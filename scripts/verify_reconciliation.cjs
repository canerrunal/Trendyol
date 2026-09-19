// =============================================================================
// Verimimari Marketplace Data Platform V2 — Dual-Write Reconciliation Tool
// Compares Supabase and ClickHouse data for a run to guarantee 100% integrity.
// =============================================================================

'use strict';

/**
 * Reconciles two sets of observations (e.g. from Supabase and ClickHouse).
 * Compares by key: offer_key (or productId:merchantId)
 */
function reconcileObservations(sourceA = [], sourceB = [], options = {}) {
  const keyField = options.keyField || 'offer_key';
  const tolerancePrice = options.tolerancePrice != null ? options.tolerancePrice : 0.01;

  const mapA = new Map();
  for (const item of sourceA) {
    const key = item[keyField] || `${item.product_id}:${item.merchant_id || 'default'}`;
    mapA.set(key, item);
  }

  const mapB = new Map();
  for (const item of sourceB) {
    const key = item[keyField] || `${item.product_id}:${item.merchant_id || 'default'}`;
    mapB.set(key, item);
  }

  const totalA = mapA.size;
  const totalB = mapB.size;
  let matches = 0;
  const missingInB = [];
  const missingInA = [];
  const discrepancies = [];

  for (const [key, itemA] of mapA.entries()) {
    const itemB = mapB.get(key);
    if (!itemB) {
      missingInB.push(key);
      continue;
    }

    const diffs = [];

    // 1. Price comparison
    const priceA = itemA.price != null ? Number(itemA.price) : null;
    const priceB = itemB.price != null ? Number(itemB.price) : null;
    if (priceA !== priceB) {
      if (priceA == null || priceB == null || Math.abs(priceA - priceB) > tolerancePrice) {
        diffs.push({ field: 'price', a: priceA, b: priceB });
      }
    }

    // 2. In-Stock ternary comparison (boolean or 1/0/null)
    const normalizeStock = (val) => {
      if (val === true || val === 1 || val === '1') return 1;
      if (val === false || val === 0 || val === '0') return 0;
      return null;
    };
    const stockA = normalizeStock(itemA.in_stock);
    const stockB = normalizeStock(itemB.in_stock);
    if (stockA !== stockB) {
      diffs.push({ field: 'in_stock', a: stockA, b: stockB });
    }

    // 3. Rank comparison (if present)
    if (itemA.rank != null || itemB.rank != null) {
      const rankA = itemA.rank != null ? Number(itemA.rank) : null;
      const rankB = itemB.rank != null ? Number(itemB.rank) : null;
      if (rankA !== rankB) {
        diffs.push({ field: 'rank', a: rankA, b: rankB });
      }
    }

    if (diffs.length > 0) {
      discrepancies.push({ key, diffs });
    } else {
      matches++;
    }
  }

  for (const key of mapB.keys()) {
    if (!mapA.has(key)) {
      missingInA.push(key);
    }
  }

  const isFullMatch = missingInA.length === 0 && missingInB.length === 0 && discrepancies.length === 0;
  const matchRate = totalA > 0 ? Number(((matches / totalA) * 100).toFixed(2)) : (totalB === 0 ? 100 : 0);

  return {
    status: isFullMatch ? 'MATCH' : 'DISCREPANCY',
    isFullMatch,
    matchRate,
    counts: {
      sourceA: totalA,
      sourceB: totalB,
      exactMatches: matches,
      missingInSourceB: missingInB.length,
      missingInSourceA: missingInA.length,
      discrepancies: discrepancies.length
    },
    sampleMissingInB: missingInB.slice(0, 5),
    sampleMissingInA: missingInA.slice(0, 5),
    sampleDiscrepancies: discrepancies.slice(0, 5)
  };
}

const crypto = require('node:crypto');
const { computeLogicalDatasetChecksum } = require('./lib/clickhouse_client.cjs');

