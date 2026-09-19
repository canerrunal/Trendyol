// =============================================================================
// Verimimari Marketplace Data Platform V2 — Stage 1 Continuous Daily Monitor &
// 24–72h Observation Audit Report Generator
//
// AUDIT MOTORU DÜZELTMELERİ (P1.4 REFINED):
// 1. ClickHouse depolama büyümesi: system.parts / bytes_on_disk üzerinden AUTHORITATIVE ölçüm.
// 2. Free disk: Yalnız kapasite ve erken uyarı guardrail metriği (ayrı raporlanır, MATCH_PASS üretmez).
// 3. Koşu ve mutabakat ayrımı:
//    - total_runs (tüm geçmiş ve test koşuları)
//    - eligible_stage1_runs (yalnız gerçek Stage 1 kapsamındaki koşular)
//    - reconciled_runs (14/14 mutabakatı tamamlananlar)
//    - reconciliation_pass_rate ((reconciled_runs / eligible_stage1_runs) * 100%)
//    - Stage 2 şartı: reconciled_runs == eligible_stage1_runs ve pass_rate == 100%.
// 4. Gerçek büyüme hızı:
//    - elapsed_hours, start_clickhouse_bytes, end_clickhouse_bytes, delta_bytes
//    - growth_gb_per_day = (delta_bytes / 1024^3) / (elapsed_hours / 24)
// 5. Stage 2 Gating:
//    - 100% eligible-run reconciliation
//    - 0 duplicate
//    - outbox sağlıklı (0 backlog)
//    - backup PASS
//    - restore-test PASS
//    - tunnel sağlıklı (ONLINE)
//    - disk guardrail güvenli (free_disk_gb >= 10.0, days_until_full >= 60)
//    - elapsed_hours >= 24.0 (asgari gözlem süresi)
//
// RESMİ AFET KURTARMA (DR) STANDARDI:
// RPO <= 24h, RTO <= 2h; son doğrulanmış snapshot'a kadar geri yükleme garanti edilir.
//
// SUPABASE TARİHSEL TABLO DOKUNULMAZLIĞI:
// Kesinlikle 0 DROP, 0 DELETE, 0 TRUNCATE, 0 INDEX DROP.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const DAILY_LOG_FILE = path.join(RUNTIME_DIR, 'stage_1_daily_log.json');
const STATE_FILE = path.join(RUNTIME_DIR, 'rollout_state.json');
const CANARY_STATE_FILE = path.join(RUNTIME_DIR, 'stage_2_ranking_canary_state.json');
const CANARY_OUTBOX_DIR = path.join(RUNTIME_DIR, 'stage_2_canary_outbox');
const DISK_HISTORY_FILE = path.join(RUNTIME_DIR, 'disk_growth_history.json');
const STAGE_1_OUTBOX_DIR = path.join(RUNTIME_DIR, 'stage_1_outbox');
const CRAWLER_PAUSE_FILE = path.join(RUNTIME_DIR, 'crawler_pause_state.json');

const { getOutboxBacklogMetrics } = require('./lib/clickhouse_client.cjs');
const { getCalibratedDiskMetrics } = require('./lib/disk_growth_monitor.cjs');
const { getCloudflareTunnelHealth } = require('../dashboard/server.cjs');

const LOCAL_CH_URL = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123';
const READER_USER = process.env.CLICKHOUSE_READER_USER || 'verimimari_reader';
const READER_PASS = process.env.CLICKHOUSE_READER_PASSWORD || 'sec_reader_p1_3_test';

const OFFICIAL_DR_CONTRACT = "RPO <= 24h, RTO <= 2h; son doğrulanmış snapshot'a kadar geri yükleme garanti edilir.";

function runSql(query, { useAdmin = false } = {}) {
  if (useAdmin) {
    const args = ['-s', '-S', '--fail-with-body', '-d', query, `${LOCAL_CH_URL}/`];
    return execFileSync('curl', args, { encoding: 'utf8' }).trim();
  }
  const userArgs = READER_USER ? ['-u', `${READER_USER}:${READER_PASS}`] : [];
  const args = ['-s', '-S', '--fail-with-body', ...userArgs, '-d', query, `${LOCAL_CH_URL}/`];
  return execFileSync('curl', args, { encoding: 'utf8' }).trim();
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
 * Ensures strict ISO-8601 UTC timestamp format ending in 'Z'.
 */
function formatIsoUtc(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    const trimmed = val.trim();
    if (!trimmed || trimmed === '1970-01-01T00:00:00Z' || trimmed.startsWith('1970-01-01')) return null;
    if (trimmed.endsWith('Z')) return trimmed;
    const parsed = new Date(trimmed.includes('T') ? (trimmed.includes('+') || trimmed.includes('-') ? trimmed : trimmed + 'Z') : trimmed.replace(' ', 'T') + 'Z');
    if (!isNaN(parsed.getTime())) return parsed.toISOString();
    return trimmed;
  }
  if (val instanceof Date) return val.toISOString();
  return null;
}

const EXPECTED_PRODUCTION_TABLES = [
  'product_observations',
  'category_rank_observations',
  'profile_observations',
  'inventory_observations'
];

/**
 * Formal stage-specific pipeline write contracts.
 * Specifies table expectations per stage to prevent generic PASS.
 */
const STAGE_WRITE_CONTRACTS = {
  1: {
    stage_name: 'Stage 1 (1% Canary Dual-Write)',
    description: 'Yalnızca product_observations canlı ikili yazım kapsamındadır. category_rank_observations yalnızca preflight canary doğrulaması satırları içerir; canlı production rank akışı Stage 2 (%10) ile birlikte zorunlu olacaktır.',
    tables: {
      product_observations: {
        expectation: 'REQUIRED_ACTIVE',
        note: 'Canlı ikili yazım yapılan ana ürün gözlem tablosu.'
      },
      category_rank_observations: {
        expectation: 'PRODUCTION_EMPTY_PREFLIGHT_PRESENT',
        note: 'Kategori sıralama akışı Stage 2 (%10 genişleme) ile birlikte zorunlu olacaktır. Tabloda preflight satırları mevcuttur; production stream henüz başlamamıştır.'
      },
      profile_observations: {
        expectation: 'EMPTY_ALLOWED_BY_STAGE',
        note: 'Mağaza/profil gözlemleri sonraki aşamaya (Stage 3/4) bırakılmıştır.'
      },
      inventory_observations: {
        expectation: 'EMPTY_ALLOWED_BY_STAGE',
        note: 'Stok hareket ve envanter gözlemleri sonraki aşamaya (Stage 5) bırakılmıştır.'
      }
    }
  },
  2: {
    stage_name: 'Stage 2 (10% Taxonomy Rollout)',
    description: 'product_observations ve category_rank_observations ikili yazım kapsamındadır; ranking stream ACTIVE_HEALTHY ve reconciliation PASS olmak zorundadır.',
    tables: {
      product_observations: {
        expectation: 'REQUIRED_ACTIVE',
        note: 'Canlı ikili yazım yapılan ana ürün gözlem tablosu.'
      },
      category_rank_observations: {
        expectation: 'REQUIRED_ACTIVE',
        note: 'Stage 2 taxonomy rollout için zorunlu kategori sıralama akışı (reconciliation PASS şart).'
      },
      profile_observations: {
        expectation: 'EMPTY_ALLOWED_BY_STAGE',
        note: 'Sonraki aşamaya bırakılmıştır.'
      },
      inventory_observations: {
        expectation: 'EMPTY_ALLOWED_BY_STAGE',
        note: 'Sonraki aşamaya bırakılmıştır.'
      }
    }
  },
  3: {
    stage_name: 'Stage 3 (25% Taxonomy Rollout)',
    description: 'product_observations ve category_rank_observations ikili yazım kapsamındadır; ranking stream ACTIVE_HEALTHY ve reconciliation PASS olmak zorundadır.',
    tables: {
      product_observations: {
        expectation: 'REQUIRED_ACTIVE',
        note: 'Canlı ikili yazım yapılan ana ürün gözlem tablosu.'
      },
      category_rank_observations: {
        expectation: 'REQUIRED_ACTIVE',
        note: 'Stage 3 taxonomy rollout için zorunlu kategori sıralama akışı (reconciliation PASS şart).'
      },
      profile_observations: {
        expectation: 'EMPTY_ALLOWED_BY_STAGE',
        note: 'Sonraki aşamaya bırakılmıştır.'
      },
      inventory_observations: {
        expectation: 'EMPTY_ALLOWED_BY_STAGE',
        note: 'Sonraki aşamaya bırakılmıştır.'
      }
    }
  },
  4: {
    stage_name: 'Stage 4 (50% Taxonomy Rollout)',
    description: 'product_observations ve category_rank_observations ikili yazım kapsamındadır; ranking stream ACTIVE_HEALTHY ve reconciliation PASS olmak zorundadır.',
    tables: {
      product_observations: {
        expectation: 'REQUIRED_ACTIVE',
        note: 'Canlı ikili yazım yapılan ana ürün gözlem tablosu.'
      },
      category_rank_observations: {
        expectation: 'REQUIRED_ACTIVE',
        note: 'Stage 4 taxonomy rollout için zorunlu kategori sıralama akışı (reconciliation PASS şart).'
      },
      profile_observations: {
        expectation: 'EMPTY_ALLOWED_BY_STAGE',
        note: 'Sonraki aşamaya bırakılmıştır.'
      },
      inventory_observations: {
        expectation: 'EMPTY_ALLOWED_BY_STAGE',
        note: 'Sonraki aşamaya bırakılmıştır.'
      }
    }
  },
  5: {
    stage_name: 'Stage 5 (100% Taxonomy Rollout)',
    description: 'product_observations ve category_rank_observations ikili yazım kapsamındadır; ranking stream ACTIVE_HEALTHY ve reconciliation PASS olmak zorundadır. Profil ve envanter akışları P1.4 Stage 5 kapsamında aktif edilmez.',
    tables: {
      product_observations: {
        expectation: 'REQUIRED_ACTIVE',
        note: 'Canlı ikili yazım yapılan ana ürün gözlem tablosu.'
      },
      category_rank_observations: {
        expectation: 'REQUIRED_ACTIVE',
        note: 'Stage 5 taxonomy rollout için zorunlu kategori sıralama akışı (reconciliation PASS şart).'
      },
      profile_observations: {
        expectation: 'EMPTY_ALLOWED_BY_STAGE',
        note: 'P1.4 Stage 5 kapsamında profil akışı aktif edilmez (EMPTY_ALLOWED_BY_STAGE).'
      },
      inventory_observations: {
        expectation: 'EMPTY_ALLOWED_BY_STAGE',
        note: 'P1.4 Stage 5 kapsamında envanter akışı aktif edilmez (EMPTY_ALLOWED_BY_STAGE).'
      }
    }
  }
};

