// =============================================================================
// Verimimari Marketplace Data Platform V2 — ClickHouse HTTP Client & Outbox
// Zero-dependency, asynchronous, non-blocking with deterministic observation IDs,
// write-ahead spooling (.runtime/clickhouse_outbox/), and durable at-least-once delivery.
// =============================================================================

'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.CLICKHOUSE_TIMEOUT_MS || '5000', 10);
const DEFAULT_OUTBOX_DIR = path.join(ROOT, '.runtime', 'clickhouse_outbox');

/**
 * Retrieves Cloudflare Access Service Token headers if configured in environment.
 * Used for machine-to-machine authentication through Cloudflare Access Zero Trust policy.
 */
function getCloudflareAccessHeaders() {
  const headers = {};
  const clientId = process.env.CF_ACCESS_CLIENT_ID;
  const clientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (clientId && clientSecret) {
    headers['CF-Access-Client-Id'] = clientId;
    headers['CF-Access-Client-Secret'] = clientSecret;
  }
  return headers;
}

/**
 * Canonical serialization for cryptographic hashing.
 * Strictly separates null, undefined, empty strings, and typed values
 * to guarantee collision-free deterministic keys.
 */
function canonicalPart(p) {
  if (p === null) return '\x00null';
  if (p === undefined) return '\x00undef';
  if (typeof p === 'string') return '\x01' + p;
  if (typeof p === 'number' || typeof p === 'bigint') return '\x02' + String(p);
  if (typeof p === 'boolean') return '\x03' + (p ? '1' : '0');
  return '\x04' + JSON.stringify(p);
}

/**
 * Generates a collision-resistant deterministic SHA256 hex string.
 */
function hashKey(...parts) {
  return crypto.createHash('sha256')
    .update(parts.map(canonicalPart).join('\x1f'))
    .digest('hex');
}

/**
 * Deterministic ID for product_observations:
 * SHA256(marketplace : run_id : product_id : merchant_id : variant_id : listing_id : source_scope : captured_at)
 * NOTE: Logical event identity / reconciliation key; not a DB uniqueness constraint in MergeTree.
 *
 * Source Disambiguation:
 * Within the same run, a product may be observed across multiple source scopes
 * (e.g. 'taxonomy' vs 'profile:supermarket') or at distinct timestamps.
 * Including source_scope and frozen captured_at ensures distinct physical snapshots
 * maintain unique, collision-resistant event identities.
 */
function buildProductObservationId(obs, runId) {
  const mkt = obs.marketplace || 'trendyol';
  const rId = runId || obs.run_id || 'unknown';
  const pId = obs.product_id != null ? String(obs.product_id) : (obs.productId != null ? String(obs.productId) : '');
  const mId = obs.merchant_id != null ? String(obs.merchant_id) : (obs.merchantId != null ? String(obs.merchantId) : null);
  const vId = obs.variant_id != null ? String(obs.variant_id) : (obs.variantId != null ? String(obs.variantId) : null);
  const lId = obs.listing_id != null ? String(obs.listing_id) : (obs.listingId != null ? String(obs.listingId) : null);
  const scope = obs.source_scope || obs.sourceScope || 'taxonomy';
  const capturedAt = obs.frozen_captured_at || obs.captured_at || null;
  return hashKey(mkt, rId, pId, mId, vId, lId, scope, capturedAt);
}

/**
 * Deterministic ID for category_rank_observations:
 * SHA256(marketplace : run_id : category_id : product_id : merchant_id : rank_scope : rank)
 */
function buildCategoryRankObservationId(rankItem, runId) {
  const mkt = rankItem.marketplace || 'trendyol';
  const rId = runId || rankItem.run_id || 'unknown';
  const cId = rankItem.category_id != null ? Number(rankItem.category_id) : (rankItem.categoryId != null ? Number(rankItem.categoryId) : '');
  const pId = rankItem.product_id != null ? String(rankItem.product_id) : (rankItem.productId != null ? String(rankItem.productId) : '');
  const mId = rankItem.merchant_id != null ? String(rankItem.merchant_id) : (rankItem.merchantId != null ? String(rankItem.merchantId) : null);
  const scope = rankItem.rank_scope || rankItem.rankScope || 'bestseller';
  const rank = rankItem.rank != null ? Number(rankItem.rank) : '';
  return hashKey(mkt, rId, cId, pId, mId, scope, rank);
}

