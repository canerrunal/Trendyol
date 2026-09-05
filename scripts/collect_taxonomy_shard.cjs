#!/usr/bin/env node

const path = require('path');
const collectionConfig = require('../taxonomy/collection-config.json');
const { enrichTaxonomy } = require('./enrich_taxonomy.cjs');
const {
  ROOT, readJson, writeGzipJsonAtomic, writeJsonAtomic, nowIstanbul, sleep,
  launchBrowser, prepareRankingPage, fetchRankingPage, normalizeProduct
} = require('./taxonomy_common.cjs');

function arg(name, fallback) {
  const inline = process.argv.find(value => value.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}
function dayNumber(date) { return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000); }
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
  const startedAt = new Date().toISOString();
  const catalogRunId = catalog.runId || catalog.generatedAt;
  writeJsonAtomic(statusFile, { schemaVersion: 2, date, shard, shardCount, status: 'running', startedAt, catalogRunId, catalogGeneratedAt: catalog.generatedAt, totalCategories: nodes.length, completedCategories: 0, failedCategories: 0, products: 0, memberships: 0 });
  const memberships = []; const products = new Map(); const failures = []; const successfulCategoryIds = [];
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
          const categoryMemberships = []; const categoryProductsByKey = new Map();
          for (let pageNumber = 1; pageNumber <= pages; pageNumber++) {
            const items = await fetchRankingPage(session.page, node.categoryId, pageNumber);
            for (let index = 0; index < items.length; index++) {
              const product = normalizeProduct(items[index]);
              if (!product.productId) continue;
              const productKey = `${product.productId}:${product.merchantId}`;
              categoryProductsByKey.set(productKey, product);
              categoryMemberships.push({ categoryId: node.categoryId, rank: (pageNumber - 1) * 20 + index + 1, productKey });
            }
            if (items.length < 20) break;
            await sleep(260);
          }
          categoryResult = { memberships: categoryMemberships, products: categoryProductsByKey };
        } catch (error) {
          lastError = error;
          console.warn(`TAXONOMY_CATEGORY_RETRY shard=${shard} category=${node.categoryId} attempt=${attempt} error=${JSON.stringify(error.message)}`);
          if (attempt < 2) { await sleep(900); await renewSession('category-retry'); }
        }
      }
      if (categoryResult) {
        successfulCategoryIds.push(node.categoryId);
        memberships.push(...categoryResult.memberships);
        for (const [key, product] of categoryResult.products) products.set(key, product);
        categoryProducts = categoryResult.memberships.length;
      } else failures.push({ categoryId: node.categoryId, path: node.path, error: lastError?.message || 'Bilinmeyen hata' });
      if ((categoryIndex + 1) % 10 === 0 || categoryIndex + 1 === nodes.length) {
        writeJsonAtomic(statusFile, {
          schemaVersion: 2, date, shard, shardCount, status: 'running', startedAt, catalogRunId, catalogGeneratedAt: catalog.generatedAt, updatedAt: new Date().toISOString(),
          totalCategories: nodes.length, completedCategories: categoryIndex + 1, failedCategories: failures.length,
          products: products.size, memberships: memberships.length, lastCategory: node.path, lastCategoryProducts: categoryProducts
        });
        console.log(`TAXONOMY_SHARD_PROGRESS shard=${shard} completed=${categoryIndex + 1}/${nodes.length} failures=${failures.length} memberships=${memberships.length}`);
      }
      await sleep(360);
    }
    const enriched = await enrichTaxonomy(session.context, [...products].map(([productKey,p])=>({productKey,...p})), ROOT, shard, date, collectionConfig);
    for (const p of enriched.products) products.set(p.productKey,p);
    detailCoverage = enriched.coverage;
  } finally { await closeSession(); }
  const successRate = nodes.length ? Math.round((nodes.length - failures.length) / nodes.length * 10000) / 100 : 0;
  const status = successRate >= 95 ? 'PASS' : 'FAIL';
  const result = {
    schemaVersion: 2, date, capturedAt: timestamp, startedAt, finishedAt: new Date().toISOString(),
    catalogRunId, catalogGeneratedAt: catalog.generatedAt, shard, shardCount, status,
    totalCategories: nodes.length, completedCategories: nodes.length, failedCategories: failures.length,
    successRate, successfulCategoryIds, detailCoverage,
    products: [...products.entries()].map(([productKey, product]) => ({ productKey, ...product })), memberships, failures
  };
  writeGzipJsonAtomic(path.join(runtimeDir, `shard-${shard}.json.gz`), result);
  writeJsonAtomic(statusFile, { ...result, products: products.size, memberships: memberships.length, finishedAt: new Date().toISOString(), failures: failures.slice(0, 50) });
  if (status !== 'PASS') throw new Error(`Shard ${shard} kalite kapısı başarısız: %${successRate}`);
  return result;
}

if (require.main === module) collect().then(result => console.log(`TAXONOMY_SHARD_OK shard=${result.shard} categories=${result.totalCategories} products=${result.products.length} memberships=${result.memberships.length} success=${result.successRate}`)).catch(error => { console.error(`TAXONOMY_SHARD_FAILED ${error.stack || error.message}`); process.exitCode = 1; });

module.exports = { collect, categoryPages, shardNodes };