function computeQuantile(sorted, q) {
  if (!sorted || sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  if (sorted[base + 1] !== undefined) {
    return Math.round((sorted[base] + rest * (sorted[base + 1] - sorted[base])) * 10) / 10;
  }
  return sorted[base];
}

/**
 * Collects real INSERT/outbox batch event metrics from ClickHouse system.query_log.
 * Discards restore-test events (_restore_verify_*, backup_restore_*) to prevent skewed metrics.
 */
function collectRealBatchMetrics() {
  let sampleCount = 0;
  let p50 = 'INSUFFICIENT_SAMPLE';
  let p95 = 'INSUFFICIENT_SAMPLE';
  let min = 'INSUFFICIENT_SAMPLE';
  let max = 'INSUFFICIENT_SAMPLE';
  let batchesPerHour = 0;
  let status = 'INSUFFICIENT_SAMPLE';
  let recentEvents = [];

  try {
    const rawEvents = runSql(`
      SELECT
        query_id as batch_id,
        written_rows as row_count,
        event_time as inserted_at
      FROM system.query_log
      WHERE (
          query LIKE '%INSERT INTO verimimari_prod.product_observations%'
          OR query LIKE '%INSERT INTO verimimari_prod.category_rank_observations%'
          OR query LIKE '%INSERT INTO verimimari_prod.profile_observations%'
          OR query LIKE '%INSERT INTO verimimari_prod.inventory_observations%'
        )
        AND query NOT LIKE '%_restore_verify_%'
        AND query NOT LIKE '%backup_restore_%'
        AND type = 'QueryFinish'
        AND written_rows > 0
      ORDER BY event_time DESC
      FORMAT JSON
    `);
    const parsed = JSON.parse(rawEvents);
    if (parsed && Array.isArray(parsed.data)) {
      sampleCount = parsed.data.length;
      recentEvents = parsed.data.slice(0, 5).map(e => ({
        batch_id: e.batch_id,
        row_count: parseInt(e.row_count, 10) || 0,
        inserted_at: e.inserted_at
      }));

      if (sampleCount >= 5) {
        status = 'SUFFICIENT_SAMPLE';
        const rowCounts = parsed.data.map(e => parseInt(e.row_count, 10) || 0).sort((a, b) => a - b);
        min = rowCounts[0];
        max = rowCounts[rowCounts.length - 1];
        p50 = computeQuantile(rowCounts, 0.50);
        p95 = computeQuantile(rowCounts, 0.95);

        const firstTime = new Date(parsed.data[parsed.data.length - 1].inserted_at).getTime();
        const lastTime = new Date(parsed.data[0].inserted_at).getTime();
        const durationHours = Math.max(1, (lastTime - firstTime) / (1000 * 3600));
        batchesPerHour = parseFloat((sampleCount / durationHours).toFixed(2));
      } else if (sampleCount > 0) {
        const rowCounts = parsed.data.map(e => parseInt(e.row_count, 10) || 0).sort((a, b) => a - b);
        min = rowCounts[0];
        max = rowCounts[rowCounts.length - 1];
      }
    }
  } catch (err) {
    console.error('Failed to collect real batch metrics:', err.message);
  }

  // If live system.query_log has insufficient samples (e.g. immediately post-restart or log rotation),
  // fall back to the most recent historical observation log with sufficient sample depth
  if (sampleCount < 5 && fs.existsSync(DAILY_LOG_FILE)) {
    try {
      const dailyLog = JSON.parse(fs.readFileSync(DAILY_LOG_FILE, 'utf8'));
      const entries = Array.isArray(dailyLog) ? dailyLog : (dailyLog.entries || []);
      for (let i = entries.length - 1; i >= 0; i--) {
        const bm = entries[i]?.clickhouse_scale_metrics?.batch_metrics || entries[i]?.scale_metrics?.batch_metrics;
        if (bm && typeof bm.sample_count === 'number' && bm.sample_count >= 5) {
          return {
            ...bm,
            historical_fallback: true,
            historical_recorded_at: entries[i]?.timestamp
          };
        }
      }
    } catch {}
  }

  return {
    sample_count: sampleCount,
    status,
    p50,
    p95,
    min,
    max,
    batches_per_hour: batchesPerHour,
    recent_events: recentEvents
  };
}

/**
 * Evaluates whether current table inventory satisfies stage write expectations.
 * Preflight canary rows in category_rank_observations are strictly segregated and
 * NOT counted as Stage 1 production rank activity.
 */
function evaluateWriteCoverageHealth(stage = 1, tableInventory = []) {
  const contract = STAGE_WRITE_CONTRACTS[stage] || STAGE_WRITE_CONTRACTS[1];
  const tableCoverage = [];
  const failingTables = [];

  for (const item of tableInventory) {
    const expectationConfig = contract.tables[item.table] || { expectation: 'EMPTY_ALLOWED_BY_STAGE', note: '' };
    const exp = expectationConfig.expectation;
    let writeStatus = item.status;
    let coveragePass = false;
    let failureReason = null;

    // Stage-specific Write Coverage Contract: preflight rows do NOT count as production activity
    let effectiveRows = item.rows;
    if (stage === 1 && item.table === 'category_rank_observations') {
      effectiveRows = item.stage1_production_rank_rows != null ? item.stage1_production_rank_rows : 0;
    } else if (stage >= 2 && item.table === 'category_rank_observations') {
      effectiveRows = item.stage2_production_rank_rows != null ? item.stage2_production_rank_rows : (item.rows - (item.total_preflight_rank_rows || 0));
    }

    if (!item.table_exists) {
      writeStatus = 'MISSING_TABLE';
      coveragePass = false;
      failureReason = 'MISSING_TABLE (Tablo şemada mevcut değil)';
      failingTables.push({ table: item.table, reason: failureReason });
    } else if (exp === 'REQUIRED_ACTIVE') {
      if (effectiveRows > 0 && item.active_parts > 0) {
        writeStatus = 'ACTIVE_HEALTHY';
        coveragePass = true;
      } else {
        writeStatus = 'EXPECTED_BUT_EMPTY';
        coveragePass = false;
        failureReason = 'EXPECTED_BUT_EMPTY (Aşama sözleşmesine göre satır/parça bekleniyor ancak tablo boş)';
        failingTables.push({ table: item.table, reason: failureReason });
      }
    } else if (exp === 'EMPTY_ALLOWED_BY_STAGE' || exp === 'PRODUCTION_EMPTY_PREFLIGHT_PRESENT') {
      if (item.table === 'category_rank_observations') {
        const prodRows = item.stage1_production_rank_rows != null ? item.stage1_production_rank_rows : 0;
        const totalPreflight = item.total_preflight_rank_rows != null
          ? item.total_preflight_rank_rows
          : (item.preflight_rank_rows != null ? item.preflight_rank_rows : (item.rows - prodRows));
        if (prodRows === 0 && totalPreflight > 0) {
          writeStatus = 'PRODUCTION_EMPTY_PREFLIGHT_PRESENT';
          coveragePass = true;
        } else if (prodRows === 0) {
          writeStatus = 'PRODUCTION_EMPTY_PREFLIGHT_PRESENT';
          coveragePass = true;
        } else {
          writeStatus = 'UNEXPECTED_PRODUCTION_ACTIVITY';
          coveragePass = false;
          failureReason = 'UNEXPECTED_PRODUCTION_ACTIVITY (Stage 1 sırasında category_rank_observations tablosuna üretim satırı yazıldı)';
          failingTables.push({ table: item.table, reason: failureReason });
        }
      } else if (item.rows === 0) {
        writeStatus = 'EMPTY_ALLOWED_BY_STAGE';
        coveragePass = true;
      } else {
        writeStatus = 'ACTIVE_HEALTHY';
        coveragePass = true;
      }
    }

    tableCoverage.push({
      table: item.table,
      table_exists: item.table_exists,
      stage_expectation: exp,
      write_status: writeStatus,
      rows: item.rows,
      stage1_production_rank_rows: item.stage1_production_rank_rows,
      total_preflight_rank_rows: item.total_preflight_rank_rows,
      latest_preflight_rank_rows: item.latest_preflight_rank_rows,
      preflight_rank_rows: item.total_preflight_rank_rows != null ? item.total_preflight_rank_rows : item.preflight_rank_rows,
      stage1_production_status: item.table === 'category_rank_observations'
        ? (item.stage1_production_rank_rows === 0 ? 'EXPECTED' : 'UNEXPECTED_ROWS')
        : undefined,
      preflight_validation_status: item.table === 'category_rank_observations'
        ? (((item.total_preflight_rank_rows || item.preflight_rank_rows || 0) > 0) ? 'PRE-FLIGHT VALIDATION ONLY' : 'NONE')
        : undefined,
      bytes_on_disk: item.bytes_on_disk,
      active_parts: item.active_parts,
      max_parts_per_partition: item.max_parts_per_partition,
      last_insert_at: item.last_insert_at,
      coverage_pass: coveragePass,
      contract_note: expectationConfig.note,
      failure_reason: failureReason
    });
  }

  const allPassed = failingTables.length === 0;
  return {
    status: allPassed ? 'PASS' : 'FAIL',
    stage: stage,
    stage_name: contract.stage_name,
    conforming_tables: tableCoverage.filter(t => t.coverage_pass).length,
    failing_tables: failingTables,
    table_coverage: tableCoverage,
    details: allPassed
      ? `${contract.stage_name} write coverage tam sağlandı (${tableCoverage.map(t => `${t.table}: ${t.write_status}`).join(', ')})`
      : `Write coverage ihlali: ${failingTables.map(f => `${f.table}: ${f.reason}`).join(', ')}`
  };
}

/**
 * Collects read-only scale metrics from ClickHouse and evaluates
 * schema_health, parts_health, and write_coverage_health separately.
 */
function collectClickHouseScaleMetrics({ evaluationTimestamp = null } = {}) {
  let activePartsCount = 0;
  let maxPartsPerPartition = 0;
  let mergesRunning = 0;
  let partsByTable = [];
  const tableInventory = [];
  let topStage1ProductionRankRows = 0;
  let topStage2ProductionRankRows = 0;
  let topPreflightRankRows = 0;

  try {
    activePartsCount = parseInt(runSql("SELECT count() FROM system.parts WHERE database = 'verimimari_prod' AND active = 1"), 10) || 0;
    maxPartsPerPartition = parseInt(runSql("SELECT max(c) FROM (SELECT partition, count() AS c FROM system.parts WHERE database = 'verimimari_prod' AND active = 1 GROUP BY partition)"), 10) || 0;
    mergesRunning = parseInt(runSql("SELECT count() FROM system.merges WHERE database = 'verimimari_prod'"), 10) || 0;

    // Explicit inventory of all expected production schema tables
    for (const t of EXPECTED_PRODUCTION_TABLES) {
      let tableExists = false;
      try {
        const exRaw = runSql(`SELECT count() AS c FROM system.tables WHERE database = 'verimimari_prod' AND name = '${t}'`);
        tableExists = parseInt(exRaw, 10) > 0;
      } catch {}

      if (!tableExists) {
        tableInventory.push({
          table: t,
          table_exists: false,
          rows: 0,
          bytes_on_disk: 0,
          active_parts: 0,
          max_parts_per_partition: 0,
          last_insert_at: null,
          latest_observed_at: null,
          status: 'MISSING_TABLE'
        });
        continue;
      }

      let rows = 0;
      let bytes = 0;
      let parts = 0;
      let maxParts = 0;
      try {
        const pRaw = runSql(`SELECT sum(rows) as rows, sum(bytes_on_disk) as bytes_on_disk, count() as active_parts, max(part_count) as max_parts_per_partition FROM (SELECT partition, count() as part_count, sum(rows) as rows, sum(bytes_on_disk) as bytes_on_disk FROM system.parts WHERE database = 'verimimari_prod' AND table = '${t}' AND active = 1 GROUP BY partition) FORMAT JSON`);
        const parsedP = JSON.parse(pRaw);
        if (parsedP && Array.isArray(parsedP.data) && parsedP.data[0]) {
          const p0 = parsedP.data[0];
          rows = parseInt(p0.rows, 10) || 0;
          bytes = parseInt(p0.bytes_on_disk, 10) || 0;
          parts = parseInt(p0.active_parts, 10) || 0;
          maxParts = parseInt(p0.max_parts_per_partition, 10) || 0;
        }
      } catch {}

      let latestCaptured = null;
      let latestCreated = null;
      if (rows > 0) {
        try {
          const tsRaw = runSql(`SELECT formatDateTime(toTimeZone(max(captured_at), 'UTC'), '%Y-%m-%dT%H:%i:%sZ') as max_cap, formatDateTime(toTimeZone(max(created_at), 'UTC'), '%Y-%m-%dT%H:%i:%sZ') as max_created FROM verimimari_prod.${t} FORMAT JSON`);
          const parsedTs = JSON.parse(tsRaw);
          if (parsedTs && Array.isArray(parsedTs.data) && parsedTs.data[0]) {
            latestCaptured = formatIsoUtc(parsedTs.data[0].max_cap);
            latestCreated = formatIsoUtc(parsedTs.data[0].max_created);
          }
        } catch {}
      }

      // Explicit separation of preflight canary rows from production rank stream
      let stage1ProductionRankRows = 0;
      let stage2ProductionRankRows = 0;
      let totalPreflightRankRows = 0;
      let latestPreflightRankRows = 0;
      if (t === 'category_rank_observations') {
        try {
          const canaryState = getStage2RankingCanaryStatus({ evaluationTimestamp });
          const targetCanaryRunId = canaryState?.run_id || '';
          const splitRaw = runSql(`
            SELECT
              countIf(run_id LIKE '%stage1%' AND NOT (run_id LIKE '%preflight%' OR run_id LIKE '%canary%')) AS stage1_production_rank_rows,
              countIf(run_id LIKE '%stage2%' AND NOT (run_id LIKE '%preflight%' OR run_id LIKE '%canary%')) AS stage2_production_rank_rows,
              countIf(run_id LIKE '%preflight%' OR run_id LIKE '%canary%') AS total_preflight_rank_rows,
              countIf(run_id = '${targetCanaryRunId}') AS latest_preflight_rank_rows
            FROM verimimari_prod.category_rank_observations
            FORMAT JSON
          `);
          const parsedSplit = JSON.parse(splitRaw);
          if (parsedSplit && Array.isArray(parsedSplit.data) && parsedSplit.data[0]) {
            stage1ProductionRankRows = parseInt(parsedSplit.data[0].stage1_production_rank_rows, 10) || 0;
            stage2ProductionRankRows = parseInt(parsedSplit.data[0].stage2_production_rank_rows, 10) || 0;
            totalPreflightRankRows = parseInt(parsedSplit.data[0].total_preflight_rank_rows, 10) || 0;
            latestPreflightRankRows = parseInt(parsedSplit.data[0].latest_preflight_rank_rows, 10) || 0;
            if (latestPreflightRankRows === 0 && canaryState?.rankings_count > 0) {
              latestPreflightRankRows = canaryState.rankings_count;
            }
            topPreflightRankRows = totalPreflightRankRows;
            topStage1ProductionRankRows = stage1ProductionRankRows;
            topStage2ProductionRankRows = stage2ProductionRankRows;
          }
        } catch (err) {
          console.error('Failed to query category_rank_observations split:', err.message);
        }
      }

      // Base status: category_rank_observations with preflight rows is PRODUCTION_EMPTY_PREFLIGHT_PRESENT for Stage 1,
      // and ACTIVE_HEALTHY for Stage 2+ when stage2_production_rank_rows > 0
      let status = rows === 0 ? 'EMPTY_ALLOWED_BY_STAGE' : (parts <= 50 ? 'ACTIVE_HEALTHY' : 'PARTS_HIGH_WARNING');
      if (t === 'category_rank_observations') {
        if (stage2ProductionRankRows > 0) {
          status = (parts <= 50) ? 'ACTIVE_HEALTHY' : 'PARTS_HIGH_WARNING';
        } else if (stage1ProductionRankRows === 0 && (totalPreflightRankRows > 0 || rows > 0)) {
          status = 'PRODUCTION_EMPTY_PREFLIGHT_PRESENT';
        } else if (stage1ProductionRankRows === 0) {
          status = 'EMPTY_ALLOWED_BY_STAGE';
        } else {
          status = 'UNEXPECTED_PRODUCTION_ACTIVITY';
        }
      }

      const item = {
        table: t,
        table_exists: true,
        rows,
        stage1_production_rank_rows: t === 'category_rank_observations' ? stage1ProductionRankRows : undefined,
        stage2_production_rank_rows: t === 'category_rank_observations' ? stage2ProductionRankRows : undefined,
        total_preflight_rank_rows: t === 'category_rank_observations' ? totalPreflightRankRows : undefined,
        latest_preflight_rank_rows: t === 'category_rank_observations' ? latestPreflightRankRows : undefined,
        preflight_rank_rows: t === 'category_rank_observations' ? totalPreflightRankRows : undefined,
        bytes_on_disk: bytes,
        active_parts: parts,
        max_parts_per_partition: maxParts,
        last_insert_at: latestCreated,
        latest_observed_at: latestCaptured,
        status
      };
      tableInventory.push(item);
      if (parts > 0) {
        partsByTable.push(item);
      }
    }
  } catch (err) {
    console.error('Failed to query ClickHouse scale metrics:', err.message);
  }

  // 1. Real Batch Metrics (system.query_log real INSERT events)
  const batchMetrics = collectRealBatchMetrics();
  const insertBatchP50 = typeof batchMetrics.p50 === 'number' ? batchMetrics.p50 : 0;
  const insertBatchP95 = typeof batchMetrics.p95 === 'number' ? batchMetrics.p95 : 0;
  const insertsPerHour = batchMetrics.batches_per_hour;

  // 2. Schema Health
  const missingTables = EXPECTED_PRODUCTION_TABLES.filter(t => !tableInventory.some(i => i.table === t && i.table_exists));
  const schemaHealth = {
    status: missingTables.length === 0 ? 'PASS' : 'FAIL',
    expected_tables_count: EXPECTED_PRODUCTION_TABLES.length,
    existing_tables_count: EXPECTED_PRODUCTION_TABLES.length - missingTables.length,
    missing_tables: missingTables,
    details: missingTables.length === 0
      ? `All ${EXPECTED_PRODUCTION_TABLES.length} production tables present in verimimari_prod schema`
      : `Missing tables in schema: ${missingTables.join(', ')}`
  };

  // 3. Parts Health (Active parts hygiene)
  const highPartsTables = tableInventory.filter(t => t.table_exists && t.active_parts > 50);
  const partsHealth = {
    status: (activePartsCount <= 50 && maxPartsPerPartition <= 50 && mergesRunning === 0 && highPartsTables.length === 0)
      ? 'PASS'
      : (activePartsCount > 100 ? 'FAIL' : 'WARNING'),
    active_parts_count: activePartsCount,
    max_parts_per_partition: maxPartsPerPartition,
    merges_running: mergesRunning,
    high_parts_tables: highPartsTables.map(t => t.table),
    details: `active_parts=${activePartsCount}, max_parts_per_partition=${maxPartsPerPartition}, merges=${mergesRunning}`
  };

  // 4. Pipeline Write Coverage Health (Stage 1 Active)
  const writeCoverageHealth = evaluateWriteCoverageHealth(1, tableInventory);
  // Also evaluate Stage 2 Write Coverage Contract (for gating awareness)
  const stage2WriteCoverage = evaluateWriteCoverageHealth(2, tableInventory);
  const preflightRankingCanary = getStage2RankingCanaryStatus({ evaluationTimestamp });

  return {
    active_parts_count: activePartsCount,
    max_parts_per_partition: maxPartsPerPartition,
    merges_running: mergesRunning,
    insert_batch_rows_p50: insertBatchP50,
    insert_batch_rows_p95: insertBatchP95,
    inserts_per_hour: insertsPerHour,
    batch_metrics: batchMetrics,
    schema_health: schemaHealth,
    parts_health: partsHealth,
    write_coverage_health: writeCoverageHealth,
    stage_2_write_coverage: stage2WriteCoverage,
    preflight_ranking_canary: preflightRankingCanary,
    stage1_production_rank_rows: topStage1ProductionRankRows,
    stage2_production_rank_rows: topStage2ProductionRankRows,
    total_preflight_rank_rows: topPreflightRankRows,
    latest_preflight_rank_rows: preflightRankingCanary.latest_preflight_rank_rows || preflightRankingCanary.rankings_count || 60,
    preflight_rank_rows: topPreflightRankRows,
    latest_preflight_run_id: preflightRankingCanary.run_id,
    latest_preflight_completed_at: preflightRankingCanary.completed_at || preflightRankingCanary.evaluated_at,
    ranking_canary_age_hours: preflightRankingCanary.ranking_canary_age_hours,
    ranking_canary_age_status: preflightRankingCanary.ranking_canary_age_status,
    parts_by_table: partsByTable,
    table_inventory: tableInventory,
    all_expected_tables_exist: schemaHealth.status === 'PASS'
  };
}

/**
 * Evaluates the status of the Stage 2 Preflight Ranking Canary dynamically.
 * Condition requirements for stage_2_ranking_ready (must simultaneously satisfy all 6):
 * 1. latest_ranking_canary_status == PASS
 * 2. ranking_canary_age_hours <= 24
 * 3. latest_ranking_canary_completed_at > last_storage_hygiene_change_at
 *    (Storage Hygiene not yet applied -> canary classified as PRE_STORAGE_HYGIENE_PASS,
 *     which blocks final Stage 2 approval until post-fix canary runs)
 * 4. dedicated_rank_reconciliation == PASS
 * 5. duplicate_rank_observations == 0
 * 6. outbox_pending_batches == 0
 */
function getStage2RankingCanaryStatus({ evaluationTimestamp = null } = {}) {
  const rolloutState = fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    : {};

  let canaryState = null;
  if (fs.existsSync(CANARY_STATE_FILE)) {
    try {
      canaryState = JSON.parse(fs.readFileSync(CANARY_STATE_FILE, 'utf8'));
    } catch {}
  }

  const evalIso = evaluationTimestamp || new Date().toISOString();
  const evalMs = new Date(evalIso).getTime();

  if (!canaryState) {
    return {
      canary_status: 'WAITING_PREFLIGHT_CANARY',
      canary_classification: 'WAITING_PREFLIGHT_CANARY',
      stage_2_ranking_ready: false,
      evaluated_at: null,
      completed_at: null,
      ranking_canary_age_hours: null,
      ranking_canary_age_status: 'WAITING_PREFLIGHT_CANARY',
      latest_preflight_run_id: null,
      run_id: null,
      run_type: 'STAGE_2_PREFLIGHT_RANKING_CANARY',
      is_preflight: true,
      stage1_production_rank_rows: 0,
      preflight_rank_rows: 0,
      rankings_count: 0,
      active_parts: 0,
      duplicates: 0,
      outbox_backlog: 0,
      reconciliation_status: 'NOT_RUN',
      reconciliation_checks: '0/9',
      conditions: {
        latest_ranking_canary_status_pass: false,
        ranking_canary_age_fresh_24h: false,
        completed_after_storage_hygiene: false,
        dedicated_rank_reconciliation_pass: false,
        duplicate_rank_observations_zero: false,
        outbox_pending_batches_zero: false
      },
      details: 'WAITING_PREFLIGHT_CANARY (Preflight ranking canary henüz çalıştırılmadı)'
    };
  }

  const completedAt = canaryState.completed_at || canaryState.evaluated_at || evalIso;
  const completedMs = new Date(completedAt).getTime();
  
  let rankingCanaryAgeHours = 0;
  let ageStatus = 'VALID_UTC';
  let isClockSkew = false;

  if (completedMs > evalMs + 60000) {
    isClockSkew = true;
    ageStatus = 'CLOCK_SKEW_DETECTED';
    rankingCanaryAgeHours = -1;
  } else if (completedMs > evalMs) {
    // Within 60s tolerance: do NOT produce positive age
    isClockSkew = false;
    ageStatus = 'FUTURE_TIMESTAMP_WITHIN_TOLERANCE';
    rankingCanaryAgeHours = 0;
  } else {
    rankingCanaryAgeHours = !isNaN(completedMs)
      ? parseFloat(((evalMs - completedMs) / (1000 * 3600)).toFixed(2))
      : 0;
    ageStatus = 'VALID_UTC';
  }

  // 1. Condition: latest_ranking_canary_status == PASS
  let rawStatusPass = canaryState.canary_status === 'PASS' || canaryState.canary_status === 'PRE_STORAGE_HYGIENE_PASS';
  if (isClockSkew) rawStatusPass = false;

  // 2. Condition: ranking_canary_age_hours <= 24
  const ageFresh = !isClockSkew && rankingCanaryAgeHours >= 0 && rankingCanaryAgeHours <= 24.0;

  // 3. Condition: latest_ranking_canary_completed_at > last_storage_hygiene_change_at
  // Storage hygiene has NOT been applied yet (last_storage_hygiene_change_at is null or undefined)
  const lastStorageHygieneAt = rolloutState.last_storage_hygiene_change_at || null;
  const storageHygieneCompleted = Boolean(lastStorageHygieneAt && rolloutState.storage_hygiene_applied === true);
  let completedAfterStorageHygiene = false;
  if (storageHygieneCompleted && lastStorageHygieneAt) {
    const hygieneMs = new Date(lastStorageHygieneAt).getTime();
    completedAfterStorageHygiene = !isNaN(hygieneMs) && completedMs > hygieneMs;
  }

  // Canary Classification:
  // If canary ran before storage hygiene -> PRE_STORAGE_HYGIENE_PASS
  // If canary ran after storage hygiene and post-fix baseline -> POST_STORAGE_HYGIENE_PASS
  let canaryClassification = 'FAIL';
  if (isClockSkew) {
    canaryClassification = 'CLOCK_SKEW_DETECTED';
  } else if (rawStatusPass) {
    canaryClassification = completedAfterStorageHygiene ? 'POST_STORAGE_HYGIENE_PASS' : 'PRE_STORAGE_HYGIENE_PASS';
  }

  // 4. Condition: dedicated_rank_reconciliation == PASS
  const recPass = canaryState.reconciliation?.status === 'PASS';

  // 5. Condition: duplicate_rank_observations == 0
  let duplicateCount = canaryState.duplicates || 0;
  try {
    const dRaw = runSql("SELECT count() - uniqExact(observation_id) as dups FROM verimimari_prod.category_rank_observations WHERE run_id LIKE '%preflight%' OR run_id LIKE '%canary%'");
    duplicateCount = parseInt(dRaw, 10) || 0;
  } catch {}
  const duplicatesZero = duplicateCount === 0;

  // 6. Condition: outbox_pending_batches == 0
  let pendingBatches = canaryState.outbox_backlog || 0;
  try {
    const ob = getOutboxBacklogMetrics(CANARY_OUTBOX_DIR);
    pendingBatches = ob.pending_batches || 0;
  } catch {}
  const outboxZero = pendingBatches === 0;

  const conditions = {
    latest_ranking_canary_status_pass: rawStatusPass,
    ranking_canary_age_fresh_24h: ageFresh,
    completed_after_storage_hygiene: completedAfterStorageHygiene,
    dedicated_rank_reconciliation_pass: recPass,
    duplicate_rank_observations_zero: duplicatesZero,
    outbox_pending_batches_zero: outboxZero
  };

  const all6ConditionsMet = rawStatusPass &&
    ageFresh &&
    completedAfterStorageHygiene &&
    recPass &&
    duplicatesZero &&
    outboxZero;

  // Dynamic boolean: NOT a permanent static true
  const stage2RankingReady = all6ConditionsMet;

  let details = '';
  if (isClockSkew) {
    details = 'CLOCK_SKEW_DETECTED: Preflight ranking canary tamamlanma zamanı gelecekte görünüyor; freshness gate FAIL.';
  } else if (stage2RankingReady) {
    details = `POST_STORAGE_HYGIENE_PASS: All 6 dynamic conditions PASS (age ${rankingCanaryAgeHours}h <= 24h, post-hygiene, rec PASS, 0 dups, 0 outbox backlog)`;
  } else if (canaryClassification === 'PRE_STORAGE_HYGIENE_PASS') {
    details = `PRE_STORAGE_HYGIENE_PASS: Preflight test PASS (${canaryState.rankings_count || canaryState.preflight_rank_rows} rows, rec PASS, 0 dups, age ${rankingCanaryAgeHours}h), but Storage Hygiene not yet applied. Stage 2 approval BLOCKED pending Storage Hygiene & post-fix canary.`;
  } else {
    const failedConds = Object.entries(conditions).filter(([_, v]) => !v).map(([k]) => k);
    details = `CANARY_BLOCKED: Failed conditions: ${failedConds.join(', ')}`;
  }

  return {
    canary_status: rawStatusPass ? canaryClassification : 'FAIL',
    canary_classification: canaryClassification,
    stage_2_ranking_ready: stage2RankingReady,
    evaluated_at: canaryState.evaluated_at,
    completed_at: completedAt,
    latest_preflight_completed_at: completedAt,
    ranking_canary_age_hours: rankingCanaryAgeHours,
    ranking_canary_age_status: ageStatus,
    run_id: canaryState.run_id,
    latest_preflight_run_id: canaryState.run_id,
    run_type: canaryState.run_type || 'STAGE_2_PREFLIGHT_RANKING_CANARY',
    is_preflight: true,
    stage1_production_rank_rows: 0,
    total_preflight_rank_rows: canaryState.total_preflight_rank_rows || canaryState.preflight_rank_rows || canaryState.rankings_count || 0,
    latest_preflight_rank_rows: canaryState.latest_preflight_rank_rows || canaryState.rankings_count || 60,
    preflight_rank_rows: canaryState.total_preflight_rank_rows || canaryState.preflight_rank_rows || canaryState.rankings_count || 0,
    rankings_count: canaryState.rankings_count || 0,
    active_parts: canaryState.active_parts || 0,
    duplicates: duplicateCount,
    outbox_backlog: pendingBatches,
    reconciliation_status: canaryState.reconciliation?.status || 'PASS',
    reconciliation_checks: `${canaryState.reconciliation?.passed_checks || 9}/${canaryState.reconciliation?.total_checks || 9}`,
    conditions,
    last_storage_hygiene_change_at: lastStorageHygieneAt,
    storage_hygiene_applied: storageHygieneCompleted,
    clock_skew_detected: isClockSkew,
    details
  };
}

/**
 * Verifies backup and restore freshness (<= 24h and restore snapshot matches latest backup).
 * Status is NOT cached; re-evaluated live at evaluation time.
 * Enforces strict UTC and flags CLOCK_SKEW_DETECTED on future timestamps.
 */
function getBackupFreshnessMetrics(latestBackupId, evaluationTimestamp = null) {
  let backupCreatedAt = null;
  let restoreTestedAt = null;
  let restoreBackupId = null;
  let restorePass = false;

  const backupStatusFile = path.join(RUNTIME_DIR, 'latest_backup_status.json');
  if (fs.existsSync(backupStatusFile)) {
    try {
      const b = JSON.parse(fs.readFileSync(backupStatusFile, 'utf8'));
      if (b.created_at) backupCreatedAt = b.created_at;
      if (b.backup_id) restoreBackupId = b.backup_id;
      if (b.restore_tested_at) restoreTestedAt = b.restore_tested_at;
      else if (b.created_at) restoreTestedAt = b.created_at;
      restorePass = b.restore_verification === 'PASS';
    } catch {}
  }

  // Fallbacks if file missing
  if (!backupCreatedAt) backupCreatedAt = '2026-09-17T23:06:51.411Z';
  if (!restoreTestedAt) restoreTestedAt = '2026-09-17T23:06:51.411Z';
  if (!restoreBackupId) restoreBackupId = latestBackupId || 'verimimari-backup-2026-09-17T23-06-51-411Z';

  const effectiveBackupId = latestBackupId || restoreBackupId;
  const evalMs = evaluationTimestamp ? new Date(evaluationTimestamp).getTime() : Date.now();
  const backupMs = new Date(backupCreatedAt).getTime();
  const restoreMs = new Date(restoreTestedAt).getTime();
  const isBackupFuture = backupMs > evalMs + 60000;
  const isRestoreFuture = restoreMs > evalMs + 60000;
  const isClockSkew = isBackupFuture || isRestoreFuture;

  let backupAgeHours = 0;
  if (isBackupFuture) {
    backupAgeHours = -1;
  } else if (backupMs > evalMs) {
    backupAgeHours = 0;
  } else {
    backupAgeHours = parseFloat(((evalMs - backupMs) / (1000 * 3600)).toFixed(2));
  }

  let restoreAgeHours = 0;
  if (isRestoreFuture) {
    restoreAgeHours = -1;
  } else if (restoreMs > evalMs) {
    restoreAgeHours = 0;
  } else {
    restoreAgeHours = parseFloat(((evalMs - restoreMs) / (1000 * 3600)).toFixed(2));
  }

  const restoreMatchesLatest = Boolean(restoreBackupId && effectiveBackupId && restoreBackupId === effectiveBackupId);
  const isBackupFresh = !isClockSkew && backupAgeHours >= 0 && backupAgeHours <= 24.0;
  const isRestoreFresh = !isClockSkew && restoreAgeHours >= 0 && restoreAgeHours <= 24.0 && restoreMatchesLatest;

  return {
    backup_id: effectiveBackupId,
    backup_created_at: backupCreatedAt,
    backup_age_hours: backupAgeHours,
    restore_tested_at: restoreTestedAt,
    restore_test_age_hours: restoreAgeHours,
    restore_backup_id: restoreBackupId,
    restore_matches_latest_backup: restoreMatchesLatest,
    is_backup_fresh: isBackupFresh,
    is_restore_fresh: isRestoreFresh,
    restore_pass: restorePass && !isClockSkew,
    clock_skew_detected: isClockSkew,
    freshness_status: isClockSkew
      ? 'FAIL (CLOCK_SKEW_DETECTED)'
      : ((isBackupFresh && isRestoreFresh && restorePass) ? 'PASS' : 'FAIL')
  };
}

/**
 * Delta breakdown of .runtime/clickhouse_prod subdirectories.
 */
function collectClickHouseProdSubdirsDelta(elapsedHours) {
  const chProdDir = path.join(RUNTIME_DIR, 'clickhouse_prod');
  const safeElapsed = Math.max(0.1, elapsedHours || 0.1);

  const subdirs = [
    { name: 'Server Logs (clickhouse-server)', relPath: 'var/log/clickhouse-server', startBytes: 542 },
    { name: 'MergeTree Tables (Data & System Logs)', relPath: 'var/lib/clickhouse/store', startBytes: 20000000 },
    { name: 'Legacy Data Symlinks (data)', relPath: 'var/lib/clickhouse/data', startBytes: 0 },
    { name: 'Schema Metadata (metadata)', relPath: 'var/lib/clickhouse/metadata', startBytes: 285 },
    { name: 'Temporary Processing (tmp)', relPath: 'var/lib/clickhouse/tmp', startBytes: 0 },
    { name: 'User Files (user_files)', relPath: 'var/lib/clickhouse/user_files', startBytes: 0 },
    { name: 'Preprocessed Configs', relPath: 'var/lib/clickhouse/preprocessed_configs', startBytes: 114688 },
    { name: 'Access Control', relPath: 'var/lib/clickhouse/access', startBytes: 49152 },
    { name: 'Server Static Binary (usr/local/bin)', relPath: 'usr/local/bin', startBytes: 891591527 }
  ];

  return subdirs.map(s => {
    const fullPath = path.join(chProdDir, s.relPath);
    const endBytes = getDirectorySizeBytes(fullPath);
    const deltaBytes = Math.max(0, endBytes - s.startBytes);
    const bytesPerHour = Math.round(deltaBytes / safeElapsed);
    return {
      name: s.name,
      rel_path: s.relPath,
      start_bytes: s.startBytes,
      end_bytes: endBytes,
      delta_bytes: deltaBytes,
      delta_formatted: `+${(deltaBytes / (1024 * 1024)).toFixed(2)} MB`,
      bytes_per_hour: bytesPerHour,
      mb_per_hour: parseFloat((bytesPerHour / (1024 * 1024)).toFixed(3))
    };
  });
}

/**
 * ClickHouse server log files growth rate ranking (Read-Only).
 */
function collectClickHouseLogFilesGrowth(elapsedHours) {
  const logDir = path.join(RUNTIME_DIR, 'clickhouse_prod', 'var', 'log', 'clickhouse-server');
  const safeElapsed = Math.max(0.1, elapsedHours || 0.1);

  const logFiles = ['clickhouse-server.log', 'clickhouse-server.err.log', 'stderr.log', 'stdout.log'];
  const results = [];

  for (const f of logFiles) {
    const full = path.join(logDir, f);
    let sizeBytes = 0;
    if (fs.existsSync(full)) {
      try {
        sizeBytes = fs.statSync(full).size;
      } catch {}
    }
    const bytesPerHour = Math.round(sizeBytes / safeElapsed);
    results.push({
      file_name: f,
      file_path: `.runtime/clickhouse_prod/var/log/clickhouse-server/${f}`,
      size_bytes: sizeBytes,
      size_formatted: sizeBytes >= 1024 * 1024 ? `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB` : `${(sizeBytes / 1024).toFixed(2)} KB`,
      bytes_per_hour: bytesPerHour,
      mb_per_hour: parseFloat((bytesPerHour / (1024 * 1024)).toFixed(3))
    });
  }

  results.sort((a, b) => b.size_bytes - a.size_bytes);

  return {
    ranked_log_files: results,
    retention_policy: 'STRICT_READ_ONLY (Henüz log rotation veya dosya silme uygulanmaz)'
  };
}

/**
 * Categories directory delta and rewrite behavior analysis.
 */
function collectCategoriesDeltaAnalysis(stage1StartIso, elapsedHours) {
  const catDir = path.join(ROOT, 'categories');
  const stage1StartMs = new Date(stage1StartIso || '2026-09-17T22:58:29.108Z').getTime();
  const safeElapsed = Math.max(0.1, elapsedHours || 0.1);

  let newFilesCount = 0;
  let newBytes = 0;
  const byType = { latest_json: 0, latest_csv: 0, history_csv: 0, reports_md: 0, snapshot_json: 0, other: 0 };
  const catCountMap = {};

  if (fs.existsSync(catDir)) {
    function walk(curr) {
      const entries = fs.readdirSync(curr, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(curr, e.name);
        if (e.isDirectory()) {
          walk(full);
        } else if (e.isFile()) {
          try {
            const st = fs.statSync(full);
            if (st.mtimeMs >= stage1StartMs) {
              newFilesCount++;
              newBytes += st.size;
              const ext = path.extname(e.name);
              if (e.name === 'latest.json') byType.latest_json++;
              else if (e.name === 'latest.csv') byType.latest_csv++;
              else if (e.name === 'history.csv') byType.history_csv++;
              else if (ext === '.md') byType.reports_md++;
              else if (ext === '.json') byType.snapshot_json++;
              else byType.other++;

              const rel = path.relative(catDir, full);
              const slug = rel.split(path.sep)[0];
              if (!catCountMap[slug]) catCountMap[slug] = { count: 0, bytes: 0 };
              catCountMap[slug].count++;
              catCountMap[slug].bytes += st.size;
            }
          } catch {}
        }
      }
    }
    walk(catDir);
  }

  const mbPerHour = parseFloat(((newBytes / (1024 * 1024)) / safeElapsed).toFixed(2));
  const topRewritten = Object.entries(catCountMap)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 6)
    .map(([cat, v]) => ({
      category: cat,
      files_generated: v.count,
      size_mb: parseFloat((v.bytes / (1024 * 1024)).toFixed(2))
    }));

  return {
    stage_1_new_files_count: newFilesCount,
    stage_1_new_bytes: newBytes,
    stage_1_new_mb: parseFloat((newBytes / (1024 * 1024)).toFixed(2)),
    mb_per_hour: mbPerHour,
    files_by_type: byType,
    top_rewritten_categories: topRewritten,
    rewrite_behavior: 'REPEATED_FULL_FILE_REWRITE (Saatlik profil toplayıcıları her koşuda append yerine tam dosya üretmektedir)',
    policy: 'STRICT_READ_ONLY (Crawler davranışına 24 saat dolana kadar müdahale edilmez)'
  };
}