/**
 * Deterministic ID for offer_observations:
 * SHA256(marketplace : run_id : profile_slug : product_id : merchant_id : rank_scope)
 */
function buildOfferObservationId(offer, runId) {
  const mkt = offer.marketplace || 'trendyol';
  const rId = runId || offer.run_id || 'unknown';
  const slug = offer.profile_slug || offer.profileSlug || '';
  const pId = offer.product_id != null ? String(offer.product_id) : (offer.productId != null ? String(offer.productId) : '');
  const mId = offer.merchant_id != null ? String(offer.merchant_id) : (offer.merchantId != null ? String(offer.merchantId) : null);
  const scope = offer.rank_scope || offer.rankScope || 'default';
  return hashKey(mkt, rId, slug, pId, mId, scope);
}

/**
 * Deterministic ID for profile_observations:
 * SHA256(marketplace : run_id : profile_slug : product_id : merchant_id : offer_key : rank_scope : rank_position)
 */
function buildProfileObservationId(obs, runId) {
  const mkt = obs.marketplace || 'trendyol';
  const rId = runId || obs.run_id || 'unknown';
  const slug = obs.profile_slug || obs.profileSlug || '';
  const pId = obs.product_id != null ? String(obs.product_id) : (obs.productId != null ? String(obs.productId) : '');
  const mId = obs.merchant_id != null ? String(obs.merchant_id) : (obs.merchantId != null ? String(obs.merchantId) : null);
  const offerKey = obs.offer_key || obs.offerKey || `${pId}:${mId || 'default'}`;
  const scope = obs.rank_scope || obs.rankScope || 'default';
  const rankPos = obs.rank_position != null ? Number(obs.rank_position) : (obs.rankPosition != null ? Number(obs.rankPosition) : null);
  return hashKey(mkt, rId, slug, pId, mId, offerKey, scope, rankPos);
}

/**
 * Computes deterministic batch checksum and batch ID.
 */
function computeBatchChecksum(rows = []) {
  const hash = crypto.createHash('sha256');
  for (const row of rows) {
    hash.update(row.observation_id || JSON.stringify(row));
    hash.update('\n');
  }
  return hash.digest('hex');
}

function computeBatchId(table, runId, batchIndex, checksum) {
  return hashKey(table, runId, batchIndex, checksum).slice(0, 32);
}

/**
 * Computes a logical dataset checksum across canonical rows.
 * Independent of physical storage engine (PostgreSQL, ClickHouse, Parquet).
 * Sorts rows deterministically by sortKey, canonically serializes fields in alphabetical order,
 * and produces a SHA256 hash.
 */
function computeLogicalDatasetChecksum(rows = [], sortKey = 'observation_id') {
  if (!rows || rows.length === 0) {
    return crypto.createHash('sha256').update('EMPTY_DATASET').digest('hex');
  }

  const sorted = [...rows].sort((a, b) => {
    const ka = a[sortKey] != null ? String(a[sortKey]) : JSON.stringify(a);
    const kb = b[sortKey] != null ? String(b[sortKey]) : JSON.stringify(b);
    return ka.localeCompare(kb);
  });

  const hash = crypto.createHash('sha256');
  for (const row of sorted) {
    const keys = Object.keys(row).sort();
    for (const k of keys) {
      hash.update(k);
      hash.update('\x1e');
      hash.update(canonicalPart(row[k]));
      hash.update('\x1f');
    }
    hash.update('\n');
  }

  return hash.digest('hex');
}

/**
 * Normalizes a Javascript value for ClickHouse insertion.
 */
function normalizeClickHouseValue(val) {
  if (val === undefined) return null;
  if (val === true) return 1;
  if (val === false) return 0;
  if (Array.isArray(val)) return val;
  return val;
}

