// =============================================================================
// Verimimari Marketplace Data Platform V2 — Pre-Storage-Hygiene Baseline Archiver
// Safely archives the initial 24h baseline without overwriting live state files.
//
// Rules:
// 1. Verifies that elapsed observation hours >= 24.0 (or explicit confirmation).
// 2. Preserves baseline start/end timestamp, all growth metrics, 5 exclusive buckets,
//    reconciliation rate, outbox backlog, backup integrity, and test results.
// 3. Saves to .runtime/baseline_archive_pre_storage_hygiene.json
// 4. Classifies baseline as: COMPLETED_PRE_STORAGE_HYGIENE
// 5. Does NOT overwrite .runtime/host_disk_consumption_state.json
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const ARCHIVE_FILE = path.join(RUNTIME_DIR, 'baseline_archive_pre_storage_hygiene.json');
const HOST_STATE_FILE = path.join(RUNTIME_DIR, 'host_disk_consumption_state.json');

const { generateStage1ObservationAuditReport } = require('./stage_1_daily_monitor.cjs');

function archivePreStorageHygieneBaseline({ force = false } = {}) {
  console.log('=============================================================================');
  console.log('  VERİMİMARİ P1.4 — PRE-STORAGE-HYGIENE BASELINE ARCHIVAL');
  console.log('=============================================================================');

  if (!fs.existsSync(HOST_STATE_FILE)) {
    throw new Error(`Host disk consumption state file not found at: ${HOST_STATE_FILE}`);
  }

  const hostState = JSON.parse(fs.readFileSync(HOST_STATE_FILE, 'utf8'));
  const elapsedHours = hostState.elapsed_hours || 0;

  console.log(`Baseline Başlangıç:    ${hostState.baseline_start_timestamp}`);
  console.log(`Mevcut Gözlem Süresi:  ${elapsedHours} saat`);

  if (elapsedHours < 24.0 && !force) {
    console.warn(`\n⚠️  Baseline henüz 24 saati doldurmadı (${elapsedHours}h < 24.0h).`);
    console.warn(`   Kalan süre: Yaklaşık ${(24.0 - elapsedHours).toFixed(2)} saat.`);
    console.warn(`   Baseline tamamlanmadan arşivleme yapılamaz (zorlamak için --force kullanın).`);
    return {
      archived: false,
      reason: `BASELINE_IN_PROGRESS: ${elapsedHours}h elapsed (< 24h required)`,
      elapsed_hours: elapsedHours,
      hours_remaining: parseFloat((24.0 - elapsedHours).toFixed(2))
    };
  }

  console.log('\nGenerating read-only audit snapshot for archival...');
  const audit = generateStage1ObservationAuditReport();

  const archiveRecord = {
    archive_version: 1,
    classification: 'COMPLETED_PRE_STORAGE_HYGIENE',
    archived_at: new Date().toISOString(),
    baseline_window: {
      baseline_start_timestamp: hostState.baseline_start_timestamp,
      baseline_end_timestamp: audit.evaluation_timestamp,
      elapsed_hours: elapsedHours,
      elapsed_days: hostState.elapsed_days,
      sample_count: hostState.sample_count,
      status: elapsedHours >= 24.0 ? 'CALIBRATED_24H_BASELINE_COMPLETED' : 'PREMATURE_ARCHIVE_FORCED'
    },
    disk_metrics: {
      volume_mount: hostState.volume_mount,
      filesystem: hostState.filesystem,
      baseline_start_free_bytes: hostState.baseline_start_free_bytes,
      baseline_start_free_gb: hostState.baseline_start_free_gb,
      current_free_bytes: hostState.current_free_bytes,
      current_free_gb: hostState.current_free_gb,
      effective_host_consumption_rate: hostState.effective_host_consumption_rate,
      host_disk_consumption_gb_day: hostState.host_disk_consumption_gb_day,
      host_days_to_10gb_warning: audit.days_to_10gb_warning
    },
    persistent_monitored_growth: {
      persistent_monitored_growth_gb_day: audit.persistent_monitored_growth_gb_day,
      persistent_days_to_10gb_warning: audit.persistent_days_to_10gb_warning,
      persistent_root_delta_bytes: audit.persistent_root_delta_bytes,
      sum_exclusive_bucket_deltas: audit.sum_exclusive_bucket_deltas,
      persistent_unattributed_delta_bytes: audit.persistent_unattributed_delta_bytes,
      double_count_detected: audit.double_count_detected,
      accounting_status: audit.persistent_accounting_status,
      exclusive_buckets: audit.exclusive_buckets,
      explanatory_submetrics: audit.explanatory_submetrics
    },
    clickhouse_user_data_growth: {
      ch_user_data_growth_gb_day: audit.clickhouse_user_data_growth_gb_day,
      ch_compressed_size_bytes: audit.clickhouse_user_data_growth_raw?.end_bytes,
      sample_match: audit.clickhouse_growth_sample_match
    },
    capacity_statuses: {
      operational_capacity_status: audit.operational_capacity_status,
      stage2_capacity_readiness: audit.stage2_capacity_readiness
    },
    reconciliation: {
      reconciled_runs: audit.run_and_reconciliation_audit?.reconciled_runs ?? 0,
      eligible_stage1_runs: audit.run_and_reconciliation_audit?.eligible_stage1_runs ?? 0,
      reconciliation_pass_rate: audit.run_and_reconciliation_audit?.reconciliation_pass_rate ?? '0%',
      reconciliation_status: audit.hard_gates?.eligible_reconciliation ? 'PASS' : 'FAIL'
    },
    outbox: {
      backlog_batches: audit.outbox_backlog_audit?.current_pending_batches ?? 0,
      peak_pending_batches: audit.outbox_backlog_audit?.peak_pending_batches ?? 0,
      outbox_status: audit.outbox_backlog_audit?.status ?? (audit.hard_gates?.outbox_healthy ? 'PASS' : 'UNKNOWN')
    },
    backup_and_recovery: {
      official_dr_contract: audit.disaster_recovery_contract,
      last_backup_id: audit.backup_restore_audit?.latest_backup_id,
      last_backup_timestamp: audit.backup_restore_audit?.backup_created_at,
      backup_age_hours: audit.backup_restore_audit?.backup_age_hours,
      backup_pass: audit.backup_restore_audit?.backup_status,
      restore_test_pass: audit.backup_restore_audit?.restore_test_status,
      restore_matches_latest_backup: audit.backup_restore_audit?.restore_matches_latest_backup
    },
    stage_2_advancement_gate: audit.stage_2_advancement_gate,
    gate_reason: audit.gate_reason
  };

  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  fs.writeFileSync(ARCHIVE_FILE, JSON.stringify(archiveRecord, null, 2), 'utf8');

  console.log(`\n✓ Baseline başarıyla arşivlendi:`);
  console.log(`   • Dosya:         ${ARCHIVE_FILE}`);
  console.log(`   • Sınıflandırma: ${archiveRecord.classification}`);
  console.log(`   • Gözlem Süresi: ${archiveRecord.baseline_window.elapsed_hours} saat`);
  console.log(`   • Persistent:    +${archiveRecord.persistent_monitored_growth.persistent_monitored_growth_gb_day} GB/gün (Pist: ${archiveRecord.persistent_monitored_growth.persistent_days_to_10gb_warning} gün)`);
  console.log(`   • Double Count:  ${archiveRecord.persistent_monitored_growth.double_count_detected}`);
  console.log('=============================================================================\n');

  return {
    archived: true,
    archive_path: ARCHIVE_FILE,
    archive_record: archiveRecord
  };
}

if (require.main === module) {
  const force = process.argv.includes('--force');
  archivePreStorageHygieneBaseline({ force });
}

module.exports = {
  archivePreStorageHygieneBaseline,
  ARCHIVE_FILE
};
