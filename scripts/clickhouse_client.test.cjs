'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  canonicalPart,
  hashKey,
  computeBatchChecksum,
  computeBatchId,
  normalizeClickHouseValue,
  buildProductObservationId,
  buildCategoryRankObservationId,
  buildOfferObservationId,
  mapProductObservation,
  mapCategoryRankObservation,
  writeAheadSpool,
  updateSpoolSink,
  durableWriteAtomic,
  listPendingOutbox,
  replayOutbox,
  sendClickHouseBatch,
  getOutboxBacklogMetrics,
  computeLogicalDatasetChecksum,
  OUTBOX_HEALTH_THRESHOLDS,
  pingClickHouse
} = require('./lib/clickhouse_client.cjs');

test('canonicalPart strictly differentiates null, empty string, and literal string "null"', () => {
  assert.notEqual(canonicalPart(null), canonicalPart(''));
  assert.notEqual(canonicalPart(null), canonicalPart('null'));
  assert.notEqual(canonicalPart(undefined), canonicalPart(null));
  assert.notEqual(canonicalPart(''), canonicalPart(undefined));
  assert.equal(canonicalPart('abc'), '\x01abc');
  assert.equal(canonicalPart(123), '\x02123');
});

test('hashKey avoids collisions between null, empty string, and "null"', () => {
  const hashNull = hashKey('trendyol', null, '123');
  const hashEmpty = hashKey('trendyol', '', '123');
  const hashLiteralNull = hashKey('trendyol', 'null', '123');

  assert.notEqual(hashNull, hashEmpty);
  assert.notEqual(hashNull, hashLiteralNull);
  assert.notEqual(hashEmpty, hashLiteralNull);
});

test('computeBatchChecksum produces consistent SHA256 hashes for row batches', () => {
  const rows1 = [{ observation_id: 'obs-1' }, { observation_id: 'obs-2' }];
  const rows2 = [{ observation_id: 'obs-1' }, { observation_id: 'obs-2' }];
  const rows3 = [{ observation_id: 'obs-2' }, { observation_id: 'obs-1' }]; // Different order

  const cs1 = computeBatchChecksum(rows1);
  const cs2 = computeBatchChecksum(rows2);
  const cs3 = computeBatchChecksum(rows3);

  assert.equal(cs1, cs2);
  assert.notEqual(cs1, cs3); // Order is preserved and affects checksum
});

test('deterministic observation_id generation produces stable 64-char SHA256 hashes', () => {
  const id1 = buildProductObservationId({
    marketplace: 'trendyol',
    product_id: '1164529918',
    merchant_id: '968',
    variant_id: 'v1',
    listing_id: 'l1'
  }, 'trendyol-20260917-151000-test1');

  const id2 = buildProductObservationId({
    marketplace: 'trendyol',
    product_id: '1164529918',
    merchant_id: '968',
    variant_id: 'v1',
    listing_id: 'l1'
  }, 'trendyol-20260917-151000-test1');

  assert.equal(typeof id1, 'string');
  assert.equal(id1.length, 64);
  assert.equal(id1, id2);

  const rankId1 = buildCategoryRankObservationId({
    marketplace: 'trendyol',
    category_id: 28,
    product_id: '1164529918',
    merchant_id: '968',
    rank_scope: 'bestseller',
    rank: 1
  }, 'trendyol-20260917-151000-test1');

  const rankId2 = buildCategoryRankObservationId({
    marketplace: 'trendyol',
    category_id: 28,
    product_id: '1164529918',
    merchant_id: '968',
    rank_scope: 'bestseller',
    rank: 1
  }, 'trendyol-20260917-151000-test1');

  assert.equal(rankId1, rankId2);
  assert.equal(rankId1.length, 64);
});

test('mapProductObservation maps deterministic observation_id, ternary stock and offer_key', () => {
  const rowInStock = mapProductObservation({
    productId: '1164529918',
    merchantId: '968',
    variantId: 'v123',
    listingId: 'l456',
    price: '299.99',
    original_price: '349.99',
    in_stock: true,
    running_out: false,
    rating: '4.8',
    rating_count: 120,
    promotions: ['3 Al 2 Öde', 'Kupon'],
    metrics: { stock_quantity: 45 }
  }, {
    run_id: 'trendyol-20260917-151000-test1',
    observed_date: '2026-09-17'
  });

  assert.ok(rowInStock.observation_id);
  assert.equal(rowInStock.observation_id.length, 64);
  assert.equal(rowInStock.product_id, '1164529918');
  assert.equal(rowInStock.merchant_id, '968');
  assert.equal(rowInStock.offer_key, '1164529918:968');
  assert.equal(rowInStock.price, 299.99);
  assert.equal(rowInStock.in_stock, 1);
  assert.equal(rowInStock.running_out, 0);
  assert.equal(rowInStock.stock_quantity, 45);

  const rowNullStock = mapProductObservation({ productId: '123', in_stock: null });
  assert.equal(rowNullStock.in_stock, null);

  const rowFalseStock = mapProductObservation({ productId: '123', in_stock: false });
  assert.equal(rowFalseStock.in_stock, 0);
});

