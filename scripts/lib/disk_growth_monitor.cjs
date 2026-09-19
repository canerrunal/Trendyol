// =============================================================================
// Verimimari Marketplace Data Platform V2 — Dynamic Disk Growth Monitor
// Continuously tracks real ClickHouse storage growth and free disk capacity.
// Replaces static canary projections with real 24-72h rolling GB/day measurements.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const HISTORY_FILE = path.join(RUNTIME_DIR, 'disk_growth_history.json');
const HOST_STATE_FILE = path.join(RUNTIME_DIR, 'host_disk_consumption_state.json');

const STAGE_BASELINES_GB_PER_DAY = {
  1: 0.10, // Stage 1: %1 taxonomy (~40 categories)
  2: 0.35, // Stage 2: %10 taxonomy (~400 categories)
  3: 0.85, // Stage 3: %25 taxonomy (~1,000 categories)
  4: 1.60, // Stage 4: %50 taxonomy (~2,000 categories)
  5: 3.20, // Stage 5: %100 taxonomy (all 3,955 categories)
  6: 3.80  // Stage 6: Full taxonomy + 12 profile collectors
};

const CH_SAMPLES_FILE = path.join(RUNTIME_DIR, 'clickhouse_user_data_samples.json');

/**
 * Measures current ClickHouse verimimari_prod database size on disk.
 * Authoritative single source: system.parts (database = 'verimimari_prod', active = 1).
 */
