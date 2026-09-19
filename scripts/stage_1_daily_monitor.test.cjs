const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  collectDailyStage1Metrics,
  generateStage1ObservationAuditReport,
  evaluateOperationalTimestampsUtc,
  determineCircuitBreakerState,
  checkHostConsumptionAcceleratingTrend,
  executeCapacitySafetyOverride,
  OFFICIAL_DR_CONTRACT
} = require('./stage_1_daily_monitor.cjs');
const { calculatePersistentMonitoredGrowth, getDirectorySizeBytes } = require('./lib/disk_growth_monitor.cjs');

test('collectDailyStage1Metrics collects all mandatory operational metrics with decoupled host disk & separated growth rates', () => {
  const { metrics } = collectDailyStage1Metrics({ dryRun: true });

  assert.ok(metrics.timestamp);
  assert.equal(typeof metrics.run_count, 'number');
  assert.equal(typeof metrics.category_count, 'number');
  assert.equal(typeof metrics.observation_count, 'number');
  assert.equal(typeof metrics.duplicate_observation_count, 'number');
  assert.equal(metrics.duplicate_observation_count, 0); // Current validation PASS
  assert.equal(metrics.duplicate_validation, 'current validation PASS (0 Duplicates)');
  assert.match(metrics.reconciliation_result, /PASS/);
  assert.equal(metrics.outbox_max_pending_batches, 0);

  // Separated & Decoupled Growth Rates & Raw ClickHouse Telemetry
  assert.equal(typeof metrics.clickhouse_user_data_growth_gb_day, 'number');
  assert.ok(metrics.clickhouse_user_data_growth_gb_day < 0.05); // Fixed unit bug: never hardcoded +0.1
  assert.ok(metrics.clickhouse_user_data_growth_raw);
  assert.equal(typeof metrics.clickhouse_user_data_growth_raw.start_bytes, 'number');
  assert.equal(typeof metrics.clickhouse_user_data_growth_raw.end_bytes, 'number');
  assert.equal(typeof metrics.clickhouse_user_data_growth_raw.delta_bytes, 'number');
  assert.equal(typeof metrics.clickhouse_user_data_growth_raw.elapsed_seconds, 'number');
  assert.equal(typeof metrics.clickhouse_user_data_growth_raw.computed_gb_day, 'number');

  // Persistent Host Disk Tracking State
  assert.ok(metrics.baseline_start_timestamp);
  assert.equal(typeof metrics.baseline_start_free_bytes, 'number');
  assert.equal(typeof metrics.current_free_bytes, 'number');
  assert.equal(typeof metrics.sample_count, 'number');
  assert.equal(typeof metrics.effective_host_consumption_rate, 'number');
  assert.equal(typeof metrics.host_disk_consumption_gb_day, 'number');
  assert.equal(typeof metrics.monitored_paths_growth_gb_day, 'number');
  assert.equal(typeof metrics.clickhouse_storage_bytes, 'number');
  assert.equal(typeof metrics.free_disk_gb, 'number');
  assert.ok(metrics.free_disk_gb > 5.0); // Above critical threshold
  assert.equal(typeof metrics.days_to_10gb_warning, 'number');
  assert.equal(typeof metrics.days_to_5gb_critical, 'number');
  assert.match(metrics.safety_policy, /ZERO_AUTOMATED_DELETION/);

  // 4-Tier Host Capacity & Circuit Breaker
  assert.ok(['SAFE', 'CAPACITY_WARNING', 'CAPACITY_PAUSE'].includes(metrics.operational_capacity_status));
  assert.ok(['READY', 'BLOCKED'].includes(metrics.stage2_capacity_readiness));
  assert.ok(['SAFE', 'CAPACITY_WARNING', 'CAPACITY_PAUSE', 'CRITICAL', 'CAPACITY_GUARDRAIL_TRIGGERED'].includes(metrics.host_disk_capacity_status));
  assert.ok(['NORMAL', 'CAPACITY_WARNING', 'CAPACITY_PAUSE', 'CRITICAL'].includes(metrics.circuit_breaker));

  // Ranking Preflight Segregation
  assert.equal(metrics.stage1_production_rank_rows, 0);
  assert.ok(metrics.total_preflight_rank_rows > 0);
  assert.ok(typeof metrics.latest_preflight_rank_rows === 'number' && metrics.latest_preflight_rank_rows > 0);
  assert.equal(metrics.stage1_production_rank_status, 'EXPECTED');
  assert.equal(metrics.preflight_rank_status, 'PRE-FLIGHT VALIDATION ONLY');
  assert.equal(metrics.category_rank_observations_status, 'PRODUCTION_EMPTY_PREFLIGHT_PRESENT');
  assert.equal(typeof metrics.stage_2_ranking_ready, 'boolean');
  assert.ok(['PRE_STORAGE_HYGIENE_PASS', 'POST_STORAGE_HYGIENE_PASS'].includes(metrics.canary_classification));
  assert.ok(metrics.latest_preflight_run_id);
  assert.ok(metrics.latest_preflight_completed_at);
  assert.equal(typeof metrics.ranking_canary_age_hours, 'number');

  assert.equal(metrics.backup_pass, 'PASS');
  assert.equal(metrics.restore_test_pass, 'PASS');
  assert.match(metrics.stage_2_gate, /FROZEN/);
  assert.equal(metrics.disaster_recovery_contract, OFFICIAL_DR_CONTRACT);
});

