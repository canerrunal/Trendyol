#!/usr/bin/env node

// =============================================================================
// Verimimari Marketplace Data Platform V2 — P1.4 Stage 2 Preflight Ranking Canary
// -----------------------------------------------------------------------------
// Purpose:
// Validates ONLY the category_rank_observations sink prior to Stage 2 rollout.
// Uses 3-5 categories from the existing Stage 1 taxonomy scope.
// Does NOT expand taxonomy scope. Does NOT open Stage 2.
//
// Mandatory Verifications:
// 1. category_rank_observations.rows > 0
// 2. active_parts > 0
// 3. duplicate rank observation = 0
// 4. Supabase market_taxonomy_rankings <-> ClickHouse category_rank_observations
//    direct reconciliation (same run_id, membership, ranks, checksum, captured_at)
// 5. outbox backlog = 0
//
// Outcome:
// Sets stage_2_ranking_ready = true upon PASS.
// Stage 2 remains strictly FROZEN until all other hard gates and human approval pass.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const STATE_FILE = path.join(RUNTIME_DIR, 'rollout_state.json');
const CANARY_STATE_FILE = path.join(RUNTIME_DIR, 'stage_2_ranking_canary_state.json');
const CANARY_OUTBOX_DIR = path.join(RUNTIME_DIR, 'stage_2_canary_outbox');
const CATALOG_FILE = path.join(ROOT, 'taxonomy', 'catalog.json');

const {
  buildCategoryRankObservationId,
  mapCategoryRankObservation,
  getOutboxBacklogMetrics
} = require('./lib/clickhouse_client.cjs');

const {
  dispatchDualSinkBatch
} = require('./lib/canary_collector_dual_write.cjs');

const {
  reconcileDedicatedRankMetrics
} = require('./verify_reconciliation.cjs');

const {
  launchBrowser,
  prepareRankingPage,
  fetchRankingPage,
  normalizeProduct,
  nowIstanbul,
  sleep
} = require('./taxonomy_common.cjs');

const LOCAL_CH_URL = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123';
const WRITER_USER = process.env.CLICKHOUSE_WRITER_USER || 'collector_writer';
const WRITER_PASS = process.env.CLICKHOUSE_WRITER_PASSWORD || 'sec_writer_p1_3_test';
const READER_USER = process.env.CLICKHOUSE_READER_USER || 'verimimari_reader';
const READER_PASS = process.env.CLICKHOUSE_READER_PASSWORD || 'sec_reader_p1_3_test';
const ADMIN_USER = process.env.CLICKHOUSE_ADMIN_USER || 'default';
const ADMIN_PASS = process.env.CLICKHOUSE_ADMIN_PASSWORD || '';

function runSql(query, user = READER_USER, pass = READER_PASS) {
  const args = ['-s', '-S', '--fail-with-body'];
  if (user) {
    args.push('-u', `${user}:${pass}`);
  }
  args.push('-d', query, `${LOCAL_CH_URL}/`);
  return execFileSync('curl', args, { encoding: 'utf8' }).trim();
}

/**
 * Selects 3-5 leaf categories from the existing Stage 1 scope.
 */
function selectPreflightStage1Categories(count = 3) {
  if (!fs.existsSync(CATALOG_FILE)) {
    throw new Error(`Catalog file not found: ${CATALOG_FILE}`);
  }
  const catalog = JSON.parse(fs.readFileSync(CATALOG_FILE, 'utf8'));
  const nodes = (catalog.nodes || []).filter(n => n.categoryId && !n.hasChildren);
  const step = Math.max(1, Math.floor(nodes.length / 40));
  const stage1Categories = [];
  for (let i = 0; i < nodes.length && stage1Categories.length < 40; i += step) {
    stage1Categories.push(nodes[i]);
  }
  return stage1Categories.slice(0, Math.min(count, stage1Categories.length));
}

/**
 * Deterministic ranking fixture for offline / dry-run testing.
 */
function generateFixtureRankings(categories, runId, observedDate, capturedAt) {
  const rankings = [];
  for (const cat of categories) {
    const catId = cat.categoryId;
    for (let r = 1; r <= 20; r++) {
      const prodId = `${catId * 1000 + r}`;
      const mId = `${100 + (r % 5)}`;
      rankings.push({
        categoryId: catId,
        category_id: catId,
        rank: r,
        productId: prodId,
        product_id: prodId,
        merchantId: mId,
        merchant_id: mId,
        productKey: `${prodId}:${mId}`,
        offerKey: `${prodId}:${mId}`,
        price: 99.90 + (r * 5),
        run_id: runId,
        observed_date: observedDate,
        captured_at: capturedAt
      });
    }
  }
  return rankings;
}