/**
 * Maps a collector product observation into a ClickHouse-ready row.
 */
function mapProductObservation(obs, runMetadata = {}) {
  const runId = obs.run_id || runMetadata.run_id || 'unknown-run';
  const inStock = obs.in_stock === true ? 1 : obs.in_stock === false ? 0 : null;
  const runningOut = obs.running_out === true ? 1 : obs.running_out === false ? 0 : null;
  const fastDelivery = obs.fast_delivery === true ? 1 : 0;
  const capturedAt = obs.captured_at || runMetadata.captured_at || new Date().toISOString().replace('T', ' ').replace('Z', '');
  const sourceScope = obs.source_scope || obs.sourceScope || 'taxonomy';

  return {
    observation_id: obs.observation_id || buildProductObservationId({ ...obs, source_scope: sourceScope, captured_at: capturedAt }, runId),
    marketplace: obs.marketplace || 'trendyol',
    observed_date: obs.observed_date || runMetadata.observed_date || new Date().toISOString().slice(0, 10),
    captured_at: capturedAt,
    run_id: runId,
    product_id: String(obs.product_id || obs.productId || ''),
    merchant_id: obs.merchant_id || obs.merchantId || null,
    variant_id: obs.variant_id || obs.variantId || null,
    listing_id: obs.listing_id || obs.listingId || null,
    offer_key: obs.offer_key || obs.offerKey || `${obs.product_id || obs.productId}:${obs.merchant_id || obs.merchantId || 'default'}`,
    price: obs.price != null ? Number(obs.price) : null,
    original_price: obs.original_price != null ? Number(obs.original_price) : null,
    currency: obs.currency || 'TRY',
    in_stock: inStock,
    running_out: runningOut,
    rating: obs.rating != null ? Number(obs.rating) : null,
    rating_count: obs.rating_count != null ? Number(obs.rating_count) : null,
    review_count: obs.review_count != null ? Number(obs.review_count) : null,
    stock_quantity: obs.metrics?.stock_quantity != null ? Number(obs.metrics.stock_quantity) : null,
    sales_signal: obs.sales_signal || null,
    sales_signal_min: obs.sales_signal_min != null ? Number(obs.sales_signal_min) : null,
    promotions_count: Array.isArray(obs.promotions) ? obs.promotions.length : 0,
    promotions: Array.isArray(obs.promotions) ? obs.promotions.map(String) : [],
    fast_delivery: fastDelivery,
    rush_delivery_hours: obs.rush_delivery_hours != null ? Number(obs.rush_delivery_hours) : null,
    source_scope: sourceScope
  };
}

/**
 * Maps a category ranking observation into a ClickHouse-ready row.
 */
function mapCategoryRankObservation(rankItem, runMetadata = {}) {
  const runId = rankItem.run_id || runMetadata.run_id || 'unknown-run';
  return {
    observation_id: rankItem.observation_id || buildCategoryRankObservationId(rankItem, runId),
    marketplace: rankItem.marketplace || 'trendyol',
    observed_date: rankItem.observed_date || runMetadata.observed_date || new Date().toISOString().slice(0, 10),
    captured_at: rankItem.captured_at || runMetadata.captured_at || new Date().toISOString().replace('T', ' ').replace('Z', ''),
    run_id: runId,
    category_id: Number(rankItem.category_id || rankItem.categoryId),
    rank: Number(rankItem.rank),
    product_id: String(rankItem.product_id || rankItem.productId),
    merchant_id: rankItem.merchant_id || rankItem.merchantId || null,
    offer_key: rankItem.offer_key || rankItem.offerKey || `${rankItem.product_id || rankItem.productId}:${rankItem.merchant_id || rankItem.merchantId || 'default'}`,
    rank_scope: rankItem.rank_scope || rankItem.rankScope || 'bestseller',
    price: rankItem.price != null ? Number(rankItem.price) : null,
    rank_delta: rankItem.rank_delta != null ? Number(rankItem.rank_delta) : null
  };
}