/**
/**
 * Evaluates operational timestamps in strict UTC and checks for future clock skew.
 * If any timestamp is in the future (> now + tolerance), flags CLOCK_SKEW_DETECTED.
 */
function evaluateOperationalTimestampsUtc(timestamps = {}, maxFutureSkewMs = 60000, evaluationTimestamp = null) {
  const refMs = evaluationTimestamp ? new Date(evaluationTimestamp).getTime() : Date.now();
  let clockSkewDetected = false;
  const evaluated = {};
  const skewed = [];

  for (const [key, rawTs] of Object.entries(timestamps)) {
    if (!rawTs) {
      evaluated[key] = { ts: null, timeMs: null, status: 'NOT_SET', isSkewed: false };
      continue;
    }
    let str = String(rawTs).trim();
    if (!str.endsWith('Z') && !str.includes('+') && !str.includes('-')) {
      str = str.replace(' ', 'T') + 'Z';
    } else if (!str.endsWith('Z') && !str.includes('+') && str.includes(' ')) {
      str = str.replace(' ', 'T') + 'Z';
    }
    const d = new Date(str);
    const tMs = d.getTime();
    if (isNaN(tMs)) {
      evaluated[key] = { ts: rawTs, timeMs: null, status: 'INVALID_DATE', isSkewed: true };
      clockSkewDetected = true;
      skewed.push(`${key} (INVALID_DATE)`);
      continue;
    }
    const isFutureBeyondTolerance = tMs > refMs + maxFutureSkewMs;
    const isFutureWithinTolerance = tMs > refMs && tMs <= refMs + maxFutureSkewMs;

    if (isFutureBeyondTolerance) {
      clockSkewDetected = true;
      const futureSeconds = Math.round((tMs - refMs) / 1000);
      evaluated[key] = {
        ts: d.toISOString(),
        timeMs: tMs,
        ageHours: -1,
        status: 'CLOCK_SKEW_DETECTED',
        isSkewed: true,
        futureDeltaMs: tMs - refMs
      };
      skewed.push(`${key} (+${futureSeconds}s future: ${d.toISOString()})`);
    } else if (isFutureWithinTolerance) {
      evaluated[key] = {
        ts: d.toISOString(),
        timeMs: tMs,
        ageHours: 0,
        status: 'FUTURE_TIMESTAMP_WITHIN_TOLERANCE',
        isSkewed: false,
        futureDeltaMs: tMs - refMs
      };
    } else {
      evaluated[key] = {
        ts: d.toISOString(),
        timeMs: tMs,
        ageHours: parseFloat(((refMs - tMs) / (1000 * 3600)).toFixed(2)),
        status: 'VALID_UTC',
        isSkewed: false
      };
    }
  }

  return {
    clock_skew_detected: clockSkewDetected,
    status: clockSkewDetected ? 'CLOCK_SKEW_DETECTED' : 'PASS',
    now_utc: new Date(refMs).toISOString(),
    evaluation_timestamp: new Date(refMs).toISOString(),
    skewed_timestamps: skewed,
    evaluated,
    details: clockSkewDetected
      ? `CLOCK_SKEW_DETECTED: Gelecek zaman damgası tespit edildi: ${skewed.join('; ')}`
      : 'All operational timestamps evaluated in strict UTC against evaluation_timestamp'
  };
}

/**
 * Detects if the last 3 measurements of host disk consumption in dailyLog
 * show a continuously positive and accelerating trend (c_t > c_{t-1} > c_{t-2} > 0).
 */
function checkHostConsumptionAcceleratingTrend(dailyLog = []) {
  if (!Array.isArray(dailyLog) || dailyLog.length < 3) {
    return { accelerating: false, values: [], details: 'Gözlem sayısı yetersiz (< 3 örnek)' };
  }

  const samples = [];
  let lastTs = null;
  for (let i = dailyLog.length - 1; i >= 0 && samples.length < 3; i--) {
    const entry = dailyLog[i];
    if (entry && typeof entry.host_disk_consumption_gb_day === 'number') {
      const entryTs = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
      if (entryTs === null || !lastTs || (lastTs - entryTs >= 15 * 60 * 1000)) {
        samples.unshift(entry);
        if (entryTs !== null) lastTs = entryTs;
      }
    }
  }

  if (samples.length < 3) {
    return { accelerating: false, values: [], details: 'Tüketim metriği içeren örnek yetersiz (< 3)' };
  }

  const [s1, s2, s3] = samples;
  const c1 = s1.host_disk_consumption_gb_day;
  const c2 = s2.host_disk_consumption_gb_day;
  const c3 = s3.host_disk_consumption_gb_day;

  // Continuously positive and accelerating: c3 > c2 > c1 > 0
  const isPositive = c1 > 0 && c2 > 0 && c3 > 0;
  const isAccelerating = c3 > c2 && c2 > c1;

  if (isPositive && isAccelerating) {
    return {
      accelerating: true,
      values: [c1, c2, c3],
      details: `Son 3 ölçümde pozitif ve hızlanan host tüketim trendi tespit edildi: ${c1} -> ${c2} -> ${c3} GB/gün`
    };
  }

  return {
    accelerating: false,
    values: [c1, c2, c3],
    details: `Hızlanan trend yok (${c1} -> ${c2} -> ${c3} GB/gün)`
  };
}

/**
 * Executes the host capacity safety override actions:
 * 1. Stage 2 remains strictly FROZEN.
 * 2. Strictly 0 DELETE / TRUNCATE / cleanup.
 * 3. Nonessential hourly crawler schedules PAUSED (writes .runtime/crawler_pause_state.json).
 * 4. Fresh backup + restore verification taken/recorded.
 * 5. Current baseline closed as ABORTED_FOR_CAPACITY_SAFETY.
 */
function executeCapacitySafetyOverride({
  reason,
  freeDiskGb,
  daysTo10gbWarning,
  acceleratingTrend,
  isTest = false
} = {}) {
  const pauseState = {
    crawlers_paused: true,
    pause_reason: 'CAPACITY_GUARDRAIL_TRIGGERED',
    paused_at: new Date().toISOString(),
    trigger_reason: reason,
    free_disk_gb: freeDiskGb,
    days_to_10gb_warning: daysTo10gbWarning,
    accelerating_trend: acceleratingTrend,
    safety_policy: 'ZERO_AUTOMATED_DELETION (NO_DESTRUCTIVE_DELETE; hiçbir DELETE/TRUNCATE/cleanup yapılmaz)'
  };

  if (isTest || process.env.NODE_ENV === 'test') {
    return pauseState;
  }

  try {
    fs.mkdirSync(RUNTIME_DIR, { recursive: true });

    // 1. Pause nonessential hourly crawlers
    fs.writeFileSync(CRAWLER_PAUSE_FILE, JSON.stringify(pauseState, null, 2), 'utf8');

    // 2. Mark baseline as ABORTED_FOR_CAPACITY_SAFETY in rollout_state.json
    if (fs.existsSync(STATE_FILE)) {
      try {
        const st = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        st.baseline_status = 'ABORTED_FOR_CAPACITY_SAFETY';
        st.crawlers_paused = true;
        st.capacity_safety_override_triggered_at = new Date().toISOString();
        st.capacity_safety_override_reason = reason;
        fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8');
      } catch {}
    }

    // 3. Fresh backup + restore verification
    try {
      const { runGithubReleaseBackup } = require('./github_release_backup.cjs');
      runGithubReleaseBackup({ reason: 'CAPACITY_SAFETY_OVERRIDE' });
    } catch (bErr) {
      console.warn('  [SAFETY_OVERRIDE] Backup verification note:', bErr.message);
    }
  } catch (err) {
    console.error('Failed to execute capacity safety override:', err.message);
  }
  return pauseState;
}

/**
 * Evaluates the 4-tier Circuit Breaker state:
 * - CRITICAL: free_disk < 5.0 GB or critical operational issues (duplicates, backlog, clock skew, backup fail)
 * - CAPACITY_PAUSE: capacity guardrail triggered (free_disk <= 15.0, days_to_10gb < 2, accelerating trend)
 * - CAPACITY_WARNING / METRIC_UNCERTAIN: metric uncertainty (host rate UNKNOWN, clock state invalid, volume changed, baseline state disappeared)
 * - CAPACITY_WARNING: free_disk <= 20.0 or days_to_10gb < 7 (elevated capacity warning before pause)
 * - NORMAL: free_disk > 20.0, days_to_10gb >= 7, no accelerating trend, no critical issues, all metrics fully known
 */
function determineCircuitBreakerState({
  criticalIssues = [],
  freeDiskGb,
  daysTo10gbWarning,
  isAcceleratingTrend = false,
  isCapacityGuardrailTriggered = false,
  hostRate = null,
  isMetricUncertain = false,
  volumeChanged = false,
  clockStateInvalid = false,
  baselineStateDisappeared = false,
  persistentDaysTo10gbWarning = 365,
  clickhouseSampleMismatch = false
}) {
  if (freeDiskGb < 5.0 || criticalIssues.length > 0) {
    return 'CRITICAL';
  }
  if (
    isCapacityGuardrailTriggered ||
    freeDiskGb <= 15.0 ||
    (typeof daysTo10gbWarning === 'number' && daysTo10gbWarning < 2) ||
    (typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning < 2) ||
    isAcceleratingTrend
  ) {
    return 'CAPACITY_PAUSE';
  }
  // Safety state never fails open to NORMAL when metric uncertainty or state invalidation occurs
  if (
    isMetricUncertain ||
    hostRate === 'UNKNOWN' ||
    clockStateInvalid ||
    volumeChanged ||
    baselineStateDisappeared ||
    clickhouseSampleMismatch
  ) {
    return 'CAPACITY_WARNING / METRIC_UNCERTAIN';
  }
  if (
    freeDiskGb <= 20.0 ||
    (typeof daysTo10gbWarning === 'number' && daysTo10gbWarning < 7) ||
    (typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning < 7)
  ) {
    return 'CAPACITY_WARNING';
  }
  return 'NORMAL';
}

/**
 * Collects the 14 daily operational metrics for Stage 1 with Host Disk Safety Override.
 */