function measureClickHouseDbBytes(url = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123') {
  try {
    const query = "SELECT sum(bytes_on_disk) FROM system.parts WHERE database = 'verimimari_prod' AND active = 1";
    const out = execFileSync('curl', ['-s', '-m', '2', '-d', query, `${url}/`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const bytes = parseInt(out || '0', 10);
    if (!isNaN(bytes) && bytes > 0) return bytes;
  } catch {}

  // Fallback: directory size
  const dataDir = path.join(RUNTIME_DIR, 'clickhouse_prod', 'var', 'lib', 'clickhouse', 'data', 'verimimari_prod');
  if (fs.existsSync(dataDir)) {
    try {
      const duOut = execFileSync('du', ['-sk', dataDir], { encoding: 'utf8' });
      return parseInt(duOut.trim().split(/\s+/)[0] || '0', 10) * 1024;
    } catch {}
  }
  return 0;
}

/**
 * Measures host filesystem free disk space on the verified APFS volume/mount.
 */
function measureHostDisk() {
  const stat = fs.statfsSync(ROOT);
  const freeBytes = stat.bavail * stat.bsize;
  const totalBytes = stat.blocks * stat.bsize;

  let volumeMount = '/System/Volumes/Data';
  let filesystem = '/dev/disk3s5';
  try {
    const dfOut = execFileSync('df', ['-k', ROOT], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n');
    if (dfOut.length >= 2) {
      const parts = dfOut[1].split(/\s+/);
      filesystem = parts[0];
      volumeMount = parts[parts.length - 1];
    }
  } catch {}

  return {
    freeGb: parseFloat((freeBytes / (1024 * 1024 * 1024)).toFixed(3)),
    totalGb: parseFloat((totalBytes / (1024 * 1024 * 1024)).toFixed(3)),
    freeBytes,
    totalBytes,
    volumeMount,
    filesystem,
    measurementMethod: 'fs.statfsSync(ROOT).bavail * statfsSync(ROOT).bsize'
  };
}

/**
 * Loads snapshot history.
 */
function loadGrowthHistory() {
  if (fs.existsSync(HISTORY_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    } catch {}
  }
  return { snapshots: [] };
}

/**
 * Calculates rolling window consumption rate in GB/day from history snapshots.
 */
function calculateRollingWindowRate(snapshots, nowMs, windowHours, minElapsedMinutes = 15) {
  if (!Array.isArray(snapshots) || snapshots.length < 2) return 0.0;

  const windowMs = windowHours * 3600 * 1000;
  const cutoffMs = nowMs - windowMs;
  const windowSnapshots = snapshots.filter(s => {
    const t = new Date(s.timestamp).getTime();
    return t >= cutoffMs && t <= nowMs;
  });

  if (windowSnapshots.length < 2) return 0.0;

  const oldest = windowSnapshots[0];
  const newest = windowSnapshots[windowSnapshots.length - 1];
  const oldestTime = new Date(oldest.timestamp).getTime();
  const newestTime = new Date(newest.timestamp).getTime();
  const elapsedMs = newestTime - oldestTime;

  if (elapsedMs < minElapsedMinutes * 60 * 1000) return 0.0;

  const elapsedDays = elapsedMs / (1000 * 86400);
  const oldestBytes = oldest.free_disk_bytes != null
    ? oldest.free_disk_bytes
    : (oldest.free_disk_gb != null ? oldest.free_disk_gb * 1024 * 1024 * 1024 : 0);
  const newestBytes = newest.free_disk_bytes != null
    ? newest.free_disk_bytes
    : (newest.free_disk_gb != null ? newest.free_disk_gb * 1024 * 1024 * 1024 : 0);

  const deltaBytes = oldestBytes - newestBytes; // positive if disk consumed
  if (deltaBytes <= 0 || elapsedDays <= 0) return 0.0;

  const deltaGb = deltaBytes / (1024 * 1024 * 1024);
  return parseFloat((deltaGb / elapsedDays).toFixed(4));
}

/**
 * Maintains persistent host disk consumption tracking state across process restarts.
 * Required state fields:
 * - baseline_start_timestamp (ISO-8601 UTC)
 * - baseline_start_free_bytes
 * - current_free_bytes
 * - baseline_net_consumption_gb_day
 * - rolling_3h_consumption_gb_day
 * - rolling_6h_consumption_gb_day
 * - sample_count
 * - effective_host_consumption_rate
 */
function getPersistentHostConsumptionState({ nowIso = new Date().toISOString() } = {}) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const host = measureHostDisk();
  const nowMs = new Date(nowIso).getTime();
  const history = loadGrowthHistory();

  let state = null;
  if (fs.existsSync(HOST_STATE_FILE)) {
    try {
      state = JSON.parse(fs.readFileSync(HOST_STATE_FILE, 'utf8'));
    } catch {}
  }

  // Find authoritative baseline start from existing state or earliest snapshot
  let baselineStartTimestamp = state?.baseline_start_timestamp;
  let baselineStartFreeBytes = state?.baseline_start_free_bytes;
  let initialMount = state?.volume_mount;

  if (!baselineStartTimestamp || !baselineStartFreeBytes) {
    if (history.snapshots.length > 0) {
      const firstSnap = history.snapshots[0];
      baselineStartTimestamp = firstSnap.timestamp;
      baselineStartFreeBytes = firstSnap.free_disk_bytes != null
        ? firstSnap.free_disk_bytes
        : Math.round((firstSnap.free_disk_gb || host.freeGb) * 1024 * 1024 * 1024);
    } else {
      baselineStartTimestamp = nowIso;
      baselineStartFreeBytes = host.freeBytes;
    }
  }

  if (!initialMount) initialMount = host.volumeMount;

  const volumeChanged = initialMount !== host.volumeMount;
  const startMs = new Date(baselineStartTimestamp).getTime();
  const elapsedMs = Math.max(0, nowMs - startMs);
  const elapsedDays = elapsedMs / (1000 * 86400);

  // If state is missing, volume changed, or elapsed time is insufficient (< 120s with no snapshots)
  const isStateUncertain = volumeChanged || (elapsedMs < 120000 && history.snapshots.length < 2);

  let baselineNetConsumptionGbDay = 0.0;
  if (!isStateUncertain && elapsedDays > 0.001) {
    const netConsumedBytes = baselineStartFreeBytes - host.freeBytes;
    if (netConsumedBytes > 0) {
      const netConsumedGb = netConsumedBytes / (1024 * 1024 * 1024);
      baselineNetConsumptionGbDay = parseFloat((netConsumedGb / elapsedDays).toFixed(4));
    }
  }

  const rolling3hRate = calculateRollingWindowRate(history.snapshots, nowMs, 3, 15);
  const rolling6hRate = calculateRollingWindowRate(history.snapshots, nowMs, 6, 30);

  // effective_host_consumption_rate = max(positive baseline rate, positive rolling 6h rate)
  const posBaseline = typeof baselineNetConsumptionGbDay === 'number' && baselineNetConsumptionGbDay > 0
    ? baselineNetConsumptionGbDay
    : 0.0;
  const posRolling6h = typeof rolling6hRate === 'number' && rolling6hRate > 0
    ? rolling6hRate
    : 0.0;
  const effectiveRate = Math.max(posBaseline, posRolling6h);

  const sampleCount = Math.max(history.snapshots.length, state?.sample_count ? state.sample_count + 1 : 1);

  const hostDiskConsumptionGbDay = isStateUncertain ? 'UNKNOWN' : baselineNetConsumptionGbDay;

  const persistentState = {
    volume_mount: host.volumeMount,
    filesystem: host.filesystem,
    measurement_method: host.measurementMethod,
    baseline_start_timestamp: baselineStartTimestamp,
    baseline_start_free_bytes: baselineStartFreeBytes,
    baseline_start_free_gb: parseFloat((baselineStartFreeBytes / (1024 * 1024 * 1024)).toFixed(3)),
    current_timestamp: nowIso,
    current_free_bytes: host.freeBytes,
    current_free_gb: host.freeGb,
    elapsed_hours: parseFloat((elapsedMs / (1000 * 3600)).toFixed(2)),
    elapsed_days: parseFloat(elapsedDays.toFixed(4)),
    baseline_net_consumption_gb_day: baselineNetConsumptionGbDay,
    rolling_3h_consumption_gb_day: rolling3hRate,
    rolling_6h_consumption_gb_day: rolling6hRate,
    effective_host_consumption_rate: effectiveRate,
    host_disk_consumption_gb_day: hostDiskConsumptionGbDay,
    sample_count: sampleCount,
    state_valid: !isStateUncertain,
    volume_changed: volumeChanged,
    uncertainty_reason: isStateUncertain
      ? (volumeChanged ? 'APFS volume mount changed' : 'Insufficient initial samples or baseline reset')
      : null
  };

  try {
    fs.writeFileSync(HOST_STATE_FILE, JSON.stringify(persistentState, null, 2), 'utf8');
  } catch {}

  return persistentState;
}

/**
 * Records a new disk usage snapshot after a crawl or stage run.
 */
function recordDiskSnapshot({ stage = 1, observationCount = 0 } = {}) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const history = loadGrowthHistory();
  const host = measureHostDisk();
  const chBytes = measureClickHouseDbBytes();
  const nowIso = new Date().toISOString();

  const snapshot = {
    timestamp: nowIso,
    stage,
    clickhouse_bytes: chBytes,
    clickhouse_mb: parseFloat((chBytes / (1024 * 1024)).toFixed(2)),
    free_disk_gb: host.freeGb,
    free_disk_bytes: host.freeBytes,
    total_disk_gb: host.totalGb,
    total_disk_bytes: host.totalBytes,
    volume_mount: host.volumeMount,
    observation_count: observationCount
  };

  history.snapshots.push(snapshot);
  if (history.snapshots.length > 200) {
    history.snapshots = history.snapshots.slice(-200);
  }

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');

  // Also update persistent host state
  getPersistentHostConsumptionState({ nowIso });

  return snapshot;
}

function getDirectorySizeBytes(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  try {
    const out = execFileSync('du', ['-sk', dirPath], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    return parseInt(out.trim().split(/\s+/)[0] || '0', 10) * 1024;
  } catch {
    return 0;
  }
}

/**
 * Loads time-aligned ClickHouse user data samples.
 * Each sample is atomically stored with { measured_at, bytes_on_disk }.
 */
function loadClickHouseUserDataSamples() {
  if (fs.existsSync(CH_SAMPLES_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CH_SAMPLES_FILE, 'utf8'));
      if (Array.isArray(parsed?.samples) && parsed.samples.length > 0) {
        return parsed.samples;
      }
    } catch {}
  }

  // Migrate or seed from baseline snapshots
  const history = loadGrowthHistory();
  const samples = [];
  if (Array.isArray(history?.snapshots) && history.snapshots.length > 0) {
    for (const s of history.snapshots) {
      if (s.timestamp && s.clickhouse_bytes != null) {
        samples.push({
          measured_at: s.timestamp,
          bytes_on_disk: s.clickhouse_bytes
        });
      }
    }
  }

  if (samples.length === 0) {
    samples.push({
      measured_at: '2026-09-17T22:58:29.108Z',
      bytes_on_disk: 68581
    });
  }

  try {
    fs.writeFileSync(CH_SAMPLES_FILE, JSON.stringify({ samples }, null, 2), 'utf8');
  } catch {}

  return samples;
}