test('generateStage1ObservationAuditReport computes all refined observation criteria and safety guardrails', () => {
  const report = generateStage1ObservationAuditReport();

  // 1. Authoritative ClickHouse Storage Delta (system.parts active = 1)
  assert.ok(report.clickhouse_storage_authoritative);
  assert.equal(typeof report.clickhouse_storage_authoritative.start_clickhouse_bytes, 'number');
  assert.equal(typeof report.clickhouse_storage_authoritative.end_clickhouse_bytes, 'number');
  assert.equal(typeof report.clickhouse_storage_authoritative.delta_bytes, 'number');
  assert.equal(typeof report.clickhouse_storage_authoritative.delta_mb, 'number');
  assert.match(report.clickhouse_storage_authoritative.measurement_source, /active = 1/);

  // Raw ClickHouse Telemetry (time-aligned atomic snapshot series, no fallback)
  assert.ok(report.clickhouse_user_data_growth_raw);
  assert.equal(typeof report.clickhouse_user_data_growth_raw.measurement_start_at, 'string');
  assert.equal(typeof report.clickhouse_user_data_growth_raw.measurement_end_at, 'string');
  assert.equal(typeof report.clickhouse_user_data_growth_raw.start_bytes, 'number');
  assert.equal(typeof report.clickhouse_user_data_growth_raw.end_bytes, 'number');
  assert.equal(typeof report.clickhouse_user_data_growth_raw.delta_bytes, 'number');
  assert.equal(typeof report.clickhouse_user_data_growth_raw.elapsed_seconds, 'number');
  assert.equal(typeof report.clickhouse_user_data_growth_raw.computed_gb_day, 'number');
  assert.equal(report.clickhouse_growth_sample_match, true);
  assert.ok(report.clickhouse_user_data_growth_gb_day < 0.05);

  // 2. Separated Growth Rates, Persistent Host State & Dual Capacity Sensors
  assert.ok(report.growth_rates);
  assert.equal(typeof report.growth_rates.clickhouse_user_data_growth_gb_day, 'number');
  assert.equal(typeof report.growth_rates.host_disk_consumption_gb_day, 'number');
  assert.equal(typeof report.growth_rates.effective_host_consumption_rate, 'number');
  assert.equal(typeof report.growth_rates.persistent_monitored_growth_gb_day, 'number');
  assert.equal(typeof report.growth_rates.persistent_days_to_10gb_warning, 'number');
  assert.equal(typeof report.growth_rates.monitored_paths_growth_gb_day, 'number');
  assert.match(report.growth_rates.capacity_decision_metric, /effective_host_consumption_rate/);
  assert.match(report.growth_rates.capacity_decision_metric, /persistent_growth_capacity_safe/);

  // 3. Host Free-Disk Capacity & Safety Guardrail (Decoupled from ClickHouse delta)
  assert.ok(report.host_disk_consumption_audit);
  assert.equal(typeof report.host_disk_consumption_audit.current_free_disk_gb, 'number');
  assert.equal(typeof report.host_disk_consumption_audit.delta_free_disk_gb, 'number');
  assert.equal(typeof report.host_disk_consumption_audit.host_disk_consumption_gb_day, 'number');
  assert.equal(typeof report.host_disk_consumption_audit.effective_host_consumption_rate, 'number');
  assert.ok(report.host_disk_consumption_audit.baseline_start_timestamp);
  assert.equal(typeof report.host_disk_consumption_audit.baseline_start_free_bytes, 'number');
  assert.equal(typeof report.host_disk_consumption_audit.current_free_bytes, 'number');
  assert.equal(typeof report.host_disk_consumption_audit.sample_count, 'number');
  assert.match(report.host_disk_consumption_audit.safety_policy, /ZERO_AUTOMATED_DELETION/);
  assert.equal(typeof report.host_disk_consumption_audit.days_to_10gb_warning, 'number');
  assert.equal(typeof report.host_disk_consumption_audit.days_to_5gb_critical, 'number');
  assert.ok(['SAFE', 'CAPACITY_WARNING', 'CAPACITY_PAUSE', 'CRITICAL', 'CAPACITY_GUARDRAIL_TRIGGERED'].includes(report.host_disk_consumption_audit.host_disk_capacity_status));
  assert.match(report.host_disk_consumption_audit.capacity_decision_rule, /host_disk_consumption_gb_day/);

  // Strict ISO-8601 UTC timestamp format assertion
  const utcRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  report.clickhouse_scale_metrics.table_inventory.forEach(t => {
    if (t.last_insert_at) assert.match(t.last_insert_at, utcRegex, `${t.table} last_insert_at must be strict UTC ending in Z`);
    if (t.latest_observed_at) assert.match(t.latest_observed_at, utcRegex, `${t.table} latest_observed_at must be strict UTC ending in Z`);
  });

  // 4. Delta-Based Monitored Paths Analysis (start_bytes, end_bytes, delta_bytes per path)
  assert.ok(report.monitored_paths_delta);
  assert.ok(Array.isArray(report.monitored_paths_delta));
  assert.ok(report.monitored_paths_delta.length >= 4);
  for (const p of report.monitored_paths_delta) {
    assert.equal(typeof p.name, 'string');
    assert.equal(typeof p.path, 'string');
    assert.equal(typeof p.start_bytes, 'number');
    assert.equal(typeof p.end_bytes, 'number');
    assert.equal(typeof p.delta_bytes, 'number');
    assert.ok(p.delta_bytes >= 0);
    assert.equal(typeof p.delta_formatted, 'string');
  }
  assert.equal(report.host_disk_drop_breakdown.deletion_policy, 'STRICT_READ_ONLY (Hiçbir dosya otomatik silinmez)');
  assert.equal(report.host_disk_drop_breakdown.methodology, 'DELTA_BASED (start_bytes, end_bytes, delta_bytes per monitored path)');

  // 5. Read-only ClickHouse Scale Metrics & Health Segregation
  assert.ok(report.clickhouse_scale_metrics);
  assert.equal(typeof report.clickhouse_scale_metrics.active_parts_count, 'number');
  assert.equal(typeof report.clickhouse_scale_metrics.max_parts_per_partition, 'number');
  assert.equal(typeof report.clickhouse_scale_metrics.merges_running, 'number');
  assert.equal(typeof report.clickhouse_scale_metrics.insert_batch_rows_p50, 'number');
  assert.equal(typeof report.clickhouse_scale_metrics.insert_batch_rows_p95, 'number');
  assert.equal(typeof report.clickhouse_scale_metrics.inserts_per_hour, 'number');

  // Real Batch Metrics (system.query_log real INSERT events)
  assert.ok(report.clickhouse_scale_metrics.batch_metrics);
  assert.ok(report.clickhouse_scale_metrics.batch_metrics.sample_count >= 5);
  assert.equal(report.clickhouse_scale_metrics.batch_metrics.status, 'SUFFICIENT_SAMPLE');
  assert.ok([25, 50].includes(report.clickhouse_scale_metrics.batch_metrics.p50));
  assert.ok([25, 50].includes(report.clickhouse_scale_metrics.batch_metrics.p95));
  assert.ok(typeof report.clickhouse_scale_metrics.batch_metrics.min === 'number' && report.clickhouse_scale_metrics.batch_metrics.min > 0);
  assert.ok([25, 50].includes(report.clickhouse_scale_metrics.batch_metrics.max));

  // Health segregation: schema_health, parts_health, write_coverage_health
  assert.equal(report.clickhouse_scale_metrics.schema_health.status, 'PASS');
  assert.equal(report.clickhouse_scale_metrics.schema_health.existing_tables_count, 4);
  assert.equal(report.clickhouse_scale_metrics.parts_health.status, 'PASS');
  assert.equal(report.clickhouse_scale_metrics.write_coverage_health.status, 'PASS');
  assert.equal(report.clickhouse_scale_metrics.write_coverage_health.stage, 1);

  // In Stage 1, category_rank_observations is PRODUCTION_EMPTY_PREFLIGHT_PRESENT
  const rankTable = report.clickhouse_scale_metrics.write_coverage_health.table_coverage.find(t => t.table === 'category_rank_observations');
  assert.ok(rankTable);
  assert.equal(rankTable.write_status, 'PRODUCTION_EMPTY_PREFLIGHT_PRESENT');
  assert.equal(rankTable.stage1_production_rank_rows, 0);
  assert.ok(rankTable.preflight_rank_rows > 0);
  assert.equal(rankTable.stage1_production_status, 'EXPECTED');
  assert.equal(rankTable.preflight_validation_status, 'PRE-FLIGHT VALIDATION ONLY');
  assert.equal(rankTable.coverage_pass, true);

  // Segregated Preflight Metrics at report top-level
  assert.equal(report.stage1_production_rank_rows, 0);
  assert.ok(report.total_preflight_rank_rows > 0);
  assert.ok(typeof report.latest_preflight_rank_rows === 'number' && report.latest_preflight_rank_rows > 0);
  assert.equal(report.category_rank_observations_status, 'PRODUCTION_EMPTY_PREFLIGHT_PRESENT');
  assert.ok(report.latest_preflight_run_id);
  assert.ok(report.latest_preflight_completed_at);
  assert.equal(typeof report.ranking_canary_age_hours, 'number');
  assert.ok(report.ranking_canary_age_hours <= 24.0);
  assert.equal(report.stage1_production_rank_status, 'EXPECTED');
  assert.equal(report.preflight_rank_status, 'PRE-FLIGHT VALIDATION ONLY');

  // Preflight Ranking Canary State & Lineage (PRE_STORAGE_HYGIENE_PASS blocks stage_2_ranking_ready)
  assert.ok(report.stage_2_preflight_ranking_canary);
  assert.ok(['PRE_STORAGE_HYGIENE_PASS', 'POST_STORAGE_HYGIENE_PASS'].includes(report.stage_2_preflight_ranking_canary.canary_classification));
  assert.equal(typeof report.stage_2_preflight_ranking_canary.stage_2_ranking_ready, 'boolean');
  assert.ok(report.stage_2_preflight_ranking_canary.rankings_count > 0);
  assert.equal(report.stage_2_preflight_ranking_canary.duplicates, 0);
  assert.equal(report.stage_2_preflight_ranking_canary.outbox_backlog, 0);
  assert.equal(report.stage_2_preflight_ranking_canary.reconciliation_status, 'PASS');

  // 6. Run Count vs. Eligible Stage 1 Runs vs. Reconciled Runs & Lineage
  assert.ok(report.run_and_reconciliation_audit);
  assert.ok(report.run_and_reconciliation_audit.total_runs >= 1);
  assert.ok(report.run_and_reconciliation_audit.eligible_stage1_runs >= 1);
  assert.equal(report.run_and_reconciliation_audit.reconciled_runs, report.run_and_reconciliation_audit.eligible_stage1_runs);
  assert.equal(report.run_and_reconciliation_audit.reconciliation_pass_rate_number, 100);
  assert.equal(report.run_and_reconciliation_audit.stage2_reconciliation_condition_met, true);

  // 7. Outbox Window Metrics
  assert.ok(report.outbox_backlog_audit);
  assert.equal(typeof report.outbox_backlog_audit.peak_pending_batches, 'number');
  assert.equal(typeof report.outbox_backlog_audit.max_oldest_spool_age_sec, 'number');
  assert.equal(report.outbox_backlog_audit.peak_pending_batches, 0);

  // 8. 4-Tier Circuit Breaker
  assert.ok(['NORMAL', 'CAPACITY_WARNING', 'CAPACITY_PAUSE', 'CRITICAL'].includes(report.circuit_breaker));

  // 9. Stage 2 Gating Freeze Enforced (< 24h) & Hard Gates
  assert.ok(['SAFE', 'CAPACITY_WARNING'].includes(report.operational_capacity_status));
  assert.ok(['READY', 'BLOCKED'].includes(report.stage2_capacity_readiness));
  assert.equal(report.hard_gates.operational_capacity_safe, true);
  assert.ok([true, false].includes(report.hard_gates.stage2_capacity_readiness_pass));
  assert.equal(report.stage_2_advancement_gate, 'FROZEN');
  assert.match(report.human_approval_policy, /BLOCKED/);
  assert.match(report.gate_reason, /Stage 2 kesin olarak FROZEN/);
  assert.equal(report.hard_gates.schema_health, true);
  assert.equal(report.hard_gates.parts_health, true);
  assert.equal(report.hard_gates.write_coverage_health, true);
  assert.equal(typeof report.hard_gates.stage_2_ranking_ready, 'boolean');
  assert.equal(report.hard_gates.post_fix_baseline_complete, false);
  assert.equal(report.disaster_recovery_contract, OFFICIAL_DR_CONTRACT);

  // 10. Persistent Monitored Path Accounting & Double Count Guard
  assert.equal(report.audit_mutation_policy, 'DATA_SINK_READ_ONLY_AUDIT');
  assert.equal(report.production_data_mutation_status, 'NO_PRODUCTION_DATA_MUTATION');
  assert.ok(Array.isArray(report.allowed_telemetry_writes));
  assert.match(report.clickhouse_client_auth, /READER_ONLY_CREDENTIAL/);
  assert.match(report.supabase_client_auth, /READER_ONLY_RESTRICTED/);
  assert.equal(typeof report.persistent_root_delta_bytes, 'number');
  assert.equal(typeof report.sum_exclusive_bucket_deltas, 'number');
  assert.equal(typeof report.persistent_unattributed_delta_bytes, 'number');
  assert.equal(report.double_count_detected, false);
  assert.equal(report.persistent_accounting_status, 'ACCOUNTING_OK');
  assert.equal(report.hard_gates.persistent_accounting_safe, true);
  assert.equal(report.hard_gates.double_count_detected, false);
  assert.ok(report.sum_exclusive_bucket_deltas <= report.persistent_root_delta_bytes + 10 * 1024 * 1024);

  // Verify overlap guard detects accounting discrepancy when sum exceeds root + tolerance
  const currentRootBytes = getDirectorySizeBytes(path.resolve(__dirname, '..'));
  const overlapCheck = calculatePersistentMonitoredGrowth({
    persistentRootStartBytes: currentRootBytes,
    simulatedBucketDeltas: 50 * 1024 * 1024
  });
  assert.equal(overlapCheck.double_count_detected, true);
  assert.equal(overlapCheck.accounting_status, 'PERSISTENT_ACCOUNTING_OVERLAP');
});