/**
 * Extracts and computes the 14 canonical verification metrics for a dataset:
 * 1. run_id
 * 2. observation_count
 * 3. ranking_count
 * 4. distinct_products
 * 5. distinct_merchants
 * 6. distinct_offer_key
 * 7. duplicate_observation_id_count
 * 8. date_range (min, max)
 * 9. captured_at_range (min, max)
 * 10. null_price_count
 * 11. stock_distribution (true, false, null)
 * 12. price_sum
 * 13. rank_checksum
 * 14. logical_dataset_checksum
 */
function analyzeObservationMetrics(dataset) {
  let runId = 'unknown';
  let observations = [];
  let rankings = [];

  if (Array.isArray(dataset)) {
    observations = dataset;
  } else if (dataset && typeof dataset === 'object') {
    runId = dataset.run_id || dataset.runId || 'unknown';
    observations = dataset.observations || dataset.products || [];
    rankings = dataset.rankings || [];
  }

  if (runId === 'unknown' && observations.length > 0 && observations[0].run_id) {
    runId = observations[0].run_id;
  }

  const distinctProducts = new Set();
  const distinctMerchants = new Set();
  const distinctOfferKeys = new Set();
  const seenObservationIds = new Set();
  let duplicateObservationIdCount = 0;
  let minDate = null;
  let maxDate = null;
  let minCapturedAt = null;
  let maxCapturedAt = null;
  let nullPriceCount = 0;
  let priceSum = 0;
  const stockDist = { true: 0, false: 0, null: 0 };

  for (const obs of observations) {
    const pId = obs.product_id != null ? String(obs.product_id) : (obs.productId != null ? String(obs.productId) : null);
    if (pId) distinctProducts.add(pId);

    const mId = obs.merchant_id != null ? String(obs.merchant_id) : (obs.merchantId != null ? String(obs.merchantId) : null);
    if (mId) distinctMerchants.add(mId);

    const offerKey = obs.offer_key || (pId ? `${pId}:${mId || 'default'}` : null);
    if (offerKey) distinctOfferKeys.add(offerKey);

    const obsId = obs.observation_id || obs.id || null;
    if (obsId) {
      if (seenObservationIds.has(obsId)) {
        duplicateObservationIdCount++;
      } else {
        seenObservationIds.add(obsId);
      }
    }

    const date = obs.observed_date || obs.observedDate || null;
    if (date) {
      if (!minDate || date < minDate) minDate = date;
      if (!maxDate || date > maxDate) maxDate = date;
    }

    const capAt = obs.captured_at || obs.capturedAt || null;
    if (capAt) {
      const capStr = typeof capAt === 'string' ? capAt : new Date(capAt).toISOString();
      if (!minCapturedAt || capStr < minCapturedAt) minCapturedAt = capStr;
      if (!maxCapturedAt || capStr > maxCapturedAt) maxCapturedAt = capStr;
    }

    if (obs.price == null || obs.price === '') {
      nullPriceCount++;
    } else {
      priceSum += Number(obs.price);
    }

    if (obs.in_stock === true || obs.in_stock === 1 || obs.in_stock === '1') {
      stockDist.true++;
    } else if (obs.in_stock === false || obs.in_stock === 0 || obs.in_stock === '0') {
      stockDist.false++;
    } else {
      stockDist.null++;
    }
  }

  // Canonical rank checksum computation over rankings
  let rankChecksum = 'none';
  if (Array.isArray(rankings) && rankings.length > 0) {
    const canonicalRankRows = rankings.map(r => {
      const catId = r.category_id != null ? String(r.category_id) : (r.categoryId != null ? String(r.categoryId) : '');
      const rank = r.rank != null ? Number(r.rank) : 0;
      const prodId = r.product_id != null
        ? String(r.product_id)
        : (r.productId != null
            ? String(r.productId)
            : (r.product_key ? String(r.product_key).split(':')[0] : (r.productKey ? String(r.productKey).split(':')[0] : '')));
      return `${catId}:${rank}:${prodId}`;
    }).sort().join('|');
    rankChecksum = crypto.createHash('sha256').update(canonicalRankRows, 'utf8').digest('hex').slice(0, 16);
  }

  // Canonical normalization to bridge PostgreSQL (true/false) and ClickHouse (1/0)
  const canonicalRows = observations.map(obs => {
    const pId = obs.product_id != null ? String(obs.product_id) : (obs.productId != null ? String(obs.productId) : '');
    const mId = obs.merchant_id != null ? String(obs.merchant_id) : (obs.merchantId != null ? String(obs.merchantId) : null);
    const offerKey = obs.offer_key || (pId ? `${pId}:${mId || 'default'}` : '');

    let normStock = null;
    if (obs.in_stock === true || obs.in_stock === 1 || obs.in_stock === '1') normStock = true;
    else if (obs.in_stock === false || obs.in_stock === 0 || obs.in_stock === '0') normStock = false;

    return {
      observation_id: obs.observation_id || obs.id || '',
      run_id: runId,
      product_id: pId,
      merchant_id: mId,
      offer_key: offerKey,
      price: obs.price != null && obs.price !== '' ? Number(Number(obs.price).toFixed(2)) : null,
      in_stock: normStock,
      observed_date: obs.observed_date || obs.observedDate || ''
    };
  });

  const logicalChecksum = computeLogicalDatasetChecksum(canonicalRows);

  return {
    run_id: runId,
    observation_count: observations.length,
    ranking_count: rankings.length,
    distinct_products: distinctProducts.size,
    distinct_merchants: distinctMerchants.size,
    distinct_offer_key: distinctOfferKeys.size,
    duplicate_observation_id_count: duplicateObservationIdCount,
    date_range: { min: minDate, max: maxDate },
    captured_at_range: { min: minCapturedAt, max: maxCapturedAt },
    null_price_count: nullPriceCount,
    stock_distribution: stockDist,
    price_sum: Math.round(priceSum * 100) / 100,
    rank_checksum: rankChecksum,
    logical_dataset_checksum: logicalChecksum
  };
}

