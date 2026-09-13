const path = require('path');
const { collectDetail } = require('./collect.cjs');
const { estimateInventory, periodEstimate, METRIC_FIELDS } = require('./product_metrics.cjs');
const { readJson, writeJsonAtomic } = require('./taxonomy_common.cjs');

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function productRecord(product, key = product.productKey || `${product.productId}:${product.merchantId}`) {
  return { ...product, productKey: key };
}

function lastTimestamp(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map(row => row?.stock_observed_at)
    .filter(value => value && !Number.isNaN(Date.parse(value)))
    .sort()
    .at(-1) || null;
}

function selectDetailCohort(products, memberships, state, options = {}) {
  const daily = positiveInteger(options.detailDailyPerShard, 100);
  const rotation = positiveInteger(options.detailRotationPerShard, 100);
  const followUpLimit = positiveInteger(options.detailFollowUpPerShard, rotation);
  const byKey = new Map(products.map(product => {
    const row = productRecord(product);
    return [row.productKey, row];
  }));
  const history = state.history && typeof state.history === 'object' ? state.history : {};
  const lastObserved = state.lastObserved && typeof state.lastObserved === 'object'
    ? { ...state.lastObserved }
    : {};
  for (const [key, rows] of Object.entries(history)) {
    if (!lastObserved[key]) lastObserved[key] = lastTimestamp(rows);
  }

  // Persist a compact daily cohort so 18–30 hour inventory comparisons continue.
  const watch = new Map();
  for (const item of Array.isArray(state.watch) ? state.watch : []) {
    if (watch.size >= daily) break;
    const current = byKey.get(item.productKey);
    const row = productRecord(current || item, item.productKey);
    if (row.url) watch.set(row.productKey, row);
  }
  for (const [key, item] of [...byKey].sort(([a], [b]) => a.localeCompare(b))) {
    if (watch.size >= daily) break;
    if (item.url) watch.set(key, item);
  }

  const selected = new Map();
  const add = (item, reason, baselineAt = null) => {
    if (!item?.url || selected.has(item.productKey)) return false;
    selected.set(item.productKey, { product: item, reason, baselineAt });
    return true;
  };
  for (const item of watch.values()) add(item, 'daily_watch');

  let followUps = 0;
  for (const queued of Array.isArray(state.followUp) ? state.followUp : []) {
    if (followUps >= followUpLimit) break;
    const current = byKey.get(queued.productKey);
    const row = productRecord(current || queued, queued.productKey);
    if (add(row, 'follow_up', queued.baselineAt || lastObserved[row.productKey] || null)) followUps++;
  }

  const categoryProducts = new Map();
  const productCategories = new Map();
  for (const membership of Array.isArray(memberships) ? memberships : []) {
    const categoryId = Number(membership.categoryId);
    if (!Number.isFinite(categoryId) || !byKey.has(membership.productKey)) continue;
    if (!categoryProducts.has(categoryId)) categoryProducts.set(categoryId, []);
    const keys = categoryProducts.get(categoryId);
    if (!keys.includes(membership.productKey)) keys.push(membership.productKey);
    if (!productCategories.has(membership.productKey)) productCategories.set(membership.productKey, []);
    const categoryIds = productCategories.get(membership.productKey);
    if (!categoryIds.includes(categoryId)) categoryIds.push(categoryId);
  }
  const coveredCategories = new Set();
  const selectedCoverage = new Set();
  for (const [categoryId, keys] of categoryProducts) {
    if (keys.some(key => lastObserved[key])) coveredCategories.add(categoryId);
    if (keys.some(key => selected.has(key))) selectedCoverage.add(categoryId);
  }

  let rotationCount = 0;
  // Give every product-returning category a measured product before filling the
  // rest of the batch. A single product can satisfy several category paths.
  for (const [categoryId, keys] of [...categoryProducts].sort(([a], [b]) => a - b)) {
    if (rotationCount >= rotation || coveredCategories.has(categoryId) || selectedCoverage.has(categoryId)) continue;
    const key = keys.find(candidate => !lastObserved[candidate] && !selected.has(candidate) && byKey.get(candidate)?.url);
    if (!key) continue;
    if (add(byKey.get(key), 'rotation')) {
      rotationCount++;
      for (const otherCategoryId of productCategories.get(key) || []) selectedCoverage.add(otherCategoryId);
    }
  }

  const candidates = [...byKey]
    .filter(([key, item]) => item.url && !selected.has(key))
    .sort(([a], [b]) => a.localeCompare(b));
  // Exhaust never-observed products deterministically.
  for (const [key, item] of candidates) {
    if (rotationCount >= rotation) break;
    if (!lastObserved[key] && add(item, 'rotation')) rotationCount++;
  }
  // Once all current products have a baseline, refresh the stalest ones first.
  if (rotationCount < rotation) {
    const stale = candidates
      .filter(([key]) => !selected.has(key))
      .sort(([a], [b]) => String(lastObserved[a] || '').localeCompare(String(lastObserved[b] || '')) || a.localeCompare(b));
    for (const [, item] of stale) {
      if (rotationCount >= rotation) break;
      if (add(item, 'rotation')) rotationCount++;
    }
  }

  return {
    selected: [...selected.values()],
    watch: [...watch.values()],
    history,
    lastObserved,
    stats: {
      dailyWatch: [...selected.values()].filter(item => item.reason === 'daily_watch').length,
      followUps: [...selected.values()].filter(item => item.reason === 'follow_up').length,
      rotation: [...selected.values()].filter(item => item.reason === 'rotation').length,
      categoriesWithProducts: categoryProducts.size,
      categoriesObservedBefore: coveredCategories.size,
    },
    categoryProducts,
  };
}