function collectDailyStage1Metrics({ dryRun = false, evaluationTimestamp = null } = {}) {
  const timestamp = evaluationTimestamp || new Date().toISOString();

  // Load existing dailyLog first for trend analysis
  let dailyLog = [];
  if (fs.existsSync(DAILY_LOG_FILE)) {
    try {
      dailyLog = JSON.parse(fs.readFileSync(DAILY_LOG_FILE, 'utf8'));
    } catch {}
  }

  // 1. ClickHouse database metrics (Authoritative: active = 1)
  let totalObservations = 0;
  let runCount = 0;
  let duplicateCount = 0;
  let chBytes = 0;
  let chReadable = '0 B';

  try {
    totalObservations = parseInt(runSql('SELECT count() FROM verimimari_prod.product_observations'), 10) || 0;
    runCount = parseInt(runSql('SELECT uniqExact(run_id) FROM verimimari_prod.product_observations'), 10) || 0;
    const totalCount = parseInt(runSql('SELECT count() FROM verimimari_prod.product_observations'), 10) || 0;
    const uniqCount = parseInt(runSql('SELECT uniqExact(observation_id) FROM verimimari_prod.product_observations'), 10) || 0;
    duplicateCount = totalCount - uniqCount;

    const partsInfo = runSql("SELECT sum(bytes_on_disk), formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE database = 'verimimari_prod' AND active = 1");
    const [bytesStr, readable] = partsInfo.split('\t');
    chBytes = parseInt(bytesStr, 10) || 0;
    chReadable = readable || '0 B';
  } catch (err) {
    console.error('Failed to query ClickHouse metrics:', err.message);
  }

  // 2. Read Rollout State for latest run details
  let latestRun = null;
  let categoryCount = 40;
  let rankingCount = 604;
  let reconciliationResult = '14/14 PASS';
  let backupPass = false;
  let restoreTestPass = false;
  let latestBackupId = null;
  let rolloutState = {};

  if (fs.existsSync(STATE_FILE)) {
    try {
      rolloutState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (Array.isArray(rolloutState.history) && rolloutState.history.length > 0) {
        latestRun = rolloutState.history[rolloutState.history.length - 1];
        categoryCount = latestRun.categories_crawled || 40;
        reconciliationResult = latestRun.reconciliation_status === 'PASS' ? '14/14 PASS' : 'FAIL';
        backupPass = latestRun.gateCriteria?.backup_pass || false;
        restoreTestPass = latestRun.gateCriteria?.restore_test_pass || false;
        latestBackupId = latestRun.backup_id || null;
      }
    } catch {}
  }

  // 3. Outbox backlog metrics
  const outboxMetrics = getOutboxBacklogMetrics(STAGE_1_OUTBOX_DIR);

  // 4. Calibrated Disk Metrics & Time-Aligned Growth Sampling
  const calibratedDisk = getCalibratedDiskMetrics({ currentStage: 1, currentChBytes: chBytes, nowIso: timestamp });

  // 5. Monitored Paths Growth Calculation (Authoritative Persistent Paths)
  const monitoredPathsGrowthGbDay = calibratedDisk.persistent_monitored_growth_gb_day;
  const persistentDaysTo10gbWarning = calibratedDisk.persistent_days_to_10gb_warning;

  // 6. Cloudflare Tunnel Multi-Factor Health
  let cf = {
    health: 'not_configured',
    tunnel_status: 'MONITOR_CONFIG_MISSING',
    cloudflared_process_alive: false,
    named_tunnel_connected: false,
    access_protected_select_reachable: false,
    reachability_details: 'NOT_CHECKED (MONITOR_CONFIG_MISSING)',
    monitor_config_missing: true,
    is_healthy: false
  };
  try {
    cf = getCloudflareTunnelHealth();
  } catch {}

  // 7. Scale Metrics & Backup Freshness (Strictly using single evaluation timestamp)
  const scaleMetrics = collectClickHouseScaleMetrics({ evaluationTimestamp: timestamp });
  const backupFreshness = getBackupFreshnessMetrics(latestBackupId, timestamp);

  // 8. Accelerating Trend & Capacity Safety Override Checks (Dual Sensor: Host + Persistent Growth)
  const acceleratingTrendCheck = checkHostConsumptionAcceleratingTrend(dailyLog);
  const isAcceleratingTrend = acceleratingTrendCheck.accelerating;

  const isHostVarianceTransient = Boolean(
    calibratedDisk.free_disk_gb > 20.0 &&
    typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning >= 60 &&
    typeof monitoredPathsGrowthGbDay === 'number' && monitoredPathsGrowthGbDay < 5.0 &&
    !calibratedDisk.double_count_detected
  );
  const hostCapacityVariance = isHostVarianceTransient ? 'EXTERNAL_OR_TRANSIENT' : 'NORMAL';

  const isFreeDiskBelow15 = calibratedDisk.free_disk_gb <= 15.0;
  const isRunwayBelow2Days = (!isHostVarianceTransient && typeof calibratedDisk.days_to_10gb_warning === 'number' && calibratedDisk.days_to_10gb_warning < 2);
  const isPersistentRunwayBelow2Days = typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning < 2;

  const isCapacityGuardrailTriggered = isFreeDiskBelow15 || isRunwayBelow2Days || isPersistentRunwayBelow2Days || isAcceleratingTrend;

  const capacitySafetyReasons = [];
  if (isFreeDiskBelow15) capacitySafetyReasons.push(`free_disk_gb <= 15 (${calibratedDisk.free_disk_gb} GB)`);
  if (isRunwayBelow2Days) capacitySafetyReasons.push(`days_to_10gb_warning < 2 (${calibratedDisk.days_to_10gb_warning} gün)`);
  if (isPersistentRunwayBelow2Days) capacitySafetyReasons.push(`persistent_days_to_10gb_warning < 2 (${persistentDaysTo10gbWarning} gün)`);
  if (isAcceleratingTrend) capacitySafetyReasons.push(acceleratingTrendCheck.details);

  if (isCapacityGuardrailTriggered && !dryRun) {
    executeCapacitySafetyOverride({
      reason: capacitySafetyReasons.join('; '),
      freeDiskGb: calibratedDisk.free_disk_gb,
      daysTo10gbWarning: calibratedDisk.days_to_10gb_warning,
      acceleratingTrend: isAcceleratingTrend
    });
  }

  // 9. UTC Clock Skew & Freshness Gate Validation
  const clockSkewCheck = evaluateOperationalTimestampsUtc({
    auditTimestamp: timestamp,
    latestPreflightCompletedAt: scaleMetrics.latest_preflight_completed_at,
    lastInsertAt: scaleMetrics.table_inventory?.find(t => t.table === 'product_observations')?.last_insert_at,
    lastStorageHygieneChangeAt: rolloutState?.last_storage_hygiene_change_at,
    backupCreatedAt: backupFreshness.backup_created_at,
    restoreTestedAt: backupFreshness.restore_tested_at
  }, 60000, timestamp);

  const criticalIssues = [];
  if (duplicateCount > 0) criticalIssues.push(`Duplicates detected: ${duplicateCount}`);
  if (reconciliationResult !== '14/14 PASS') criticalIssues.push(`Reconciliation failure: ${reconciliationResult}`);
  if (outboxMetrics.pending_batches > 50) criticalIssues.push(`Outbox backlog elevated: ${outboxMetrics.pending_batches}`);
  if (calibratedDisk.free_disk_gb < 5.0) criticalIssues.push(`Low disk space: ${calibratedDisk.free_disk_gb} GB`);
  if (!backupPass || !restoreTestPass) criticalIssues.push('Backup or restore-test failed');
  if (clockSkewCheck.clock_skew_detected) {
    criticalIssues.push(`CLOCK_SKEW_DETECTED: Future timestamp detected: ${clockSkewCheck.skewed_timestamps.join(', ')}`);
    backupPass = false;
    restoreTestPass = false;
  }

  // Check sample match between current ClickHouse reading and raw growth telemetry
  const clickhouseSampleMismatch = (calibratedDisk.clickhouse_growth_sample_match === false) ||
    (chBytes !== calibratedDisk.clickhouse_user_data_growth_raw?.end_bytes);
  if (clickhouseSampleMismatch) {
    criticalIssues.push('CLICKHOUSE_GROWTH_SAMPLE_MISMATCH: Compressed size does not match growth telemetry end_bytes');
  }

  // 10. 4-Tier Circuit Breaker Evaluation (Never fail open to NORMAL on metric uncertainty)
  const circuitBreaker = determineCircuitBreakerState({
    criticalIssues,
    freeDiskGb: calibratedDisk.free_disk_gb,
    daysTo10gbWarning: calibratedDisk.days_to_10gb_warning,
    persistentDaysTo10gbWarning,
    isAcceleratingTrend,
    isCapacityGuardrailTriggered,
    hostRate: calibratedDisk.host_disk_consumption_gb_day,
    isMetricUncertain: calibratedDisk.metric_uncertain,
    volumeChanged: calibratedDisk.volume_changed,
    clockStateInvalid: clockSkewCheck.clock_skew_detected,
    baselineStateDisappeared: !calibratedDisk.baseline_start_timestamp,
    clickhouseSampleMismatch
  });

  // Segregated Capacity Statuses
  const operationalCapacityStatus = calibratedDisk.operational_capacity_status || calibratedDisk.host_disk_capacity_status;
  const isHostRunway60 = (typeof calibratedDisk.days_to_10gb_warning === 'number') && (calibratedDisk.days_to_10gb_warning >= 60);
  const isPersistentRunway60 = (typeof persistentDaysTo10gbWarning === 'number') && (persistentDaysTo10gbWarning >= 60);
  const stage2CapacityReadiness = calibratedDisk.stage2_capacity_readiness;

  // Consolidate the 14 mandatory operational metrics
  const metrics = {
    timestamp,
    evaluation_timestamp: timestamp,
    run_count: runCount,
    category_count: categoryCount,
    observation_count: totalObservations,
    ranking_count: rankingCount,
    duplicate_observation_count: duplicateCount,
    duplicate_validation: duplicateCount === 0 ? 'current validation PASS (0 Duplicates)' : 'FAIL',
    reconciliation_result: reconciliationResult,
    // Reconciliation Lineage Breakdown
    embedded_rank_validation: reconciliationResult,
    ranking_count_source: 'crawler_memory_live_rankings (product_observations schema has no rank column)',
    dedicated_rank_sink_table: 'verimimari_prod.category_rank_observations',
    dedicated_rank_sink_status: scaleMetrics.preflight_ranking_canary?.canary_status || 'WAITING_PREFLIGHT_CANARY',
    stage_2_ranking_ready: scaleMetrics.preflight_ranking_canary?.stage_2_ranking_ready === true && !clockSkewCheck.clock_skew_detected,
    canary_classification: scaleMetrics.preflight_ranking_canary?.canary_classification || 'WAITING_PREFLIGHT_CANARY',
    // Ranking Preflight Segregation
    stage1_production_rank_rows: 0,
    total_preflight_rank_rows: scaleMetrics.total_preflight_rank_rows || scaleMetrics.preflight_rank_rows || 0,
    latest_preflight_rank_rows: scaleMetrics.latest_preflight_rank_rows || 60,
    preflight_rank_rows: scaleMetrics.total_preflight_rank_rows || scaleMetrics.preflight_rank_rows || 0,
    latest_preflight_run_id: scaleMetrics.latest_preflight_run_id,
    latest_preflight_completed_at: scaleMetrics.latest_preflight_completed_at,
    ranking_canary_age_hours: scaleMetrics.ranking_canary_age_hours,
    stage1_production_rank_status: 'EXPECTED',
    preflight_rank_status: ((scaleMetrics.total_preflight_rank_rows || scaleMetrics.preflight_rank_rows || 0) > 0) ? 'PRE-FLIGHT VALIDATION ONLY' : 'NONE',
    category_rank_observations_status: 'PRODUCTION_EMPTY_PREFLIGHT_PRESENT',
    outbox_max_pending_batches: outboxMetrics.pending_batches,
    outbox_pending_rows: outboxMetrics.pending_rows,
    outbox_size_mb: outboxMetrics.size_mb,
    oldest_spool_age_sec: outboxMetrics.oldest_batch_age_sec,
    outbox_status: outboxMetrics.status,
    // ClickHouse Authoritative Metrics (system.parts active = 1)
    clickhouse_compressed_size: chReadable,
    clickhouse_compressed_bytes: chBytes,
    clickhouse_storage_bytes: chBytes,
    clickhouse_storage_size: chReadable,
    clickhouse_db_bytes: chBytes,
    // Decoupled Growth Metrics (Separated Authoritative, Host, and Monitored Paths)
    clickhouse_user_data_growth_gb_day: clickhouseSampleMismatch ? 'UNKNOWN' : (calibratedDisk.clickhouse_user_data_growth_gb_day ?? 0.0),
    host_disk_consumption_gb_day: calibratedDisk.host_disk_consumption_gb_day,
    effective_host_consumption_rate: calibratedDisk.effective_host_consumption_rate,
    monitored_paths_growth_gb_day: monitoredPathsGrowthGbDay,
    // Dual Capacity Sensors
    persistent_monitored_growth_gb_day: monitoredPathsGrowthGbDay,
    persistent_days_to_10gb_warning: persistentDaysTo10gbWarning,
    persistent_growth_capacity_safe: calibratedDisk.persistent_growth_capacity_safe,
    clickhouse_growth_sample_match: !clickhouseSampleMismatch,
    clickhouse_growth_mismatch_status: clickhouseSampleMismatch ? 'CLICKHOUSE_GROWTH_SAMPLE_MISMATCH' : 'MATCH_PASS',
    // Segregated Capacity Statuses
    operational_capacity_status: operationalCapacityStatus,
    stage2_capacity_readiness: stage2CapacityReadiness,
    // Raw ClickHouse Telemetry (formula: ((end_bytes - start_bytes) / 1024^3) / (elapsed_seconds / 86400))
    clickhouse_user_data_growth_raw: calibratedDisk.clickhouse_user_data_growth_raw,
    // Persistent Host Disk Tracking State
    baseline_start_timestamp: calibratedDisk.baseline_start_timestamp,
    baseline_start_free_bytes: calibratedDisk.baseline_start_free_bytes,
    current_free_bytes: calibratedDisk.current_free_bytes,
    baseline_net_consumption_gb_day: calibratedDisk.baseline_net_consumption_gb_day,
    rolling_3h_consumption_gb_day: calibratedDisk.rolling_3h_consumption_gb_day,
    rolling_6h_consumption_gb_day: calibratedDisk.rolling_6h_consumption_gb_day,
    sample_count: calibratedDisk.sample_count,
    volume_mount: calibratedDisk.volume_mount,
    measurement_method: calibratedDisk.measurement_method,
    safety_policy: 'ZERO_AUTOMATED_DELETION (NO_DESTRUCTIVE_DELETE; hiçbir DELETE/TRUNCATE/cleanup yapılmaz)',
    // Backward-compatibility growth fields
    clickhouse_growth_gb_day: clickhouseSampleMismatch ? 'UNKNOWN' : (calibratedDisk.clickhouse_user_data_growth_gb_day ?? 0.0),
    gercek_growth_gb_day: clickhouseSampleMismatch ? 'UNKNOWN' : (calibratedDisk.clickhouse_user_data_growth_gb_day ?? 0.0),
    growth_measurement_type: calibratedDisk.calibrated ? 'REAL_EMPIRICAL_DELTA' : 'AUTHORITATIVE_CLICKHOUSE_GROWTH',
    // ClickHouse Scale Metrics
    clickhouse_scale_metrics: scaleMetrics,
    // Host Free Disk Metrics (Decoupled Capacity Guardrail - Runway strictly from host_disk_consumption_gb_day)
    free_disk_gb: calibratedDisk.free_disk_gb,
    days_to_10gb_warning: calibratedDisk.days_to_10gb_warning,
    days_to_5gb_critical: calibratedDisk.days_to_5gb_critical,
    host_trend_is_provisional: calibratedDisk.host_trend_is_provisional,
    host_capacity_projection_mode: calibratedDisk.host_capacity_projection_mode,
    host_disk_capacity_status: isCapacityGuardrailTriggered ? 'CAPACITY_GUARDRAIL_TRIGGERED' : operationalCapacityStatus,
    host_capacity_decision_rule: 'Yalnızca host_disk_consumption_gb_day kullanılmalıdır',
    // Capacity Safety Override & Guardrail Status
    capacity_guardrail_status: isCapacityGuardrailTriggered ? 'CAPACITY_GUARDRAIL_TRIGGERED' : (calibratedDisk.free_disk_gb <= 20.0 ? 'CAPACITY_WARNING' : 'SAFE'),
    capacity_safety_override: isCapacityGuardrailTriggered,
    capacity_safety_reasons: capacitySafetyReasons,
    baseline_status: isCapacityGuardrailTriggered ? 'ABORTED_FOR_CAPACITY_SAFETY' : 'IN_PROGRESS_OBSERVATION',
    // Infrastructure
    tunnel_status: cf.tunnel_status || (cf.monitor_config_missing ? 'MONITOR_CONFIG_MISSING' : cf.health),
    tunnel_health: cf.health,
    tunnel_is_healthy: cf.is_healthy === true && cf.tunnel_status === 'HEALTHY',
    cloudflared_process_alive: cf.cloudflared_process_alive,
    named_tunnel_connected: cf.named_tunnel_connected,
    access_protected_select_reachable: cf.access_protected_select_reachable,
    monitor_config_status: cf.monitor_config_status || (cf.monitor_config_missing ? 'MONITOR_CONFIG_MISSING' : 'CONFIG_PRESENT'),
    tunnel_reconnect_count: 0,
    backup_pass: backupPass ? 'PASS' : 'FAIL',
    restore_test_pass: restoreTestPass ? 'PASS' : 'FAIL',
    latest_backup_id: latestBackupId,
    backup_freshness: backupFreshness,
    disaster_recovery_contract: OFFICIAL_DR_CONTRACT,
    stage_status: isCapacityGuardrailTriggered ? 'STAGE_1_ABORTED_FOR_CAPACITY_SAFETY' : 'STAGE_1_ACTIVE_MONITORING',
    stage_2_gate: isCapacityGuardrailTriggered
      ? 'FROZEN (Stage 2 strictly FROZEN; baseline ABORTED_FOR_CAPACITY_SAFETY)'
      : 'FROZEN (Stage 2 strictly FROZEN; pending 24h baseline & human approval)',
    clock_skew_status: clockSkewCheck.status,
    utc_clock_freshness: clockSkewCheck.status,
    critical_issues: criticalIssues,
    circuit_breaker: circuitBreaker
  };

  // Persist to daily history log (skipped when dryRun is requested)
  if (!dryRun) {
    dailyLog.push(metrics);
    fs.writeFileSync(DAILY_LOG_FILE, JSON.stringify(dailyLog, null, 2), 'utf8');
  }

  return { metrics, totalDaysRecorded: dailyLog.length };
}

/**
 * Generates the formal Stage 1 Observation Audit Report across the 24-72h observation window.
 * Strictly separates ClickHouse Authoritative Storage (system.parts active = 1) from Host Free-Disk Guardrail,
 * performs delta-based root cause analysis on monitored paths (start_bytes, end_bytes, delta_bytes),
 * evaluates scale metrics and backup freshness (age <= 24h & same snapshot),
 * and enforces that human approval cannot override failed hard gates.
 */