/**
 * Reconciles two datasets across the 14 canonical Verimimari P1 reconciliation metrics:
 * 1. run_id equality
 * 2. observation_count equality
 * 3. ranking_count equality
 * 4. distinct_products equality
 * 5. distinct_merchants equality
 * 6. distinct_offer_key equality
 * 7. duplicate_observation_id_count equality
 * 8. date_range (min_date, max_date) equality
 * 9. captured_at_range (min_captured_at, max_captured_at) equality
 * 10. null_price_count equality
 * 11. stock_distribution (true / false / null) equality
 * 12. price_sum equality
 * 13. rank_checksum equality
 * 14. logical_dataset_checksum equality
 */
function reconcileDatasetMetrics(sourceA, sourceB) {
  const mA = analyzeObservationMetrics(sourceA);
  const mB = analyzeObservationMetrics(sourceB);

  const checks = {
    run_id: {
      pass: mA.run_id === mB.run_id,
      sourceA: mA.run_id,
      sourceB: mB.run_id
    },
    observation_count: {
      pass: mA.observation_count === mB.observation_count,
      sourceA: mA.observation_count,
      sourceB: mB.observation_count
    },
    ranking_count: {
      pass: mA.ranking_count === mB.ranking_count,
      sourceA: mA.ranking_count,
      sourceB: mB.ranking_count
    },
    distinct_products: {
      pass: mA.distinct_products === mB.distinct_products,
      sourceA: mA.distinct_products,
      sourceB: mB.distinct_products
    },
    distinct_merchants: {
      pass: mA.distinct_merchants === mB.distinct_merchants,
      sourceA: mA.distinct_merchants,
      sourceB: mB.distinct_merchants
    },
    distinct_offer_key: {
      pass: mA.distinct_offer_key === mB.distinct_offer_key,
      sourceA: mA.distinct_offer_key,
      sourceB: mB.distinct_offer_key
    },
    duplicate_observation_id_count: {
      pass: mA.duplicate_observation_id_count === mB.duplicate_observation_id_count,
      sourceA: mA.duplicate_observation_id_count,
      sourceB: mB.duplicate_observation_id_count
    },
    date_range: {
      pass: mA.date_range.min === mB.date_range.min && mA.date_range.max === mB.date_range.max,
      sourceA: mA.date_range,
      sourceB: mB.date_range
    },
    captured_at_range: {
      pass: mA.captured_at_range.min === mB.captured_at_range.min && mA.captured_at_range.max === mB.captured_at_range.max,
      sourceA: mA.captured_at_range,
      sourceB: mB.captured_at_range
    },
    null_price_count: {
      pass: mA.null_price_count === mB.null_price_count,
      sourceA: mA.null_price_count,
      sourceB: mB.null_price_count
    },
    stock_distribution: {
      pass: mA.stock_distribution.true === mB.stock_distribution.true &&
            mA.stock_distribution.false === mB.stock_distribution.false &&
            mA.stock_distribution.null === mB.stock_distribution.null,
      sourceA: mA.stock_distribution,
      sourceB: mB.stock_distribution
    },
    price_sum: {
      pass: Math.abs(mA.price_sum - mB.price_sum) < 0.01,
      sourceA: mA.price_sum,
      sourceB: mB.price_sum
    },
    rank_checksum: {
      pass: mA.rank_checksum === mB.rank_checksum,
      sourceA: mA.rank_checksum,
      sourceB: mB.rank_checksum
    },
    logical_dataset_checksum: {
      pass: mA.logical_dataset_checksum === mB.logical_dataset_checksum,
      sourceA: mA.logical_dataset_checksum,
      sourceB: mB.logical_dataset_checksum
    }
  };

  const metricNames = Object.keys(checks);
  const passedCount = metricNames.filter(name => checks[name].pass).length;
  const isFullPass = passedCount === metricNames.length;

  return {
    status: isFullPass ? 'PASS' : 'FAIL',
    isFullPass,
    totalMetrics: metricNames.length,
    passedMetrics: passedCount,
    failedMetrics: metricNames.length - passedCount,
    metrics: checks,
    sourceA_summary: mA,
    sourceB_summary: mB
  };
}