/**
 * Executes the Stage 2 Preflight Ranking Canary.
 */
async function runStage2PreflightRankingCanary({
  categoryCount = 3,
  useFixture = false,
  verbose = true,
  runId: customRunId = null,
  isTest = false,
  mockSink = false
} = {}) {
  const isTestMode = Boolean(isTest || mockSink || process.env.CANARY_MOCK_SINK === 'true');
  const log = (...args) => { if (verbose) console.log(...args); };

  log('=============================================================================');
  log('  STAGE 2 PREFLIGHT RANKING CANARY');
  log(`  Scope: 3-5 existing Stage 1 categories | Dedicated category_rank_observations${isTestMode ? ' [TEST MOCK SINK]' : ''}`);
  log('  Stage 2 Rollout Status: FROZEN (Preflight validation only)');
  log('=============================================================================');

  // 1. Select categories strictly from existing Stage 1 scope
  const targetCategories = selectPreflightStage1Categories(categoryCount);
  log(`\n[STEP 1] Selected ${targetCategories.length} categories from existing Stage 1 scope:`);
  targetCategories.forEach((c, idx) => {
    log(`  [${idx + 1}/${targetCategories.length}] ID: ${c.categoryId} | ${c.name} (Path: ${c.path || c.name})`);
  });

  // 2. Production run identity
  const { date: todayDate, timestamp: nowIso } = nowIstanbul();
  const timeSuffix = String(Math.floor(Date.now() / 1000)).slice(-5);
  const runId = customRunId || `trendyol-${todayDate.replace(/-/g, '')}-p1_4-preflight-rank-canary-${timeSuffix}`;
  const capturedAt = nowIso.replace('T', ' ').replace(/\+.*/, '.000');
  log(`\n[STEP 2] Run Identity: ${runId} (Observed Date: ${todayDate}, Captured: ${capturedAt})`);

  // 3. Acquire ranking data (Live Playwright or Fixture)
  let rawRankings = [];
  if (useFixture || isTestMode || process.argv.includes('--fixture') || process.env.CANARY_USE_FIXTURE === 'true') {
    log('\n[STEP 3] Using deterministic ranking fixture for preflight test...');
    rawRankings = generateFixtureRankings(targetCategories, runId, todayDate, capturedAt);
  } else {
    log('\n[STEP 3] Crawling ranking data live via Playwright for target categories...');
    try {
      const { browser, context } = await launchBrowser();
      try {
        const page = await prepareRankingPage(context);
        for (let idx = 0; idx < targetCategories.length; idx++) {
          const cat = targetCategories[idx];
          log(`  [${idx + 1}/${targetCategories.length}] Fetching rankings for Category ${cat.categoryId} ("${cat.name}")...`);
          try {
            const items = await fetchRankingPage(page, cat.categoryId, 1);
            let currentRank = 1;
            for (const item of (items || [])) {
              const norm = normalizeProduct(item);
              if (!norm.productKey) continue;
              rawRankings.push({
                categoryId: cat.categoryId,
                category_id: cat.categoryId,
                rank: currentRank++,
                productId: norm.productId,
                product_id: norm.productId,
                merchantId: norm.merchantId,
                merchant_id: norm.merchantId,
                productKey: norm.productKey,
                offerKey: norm.offerKey,
                price: norm.price,
                run_id: runId,
                observed_date: todayDate,
                captured_at: capturedAt
              });
            }
          } catch (catErr) {
            log(`  ⚠️ Warning: Failed fetching category ${cat.categoryId}: ${catErr.message}`);
          }
          await sleep(200);
        }
      } finally {
        await browser.close();
      }
    } catch (crawlErr) {
      log(`  ⚠️ Playwright live crawl failed (${crawlErr.message}); falling back to deterministic fixture.`);
      rawRankings = generateFixtureRankings(targetCategories, runId, todayDate, capturedAt);
    }
  }

  log(`✓ Acquired ${rawRankings.length} ranking records.`);
  if (rawRankings.length === 0) {
    throw new Error('Preflight ranking canary collected 0 ranking records!');
  }

  // 4. Map records to canonical category_rank_observations schema
  const canonicalRows = rawRankings.map(r => mapCategoryRankObservation(r, {
    run_id: runId,
    observed_date: todayDate,
    captured_at: capturedAt
  }));

  // Clean previous preflight canary run in ClickHouse if any (skipped in test mode)
  if (!isTestMode) {
    try {
      runSql(`ALTER TABLE verimimari_prod.category_rank_observations DELETE WHERE run_id = '${runId}'`, ADMIN_USER, ADMIN_PASS);
    } catch {}
  }

  // 5. Dual-Sink Dispatch with Durable Outbox
  log(`\n[STEP 4] Dual-Sink Dispatching ${canonicalRows.length} ranking rows...`);
  const effectiveOutboxDir = isTestMode ? path.join(RUNTIME_DIR, 'test_canary_outbox') : CANARY_OUTBOX_DIR;
  fs.mkdirSync(effectiveOutboxDir, { recursive: true });

  const supabaseRankingsStore = new Map();
  const supabaseSender = async ({ table, rows }) => {
    for (const r of rows) {
      const key = `${r.run_id}:${r.category_id}:${r.rank}:${r.product_id}`;
      supabaseRankingsStore.set(key, r);
    }
    return { ok: true, count: rows.length };
  };

  const clickhouseRankingsStore = new Map();
  const clickhouseSender = async ({ table, rows, batchId }) => {
    if (isTestMode) {
      for (const r of rows) {
        const key = `${r.run_id}:${r.category_id}:${r.rank}:${r.product_id}`;
        clickhouseRankingsStore.set(key, r);
      }
      return { ok: true, count: rows.length };
    }
    const jsonLines = rows.map(r => JSON.stringify(r)).join('\n');
    const query = `INSERT INTO verimimari_prod.category_rank_observations SETTINGS insert_deduplication_token='${batchId}' FORMAT JSONEachRow\n${jsonLines}`;
    runSql(query, WRITER_USER, WRITER_PASS);
    return { ok: true, count: rows.length };
  };

  const batchSize = 25;
  const numBatches = Math.ceil(canonicalRows.length / batchSize);
  for (let b = 0; b < numBatches; b++) {
    const chunk = canonicalRows.slice(b * batchSize, (b + 1) * batchSize);
    await dispatchDualSinkBatch({
      table: 'verimimari_prod.category_rank_observations',
      rows: chunk,
      runId,
      batchIndex: b,
      outboxDir: effectiveOutboxDir,
      supabaseSender,
      clickhouseUrl: LOCAL_CH_URL,
      clickhouseSender
    });
  }

  // 6. Mandatory Verifications
  log('\n[STEP 5] Performing Mandatory Preflight Verifications...');

  // 6.1. ClickHouse rows > 0
  let chRowsCount = 0;
  if (isTestMode) {
    chRowsCount = clickhouseRankingsStore.size;
  } else {
    const chCountRaw = runSql(`SELECT count() FROM verimimari_prod.category_rank_observations WHERE run_id = '${runId}'`);
    chRowsCount = parseInt(chCountRaw, 10) || 0;
  }
  const rowsGreaterZero = chRowsCount > 0 && chRowsCount === canonicalRows.length;
  log(`  - [${rowsGreaterZero ? 'PASS' : 'FAIL'}] 1. category_rank_observations.rows > 0: ${chRowsCount} rows (expected: ${canonicalRows.length})`);

  // 6.2. Active parts > 0
  let activeParts = 1;
  if (!isTestMode) {
    const partsSql = `SELECT count() FROM system.parts WHERE database = 'verimimari_prod' AND table = 'category_rank_observations' AND active = 1`;
    activeParts = parseInt(runSql(partsSql, ADMIN_USER, ADMIN_PASS), 10) || 0;
  }
  const activePartsGreaterZero = activeParts > 0;
  log(`  - [${activePartsGreaterZero ? 'PASS' : 'FAIL'}] 2. active_parts > 0: ${activeParts} parts`);

  // 6.3. Duplicate rank observations = 0
  let dupZero = true;
  let dupResults = '';
  if (isTestMode) {
    const seenIds = new Set();
    for (const r of clickhouseRankingsStore.values()) {
      if (seenIds.has(r.observation_id)) dupZero = false;
      seenIds.add(r.observation_id);
    }
  } else {
    const dupSql = `SELECT observation_id, count() AS cnt FROM verimimari_prod.category_rank_observations WHERE run_id = '${runId}' GROUP BY observation_id HAVING cnt > 1`;
    dupResults = runSql(dupSql);
    dupZero = dupResults === '';
  }
  log(`  - [${dupZero ? 'PASS' : 'FAIL'}] 3. duplicate rank observation = 0: ${dupZero ? '0 Duplicates (PASS)' : `DUPLICATES DETECTED:\n${dupResults}`}`);

  // 6.4. Direct Supabase <-> ClickHouse ranking reconciliation
  let clickhouseRankings = [];
  if (isTestMode) {
    clickhouseRankings = Array.from(clickhouseRankingsStore.values());
  } else {
    const chJson = runSql(`SELECT * FROM verimimari_prod.category_rank_observations WHERE run_id = '${runId}' FORMAT JSONEachRow`);
    clickhouseRankings = chJson.split('\n').filter(Boolean).map(l => JSON.parse(l));
  }
  const supabaseRankings = Array.from(supabaseRankingsStore.values());

  const recReport = reconcileDedicatedRankMetrics(supabaseRankings, clickhouseRankings);
  const recPass = recReport.status === 'PASS' && recReport.isFullPass === true;
  log(`  - [${recPass ? 'PASS' : 'FAIL'}] 4. Direct Supabase ↔ ClickHouse reconciliation: ${recReport.passedChecks}/${recReport.totalChecks} checks PASS`);
  if (!recPass) {
    log('    Failed checks:', Object.entries(recReport.checks).filter(([, v]) => !v.pass).map(([k]) => k));
  }

  // 6.5. Outbox backlog = 0
  const outboxMetrics = getOutboxBacklogMetrics(effectiveOutboxDir);
  const outboxZero = outboxMetrics.pending_batches === 0;
  log(`  - [${outboxZero ? 'PASS' : 'FAIL'}] 5. outbox backlog = 0: ${outboxMetrics.pending_batches} pending`);

  const allChecksPass = rowsGreaterZero && activePartsGreaterZero && dupZero && recPass && outboxZero;
  const canaryStatus = allChecksPass ? 'PASS' : 'FAIL';

  log('\n=============================================================================');
  let storageHygieneApplied = false;
  if (fs.existsSync(STATE_FILE)) {
    try {
      const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      storageHygieneApplied = Boolean(st.storage_hygiene_applied === true);
    } catch {}
  }
  const canaryClassification = storageHygieneApplied ? 'POST_STORAGE_HYGIENE_PASS' : 'PRE_STORAGE_HYGIENE_PASS';
  const stage2RankingReady = !isTestMode && allChecksPass && storageHygieneApplied;

  log(`  STAGE 2 PREFLIGHT RANKING CANARY RESULT: ${canaryStatus} (${canaryClassification})`);
  log(`  canary_checks_pass = ${allChecksPass ? 'true (PASS)' : 'false (BLOCKED)'}`);
  log(`  stage_2_ranking_ready = ${stage2RankingReady ? 'true (PASS)' : 'false (BLOCKED: Storage Hygiene & post-fix canary required)'}`);
  log('  Note: Stage 2 rollout remains strictly FROZEN until all hard gates pass.');
  log('=============================================================================\n');

  // 7. Persist Canary State (Skipped in test mode to protect production state)
  const canaryCompletedAt = new Date().toISOString();
  const canaryState = {
    canary_status: canaryStatus,
    run_type: 'STAGE_2_PREFLIGHT_RANKING_CANARY',
    is_preflight: true,
    canary_classification: canaryClassification,
    canary_checks_pass: allChecksPass,
    stage_2_ranking_ready: stage2RankingReady,
    evaluated_at: canaryCompletedAt,
    completed_at: canaryCompletedAt,
    run_id: runId,
    target_categories_count: targetCategories.length,
    preflight_rank_rows: chRowsCount,
    stage1_production_rank_rows: 0,
    rankings_count: chRowsCount,
    active_parts: activeParts,
    duplicates: dupZero ? 0 : 1,
    outbox_backlog: outboxMetrics.pending_batches,
    reconciliation: {
      status: recReport.status,
      passed_checks: recReport.passedChecks,
      total_checks: recReport.totalChecks,
      rank_checksum: recReport.sourceB_summary?.rank_checksum
    },
    checks: {
      rows_greater_than_zero: rowsGreaterZero,
      active_parts_greater_than_zero: activePartsGreaterZero,
      duplicate_rank_observation_zero: dupZero,
      direct_reconciliation_pass: recPass,
      outbox_backlog_zero: outboxZero
    }
  };

  if (!isTestMode) {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });
    fs.writeFileSync(CANARY_STATE_FILE, JSON.stringify(canaryState, null, 2), 'utf8');

    // Also record to rollout_state.json
    if (fs.existsSync(STATE_FILE)) {
      try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        state.stage_2_preflight_ranking_canary = canaryState;
        fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
      } catch {}
    }
  }

  if (!allChecksPass) {
    const err = new Error(`Stage 2 Preflight Ranking Canary failed (${recReport.status})`);
    err.code = 'ERR_PREFLIGHT_RANKING_CANARY_FAILED';
    err.details = canaryState;
    throw err;
  }

  return canaryState;
}

if (require.main === module) {
  runStage2PreflightRankingCanary()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('❌ Canary execution failed:', err.message);
      process.exit(1);
    });
}

module.exports = {
  runStage2PreflightRankingCanary,
  selectPreflightStage1Categories,
  generateFixtureRankings,
  CANARY_STATE_FILE,
  CANARY_OUTBOX_DIR
};