test('writeAheadSpool writes .spool atomically with batchId and batchChecksum', () => {
  const testOutboxDir = path.join(os.tmpdir(), `ch_wal_test_${Date.now()}`);

  const rows = [
    { observation_id: 'obs-a', product_id: '101', price: 100 },
    { observation_id: 'obs-b', product_id: '102', price: 200 }
  ];

  const spool = writeAheadSpool({
    outboxDir: testOutboxDir,
    table: 'trendyol.product_observations',
    rows,
    runId: 'trendyol-wal-run',
    batchIndex: 0
  });

  assert.ok(spool);
  assert.ok(fs.existsSync(spool.spoolPath));
  assert.ok(spool.spoolPath.endsWith('.spool'));

  const pending = listPendingOutbox(testOutboxDir);
  assert.equal(pending.length, 1);
  assert.equal(pending[0], spool.spoolPath);

  const parsed = JSON.parse(fs.readFileSync(spool.spoolPath, 'utf8'));
  assert.equal(parsed.table, 'trendyol.product_observations');
  assert.equal(parsed.batchId, spool.batchId);
  assert.equal(parsed.batchChecksum, spool.batchChecksum);
  assert.deepEqual(parsed.rows, rows);

  fs.rmSync(testOutboxDir, { recursive: true, force: true });
});

test('sendClickHouseBatch writes ahead before HTTP call and keeps spool on failure for at-least-once delivery', async () => {
  const testOutboxDir = path.join(os.tmpdir(), `ch_wal_fail_${Date.now()}`);

  const res = await sendClickHouseBatch({
    baseUrl: 'http://127.0.0.1:59999', // Unreachable
    table: 'trendyol.test',
    rows: [{ observation_id: 'test-obs-1', val: 42 }],
    runId: 'trendyol-wal-fail-run',
    batchIndex: 1,
    timeoutMs: 100,
    writeAhead: true,
    outboxDir: testOutboxDir
  });

  assert.equal(res.ok, false);
  assert.equal(res.spooled, true);
  assert.ok(fs.existsSync(res.spoolPath));

  const pending = listPendingOutbox(testOutboxDir);
  assert.equal(pending.length, 1);

  fs.rmSync(testOutboxDir, { recursive: true, force: true });
});

test('durableWriteAtomic writes content durably using write -> fsync -> rename -> fsync', () => {
  const testDir = path.join(os.tmpdir(), `durable_atomic_test_${Date.now()}`);
  const targetFile = path.join(testDir, 'test_batch.json');
  const content = JSON.stringify({ test: 'durable', count: 100 });

  durableWriteAtomic(targetFile, content);

  assert.ok(fs.existsSync(targetFile));
  assert.equal(fs.readFileSync(targetFile, 'utf8'), content);

  // Overwrite durably
  const updatedContent = JSON.stringify({ test: 'durable', count: 200 });
  durableWriteAtomic(targetFile, updatedContent);
  assert.equal(fs.readFileSync(targetFile, 'utf8'), updatedContent);

  fs.rmSync(testDir, { recursive: true, force: true });
});

test('dual-sink outbox: unlinks spool file ONLY when both Supabase and ClickHouse return ACK', () => {
  const testOutboxDir = path.join(os.tmpdir(), `dual_sink_test_${Date.now()}`);

  const spool = writeAheadSpool({
    outboxDir: testOutboxDir,
    table: 'trendyol.product_observations',
    rows: [{ observation_id: 'obs-1', price: 99 }],
    runId: 'trendyol-dual-ack-run',
    batchIndex: 0
  });

  assert.ok(spool);
  assert.ok(fs.existsSync(spool.spoolPath));

  // 1. Supabase ACKs first
  const step1 = updateSpoolSink(spool.spoolPath, 'supabase', { status: 'ACK' });
  assert.equal(step1.cleared, false);
  assert.equal(step1.sinks.supabase.status, 'ACK');
  assert.equal(step1.sinks.clickhouse.status, 'PENDING');
  assert.ok(fs.existsSync(spool.spoolPath), 'Spool file must still exist after single sink ACK');

  // 2. ClickHouse ACKs second
  const step2 = updateSpoolSink(spool.spoolPath, 'clickhouse', { status: 'ACK' });
  assert.equal(step2.cleared, true);
  assert.equal(step2.sinks.supabase.status, 'ACK');
  assert.equal(step2.sinks.clickhouse.status, 'ACK');
  assert.ok(!fs.existsSync(spool.spoolPath), 'Spool file must be unlinked when both sinks ACK');

  fs.rmSync(testOutboxDir, { recursive: true, force: true });
});