// Backward-compatibility alias for 10-metrics caller
const reconcileDataset10Metrics = reconcileDatasetMetrics;

function normalizeTimestampString(val) {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString().slice(0, 19);
  const s = String(val).trim().replace(' ', 'T').replace(/\..*/, '').replace(/Z$/, '').replace(/\+.*$/, '');
  return s;
}

/**
 * Extracts and computes direct reconciliation metrics for dedicated ranking datasets:
 * Supabase market_taxonomy_rankings <-> ClickHouse verimimari_prod.category_rank_observations
 */
function analyzeDedicatedRankMetrics(rankingsList) {
  const items = Array.isArray(rankingsList) ? rankingsList : (rankingsList?.rankings || []);
  let runId = 'unknown';
  if (items.length > 0 && items[0].run_id) {
    runId = items[0].run_id;
  } else if (rankingsList && typeof rankingsList === 'object' && rankingsList.run_id) {
    runId = rankingsList.run_id;
  }

  const distinctProducts = new Set();
  const distinctCategories = new Set();
  const membershipMap = new Map(); // key: `${catId}:${prodId}` -> rank
  const seenObservationIds = new Set();
  let duplicateCount = 0;
  let minCapturedAt = null;
  let maxCapturedAt = null;

  for (const item of items) {
    const catId = item.category_id != null ? String(item.category_id) : (item.categoryId != null ? String(item.categoryId) : '');
    const prodId = item.product_id != null
      ? String(item.product_id)
      : (item.productId != null
          ? String(item.productId)
          : (item.product_key ? String(item.product_key).split(':')[0] : (item.productKey ? String(item.productKey).split(':')[0] : '')));
    const rank = item.rank != null ? Number(item.rank) : 0;
    const obsId = item.observation_id || `${catId}:${rank}:${prodId}`;

    if (seenObservationIds.has(obsId)) {
      duplicateCount++;
    } else {
      seenObservationIds.add(obsId);
    }

    if (catId) distinctCategories.add(catId);
    if (prodId) distinctProducts.add(prodId);

    const memKey = `${catId}:${prodId}`;
    if (!membershipMap.has(memKey)) {
      membershipMap.set(memKey, rank);
    }

    const capAt = item.captured_at || item.capturedAt || null;
    if (capAt) {
      const capNorm = normalizeTimestampString(capAt);
      if (!minCapturedAt || capNorm < minCapturedAt) minCapturedAt = capNorm;
      if (!maxCapturedAt || capNorm > maxCapturedAt) maxCapturedAt = capNorm;
    }
  }

  const canonicalRankRows = items.map(r => {
    const catId = r.category_id != null ? String(r.category_id) : (r.categoryId != null ? String(r.categoryId) : '');
    const rank = r.rank != null ? Number(r.rank) : 0;
    const prodId = r.product_id != null
      ? String(r.product_id)
      : (r.productId != null
          ? String(r.productId)
          : (r.product_key ? String(r.product_key).split(':')[0] : (r.productKey ? String(r.productKey).split(':')[0] : '')));
    return `${catId}:${rank}:${prodId}`;
  }).sort().join('|');

  const rankChecksum = items.length > 0
    ? crypto.createHash('sha256').update(canonicalRankRows, 'utf8').digest('hex').slice(0, 16)
    : 'none';

  return {
    run_id: runId,
    count: items.length,
    distinct_products: distinctProducts.size,
    distinct_categories: distinctCategories.size,
    membershipMap,
    rank_checksum: rankChecksum,
    captured_at_scope: { min: minCapturedAt, max: maxCapturedAt },
    duplicate_count: duplicateCount
  };
}

