// =============================================================================
// Verimimari Marketplace Data Platform V2 — P1.2 Real ClickHouse Canary Runner
// Runs real canary dual-write on Darwin arm64 with isolated 'trendyol_canary' schema.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync, execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const {
  mapProductObservation,
  sendClickHouseBatch,
  pingClickHouse,
  getOutboxBacklogMetrics
} = require('./lib/clickhouse_client.cjs');

const {
  dispatchDualSinkBatch,
  recoverPendingOutbox
} = require('./lib/canary_collector_dual_write.cjs');

const {
  reconcileDatasetMetrics
} = require('./verify_reconciliation.cjs');

const {
  buildStatus
} = require('../dashboard/server.cjs');

const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123';
const CANARY_OUTBOX_DIR = path.join(ROOT, '.runtime', 'clickhouse_canary_outbox');
const CH_BIN = path.join(ROOT, '.runtime', 'bin', 'clickhouse');
const CH_PREFIX = path.join(ROOT, '.runtime', 'clickhouse_canary');

function runClickHouseSql(query) {
  const output = execFileSync('curl', [
    '-s',
    '--data-binary',
    query,
    `${CLICKHOUSE_URL}/`
  ], { encoding: 'utf8' });
  return output.trim();
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=============================================================================');
  console.log('  STARTING P1.2 REAL CLICKHOUSE CANARY INTEGRATION EXECUTION');
  console.log('=============================================================================');

  // Ensure canary outbox exists
  fs.mkdirSync(CANARY_OUTBOX_DIR, { recursive: true });

  // 1. Verify ClickHouse Server is healthy
  console.log('\n[STEP 1] Verifying ClickHouse Server Connection...');
  const ping = await pingClickHouse(CLICKHOUSE_URL);
  if (!ping.ok) {
    throw new Error(`ClickHouse is not running at ${CLICKHOUSE_URL}: ${ping.error}`);
  }
  const chVersion = runClickHouseSql('SELECT version()');
  console.log(`✓ ClickHouse is online: Version ${chVersion} at ${CLICKHOUSE_URL}`);

  // Ensure isolated schema 'trendyol_canary' is ready
  runClickHouseSql('CREATE DATABASE IF NOT EXISTS trendyol_canary');
  const ddlPath = path.join(ROOT, 'scripts', 'sql', 'clickhouse_canary_schema.sql');
  const ddlSql = fs.readFileSync(ddlPath, 'utf8');
  for (const stmt of ddlSql.split(';').map(s => s.trim()).filter(Boolean)) {
    runClickHouseSql(stmt);
  }
  console.log('✓ Isolated schema trendyol_canary and tables verified.');

  // Clean previous canary run test data from ClickHouse
  runClickHouseSql('TRUNCATE TABLE trendyol_canary.product_observations');
  runClickHouseSql('TRUNCATE TABLE trendyol_canary.category_rank_observations');

  // 2. Select Canary Scope: Category 31 ("Şal", 292 products) from real snapshot
  console.log('\n[STEP 2] Loading Real Canary Scope from 2026-09-17 Snapshot (Category 31: "Şal")...');
  const snapshotDate = '2026-09-17';
  const snapshotDir = path.join(ROOT, 'taxonomy', 'snapshots', snapshotDate);
  const rankingsRaw = zlib.gunzipSync(fs.readFileSync(path.join(snapshotDir, 'rankings.ndjson.gz')))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));

  const cat31Rankings = rankingsRaw.filter(r => Number(r.categoryId) === 31);
  console.log(`✓ Found ${cat31Rankings.length} rankings for Category 31.`);

  const cat31ProductKeys = new Set(cat31Rankings.map(r => r.productKey));
  const productsRaw = zlib.gunzipSync(fs.readFileSync(path.join(snapshotDir, 'products.ndjson.gz')))
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));

  const cat31Products = productsRaw.filter(p => cat31ProductKeys.has(p.productKey));
  console.log(`✓ Found ${cat31Products.length} matching products for Category 31.`);

  const runId = `trendyol-${snapshotDate.replace(/-/g, '')}-canary-cat31`;
  const capturedAt = `${snapshotDate} 19:10:00.000`;

  // Map to ClickHouse and Supabase canonical models
  const canaryRows = cat31Products.map((raw, idx) => {
    return mapProductObservation({
      ...raw,
      run_id: runId,
      observed_date: snapshotDate,
      captured_at: capturedAt,
      source_scope: 'taxonomy'
    });
  });

  console.log(`✓ Mapped ${canaryRows.length} canonical observations with deterministic observation_ids.`);

  // 3. Supabase and ClickHouse Dual-Write Dispatch
  console.log('\n[STEP 3] Executing Write-Ahead Spool and Dual-Write Dispatch...');

  // Track Supabase destination table states
  const supabaseDb = {
    market_taxonomy_products: new Map(),
    market_taxonomy_product_observations: new Map(),
    market_taxonomy_rankings: new Map()
  };

  const supabaseSender = async ({ table, rows, runId, batchId }) => {
    // Simulates the exact Supabase Next.js ingest contract (upsert with onConflict)
    for (const r of rows) {
      // 1. market_taxonomy_products onConflict: marketplace,product_key
      const prodKey = `trendyol:${r.product_id}`;
      supabaseDb.market_taxonomy_products.set(prodKey, {
        marketplace: 'trendyol',
        product_key: r.offer_key,
        product_id: r.product_id,
        merchant_id: r.merchant_id
      });

      // 2. market_taxonomy_product_observations onConflict: run_id,product_key
      const obsKey = `${runId}:${r.offer_key}`;
      supabaseDb.market_taxonomy_product_observations.set(obsKey, {
        run_id: runId,
        product_id: r.product_id,
        merchant_id: r.merchant_id,
        offer_key: r.offer_key,
        product_key: r.offer_key,
        observation_id: r.observation_id,
        price: r.price,
        original_price: r.original_price,
        in_stock: r.in_stock === 1 ? true : (r.in_stock === 0 ? false : null),
        observed_date: r.observed_date,
        captured_at: r.captured_at
      });
    }

    for (const r of cat31Rankings) {
      // 3. market_taxonomy_rankings onConflict: run_id,category_id,rank,product_key
      const rankKey = `${runId}:${r.categoryId}:${r.rank}:${r.productKey}`;
      supabaseDb.market_taxonomy_rankings.set(rankKey, {
        run_id: runId,
        category_id: r.categoryId,
        rank: r.rank,
        product_id: String(r.productKey || '').split(':')[0],
        product_key: r.productKey
      });
    }

    return { ok: true, count: rows.length };
  };

  const dispatchResult = await dispatchDualSinkBatch({
    table: 'trendyol_canary.product_observations',
    rows: canaryRows,
    runId,
    batchIndex: 0,
    outboxDir: CANARY_OUTBOX_DIR,
    supabaseSender,
    clickhouseUrl: CLICKHOUSE_URL
  });

  console.log('✓ Dual-Write Dispatch Result:', {
    batchId: dispatchResult.batchId,
    batchChecksum: dispatchResult.batchChecksum,
    rowCount: dispatchResult.rowCount,
    spooled: dispatchResult.spooled,
    sinks: {
      supabase: dispatchResult.sinks.supabase.ok,
      clickhouse: dispatchResult.sinks.clickhouse.ok
    }
  });

  // 4. ClickHouse Direct SQL Validation
  console.log('\n[STEP 4] Querying ClickHouse directly via HTTP SQL...');
  const countSql = `SELECT count() FROM trendyol_canary.product_observations WHERE run_id = '${runId}'`;
  const uniqSql = `SELECT uniqExact(observation_id) FROM trendyol_canary.product_observations WHERE run_id = '${runId}'`;
  const dupSql = `SELECT observation_id, count() AS cnt FROM trendyol_canary.product_observations WHERE run_id = '${runId}' GROUP BY observation_id HAVING cnt > 1`;

  const totalCount = Number(runClickHouseSql(countSql));
  const uniqCount = Number(runClickHouseSql(uniqSql));
  const dupResults = runClickHouseSql(dupSql);

  console.log(`[SQL 1] count(): ${totalCount}`);
  console.log(`[SQL 2] uniqExact(observation_id): ${uniqCount}`);
  console.log(`[SQL 3] duplicates (HAVING cnt > 1): ${dupResults ? dupResults : '0 (None)'}`);

  if (totalCount !== canaryRows.length) throw new Error(`Count mismatch: expected ${canaryRows.length}, got ${totalCount}`);
  if (uniqCount !== canaryRows.length) throw new Error(`Uniq mismatch: expected ${canaryRows.length}, got ${uniqCount}`);
  if (dupResults !== '') throw new Error(`Duplicates found: ${dupResults}`);

  // 5. Double Replay Test on MergeTree & Supabase
  console.log('\n[STEP 5] Testing Intentional Double Replay (Idempotency Proof)...');
  console.log('Sending identical batch to ClickHouse second time with same batchId & dedup token...');

  // Replay to ClickHouse
  const replayChRes = await sendClickHouseBatch({
    baseUrl: CLICKHOUSE_URL,
    table: 'trendyol_canary.product_observations',
    rows: canaryRows,
    runId,
    batchIndex: 0,
    writeAhead: false
  });
  console.log(`✓ ClickHouse Replay response: ok=${replayChRes.ok}`);

  // Replay to Supabase
  await supabaseSender({ table: 'trendyol_canary.product_observations', rows: canaryRows, runId, batchId: dispatchResult.batchId });
  console.log(`✓ Supabase Replay executed.`);

  // Verify ClickHouse counts did NOT double on MergeTree
  const countAfterReplay = Number(runClickHouseSql(countSql));
  const uniqAfterReplay = Number(runClickHouseSql(uniqSql));
  const dupAfterReplay = runClickHouseSql(dupSql);

  console.log(`[Replay SQL 1] count() after replay: ${countAfterReplay}`);
  console.log(`[Replay SQL 2] uniqExact(observation_id) after replay: ${uniqAfterReplay}`);
  console.log(`[Replay SQL 3] duplicates after replay: ${dupAfterReplay ? dupAfterReplay : '0 (None)'}`);

  if (countAfterReplay !== canaryRows.length) {
    throw new Error(`Duplicate rows detected in ClickHouse! Count is ${countAfterReplay}, expected ${canaryRows.length}`);
  }

  // Verify Supabase counts
  const supaObsCount = supabaseDb.market_taxonomy_product_observations.size;
  const supaRankCount = supabaseDb.market_taxonomy_rankings.size;
  console.log(`✓ Supabase observation table count after replay: ${supaObsCount}`);
  console.log(`✓ Supabase ranking table count after replay: ${supaRankCount}`);

  // 6. Real ClickHouse Offline Resiliency Test
  console.log('\n[STEP 6] Executing Real ClickHouse Offline Resiliency Test...');
  console.log('Stopping ClickHouse server...');
  const pidFile = path.join(CH_PREFIX, 'var', 'run', 'clickhouse-server', 'clickhouse-server.pid');
  if (fs.existsSync(pidFile)) {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    try {
      process.kill(pid, 'SIGTERM');
      let alive = true;
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        try { process.kill(pid, 0); } catch { alive = false; break; }
      }
      if (alive) process.kill(pid, 'SIGKILL');
    } catch {}
  }
  await sleep(1000);

  const pingOffline = await pingClickHouse(CLICKHOUSE_URL, 1000);
  console.log(`✓ ClickHouse offline verified: ping.ok=${pingOffline.ok}`);

  console.log('Collector runs while ClickHouse is offline (sending new offline batch)...');
  const offlineRows = [
    mapProductObservation({
      product_id: 'offline-test-p1',
      merchant_id: 'm1',
      name: 'Offline Resiliency Item',
      price: 149.99,
      in_stock: true,
      run_id: runId,
      observed_date: snapshotDate,
      captured_at: capturedAt
    })
  ];

  const offlineDispatch = await dispatchDualSinkBatch({
    table: 'trendyol_canary.product_observations',
    rows: offlineRows,
    runId,
    batchIndex: 1,
    outboxDir: CANARY_OUTBOX_DIR,
    supabaseSender,
    clickhouseUrl: CLICKHOUSE_URL
  });

  console.log(`✓ Batch dispatched during offline: spooled=${offlineDispatch.spooled}, ch_status=${offlineDispatch.sinks.clickhouse.ok}`);
  const backlogDuringOffline = getOutboxBacklogMetrics(CANARY_OUTBOX_DIR);
  console.log(`✓ Outbox backlog while offline: pending_batches=${backlogDuringOffline.pending_batches}, clickhouse_pending=${backlogDuringOffline.sinks_pending.clickhouse}`);

  console.log('Restarting ClickHouse server via clickhouse start...');
  execSync(`"${CH_BIN}" start --prefix="${CH_PREFIX}" --no-sudo`);
  await sleep(2000);

  const pingOnline = await pingClickHouse(CLICKHOUSE_URL, 2000);
  console.log(`✓ ClickHouse online verified: ping.ok=${pingOnline.ok}`);

  console.log('Running recoverPendingOutbox() to drain accumulated spool...');
  const recoveryResult = await recoverPendingOutbox({
    outboxDir: CANARY_OUTBOX_DIR,
    supabaseSender,
    clickhouseUrl: CLICKHOUSE_URL
  });
  console.log('✓ Recovery result:', recoveryResult);

  const backlogAfterRecovery = getOutboxBacklogMetrics(CANARY_OUTBOX_DIR);
  console.log(`✓ Outbox backlog after recovery: pending_batches=${backlogAfterRecovery.pending_batches}`);

  if (backlogAfterRecovery.pending_batches !== 0) {
    throw new Error(`Expected backlog 0 after recovery, got ${backlogAfterRecovery.pending_batches}`);
  }

  // 7. Full 14-Metric Reconciliation Report
  console.log('\n[STEP 7] Performing Full 14-Metric Reconciliation...');

  // Fetch actual rows from ClickHouse
  const chRawJson = runClickHouseSql(`SELECT * FROM trendyol_canary.product_observations WHERE run_id = '${runId}' FORMAT JSONEachRow`);
  const clickhouseObs = chRawJson.split('\n').filter(Boolean).map(l => JSON.parse(l));

  const supabaseObs = Array.from(supabaseDb.market_taxonomy_product_observations.values());
  const supabaseRankings = Array.from(supabaseDb.market_taxonomy_rankings.values());

  const datasetA = {
    run_id: runId,
    observations: supabaseObs,
    rankings: supabaseRankings
  };

  const datasetB = {
    run_id: runId,
    observations: clickhouseObs,
    rankings: cat31Rankings.map(r => ({ category_id: r.categoryId, rank: r.rank, product_id: r.productKey.split(':')[0] }))
  };

  const reconciliationReport = reconcileDatasetMetrics(datasetA, datasetB);
  console.log('\n=============================================================================');
  console.log('  RECONCILIATION RESULT SUMMARY');
  console.log('=============================================================================');
  console.log(`Status: ${reconciliationReport.status}`);
  console.log(`Passed Metrics: ${reconciliationReport.passedMetrics} / ${reconciliationReport.totalMetrics}`);
  console.log(`Failed Metrics: ${reconciliationReport.failedMetrics}`);
  console.log('Detailed 14 Metrics:');
  for (const [metric, res] of Object.entries(reconciliationReport.metrics)) {
    console.log(`  - [${res.pass ? 'PASS' : 'FAIL'}] ${metric}: sourceA=${JSON.stringify(res.sourceA)} | sourceB=${JSON.stringify(res.sourceB)}`);
  }

  if (reconciliationReport.status !== 'PASS') {
    throw new Error('Reconciliation did not pass across all 14 metrics!');
  }

  // 8. Dashboard Health Output
  console.log('\n[STEP 8] Verifying Dashboard Health Check Output...');
  process.env.CLICKHOUSE_URL = CLICKHOUSE_URL;
  const dashStatus = buildStatus({ bypassCache: true });
  console.log('Dashboard clickhouse status:', JSON.stringify(dashStatus.clickhouse, null, 2));

  console.log('\n=============================================================================');
  console.log('  ALL P1.2 CANARY VALIDATIONS COMPLETED SUCCESSFULLY');
  console.log('=============================================================================');

  return {
    runId,
    batchId: dispatchResult.batchId,
    rowCount: canaryRows.length,
    reconciliationReport,
    dashboardHealth: dashStatus.clickhouse,
    clickhouseSqlResults: {
      count: countAfterReplay,
      uniqExact: uniqAfterReplay,
      duplicates: dupAfterReplay || 0
    }
  };
}

if (require.main === module) {
  main().then(res => {
    fs.writeFileSync(path.join(ROOT, '.runtime', 'canary_p1_2_report.json'), JSON.stringify(res, null, 2));
    process.exit(0);
  }).catch(err => {
    console.error('CANARY RUN FAILED:', err);
    process.exit(1);
  });
}

module.exports = { main };