test('evaluateOperationalTimestampsUtc enforces strict UTC and flags CLOCK_SKEW_DETECTED on future timestamps', () => {
  const nowIso = new Date().toISOString();
  const pastIso = new Date(Date.now() - 3600000).toISOString();
  const futureIso = new Date(Date.now() + 120000).toISOString(); // 2 minutes in future

  const validResult = evaluateOperationalTimestampsUtc({
    auditTimestamp: nowIso,
    lastInsertAt: pastIso
  });
  assert.equal(validResult.clock_skew_detected, false);
  assert.equal(validResult.status, 'PASS');
  assert.equal(validResult.evaluated.auditTimestamp.status, 'VALID_UTC');

  const withinToleranceIso = new Date(Date.now() + 30000).toISOString(); // 30s in future (<= 60s)
  const tolResult = evaluateOperationalTimestampsUtc({
    auditTimestamp: nowIso,
    withinTol: withinToleranceIso
  });
  assert.equal(tolResult.clock_skew_detected, false);
  assert.equal(tolResult.status, 'PASS');
  assert.equal(tolResult.evaluated.withinTol.status, 'FUTURE_TIMESTAMP_WITHIN_TOLERANCE');
  assert.equal(tolResult.evaluated.withinTol.ageHours, 0);

  const skewResult = evaluateOperationalTimestampsUtc({
    auditTimestamp: nowIso,
    futureTimestamp: futureIso
  });
  assert.equal(skewResult.clock_skew_detected, true);
  assert.equal(skewResult.status, 'CLOCK_SKEW_DETECTED');
  assert.equal(skewResult.evaluated.futureTimestamp.status, 'CLOCK_SKEW_DETECTED');
  assert.ok(skewResult.skewed_timestamps.some(t => t.includes('futureTimestamp')));
});