/**
 * Direct Dedicated SQL Reconciliation for Ranking Stream:
 * Supabase market_taxonomy_rankings <-> ClickHouse verimimari_prod.category_rank_observations
 *
 * Mandatory validations:
 * 1. run_id: same run_id
 * 2. count: rows > 0 and exact match
 * 3. distinct_products: exact match
 * 4. distinct_categories: exact match
 * 5. category_product_membership: exact match of (category_id, product_id) tuples
 * 6. rank_values: exact match of rank for each (category_id, product_id)
 * 7. rank_checksum: exact match of canonical SHA256 of sorted `${category_id}:${rank}:${product_id}`
 * 8. captured_at_scope: min and max captured_at match
 * 9. duplicate_count: 0 duplicates in both sources
 */
function reconcileDedicatedRankMetrics(sourceA, sourceB) {
  const mA = analyzeDedicatedRankMetrics(sourceA);
  const mB = analyzeDedicatedRankMetrics(sourceB);

  // Check category-product membership
  let membershipMatch = true;
  let rankValuesMatch = true;
  if (mA.membershipMap.size !== mB.membershipMap.size) {
    membershipMatch = false;
  } else {
    for (const [key, rankA] of mA.membershipMap.entries()) {
      if (!mB.membershipMap.has(key)) {
        membershipMatch = false;
        break;
      }
      if (mB.membershipMap.get(key) !== rankA) {
        rankValuesMatch = false;
        break;
      }
    }
  }

  const checks = {
    run_id: {
      pass: mA.run_id === mB.run_id && mA.run_id !== 'unknown',
      sourceA: mA.run_id,
      sourceB: mB.run_id
    },
    count: {
      pass: mA.count === mB.count && mA.count > 0,
      sourceA: mA.count,
      sourceB: mB.count
    },
    distinct_products: {
      pass: mA.distinct_products === mB.distinct_products && mA.distinct_products > 0,
      sourceA: mA.distinct_products,
      sourceB: mB.distinct_products
    },
    distinct_categories: {
      pass: mA.distinct_categories === mB.distinct_categories && mA.distinct_categories > 0,
      sourceA: mA.distinct_categories,
      sourceB: mB.distinct_categories
    },
    category_product_membership: {
      pass: membershipMatch,
      matched: membershipMatch
    },
    rank_values: {
      pass: rankValuesMatch,
      matched: rankValuesMatch
    },
    rank_checksum: {
      pass: mA.rank_checksum === mB.rank_checksum && mA.rank_checksum !== 'none',
      sourceA: mA.rank_checksum,
      sourceB: mB.rank_checksum
    },
    captured_at_scope: {
      pass: mA.captured_at_scope.min === mB.captured_at_scope.min && mA.captured_at_scope.max === mB.captured_at_scope.max,
      sourceA: mA.captured_at_scope,
      sourceB: mB.captured_at_scope
    },
    duplicate_count: {
      pass: mA.duplicate_count === 0 && mB.duplicate_count === 0,
      sourceA: mA.duplicate_count,
      sourceB: mB.duplicate_count
    }
  };

  const checkKeys = Object.keys(checks);
  const passedCount = checkKeys.filter(k => checks[k].pass).length;
  const isFullPass = passedCount === checkKeys.length;

  return {
    status: isFullPass ? 'PASS' : 'FAIL',
    isFullPass,
    totalChecks: checkKeys.length,
    passedChecks: passedCount,
    failedChecks: checkKeys.length - passedCount,
    checks,
    sourceA_summary: {
      run_id: mA.run_id,
      count: mA.count,
      distinct_products: mA.distinct_products,
      distinct_categories: mA.distinct_categories,
      rank_checksum: mA.rank_checksum,
      duplicate_count: mA.duplicate_count
    },
    sourceB_summary: {
      run_id: mB.run_id,
      count: mB.count,
      distinct_products: mB.distinct_products,
      distinct_categories: mB.distinct_categories,
      rank_checksum: mB.rank_checksum,
      duplicate_count: mB.duplicate_count
    }
  };
}

