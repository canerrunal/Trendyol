#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const BATCH_SIZE = Number(process.env.TAXONOMY_PUBLISH_BATCH_SIZE || 500);
const CONCURRENCY = Number(process.env.TAXONOMY_PUBLISH_CONCURRENCY || 6);
const MAX_PUBLISHED_RANK = 1000;

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readNdjsonGzip(file) {
  return zlib
    .gunzipSync(fs.readFileSync(file))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

function batches(rows, size = BATCH_SIZE) {
  return Array.from({ length: Math.ceil(rows.length / size) }, (_, index) =>
    rows.slice(index * size, index * size + size)
  );
}

function publishableRankings(rows) {
  return rows.filter(
    row =>
      Number.isInteger(row?.rank) &&
      row.rank > 0 &&
      row.rank <= MAX_PUBLISHED_RANK &&
      Number.isInteger(row?.categoryId) &&
      row.categoryId > 0 &&
      typeof row?.productKey === 'string' &&
      row.productKey.length > 0
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function requestJson(baseUrl, secret, method, payload) {
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const response = await fetch(
        `${baseUrl.replace(/\/$/, '')}/api/pazar-nabzi/taksonomi/ingest`,
        {
          method,
          headers: {
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(90000)
        }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.ok !== true) {
        const error = new Error(`HTTP ${response.status} ${JSON.stringify(result)}`);
        if (response.status >= 400 && response.status < 500 && response.status !== 429) throw error;
        lastError = error;
      } else return result;
    } catch (error) {
      lastError = error;
      if (/HTTP 4\d\d/.test(error.message) && !/HTTP 429/.test(error.message)) throw error;
    }
    if (attempt < 4) await sleep(1000 * 2 ** (attempt - 1));
  }
  throw lastError || new Error('Taksonomi yayın isteği başarısız.');
}

async function publishBatches(baseUrl, secret, action, runId, rows) {
  const queue = batches(rows);
  let cursor = 0;
  let accepted = 0;
  async function worker() {
    while (cursor < queue.length) {
      const index = cursor++;
      const batch = queue[index];
      const result = await requestJson(baseUrl, secret, 'POST', { action, runId, rows: batch });
      accepted += Number(result.accepted || 0);
      if ((index + 1) % 20 === 0 || index + 1 === queue.length) {
        console.log(`TAXONOMY_PUBLISH_PROGRESS action=${action} batches=${index + 1}/${queue.length}`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
  return accepted;
}

async function main() {
  const baseUrl = process.env.VERI_MIMARI_INGEST_URL || '';
  const secret = process.env.VERI_MIMARI_INGEST_SECRET || '';
  if (!baseUrl || !secret) {
    console.log('TAXONOMY_PUBLISH_SKIPPED Veri Mimarı yayın sırları tanımlı değil.');
    return;
  }
  if (!Number.isInteger(BATCH_SIZE) || BATCH_SIZE < 1 || BATCH_SIZE > 1000) {
    throw new Error(`Geçersiz TAXONOMY_PUBLISH_BATCH_SIZE: ${BATCH_SIZE}`);
  }
  if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1 || CONCURRENCY > 12) {
    throw new Error(`Geçersiz TAXONOMY_PUBLISH_CONCURRENCY: ${CONCURRENCY}`);
  }

  const catalog = readJson(path.join(ROOT, 'taxonomy', 'catalog.json'));
  const summary = readJson(path.join(ROOT, 'taxonomy', 'status.json'));
  if (summary.status !== 'PASS') {
    console.log(`TAXONOMY_PUBLISH_BLOCKED status=${summary.status} reason=quality-gate-partial-or-fail`);
    return;
  }
  if (!summary.date || !catalog.nodes?.length) throw new Error('Taksonomi kataloğu veya tarih eksik.');
  if (summary.catalogGeneratedAt !== catalog.generatedAt) {
    throw new Error('Taksonomi özeti güncel katalogla eşleşmiyor.');
  }
  const snapshotRoot = path.join(ROOT, 'taxonomy', 'snapshots', summary.date);
  const products = readNdjsonGzip(path.join(snapshotRoot, 'products.ndjson.gz'));
  const sourceRankings = readNdjsonGzip(path.join(snapshotRoot, 'rankings.ndjson.gz'));
  if (
    products.length !== summary.uniqueProducts ||
    sourceRankings.length !== summary.rankingMemberships
  ) {
    throw new Error(
      `Taksonomi dosya sayıları özetle eşleşmiyor: products=${products.length}/${summary.uniqueProducts} rankings=${sourceRankings.length}/${summary.rankingMemberships}`
    );
  }
  const rankings = publishableRankings(sourceRankings);
  if (!rankings.length) throw new Error('Yayınlanabilir kategori sıralaması bulunamadı.');
  if (rankings.length !== sourceRankings.length) {
    console.log(
      `TAXONOMY_PUBLISH_RANK_LIMIT kept=${rankings.length} omitted=${sourceRankings.length - rankings.length} max=${MAX_PUBLISHED_RANK}`
    );
  }

  const started = await requestJson(baseUrl, secret, 'POST', {
    action: 'start',
    summary: {
      ...summary,
      rankingMemberships: rankings.length,
      catalogRunId: catalog.runId || catalog.generatedAt
    },
    sourceCommit: process.env.GITHUB_SHA || null
  });
  const runId = started.runId;
  console.log(`TAXONOMY_PUBLISH_STARTED run=${runId} date=${summary.date}`);

  await publishBatches(baseUrl, secret, 'categories', runId, catalog.nodes);
  await publishBatches(baseUrl, secret, 'products', runId, products);
  await publishBatches(baseUrl, secret, 'rankings', runId, rankings);

  const completed = await requestJson(baseUrl, secret, 'PUT', {
    action: 'complete',
    runId,
    catalogGeneratedAt: catalog.generatedAt,
    finalStatus: summary.status
  });
  console.log(
    `TAXONOMY_PUBLISH_OK run=${runId} categories=${completed.counts.categories} paths=${completed.counts.paths} products=${completed.counts.products} rankings=${completed.counts.rankings}`
  );
}

if (require.main === module) {
  main().catch(error => {
    console.error(`TAXONOMY_PUBLISH_FAILED ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = {
  batches,
  publishableRankings,
  readNdjsonGzip,
  publishBatches,
  requestJson
};