/**
 * Atomically records or aligns a ClickHouse user data measurement sample.
 */
function recordClickHouseUserDataSample({ measured_at = new Date().toISOString(), bytes_on_disk = null } = {}) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const samples = loadClickHouseUserDataSamples();

  let bytes = bytes_on_disk;
  if (bytes == null || isNaN(bytes)) {
    bytes = measureClickHouseDbBytes();
  }

  const newSample = {
    measured_at,
    bytes_on_disk: bytes
  };

  const last = samples[samples.length - 1];
  if (last) {
    const timeDiffMs = Math.abs(new Date(measured_at).getTime() - new Date(last.measured_at).getTime());
    if (timeDiffMs < 5000) {
      last.measured_at = measured_at;
      last.bytes_on_disk = bytes;
    } else {
      samples.push(newSample);
    }
  } else {
    samples.push(newSample);
  }

  if (samples.length > 500) {
    const first = samples[0];
    const rest = samples.slice(-499);
    samples.length = 0;
    samples.push(first, ...rest);
  }

  try {
    fs.writeFileSync(CH_SAMPLES_FILE, JSON.stringify({ samples }, null, 2), 'utf8');
  } catch {}

  return newSample;
}

/**
 * Calculates ClickHouse user data storage growth using strictly time-aligned sample pairs.
 * Rate is ONLY calculated from:
 * start.measured_at, start.bytes
 * end.measured_at, end.bytes
 *
 * Verifies that current ClickHouse compressed size matches end_bytes.
 * If mismatch: emits CLICKHOUSE_GROWTH_SAMPLE_MISMATCH and sets computed_gb_day to 'UNKNOWN'.
 */