/**
 * Analyzes profile stream metrics for dedicated profile observation reconciliation.
 */
function analyzeDedicatedProfileMetrics(items = []) {
  if (!items || !Array.isArray(items)) {
    return {
      run_id: 'unknown',
      count: 0,
      distinct_products: 0,
      distinct_profiles: 0,
      membershipMap: new Map(),
      profile_checksum: 'none',
      captured_at_scope: { min: null, max: null },
      duplicate_count: 0
    };
  }

  let runId = 'unknown';
  const distinctProducts = new Set();
  const distinctProfiles = new Set();
  const seenObservationKeys = new Set();
  let duplicateCount = 0;
  const membershipMap = new Map();
  let minCapturedAt = null;
  let maxCapturedAt = null;

  for (const item of items) {
    if (runId === 'unknown' && item.run_id) {
      runId = item.run_id;
    }
    const slug = item.profile_slug || item.profileSlug || 'default';
    distinctProfiles.add(slug);

    const prodId = item.product_id != null
      ? String(item.product_id)
      : (item.productId != null ? String(item.productId) : '');
    if (prodId) distinctProducts.add(prodId);

    const mId = item.merchant_id || item.merchantId || 'default';
    const offerKey = item.offer_key || item.offerKey || `${prodId}:${mId}`;
    const rankPos = item.rank_position != null ? Number(item.rank_position) : (item.rankPosition != null ? Number(item.rankPosition) : 0);

    const obsKey = `${slug}:${prodId}:${offerKey}:${rankPos}`;
    if (seenObservationKeys.has(obsKey)) {
      duplicateCount++;
    } else {
      seenObservationKeys.add(obsKey);
    }

    membershipMap.set(`${slug}:${prodId}:${offerKey}`, {
      price: item.price != null ? Number(item.price) : null,
      rank_position: rankPos
    });

    const capAt = item.captured_at || item.capturedAt || null;
    if (capAt) {
      const capNorm = normalizeTimestampString(capAt);
      if (!minCapturedAt || capNorm < minCapturedAt) minCapturedAt = capNorm;
      if (!maxCapturedAt || capNorm > maxCapturedAt) maxCapturedAt = capNorm;
    }
  }

  const canonicalProfileRows = items.map(p => {
    const slug = p.profile_slug || p.profileSlug || 'default';
    const prodId = p.product_id != null ? String(p.product_id) : (p.productId != null ? String(p.productId) : '');
    const offerKey = p.offer_key || p.offerKey || '';
    const price = p.price != null ? Number(p.price).toFixed(2) : 'null';
    return `${slug}:${prodId}:${offerKey}:${price}`;
  }).sort().join('|');

  const profileChecksum = items.length > 0
    ? crypto.createHash('sha256').update(canonicalProfileRows, 'utf8').digest('hex').slice(0, 16)
    : 'none';

  return {
    run_id: runId,
    count: items.length,
    distinct_products: distinctProducts.size,
    distinct_profiles: distinctProfiles.size,
    membershipMap,
    profile_checksum: profileChecksum,
    captured_at_scope: { min: minCapturedAt, max: maxCapturedAt },
    duplicate_count: duplicateCount
  };
}