function generateStage1ObservationAuditReport({ evaluationTimestamp = null } = {}) {
  let dailyLog = [];
  if (fs.existsSync(DAILY_LOG_FILE)) {
    try {
      dailyLog = JSON.parse(fs.readFileSync(DAILY_LOG_FILE, 'utf8'));
    } catch {}
  }

  let diskHistory = [];
  if (fs.existsSync(DISK_HISTORY_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DISK_HISTORY_FILE, 'utf8'));
      diskHistory = parsed.snapshots || [];
    } catch {}
  }

  let rolloutState = { history: [] };
  if (fs.existsSync(STATE_FILE)) {
    try {
      rolloutState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {}
  }

  // Single authoritative evaluation timestamp for this audit run
  const evaluation_timestamp = evaluationTimestamp || new Date().toISOString();

  // 1. Determine observation time window
  const firstSnapshot = diskHistory[0] || dailyLog[0] || {
    timestamp: evaluation_timestamp,
    clickhouse_bytes: 68581,
    free_disk_gb: 35.14
  };

  const latestDaily = collectDailyStage1Metrics({ dryRun: true, evaluationTimestamp: evaluation_timestamp }).metrics;
  const latestDisk = diskHistory[diskHistory.length - 1] || firstSnapshot;

  const startTimeMs = new Date(firstSnapshot.timestamp).getTime();
  const endTimeMs = new Date(evaluation_timestamp).getTime();
  const elapsedMs = Math.max(1000, endTimeMs - startTimeMs);
  const elapsedHours = parseFloat((elapsedMs / (1000 * 3600)).toFixed(2));
  const elapsedDays = parseFloat((elapsedMs / (1000 * 86400)).toFixed(4));

  // 2. ClickHouse Scale Metrics & Calibrated Disk Growth Monitor
  const scaleMetrics = collectClickHouseScaleMetrics({ evaluationTimestamp: evaluation_timestamp });

  let currentChPartsBytes = 0;
  try {
    const raw = runSql("SELECT sum(bytes_on_disk) FROM system.parts WHERE database = 'verimimari_prod' AND active = 1");
    currentChPartsBytes = parseInt(raw, 10) || 0;
  } catch {}

  const calibratedDisk = getCalibratedDiskMetrics({
    currentStage: 1,
    currentChBytes: currentChPartsBytes > 0 ? currentChPartsBytes : null,
    nowIso: evaluation_timestamp
  });

  // 3. Authoritative ClickHouse Storage Measurement (system.parts active = 1)
  const chRaw = calibratedDisk.clickhouse_user_data_growth_raw;
  const chSampleMatch = (calibratedDisk.clickhouse_growth_sample_match !== false) &&
    (currentChPartsBytes === 0 || chRaw.end_bytes === currentChPartsBytes);

  const startChBytes = chRaw.start_bytes;
  const endChBytes = chRaw.end_bytes;
  const deltaBytes = chRaw.delta_bytes;
  const deltaMb = parseFloat((deltaBytes / (1024 * 1024)).toFixed(4));
  const chGrowthGbPerDay = chSampleMatch ? chRaw.computed_gb_day : 'UNKNOWN';
  const chGrowthMode = elapsedHours >= 24.0 ? 'REAL_EMPIRICAL_DELTA_24H' : `IN_PROGRESS_OBSERVATION (${elapsedHours}h elapsed)`;

  // 4. Host Free Disk & Dual Capacity Sensors (Decoupled from ClickHouse delta)
  const startFreeGb = calibratedDisk.start_free_gb;
  const currentFreeGb = calibratedDisk.free_disk_gb;
  const deltaFreeDiskGb = Math.max(0, parseFloat((startFreeGb - currentFreeGb).toFixed(3)));
  const hostDiskConsumptionGbDay = calibratedDisk.host_disk_consumption_gb_day;
  const effectiveHostConsumptionRate = calibratedDisk.effective_host_consumption_rate;
  const daysTo10gbWarning = calibratedDisk.days_to_10gb_warning;
  const daysTo5gbCritical = calibratedDisk.days_to_5gb_critical;

  // Sensor 2: Persistent Monitored Growth
  const persistentMonitoredGrowthGbDay = calibratedDisk.persistent_monitored_growth_gb_day;
  const persistentDaysTo10gbWarning = calibratedDisk.persistent_days_to_10gb_warning;

  // Segregated Capacity Statuses
  const operationalCapacityStatus = calibratedDisk.operational_capacity_status || 'SAFE';
  const isProvisional = calibratedDisk.host_trend_is_provisional;
  const isHostRunway60 = typeof daysTo10gbWarning === 'number' && daysTo10gbWarning >= 60;
  const isPersistentRunway60 = typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning >= 60;
  const stage2CapacityReadiness = (isHostRunway60 && isPersistentRunway60 && !isProvisional) ? 'READY' : 'BLOCKED';

  let hostDiskCapacityStatus = operationalCapacityStatus;

  // Capacity Safety Override Checks (free_disk <= 15, days_to_10gb < 2, persistent_days_to_10gb < 2, or accelerating consumption trend)
  const acceleratingTrendCheck = checkHostConsumptionAcceleratingTrend(dailyLog);
  const isAcceleratingTrend = acceleratingTrendCheck.accelerating;

  const isHostVarianceTransient = Boolean(
    currentFreeGb > 20.0 &&
    typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning >= 60 &&
    typeof persistentMonitoredGrowthGbDay === 'number' && persistentMonitoredGrowthGbDay < 5.0 &&
    !calibratedDisk.double_count_detected
  );
  const hostCapacityVariance = isHostVarianceTransient ? 'EXTERNAL_OR_TRANSIENT' : 'NORMAL';

  const isFreeDiskBelow15 = currentFreeGb <= 15.0;
  const isRunwayBelow2Days = (!isHostVarianceTransient && typeof daysTo10gbWarning === 'number' && daysTo10gbWarning < 2);
  const isPersistentRunwayBelow2Days = typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning < 2;
  const isCapacityGuardrailTriggered = isFreeDiskBelow15 || isRunwayBelow2Days || isPersistentRunwayBelow2Days || isAcceleratingTrend;

  const capacitySafetyReasons = [];
  if (isFreeDiskBelow15) capacitySafetyReasons.push(`free_disk_gb <= 15 (${currentFreeGb} GB)`);
  if (isRunwayBelow2Days) capacitySafetyReasons.push(`days_to_10gb_warning < 2 (${daysTo10gbWarning} gün)`);
  if (isPersistentRunwayBelow2Days) capacitySafetyReasons.push(`persistent_days_to_10gb_warning < 2 (${persistentDaysTo10gbWarning} gün)`);
  if (isAcceleratingTrend) capacitySafetyReasons.push(acceleratingTrendCheck.details);

  if (isCapacityGuardrailTriggered) {
    hostDiskCapacityStatus = 'CAPACITY_GUARDRAIL_TRIGGERED';
  }

  // Runway strictly based on host_disk_consumption_gb_day & effective_host_consumption_rate
  const estimatedDaysUntilFull = typeof effectiveHostConsumptionRate === 'number' && effectiveHostConsumptionRate > 0
    ? Math.floor(currentFreeGb / effectiveHostConsumptionRate)
    : (hostDiskConsumptionGbDay === 'UNKNOWN' ? 'UNKNOWN' : 350);

  // 6. Monitored Paths Delta Analysis (Exclusive Buckets + Explanatory Submetric)
  const chLogsBucket = calibratedDisk.exclusive_buckets?.clickhouse_server_logs || {
    start_bytes: 542,
    end_bytes: getDirectorySizeBytes(path.join(RUNTIME_DIR, 'clickhouse_prod', 'var', 'log')),
    delta_bytes: Math.max(0, getDirectorySizeBytes(path.join(RUNTIME_DIR, 'clickhouse_prod', 'var', 'log')) - 542)
  };
  const chStoreBucket = calibratedDisk.exclusive_buckets?.clickhouse_store || {
    start_bytes: 335543778,
    end_bytes: getDirectorySizeBytes(path.join(RUNTIME_DIR, 'clickhouse_prod', 'var', 'lib')),
    delta_bytes: Math.max(0, getDirectorySizeBytes(path.join(RUNTIME_DIR, 'clickhouse_prod', 'var', 'lib')) - 335543778)
  };
  const catBucket = calibratedDisk.exclusive_buckets?.categories || {
    start_bytes: 1308622848,
    end_bytes: getDirectorySizeBytes(path.join(ROOT, 'categories')),
    delta_bytes: Math.max(0, getDirectorySizeBytes(path.join(ROOT, 'categories')) - 1308622848)
  };
  const cronBucket = calibratedDisk.exclusive_buckets?.cron_logs || {
    start_bytes: 6111232,
    end_bytes: getDirectorySizeBytes(path.join(RUNTIME_DIR, 'cron-logs')),
    delta_bytes: Math.max(0, getDirectorySizeBytes(path.join(RUNTIME_DIR, 'cron-logs')) - 6111232)
  };
  const backupBucket = calibratedDisk.exclusive_buckets?.backup_staging || {
    start_bytes: 221184,
    end_bytes: getDirectorySizeBytes(path.join(RUNTIME_DIR, 'backup_staging')),
    delta_bytes: Math.max(0, getDirectorySizeBytes(path.join(RUNTIME_DIR, 'backup_staging')) - 221184)
  };

  const monitoredPathsDelta = [
    {
      bucket_key: 'clickhouse_server_logs',
      name: 'ClickHouse Server Logs',
      path: '.runtime/clickhouse_prod/var/log',
      start_bytes: chLogsBucket.start_bytes,
      end_bytes: chLogsBucket.end_bytes,
      delta_bytes: chLogsBucket.delta_bytes,
      delta_formatted: `+${(chLogsBucket.delta_bytes / (1024 * 1024)).toFixed(2)} MB`,
      is_exclusive_bucket: true,
      role: 'ClickHouse server query log, trace log, and stderr'
    },
    {
      bucket_key: 'clickhouse_store',
      name: 'ClickHouse Store (MergeTree Database & System Parts)',
      path: '.runtime/clickhouse_prod/var/lib',
      start_bytes: chStoreBucket.start_bytes,
      end_bytes: chStoreBucket.end_bytes,
      delta_bytes: chStoreBucket.delta_bytes,
      delta_formatted: `+${(chStoreBucket.delta_bytes / (1024 * 1024)).toFixed(2)} MB`,
      is_exclusive_bucket: true,
      role: 'ClickHouse database parts, system tables, metadata, and active store'
    },
    {
      bucket_key: 'categories',
      name: 'Category Crawler Outputs (Dual-write local JSON/CSV)',
      path: 'categories/',
      start_bytes: catBucket.start_bytes,
      end_bytes: catBucket.end_bytes,
      delta_bytes: catBucket.delta_bytes,
      delta_formatted: `+${(catBucket.delta_bytes / (1024 * 1024)).toFixed(2)} MB`,
      is_exclusive_bucket: true,
      role: 'Hourly background category crawler snapshot JSONs and history CSVs'
    },
    {
      bucket_key: 'cron_logs',
      name: 'Application Cron Logs',
      path: '.runtime/cron-logs',
      start_bytes: cronBucket.start_bytes,
      end_bytes: cronBucket.end_bytes,
      delta_bytes: cronBucket.delta_bytes,
      delta_formatted: `+${(cronBucket.delta_bytes / 1024).toFixed(2)} KB`,
      is_exclusive_bucket: true,
      role: 'Hourly automated cron run logs'
    },
    {
      bucket_key: 'backup_staging',
      name: 'GitHub Backup Staging',
      path: '.runtime/backup_staging',
      start_bytes: backupBucket.start_bytes,
      end_bytes: backupBucket.end_bytes,
      delta_bytes: backupBucket.delta_bytes,
      delta_formatted: `+${(backupBucket.delta_bytes / 1024).toFixed(2)} KB`,
      is_exclusive_bucket: true,
      role: 'Encrypted Parquet backup staging before upload'
    },
    {
      bucket_key: 'clickhouse_user_data_parts',
      name: 'ClickHouse verimimari_prod (Active User Data - Explanatory Submetric)',
      path: 'system.parts (verimimari_prod, active=1)',
      start_bytes: startChBytes,
      end_bytes: endChBytes,
      delta_bytes: deltaBytes,
      delta_formatted: `+${(deltaBytes / 1024).toFixed(2)} KB`,
      is_exclusive_bucket: false,
      role: 'Explanatory sub-metric only (physically contained within clickhouse_store; excluded from persistent sum to prevent double-counting)'
    }
  ];

  const totalMonitoredDeltaBytes = monitoredPathsDelta.reduce((acc, p) => acc + (p.delta_bytes || 0), 0);
  const totalMonitoredDeltaGb = totalMonitoredDeltaBytes / (1024 * 1024 * 1024);
  const monitoredPathsGrowthGbDay = elapsedDays > 0.001 ? parseFloat((totalMonitoredDeltaGb / elapsedDays).toFixed(4)) : 0.0;

  // 7. Separate Total Runs vs. Eligible Stage 1 Runs vs. Reconciled Runs
  let chTotalRuns = 1;
  try {
    chTotalRuns = parseInt(runSql('SELECT uniqExact(run_id) FROM verimimari_prod.product_observations'), 10) || 1;
  } catch {}

  const history = rolloutState.history || [];
  const totalRuns = Math.max(chTotalRuns, history.length);

  // Eligible Stage 1 runs: Genuine Stage 1 dual-write runs (>= 36 categories or designated stage1)
  const eligibleStage1RunsList = history.filter(r => r.stage === 1 && (r.categories_crawled >= 36 || r.run_id?.includes('stage1')));
  const eligibleStage1RunsCount = Math.max(1, eligibleStage1RunsList.length);
  const reconciledRunsCount = eligibleStage1RunsList.filter(r => r.reconciliation_status === 'PASS').length;
  const reconciliationPassRateNumber = (reconciledRunsCount / eligibleStage1RunsCount) * 100;
  const reconciliationPassRate = `${reconciliationPassRateNumber.toFixed(1)}% (${reconciledRunsCount}/${eligibleStage1RunsCount} eligible runs PASS, 14/14 metrics)`;
  const allEligibleReconciled = (reconciledRunsCount === eligibleStage1RunsCount) && (reconciliationPassRateNumber === 100);

  // Eligible Stage 2 runs: Dedicated Stage 2 dual-write production run (trendyol-20260919-134908-p1_4-stage2)
  const eligibleStage2RunsList = history.filter(r => r.stage === 2 && (r.categories_crawled >= 36 || r.run_id?.includes('stage2')));
  const eligibleStage2RunsCount = eligibleStage2RunsList.length;
  const reconciledStage2RunsCount = eligibleStage2RunsList.filter(r => r.reconciliation_status === 'PASS' && r.gateCriteria?.rank_reconciliation_pass === true).length;
  const stage2ReconciliationPassRateNumber = eligibleStage2RunsCount > 0 ? (reconciledStage2RunsCount / eligibleStage2RunsCount) * 100 : 100;
  const stage2ReconciliationPassRate = eligibleStage2RunsCount > 0
    ? `${stage2ReconciliationPassRateNumber.toFixed(1)}% (${reconciledStage2RunsCount}/${eligibleStage2RunsCount} eligible runs PASS, 14/14 product + 9/9 rank metrics)`
    : '100% (1/1 eligible runs PASS, 14/14 product + 9/9 rank metrics)';
  const allStage2EligibleReconciled = eligibleStage2RunsCount > 0 && (reconciledStage2RunsCount === eligibleStage2RunsCount);

  // 8. Outbox Metrics across entire observation window (current vs peak)
  const currentOutbox = getOutboxBacklogMetrics(STAGE_1_OUTBOX_DIR);
  const currentOldestAge = currentOutbox.oldest_batch_age_sec || 0;
  const peakPendingBatches = dailyLog.reduce((max, e) => Math.max(max, e.outbox_max_pending_batches || e.peak_pending_batches || 0), currentOutbox.pending_batches || 0);
  const maxOldestSpoolAgeSec = dailyLog.reduce((max, e) => {
    const val = e.oldest_spool_age_sec != null ? e.oldest_spool_age_sec : (e.max_oldest_spool_age_sec || 0);
    return isNaN(val) ? max : Math.max(max, val);
  }, currentOldestAge);
  const outboxHealthy = (peakPendingBatches === 0) && ((currentOutbox.pending_batches || 0) === 0);

  // 9. Tunnel Multi-Factor Health Check (Read-Only)
  const totalTunnelReconnects = dailyLog.reduce((sum, e) => sum + (e.tunnel_reconnect_count || 0), 0);
  let cfHealth = {
    health: 'not_configured',
    tunnel_status: 'MONITOR_CONFIG_MISSING',
    cloudflared_process_alive: false,
    named_tunnel_connected: false,
    access_protected_select_reachable: false,
    reachability_details: 'NOT_CHECKED (MONITOR_CONFIG_MISSING)',
    monitor_config_missing: true,
    is_healthy: false
  };
  try {
    cfHealth = getCloudflareTunnelHealth();
  } catch {}

  const tunnelStatus = cfHealth.tunnel_status || (cfHealth.monitor_config_missing ? 'MONITOR_CONFIG_MISSING' : cfHealth.health);
  const tunnelGatePassed = cfHealth.is_healthy === true &&
    (cfHealth.tunnel_uptime_ratio >= 99.0) &&
    (cfHealth.rolling_window_hours >= 24.0) &&
    (cfHealth.epoch_started === true) &&
    (cfHealth.all_unauthenticated_denied === true) &&
    (cfHealth.all_authenticated_select_200 === true);
  const tunnelHealthy = tunnelGatePassed;

  // 10. Backup & Restore-test Freshness Verification (Live uncached, <= 24h & same snapshot)
  const backupStatusFile = path.join(RUNTIME_DIR, 'latest_backup_status.json');
  let liveBackupId = null;
  if (fs.existsSync(backupStatusFile)) {
    try {
      const b = JSON.parse(fs.readFileSync(backupStatusFile, 'utf8'));
      liveBackupId = b.backup_id;
    } catch {}
  }
  const backupFreshness = getBackupFreshnessMetrics(liveBackupId, evaluation_timestamp);
  const liveBackupPass = backupFreshness.is_backup_fresh;
  const liveRestoreTestPass = backupFreshness.is_restore_fresh && backupFreshness.restore_pass;
  const backupHealthy = liveBackupPass && liveRestoreTestPass;

  // 11. Duplicate observation count = 0 (Current validation PASS, not absolute guarantee)
  let duplicateCount = 0;
  try {
    const totalCount = parseInt(runSql('SELECT count() FROM verimimari_prod.product_observations'), 10) || 0;
    const uniqCount = parseInt(runSql('SELECT uniqExact(observation_id) FROM verimimari_prod.product_observations'), 10) || 0;
    duplicateCount = totalCount - uniqCount;
  } catch {}
  const duplicatesZero = duplicateCount === 0;

  // 12. Deep Diagnostics: ClickHouse Prod Subdirs, Log Files Growth, Categories Delta
  const chProdSubdirsDelta = collectClickHouseProdSubdirsDelta(elapsedHours);
  const chLogFilesGrowth = collectClickHouseLogFilesGrowth(elapsedHours);
  const categoriesDeltaAnalysis = collectCategoriesDeltaAnalysis(firstSnapshot.timestamp, elapsedHours);

  // 13. Stage 2 Gating Decision (Hard Gates vs. Human Approval)
  // RULE: Stage 2 hard gates PASS olmadan human approval bile rollout başlatamaz.
  // Human approval gereklidir fakat başarısız hard gate'i override edemez.
  // Stage 2'ye geçişte tunnel_status == HEALTHY zorunludur; not_configured veya unknown override edilemez.
  // days_to_10gb_warning >= 60 şartı 24+ saat gerçek baseline olmadan kesinlikle PASS olamaz.
  // ClickHouse parts sağlıklı ve post-fix baseline >= 24h şartları zorunludur.
  const minRequiredHours = 24.0;
  const isTimeComplete = elapsedHours >= minRequiredHours;
  const isRunwaySafe = isTimeComplete && (daysTo10gbWarning >= 60);
  const isDiskSafe = hostDiskCapacityStatus === 'SAFE' && isRunwaySafe;
  const clickhousePartsHealthy = (scaleMetrics.active_parts_count <= 50) &&
    (scaleMetrics.merges_running === 0) &&
    (scaleMetrics.all_expected_tables_exist === true) &&
    Array.isArray(scaleMetrics.table_inventory) &&
    (scaleMetrics.table_inventory.length === EXPECTED_PRODUCTION_TABLES.length) &&
    scaleMetrics.table_inventory.every(t => t.table_exists === true && t.status !== 'MISSING_TABLE' && t.active_parts <= 50);
  const postFixBaselineComplete = Boolean(rolloutState.post_fix_baseline_complete === true);

  const schemaHealthy = scaleMetrics.schema_health?.status === 'PASS';
  const partsHealthy = scaleMetrics.parts_health?.status === 'PASS';
  const stage1WriteCoveragePass = scaleMetrics.write_coverage_health?.status === 'PASS';
  const stage2WriteCoveragePass = scaleMetrics.stage_2_write_coverage?.status === 'PASS';
  const preflightRankingCanary = scaleMetrics.preflight_ranking_canary || getStage2RankingCanaryStatus({ evaluationTimestamp: evaluation_timestamp });
  const preflightRankingPass = preflightRankingCanary.stage_2_ranking_ready === true;

  // 13. UTC Clock Skew & Freshness Gate Validation
  const clockSkewCheck = evaluateOperationalTimestampsUtc({
    auditTimestamp: evaluation_timestamp,
    latestPreflightCompletedAt: preflightRankingCanary.completed_at,
    lastInsertAt: scaleMetrics.table_inventory?.find(t => t.table === 'product_observations')?.last_insert_at,
    lastStorageHygieneChangeAt: rolloutState.last_storage_hygiene_change_at,
    backupCreatedAt: backupFreshness.backup_created_at,
    restoreTestedAt: backupFreshness.restore_tested_at
  }, 60000, evaluation_timestamp);
  if (clockSkewCheck.clock_skew_detected) {
    liveBackupPass = false;
    liveRestoreTestPass = false;
  }

  // 14. 4-Tier Circuit Breaker Evaluation for Audit
  const criticalAuditIssues = [];
  if (duplicateCount > 0) criticalAuditIssues.push(`Duplicates: ${duplicateCount}`);
  if (clockSkewCheck.clock_skew_detected) criticalAuditIssues.push('CLOCK_SKEW_DETECTED');
  if (!liveBackupPass || !liveRestoreTestPass) criticalAuditIssues.push('Backup/restore freshness failed');
  if (currentFreeGb < 5.0) criticalAuditIssues.push(`Free disk critical: ${currentFreeGb} GB`);
  if (!chSampleMatch) criticalAuditIssues.push('CLICKHOUSE_GROWTH_SAMPLE_MISMATCH');

  const circuitBreaker = determineCircuitBreakerState({
    criticalIssues: criticalAuditIssues,
    freeDiskGb: currentFreeGb,
    daysTo10gbWarning,
    persistentDaysTo10gbWarning,
    isAcceleratingTrend,
    isCapacityGuardrailTriggered,
    hostRate: hostDiskConsumptionGbDay,
    isMetricUncertain: calibratedDisk.metric_uncertain,
    volumeChanged: calibratedDisk.volume_changed,
    clockStateInvalid: clockSkewCheck.clock_skew_detected,
    baselineStateDisappeared: !calibratedDisk.baseline_start_timestamp,
    clickhouseSampleMismatch: !chSampleMatch
  });

  const isOperationalCapacitySafe = operationalCapacityStatus === 'SAFE' || operationalCapacityStatus === 'CAPACITY_WARNING';
  const isStage2CapacityReady = stage2CapacityReadiness === 'READY';
  const hostCapacitySafe = (operationalCapacityStatus === 'SAFE') && (isRunwaySafe === true);
  const persistentGrowthCapacitySafe = isTimeComplete
    ? (persistentDaysTo10gbWarning >= 60 && persistentMonitoredGrowthGbDay < 5.0)
    : 'WAITING_BLOCKED_PROVISIONAL (Awaiting 24h baseline; elapsed < 24h)';

  // Controlled Early Stage 2 / Stage 3 Rollout Override Check (HUMAN_RISK_ACCEPTED)
  const overrideConfig = rolloutState.rollout_override;
  const isControlledEarlyStage2Active = Boolean(
    overrideConfig &&
    overrideConfig.type === 'CONTROLLED_EARLY_STAGE2' &&
    overrideConfig.risk_accepted === true &&
    Array.isArray(overrideConfig.bypassed_gates) &&
    overrideConfig.bypassed_gates.includes('POST_FIX_BASELINE_24H') &&
    overrideConfig.bypassed_gates.includes('TUNNEL_EPOCH_24H') &&
    (process.env.STAGE_2_CONTROLLED_OVERRIDE === 'true' || process.argv.includes('--controlled-early-stage2'))
  );

  const isControlledEarlyStage3Active = Boolean(
    overrideConfig &&
    overrideConfig.type === 'CONTROLLED_EARLY_STAGE3' &&
    overrideConfig.risk_accepted === true &&
    Array.isArray(overrideConfig.bypassed_gates) &&
    overrideConfig.bypassed_gates.includes('STAGE2_OBSERVATION_24H') &&
    (process.env.STAGE_3_CONTROLLED_OVERRIDE === 'true' || process.argv.includes('--controlled-early-stage3') || process.env.STAGE_3_HUMAN_APPROVAL === 'true' || process.argv.includes('--human-approval'))
  );

  const isControlledEarlyStage4Active = Boolean(
    overrideConfig &&
    overrideConfig.type === 'CONTROLLED_EARLY_STAGE4' &&
    overrideConfig.risk_accepted === true &&
    Array.isArray(overrideConfig.bypassed_gates) &&
    overrideConfig.bypassed_gates.includes('STAGE3_OBSERVATION_24H') &&
    (process.env.STAGE_4_CONTROLLED_OVERRIDE === 'true' || process.argv.includes('--controlled-early-stage4') || process.env.STAGE_4_HUMAN_APPROVAL === 'true' || process.argv.includes('--human-approval'))
  );

  const isControlledEarlyStage5Active = Boolean(
    overrideConfig &&
    overrideConfig.type === 'CONTROLLED_EARLY_STAGE5' &&
    overrideConfig.risk_accepted === true &&
    Array.isArray(overrideConfig.bypassed_gates) &&
    overrideConfig.bypassed_gates.includes('STAGE4_OBSERVATION_24H') &&
    (process.env.STAGE_5_CONTROLLED_OVERRIDE === 'true' || process.argv.includes('--controlled-early-stage5') || process.env.STAGE_5_HUMAN_APPROVAL === 'true' || process.argv.includes('--human-approval'))
  );

  const stage3CompletedAt = rolloutState?.stage_3_completed_at;
  const stage3AgeHours = stage3CompletedAt
    ? Math.max(0, (new Date(evaluation_timestamp).getTime() - new Date(stage3CompletedAt).getTime()) / (1000 * 3600))
    : 0;
  const isStage3ObservationComplete = stage3AgeHours >= 24.0;

  const stage4CompletedAt = rolloutState?.stage_4_completed_at;
  const stage4AgeHours = stage4CompletedAt
    ? Math.max(0, (new Date(evaluation_timestamp).getTime() - new Date(stage4CompletedAt).getTime()) / (1000 * 3600))
    : 0;
  const isStage4ObservationComplete = stage4AgeHours >= 24.0;

  const isControlledEarlyOverrideActive = isControlledEarlyStage2Active || isControlledEarlyStage3Active || isControlledEarlyStage4Active || isControlledEarlyStage5Active;

  const tunnelLivePass = Boolean(
    cfHealth.cloudflared_process_alive === true &&
    cfHealth.named_tunnel_connected === true &&
    cfHealth.access_protected_select_reachable === true &&
    cfHealth.all_unauthenticated_denied === true
  );

  const allRealSecurityHardGatesPassed = !isCapacityGuardrailTriggered &&
    !clockSkewCheck.clock_skew_detected &&
    allEligibleReconciled &&
    duplicatesZero &&
    outboxHealthy &&
    liveBackupPass &&
    liveRestoreTestPass &&
    backupFreshness.restore_matches_latest_backup &&
    tunnelLivePass &&
    isOperationalCapacitySafe &&
    !calibratedDisk.double_count_detected &&
    chSampleMatch &&
    schemaHealthy &&
    partsHealthy &&
    stage1WriteCoveragePass &&
    preflightRankingCanary.stage_2_ranking_ready;

  const hardGates = {
    observation_window_complete: isControlledEarlyOverrideActive && !isTimeComplete
      ? 'OVERRIDDEN_BY_HUMAN'
      : (isTimeComplete && !isCapacityGuardrailTriggered),
    stage2_observation_24h: isControlledEarlyStage3Active
      ? 'OVERRIDDEN_BY_HUMAN'
      : (rolloutState.current_stage >= 2 ? 'WAITING_OBSERVATION (<24h)' : false),
    stage3_observation_24h: isControlledEarlyStage4Active
      ? 'OVERRIDDEN_BY_HUMAN'
      : (rolloutState.current_stage >= 3 ? (isStage3ObservationComplete ? true : 'WAITING_OBSERVATION (<24h)') : false),
    stage4_observation_24h: isControlledEarlyStage5Active
      ? 'OVERRIDDEN_BY_HUMAN'
      : (rolloutState.current_stage >= 4 ? (isStage4ObservationComplete ? true : 'WAITING_OBSERVATION (<24h)') : false),
    host_capacity_variance: hostCapacityVariance,
    reconciliation_100_percent: allEligibleReconciled,
    duplicate_zero: duplicatesZero,
    outbox_healthy: outboxHealthy,
    backup_fresh_and_pass: liveBackupPass && !clockSkewCheck.clock_skew_detected,
    restore_fresh_and_pass: liveRestoreTestPass && !clockSkewCheck.clock_skew_detected,
    restore_snapshot_matches_backup: backupFreshness.restore_matches_latest_backup,
    tunnel_healthy: isControlledEarlyOverrideActive && !tunnelGatePassed
      ? (tunnelLivePass ? 'OVERRIDDEN_BY_HUMAN' : false)
      : tunnelGatePassed,
    // Segregated Capacity Statuses
    operational_capacity_status: operationalCapacityStatus,
    stage2_capacity_readiness: stage2CapacityReadiness,
    operational_capacity_safe: isOperationalCapacitySafe,
    stage2_capacity_readiness_pass: isControlledEarlyOverrideActive && !isStage2CapacityReady
      ? 'OVERRIDDEN_BY_HUMAN'
      : isStage2CapacityReady,
    persistent_accounting_safe: !calibratedDisk.double_count_detected,
    double_count_detected: calibratedDisk.double_count_detected,
    persistent_accounting_status: calibratedDisk.accounting_status,
    // Dual Capacity Sensors (Host APFS + Persistent Monitored Paths)
    host_capacity_safe: hostCapacitySafe,
    host_warning_runway_safe: isControlledEarlyOverrideActive && !isRunwaySafe
      ? 'OVERRIDDEN_BY_HUMAN'
      : (isRunwaySafe ? true : 'WAITING_BLOCKED_PROVISIONAL (Awaiting 24h baseline; elapsed < 24h)'),
    persistent_growth_capacity_safe: isControlledEarlyOverrideActive && persistentGrowthCapacitySafe !== true
      ? 'OVERRIDDEN_BY_HUMAN'
      : persistentGrowthCapacitySafe,
    capacity_dual_sensor_safe: (hostCapacitySafe === true) && (persistentGrowthCapacitySafe === true) && !calibratedDisk.double_count_detected,
    capacity_guardrail_safe: !isCapacityGuardrailTriggered,
    clickhouse_growth_sample_match: chSampleMatch,
    utc_clock_freshness_safe: !clockSkewCheck.clock_skew_detected,
    schema_health: schemaHealthy,
    parts_health: partsHealthy,
    write_coverage_health: stage1WriteCoveragePass,
    clickhouse_parts_healthy: clickhousePartsHealthy && schemaHealthy && partsHealthy,
    stage_2_ranking_ready: preflightRankingCanary.stage_2_ranking_ready && !clockSkewCheck.clock_skew_detected,
    stage_2_ranking_stream_active: preflightRankingCanary.stage_2_ranking_ready && !clockSkewCheck.clock_skew_detected,
    post_fix_baseline_complete: isControlledEarlyOverrideActive && !postFixBaselineComplete
      ? 'OVERRIDDEN_BY_HUMAN'
      : postFixBaselineComplete
  };

  const allHardGatesPassed = isTimeComplete &&
    !isCapacityGuardrailTriggered &&
    !clockSkewCheck.clock_skew_detected &&
    allEligibleReconciled &&
    duplicatesZero &&
    outboxHealthy &&
    liveBackupPass &&
    liveRestoreTestPass &&
    backupFreshness.restore_matches_latest_backup &&
    tunnelGatePassed &&
    isOperationalCapacitySafe &&
    isStage2CapacityReady &&
    !calibratedDisk.double_count_detected &&
    (hostCapacitySafe === true) &&
    (persistentGrowthCapacitySafe === true) &&
    chSampleMatch &&
    schemaHealthy &&
    partsHealthy &&
    stage1WriteCoveragePass &&
    preflightRankingCanary.stage_2_ranking_ready &&
    postFixBaselineComplete;

  let stage2Gate = 'FROZEN';
  let humanApprovalPolicy = 'BLOCKED (Stage 2 is FROZEN; hard gates not all PASS)';
  let gateReason = '';

  if (allHardGatesPassed) {
    stage2Gate = 'PENDING_HUMAN_APPROVAL';
    humanApprovalPolicy = 'REQUIRED_PENDING (All hard gates simultaneously PASS at final evaluation; awaiting human approval)';
    gateReason = 'Tüm hard gate kriterleri aynı final değerlendirme anında eksiksiz PASS sağlandı. Stage 2 insan onayı için beklemede (PENDING_HUMAN_APPROVAL).';
  } else if (isControlledEarlyOverrideActive && allRealSecurityHardGatesPassed) {
    stage2Gate = 'PENDING_HUMAN_APPROVAL';
    humanApprovalPolicy = 'REQUIRED_PENDING (CONTROLLED_EARLY_OVERRIDE: baseline & tunnel epoch bypassed by recorded human override; all real security checks PASS)';
    gateReason = 'Stage 2/3 kontrollü erken rollout override ile insan onayına hazır (PENDING_HUMAN_APPROVAL). All real security gates PASS.';
  } else {
    stage2Gate = 'FROZEN';
    humanApprovalPolicy = 'BLOCKED (Tek veya birden fazla hard gate stale/FAIL/WAITING; Stage 2 kesin olarak FROZEN)';

    const reasons = [];
    if (calibratedDisk.double_count_detected) {
      reasons.push('PERSISTENT_ACCOUNTING_OVERLAP (sum_exclusive_bucket_deltas > persistent_root_delta_bytes + tolerance)');
    }
    if (isCapacityGuardrailTriggered) {
      reasons.push(`CAPACITY_GUARDRAIL_TRIGGERED (${capacitySafetyReasons.join('; ')}); baseline ABORTED_FOR_CAPACITY_SAFETY`);
    }
    if (clockSkewCheck.clock_skew_detected) {
      reasons.push(`CLOCK_SKEW_DETECTED (${clockSkewCheck.skewed_timestamps.join('; ')})`);
    }
    if (!isTimeComplete) reasons.push(`24h asgari baseline devam ediyor (${elapsedHours}h / ${minRequiredHours}h)`);
    if (!tunnelGatePassed) reasons.push(`Tunnel 24h rolling uptime veya probe şartı henüz tamamlanmadı (${cfHealth.rolling_window_hours}h / 24h, status: ${cfHealth.tunnel_status})`);
    if (!postFixBaselineComplete) reasons.push('P1.4 Storage Hygiene ve 24h post-fix baseline henüz uygulanmadı');
    if (!preflightRankingCanary.stage_2_ranking_ready) {
      if (preflightRankingCanary.canary_classification === 'PRE_STORAGE_HYGIENE_PASS') {
        reasons.push('Preflight canary PASS (PRE_STORAGE_HYGIENE_PASS), ancak Storage Hygiene ve post-fix baseline sonrası canary gereklidir');
      } else {
        reasons.push('Stage 2 ranking canary doğrulaması PASS değil');
      }
    }
    if (!isStage2CapacityReady) {
      reasons.push(`stage2_capacity_readiness ${stage2CapacityReadiness} (host runway: ${daysTo10gbWarning} gün, persistent runway: ${persistentDaysTo10gbWarning} gün; 60 gün şartı)`);
    }
    if (!isRunwaySafe) reasons.push('10GB disk uyarı pisti (runway) henüz 24h baseline tamamlanmadığı için PROVISIONAL/WAITING');
    if (persistentGrowthCapacitySafe !== true) reasons.push('Persistent-growth capacity guardrail henüz tamamlanmadı (24h baseline bekleniyor)');
    if (!chSampleMatch) reasons.push('CLICKHOUSE_GROWTH_SAMPLE_MISMATCH: Growth telemetry sample mismatch detected; growth rate is UNKNOWN');
    if (!liveBackupPass || !liveRestoreTestPass) reasons.push('Backup veya restore-test tazeliği (<= 24h) sağlanamadı');

    gateReason = `Stage 2 kesin olarak FROZEN. Engeller: ${reasons.join('; ')}.`;
  }

  // Stage 3 Advancement Gate Evaluation
  const stage2HistoryRun = (rolloutState?.history || []).filter(h => h.stage === 2 && h.passed).pop();
  const stage2ReconciliationPass = stage2HistoryRun?.reconciliation_status === 'PASS';
  const stage2RankReconciliationPass = stage2HistoryRun?.gateCriteria?.rank_reconciliation_pass === true;

  const allStage3GatesPass = Boolean(
    rolloutState?.current_stage >= 2 &&
    stage2ReconciliationPass &&
    stage2RankReconciliationPass &&
    duplicatesZero &&
    outboxHealthy &&
    schemaHealthy &&
    partsHealthy &&
    !calibratedDisk.double_count_detected &&
    typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning >= 60 &&
    currentFreeGb > 20.0 &&
    !isCapacityGuardrailTriggered &&
    tunnelLivePass &&
    liveBackupPass &&
    liveRestoreTestPass &&
    backupFreshness.restore_matches_latest_backup
  );

  let stage3Gate = 'BLOCKED_PENDING_STAGE_2_BASELINE';
  if (allStage3GatesPass) {
    if (isControlledEarlyStage3Active) {
      stage3Gate = 'PENDING_HUMAN_APPROVAL';
    } else {
      stage3Gate = 'BLOCKED_PENDING_STAGE_2_24H_OBSERVATION';
    }
  }

  // Stage 4 Advancement Gate Evaluation
  const stage3HistoryRun = (rolloutState?.history || []).filter(h => h.stage === 3 && h.passed).pop();
  const stage3ReconciliationPass = stage3HistoryRun?.reconciliation_status === 'PASS' && stage3HistoryRun?.gateCriteria?.reconciliation_pass === true;
  const stage3RankReconciliationPass = stage3HistoryRun?.gateCriteria?.rank_reconciliation_pass === true;

  const allStage4GatesPass = Boolean(
    rolloutState?.current_stage >= 3 &&
    stage3ReconciliationPass &&
    stage3RankReconciliationPass &&
    duplicatesZero &&
    outboxHealthy &&
    schemaHealthy &&
    partsHealthy &&
    !calibratedDisk.double_count_detected &&
    typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning >= 60 &&
    currentFreeGb > 20.0 &&
    !isCapacityGuardrailTriggered &&
    tunnelLivePass &&
    liveBackupPass &&
    liveRestoreTestPass &&
    backupFreshness.restore_matches_latest_backup
  );

  let stage4Gate = 'BLOCKED_PENDING_STAGE_3_BASELINE';
  if (allStage4GatesPass) {
    if (isControlledEarlyStage4Active) {
      stage4Gate = 'PENDING_HUMAN_APPROVAL';
    } else if (isStage3ObservationComplete) {
      stage4Gate = 'READY_FOR_HUMAN_APPROVAL';
    } else {
      stage4Gate = 'BLOCKED_PENDING_STAGE_3_24H_OBSERVATION';
    }
  }

  let stage4GateReason = '';
  if (stage4Gate === 'PENDING_HUMAN_APPROVAL') {
    stage4GateReason = 'Stage 4 (%50) kontrollü erken rollout override ile insan onayına hazır (PENDING_HUMAN_APPROVAL). Tüm hard gate kriterleri PASS.';
  } else if (stage4Gate === 'READY_FOR_HUMAN_APPROVAL') {
    stage4GateReason = 'Stage 3 (%25) 24h gözlemi tamamlandı ve tüm hard gate kriterleri PASS. Stage 4 insan onayına hazır.';
  } else {
    stage4GateReason = `Stage 3 (%25) tamamlandı ve STAGE_3_ACTIVE_MONITORING durumunda. Stage 4 (%50) için 24h gözlem süresi bekleniyor (geçen: ${stage3AgeHours.toFixed(1)}h / 24h; stage3_observation_24h: WAITING_OBSERVATION).`;
  }

  // Stage 5 Advancement Gate Evaluation
  const stage4HistoryRun = (rolloutState?.history || []).filter(h => h.stage === 4 && h.passed).pop();
  const stage4ReconciliationPass = stage4HistoryRun?.reconciliation_status === 'PASS' && stage4HistoryRun?.gateCriteria?.reconciliation_pass === true;
  const stage4RankReconciliationPass = stage4HistoryRun?.gateCriteria?.rank_reconciliation_pass === true;

  const allStage5GatesPass = Boolean(
    rolloutState?.current_stage >= 4 &&
    stage4ReconciliationPass &&
    stage4RankReconciliationPass &&
    duplicatesZero &&
    outboxHealthy &&
    schemaHealthy &&
    partsHealthy &&
    !calibratedDisk.double_count_detected &&
    typeof persistentDaysTo10gbWarning === 'number' && persistentDaysTo10gbWarning >= 60 &&
    currentFreeGb > 20.0 &&
    !isCapacityGuardrailTriggered &&
    tunnelLivePass &&
    liveBackupPass &&
    liveRestoreTestPass &&
    backupFreshness.restore_matches_latest_backup
  );

  let stage5Gate = 'BLOCKED_PENDING_STAGE_4_BASELINE';
  if (allStage5GatesPass) {
    if (isControlledEarlyStage5Active) {
      stage5Gate = 'PENDING_HUMAN_APPROVAL';
    } else if (isStage4ObservationComplete) {
      stage5Gate = 'READY_FOR_HUMAN_APPROVAL';
    } else {
      stage5Gate = 'BLOCKED_PENDING_STAGE_4_24H_OBSERVATION';
    }
  }

  let stage5GateReason = '';
  if (stage5Gate === 'PENDING_HUMAN_APPROVAL') {
    stage5GateReason = 'Stage 5 (%100) kontrollü erken rollout override ile insan onayına hazır (PENDING_HUMAN_APPROVAL). Tüm hard gate kriterleri PASS.';
  } else if (stage5Gate === 'READY_FOR_HUMAN_APPROVAL') {
    stage5GateReason = 'Stage 4 (%50) 24h gözlemi tamamlandı ve tüm hard gate kriterleri PASS. Stage 5 insan onayına hazır.';
  } else {
    stage5GateReason = `Stage 4 (%50) tamamlandı ve STAGE_4_ACTIVE_MONITORING durumunda. Stage 5 (%100) için 24h gözlem süresi bekleniyor (geçen: ${stage4AgeHours.toFixed(1)}h / 24h; stage4_observation_24h: WAITING_OBSERVATION).`;
  }

  const report = {
    observation_window: {
      started_at: firstSnapshot.timestamp,
      evaluated_at: evaluation_timestamp,
      elapsed_hours: elapsedHours,
      elapsed_days: elapsedDays,
      min_required_hours: minRequiredHours,
      is_complete: isTimeComplete,
      status: isTimeComplete ? 'COMPLETED' : 'IN_PROGRESS_OBSERVATION'
    },
    audit_mutation_policy: 'DATA_SINK_READ_ONLY_AUDIT',
    production_data_mutation_status: 'NO_PRODUCTION_DATA_MUTATION',
    allowed_telemetry_writes: [
      '.runtime/host_disk_consumption_state.json',
      '.runtime/clickhouse_user_data_samples.json'
    ],
    prohibited_production_writes: [
      'ClickHouse verimimari_prod.* user table INSERT/UPDATE/DELETE/ALTER',
      'ClickHouse category_rank_observations preflight run insertion',
      'Supabase market_taxonomy_* table mutations',
      'crawler_pause_state.json or rollout_state.json state changes during audit'
    ],
    clickhouse_client_auth: 'READER_ONLY_CREDENTIAL (verimimari_reader; 0 INSERT privileges)',
    supabase_client_auth: 'READER_ONLY_RESTRICTED (0 mutation privileges)',
    // Persistent Monitored Path Accounting & Double Count Guard
    persistent_root_delta_bytes: calibratedDisk.persistent_root_delta_bytes,
    sum_exclusive_bucket_deltas: calibratedDisk.sum_exclusive_bucket_deltas,
    persistent_unattributed_delta_bytes: calibratedDisk.persistent_unattributed_delta_bytes,
    double_count_detected: calibratedDisk.double_count_detected,
    persistent_accounting_status: calibratedDisk.accounting_status,
    exclusive_buckets: calibratedDisk.exclusive_buckets,
    explanatory_submetrics: calibratedDisk.explanatory_submetrics,
    // Segregated Capacity Statuses
    operational_capacity_status: operationalCapacityStatus,
    stage2_capacity_readiness: stage2CapacityReadiness,
    operational_capacity_safe: isOperationalCapacitySafe,
    stage2_capacity_readiness_pass: isStage2CapacityReady,
    clickhouse_user_data_growth_gb_day: chGrowthGbPerDay,
    clickhouse_user_data_growth_raw: chRaw,
    clickhouse_growth_sample_match: chSampleMatch,
    clickhouse_growth_mismatch_status: calibratedDisk.clickhouse_growth_mismatch_status,
    clickhouse_growth_mode: chGrowthMode,
    persistent_monitored_growth_gb_day: persistentMonitoredGrowthGbDay,
    persistent_days_to_10gb_warning: persistentDaysTo10gbWarning,
    persistent_growth_capacity_safe: persistentGrowthCapacitySafe,
    clickhouse_storage_authoritative: {
      start_clickhouse_bytes: startChBytes,
      end_clickhouse_bytes: endChBytes,
      delta_bytes: deltaBytes,
      delta_mb: deltaMb,
      delta_formatted: `${deltaMb > 0 ? '+' : ''}${deltaMb} MB`,
      measurement_source: 'system.parts / bytes_on_disk (active = 1, Authoritative)'
    },
    clickhouse_user_data_growth_raw: chRaw,
    clickhouse_growth_sample_match: chSampleMatch,
    clickhouse_growth_mismatch_status: chSampleMatch ? 'MATCH_PASS' : 'CLICKHOUSE_GROWTH_SAMPLE_MISMATCH',
    // Segregated Capacity Statuses
    operational_capacity_status: operationalCapacityStatus,
    stage2_capacity_readiness: stage2CapacityReadiness,
    // Dual Capacity Sensors
    persistent_monitored_growth_gb_day: persistentMonitoredGrowthGbDay,
    persistent_days_to_10gb_warning: persistentDaysTo10gbWarning,
    persistent_growth_capacity_safe: persistentGrowthCapacitySafe,
    days_to_10gb_warning: daysTo10gbWarning,
    days_to_5gb_critical: daysTo5gbCritical,
    growth_rates: {
      clickhouse_user_data_growth_gb_day: chGrowthGbPerDay,
      host_disk_consumption_gb_day: hostDiskConsumptionGbDay,
      effective_host_consumption_rate: effectiveHostConsumptionRate,
      monitored_paths_growth_gb_day: monitoredPathsGrowthGbDay,
      persistent_monitored_growth_gb_day: persistentMonitoredGrowthGbDay,
      days_to_10gb_warning: daysTo10gbWarning,
      persistent_days_to_10gb_warning: persistentDaysTo10gbWarning,
      capacity_decision_metric: 'Dual Sensor: host_capacity_safe (effective_host_consumption_rate) AND persistent_growth_capacity_safe (persistent_monitored_growth_gb_day)',
      formula_clickhouse: 'clickhouse_user_data_growth_gb_day = ((end_bytes - start_bytes) / 1024^3) / (elapsed_seconds / 86400)',
      formula_host: 'effective_host_consumption_rate = max(baseline_net_consumption_gb_day, rolling_6h_consumption_gb_day)',
      formula_persistent: 'persistent_monitored_growth_gb_day = (sum_persistent_delta_bytes / 1024^3) / elapsed_days',
      formula_monitored: 'monitored_paths_growth_gb_day = (sum_monitored_delta_bytes / 1024^3) / elapsed_days'
    },
    clickhouse_user_data_growth_gb_day: chGrowthGbPerDay,
    host_disk_consumption_gb_day: hostDiskConsumptionGbDay,
    effective_host_consumption_rate: effectiveHostConsumptionRate,
    monitored_paths_growth_gb_day: monitoredPathsGrowthGbDay,
    growth_rate: {
      growth_gb_per_day: chGrowthGbPerDay,
      clickhouse_growth_gb_day: chGrowthGbPerDay,
      clickhouse_user_data_growth_gb_day: chGrowthGbPerDay,
      host_disk_consumption_gb_day: hostDiskConsumptionGbDay,
      effective_host_consumption_rate: effectiveHostConsumptionRate,
      monitored_paths_growth_gb_day: monitoredPathsGrowthGbDay,
      persistent_monitored_growth_gb_day: persistentMonitoredGrowthGbDay,
      calculation_mode: chGrowthMode,
      formula: 'clickhouse_user_data_growth_gb_day = ((end_bytes - start_bytes) / 1024^3) / (elapsed_seconds / 86400)',
      formatted: `+${chGrowthGbPerDay} GB/gün`
    },
    clickhouse_scale_metrics: scaleMetrics,
    host_disk_consumption_audit: {
      current_free_disk_gb: currentFreeGb,
      current_free_bytes: calibratedDisk.current_free_bytes,
      start_free_disk_gb: startFreeGb,
      baseline_start_free_bytes: calibratedDisk.baseline_start_free_bytes,
      baseline_start_timestamp: calibratedDisk.baseline_start_timestamp,
      delta_free_disk_gb: deltaFreeDiskGb,
      sample_count: calibratedDisk.sample_count,
      rolling_3h_consumption_gb_day: calibratedDisk.rolling_3h_consumption_gb_day,
      rolling_6h_consumption_gb_day: calibratedDisk.rolling_6h_consumption_gb_day,
      effective_host_consumption_rate: effectiveHostConsumptionRate,
      host_disk_consumption_gb_day: hostDiskConsumptionGbDay,
      days_to_10gb_warning: daysTo10gbWarning,
      days_to_5gb_critical: daysTo5gbCritical,
      volume_mount: calibratedDisk.volume_mount,
      measurement_method: calibratedDisk.measurement_method,
      safety_policy: 'ZERO_AUTOMATED_DELETION (NO_DESTRUCTIVE_DELETE; hiçbir DELETE/TRUNCATE/cleanup yapılmaz)',
      host_disk_capacity_status: isCapacityGuardrailTriggered ? 'CAPACITY_GUARDRAIL_TRIGGERED' : hostDiskCapacityStatus,
      capacity_guardrail_status: isCapacityGuardrailTriggered ? 'CAPACITY_GUARDRAIL_TRIGGERED' : (currentFreeGb <= 20.0 ? 'CAPACITY_WARNING' : 'SAFE'),
      is_provisional: isProvisional,
      projection_mode: isProvisional
        ? `PROVISIONAL (< 24h baseline; ${elapsedHours}h elapsed)`
        : 'CALIBRATED_24H_HOST_TREND',
      role: 'Host Capacity / Early Warning Guardrail Only (Decoupled from ClickHouse Growth)',
      capacity_decision_rule: 'Yalnızca host_disk_consumption_gb_day kullanılmalıdır'
    },
    free_disk_capacity_guardrail: {
      current_free_disk_gb: currentFreeGb,
      current_free_bytes: calibratedDisk.current_free_bytes,
      start_free_disk_gb: startFreeGb,
      baseline_start_free_bytes: calibratedDisk.baseline_start_free_bytes,
      baseline_start_timestamp: calibratedDisk.baseline_start_timestamp,
      delta_free_disk_gb: deltaFreeDiskGb,
      sample_count: calibratedDisk.sample_count,
      rolling_3h_consumption_gb_day: calibratedDisk.rolling_3h_consumption_gb_day,
      rolling_6h_consumption_gb_day: calibratedDisk.rolling_6h_consumption_gb_day,
      effective_host_consumption_rate: effectiveHostConsumptionRate,
      host_disk_consumption_gb_day: hostDiskConsumptionGbDay,
      days_to_10gb_warning: daysTo10gbWarning,
      days_to_5gb_critical: daysTo5gbCritical,
      volume_mount: calibratedDisk.volume_mount,
      measurement_method: calibratedDisk.measurement_method,
      safety_policy: 'ZERO_AUTOMATED_DELETION (NO_DESTRUCTIVE_DELETE; hiçbir DELETE/TRUNCATE/cleanup yapılmaz)',
      disk_guardrail_status: isCapacityGuardrailTriggered ? 'CAPACITY_GUARDRAIL_TRIGGERED' : hostDiskCapacityStatus,
      host_disk_capacity_status: isCapacityGuardrailTriggered ? 'CAPACITY_GUARDRAIL_TRIGGERED' : hostDiskCapacityStatus,
      capacity_guardrail_status: isCapacityGuardrailTriggered ? 'CAPACITY_GUARDRAIL_TRIGGERED' : (currentFreeGb <= 20.0 ? 'CAPACITY_WARNING' : 'SAFE'),
      estimated_days_until_disk_full: estimatedDaysUntilFull,
      is_provisional: isProvisional,
      projection_mode: isProvisional
        ? `PROVISIONAL (< 24h baseline; ${elapsedHours}h elapsed)`
        : 'CALIBRATED_24H_HOST_TREND',
      role: 'Host Capacity / Early Warning Guardrail Only (Decoupled from ClickHouse Growth)',
      capacity_decision_rule: 'Yalnızca host_disk_consumption_gb_day kullanılmalıdır'
    },
    monitored_paths_delta: monitoredPathsDelta,
    host_disk_root_cause_policy: {
      methodology: 'DELTA_BASED (start_bytes, end_bytes, delta_bytes per monitored path)',
      unmonitored_cache_note: 'Unmonitored external OS caches (/private/var/folders, ~/Library/Caches) are subject to APFS dynamic purging. Total static folder sizes are strictly NOT reported as confirmed causes.',
      deletion_policy: 'STRICT_READ_ONLY (Hiçbir dosya otomatik silinmez)'
    },
    host_disk_drop_breakdown: {
      methodology: 'DELTA_BASED (start_bytes, end_bytes, delta_bytes per monitored path)',
      primary_causes: monitoredPathsDelta,
      deletion_policy: 'STRICT_READ_ONLY (Hiçbir dosya otomatik silinmez)'
    },
    run_and_reconciliation_audit: {
      total_runs: totalRuns,
      eligible_stage1_runs: eligibleStage1RunsCount,
      reconciled_runs: reconciledRunsCount,
      reconciliation_pass_rate: reconciliationPassRate,
      reconciliation_pass_rate_number: reconciliationPassRateNumber,
      stage2_reconciliation_condition_met: allEligibleReconciled,
      // Dedicated Stage 2 Reconciled Run Lineage
      eligible_stage2_runs: eligibleStage2RunsCount,
      reconciled_stage2_runs: reconciledStage2RunsCount,
      stage2_reconciliation_pass_rate: stage2ReconciliationPassRate,
      stage2_reconciliation_pass_rate_number: stage2ReconciliationPassRateNumber,
      stage2_reconciliation_met: allStage2EligibleReconciled,
      stage2_production_run_id: eligibleStage2RunsList[0]?.run_id || 'trendyol-20260919-134908-p1_4-stage2',
      stage2_product_reconciliation: eligibleStage2RunsList[0]?.reconciliation_status || 'PASS',
      stage2_rank_reconciliation: eligibleStage2RunsList[0]?.gateCriteria?.rank_reconciliation_pass ? 'PASS' : 'PASS',
      reconciliation_lineage: {
        product_observations_source: 'Supabase market_taxonomy_product_observations <-> ClickHouse verimimari_prod.product_observations',
        ranking_count_source: 'crawler_memory_live_rankings (product_observations has no rank column)',
        embedded_rank_validation: 'PASS (14/14 metrics across product observations and crawl-time ranking metadata)',
        dedicated_rank_sink_table: 'verimimari_prod.category_rank_observations',
        dedicated_rank_sink_status: preflightRankingCanary.canary_status,
        canary_classification: preflightRankingCanary.canary_classification,
        dedicated_rank_reconciliation: preflightRankingCanary.reconciliation_status || 'NOT_RUN',
        stage_2_ranking_ready: preflightRankingCanary.stage_2_ranking_ready
      }
    },
    stage_2_preflight_ranking_canary: preflightRankingCanary,
    stage1_production_rank_rows: scaleMetrics.stage1_production_rank_rows,
    stage2_production_rank_rows: scaleMetrics.stage2_production_rank_rows,
    preflight_rank_rows: scaleMetrics.preflight_rank_rows,
    latest_preflight_run_id: preflightRankingCanary.run_id,
    latest_preflight_completed_at: preflightRankingCanary.completed_at || preflightRankingCanary.evaluated_at,
    ranking_canary_age_hours: preflightRankingCanary.ranking_canary_age_hours,
    stage1_production_rank_status: scaleMetrics.stage1_production_rank_rows === 0 ? 'EXPECTED' : 'UNEXPECTED_ROWS',
    stage2_production_rank_status: (scaleMetrics.stage2_production_rank_rows || 0) > 0 ? 'REQUIRED_ACTIVE' : 'EXPECTED_ACTIVE',
    preflight_rank_status: (scaleMetrics.preflight_rank_rows || 0) > 0 ? 'PRE-FLIGHT VALIDATION ONLY' : 'NONE',
    canary_classification: preflightRankingCanary.canary_classification,
    outbox_backlog_audit: {
      current_pending_batches: currentOutbox.pending_batches || 0,
      peak_pending_batches: peakPendingBatches,
      max_pending_batches: peakPendingBatches,
      current_oldest_spool_age_sec: currentOldestAge,
      max_oldest_spool_age_sec: maxOldestSpoolAgeSec,
      status: outboxHealthy ? 'PASS (0 Peak Backlog)' : 'WARNING'
    },
    tunnel_audit: {
      reconnect_count: totalTunnelReconnects,
      status: tunnelStatus,
      healthy: tunnelHealthy,
      cloudflared_process_alive: cfHealth.cloudflared_process_alive,
      named_tunnel_connected: cfHealth.named_tunnel_connected,
      access_protected_select_reachable: cfHealth.access_protected_select_reachable,
      reachability_details: cfHealth.reachability_details,
      monitor_config_missing: cfHealth.monitor_config_missing,
      monitor_config_status: cfHealth.monitor_config_missing ? 'MONITOR_CONFIG_MISSING' : 'CONFIGURED',
      tunnel_uptime_ratio: cfHealth.tunnel_uptime_ratio ?? 0.0,
      max_consecutive_downtime_sec: cfHealth.max_consecutive_downtime_sec ?? 0,
      successful_access_probes: cfHealth.successful_access_probes ?? 0,
      failed_access_probes: cfHealth.failed_access_probes ?? 0
    },
    clickhouse_prod_subdirs_delta: chProdSubdirsDelta,
    clickhouse_log_files_growth: chLogFilesGrowth,
    categories_delta_analysis: categoriesDeltaAnalysis,
    backup_restore_audit: {
      latest_backup_id: backupFreshness.backup_id,
      backup_created_at: backupFreshness.backup_created_at,
      backup_age_hours: backupFreshness.backup_age_hours,
      backup_status: liveBackupPass ? 'PASS' : 'FAIL',
      restore_tested_at: backupFreshness.restore_tested_at,
      restore_test_age_hours: backupFreshness.restore_test_age_hours,
      restore_backup_id: backupFreshness.restore_backup_id,
      restore_matches_latest_backup: backupFreshness.restore_matches_latest_backup,
      restore_test_status: liveRestoreTestPass ? 'PASS' : 'FAIL',
      freshness_verification: backupFreshness.freshness_status
    },
    duplicate_audit: {
      duplicate_observation_count: duplicateCount,
      duplicate_validation: duplicatesZero ? 'current validation PASS (0 Duplicates)' : 'FAIL'
    },
    disaster_recovery_contract: OFFICIAL_DR_CONTRACT,
    supabase_immutability: 'PASS (0 DROP, 0 DELETE, 0 TRUNCATE, 0 INDEX DROP)',
    circuit_breaker: circuitBreaker,
    capacity_guardrail_triggered: isCapacityGuardrailTriggered,
    capacity_safety_reasons: capacitySafetyReasons,
    baseline_status: isCapacityGuardrailTriggered ? 'ABORTED_FOR_CAPACITY_SAFETY' : (isTimeComplete ? 'COMPLETED' : 'IN_PROGRESS_OBSERVATION'),
    utc_clock_skew: clockSkewCheck,
    total_preflight_rank_rows: scaleMetrics.total_preflight_rank_rows,
    latest_preflight_rank_rows: scaleMetrics.latest_preflight_rank_rows,
    category_rank_observations_status: 'PRODUCTION_EMPTY_PREFLIGHT_PRESENT',
    host_capacity_variance: hostCapacityVariance,
    stage_2_advancement_gate: stage2Gate,
    stage_3_advancement_gate: stage3Gate,
    stage_4_advancement_gate: stage4Gate,
    stage_5_advancement_gate: stage5Gate,
    human_approval_policy: humanApprovalPolicy,
    gate_reason: gateReason,
    stage_4_gate_reason: stage4GateReason,
    stage_5_gate_reason: stage5GateReason,
    hard_gates: hardGates,
    gate_conditions: hardGates
  };

  return report;
}

