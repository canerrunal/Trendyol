// =============================================================================
// Verimimari Marketplace Data Platform V2 — Outbox Background Recovery Daemon
// Periodically checks .runtime/clickhouse_outbox and replays any pending spools.
// Guarantees zero stuck backlog if ClickHouse or collector momentarily restarts.
// =============================================================================

'use strict';

const { replayOutbox, getOutboxBacklogMetrics } = require('./lib/clickhouse_client.cjs');

async function runRecovery() {
  const metrics = getOutboxBacklogMetrics();
  if (metrics.pending_batches === 0) {
    return { pending: 0, status: 'CLEAN' };
  }

  console.log(`[OUTBOX RECOVERY] Found ${metrics.pending_batches} pending spool(s) (${metrics.pending_size_mb} MB, oldest age: ${metrics.oldest_batch_age_sec}s)`);
  const result = await replayOutbox();
  console.log(`[OUTBOX RECOVERY] Replay finished: replayed=${result.replayed}, cleared=${result.cleared}, failed=${result.failed}`);

  const postMetrics = getOutboxBacklogMetrics();
  return {
    before: metrics.pending_batches,
    after: postMetrics.pending_batches,
    result,
    status: postMetrics.pending_batches === 0 ? 'CLEAN' : 'PENDING'
  };
}

if (require.main === module) {
  runRecovery()
    .then(res => {
      console.log('Recovery result:', JSON.stringify(res));
      process.exit(res.status === 'CLEAN' ? 0 : 1);
    })
    .catch(err => {
      console.error('Fatal recovery failure:', err);
      process.exit(1);
    });
}

module.exports = { runRecovery };