/**
 * Direct Dedicated SQL Reconciliation for Profile Stream:
 * Supabase market_profile_observations <-> ClickHouse verimimari_prod.profile_observations
 */
function reconcileDedicatedProfileMetrics(sourceA, sourceB) {
  const mA = analyzeDedicatedProfileMetrics(sourceA);
  const mB = analyzeDedicatedProfileMetrics(sourceB);

  let membershipMatch = true;
  let valuesMatch = true;
  if (mA.membershipMap.size !== mB.membershipMap.size) {
    membershipMatch = false;
  } else {
    for (const [key, valA] of mA.membershipMap.entries()) {
      if (!mB.membershipMap.has(key)) {
        membershipMatch = false;
        break;
      }
      const valB = mB.membershipMap.get(key);
      if (valA.price !== valB.price || valA.rank_position !== valB.rank_position) {
        valuesMatch = false;
        break;
      }
    }
  }

  const checks = {
    run_id: {
      pass: mA.run_id === mB.run_id && mA.run_id !== 'unknown',
      sourceA: mA.run_id,
      sourceB: mB.run_id
    },
    count: {
      pass: mA.count === mB.count && mA.count > 0,
      sourceA: mA.count,
      sourceB: mB.count
    },
    distinct_products: {
      pass: mA.distinct_products === mB.distinct_products && mA.distinct_products > 0,
      sourceA: mA.distinct_products,
      sourceB: mB.distinct_products
    },
    distinct_profiles: {
      pass: mA.distinct_profiles === mB.distinct_profiles && mA.distinct_profiles > 0,
      sourceA: mA.distinct_profiles,
      sourceB: mB.distinct_profiles
    },
    profile_product_membership: {
      pass: membershipMatch,
      matched: membershipMatch
    },
    profile_values: {
      pass: valuesMatch,
      matched: valuesMatch
    },
    profile_checksum: {
      pass: mA.profile_checksum === mB.profile_checksum && mA.profile_checksum !== 'none',
      sourceA: mA.profile_checksum,
      sourceB: mB.profile_checksum
    },
    captured_at_scope: {
      pass: mA.captured_at_scope.min === mB.captured_at_scope.min && mA.captured_at_scope.max === mB.captured_at_scope.max,
      sourceA: mA.captured_at_scope,
      sourceB: mB.captured_at_scope
    },
    duplicate_count: {
      pass: mA.duplicate_count === 0 && mB.duplicate_count === 0,
      sourceA: mA.duplicate_count,
      sourceB: mB.duplicate_count
    }
  };

  const checkKeys = Object.keys(checks);
  const passedCount = checkKeys.filter(k => checks[k].pass).length;
  const isFullPass = passedCount === checkKeys.length;

  return {
    status: isFullPass ? 'PASS' : 'FAIL',
    isFullPass,
    totalChecks: checkKeys.length,
    passedChecks: passedCount,
    failedChecks: checkKeys.length - passedCount,
    checks
  };
}

module.exports = {
  reconcileObservations,
  analyzeObservationMetrics,
  reconcileDatasetMetrics,
  reconcileDataset10Metrics,
  analyzeDedicatedRankMetrics,
  reconcileDedicatedRankMetrics,
  analyzeDedicatedProfileMetrics,
  reconcileDedicatedProfileMetrics
};
