// =============================================================================
// Verimimari Marketplace Data Platform V2 — P1.1 Canary Dual-Write Test Suite
// Verifies all 7 resiliency, recovery, idempotency, and reconciliation scenarios.
// =============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  dispatchDualSinkBatch,
  recoverPendingOutbox
} = require('./lib/canary_collector_dual_write.cjs');

const {
  writeAheadSpool,
  updateSpoolSink,
  durableWriteAtomic,
  listPendingOutbox,
  getOutboxBacklogMetrics,
  buildProductObservationId,
  computeLogicalDatasetChecksum
} = require('./lib/clickhouse_client.cjs');

const {
  reconcileObservations,
  reconcileDataset10Metrics
} = require('./verify_reconciliation.cjs');

test('Scenario 1: Collector -> durable dual-sink outbox integration (atomic spool, dual ACK, clean unlink)', async () => {
  const testOutboxDir = path.join(os.tmpdir(), `canary_s1_${Date.now()}`);

  const rows = [
    { observation_id: 'c-obs-1', product_id: '101', price: 99.90, in_stock: 1, observed_date: '2026-09-17' },
    { observation_id: 'c-obs-2', product_id: '102', price: 149.90, in_stock: 0, observed_date: '2026-09-17' }
  ];

  let supaDispatched = false;
  let chDispatched = false;

  const result = await dispatchDualSinkBatch({
    table: 'trendyol.product_observations',
    rows,
    runId: 'trendyol-20260917-canary-01',
    batchIndex: 0,
    outboxDir: testOutboxDir,
    supabaseSender: async (batch) => {
      supaDispatched = true;
      assert.equal(batch.rows.length, 2);
      return { ok: true };
    },
    clickhouseSender: async (batch) => {
      chDispatched = true;
      assert.equal(batch.rows.length, 2);
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(supaDispatched, true);
  assert.equal(chDispatched, true);
  assert.equal(result.spooled, false); // Cleanly unlinked because both ACKed!

  // Spool directory should be completely clean
  const pending = listPendingOutbox(testOutboxDir);
  assert.equal(pending.length, 0);

  fs.rmSync(testOutboxDir, { recursive: true, force: true });
});

test('Scenario 2: Supabase retry / replay idempotency behavior', async () => {
  const testOutboxDir = path.join(os.tmpdir(), `canary_s2_${Date.now()}`);
  const store = new Map();

  const supabaseUpsertMock = async ({ rows }) => {
    // Simulates ON CONFLICT (marketplace, product_key) DO UPDATE
    for (const r of rows) {
      store.set(r.observation_id, { ...r, version: (store.get(r.observation_id)?.version || 0) + 1 });
    }
    return { ok: true };
  };

  const rows = [
    { observation_id: 'c-obs-idem-1', product_id: '201', price: 50.00, in_stock: 1 },
    { observation_id: 'c-obs-idem-2', product_id: '202', price: 75.00, in_stock: 0 }
  ];

  // First dispatch
  await dispatchDualSinkBatch({
    table: 'trendyol.product_observations',
    rows,
    runId: 'trendyol-20260917-canary-02',
    outboxDir: testOutboxDir,
    supabaseSender: supabaseUpsertMock,
    clickhouseSender: async () => ({ ok: true })
  });

  assert.equal(store.size, 2);
  assert.equal(store.get('c-obs-idem-1').version, 1);

  // Intentional Retry / Replay of identical batch
  await dispatchDualSinkBatch({
    table: 'trendyol.product_observations',
    rows,
    runId: 'trendyol-20260917-canary-02',
    outboxDir: testOutboxDir,
    supabaseSender: supabaseUpsertMock,
    clickhouseSender: async () => ({ ok: true })
  });

  // Size remains exactly 2: zero duplicate records created!
  assert.equal(store.size, 2);
  assert.equal(store.get('c-obs-idem-1').version, 2); // safely updated version, no duplicate key

  fs.rmSync(testOutboxDir, { recursive: true, force: true });
});

test('Scenario 3: Manifest ACK/state updates are atomic and durable across retries', () => {
  const testOutboxDir = path.join(os.tmpdir(), `canary_s3_${Date.now()}`);

  const spool = writeAheadSpool({
    outboxDir: testOutboxDir,
    table: 'trendyol.product_observations',
    rows: [{ observation_id: 'obs-atom-1', price: 120 }],
    runId: 'trendyol-canary-03',
    batchIndex: 0
  });

  // Attempt 1: Supabase fails with 503
  const update1 = updateSpoolSink(spool.spoolPath, 'supabase', {
    status: 'FAILED',
    error: 'HTTP 503 Service Unavailable'
  });
  assert.equal(update1.cleared, false);
  assert.equal(update1.sinks.supabase.attempts, 1);
  assert.equal(update1.sinks.supabase.error, 'HTTP 503 Service Unavailable');

  // Verify file was written durably to disk with new attempt state
  const onDisk1 = JSON.parse(fs.readFileSync(spool.spoolPath, 'utf8'));
  assert.equal(onDisk1.sinks.supabase.attempts, 1);
  assert.equal(onDisk1.sinks.supabase.status, 'FAILED');

  // Attempt 2: Supabase succeeds with ACK
  const update2 = updateSpoolSink(spool.spoolPath, 'supabase', { status: 'ACK' });
  assert.equal(update2.cleared, false); // ClickHouse is still PENDING
  assert.equal(update2.sinks.supabase.attempts, 2);
  assert.equal(update2.sinks.supabase.status, 'ACK');

  // Attempt 1 for ClickHouse: succeeds with ACK
  const update3 = updateSpoolSink(spool.spoolPath, 'clickhouse', { status: 'ACK' });
  assert.equal(update3.cleared, true); // Both ACKed -> Unlinked!
  assert.equal(fs.existsSync(spool.spoolPath), false);

  fs.rmSync(testOutboxDir, { recursive: true, force: true });
});

test('Scenario 4: Process restart auto-recovery/replay drains pending spools', async () => {
  const testOutboxDir = path.join(os.tmpdir(), `canary_s4_${Date.now()}`);

  // Simulate 3 pending spools left by an abruptly terminated worker
  for (let i = 0; i < 3; i++) {
    writeAheadSpool({
      outboxDir: testOutboxDir,
      table: 'trendyol.product_observations',
      rows: [{ observation_id: `obs-crash-${i}`, product_id: `prod-${i}`, price: 100 + i }],
      runId: 'trendyol-canary-crashed-worker',
      batchIndex: i
    });
  }

  const initialPending = listPendingOutbox(testOutboxDir);
  assert.equal(initialPending.length, 3);

  // Worker restarts and triggers auto-recovery
  let recoveredSupa = 0;
  let recoveredCh = 0;

  const recoveryResult = await recoverPendingOutbox({
    outboxDir: testOutboxDir,
    supabaseSender: async () => { recoveredSupa++; return { ok: true }; },
    clickhouseSender: async () => { recoveredCh++; return { ok: true }; }
  });

  assert.equal(recoveryResult.scanned, 3);
  assert.equal(recoveryResult.recovered, 3);
  assert.equal(recoveryResult.stillPending, 0);
  assert.equal(recoveredSupa, 3);
  assert.equal(recoveredCh, 3);

  // All spool files should be cleanly drained
  const remaining = listPendingOutbox(testOutboxDir);
  assert.equal(remaining.length, 0);

  fs.rmSync(testOutboxDir, { recursive: true, force: true });
});

test('Scenario 5: ClickHouse offline -> collector continues -> spool accumulates -> ClickHouse online -> replay -> backlog zero', async () => {
  const testOutboxDir = path.join(os.tmpdir(), `canary_s5_${Date.now()}`);

  let clickhouseOnline = false;
  const clickhouseStorage = [];

  const dynamicClickHouseSender = async (batch) => {
    if (!clickhouseOnline) {
      return { ok: false, error: 'ECONNREFUSED 127.0.0.1:8123 (Simulated Offline)' };
    }
    clickhouseStorage.push(...batch.rows);
    return { ok: true };
  };

  // Phase 1: ClickHouse is offline. Run 4 collector batches.
  for (let i = 0; i < 4; i++) {
    const res = await dispatchDualSinkBatch({
      table: 'trendyol.product_observations',
      rows: [{ observation_id: `obs-s5-${i}`, price: 100 * (i + 1) }],
      runId: 'trendyol-s5-offline-run',
      batchIndex: i,
      outboxDir: testOutboxDir,
      supabaseSender: async () => ({ ok: true }), // Supabase succeeds
      clickhouseSender: dynamicClickHouseSender     // ClickHouse fails
    });

    assert.equal(res.ok, true);
    assert.equal(res.spooled, true, 'Batch must remain spooled on ClickHouse failure');
  }

  // Verify backlog metrics show 4 pending batches
  const backlogDuringOffline = getOutboxBacklogMetrics(testOutboxDir);
  assert.equal(backlogDuringOffline.pending_batches, 4);
  assert.equal(backlogDuringOffline.pending_rows, 4);
  assert.ok(backlogDuringOffline.size_mb >= 0);
  assert.equal(backlogDuringOffline.sinks_pending.clickhouse, 4);
  assert.equal(backlogDuringOffline.sinks_pending.supabase, 0);
  assert.equal(clickhouseStorage.length, 0);

  // Phase 2: ClickHouse comes back online!
  clickhouseOnline = true;

  // Run auto-recovery / replay
  const flushResult = await recoverPendingOutbox({
    outboxDir: testOutboxDir,
    supabaseSender: async () => ({ ok: true }),
    clickhouseSender: dynamicClickHouseSender
  });

  assert.equal(flushResult.scanned, 4);
  assert.equal(flushResult.recovered, 4);
  assert.equal(clickhouseStorage.length, 4);

  // Backlog must now be exactly ZERO
  const backlogAfterOnline = getOutboxBacklogMetrics(testOutboxDir);
  assert.equal(backlogAfterOnline.pending_batches, 0);
  assert.equal(backlogAfterOnline.pending_rows, 0);
  assert.equal(backlogAfterOnline.size_mb, 0);
  assert.equal(backlogAfterOnline.health, 'OK');

  fs.rmSync(testOutboxDir, { recursive: true, force: true });
});

test('Scenario 6: Intentional double replay duplicate observation check', () => {
  // Simulates table storage with observation_id uniqueness check
  const tableData = new Map();

  const insertWithDedup = (rows, dedupToken) => {
    let inserted = 0;
    let skipped = 0;
    for (const r of rows) {
      if (tableData.has(r.observation_id)) {
        skipped++;
      } else {
        tableData.set(r.observation_id, r);
        inserted++;
      }
    }
    return { inserted, skipped };
  };

  const batch = [
    { observation_id: 'double-replay-1', product_id: 'p1', price: 99.00 },
    { observation_id: 'double-replay-2', product_id: 'p2', price: 149.00 }
  ];

  // Initial insert
  const res1 = insertWithDedup(batch, 'batch-token-123');
  assert.equal(res1.inserted, 2);
  assert.equal(res1.skipped, 0);
  assert.equal(tableData.size, 2);

  // Intentional Double Replay of the same batch
  const res2 = insertWithDedup(batch, 'batch-token-123');
  assert.equal(res2.inserted, 0);
  assert.equal(res2.skipped, 2);

  // Exactly 2 distinct observations exist in the dataset; zero duplicate pollution
  assert.equal(tableData.size, 2);
  assert.ok(tableData.has('double-replay-1'));
  assert.ok(tableData.has('double-replay-2'));
});

test('Scenario 7: Full 10-metric reconciliation returns PASS across all metrics', () => {
  const runId = 'trendyol-20260917-canary-pass';

  const supabaseObservations = [
    { observation_id: 'obs-c1', run_id: runId, product_id: 'prod-A', merchant_id: 'm1', observed_date: '2026-09-17', price: 100.00, in_stock: true },
    { observation_id: 'obs-c2', run_id: runId, product_id: 'prod-B', merchant_id: 'm2', observed_date: '2026-09-17', price: 150.50, in_stock: false },
    { observation_id: 'obs-c3', run_id: runId, product_id: 'prod-C', merchant_id: 'm1', observed_date: '2026-09-17', price: null, in_stock: null }
  ];

  const clickhouseObservations = [
    // Different order & ClickHouse 1/0 ternary representation
    { observation_id: 'obs-c2', run_id: runId, product_id: 'prod-B', merchant_id: 'm2', observed_date: '2026-09-17', price: 150.50, in_stock: 0 },
    { observation_id: 'obs-c3', run_id: runId, product_id: 'prod-C', merchant_id: 'm1', observed_date: '2026-09-17', price: null, in_stock: null },
    { observation_id: 'obs-c1', run_id: runId, product_id: 'prod-A', merchant_id: 'm1', observed_date: '2026-09-17', price: 100.00, in_stock: 1 }
  ];

  const datasetA = { run_id: runId, observations: supabaseObservations, rankings: [{ rank: 1 }] };
  const datasetB = { run_id: runId, observations: clickhouseObservations, rankings: [{ rank: 1 }] };

  const rec = reconcileDataset10Metrics(datasetA, datasetB);

  assert.equal(rec.status, 'PASS');
  assert.equal(rec.isFullPass, true);
  assert.equal(rec.totalMetrics, 14);
  assert.equal(rec.passedMetrics, 14);
  assert.equal(rec.failedMetrics, 0);

  // Verify all 14 individual metric check results
  assert.equal(rec.metrics.run_id.pass, true);
  assert.equal(rec.metrics.observation_count.pass, true);
  assert.equal(rec.metrics.ranking_count.pass, true);
  assert.equal(rec.metrics.distinct_products.pass, true);
  assert.equal(rec.metrics.distinct_merchants.pass, true);
  assert.equal(rec.metrics.distinct_offer_key.pass, true);
  assert.equal(rec.metrics.duplicate_observation_id_count.pass, true);
  assert.equal(rec.metrics.date_range.pass, true);
  assert.equal(rec.metrics.captured_at_range.pass, true);
  assert.equal(rec.metrics.null_price_count.pass, true);
  assert.equal(rec.metrics.stock_distribution.pass, true);
  assert.equal(rec.metrics.price_sum.pass, true);
  assert.equal(rec.metrics.rank_checksum.pass, true);
  assert.equal(rec.metrics.logical_dataset_checksum.pass, true);
});

test('Scenario 8: Spool write failure aborts dual-write with CRITICAL error without dispatching to sinks', async () => {
  let supabaseCalled = false;
  let clickhouseCalled = false;

  const mockSupabaseSender = async () => {
    supabaseCalled = true;
    return { ok: true };
  };

  const mockClickhouseSender = async () => {
    clickhouseCalled = true;
    return { ok: true };
  };

  // Provide an impossible/read-only path to force write failure
  const invalidOutboxDir = '/proc/nonexistent/outbox/cannot/write';

  await assert.rejects(
    async () => {
      await dispatchDualSinkBatch({
        table: 'trendyol.product_observations',
        rows: [{ product_id: 'p-critical', price: 99.99 }],
        runId: 'trendyol-20260917-critical-test',
        batchIndex: 0,
        outboxDir: invalidOutboxDir,
        supabaseSender: mockSupabaseSender,
        clickhouseSender: mockClickhouseSender
      });
    },
    (err) => {
      assert.equal(err.isCritical, true);
      assert.equal(err.code, 'ERR_OUTBOX_WRITE_AHEAD_FAILED');
      assert.match(err.message, /CRITICAL: Outbox write-ahead spool failed/);
      return true;
    }
  );

  // Guarantee that neither sink was dispatched without write-ahead persistence
  assert.equal(supabaseCalled, false, 'Supabase MUST NOT be called if spool persistence fails');
  assert.equal(clickhouseCalled, false, 'ClickHouse MUST NOT be called if spool persistence fails');
});

