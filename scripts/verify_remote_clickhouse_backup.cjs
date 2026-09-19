// =============================================================================
// Verimimari Marketplace Data Platform V2 — P1.3c Remote Backup & Restore Verifier
// Verifies ClickHouse backup and restore integrity using:
// 1. Native Parquet export / import
// 2. Physical file SHA-256 verification
// 3. Logical dataset checksum equivalence (computeLogicalDatasetChecksum)
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { computeLogicalDatasetChecksum } = require('./lib/clickhouse_client.cjs');

const BACKUP_DIR = path.join(ROOT, '.runtime', 'remote_backups');

function runRemoteSql(query, user, pass, baseUrl, failOnHttp = true) {
  const args = ['-s', '-S'];
  if (failOnHttp) {
    args.push('--fail-with-body');
  }
  if (user && pass) {
    args.push('-u', `${user}:${pass}`);
  }
  args.push('--data-binary', query, `${baseUrl}/`);

  try {
    const output = execFileSync('curl', args, { encoding: 'utf8' });
    if (output.includes('DB::Exception')) {
      throw new Error(output.trim());
    }
    return output.trim();
  } catch (err) {
    const msg = ((err.stdout || '') + ' ' + (err.stderr || '') + ' ' + (err.message || '')).trim();
    throw new Error(msg);
  }
}

function runRemoteBinaryQuery(query, user, pass, baseUrl) {
  const args = ['-s', '-S', '--fail-with-body'];
  if (user && pass) {
    args.push('-u', `${user}:${pass}`);
  }
  args.push('--data-binary', query, `${baseUrl}/`);
  return execFileSync('curl', args, { maxBuffer: 50 * 1024 * 1024 });
}

function runRemoteBinaryInsert(query, dataBuffer, user, pass, baseUrl) {
  const args = ['-s', '-S', '--fail-with-body'];
  if (user && pass) {
    args.push('-u', `${user}:${pass}`);
  }
  args.push('--data-binary', '@-', `${baseUrl}/?query=${encodeURIComponent(query)}`);
  return execFileSync('curl', args, { input: dataBuffer, encoding: 'utf8' });
}

/**
 * Executes full remote backup export, SHA256 hashing, restore to verification table,
 * and logical dataset checksum comparison.
 */
