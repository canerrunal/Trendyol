#!/usr/bin/env node

const path = require('path');
const collectionConfig = require('../taxonomy/collection-config.json');
const { enrichTaxonomy } = require('./enrich_taxonomy.cjs');
const {
  ROOT, readJson, writeGzipJsonAtomic, writeJsonAtomic, nowIstanbul, sleep,
  launchBrowser, prepareRankingPage, fetchRankingPage, fetchSearchPage, normalizeProduct
} = require('./taxonomy_common.cjs');

function arg(name, fallback) {
  const inline = process.argv.find(value => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function dayNumber(date) { return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000); }
function rotatingExpansionPages(categoryId, date, options = {}) {
  if (options.catalogExpansion === false) return [];
  const count = Math.max(0, Number(options.expansionPagesPerCategory || 0));
  const first = Math.max(1, Number(options.expansionFirstPage || 3));
  const last = Math.max(first, Number(options.expansionLastPage || first));
  if (!Number.isInteger(count) || !Number.isInteger(first) || !Number.isInteger(last) || count === 0) return [];
  const span = last - first + 1;
  const seed = (Number(categoryId) + dayNumber(date) * count) % span;
  return Array.from({ length: Math.min(count, span) }, (_, index) => first + ((seed + index) % span));
}
function categoryPages(node, date, options = {}) {
  if (options.pages) return Number(options.pages);
  if (node.level <= 1) return collectionConfig.deepPages;
  const cycleDays = Number(options.deepCycleDays || collectionConfig.deepCycleDays);
  return (node.categoryId + dayNumber(date)) % cycleDays === 0 ? collectionConfig.deepPages : collectionConfig.dailyPages;
}
function shardNodes(nodes, shard, shardCount) {
  const seen = new Set();
  return nodes.filter(node => {
    if (node.categoryId % shardCount !== shard || seen.has(node.categoryId)) return false;
    seen.add(node.categoryId);
    return true;
  });
}

async function collectNewestListings(page, categoryId, options = {}) {
  if (options.newestDiscovery !== true) {
    return { pages: [], headProductIds: [], caughtUp: null, baseline: false, failures: [] };
  }
  const searchFetch = options.fetchSearchPage || fetchSearchPage;
  const pageSize = Math.max(1, Number(options.newestPageSize || 36));
  const maxPages = Math.max(1, Number(options.newestMaxPagesPerCategory || 10));
  const firstRunPages = Math.min(maxPages, Math.max(1, Number(options.newestFirstRunPages || 2)));
  const checkpointSize = Math.max(1, Number(options.newestCheckpointSize || 12));
  const knownProductIds = new Set((options.newestKnownProductIds || []).map(String).filter(Boolean));
  const requiredHits = Math.min(knownProductIds.size, Math.max(1, Number(options.newestCheckpointHits || 3)));
  const sort = String(options.newestSort || 'MOST_RECENT');
  const pages = []; const failures = []; const observedKnownIds = new Set();
  let headProductIds = []; let caughtUp = knownProductIds.size ? false : null;

  for (let pageNumber = 1; pageNumber <= maxPages; pageNumber++) {
    let items;
    try {
      items = await searchFetch(page, categoryId, pageNumber, pageSize, 3, sort);
    } catch (error) {
      failures.push({ pageNumber, error: error?.message || String(error) });
      break;
    }
    const productIds = items.map(item => normalizeProduct(item).productId).filter(Boolean);
    if (pageNumber === 1) headProductIds = productIds.slice(0, checkpointSize);
    pages.push({ pageNumber, items });
    for (const productId of productIds) {
      if (knownProductIds.has(productId)) observedKnownIds.add(productId);
    }
    if (requiredHits && observedKnownIds.size >= requiredHits) {
      caughtUp = true;
      break;
    }
    if (!knownProductIds.size && pageNumber >= firstRunPages) break;
    if (items.length < pageSize) {
      caughtUp = true;
      break;
    }
  }
  return {
    pages,
    headProductIds,
    caughtUp,
    baseline: knownProductIds.size === 0,
    checkpointHits: observedKnownIds.size,
    failures,
  };
}

async function collectCategoryListings(page, categoryId, pages, options = {}) {
  const rankingFetch = options.fetchRankingPage || fetchRankingPage;
  const searchFetch = options.fetchSearchPage || fetchSearchPage;
  const pauseMs = Number(options.pauseMs ?? 260);
  const targetProducts = pages * 20;
  const categoryMemberships = [];
  const categoryProductsByKey = new Map();
  const addItems = (items, source, rankStart = 1, maximumMemberships = Infinity) => {
    for (let index = 0; index < items.length; index++) {
      if (categoryMemberships.length >= maximumMemberships) break;
      const item = items[index];
      const product = normalizeProduct(item);
      if (!product.productId) continue;
      const productKey = `${product.productId}:${product.merchantId}`;
      if (categoryProductsByKey.has(productKey)) continue;
      categoryProductsByKey.set(productKey, product);
      categoryMemberships.push({ categoryId, rank: rankStart + index, productKey, source });
    }
  };

  for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
    const items = await rankingFetch(page, categoryId, pageNumber);
    addItems(items, 'top_ranking', (pageNumber - 1) * 20 + 1, targetProducts);
    if (items.length < 20 || categoryMemberships.length >= targetProducts) break;
    if (pauseMs > 0) await sleep(pauseMs);
  }

  let fallbackUsed = false;
  if (!categoryMemberships.length && options.emptyCategoryFallback !== false) {
    fallbackUsed = true;
    const pageSize = Number(options.fallbackPageSize || 36);
    const fallbackPages = Math.ceil(targetProducts / pageSize);
    for (let pageNumber = 1; pageNumber <= fallbackPages; pageNumber++) {
      const items = await searchFetch(page, categoryId, pageNumber, pageSize);
      addItems(items, 'category_search_fallback', (pageNumber - 1) * pageSize + 1);
      if (items.length < pageSize || categoryMemberships.length >= targetProducts) break;
      if (pauseMs > 0) await sleep(pauseMs);
    }
  }

  let expansionProducts = 0;
  let expansionPages = [];
  const expansionFailures = [];
  if (categoryMemberships.length) {
    const pageSize = Number(options.expansionPageSize || 36);
    expansionPages = rotatingExpansionPages(categoryId, options.date, options);
    const results = await Promise.allSettled(expansionPages.map(async requestedPage => {
      let pageNumber = requestedPage;
      let items = await searchFetch(page, categoryId, pageNumber, pageSize);
      const totalPages = items.total ? Math.ceil(items.total / pageSize) : null;
      const first = Math.max(1, Number(options.expansionFirstPage || 3));
      const configuredLast = Math.max(first, Number(options.expansionLastPage || first));
      const availableLast = totalPages ? Math.min(configuredLast, totalPages) : configuredLast;
      if (!items.length && availableLast >= first && pageNumber > availableLast) {
        pageNumber = first + ((requestedPage - first) % (availableLast - first + 1));
        items = await searchFetch(page, categoryId, pageNumber, pageSize);
      }
      return { requestedPage, pageNumber, items };
    }));
    const before = categoryMemberships.length;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        addItems(result.value.items, 'category_search_expansion', (result.value.pageNumber - 1) * pageSize + 1);
      } else {
        const requestedPage = expansionPages[results.indexOf(result)];
        expansionFailures.push({ pageNumber: requestedPage, error: result.reason?.message || String(result.reason) });
      }
    }
    expansionProducts = categoryMemberships.length - before;
  }

  const newest = await collectNewestListings(page, categoryId, {
    ...options,
    fetchSearchPage: searchFetch,
  });
  const beforeNewest = categoryMemberships.length;
  const newestSource = newest.baseline ? 'category_search_newest_baseline' : 'category_search_newest';
  for (const result of newest.pages) {
    addItems(result.items, newestSource, (result.pageNumber - 1) * Number(options.newestPageSize || 36) + 1);
  }
  const newestProducts = categoryMemberships.length - beforeNewest;

  return {
    memberships: categoryMemberships,
    products: categoryProductsByKey,
    fallbackUsed,
    expansionPages,
    expansionProducts,
    expansionFailures,
    newestProducts,
    newest,
  };
}