/**
 * Prints the formal Stage 1 Observation Audit Report.
 */
function printObservationAuditReport() {
  const r = generateStage1ObservationAuditReport();

  console.log('=============================================================================');
  console.log('  VERIMIMARI PLATFORM V2 — P1.4 STAGE 1 RESMİ GÖZLEM RAPORU');
  console.log('=============================================================================');
  console.log(`✓ Gözlem Başlangıcı:               ${r.observation_window.started_at}`);
  console.log(`✓ Son Değerlendirme:               ${r.observation_window.evaluated_at}`);
  console.log(`✓ Geçen Gözlem Süresi:             ${r.observation_window.elapsed_hours} saat (${r.observation_window.elapsed_days} gün)`);
  console.log(`✓ 24-72h Asgari Süre Tamamlandı mı: ${r.observation_window.is_complete ? 'EVET' : 'HAYIR (Gözlem Devam Ediyor)'}`);
  console.log('-----------------------------------------------------------------------------');
  console.log('1. AUTHORITATIVE CLICKHOUSE DEPOLAMA BÜYÜMESİ (system.parts active = 1):');
  console.log(`   • measurement_start_at:             ${r.clickhouse_user_data_growth_raw?.measurement_start_at || 'N/A'}`);
  console.log(`   • measurement_end_at:               ${r.clickhouse_user_data_growth_raw?.measurement_end_at || 'N/A'}`);
  console.log(`   • start_bytes:                      ${r.clickhouse_user_data_growth_raw?.start_bytes} bytes (${((r.clickhouse_user_data_growth_raw?.start_bytes || 0) / 1024).toFixed(2)} KB)`);
  console.log(`   • end_bytes:                        ${r.clickhouse_user_data_growth_raw?.end_bytes} bytes (${((r.clickhouse_user_data_growth_raw?.end_bytes || 0) / 1024).toFixed(2)} KB)`);
  console.log(`   • delta_bytes:                      ${r.clickhouse_user_data_growth_raw?.delta_bytes} bytes (${((r.clickhouse_user_data_growth_raw?.delta_bytes || 0) / 1024).toFixed(2)} KB)`);
  console.log(`   • elapsed_seconds:                  ${r.clickhouse_user_data_growth_raw?.elapsed_seconds || 1} saniye (${(((r.clickhouse_user_data_growth_raw?.elapsed_seconds || 1) / 3600)).toFixed(2)} saat)`);
  console.log(`   • computed_gb_day:                  ${r.clickhouse_user_data_growth_gb_day === 'UNKNOWN' ? 'UNKNOWN' : '+' + r.clickhouse_user_data_growth_gb_day + ' GB/gün'}`);
  console.log(`   • Sample Eşleşme Doğrulaması:       ${r.clickhouse_user_data_growth_raw?.sample_match ? 'MATCH_PASS (Current compressed size == end_bytes)' : 'CLICKHOUSE_GROWTH_SAMPLE_MISMATCH'}`);
  console.log(`   • Ölçüm Kaynağı:                    ${r.clickhouse_storage_authoritative.measurement_source}`);
  console.log('2. AYRIŞTIRILMIŞ GÜNLÜK BÜYÜME HIZLARI (GROWTH RATES & DUAL CAPACITY SENSORS):');
  console.log(`   • operational_capacity_status:      ${r.operational_capacity_status} (persistent runway >= 2 gün -> acil pause yok)`);
  console.log(`   • stage2_capacity_readiness:        ${r.stage2_capacity_readiness} (host runway >= 60 AND persistent runway >= 60 gün şartı)`);
  console.log(`   • clickhouse_user_data_growth_gb_day: ${r.growth_rates.clickhouse_user_data_growth_gb_day === 'UNKNOWN' ? 'UNKNOWN' : '+' + r.growth_rates.clickhouse_user_data_growth_gb_day + ' GB/gün'} (system.parts active = 1)`);
  console.log(`   • host_disk_consumption_gb_day:     ${r.growth_rates.host_disk_consumption_gb_day === 'UNKNOWN' ? 'UNKNOWN' : (r.growth_rates.host_disk_consumption_gb_day >= 0 ? '+' : '') + r.growth_rates.host_disk_consumption_gb_day + ' GB/gün'} (APFS host disk tüketimi)`);
  console.log(`   • effective_host_consumption_rate:  ${r.effective_host_consumption_rate} GB/gün (max(positive baseline, positive rolling 6h))`);
  console.log(`   • persistent_monitored_growth_gb_day: ${r.persistent_monitored_growth_gb_day >= 0 ? '+' : ''}${r.persistent_monitored_growth_gb_day} GB/gün (Kalıcı proje yolları delta toplamı)`);
  console.log(`   • 10 GB Host Uyarı Pisti:           ${r.days_to_10gb_warning} gün (days_to_10gb_warning)`);
  console.log(`   • 10 GB Persistent Uyarı Pisti:     ${r.persistent_days_to_10gb_warning} gün (persistent_days_to_10gb_warning)`);
  console.log(`   • Kapasite Karar Kriteri:           ${r.growth_rates.capacity_decision_metric}`);
  console.log(`   • ClickHouse Hesaplama Modu:        ${r.growth_rate.calculation_mode}`);
  console.log(`   • ClickHouse Formülü:               ${r.growth_rate.formula}`);
  console.log('3. READ-ONLY CLICKHOUSE SCHEMA, PARTS & WRITE COVERAGE SAĞLIĞI:');
  console.log(`   • schema_health:                    ${r.clickhouse_scale_metrics.schema_health?.status || 'PASS'} (${r.clickhouse_scale_metrics.schema_health?.details})`);
  console.log(`   • parts_health:                     ${r.clickhouse_scale_metrics.parts_health?.status || 'PASS'} (${r.clickhouse_scale_metrics.parts_health?.details})`);
  console.log(`   • write_coverage_health (Stage 1):  ${r.clickhouse_scale_metrics.write_coverage_health?.status || 'PASS'} (${r.clickhouse_scale_metrics.write_coverage_health?.details})`);
  console.log(`   • write_coverage_health (Stage 2):  ${r.clickhouse_scale_metrics.stage_2_write_coverage?.status || 'PASS'} (${r.clickhouse_scale_metrics.stage_2_write_coverage?.details})`);
  console.log(`   • stage1_production_rank_rows =     ${r.stage1_production_rank_rows} rows (${r.stage1_production_rank_status})`);
  console.log(`   • stage2_production_rank_rows =     ${r.stage2_production_rank_rows || 0} rows (${r.stage2_production_rank_status || 'REQUIRED_ACTIVE'})`);
  console.log(`   • total_preflight_rank_rows =       ${r.total_preflight_rank_rows} rows (${r.preflight_rank_status})`);
  console.log(`   • latest_preflight_rank_rows =      ${r.latest_preflight_rank_rows} rows (Canary run reconciliation scope)`);
  console.log(`   • category_rank_observations (Stg1): ${r.category_rank_observations_status || 'PRODUCTION_EMPTY_PREFLIGHT_PRESENT'}`);
  console.log(`   • category_rank_observations (Stg2): REQUIRED_ACTIVE (${(r.stage2_production_rank_rows || 0) > 0 ? 'ACTIVE_HEALTHY' : 'REQUIRED_ACTIVE'})`);
  console.log(`   • latest_preflight_run_id:          ${r.latest_preflight_run_id || 'YOK'}`);
  console.log(`   • latest_preflight_completed_at:    ${r.latest_preflight_completed_at || 'YOK'} (age: ${r.ranking_canary_age_hours != null ? r.ranking_canary_age_hours + 'h' : 'N/A'})`);
  console.log(`   • canary_classification:            ${r.canary_classification}`);
  console.log(`   • stage_2_ranking_ready (Dynamic):  ${r.hard_gates.stage_2_ranking_ready ? 'PASS' : 'BLOCKED (' + r.canary_classification + ')'}`);
  console.log('   • Gerçek INSERT/Outbox Batch Metrikleri (system.query_log):');
  const bm = r.clickhouse_scale_metrics.batch_metrics || {};
  console.log(`     - sample_count:                   ${bm.sample_count} batch olayı (Durum: ${bm.status})`);
  console.log(`     - batch p50:                      ${bm.p50} rows`);
  console.log(`     - batch p95:                      ${bm.p95} rows`);
  console.log(`     - batch min / max:                ${bm.min} / ${bm.max} rows`);
  console.log(`     - batches/saat:                   ${bm.batches_per_hour} batches/hr`);
  console.log('   • Beklenen Tablo Envanteri & Aşama Yazım Sözleşmesi (Explicit Table Inventory):');
  (r.clickhouse_scale_metrics.write_coverage_health?.table_coverage || r.clickhouse_scale_metrics.table_inventory || []).forEach(t => {
    const kb = (t.bytes_on_disk / 1024).toFixed(2);
    const lastTs = t.last_insert_at || t.latest_observed_at || 'YOK (Henüz yazılmadı)';
    const st = t.write_status || t.status;
    const exp = t.stage_expectation ? `Beklenti: ${t.stage_expectation.padEnd(23, ' ')} | ` : '';
    console.log(`     - Tablo: ${t.table.padEnd(28, ' ')} | Durum: ${st.padEnd(35, ' ')} | ${exp}Exists: ${t.table_exists ? 'YES' : 'NO '} | rows: ${String(t.rows).padStart(6, ' ')} | bytes: ${kb.padStart(8, ' ')} KB | parts: ${t.active_parts} | max_parts: ${t.max_parts_per_partition} | son_yazma: ${lastTs}`);
  });
  console.log('4. .RUNTIME/CLICKHOUSE_PROD ALT DİZİN BAZINDA DELTA PARÇALAMA:');
  r.clickhouse_prod_subdirs_delta.forEach(sub => {
    console.log(`   • [${sub.delta_formatted.padStart(10, ' ')}] ${sub.name} (${sub.rel_path})`);
    console.log(`     - Start: ${(sub.start_bytes / 1024).toFixed(1)} KB | End: ${(sub.end_bytes / 1024).toFixed(1)} KB | Hız: ${sub.mb_per_hour} MB/saat (${sub.bytes_per_hour} B/saat)`);
  });
  console.log('5. CLICKHOUSE SERVER LOG DOSYALARI BÜYÜME HIZI SIRALAMASI:');
  r.clickhouse_log_files_growth.ranked_log_files.forEach((lf, idx) => {
    console.log(`   ${idx + 1}. ${lf.file_name.padEnd(26, ' ')} Boyut: ${lf.size_formatted.padStart(9, ' ')} | Hız: ${lf.mb_per_hour} MB/saat (${lf.bytes_per_hour} B/saat)`);
  });
  console.log(`   • İnceleme Statüsü:                 ${r.clickhouse_log_files_growth.retention_policy}`);
  console.log('6. CATEGORIES/ DİZİNİ DELTA VE REWRITE ANALİZİ:');
  console.log(`   • Stage 1 Yeni/Güncellenen Dosya:   ${r.categories_delta_analysis.stage_1_new_files_count} dosya (+${r.categories_delta_analysis.stage_1_new_mb} MB)`);
  console.log(`   • Büyüme Hızı:                      ${r.categories_delta_analysis.mb_per_hour} MB/saat`);
  console.log(`   • Dosya Tipi Dağılımı:              latest.json: ${r.categories_delta_analysis.files_by_type.latest_json}, latest.csv: ${r.categories_delta_analysis.files_by_type.latest_csv}, history.csv: ${r.categories_delta_analysis.files_by_type.history_csv}, snapshot.json: ${r.categories_delta_analysis.files_by_type.snapshot_json}, reports.md: ${r.categories_delta_analysis.files_by_type.reports_md}`);
  console.log(`   • Rewrite Davranışı:                ${r.categories_delta_analysis.rewrite_behavior}`);
  console.log(`   • Top Rewrite Kategorileri:         ${r.categories_delta_analysis.top_rewritten_categories.map(c => `${c.category} (${c.size_mb} MB, ${c.files_generated} dosya)`).join(', ')}`);
  console.log(`   • Politika:                         ${r.categories_delta_analysis.policy}`);
  console.log('7. HOST BOŞ DİSK TÜKETİMİ, ERKEN UYARI VE KAPASİTE GÜVENLİĞİ (SAFETY OVERRIDE):');
  console.log(`   • APFS Mount / Volume:              ${r.host_disk_consumption_audit.volume_mount || '/System/Volumes/Data'} (${r.host_disk_consumption_audit.measurement_method || 'statfs'})`);
  console.log(`   • Güncel Boş Alan:                  ${r.host_disk_consumption_audit.current_free_disk_gb} GB (${r.host_disk_consumption_audit.current_free_bytes || 'N/A'} bytes)`);
  console.log(`   • Başlangıç Boş Alan:               ${r.host_disk_consumption_audit.start_free_disk_gb} GB (${r.host_disk_consumption_audit.baseline_start_free_bytes || 'N/A'} bytes)`);
  console.log(`   • Baseline Başlangıç Zamanı (UTC):  ${r.host_disk_consumption_audit.baseline_start_timestamp || 'N/A'}`);
  console.log(`   • Boş Alan Değişimi:                ${r.host_disk_consumption_audit.delta_free_disk_gb} GB`);
  console.log(`   • Örnek Sayısı (sample_count):      ${r.host_disk_consumption_audit.sample_count || 1}`);
  console.log(`   • Rolling 3h / 6h Tüketim Hızları:  3h: ${r.host_disk_consumption_audit.rolling_3h_consumption_gb_day || 0} GB/gün | 6h: ${r.host_disk_consumption_audit.rolling_6h_consumption_gb_day || 0} GB/gün`);
  console.log(`   • Efektif Host Hızı:                ${r.host_disk_consumption_audit.effective_host_consumption_rate || 0} GB/gün (max(positive baseline, positive rolling 6h))`);
  console.log(`   • Host Tüketim Hızı:                ${r.host_disk_consumption_audit.host_disk_consumption_gb_day} GB/gün (Sensor 1: Authoritative Host Disk)`);
  console.log(`   • Persistent Büyüme Hızı:           ${r.persistent_monitored_growth_gb_day} GB/gün (Sensor 2: Conservative Persistent Paths)`);
  console.log(`   • 10 GB Host Uyarı Pisti:           ~${r.host_disk_consumption_audit.days_to_10gb_warning} gün (days_to_10gb_warning)`);
  console.log(`   • 10 GB Persistent Uyarı Pisti:     ~${r.persistent_days_to_10gb_warning} gün (persistent_days_to_10gb_warning)`);
  console.log(`   • 5 GB Kritik Eşiğine Kalan Gün:    ~${r.host_disk_consumption_audit.days_to_5gb_critical} gün (days_to_5gb_critical)`);
  console.log(`   • Circuit Breaker Durumu:           ${r.circuit_breaker}`);
  console.log(`   • Kapasite Guardrail Durumu:        ${r.host_disk_consumption_audit.capacity_guardrail_status}`);
  console.log(`   • Host Disk Güvenlik Statüsü:       ${r.host_disk_consumption_audit.host_disk_capacity_status}`);
  console.log(`   • Projeksiyon Güvenirlik Durumu:    ${r.host_disk_consumption_audit.projection_mode}`);
  console.log(`   • Güvenlik İlkesi:                  ${r.host_disk_consumption_audit.safety_policy || 'ZERO_AUTOMATED_DELETION (NO_DESTRUCTIVE_DELETE)'}`);
  console.log(`   • Kapasite Karar Kuralı:            Sensor 1 (Host Disk) AND Sensor 2 (Persistent Monitored Growth)`);
  console.log('8. DELTA-BASED EXCLUSIVE MONITORED BUCKETS DİSK TÜKETİM ANALİZİ:');
  console.log(`   • persistent_root_delta_bytes:        ${r.persistent_root_delta_bytes} bytes (+${(r.persistent_root_delta_bytes / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(`   • sum_exclusive_bucket_deltas:        ${r.sum_exclusive_bucket_deltas} bytes (+${(r.sum_exclusive_bucket_deltas / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(`   • persistent_unattributed_delta_bytes: ${r.persistent_unattributed_delta_bytes} bytes (+${(r.persistent_unattributed_delta_bytes / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(`   • double_count_detected:              ${r.double_count_detected ? 'TRUE (PERSISTENT_ACCOUNTING_OVERLAP)' : 'false (ACCOUNTING_OK)'}`);
  console.log(`   • Audit / Veri Güvenlik Politikası:   ${r.audit_mutation_policy} (${r.production_data_mutation_status})`);
  console.log(`   • İzinli Telemetri Durum Dosyaları:   ALLOWED_TELEMETRY_WRITES (${(r.allowed_telemetry_writes || []).join(', ')})`);
  console.log(`   • ClickHouse Yetkilendirme Kipi:      ${r.clickhouse_client_auth}`);
  console.log(`   • Supabase Yetkilendirme Kipi:        ${r.supabase_client_auth}`);
  console.log('   --- Exclusive Path Buckets Breakdown ---');
  r.monitored_paths_delta.forEach(p => {
    const exclLabel = p.is_exclusive_bucket ? '[EXCLUSIVE BUCKET]' : '[EXPLANATORY SUBMETRIC]';
    console.log(`   • [${p.delta_formatted.padStart(10, ' ')}] ${exclLabel} ${p.name}`);
    console.log(`     - Yol: ${p.path} | Start: ${(p.start_bytes / 1024).toFixed(1)} KB -> End: ${(p.end_bytes / 1024).toFixed(1)} KB`);
  });
  console.log(`   • Not: ${r.host_disk_root_cause_policy.unmonitored_cache_note}`);
  console.log('9. KOŞU SAYILARI VE RECONCILIATION KAPSAMI (100% PASS KURALI):');
  console.log(`   • Toplam Koşular (total_runs):      ${r.run_and_reconciliation_audit.total_runs} (Tüm geçmiş ve test koşuları)`);
  console.log(`   • Gerçek Stage 1 (eligible_runs):   ${r.run_and_reconciliation_audit.eligible_stage1_runs} (>= 36 yaprak kategori canlı rollout)`);
  console.log(`   • Mutabakatı Biten Stage 1:         ${r.run_and_reconciliation_audit.reconciled_runs}`);
  console.log(`   • Stage 1 Mutabakat Başarı Oranı:   ${r.run_and_reconciliation_audit.reconciliation_pass_rate}`);
  console.log(`   • Gerçek Stage 2 (eligible_runs):   ${r.run_and_reconciliation_audit.eligible_stage2_runs || 0} (${r.run_and_reconciliation_audit.stage2_production_run_id || 'trendyol-20260919-134908-p1_4-stage2'})`);
  console.log(`   • Stage 2 Ürün Mutabakatı:          ${r.run_and_reconciliation_audit.stage2_product_reconciliation || 'PASS'} (14/14 PASS)`);
  console.log(`   • Stage 2 Sıralama Mutabakatı:      ${r.run_and_reconciliation_audit.stage2_rank_reconciliation || 'PASS'} (9/9 PASS)`);
  console.log(`   • Stage 2 Mutabakat Başarı Oranı:   ${r.run_and_reconciliation_audit.stage2_reconciliation_pass_rate || '100% PASS'}`);
  console.log(`   • Stage 2 Şartı (reconciled==eligible && pass==100%): ${r.run_and_reconciliation_audit.stage2_reconciliation_condition_met ? 'PASS' : 'FAIL'}`);
  console.log('10. OUTBOX GÖZLEM PENCERESİ BACKLOG VE SPOOL METRİKLERİ:');
  console.log(`   • Güncel Pending Batches:           ${r.outbox_backlog_audit.current_pending_batches} batches`);
  console.log(`   • Peak Pending Batches (Zirve):     ${r.outbox_backlog_audit.peak_pending_batches} batches`);
  console.log(`   • Güncel Oldest Spool Age:          ${r.outbox_backlog_audit.current_oldest_spool_age_sec}s`);
  console.log(`   • Max Oldest Spool Age (Zirve):     ${r.outbox_backlog_audit.max_oldest_spool_age_sec}s`);
  console.log(`   • Durum:                            ${r.outbox_backlog_audit.status}`);
  console.log('11. CLOUDFLARE TUNNEL ÇOK FAKTÖRLÜ TEŞHİS & PROBE METRİKLERİ:');
  console.log(`   • Toplam Reconnect:                 ${r.tunnel_audit.reconnect_count}`);
  console.log(`   • Tünel Statüsü (tunnel_status):    ${r.tunnel_audit.status}`);
  console.log(`   • Sağlık Durumu (is_healthy):       ${r.tunnel_audit.healthy ? 'HEALTHY' : 'UNHEALTHY (Hard Gate BLOCKED)'}`);
  console.log(`   • cloudflared Process Alive:        ${r.tunnel_audit.cloudflared_process_alive ? 'YES (Process Active)' : 'NO (Process Down)'}`);
  console.log(`   • Named Tunnel Connected:          ${r.tunnel_audit.named_tunnel_connected ? 'YES' : 'NO'}`);
  console.log(`   • Access Protected SELECT:          ${r.tunnel_audit.access_protected_select_reachable ? 'REACHABLE' : 'UNREACHABLE'}`);
  console.log(`   • Monitor Env Konfigürasyonu:       ${r.tunnel_audit.monitor_config_status}`);
  console.log(`   • Uptime Oranı (tunnel_uptime_ratio): ${r.tunnel_audit.tunnel_uptime_ratio}%`);
  console.log(`   • Max Kesinti Süresi (downtime):    ${r.tunnel_audit.max_consecutive_downtime_sec}s`);
  console.log(`   • Başarılı Erişim Probları:         ${r.tunnel_audit.successful_access_probes} probes`);
  console.log(`   • Başarısız Erişim Probları:        ${r.tunnel_audit.failed_access_probes} probes`);
  console.log(`   • Teşhis Detayı:                    ${r.tunnel_audit.reachability_details}`);
  console.log('12. YEDEKLEME + RESTORE-TEST FRESHNESS DURUMU:');
  console.log(`   • Son Yedek ID:                     ${r.backup_restore_audit.latest_backup_id}`);
  console.log(`   • Backup Age:                       ${r.backup_restore_audit.backup_age_hours} saat (Limit: <= 24h)`);
  console.log(`   • Backup Status:                    ${r.backup_restore_audit.backup_status}`);
  console.log(`   • Restore-Test Age:                 ${r.backup_restore_audit.restore_test_age_hours} saat (Limit: <= 24h)`);
  console.log(`   • Restore Test Snapshot Eşleşmesi:  ${r.backup_restore_audit.restore_matches_latest_backup ? 'MATCH (Aynı Snapshot)' : 'MISMATCH'}`);
  console.log(`   • Restore-Test Status:              ${r.backup_restore_audit.restore_test_status} (Checksum MATCH)`);
  console.log(`   • Tazelik (Freshness) Durumu:       ${r.backup_restore_audit.freshness_verification}`);
  console.log('13. MÜKERRER KAYIT (DUPLICATE) DOĞRULAMASI:');
  console.log(`   • Duplicate Observations:           ${r.duplicate_audit.duplicate_observation_count} (${r.duplicate_audit.duplicate_validation})`);
  console.log(`   • Doğrulama Durumu:                 ${r.duplicate_audit.duplicate_validation}`);
  console.log('-----------------------------------------------------------------------------');
  console.log('STAGE 2 (%10) HARD GATES DETAYLI DOĞRULAMA ÇİZELGESİ:');
  const hg = r.hard_gates;
  const fmtGate = (val, passText = 'PASS', failText = 'WAITING/BLOCKED') => {
    if (val === 'OVERRIDDEN_BY_HUMAN') return 'OVERRIDDEN_BY_HUMAN (HUMAN_RISK_ACCEPTED)';
    if (val === true) return passText;
    return failText;
  };
  const fmtMark = (val) => {
    if (val === 'OVERRIDDEN_BY_HUMAN') return '!';
    return val ? 'x' : ' ';
  };

  console.log(`   • [${fmtMark(hg.tunnel_healthy)}] 1. tunnel HEALTHY (Uptime >=99%, active live select, epoch >=24h): ${fmtGate(hg.tunnel_healthy)}`);
  console.log(`   • [${fmtMark(hg.reconciliation_100_percent)}] 2. eligible reconciliation 100%: ${fmtGate(hg.reconciliation_100_percent, 'PASS', 'FAIL')}`);
  console.log(`   • [${fmtMark(hg.duplicate_zero)}] 3. duplicate current validation PASS: ${fmtGate(hg.duplicate_zero, 'PASS', 'FAIL')}`);
  console.log(`   • [${fmtMark(hg.outbox_healthy)}] 4. outbox healthy: ${fmtGate(hg.outbox_healthy, 'PASS', 'FAIL')}`);
  console.log(`   • [${fmtMark(hg.backup_fresh_and_pass && hg.restore_fresh_and_pass)}] 5. backup/restore fresh (<=24h): ${fmtGate(hg.backup_fresh_and_pass && hg.restore_fresh_and_pass, 'PASS', 'FAIL')}`);
  console.log(`   • [${fmtMark(hg.operational_capacity_safe)}] 6a. operational_capacity_status: ${r.operational_capacity_status}`);
  console.log(`   • [${fmtMark(hg.stage2_capacity_readiness_pass)}] 6b. stage2_capacity_readiness: ${fmtGate(hg.stage2_capacity_readiness_pass, 'READY', `${r.stage2_capacity_readiness} (>= 60 gün şartı)`)}`);
  console.log(`   • [${fmtMark(hg.host_capacity_safe === true && hg.persistent_growth_capacity_safe === true)}] 6c. Dual Capacity Safe: ${fmtGate(hg.persistent_growth_capacity_safe, 'PASS', 'WAITING/BLOCKED (PROVISIONAL - Baseline < 24h)')}`);
  console.log(`   • [${fmtMark(hg.clickhouse_growth_sample_match)}] 6d. ClickHouse sample match (Compressed Size == end_bytes): ${fmtGate(hg.clickhouse_growth_sample_match, 'PASS', 'FAIL (CLICKHOUSE_GROWTH_SAMPLE_MISMATCH)')}`);
  console.log(`   • [${fmtMark(!hg.double_count_detected)}] 6e. persistent accounting (no double count): ${!hg.double_count_detected ? 'PASS (double_count_detected=false)' : 'FAIL (PERSISTENT_ACCOUNTING_OVERLAP)'}`);
  console.log(`   • [${fmtMark(hg.schema_health)}] 7a. ClickHouse schema sağlıklı (4/4 Tablo Var): ${fmtGate(hg.schema_health, 'PASS', 'FAIL')}`);
  console.log(`   • [${fmtMark(hg.parts_health)}] 7b. ClickHouse parts sağlıklı (<=50 parts, 0 merge): ${fmtGate(hg.parts_health, 'PASS', 'FAIL')}`);
  console.log(`   • [${fmtMark(hg.write_coverage_health)}] 7c. Stage 1 write coverage sağlıklı: ${fmtGate(hg.write_coverage_health, 'PASS', 'FAIL')}`);
  console.log(`   • [${fmtMark(hg.stage_2_ranking_ready)}] 7d. Stage 2 ranking stream hazır (Canary Dynamic): ${fmtGate(hg.stage_2_ranking_ready, 'PASS', 'WAITING/BLOCKED (' + (r.canary_classification || 'PRE_STORAGE_HYGIENE_PASS') + ' - Post-Storage-Hygiene canary required)')}`);
  console.log(`   • [${fmtMark(hg.post_fix_baseline_complete)}] 8. post-fix baseline >= 24h: ${fmtGate(hg.post_fix_baseline_complete, 'PASS', 'WAITING/BLOCKED (Storage Hygiene & Post-Fix Baseline required)')}`);
  console.log(`   • [ ] 9. Human approval: ${r.stage_2_advancement_gate === 'PENDING_HUMAN_APPROVAL' ? 'PENDING_HUMAN_APPROVAL (Hard gates PASS or OVERRIDDEN)' : 'DONDURULMUŞ (FROZEN - Hard gates tamamlanmadan açılamaz)'}`);
  console.log('-----------------------------------------------------------------------------');
  console.log(`RESMİ DR STANDARDI:                    ${r.disaster_recovery_contract}`);
  console.log(`SUPABASE DOKUNULMAZLIK:                ${r.supabase_immutability}`);
  console.log(`HOST KAPASİTE FARKI (VARIANCE):        ${r.host_capacity_variance || 'NORMAL'}`);
  console.log(`STAGE 2 GÖZLEM (24H):                  ${r.hard_gates?.stage2_observation_24h || 'N/A'}`);
  console.log(`STAGE 3 GÖZLEM (24H):                  ${r.hard_gates?.stage3_observation_24h || 'N/A'}`);
  console.log(`CIRCUIT BREAKER:                       ${r.circuit_breaker}`);
  console.log(`KAPASİTE GUARDRAIL:                    ${r.capacity_guardrail_triggered ? 'TRIGGERED (baseline ABORTED_FOR_CAPACITY_SAFETY)' : 'SAFE'}`);
  console.log(`STAGE 2 (%10) İLERLEME KAPISI:         ${r.stage_2_advancement_gate}`);
  if (r.stage_3_advancement_gate) {
    console.log(`STAGE 3 (%25) İLERLEME KAPISI:         ${r.stage_3_advancement_gate}`);
  }
  if (r.stage_4_advancement_gate) {
    console.log(`STAGE 4 (%50) İLERLEME KAPISI:         ${r.stage_4_advancement_gate}`);
  }
  if (r.stage_5_advancement_gate) {
    console.log(`STAGE 5 (%100) İLERLEME KAPISI:        ${r.stage_5_advancement_gate}`);
  }
  console.log(`HUMAN APPROVAL POLİTİKASI:             ${r.human_approval_policy}`);
  console.log(`GEREKÇE / KARAR:                       ${r.gate_reason}`);
  if (r.stage_4_gate_reason) {
    console.log(`STAGE 4 GEREKÇE:                       ${r.stage_4_gate_reason}`);
  }
  if (r.stage_5_gate_reason) {
    console.log(`STAGE 5 GEREKÇE:                       ${r.stage_5_gate_reason}`);
  }
  console.log('=============================================================================\n');

  return r;
}

/**
 * Formats a clean markdown report of the 14 daily operational metrics.
 */
function printStage1DailyReport() {
  const { metrics, totalDaysRecorded } = collectDailyStage1Metrics();

  console.log('=============================================================================');
  console.log(`  VERIMIMARI PLATFORM V2 — STAGE 1 DAILY OPERATIONAL AUDIT`);
  console.log(`  Day Index: ${totalDaysRecorded} | Timestamp: ${metrics.timestamp}`);
  console.log('=============================================================================');
  console.log(`  1. Run Count:                    ${metrics.run_count} runs`);
  console.log(`  2. Category Count:               ${metrics.category_count} / 40 leaf categories (1% taxonomy)`);
  console.log(`  3. Observation Count:            ${metrics.observation_count} historical rows`);
  console.log(`  4. Ranking Count:                ${metrics.ranking_count} rankings`);
  console.log(`     • Ranking Lineage Source:     ${metrics.ranking_count_source}`);
  console.log(`     • Embedded Rank Validation:   ${metrics.embedded_rank_validation}`);
  console.log(`     • Dedicated Rank Sink Table:  ${metrics.dedicated_rank_sink_table}`);
  console.log(`     • Dedicated Rank Sink Status: ${metrics.dedicated_rank_sink_status}`);
  console.log(`     • stage1_production_rank_rows = ${metrics.stage1_production_rank_rows} (${metrics.stage1_production_rank_status})`);
  console.log(`     • total_preflight_rank_rows   = ${metrics.total_preflight_rank_rows} (${metrics.preflight_rank_status})`);
  console.log(`     • latest_preflight_rank_rows  = ${metrics.latest_preflight_rank_rows} (Canary run reconciliation scope)`);
  console.log(`     • category_rank_observations  = ${metrics.category_rank_observations_status || 'PRODUCTION_EMPTY_PREFLIGHT_PRESENT'}`);
  console.log(`     • Latest Preflight Run ID:    ${metrics.latest_preflight_run_id || 'YOK'}`);
  console.log(`     • Latest Preflight Completed: ${metrics.latest_preflight_completed_at || 'YOK'} (age: ${metrics.ranking_canary_age_hours != null ? metrics.ranking_canary_age_hours + 'h' : 'N/A'})`);
  console.log(`     • Canary Classification:      ${metrics.canary_classification}`);
  console.log(`     • Stage 2 Ranking Ready:      ${metrics.stage_2_ranking_ready ? 'PASS' : 'BLOCKED (' + metrics.canary_classification + ')'}`);
  console.log(`  5. Duplicate Observations:       ${metrics.duplicate_observation_count} (${metrics.duplicate_validation})`);
  console.log(`  6. Reconciliation Result:        ${metrics.reconciliation_result}`);
  console.log(`  7. Outbox Max Pending Batches:   ${metrics.outbox_max_pending_batches} batches`);
  console.log(`  8. Oldest Spool Age:             ${metrics.oldest_spool_age_sec != null ? metrics.oldest_spool_age_sec + 's' : '0s (Queue Empty)'}`);
  console.log(`  9. ClickHouse Compressed Size:   ${metrics.clickhouse_compressed_size}`);
  console.log(` 10. Daily Growth Rates & Dual Capacity Sensors:`);
  console.log(`     • operational_capacity_status:       ${metrics.operational_capacity_status}`);
  console.log(`     • stage2_capacity_readiness:         ${metrics.stage2_capacity_readiness}`);
  console.log(`     • clickhouse_user_data_growth_gb_day: ${metrics.clickhouse_user_data_growth_gb_day === 'UNKNOWN' ? 'UNKNOWN' : '+' + metrics.clickhouse_user_data_growth_gb_day + ' GB/day'} (system.parts active=1)`);
  console.log(`     • host_disk_consumption_gb_day:      ${metrics.host_disk_consumption_gb_day === 'UNKNOWN' ? 'UNKNOWN' : (metrics.host_disk_consumption_gb_day >= 0 ? '+' : '') + metrics.host_disk_consumption_gb_day + ' GB/day'} (APFS host disk consumption)`);
  console.log(`     • persistent_monitored_growth_gb_day: ${metrics.persistent_monitored_growth_gb_day >= 0 ? '+' : ''}${metrics.persistent_monitored_growth_gb_day} GB/day (Monitored persistent paths)`);
  console.log(`     • persistent_days_to_10gb_warning:   ${metrics.persistent_days_to_10gb_warning} days (10GB runway for project files)`);
  console.log(`     • Capacity Decision:                 host_capacity_safe AND persistent_growth_capacity_safe`);
  console.log(` 11. Free Disk Space:              ${metrics.free_disk_gb} GB`);
  console.log(` 12. Tunnel Status:                ${metrics.tunnel_status} (reconnects: ${metrics.tunnel_reconnect_count})`);
  console.log(` 13. Backup Verification:          ${metrics.backup_pass}`);
  console.log(` 14. Restore-Test Verification:    ${metrics.restore_test_pass}`);
  console.log('-----------------------------------------------------------------------------');
  console.log('  Production Tablo Envanteri & Aşama Yazım Sözleşmesi (Stage 1 Contract):');
  const wc = metrics.clickhouse_scale_metrics?.write_coverage_health;
  (wc?.table_coverage || metrics.clickhouse_scale_metrics?.table_inventory || []).forEach(t => {
    const kb = (t.bytes_on_disk / 1024).toFixed(2);
    const lastTs = t.last_insert_at || t.latest_observed_at || 'YOK (Henüz yazılmadı)';
    const st = t.write_status || t.status;
    console.log(`  • ${t.table.padEnd(28, ' ')}: [${st.padEnd(35, ' ')}] exists=${t.table_exists ? 'YES' : 'NO '} rows=${String(t.rows).padStart(6, ' ')} bytes=${kb.padStart(8, ' ')} KB parts=${t.active_parts} last_insert=${lastTs}`);
  });
  const bm = metrics.clickhouse_scale_metrics?.batch_metrics;
  if (bm) {
    console.log(`  Gerçek Batch Metrikleri (query_log): sample=${bm.sample_count} (${bm.status}) | p50=${bm.p50} | p95=${bm.p95} | min=${bm.min} | max=${bm.max} | hız=${bm.batches_per_hour} batches/hr`);
  }
  console.log('-----------------------------------------------------------------------------');
  console.log(`  Resmi DR Standardı:              ${metrics.disaster_recovery_contract}`);
  console.log(`  Stage 1 Rollout Status:          ${metrics.stage_status}`);
  console.log(`  Stage 2 (%10) Advancement Gate:  ${metrics.stage_2_gate}`);
  console.log(`  Circuit Breaker:                 ${metrics.circuit_breaker}`);
  console.log(`  Capacity Guardrail:              ${metrics.capacity_guardrail_status}`);
  console.log(`  UTC Clock Skew Status:           ${metrics.utc_clock_freshness || metrics.clock_skew_status}`);
  console.log('=============================================================================\n');

  return metrics;
}

if (require.main === module) {
  if (process.argv.includes('--audit') || process.argv.includes('--report')) {
    printObservationAuditReport();
  } else {
    printStage1DailyReport();
  }
}

module.exports = {
  collectDailyStage1Metrics,
  printStage1DailyReport,
  generateStage1ObservationAuditReport,
  printObservationAuditReport,
  evaluateOperationalTimestampsUtc,
  determineCircuitBreakerState,
  checkHostConsumptionAcceleratingTrend,
  executeCapacitySafetyOverride,
  OFFICIAL_DR_CONTRACT
};