test('dual-sink outbox: tracks retry attempts and error messages upon sink failure', () => {
  const testOutboxDir = path.join(os.tmpdir(), `dual_sink_fail_${Date.now()}`);

  const spool = writeAheadSpool({
    outboxDir: testOutboxDir,
    table: 'trendyol.product_observations',
    rows: [{ observation_id: 'obs-fail-1', price: 199 }],
    runId: 'trendyol-dual-fail-run',
    batchIndex: 0
  });

  assert.ok(fs.existsSync(spool.spoolPath));

  // Simulate Supabase failure on attempt 1
  const fail1 = updateSpoolSink(spool.spoolPath, 'supabase', {
    status: 'FAILED',
    error: 'HTTP 503 Service Unavailable'
  });

  assert.equal(fail1.cleared, false);
  assert.equal(fail1.sinks.supabase.status, 'FAILED');
  assert.equal(fail1.sinks.supabase.attempts, 1);
  assert.equal(fail1.sinks.supabase.error, 'HTTP 503 Service Unavailable');
  assert.ok(fail1.sinks.supabase.lastAttemptAt);

  // Simulate retry on attempt 2
  const fail2 = updateSpoolSink(spool.spoolPath, 'supabase', {
    status: 'FAILED',
    error: 'HTTP 504 Gateway Timeout'
  });
  assert.equal(fail2.sinks.supabase.attempts, 2);
  assert.equal(fail2.sinks.supabase.error, 'HTTP 504 Gateway Timeout');

  // ClickHouse succeeds
  const chOk = updateSpoolSink(spool.spoolPath, 'clickhouse', { status: 'ACK' });
  assert.equal(chOk.cleared, false, 'Spool file still preserved because Supabase is FAILED');

  // Supabase finally succeeds on attempt 3
  const supaOk = updateSpoolSink(spool.spoolPath, 'supabase', { status: 'ACK' });
  assert.equal(supaOk.cleared, true, 'Spool file cleared now that both are ACK');
  assert.ok(!fs.existsSync(spool.spoolPath));

  fs.rmSync(testOutboxDir, { recursive: true, force: true });
});

test('getOutboxBacklogMetrics accurately computes metrics and triggers WARNING and CRITICAL thresholds', () => {
  const testOutboxDir = path.join(os.tmpdir(), `backlog_metrics_${Date.now()}`);

  // Empty directory -> OK
  const emptyMetrics = getOutboxBacklogMetrics(testOutboxDir);
  assert.equal(emptyMetrics.pending_batches, 0);
  assert.equal(emptyMetrics.pending_rows, 0);
  assert.equal(emptyMetrics.size_mb, 0);
  assert.equal(emptyMetrics.health, 'OK');

  // Create 2 normal batches -> OK
  for (let i = 0; i < 2; i++) {
    writeAheadSpool({
      outboxDir: testOutboxDir,
      table: 'trendyol.test',
      rows: [{ id: `r-${i}-1` }, { id: `r-${i}-2` }],
      runId: 'trendyol-metrics-run',
      batchIndex: i
    });
  }

  const normalMetrics = getOutboxBacklogMetrics(testOutboxDir);
  assert.equal(normalMetrics.pending_batches, 2);
  assert.equal(normalMetrics.pending_rows, 4);
  assert.equal(normalMetrics.health, 'OK');

  // Create more batches to reach WARNING (>= 5 batches)
  for (let i = 2; i < 6; i++) {
    writeAheadSpool({
      outboxDir: testOutboxDir,
      table: 'trendyol.test',
      rows: [{ id: `r-${i}-1` }],
      runId: 'trendyol-metrics-run',
      batchIndex: i
    });
  }

  const warningMetrics = getOutboxBacklogMetrics(testOutboxDir);
  assert.equal(warningMetrics.pending_batches, 6);
  assert.equal(warningMetrics.health, 'WARNING');
  assert.ok(warningMetrics.reasons.some(r => r.includes('pending_batches')));

  // Create more batches to reach CRITICAL (>= 20 batches)
  for (let i = 6; i < 21; i++) {
    writeAheadSpool({
      outboxDir: testOutboxDir,
      table: 'trendyol.test',
      rows: [{ id: `r-${i}-1` }],
      runId: 'trendyol-metrics-run',
      batchIndex: i
    });
  }

  const criticalMetrics = getOutboxBacklogMetrics(testOutboxDir);
  assert.equal(criticalMetrics.pending_batches, 21);
  assert.equal(criticalMetrics.health, 'CRITICAL');
  assert.ok(criticalMetrics.reasons.some(r => r.includes('pending_batches')));

  fs.rmSync(testOutboxDir, { recursive: true, force: true });
});