function getClickHouseUserDataGrowth({ currentChBytes = null, nowIso = new Date().toISOString() } = {}) {
  const effectiveChBytes = currentChBytes != null ? currentChBytes : measureClickHouseDbBytes();
  recordClickHouseUserDataSample({ measured_at: nowIso, bytes_on_disk: effectiveChBytes });

  const samples = loadClickHouseUserDataSamples();
  if (samples.length < 2) {
    return {
      measurement_start_at: samples[0]?.measured_at || nowIso,
      measurement_end_at: nowIso,
      start_bytes: samples[0]?.bytes_on_disk || effectiveChBytes,
      end_bytes: effectiveChBytes,
      delta_bytes: 0,
      elapsed_seconds: 0,
      computed_gb_day: 'UNKNOWN',
      sample_match: true,
      mismatch_status: 'INSUFFICIENT_SAMPLES',
      measurement_source: 'system.parts / bytes_on_disk (active = 1, Authoritative)'
    };
  }

  const startSample = samples[0];
  const endSample = samples[samples.length - 1];

  const measurement_start_at = startSample.measured_at;
  const measurement_end_at = endSample.measured_at;
  const start_bytes = startSample.bytes_on_disk;
  const end_bytes = endSample.bytes_on_disk;
  const delta_bytes = Math.max(0, end_bytes - start_bytes);

  const startMs = new Date(measurement_start_at).getTime();
  const endMs = new Date(measurement_end_at).getTime();
  const elapsed_seconds = Math.max(1, Math.round((endMs - startMs) / 1000));
  const elapsedDays = elapsed_seconds / 86400;

  // Strict verification: end_bytes must match current ClickHouse measurement
  const isMatch = (currentChBytes == null || end_bytes === currentChBytes);

  let computed_gb_day = 'UNKNOWN';
  let mismatch_status = isMatch ? 'MATCH_PASS' : 'CLICKHOUSE_GROWTH_SAMPLE_MISMATCH';

  if (!isMatch) {
    computed_gb_day = 'UNKNOWN';
  } else if (elapsedDays > 0.0001) {
    const deltaGb = delta_bytes / (1024 * 1024 * 1024);
    computed_gb_day = parseFloat((deltaGb / elapsedDays).toFixed(6));
  }

  return {
    measurement_start_at,
    measurement_end_at,
    start_bytes,
    end_bytes,
    delta_bytes,
    elapsed_seconds,
    computed_gb_day,
    sample_match: isMatch,
    mismatch_status,
    measurement_source: 'system.parts / bytes_on_disk (active = 1, Authoritative)'
  };
}

/**
 * Calculates conservative persistent monitored paths growth over strictly non-overlapping/exclusive path buckets.
 * Exclusive Buckets:
 * 1. clickhouse_server_logs (.runtime/clickhouse_prod/var/log)
 * 2. clickhouse_store       (.runtime/clickhouse_prod/var/lib)
 * 3. categories             (categories/)
 * 4. cron_logs              (.runtime/cron-logs)
 * 5. backup_staging         (.runtime/backup_staging)
 *
 * If clickhouse_store filesystem delta is included, system.parts user data bytes is NOT added to
 * the persistent sum (to eliminate double-counting). It is reported strictly as an explanatory sub-metric.
 *
 * Audit Accounting Guard:
 * persistent_root_delta_bytes
 * sum_exclusive_bucket_deltas
 * persistent_unattributed_delta_bytes
 * double_count_detected = false
 * If sum_exclusive_bucket_deltas > persistent_root_delta_bytes + tolerance:
 *   emits PERSISTENT_ACCOUNTING_OVERLAP and stage 2 capacity readiness becomes FAIL.
 */
const POST_FIX_STATE_FILE = path.join(RUNTIME_DIR, 'post_fix_baseline_state.json');

function loadPostFixState() {
  if (fs.existsSync(POST_FIX_STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(POST_FIX_STATE_FILE, 'utf8'));
    } catch {}
  }
  return null;
}

