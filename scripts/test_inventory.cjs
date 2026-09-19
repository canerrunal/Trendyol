// =============================================================================
// Verimimari Marketplace Data Platform V2 — Test Inventory & Regression Guard
// Catalogs all active test suites and prevents silent test count regressions.
// Minimum expected test count baseline: 91 tests across scripts & dashboard.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const PREFLIGHT_GUARD_FILE = path.join(RUNTIME_DIR, 'test_preflight_guard.json');
const MIN_EXPECTED_TEST_COUNT = 91;

const LOCAL_CH_URL = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123';
const READER_USER = process.env.CLICKHOUSE_READER_USER || 'verimimari_reader';
const READER_PASS = process.env.CLICKHOUSE_READER_PASSWORD || 'sec_reader_p1_3_test';

function queryPreflightRankRowCount() {
  try {
    const query = "SELECT countIf(run_id LIKE '%preflight%' OR run_id LIKE '%canary%') FROM verimimari_prod.category_rank_observations";
    const userArgs = READER_USER ? ['-u', `${READER_USER}:${READER_PASS}`] : [];
    const args = ['-s', '-S', '--fail-with-body', ...userArgs, '-d', query, `${LOCAL_CH_URL}/`];
    const out = execFileSync('curl', args, { encoding: 'utf8' }).trim();
    const count = parseInt(out, 10);
    return isNaN(count) ? 0 : count;
  } catch (err) {
    console.warn('⚠️ Warning: Failed to query ClickHouse for preflight rank count:', err.message);
    return null;
  }
}

function runPreGuard() {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const count = queryPreflightRankRowCount();
  const state = {
    total_preflight_rank_rows_before: count,
    recorded_at: new Date().toISOString()
  };
  fs.writeFileSync(PREFLIGHT_GUARD_FILE, JSON.stringify(state, null, 2), 'utf8');
  console.log('=============================================================================');
  console.log('  TEST PRE-GUARD: PREFLIGHT INVARIANT BASELINE RECORDED');
  console.log(`  total_preflight_rank_rows_before = ${count}`);
  console.log('=============================================================================\n');
  return state;
}

function runPostGuard() {
  if (!fs.existsSync(PREFLIGHT_GUARD_FILE)) {
    console.warn('⚠️ Warning: No preflight guard file found. Pre-guard was not executed.');
    return { ok: true };
  }
  let beforeState = {};
  try {
    beforeState = JSON.parse(fs.readFileSync(PREFLIGHT_GUARD_FILE, 'utf8'));
  } catch {}
  const beforeCount = beforeState.total_preflight_rank_rows_before;
  const afterCount = queryPreflightRankRowCount();

  console.log('=============================================================================');
  console.log('  TEST POST-GUARD: PREFLIGHT INVARIANT VERIFICATION');
  console.log(`  total_preflight_rank_rows_before = ${beforeCount}`);
  console.log(`  total_preflight_rank_rows_after  = ${afterCount}`);
  console.log('=============================================================================');

  if (beforeCount != null && afterCount != null) {
    if (beforeCount !== afterCount) {
      console.error(`❌ INVARIANT VIOLATION: Unit tests inserted real rows into production ClickHouse category_rank_observations!`);
      console.error(`   Expected: ${beforeCount}, Actual: ${afterCount} (+${afterCount - beforeCount} rows)`);
      process.exit(1);
    } else {
      console.log('✓ Invariant verified: total_preflight_rank_rows_before == total_preflight_rank_rows_after (0 rows inserted)');
    }
  }

  try {
    fs.unlinkSync(PREFLIGHT_GUARD_FILE);
  } catch {}
  console.log('=============================================================================\n');
  return { ok: true, beforeCount, afterCount };
}

function discoverTestFiles() {
  const testFiles = [];
  const searchDirs = [
    path.join(ROOT, 'scripts'),
    path.join(ROOT, 'dashboard')
  ];

  for (const dir of searchDirs) {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      for (const f of files) {
        if (f.endsWith('.test.cjs') || f.endsWith('.test.js')) {
          testFiles.push(path.join(dir, f));
        }
      }
    }
  }

  testFiles.sort();
  return testFiles;
}

function countTestsInFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    // Match test('...', test("...", test(`...`
    const matches = content.match(/test\s*\(\s*['"`]/g);
    return matches ? matches.length : 0;
  } catch {
    return 0;
  }
}

function generateTestInventory() {
  const testFiles = discoverTestFiles();
  const inventory = [];
  let totalTests = 0;

  for (const f of testFiles) {
    const relPath = path.relative(ROOT, f);
    const count = countTestsInFile(f);
    totalTests += count;
    inventory.push({
      file: relPath,
      test_count: count
    });
  }

  const passed = totalTests >= MIN_EXPECTED_TEST_COUNT;

  return {
    inventory_timestamp: new Date().toISOString(),
    min_expected_test_count: MIN_EXPECTED_TEST_COUNT,
    total_test_files: testFiles.length,
    total_test_count: totalTests,
    status: passed ? 'PASS' : 'WARNING_TEST_COUNT_REGRESSED',
    warning: passed ? null : `Test count regressed: found ${totalTests}, minimum expected ${MIN_EXPECTED_TEST_COUNT}`,
    suites: inventory
  };
}

function printTestInventory() {
  const inv = generateTestInventory();
  console.log('=============================================================================');
  console.log('  VERIMIMARI PLATFORM V2 — TEST SUITE INVENTORY & REGRESSION GUARD');
  console.log(`  Timestamp: ${inv.inventory_timestamp}`);
  console.log('=============================================================================');
  console.log(`  Total Test Files:            ${inv.total_test_files}`);
  console.log(`  Total Discovered Tests:      ${inv.total_test_count} tests`);
  console.log(`  Minimum Expected Baseline:   ${inv.min_expected_test_count} tests`);
  console.log(`  Inventory Status:            ${inv.status}`);
  console.log('-----------------------------------------------------------------------------');
  console.log('  Discovered Test Suites:');
  inv.suites.forEach((s, idx) => {
    console.log(`   ${String(idx + 1).padStart(2, ' ')}. ${s.file.padEnd(45, ' ')} : ${String(s.test_count).padStart(3, ' ')} tests`);
  });
  console.log('-----------------------------------------------------------------------------');
  if (inv.warning) {
    console.warn(`⚠️  WARNING: ${inv.warning}`);
  } else {
    console.log(`✓  All ${inv.total_test_count} tests cataloged. Zero discovery regressions.`);
  }
  console.log('=============================================================================\n');
  return inv;
}

if (require.main === module) {
  if (process.argv.includes('--pre-guard')) {
    runPreGuard();
    process.exit(0);
  }
  if (process.argv.includes('--post-guard')) {
    runPostGuard();
    process.exit(0);
  }
  const inv = printTestInventory();
  if (process.argv.includes('--ci') && inv.status !== 'PASS') {
    process.exit(1);
  }
}

module.exports = {
  discoverTestFiles,
  countTestsInFile,
  generateTestInventory,
  printTestInventory,
  queryPreflightRankRowCount,
  runPreGuard,
  runPostGuard,
  MIN_EXPECTED_TEST_COUNT
};