test('determineCircuitBreakerState evaluates all 4 tiers correctly', () => {
  // 1. NORMAL: free disk > 20GB, days_to_10gb >= 7, no accelerating trend, no critical issues
  const normalState = determineCircuitBreakerState({
    freeDiskGb: 35.0,
    daysTo10gbWarning: 30,
    isAcceleratingTrend: false,
    criticalIssues: []
  });
  assert.equal(normalState, 'NORMAL');

  // 2. CAPACITY_WARNING: free disk <= 20GB or days_to_10gb < 7
  const warningState1 = determineCircuitBreakerState({
    freeDiskGb: 19.5,
    daysTo10gbWarning: 15,
    isAcceleratingTrend: false,
    criticalIssues: []
  });
  assert.equal(warningState1, 'CAPACITY_WARNING');

  const warningState2 = determineCircuitBreakerState({
    freeDiskGb: 25.0,
    daysTo10gbWarning: 5,
    isAcceleratingTrend: false,
    criticalIssues: []
  });
  assert.equal(warningState2, 'CAPACITY_WARNING');

  // 3. CAPACITY_PAUSE: free disk <= 15GB, days_to_10gb < 2, or accelerating trend
  const pauseState1 = determineCircuitBreakerState({
    freeDiskGb: 14.8,
    daysTo10gbWarning: 10,
    isAcceleratingTrend: false,
    criticalIssues: []
  });
  assert.equal(pauseState1, 'CAPACITY_PAUSE');

  const pauseState2 = determineCircuitBreakerState({
    freeDiskGb: 25.0,
    daysTo10gbWarning: 1,
    isAcceleratingTrend: false,
    criticalIssues: []
  });
  assert.equal(pauseState2, 'CAPACITY_PAUSE');

  const pauseState3 = determineCircuitBreakerState({
    freeDiskGb: 25.0,
    daysTo10gbWarning: 20,
    isAcceleratingTrend: true,
    criticalIssues: []
  });
  assert.equal(pauseState3, 'CAPACITY_PAUSE');

  // 4. CRITICAL: free disk < 5GB or critical issues (duplicates, clock skew, etc.)
  const criticalState1 = determineCircuitBreakerState({
    freeDiskGb: 4.2,
    daysTo10gbWarning: 1,
    isAcceleratingTrend: false,
    criticalIssues: []
  });
  assert.equal(criticalState1, 'CRITICAL');

  const criticalState2 = determineCircuitBreakerState({
    freeDiskGb: 35.0,
    daysTo10gbWarning: 30,
    isAcceleratingTrend: false,
    criticalIssues: ['CLOCK_SKEW_DETECTED']
  });
  assert.equal(criticalState2, 'CRITICAL');

  // 5. Metric Uncertainty never fails open to NORMAL: returns CAPACITY_WARNING / METRIC_UNCERTAIN
  const uncertainRate = determineCircuitBreakerState({
    freeDiskGb: 35.0,
    daysTo10gbWarning: 30,
    hostRate: 'UNKNOWN'
  });
  assert.equal(uncertainRate, 'CAPACITY_WARNING / METRIC_UNCERTAIN');

  const uncertainMetric = determineCircuitBreakerState({
    freeDiskGb: 35.0,
    daysTo10gbWarning: 30,
    isMetricUncertain: true
  });
  assert.equal(uncertainMetric, 'CAPACITY_WARNING / METRIC_UNCERTAIN');

  const invalidClock = determineCircuitBreakerState({
    freeDiskGb: 35.0,
    daysTo10gbWarning: 30,
    clockStateInvalid: true
  });
  assert.equal(invalidClock, 'CAPACITY_WARNING / METRIC_UNCERTAIN');

  const volumeChanged = determineCircuitBreakerState({
    freeDiskGb: 35.0,
    daysTo10gbWarning: 30,
    volumeChanged: true
  });
  assert.equal(volumeChanged, 'CAPACITY_WARNING / METRIC_UNCERTAIN');

  const baselineDisappeared = determineCircuitBreakerState({
    freeDiskGb: 35.0,
    daysTo10gbWarning: 30,
    baselineStateDisappeared: true
  });
  assert.equal(baselineDisappeared, 'CAPACITY_WARNING / METRIC_UNCERTAIN');

  // 6. Persistent runway < 2 days triggers CAPACITY_PAUSE
  const persistentPause = determineCircuitBreakerState({
    freeDiskGb: 35.0,
    daysTo10gbWarning: 30,
    persistentDaysTo10gbWarning: 1,
    isAcceleratingTrend: false,
    criticalIssues: []
  });
  assert.equal(persistentPause, 'CAPACITY_PAUSE');

  // 7. ClickHouse sample mismatch triggers CAPACITY_WARNING / METRIC_UNCERTAIN
  const chMismatch = determineCircuitBreakerState({
    freeDiskGb: 35.0,
    daysTo10gbWarning: 30,
    clickhouseSampleMismatch: true
  });
  assert.equal(chMismatch, 'CAPACITY_WARNING / METRIC_UNCERTAIN');
});