async function verifyRemoteBackup({
  remoteUrl,
  adminUser = 'migration_admin',
  adminPass = process.env.CLICKHOUSE_ADMIN_PASSWORD || 'sec_admin_p1_3_test',
  readerUser = 'verimimari_reader',
  readerPass = process.env.CLICKHOUSE_READER_PASSWORD || 'sec_reader_p1_3_test',
  database = 'verimimari_prod',
  sourceTable = 'product_observations',
  runId = null
} = {}) {
  if (!remoteUrl) {
    throw new Error('remoteUrl is required for verifyRemoteBackup');
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  console.log('\n-----------------------------------------------------------------------------');
  console.log('  STARTING REMOTE CLICKHOUSE BACKUP & RESTORE INTEGRITY VERIFICATION');
  console.log(`  Source: ${database}.${sourceTable} at ${remoteUrl.replace(/:\/\/.*@/, '://')}`);
  console.log('-----------------------------------------------------------------------------');

  const filterClause = runId ? `WHERE run_id = '${runId}'` : '';

  // 1. Read original dataset from source table
  console.log('[BACKUP STEP 1] Fetching live dataset and computing original logical checksum...');
  const originalJson = runRemoteSql(
    `SELECT * FROM ${database}.${sourceTable} ${filterClause} FORMAT JSONEachRow`,
    readerUser,
    readerPass,
    remoteUrl
  );
  const originalRows = originalJson.split('\n').filter(Boolean).map(l => JSON.parse(l));

  if (originalRows.length === 0) {
    throw new Error(`Cannot verify backup: ${database}.${sourceTable} has 0 rows for run_id ${runId}`);
  }

  const originalChecksum = computeLogicalDatasetChecksum(originalRows);
  console.log(`✓ Original rows: ${originalRows.length}`);
  console.log(`✓ Original Logical Dataset Checksum: ${originalChecksum}`);

  // 2. Export Parquet backup from remote ClickHouse
  console.log('[BACKUP STEP 2] Exporting binary Parquet snapshot from remote ClickHouse...');
  const exportSql = `SELECT * FROM ${database}.${sourceTable} ${filterClause} FORMAT Parquet`;
  const parquetBuffer = runRemoteBinaryQuery(exportSql, readerUser, readerPass, remoteUrl);

  const timestamp = Date.now();
  const backupFilename = `${database}_${sourceTable}_${timestamp}.parquet`;
  const backupPath = path.join(BACKUP_DIR, backupFilename);
  fs.writeFileSync(backupPath, parquetBuffer);

  const fileSha256 = crypto.createHash('sha256').update(parquetBuffer).digest('hex');
  console.log(`✓ Parquet backup exported: ${parquetBuffer.length} bytes`);
  console.log(`✓ Backup File SHA256: ${fileSha256}`);
  console.log(`✓ Local backup artifact saved to: ${backupPath}`);

  // 3. Create isolated restore verification table
  console.log('[BACKUP STEP 3] Creating isolated restore verification table on remote ClickHouse...');
  const verifyTable = `backup_restore_verification_${timestamp}`;
  runRemoteSql(
    `CREATE TABLE IF NOT EXISTS ${database}.${verifyTable} AS ${database}.${sourceTable}`,
    adminUser,
    adminPass,
    remoteUrl
  );
  runRemoteSql(`TRUNCATE TABLE ${database}.${verifyTable}`, adminUser, adminPass, remoteUrl);

  // 4. Restore Parquet snapshot to verification table
  console.log(`[BACKUP STEP 4] Restoring Parquet snapshot to ${database}.${verifyTable}...`);
  const insertSql = `INSERT INTO ${database}.${verifyTable} FORMAT Parquet`;
  runRemoteBinaryInsert(insertSql, parquetBuffer, adminUser, adminPass, remoteUrl);

  // 5. Verify restored data
  console.log('[BACKUP STEP 5] Verifying restored dataset integrity...');
  const restoredJson = runRemoteSql(
    `SELECT * FROM ${database}.${verifyTable} FORMAT JSONEachRow`,
    readerUser,
    readerPass,
    remoteUrl
  );
  const restoredRows = restoredJson.split('\n').filter(Boolean).map(l => JSON.parse(l));

  const restoredCountSql = `SELECT count(), uniqExact(observation_id) FROM ${database}.${verifyTable}`;
  const restoredCounts = runRemoteSql(restoredCountSql, readerUser, readerPass, remoteUrl).split('\t');
  const restoredCount = Number(restoredCounts[0]);
  const restoredUniq = Number(restoredCounts[1]);

  const restoredChecksum = computeLogicalDatasetChecksum(restoredRows);

  console.log(`✓ Restored row count: ${restoredCount} (expected: ${originalRows.length})`);
  console.log(`✓ Restored uniq observations: ${restoredUniq} (expected: ${originalRows.length})`);
  console.log(`✓ Restored Logical Dataset Checksum: ${restoredChecksum}`);

  const countMatch = restoredCount === originalRows.length;
  const uniqMatch = restoredUniq === originalRows.length;
  const checksumMatch = originalChecksum === restoredChecksum;

  console.log('\n[BACKUP VERIFICATION AUDIT]');
  console.log(`  - Count Match: ${countMatch ? 'PASS' : 'FAIL'}`);
  console.log(`  - Uniq Match: ${uniqMatch ? 'PASS' : 'FAIL'}`);
  console.log(`  - Logical Dataset Checksum Match: ${checksumMatch ? 'PASS' : 'FAIL'}`);

  // 6. Clean up temporary verification table
  console.log(`[BACKUP STEP 6] Dropping temporary table ${database}.${verifyTable}...`);
  runRemoteSql(`DROP TABLE IF EXISTS ${database}.${verifyTable}`, adminUser, adminPass, remoteUrl);

  if (!countMatch || !uniqMatch || !checksumMatch) {
    throw new Error('Remote ClickHouse backup/restore verification FAILED! Checksum or count mismatch.');
  }

  console.log('✓ Remote ClickHouse Backup & Restore Verification: 100% PASS\n');

  return {
    status: 'PASS',
    database,
    sourceTable,
    exportedRows: originalRows.length,
    restoredRows: restoredCount,
    backupBytes: parquetBuffer.length,
    fileSha256,
    originalChecksum,
    restoredChecksum,
    checksumMatch
  };
}

if (require.main === module) {
  const remoteUrl = process.env.CLICKHOUSE_REMOTE_URL;
  if (!remoteUrl) {
    console.error('ERROR: CLICKHOUSE_REMOTE_URL environment variable is required.');
    process.exit(1);
  }

  verifyRemoteBackup({ remoteUrl })
    .then(res => {
      console.log('Backup Verification Result:', JSON.stringify(res, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('Backup Verification Failed:', err);
      process.exit(1);
    });
}

module.exports = {
  verifyRemoteBackup
};