test('buildProductObservationId disambiguates observations across source_scope and captured_at', () => {
  const baseObs = {
    marketplace: 'trendyol',
    product_id: '1164529918',
    merchant_id: '968',
    variant_id: 'v1',
    listing_id: 'l1'
  };

  const idTaxonomy = buildProductObservationId({
    ...baseObs,
    source_scope: 'taxonomy',
    captured_at: '2026-09-17 15:00:00'
  }, 'run-1');

  const idProfile = buildProductObservationId({
    ...baseObs,
    source_scope: 'profile:supermarket',
    captured_at: '2026-09-17 15:00:00'
  }, 'run-1');

  const idLaterSnapshot = buildProductObservationId({
    ...baseObs,
    source_scope: 'taxonomy',
    captured_at: '2026-09-17 15:30:00'
  }, 'run-1');

  const idIdentical = buildProductObservationId({
    ...baseObs,
    source_scope: 'taxonomy',
    captured_at: '2026-09-17 15:00:00'
  }, 'run-1');

  // Scope disambiguation: different scope in same run MUST NOT collide
  assert.notEqual(idTaxonomy, idProfile);

  // Temporal disambiguation: different captured_at in same run and scope MUST NOT collide
  assert.notEqual(idTaxonomy, idLaterSnapshot);

  // Exact match produces identical deterministic hash
  assert.equal(idTaxonomy, idIdentical);
});

test('computeLogicalDatasetChecksum guarantees order-independent cross-engine equivalence (Supabase vs ClickHouse vs Parquet)', () => {
  const rowsSupabaseOrder = [
    { observation_id: 'b', product_id: '200', price: 50.5, observed_date: '2026-09-17' },
    { observation_id: 'a', product_id: '100', price: 29.9, observed_date: '2026-09-17' },
    { observation_id: 'c', product_id: '300', price: 99.0, observed_date: '2026-09-17' }
  ];

  const rowsClickHouseOrder = [
    { observation_id: 'a', product_id: '100', price: 29.9, observed_date: '2026-09-17' },
    { observation_id: 'c', product_id: '300', price: 99.0, observed_date: '2026-09-17' },
    { observation_id: 'b', product_id: '200', price: 50.5, observed_date: '2026-09-17' }
  ];

  const rowsParquetOrder = [
    { observation_id: 'c', product_id: '300', price: 99.0, observed_date: '2026-09-17' },
    { observation_id: 'b', product_id: '200', price: 50.5, observed_date: '2026-09-17' },
    { observation_id: 'a', product_id: '100', price: 29.9, observed_date: '2026-09-17' }
  ];

  const hashSupabase = computeLogicalDatasetChecksum(rowsSupabaseOrder);
  const hashClickHouse = computeLogicalDatasetChecksum(rowsClickHouseOrder);
  const hashParquet = computeLogicalDatasetChecksum(rowsParquetOrder);

  // Checksums MUST match across all three storage representations regardless of query sort order
  assert.equal(hashSupabase, hashClickHouse);
  assert.equal(hashSupabase, hashParquet);

  // Any data discrepancy alters the checksum
  const tamperedRows = [
    { observation_id: 'a', product_id: '100', price: 29.91, observed_date: '2026-09-17' }, // price changed by 1 cent
    { observation_id: 'b', product_id: '200', price: 50.5, observed_date: '2026-09-17' },
    { observation_id: 'c', product_id: '300', price: 99.0, observed_date: '2026-09-17' }
  ];
  assert.notEqual(hashSupabase, computeLogicalDatasetChecksum(tamperedRows));
});