test('checkHostConsumptionAcceleratingTrend detects 3 consecutive positive and accelerating consumption measurements', () => {
  // Non-accelerating (stable)
  const stableLog = [
    { host_disk_consumption_gb_day: 0.5 },
    { host_disk_consumption_gb_day: 0.5 },
    { host_disk_consumption_gb_day: 0.5 }
  ];
  assert.equal(checkHostConsumptionAcceleratingTrend(stableLog).accelerating, false);

  // Positive and accelerating: c_t > c_{t-1} > c_{t-2} > 0
  const acceleratingLog = [
    { host_disk_consumption_gb_day: 0.2 },
    { host_disk_consumption_gb_day: 0.8 },
    { host_disk_consumption_gb_day: 1.5 }
  ];
  const accResult = checkHostConsumptionAcceleratingTrend(acceleratingLog);
  assert.equal(accResult.accelerating, true);
  assert.match(accResult.details, /pozitif ve hızlanan/);
});

test('executeCapacitySafetyOverride pauses crawlers and guarantees zero automated deletion', () => {
  const state = executeCapacitySafetyOverride({
    reason: 'TEST_TRIGGER',
    freeDiskGb: 14.5,
    daysTo10gbWarning: 1,
    acceleratingTrend: false,
    isTest: true
  });

  assert.equal(state.crawlers_paused, true);
  assert.equal(state.pause_reason, 'CAPACITY_GUARDRAIL_TRIGGERED');
  assert.match(state.safety_policy, /ZERO_AUTOMATED_DELETION/);
  assert.match(state.safety_policy, /NO_DESTRUCTIVE_DELETE/);
});