/**
 * Maps a profile observation into a ClickHouse-ready row for verimimari_prod.profile_observations.
 */
function mapProfileObservation(obs, runMetadata = {}) {
  const runId = obs.run_id || runMetadata.run_id || 'unknown-run';
  const pId = String(obs.product_id || obs.productId);
  const mId = obs.merchant_id || obs.merchantId || null;
  const offerKey = obs.offer_key || obs.offerKey || `${pId}:${mId || 'default'}`;
  const profileSlug = obs.profile_slug || obs.profileSlug || 'default';
  return {
    observation_id: obs.observation_id || buildProfileObservationId(obs, runId),
    marketplace: obs.marketplace || 'trendyol',
    profile_slug: profileSlug,
    observed_date: obs.observed_date || runMetadata.observed_date || new Date().toISOString().slice(0, 10),
    captured_at: obs.captured_at || runMetadata.captured_at || new Date().toISOString().replace('T', ' ').replace('Z', ''),
    run_id: runId,
    product_id: pId,
    merchant_id: mId,
    offer_key: offerKey,
    rank_position: obs.rank_position != null ? Number(obs.rank_position) : (obs.rankPosition != null ? Number(obs.rankPosition) : null),
    rank_scope: obs.rank_scope || obs.rankScope || 'default',
    price: obs.price != null ? Number(obs.price) : null,
    original_price: obs.original_price != null ? Number(obs.original_price) : (obs.originalPrice != null ? Number(obs.originalPrice) : null),
    discount_percent: obs.discount_percent != null ? Number(obs.discount_percent) : (obs.discountPercent != null ? Number(obs.discountPercent) : null),
    trend_score: obs.trend_score != null ? Number(obs.trend_score) : (obs.trendScore != null ? Number(obs.trendScore) : null),
    opportunity_score: obs.opportunity_score != null ? Number(obs.opportunity_score) : (obs.opportunityScore != null ? Number(obs.opportunityScore) : null),
    stock_status: obs.stock_status || obs.stockStatus || null,
    stock_signal: obs.stock_signal || obs.stockSignal || null
  };
}

// -----------------------------------------------------------------------------
// Write-Ahead Durable Outbox Spooling (.runtime/clickhouse_outbox/)
// -----------------------------------------------------------------------------

function ensureOutboxDir(outboxDir = DEFAULT_OUTBOX_DIR) {
  if (!fs.existsSync(outboxDir)) {
    fs.mkdirSync(outboxDir, { recursive: true });
  }
}

/**
 * Durable atomic file writer:
 * write -> fsync(file) -> atomic rename -> fsync(directory)
 * Guarantees that neither partial files nor lost writes occur across process/OS crashes.
 */
function durableWriteAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = path.join(
    dir,
    `.tmp_${path.basename(filePath)}_${process.pid}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  );

  const fd = fs.openSync(tmpPath, 'w');
  try {
    fs.writeSync(fd, content, 0, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  fs.renameSync(tmpPath, filePath);

  try {
    const dirFd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    // Directory fsync is unsupported or restricted on some filesystems/OS platforms
  }
}

/**
 * Write-Ahead Spool: Atomically persists the batch to disk BEFORE external transport.
 * Tracks independent delivery status and attempt counts for both Supabase and ClickHouse sinks.
 * Guarantees durable at-least-once delivery semantics.
 */
function writeAheadSpool({
  outboxDir = DEFAULT_OUTBOX_DIR,
  table,
  rows,
  runId = 'unknown',
  batchIndex = 0,
  batchId,
  batchChecksum,
  sinks = {}
} = {}) {
  if (!rows || rows.length === 0) return null;
  ensureOutboxDir(outboxDir);

  const checksum = batchChecksum || computeBatchChecksum(rows);
  const id = batchId || computeBatchId(table, runId, batchIndex, checksum);
  const timestamp = Date.now();
  const safeTable = table.replace(/[^a-zA-Z0-9_]/g, '_');
  const safeRunId = runId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const baseName = `${safeRunId}_${safeTable}_b${batchIndex}_${id}`;
  const spoolPath = path.join(outboxDir, `${baseName}.spool`);

  const payload = {
    batchId: id,
    batchChecksum: checksum,
    table,
    runId,
    batchIndex,
    timestamp,
    rowCount: rows.length,
    sinks: {
      supabase: {
        status: sinks.supabase?.status || 'PENDING',
        attempts: sinks.supabase?.attempts || 0,
        lastAttemptAt: sinks.supabase?.lastAttemptAt || null,
        error: sinks.supabase?.error || null
      },
      clickhouse: {
        status: sinks.clickhouse?.status || 'PENDING',
        attempts: sinks.clickhouse?.attempts || 0,
        lastAttemptAt: sinks.clickhouse?.lastAttemptAt || null,
        error: sinks.clickhouse?.error || null
      }
    },
    rows // Preserved exactly without mutation
  };

  durableWriteAtomic(spoolPath, JSON.stringify(payload) + '\n');
  return { spoolPath, batchId: id, batchChecksum: checksum, payload };
}

/**
 * Updates delivery state for a specific sink ('supabase' | 'clickhouse').
 * DUAL-SINK ACK RULE: Spool is unlinked ONLY when BOTH sinks return status 'ACK'.
 */
function updateSpoolSink(spoolPath, sinkName, { status = 'PENDING', error = null } = {}) {
  if (!fs.existsSync(spoolPath)) {
    return { cleared: true, missing: true };
  }

  let payload;
  try {
    const content = fs.readFileSync(spoolPath, 'utf8').trim();
    if (!content) {
      try { fs.unlinkSync(spoolPath); } catch {}
      return { cleared: true };
    }
    payload = JSON.parse(content);
  } catch (err) {
    return { cleared: false, error: 'Malformed spool file' };
  }

  if (!payload.sinks) {
    payload.sinks = {
      supabase: { status: 'PENDING', attempts: 0, lastAttemptAt: null, error: null },
      clickhouse: { status: 'PENDING', attempts: 0, lastAttemptAt: null, error: null }
    };
  }

  if (!payload.sinks[sinkName]) {
    payload.sinks[sinkName] = { status: 'PENDING', attempts: 0, lastAttemptAt: null, error: null };
  }

  payload.sinks[sinkName].attempts = (payload.sinks[sinkName].attempts || 0) + 1;
  payload.sinks[sinkName].status = status;
  payload.sinks[sinkName].lastAttemptAt = new Date().toISOString();
  payload.sinks[sinkName].error = error ? String(error) : null;

  const supabaseAck = payload.sinks.supabase?.status === 'ACK';
  const clickhouseAck = payload.sinks.clickhouse?.status === 'ACK';

  if (supabaseAck && clickhouseAck) {
    // Both sinks confirmed ACK: safely unlink spool file
    try {
      fs.unlinkSync(spoolPath);
    } catch {}
    return { cleared: true, sinks: payload.sinks };
  }

  // Not all sinks ACKed yet: durably save updated manifest back to disk
  durableWriteAtomic(spoolPath, JSON.stringify(payload) + '\n');
  return { cleared: false, sinks: payload.sinks };
}

/**
 * Outbox backlog health thresholds for alerting.
 */
const OUTBOX_HEALTH_THRESHOLDS = {
  WARNING: {
    pending_batches: 5,
    oldest_batch_age_sec: 300,  // 5 minutes
    size_mb: 50
  },
  CRITICAL: {
    pending_batches: 20,
    oldest_batch_age_sec: 3600, // 1 hour
    size_mb: 200
  }
};

/**
 * Lists all pending spool files in the outbox directory.
 */
function listPendingOutbox(outboxDir = DEFAULT_OUTBOX_DIR) {
  if (!fs.existsSync(outboxDir)) return [];
  return fs.readdirSync(outboxDir)
    .filter(f => f.endsWith('.spool') || f.endsWith('.jsonl'))
    .sort()
    .map(f => path.join(outboxDir, f));
}

/**
 * Calculates backlog health metrics for the outbox.
 * Reports pending_batches, pending_rows, size_mb, oldest_batch_age_sec,
 * and evaluates OK / WARNING / CRITICAL health states.
 */
function getOutboxBacklogMetrics(outboxDir = DEFAULT_OUTBOX_DIR) {
  if (!fs.existsSync(outboxDir)) {
    return {
      pending_batches: 0,
      pending_rows: 0,
      size_mb: 0,
      oldest_batch_age_sec: 0,
      health: 'OK',
      reasons: [],
      sinks_pending: { supabase: 0, clickhouse: 0 },
      thresholds: OUTBOX_HEALTH_THRESHOLDS
    };
  }

  const files = listPendingOutbox(outboxDir);
  if (files.length === 0) {
    return {
      pending_batches: 0,
      pending_rows: 0,
      size_mb: 0,
      oldest_batch_age_sec: 0,
      health: 'OK',
      reasons: [],
      sinks_pending: { supabase: 0, clickhouse: 0 },
      thresholds: OUTBOX_HEALTH_THRESHOLDS
    };
  }

  let totalBytes = 0;
  let totalRows = 0;
  let oldestTimestamp = Date.now();
  const sinksPending = { supabase: 0, clickhouse: 0 };

  for (const filePath of files) {
    try {
      const st = fs.statSync(filePath);
      totalBytes += st.size;
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (content) {
        const parsed = JSON.parse(content);
        totalRows += (parsed.rowCount || (Array.isArray(parsed.rows) ? parsed.rows.length : 0));
        const fileTs = parsed.timestamp || st.mtimeMs;
        if (fileTs < oldestTimestamp) {
          oldestTimestamp = fileTs;
        }
        if (parsed.sinks) {
          if (parsed.sinks.supabase?.status !== 'ACK') sinksPending.supabase++;
          if (parsed.sinks.clickhouse?.status !== 'ACK') sinksPending.clickhouse++;
        } else {
          sinksPending.supabase++;
          sinksPending.clickhouse++;
        }
      }
    } catch {
      // Ignore unparseable or transient files
    }
  }

  const now = Date.now();
  const oldest_batch_age_sec = Math.max(0, Math.floor((now - oldestTimestamp) / 1000));
  const size_mb = Math.round((totalBytes / (1024 * 1024)) * 100) / 100;
  const pending_batches = files.length;

  let health = 'OK';
  const reasons = [];

  // Evaluate CRITICAL first
  if (pending_batches >= OUTBOX_HEALTH_THRESHOLDS.CRITICAL.pending_batches) {
    health = 'CRITICAL';
    reasons.push(`pending_batches (${pending_batches} >= ${OUTBOX_HEALTH_THRESHOLDS.CRITICAL.pending_batches})`);
  }
  if (oldest_batch_age_sec >= OUTBOX_HEALTH_THRESHOLDS.CRITICAL.oldest_batch_age_sec) {
    health = 'CRITICAL';
    reasons.push(`oldest_batch_age_sec (${oldest_batch_age_sec}s >= ${OUTBOX_HEALTH_THRESHOLDS.CRITICAL.oldest_batch_age_sec}s)`);
  }
  if (size_mb >= OUTBOX_HEALTH_THRESHOLDS.CRITICAL.size_mb) {
    health = 'CRITICAL';
    reasons.push(`size_mb (${size_mb}MB >= ${OUTBOX_HEALTH_THRESHOLDS.CRITICAL.size_mb}MB)`);
  }

  // Evaluate WARNING if not CRITICAL
  if (health !== 'CRITICAL') {
    if (pending_batches >= OUTBOX_HEALTH_THRESHOLDS.WARNING.pending_batches) {
      health = 'WARNING';
      reasons.push(`pending_batches (${pending_batches} >= ${OUTBOX_HEALTH_THRESHOLDS.WARNING.pending_batches})`);
    }
    if (oldest_batch_age_sec >= OUTBOX_HEALTH_THRESHOLDS.WARNING.oldest_batch_age_sec) {
      health = 'WARNING';
      reasons.push(`oldest_batch_age_sec (${oldest_batch_age_sec}s >= ${OUTBOX_HEALTH_THRESHOLDS.WARNING.oldest_batch_age_sec}s)`);
    }
    if (size_mb >= OUTBOX_HEALTH_THRESHOLDS.WARNING.size_mb) {
      health = 'WARNING';
      reasons.push(`size_mb (${size_mb}MB >= ${OUTBOX_HEALTH_THRESHOLDS.WARNING.size_mb}MB)`);
    }
  }

  return {
    pending_batches,
    pending_rows: totalRows,
    size_mb,
    oldest_batch_age_sec,
    health,
    reasons,
    sinks_pending: sinksPending,
    thresholds: OUTBOX_HEALTH_THRESHOLDS
  };
}

// -----------------------------------------------------------------------------
// ClickHouse HTTP Transport & Batch Sender (Write-Ahead Spool + Dual-Sink ACK)
// -----------------------------------------------------------------------------

/**
 * Sends a batch to ClickHouse following the write-ahead spool pattern:
 * 1. Persist batch to .runtime/clickhouse_outbox/<batch_id>.spool BEFORE HTTP call.
 * 2. Send HTTP INSERT with query param `insert_deduplication_token=<batch_id>`.
 *    NOTE ON DEDUPLICATION TOKEN:
 *    insert_deduplication_token provides secondary defense during network transport retries.
 *    Because ClickHouse block deduplication has a finite window (replicated_deduplication_window),
 *    system correctness MUST NEVER rely solely on ClickHouse dedup window.
 *    Observation-level idempotent reconciliation remains mandatory.
 * 3. On successful ACK (HTTP 200..299): Mark ClickHouse sink ACK. Unlink spool ONLY IF Supabase also ACKed.
 * 4. On failure/timeout: Mark ClickHouse sink FAILED and retain spool file for replay.
 */
async function sendClickHouseBatch({
  baseUrl = DEFAULT_CLICKHOUSE_URL,
  table,
  rows,
  runId = 'unknown',
  batchIndex = 0,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  user = process.env.CLICKHOUSE_USER || 'default',
  password = process.env.CLICKHOUSE_PASSWORD || '',
  writeAhead = true,
  outboxDir = DEFAULT_OUTBOX_DIR,
  sinks = {}
} = {}) {
  if (!rows || rows.length === 0) {
    return { ok: true, inserted: 0 };
  }

  const batchChecksum = computeBatchChecksum(rows);
  const batchId = computeBatchId(table, runId, batchIndex, batchChecksum);

  let spoolRecord = null;
  if (writeAhead) {
    spoolRecord = writeAheadSpool({
      outboxDir,
      table,
      rows,
      runId,
      batchIndex,
      batchId,
      batchChecksum,
      sinks
    });
  }

  const serializedLines = rows.map(r => JSON.stringify(r)).join('\n');
  const endpoint = new URL(baseUrl);
  endpoint.searchParams.set('query', `INSERT INTO ${table} FORMAT JSONEachRow`);
  endpoint.searchParams.set('insert_deduplication_token', batchId);

  const transportResult = await new Promise((resolve) => {
    const isHttps = endpoint.protocol === 'https:';
    const transport = isHttps ? https : http;

    const reqOptions = {
      method: 'POST',
      hostname: endpoint.hostname,
      port: endpoint.port || (isHttps ? 443 : 8123),
      path: endpoint.pathname + endpoint.search,
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Length': Buffer.byteLength(serializedLines),
        ...(user ? { 'X-ClickHouse-User': user } : {}),
        ...(password ? { 'X-ClickHouse-Key': password } : {}),
        ...getCloudflareAccessHeaders()
      },
      timeout: timeoutMs
    };

    const req = transport.request(reqOptions, (res) => {
      let responseBody = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { responseBody += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({ ok: true, inserted: rows.length, batchId, batchChecksum });
        } else {
          resolve({
            ok: false,
            statusCode: res.statusCode,
            batchId,
            batchChecksum,
            error: responseBody.trim() || `HTTP ${res.statusCode}`
          });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, batchId, batchChecksum, error: `ClickHouse request timed out after ${timeoutMs}ms` });
    });

    req.on('error', (err) => {
      resolve({ ok: false, batchId, batchChecksum, error: err.message || 'ClickHouse connection failed' });
    });

    req.write(serializedLines);
    req.end();
  });

  // Dual-Sink ACK Handling:
  // Spool is unlinked ONLY when both Supabase and ClickHouse have status 'ACK'.
  if (spoolRecord && spoolRecord.spoolPath) {
    const updateResult = updateSpoolSink(
      spoolRecord.spoolPath,
      'clickhouse',
      transportResult.ok
        ? { status: 'ACK' }
        : { status: 'FAILED', error: transportResult.error }
    );

    return {
      ...transportResult,
      spooled: !updateResult.cleared,
      spoolPath: spoolRecord.spoolPath,
      sinks: updateResult.sinks
    };
  }

  return transportResult;
}

/**
 * Replays all pending outbox files to ClickHouse.
 * CRITICAL RULE: captured_at, observation_id, batch rows, and order are NEVER regenerated.
 * The original spooled payload is replayed verbatim.
 */
async function replayOutbox({
  baseUrl = DEFAULT_CLICKHOUSE_URL,
  outboxDir = DEFAULT_OUTBOX_DIR,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  const files = listPendingOutbox(outboxDir);
  const results = { total: files.length, replayed: 0, failed: 0, cleared: 0 };

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf8').trim();
      if (!content) {
        fs.unlinkSync(filePath);
        continue;
      }
      const batch = JSON.parse(content);

      // If ClickHouse already ACKed this batch, do not resend to ClickHouse
      if (batch.sinks?.clickhouse?.status === 'ACK') {
        continue;
      }

      // Replay EXACT payload
      const res = await sendClickHouseBatch({
        baseUrl,
        table: batch.table,
        rows: batch.rows,
        runId: batch.runId,
        batchIndex: batch.batchIndex || 0,
        timeoutMs,
        writeAhead: false // Handled manually below
      });

      if (res.ok) {
        const updateRes = updateSpoolSink(filePath, 'clickhouse', { status: 'ACK' });
        results.replayed++;
        if (updateRes.cleared) {
          results.cleared++;
        }
      } else {
        updateSpoolSink(filePath, 'clickhouse', { status: 'FAILED', error: res.error });
        results.failed++;
        break; // Preserve order and stop on ClickHouse failure
      }
    } catch (err) {
      results.failed++;
      break;
    }
  }

  return results;
}

async function pingClickHouse(baseUrl = DEFAULT_CLICKHOUSE_URL, timeoutMs = 2000) {
  const endpoint = new URL('/ping', baseUrl);
  return new Promise((resolve) => {
    const transport = endpoint.protocol === 'https:' ? https : http;
    const req = transport.get(endpoint.href, {
      timeout: timeoutMs,
      headers: getCloudflareAccessHeaders()
    }, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        resolve({ ok: res.statusCode === 200 && body.trim() === 'Ok.' });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
  });
}

module.exports = {
  canonicalPart,
  hashKey,
  computeBatchChecksum,
  computeBatchId,
  computeLogicalDatasetChecksum,
  buildProductObservationId,
  buildCategoryRankObservationId,
  buildOfferObservationId,
  buildProfileObservationId,
  normalizeClickHouseValue,
  mapProductObservation,
  mapCategoryRankObservation,
  mapProfileObservation,
  durableWriteAtomic,
  writeAheadSpool,
  updateSpoolSink,
  listPendingOutbox,
  replayOutbox,
  sendClickHouseBatch,
  getOutboxBacklogMetrics,
  pingClickHouse,
  getCloudflareAccessHeaders,
  DEFAULT_OUTBOX_DIR,
  OUTBOX_HEALTH_THRESHOLDS
};