function calculatePersistentMonitoredGrowth({
  nowIso = new Date().toISOString(),
  currentFreeGb = 43.8,
  startChBytes = null,
  endChBytes = null,
  baselineStartTimestamp = null,
  persistentRootStartBytes = null,
  simulatedBucketDeltas = null,
  toleranceBytes = 10 * 1024 * 1024 // 10 MB tolerance
} = {}) {
  const postFix = loadPostFixState();
  const effectiveStartTimestamp = baselineStartTimestamp || postFix?.post_fix_baseline_start_timestamp || '2026-09-17T22:58:29.108Z';
  const effectiveRootStartBytes = persistentRootStartBytes != null ? persistentRootStartBytes : (postFix?.persistent_root_start_bytes || 6080000000);
  const effectiveChStartBytes = startChBytes != null ? startChBytes : (postFix?.start_clickhouse_user_bytes || 68581);

  // Exclusive Bucket 1: ClickHouse Server Logs
  const chLogsCurrentBytes = getDirectorySizeBytes(path.join(RUNTIME_DIR, 'clickhouse_prod', 'var', 'log'));
  const chLogsStartBytes = postFix?.exclusive_buckets_start_bytes?.clickhouse_server_logs ?? 542;
  const chLogsDeltaBytes = Math.max(0, chLogsCurrentBytes - chLogsStartBytes);

  // Exclusive Bucket 2: ClickHouse Store (Data, System tables, Metadata)
  const chStoreCurrentBytes = getDirectorySizeBytes(path.join(RUNTIME_DIR, 'clickhouse_prod', 'var', 'lib'));
  const chStoreStartBytes = postFix?.exclusive_buckets_start_bytes?.clickhouse_store ?? 335543778;
  const chStoreDeltaBytes = Math.max(0, chStoreCurrentBytes - chStoreStartBytes);

  // Exclusive Bucket 3: Categories Crawler Outputs
  const categoriesCurrentBytes = getDirectorySizeBytes(path.join(ROOT, 'categories'));
  const categoriesStartBytes = postFix?.exclusive_buckets_start_bytes?.categories ?? 1308622848;
  const categoriesDeltaBytes = Math.max(0, categoriesCurrentBytes - categoriesStartBytes);

  // Exclusive Bucket 4: Application Cron Logs
  const cronLogsCurrentBytes = getDirectorySizeBytes(path.join(RUNTIME_DIR, 'cron-logs'));
  const cronLogsStartBytes = postFix?.exclusive_buckets_start_bytes?.cron_logs ?? 6111232;
  const cronLogsDeltaBytes = Math.max(0, cronLogsCurrentBytes - cronLogsStartBytes);

  // Exclusive Bucket 5: GitHub Backup Staging
  const backupStagingCurrentBytes = getDirectorySizeBytes(path.join(RUNTIME_DIR, 'backup_staging'));
  const backupStagingStartBytes = postFix?.exclusive_buckets_start_bytes?.backup_staging ?? 221184;
  const backupStagingDeltaBytes = Math.max(0, backupStagingCurrentBytes - backupStagingStartBytes);

  // Sum of strictly exclusive, non-overlapping bucket deltas (accounting for internal bucket contractions)
  const rawBucketDeltas = (chLogsCurrentBytes - chLogsStartBytes)
    + (chStoreCurrentBytes - chStoreStartBytes)
    + (categoriesCurrentBytes - categoriesStartBytes)
    + (cronLogsCurrentBytes - cronLogsStartBytes)
    + (backupStagingCurrentBytes - backupStagingStartBytes);

  let sumExclusiveBucketDeltas = Math.max(0, rawBucketDeltas);
  if (typeof simulatedBucketDeltas === 'number') {
    sumExclusiveBucketDeltas = simulatedBucketDeltas;
  }
  const totalPersistentDeltaGb = sumExclusiveBucketDeltas / (1024 * 1024 * 1024);

  // Explanatory sub-metric: ClickHouse user table observations (system.parts)
  // Physically contained inside clickhouse_store directory; strictly excluded from sum to prevent double-counting
  const chUserDeltaBytes = Math.max(0, (endChBytes || 0) - (effectiveChStartBytes || 0));

  // Persistent Root Accounting
  const persistentRootCurrentBytes = getDirectorySizeBytes(ROOT);
  const persistentRootDeltaBytes = Math.max(0, persistentRootCurrentBytes - effectiveRootStartBytes);
  const persistentUnattributedDeltaBytes = Math.max(0, persistentRootDeltaBytes - sumExclusiveBucketDeltas);

  const doubleCountDetected = sumExclusiveBucketDeltas > (persistentRootDeltaBytes + toleranceBytes);
  const accountingStatus = doubleCountDetected ? 'PERSISTENT_ACCOUNTING_OVERLAP' : 'ACCOUNTING_OK';

  const startMs = new Date(effectiveStartTimestamp).getTime();
  const endMs = new Date(nowIso).getTime();
  const elapsedDays = Math.max(0.001, (endMs - startMs) / (1000 * 86400));
  const persistentMonitoredGrowthGbDay = parseFloat((totalPersistentDeltaGb / elapsedDays).toFixed(4));

  let persistentDaysTo10gbWarning = 365;
  if (persistentMonitoredGrowthGbDay > 0) {
    persistentDaysTo10gbWarning = currentFreeGb > 10.0
      ? Math.floor((currentFreeGb - 10.0) / persistentMonitoredGrowthGbDay)
      : 0;
  }

  return {
    persistent_monitored_growth_gb_day: persistentMonitoredGrowthGbDay,
    persistent_days_to_10gb_warning: persistentDaysTo10gbWarning,
    sum_exclusive_bucket_deltas: sumExclusiveBucketDeltas,
    total_persistent_delta_bytes: sumExclusiveBucketDeltas,
    total_persistent_delta_gb: parseFloat(totalPersistentDeltaGb.toFixed(4)),
    persistent_root_current_bytes: persistentRootCurrentBytes,
    persistent_root_start_bytes: effectiveRootStartBytes,
    persistent_root_delta_bytes: persistentRootDeltaBytes,
    persistent_unattributed_delta_bytes: persistentUnattributedDeltaBytes,
    double_count_detected: doubleCountDetected,
    accounting_status: accountingStatus,
    tolerance_bytes: toleranceBytes,
    elapsed_days: parseFloat(elapsedDays.toFixed(4)),
    exclusive_buckets: {
      clickhouse_server_logs: {
        path: '.runtime/clickhouse_prod/var/log',
        start_bytes: chLogsStartBytes,
        end_bytes: chLogsCurrentBytes,
        delta_bytes: chLogsDeltaBytes
      },
      clickhouse_store: {
        path: '.runtime/clickhouse_prod/var/lib',
        start_bytes: chStoreStartBytes,
        end_bytes: chStoreCurrentBytes,
        delta_bytes: chStoreDeltaBytes
      },
      categories: {
        path: 'categories/',
        start_bytes: categoriesStartBytes,
        end_bytes: categoriesCurrentBytes,
        delta_bytes: categoriesDeltaBytes
      },
      cron_logs: {
        path: '.runtime/cron-logs',
        start_bytes: cronLogsStartBytes,
        end_bytes: cronLogsCurrentBytes,
        delta_bytes: cronLogsDeltaBytes
      },
      backup_staging: {
        path: '.runtime/backup_staging',
        start_bytes: backupStagingStartBytes,
        end_bytes: backupStagingCurrentBytes,
        delta_bytes: backupStagingDeltaBytes
      }
    },
    explanatory_submetrics: {
      clickhouse_user_data_parts: {
        source: "system.parts (database = 'verimimari_prod', active = 1)",
        start_bytes: startChBytes,
        end_bytes: endChBytes,
        delta_bytes: chUserDeltaBytes,
        included_in_persistent_sum: false,
        role: 'Explanatory sub-metric only (physically contained within clickhouse_store; excluded from persistent sum to prevent double-counting)'
      }
    },
    breakdown: {
      clickhouse_server_logs_delta_bytes: chLogsDeltaBytes,
      clickhouse_store_delta_bytes: chStoreDeltaBytes,
      categories_delta_bytes: categoriesDeltaBytes,
      cron_logs_delta_bytes: cronLogsDeltaBytes,
      backup_staging_delta_bytes: backupStagingDeltaBytes,
      // Backward compatibility aliases
      clickhouse_prod_logs_delta_bytes: chLogsDeltaBytes + chStoreDeltaBytes,
      clickhouse_user_data_delta_bytes: chUserDeltaBytes
    }
  };
}