test('runStage2PreflightRankingCanary succeeds with 5/5 mandatory validations without mutating production ClickHouse', async () => {
  const { runStage2PreflightRankingCanary } = require('./stage_2_preflight_ranking_canary.cjs');

  const result = await runStage2PreflightRankingCanary({ useFixture: true, verbose: false, isTest: true });
  assert.equal(result.canary_status, 'PASS');
  assert.ok(['PRE_STORAGE_HYGIENE_PASS', 'POST_STORAGE_HYGIENE_PASS'].includes(result.canary_classification));
  assert.equal(result.canary_checks_pass, true);
  assert.equal(result.stage_2_ranking_ready, false);
  assert.equal(result.checks.rows_greater_than_zero, true);
  assert.equal(result.checks.active_parts_greater_than_zero, true);
  assert.equal(result.checks.duplicate_rank_observation_zero, true);
  assert.equal(result.checks.direct_reconciliation_pass, true);
  assert.equal(result.checks.outbox_backlog_zero, true);
  assert.equal(result.rankings_count, 60);
  assert.equal(result.duplicates, 0);
  assert.equal(result.outbox_backlog, 0);
});

test('executeStageRun blocks Stage 2 advancement while hard gates are frozen, even with human approval', async () => {
  const { executeStageRun } = require('./rollout_dual_write_orchestrator.cjs');

  process.env.STAGE_2_HUMAN_APPROVAL = 'true';
  try {
    await assert.rejects(
      async () => {
        await executeStageRun({ stage: 2 });
      },
      (err) => {
        assert.equal(err.code, 'ERR_STAGE_2_HARD_GATES_FAILED');
        assert.match(err.message, /Stage 2 rollout BLOCKED by hard gates/);
        assert.match(err.message, /Human approval cannot override failed hard gates/);
        return true;
      }
    );
  } finally {
    delete process.env.STAGE_2_HUMAN_APPROVAL;
  }
});