async function collect() {
  const shard = Number(arg('shard', '0'));
  const shardCount = Number(arg('shards', '4'));
  const limit = Number(arg('limit-categories', '0'));
  const forcedPages = Number(arg('pages', '0'));
  if (!Number.isInteger(shard) || !Number.isInteger(shardCount) || shard < 0 || shard >= shardCount) throw new Error('Geçersiz shard ayarı.');
  const catalog = readJson(path.join(ROOT, 'taxonomy', 'catalog.json'));
  if (!catalog?.nodes?.length) throw new Error('taxonomy/catalog.json bulunamadı; önce keşif çalıştırılmalı.');
  const { date, timestamp } = nowIstanbul();
  let nodes = shardNodes(catalog.nodes, shard, shardCount);
  if (limit > 0) nodes = nodes.slice(0, limit);
  const runtimeDir = path.join(ROOT, '.runtime', 'taxonomy', date);
  const statusFile = path.join(runtimeDir, `shard-${shard}.status.json`);
  const newestStateFile = path.join(ROOT, '.runtime', 'new-products', `shard-${shard}.json`);
  const newestState = readJson(newestStateFile, { categories: {} });
  if (!newestState.categories || typeof newestState.categories !== 'object') newestState.categories = {};
  const startedAt = new Date().toISOString();
  const catalogRunId = catalog.runId || catalog.generatedAt;
  writeJsonAtomic(statusFile, { schemaVersion: 2, date, shard, shardCount, status: 'running', startedAt, catalogRunId, catalogGeneratedAt: catalog.generatedAt, totalCategories: nodes.length, completedCategories: 0, failedCategories: 0, products: 0, memberships: 0 });
  const memberships = []; const products = new Map(); const failures = []; const successfulCategoryIds = [];
  const fallbackCategoryIds = []; const expansionCategoryIds = []; const emptyCategoryIds = [];
  let expansionMemberships = 0; let expansionPageFailures = 0;
  const newestCategoryIds = [];
  const newestStats = { products: 0, pages: 0, caughtUpCategories: 0, uncaughtCategories: 0, baselineCategories: 0, pageFailures: 0 };
  let detailCoverage = null;
  let session = null;
  const closeSession = async () => {
    if (!session) return;
    await session.context.close().catch(() => {});
    await session.browser.close().catch(() => {});
    session = null;
  };
  const renewSession = async reason => {
    await closeSession();
    const launched = await launchBrowser();
    const page = await prepareRankingPage(launched.context);
    session = { ...launched, page };
    console.log(`TAXONOMY_SESSION_READY shard=${shard} reason=${reason}`);
  };
  try {
    await renewSession('initial');
    for (let categoryIndex = 0; categoryIndex < nodes.length; categoryIndex++) {
      if (categoryIndex > 0 && categoryIndex % 60 === 0) await renewSession('periodic');
      const node = nodes[categoryIndex];
      const pages = categoryPages(node, date, { pages: forcedPages || null });
      let categoryProducts = 0;
      let categoryResult = null; let lastError = null;
      for (let attempt = 1; attempt <= 2 && !categoryResult; attempt++) {
        try {
          categoryResult = await collectCategoryListings(session.page, node.categoryId, pages, {
            ...collectionConfig,
            date,
            newestKnownProductIds: newestState.categories[String(node.categoryId)]?.headProductIds || [],
          });
        } catch (error) {
          lastError = error;
          console.warn(`TAXONOMY_CATEGORY_RETRY shard=${shard} category=${node.categoryId} attempt=${attempt} error=${JSON.stringify(error.message)}`);
          if (attempt < 2) { await sleep(900); await renewSession('category-retry'); }
        }
      }
      if (categoryResult) {
        successfulCategoryIds.push(node.categoryId);
        if (categoryResult.fallbackUsed && categoryResult.memberships.length) fallbackCategoryIds.push(node.categoryId);
        if (categoryResult.expansionProducts > 0) expansionCategoryIds.push(node.categoryId);
        expansionMemberships += categoryResult.expansionProducts || 0;
        expansionPageFailures += categoryResult.expansionFailures?.length || 0;
        if (categoryResult.newestProducts > 0) newestCategoryIds.push(node.categoryId);
        newestStats.products += categoryResult.newestProducts || 0;
        newestStats.pages += categoryResult.newest?.pages?.length || 0;
        newestStats.pageFailures += categoryResult.newest?.failures?.length || 0;
        if (categoryResult.newest?.baseline) newestStats.baselineCategories++;
        else if (categoryResult.newest?.caughtUp === true) newestStats.caughtUpCategories++;
        else if (categoryResult.newest?.caughtUp === false) newestStats.uncaughtCategories++;
        if (categoryResult.newest?.headProductIds?.length) {
          newestState.categories[String(node.categoryId)] = {
            headProductIds: categoryResult.newest.headProductIds,
            observedAt: timestamp,
            caughtUp: categoryResult.newest.caughtUp,
          };
        }
        if (!categoryResult.memberships.length) emptyCategoryIds.push(node.categoryId);
        memberships.push(...categoryResult.memberships);
        for (const [key, product] of categoryResult.products) products.set(key, product);
        categoryProducts = categoryResult.memberships.length;
      } else failures.push({ categoryId: node.categoryId, path: node.path, error: lastError?.message || 'Bilinmeyen hata' });
      if ((categoryIndex + 1) % 10 === 0 || categoryIndex + 1 === nodes.length) {
        writeJsonAtomic(statusFile, {
          schemaVersion: 2, date, shard, shardCount, status: 'running', startedAt, catalogRunId, catalogGeneratedAt: catalog.generatedAt, updatedAt: new Date().toISOString(),
          totalCategories: nodes.length, completedCategories: categoryIndex + 1, failedCategories: failures.length,
          products: products.size, memberships: memberships.length, fallbackCategories: fallbackCategoryIds.length,
          expansionCategories: expansionCategoryIds.length, expansionMemberships, expansionPageFailures,
          newestCategories: newestCategoryIds.length, newestProducts: newestStats.products,
          newestPages: newestStats.pages, newestUncaughtCategories: newestStats.uncaughtCategories,
          emptyCategories: emptyCategoryIds.length, lastCategory: node.path, lastCategoryProducts: categoryProducts
        });
        console.log(`TAXONOMY_SHARD_PROGRESS shard=${shard} completed=${categoryIndex + 1}/${nodes.length} failures=${failures.length} memberships=${memberships.length}`);
        writeJsonAtomic(newestStateFile, {
          schemaVersion: 1, shard, shardCount, updatedAt: new Date().toISOString(), categories: newestState.categories,
        });
      }
      await sleep(360);
    }
    const enriched = await enrichTaxonomy(
      session.context,
      [...products].map(([productKey, p]) => ({ productKey, ...p })),
      ROOT,
      shard,
      date,
      collectionConfig,
      memberships,
    );
    for (const p of enriched.products) products.set(p.productKey,p);
    detailCoverage = enriched.coverage;
    writeJsonAtomic(newestStateFile, {
      schemaVersion: 1, shard, shardCount, updatedAt: new Date().toISOString(), categories: newestState.categories,
    });
  } finally { await closeSession(); }
  const successRate = nodes.length ? Math.round((nodes.length - failures.length) / nodes.length * 10000) / 100 : 0;
  const status = successRate >= 95 ? 'PASS' : 'FAIL';
  const result = {
    schemaVersion: 2, date, capturedAt: timestamp, startedAt, finishedAt: new Date().toISOString(),
    catalogRunId, catalogGeneratedAt: catalog.generatedAt, shard, shardCount, status,
    totalCategories: nodes.length, completedCategories: nodes.length, failedCategories: failures.length,
    successRate, successfulCategoryIds, fallbackCategoryIds, expansionCategoryIds, expansionMemberships, expansionPageFailures,
    newestCategoryIds, newestDiscovery: newestStats, emptyCategoryIds, detailCoverage,
    products: [...products.entries()].map(([productKey, product]) => ({ productKey, ...product })), memberships, failures
  };
  writeGzipJsonAtomic(path.join(runtimeDir, `shard-${shard}.json.gz`), result);
  writeJsonAtomic(statusFile, { ...result, products: products.size, memberships: memberships.length, finishedAt: new Date().toISOString(), failures: failures.slice(0, 50) });
  if (status !== 'PASS') throw new Error(`Shard ${shard} kalite kapısı başarısız: %${successRate}`);
  return result;
}

if (require.main === module) collect().then(result => console.log(`TAXONOMY_SHARD_OK shard=${result.shard} categories=${result.totalCategories} products=${result.products.length} memberships=${result.memberships.length} success=${result.successRate}`)).catch(error => { console.error(`TAXONOMY_SHARD_FAILED ${error.stack || error.message}`); process.exitCode = 1; });

module.exports = { collect, categoryPages, rotatingExpansionPages, shardNodes, collectNewestListings, collectCategoryListings };
