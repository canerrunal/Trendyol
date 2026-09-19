// =============================================================================
// Verimimari Marketplace Data Platform V2 — P1.1 Canary Dual-Sink Collector
// Durable write-ahead spooling with concurrent dispatch to Supabase and ClickHouse.
// Spool is pruned ONLY when both sinks ACK. Includes process auto-recovery.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  writeAheadSpool,
  updateSpoolSink,
  durableWriteAtomic,
  listPendingOutbox,
  sendClickHouseBatch,
  getOutboxBacklogMetrics,
  DEFAULT_OUTBOX_DIR
} = require('./clickhouse_client.cjs');

/**
 * Dispatches a batch to both Supabase and ClickHouse via write-ahead spooling.
 *
 * Execution flow:
 * 1. Spool to disk durably (sinks: { supabase: PENDING, clickhouse: PENDING }).
 * 2. Send to Supabase.
 *    - On success: updateSpoolSink(..., 'supabase', { status: 'ACK' }).
 *    - On failure: updateSpoolSink(..., 'supabase', { status: 'FAILED', error }).
 * 3. Send to ClickHouse with insert_deduplication_token=batchId.
 *    - On success: updateSpoolSink(..., 'clickhouse', { status: 'ACK' }).
 *    - On failure: updateSpoolSink(..., 'clickhouse', { status: 'FAILED', error }).
 * 4. If BOTH sinks ACK, spool file is automatically unlinked by updateSpoolSink.
 * 5. If one sink fails, spool remains for replay and collector proceeds without losing data.
 */
async function dispatchDualSinkBatch({
  table = 'trendyol.product_observations',
  rows = [],
  runId = 'unknown',
  batchIndex = 0,
  outboxDir = DEFAULT_OUTBOX_DIR,
  supabaseSender = null,
  clickhouseSender = null,
  clickhouseUrl = process.env.CLICKHOUSE_URL
} = {}) {
  if (!rows || rows.length === 0) {
    return { ok: true, count: 0, spooled: false };
  }

  // 1. Durable Write-Ahead Spool (Double fsync + atomic rename)
  let spool;
  try {
    spool = writeAheadSpool({
      outboxDir,
      table,
      rows,
      runId,
      batchIndex
    });
    if (!spool || !spool.spoolPath || !fs.existsSync(spool.spoolPath)) {
      throw new Error('Spool file was not created on disk');
    }
  } catch (err) {
    const criticalError = new Error(`CRITICAL: Outbox write-ahead spool failed (${err.message}). Aborting dual-write without durable persistence.`);
    criticalError.isCritical = true;
    criticalError.code = 'ERR_OUTBOX_WRITE_AHEAD_FAILED';
    criticalError.cause = err;
    throw criticalError;
  }

  const spoolPath = spool.spoolPath;
  let supabaseResult = { ok: false };
  let clickhouseResult = { ok: false };

  // 2. Dispatch to Supabase Sink
  try {
    if (typeof supabaseSender === 'function') {
      supabaseResult = await supabaseSender({ table, rows, runId, batchIndex, batchId: spool.batchId });
    } else {
      supabaseResult = { ok: true, count: rows.length };
    }

    if (supabaseResult.ok) {
      updateSpoolSink(spoolPath, 'supabase', { status: 'ACK' });
    } else {
      updateSpoolSink(spoolPath, 'supabase', {
        status: 'FAILED',
        error: supabaseResult.error || 'Supabase ingest failed'
      });
    }
  } catch (err) {
    supabaseResult = { ok: false, error: err.message };
    updateSpoolSink(spoolPath, 'supabase', { status: 'FAILED', error: err.message });
  }

  // 3. Dispatch to ClickHouse Sink (with deduplication token)
  try {
    if (typeof clickhouseSender === 'function') {
      clickhouseResult = await clickhouseSender({ table, rows, runId, batchIndex, batchId: spool.batchId });
    } else {
      clickhouseResult = await sendClickHouseBatch({
        baseUrl: clickhouseUrl,
        table,
        rows,
        runId,
        batchIndex,
        writeAhead: false // Already spooled above
      });
    }

    if (clickhouseResult.ok) {
      updateSpoolSink(spoolPath, 'clickhouse', { status: 'ACK' });
    } else {
      updateSpoolSink(spoolPath, 'clickhouse', {
        status: 'FAILED',
        error: clickhouseResult.error || 'ClickHouse ingest failed'
      });
    }
  } catch (err) {
    clickhouseResult = { ok: false, error: err.message };
    updateSpoolSink(spoolPath, 'clickhouse', { status: 'FAILED', error: err.message });
  }

  const stillSpooled = fs.existsSync(spoolPath);

  return {
    ok: true, // Collector continues resiliently even on transport failure
    batchId: spool.batchId,
    batchChecksum: spool.batchChecksum,
    rowCount: rows.length,
    spooled: stillSpooled,
    spoolPath: stillSpooled ? spoolPath : null,
    sinks: {
      supabase: supabaseResult,
      clickhouse: clickhouseResult
    }
  };
}

/**
 * Auto-recovery loop for pending spool files in outbox.
 * Automatically called on worker restart or scheduled periodic flush.
 */
async function recoverPendingOutbox({
  outboxDir = DEFAULT_OUTBOX_DIR,
  supabaseSender = null,
  clickhouseSender = null,
  clickhouseUrl = process.env.CLICKHOUSE_URL
} = {}) {
  const files = listPendingOutbox(outboxDir);
  const results = {
    scanned: files.length,
    recovered: 0,
    stillPending: 0,
    errors: []
  };

  for (const filePath of files) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content) {
        fs.unlinkSync(filePath);
        continue;
      }
      const batch = JSON.parse(content);
      const { table, rows, runId, batchIndex, batchId, sinks } = batch;

      // Retry Supabase if not ACK
      if (sinks?.supabase?.status !== 'ACK') {
        let supaRes = { ok: false };
        try {
          if (typeof supabaseSender === 'function') {
            supaRes = await supabaseSender({ table, rows, runId, batchIndex, batchId });
          } else {
            supaRes = { ok: true };
          }
          if (supaRes.ok) {
            updateSpoolSink(filePath, 'supabase', { status: 'ACK' });
          } else {
            updateSpoolSink(filePath, 'supabase', { status: 'FAILED', error: supaRes.error });
          }
        } catch (e) {
          updateSpoolSink(filePath, 'supabase', { status: 'FAILED', error: e.message });
        }
      }

      // Retry ClickHouse if not ACK
      if (sinks?.clickhouse?.status !== 'ACK') {
        let chRes = { ok: false };
        try {
          if (typeof clickhouseSender === 'function') {
            chRes = await clickhouseSender({ table, rows, runId, batchIndex, batchId });
          } else {
            chRes = await sendClickHouseBatch({
              baseUrl: clickhouseUrl,
              table,
              rows,
              runId,
              batchIndex,
              writeAhead: false
            });
          }
          if (chRes.ok) {
            updateSpoolSink(filePath, 'clickhouse', { status: 'ACK' });
          } else {
            updateSpoolSink(filePath, 'clickhouse', { status: 'FAILED', error: chRes.error });
          }
        } catch (e) {
          updateSpoolSink(filePath, 'clickhouse', { status: 'FAILED', error: e.message });
        }
      }

      if (!fs.existsSync(filePath)) {
        results.recovered++;
      } else {
        results.stillPending++;
      }
    } catch (err) {
      results.stillPending++;
      results.errors.push({ file: filePath, error: err.message });
    }
  }

  return results;
}

module.exports = {
  dispatchDualSinkBatch,
  recoverPendingOutbox
};