async function enrichTaxonomy(context, products, root, shard, date, options, memberships = []) {
  const stateFile = path.join(root, '.runtime', 'inventory', `shard-${shard}.json`);
  const state = readJson(stateFile, { watch: [], followUp: [], history: {}, lastObserved: {} });
  const cohort = selectDetailCohort(products, memberships, state, options);
  const byKey = new Map(products.map(product => {
    const row = productRecord(product);
    return [row.productKey, row];
  }));
  const history = cohort.history;
  const lastObserved = cohort.lastObserved;
  const nextFollowUp = new Map();
  let cursor = 0, refreshed = 0, quantities = 0, newCoverage = 0;

  async function worker() {
    while (cursor < cohort.selected.length) {
      const selection = cohort.selected[cursor++];
      const p = selection.product;
      const hadCoverage = Boolean(lastObserved[p.productKey]);
      let row = null;
      if (p.url) {
        const url = new URL(p.url);
        if (p.merchantId) url.searchParams.set('merchantId', p.merchantId);
        row = await collectDetail(
          context,
          { product_id: p.productId, url: url.toString() },
          0,
          { questionWaitMs: positiveInteger(options.detailQuestionWaitMs, 4000) },
        );
      }
      if (!row?.detail_ok || (p.merchantId && row.merchant_id !== p.merchantId)) {
        if (selection.reason === 'rotation' || selection.reason === 'follow_up') {
          nextFollowUp.set(p.productKey, { ...p, baselineAt: selection.baselineAt || null });
        }
        continue;
      }
      const prior = history[p.productKey] || [];
      const old = prior
        .filter(previous => previous.stock_observed_at < row.stock_observed_at && previous.stock_observed_at.slice(0, 10) < row.stock_observed_at.slice(0, 10))
        .at(-1);
      const metrics = {
        ...Object.fromEntries(METRIC_FIELDS.map(key => [key, row[key] ?? null])),
        merchant_id: row.merchant_id,
        seller_name: row.seller_name,
        seller_score: row.seller_score,
        rating: row.rating,
        rating_count: row.rating_count,
        review_count: row.review_count,
        question_count: row.question_count,
        ...estimateInventory(row, old),
      };
      metrics.sales_estimate_weekly = periodEstimate(prior, metrics, 7);
      metrics.sales_estimate_monthly = periodEstimate(prior, metrics, 30);
      byKey.set(p.productKey, { ...(byKey.get(p.productKey) || p), metrics });
      history[p.productKey] = [
        ...prior.filter(previous => previous.stock_observed_at?.slice(0, 10) !== metrics.stock_observed_at?.slice(0, 10)),
        metrics,
      ].slice(-32);
      lastObserved[p.productKey] = metrics.stock_observed_at;
      refreshed++;
      if (!hadCoverage) newCoverage++;
      if (metrics.stock_quantity !== null) quantities++;

      if (selection.reason === 'rotation') {
        nextFollowUp.set(p.productKey, { ...p, baselineAt: metrics.stock_observed_at });
      } else if (selection.reason === 'follow_up') {
        const completedPair = ['estimated', 'unchanged_stock', 'restock_or_adjustment'].includes(metrics.sales_estimate_status);
        if (!completedPair) nextFollowUp.set(p.productKey, { ...p, baselineAt: metrics.stock_observed_at });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Number(options.detailConcurrency || 3)) }, worker));

  // Keep interval history compact while retaining long-lived coverage progress.
  const historyThreshold = Date.parse(`${date}T00:00:00Z`) - 32 * 86400000;
  for (const key of Object.keys(history)) {
    history[key] = history[key].filter(row => Date.parse(row.stock_observed_at) >= historyThreshold);
    if (!history[key].length) delete history[key];
  }
  const coverageThreshold = Date.parse(`${date}T00:00:00Z`) - positiveInteger(options.detailCoverageMemoryDays, 365) * 86400000;
  for (const [key, timestamp] of Object.entries(lastObserved)) {
    if (!timestamp || Date.parse(timestamp) < coverageThreshold) delete lastObserved[key];
  }

  const currentKeys = new Set(byKey.keys());
  const cumulativeObserved = [...currentKeys].filter(key => lastObserved[key]).length;
  const categoriesObserved = [...cohort.categoryProducts.values()]
    .filter(keys => keys.some(key => lastObserved[key])).length;
  const coverage = {
    attempted: cohort.selected.length,
    refreshed,
    numericStock: quantities,
    total: byKey.size,
    dailyWatch: cohort.stats.dailyWatch,
    followUps: cohort.stats.followUps,
    rotation: cohort.stats.rotation,
    newCoverage,
    cumulativeObserved,
    cumulativeCoverage: byKey.size ? Math.round(cumulativeObserved / byKey.size * 10000) / 100 : 0,
    categoriesWithProducts: cohort.stats.categoriesWithProducts,
    categoriesObserved,
    categoryCoverage: cohort.stats.categoriesWithProducts
      ? Math.round(categoriesObserved / cohort.stats.categoriesWithProducts * 10000) / 100
      : 100,
    pendingFollowUps: nextFollowUp.size,
  };
  writeJsonAtomic(stateFile, {
    schemaVersion: 2,
    watch: cohort.watch,
    followUp: [...nextFollowUp.values()],
    history,
    lastObserved,
    lastRun: { date, ...coverage },
  });
  console.log(
    `TAXONOMY_DETAIL attempted=${coverage.attempted} refreshed=${refreshed} numericStock=${quantities} ` +
    `new=${newCoverage} cumulative=${cumulativeObserved}/${byKey.size} categories=${categoriesObserved}/${coverage.categoriesWithProducts} followUp=${nextFollowUp.size}`,
  );
  return { products: [...byKey.values()], coverage };
}

module.exports = { enrichTaxonomy, selectDetailCohort, lastTimestamp };