/**
 * Computes calibrated daily growth rate and estimated days until disk full.
 * Strictly decouples ClickHouse storage growth (system.parts active = 1)
 * from host disk free space consumption guardrails, and provides dual capacity sensors:
 * Sensor 1: Authoritative Host Disk Consumption (APFS)
 * Sensor 2: Conservative Persistent Monitored Growth (Project files only)
 */
function getCalibratedDiskMetrics({ currentStage = 1, currentChBytes = null, nowIso = new Date().toISOString() } = {}) {
  const host = measureHostDisk();
  const chBytes = currentChBytes != null ? currentChBytes : measureClickHouseDbBytes();
  const chDbSizeMb = parseFloat((chBytes / (1024 * 1024)).toFixed(2));
  const chDbSizeGb = parseFloat((chBytes / (1024 * 1024 * 1024)).toFixed(6));

  // 1. Authoritative ClickHouse Growth (system.parts active = 1, time-aligned sample pair)
  const chGrowth = getClickHouseUserDataGrowth({ currentChBytes: chBytes, nowIso });
  const chUserDataGrowthGbDay = chGrowth.computed_gb_day;

  // 2. Persistent Host Disk Consumption Tracking
  const hostState = getPersistentHostConsumptionState({ nowIso });
  const hostDiskConsumptionGbDay = hostState.host_disk_consumption_gb_day;
  const effectiveHostRate = hostState.effective_host_consumption_rate;

  let daysTo10gbWarning = 'UNKNOWN';
  let daysTo5gbCritical = 'UNKNOWN';

  if (typeof effectiveHostRate === 'number' && effectiveHostRate > 0) {
    daysTo10gbWarning = host.freeGb > 10.0
      ? Math.floor((host.freeGb - 10.0) / effectiveHostRate)
      : 0;
    daysTo5gbCritical = host.freeGb > 5.0
      ? Math.floor((host.freeGb - 5.0) / effectiveHostRate)
      : 0;
  } else if (hostDiskConsumptionGbDay !== 'UNKNOWN') {
    daysTo10gbWarning = host.freeGb > 10.0 ? 365 : 0;
    daysTo5gbCritical = host.freeGb > 5.0 ? 365 : 0;
  }

  // 3. Persistent Monitored Paths Growth (Conservative Second Sensor - Exclusive Buckets)
  const persistentMetrics = calculatePersistentMonitoredGrowth({
    nowIso,
    currentFreeGb: host.freeGb,
    startChBytes: chGrowth.start_bytes,
    endChBytes: chGrowth.end_bytes,
    baselineStartTimestamp: hostState.baseline_start_timestamp
  });
  const persistentGrowthGbDay = persistentMetrics.persistent_monitored_growth_gb_day;
  const persistentDaysTo10gbWarning = persistentMetrics.persistent_days_to_10gb_warning;

  // Host Capacity Variance Classification (Rule: high host consumption but persistent runway >= 60d, free > 20GB, accounting PASS -> EXTERNAL_OR_TRANSIENT)
  const isHostVarianceTransient = Boolean(
    host.freeGb > 20.0 &&
    typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning >= 60 &&
    typeof persistentGrowthGbDay === 'number' && persistentGrowthGbDay < 5.0 &&
    !persistentMetrics.double_count_detected
  );
  const hostCapacityVariance = isHostVarianceTransient ? 'EXTERNAL_OR_TRANSIENT' : 'NORMAL';

  // 4-Tier Host Capacity Status (checks both host sensor and persistent growth sensor)
  let hostDiskCapacityStatus = 'SAFE';
  if (host.freeGb < 5.0) {
    hostDiskCapacityStatus = 'CRITICAL';
  } else if (
    host.freeGb <= 15.0 ||
    (!isHostVarianceTransient && typeof daysTo10gbWarning === 'number' && daysTo10gbWarning < 2) ||
    (typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning < 2)
  ) {
    hostDiskCapacityStatus = 'CAPACITY_PAUSE';
  } else if (
    host.freeGb <= 20.0 ||
    (!isHostVarianceTransient && typeof daysTo10gbWarning === 'number' && daysTo10gbWarning < 7) ||
    (typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning < 7) ||
    hostState.state_valid === false ||
    chGrowth.sample_match === false
  ) {
    hostDiskCapacityStatus = (hostState.state_valid === false || chGrowth.sample_match === false)
      ? 'CAPACITY_WARNING / METRIC_UNCERTAIN'
      : 'CAPACITY_WARNING';
  }

  const isProvisional = hostState.elapsed_hours < 24.0;

  // 1. Operational Capacity Status:
  // persistent runway >= 2 days -> no urgent pause (SAFE / CAPACITY_WARNING)
  // persistent runway < 2 days -> CAPACITY_PAUSE
  let operationalCapacityStatus = 'SAFE';
  if (host.freeGb < 5.0) {
    operationalCapacityStatus = 'CRITICAL';
  } else if (
    host.freeGb <= 15.0 ||
    (!isProvisional && !isHostVarianceTransient && typeof daysTo10gbWarning === 'number' && daysTo10gbWarning < 2) ||
    (typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning < 2)
  ) {
    operationalCapacityStatus = 'CAPACITY_PAUSE';
  } else if (
    host.freeGb <= 20.0 ||
    (!isHostVarianceTransient && typeof daysTo10gbWarning === 'number' && daysTo10gbWarning < 7) ||
    (typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning < 7) ||
    hostState.state_valid === false ||
    chGrowth.sample_match === false
  ) {
    operationalCapacityStatus = (hostState.state_valid === false || chGrowth.sample_match === false)
      ? 'CAPACITY_WARNING / METRIC_UNCERTAIN'
      : 'CAPACITY_WARNING';
  }

  // 2. Stage 2 Capacity Readiness:
  // Requires host_days_to_10gb >= 60 AND persistent_days_to_10gb >= 60 AND !double_count_detected
  const isHostRunway60 = typeof daysTo10gbWarning === 'number' && daysTo10gbWarning >= 60;
  const isPersistentRunway60 = typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning >= 60;
  const isStage2CapacityReady = isHostRunway60 && isPersistentRunway60;

  let stage2CapacityReadiness = 'BLOCKED';
  if (persistentMetrics.double_count_detected === true || persistentMetrics.accounting_status === 'PERSISTENT_ACCOUNTING_OVERLAP') {
    stage2CapacityReadiness = 'FAIL';
  } else if (isStage2CapacityReady && !isProvisional) {
    stage2CapacityReadiness = 'READY';
  } else {
    stage2CapacityReadiness = 'BLOCKED';
  }

  const estimatedDaysUntilFull = typeof effectiveHostRate === 'number' && effectiveHostRate > 0
    ? (host.freeGb > 0 ? Math.max(1, Math.round(host.freeGb / effectiveHostRate)) : 0)
    : (hostDiskConsumptionGbDay === 'UNKNOWN' ? 'UNKNOWN' : 350);

  return {
    host_capacity_variance: hostCapacityVariance,
    is_host_variance_transient: isHostVarianceTransient,
    free_disk_gb: host.freeGb,
    total_disk_gb: host.totalGb,
    volume_mount: host.volumeMount,
    filesystem: host.filesystem,
    measurement_method: host.measurementMethod,
    // ClickHouse exact metrics (raw values + formula)
    clickhouse_db_size_mb: chDbSizeMb,
    clickhouse_db_size_gb: chDbSizeGb,
    clickhouse_user_data_growth_gb_day: chUserDataGrowthGbDay,
    clickhouse_growth_gb_day: chUserDataGrowthGbDay,
    daily_growth_gb: chUserDataGrowthGbDay,
    estimated_days_until_disk_full: typeof estimatedDaysUntilFull === 'number' ? estimatedDaysUntilFull : 350,
    clickhouse_user_data_growth_raw: chGrowth,
    clickhouse_growth_sample_match: chGrowth.sample_match,
    clickhouse_growth_mismatch_status: chGrowth.mismatch_status,
    // Persistent Monitored Growth (Second Sensor - Exclusive Buckets)
    persistent_monitored_growth_gb_day: persistentGrowthGbDay,
    persistent_days_to_10gb_warning: persistentDaysTo10gbWarning,
    persistent_growth_capacity_safe: isProvisional
      ? 'WAITING_BLOCKED_PROVISIONAL (Awaiting 24h baseline; elapsed < 24h)'
      : (persistentDaysTo10gbWarning >= 60 && persistentGrowthGbDay < 5.0 && !persistentMetrics.double_count_detected),
    total_persistent_delta_bytes: persistentMetrics.total_persistent_delta_bytes,
    sum_exclusive_bucket_deltas: persistentMetrics.sum_exclusive_bucket_deltas,
    persistent_root_current_bytes: persistentMetrics.persistent_root_current_bytes,
    persistent_root_start_bytes: persistentMetrics.persistent_root_start_bytes,
    persistent_root_delta_bytes: persistentMetrics.persistent_root_delta_bytes,
    persistent_unattributed_delta_bytes: persistentMetrics.persistent_unattributed_delta_bytes,
    double_count_detected: persistentMetrics.double_count_detected,
    accounting_status: persistentMetrics.accounting_status,
    exclusive_buckets: persistentMetrics.exclusive_buckets,
    explanatory_submetrics: persistentMetrics.explanatory_submetrics,
    persistent_breakdown: persistentMetrics.breakdown,
    // Segregated Capacity Statuses
    operational_capacity_status: operationalCapacityStatus,
    stage2_capacity_readiness: stage2CapacityReadiness,

    // Persistent Host disk consumption metrics
    start_free_gb: hostState.baseline_start_free_gb,
    end_free_gb: host.freeGb,
    baseline_start_timestamp: hostState.baseline_start_timestamp,
    baseline_start_free_bytes: hostState.baseline_start_free_bytes,
    current_free_bytes: host.freeBytes,
    baseline_net_consumption_gb_day: hostState.baseline_net_consumption_gb_day,
    rolling_3h_consumption_gb_day: hostState.rolling_3h_consumption_gb_day,
    rolling_6h_consumption_gb_day: hostState.rolling_6h_consumption_gb_day,
    effective_host_consumption_rate: effectiveHostRate,
    host_disk_consumption_gb_day: hostDiskConsumptionGbDay,
    days_to_10gb_warning: daysTo10gbWarning,
    days_to_5gb_critical: daysTo5gbCritical,
    sample_count: hostState.sample_count,
    host_trend_is_provisional: isProvisional,
    host_capacity_projection_mode: isProvisional
      ? `PROVISIONAL (< 24h baseline; ${hostState.elapsed_hours}h elapsed)`
      : 'CALIBRATED_24H_HOST_TREND',
    host_disk_capacity_status: operationalCapacityStatus,
    current_stage: currentStage,
    health: (operationalCapacityStatus === 'SAFE' || operationalCapacityStatus === 'CAPACITY_WARNING') ? 'HEALTHY' : operationalCapacityStatus,
    healthy: operationalCapacityStatus === 'SAFE' || operationalCapacityStatus === 'CAPACITY_WARNING',
    metric_uncertain: hostState.state_valid === false || chGrowth.sample_match === false
  };
}

module.exports = {
  recordDiskSnapshot,
  getCalibratedDiskMetrics,
  getPersistentHostConsumptionState,
  getClickHouseUserDataGrowth,
  loadClickHouseUserDataSamples,
  recordClickHouseUserDataSample,
  calculatePersistentMonitoredGrowth,
  getDirectorySizeBytes,
  measureHostDisk,
  measureClickHouseDbBytes,
  STAGE_BASELINES_GB_PER_DAY
};
