// =============================================================================
// Verimimari Marketplace Data Platform V2 — P1.3c GitHub Releases Backup System
// Zero-cost, encrypted, off-site disaster recovery backup for ClickHouse 26.8 LTS.
// Exports native Parquet snapshots, calculates cryptographic logical checksums,
// encrypts with AES-256-GCM, verifies restore integrity, and publishes to
// a private GitHub Release via gh CLI.
// =============================================================================

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, execSync } = require('node:child_process');
const { computeLogicalDatasetChecksum } = require('./lib/clickhouse_client.cjs');

const ROOT = path.resolve(__dirname, '..');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const BACKUP_STAGING_DIR = path.join(RUNTIME_DIR, 'backup_staging');
const LATEST_BACKUP_STATUS_FILE = path.join(RUNTIME_DIR, 'latest_backup_status.json');
const DEFAULT_KEY_FILE = path.join(RUNTIME_DIR, 'backup_encryption.key');

const MAGIC_HEADER = Buffer.from('VMBK', 'utf8'); // Verimimari Backup Magic
const FORMAT_VERSION = 1;
const DEFAULT_CHUNK_LIMIT_BYTES = 1800 * 1024 * 1024; // 1.8 GiB (GitHub 2 GiB limit safety margin)

/**
 * Resolves or generates the 256-bit encryption key.
 * Never logs or commits the raw key.
 */
function resolveEncryptionKey() {
  if (process.env.BACKUP_ENCRYPTION_KEY) {
    const raw = process.env.BACKUP_ENCRYPTION_KEY.trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    return crypto.scryptSync(raw, 'verimimari-backup-salt-v1', 32);
  }

  if (fs.existsSync(DEFAULT_KEY_FILE)) {
    const keyHex = fs.readFileSync(DEFAULT_KEY_FILE, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      return Buffer.from(keyHex, 'hex');
    }
  }

  // Generate a random 256-bit key and save with 0600 permissions
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });
  const newKey = crypto.randomBytes(32);
  fs.writeFileSync(DEFAULT_KEY_FILE, newKey.toString('hex'), { mode: 0o600 });
  return newKey;
}

/**
 * Executes ClickHouse SQL query via curl HTTP interface.
 */
function queryClickHouse(sql, { url, user, password, headers = {} } = {}) {
  const endpoint = `${url}/`;
  const curlArgs = ['-s', '-S', '--fail-with-body', '-d', sql];

  if (user && password) {
    curlArgs.push('-u', `${user}:${password}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    curlArgs.push('-H', `${k}: ${v}`);
  }
  curlArgs.push(endpoint);

  try {
    const output = execFileSync('curl', curlArgs, { encoding: 'utf8', maxBuffer: 100 * 1024 * 1024 });
    return output.trim();
  } catch (err) {
    const msg = ((err.stdout || '') + ' ' + (err.stderr || '') + ' ' + (err.message || '')).trim();
    throw new Error(`ClickHouse query failed [${sql.slice(0, 80)}...]: ${msg}`);
  }
}

/**
 * Exports binary Parquet data from ClickHouse.
 */
function exportParquet(sql, { url, user, password, headers = {} } = {}) {
  const endpoint = `${url}/`;
  const curlArgs = ['-s', '-S', '--fail-with-body', '-d', sql];

  if (user && password) {
    curlArgs.push('-u', `${user}:${password}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    curlArgs.push('-H', `${k}: ${v}`);
  }
  curlArgs.push(endpoint);

  return execFileSync('curl', curlArgs, { maxBuffer: 500 * 1024 * 1024 });
}

/**
 * Imports binary Parquet data into ClickHouse table.
 */
function importParquet(table, dataBuffer, { url, user, password, headers = {} } = {}) {
  const endpoint = `${url}/?query=${encodeURIComponent(`INSERT INTO ${table} FORMAT Parquet`)}`;
  const curlArgs = ['-s', '-S', '--fail-with-body', '-H', 'Content-Type: application/octet-stream', '--data-binary', '@-'];

  if (user && password) {
    curlArgs.push('-u', `${user}:${password}`);
  }
  for (const [k, v] of Object.entries(headers)) {
    curlArgs.push('-H', `${k}: ${v}`);
  }
  curlArgs.push(endpoint);

  execFileSync('curl', curlArgs, { input: dataBuffer, encoding: 'utf8' });
}

/**
 * Encrypts a buffer using AES-256-GCM.
 * Output format: [4 bytes Magic][1 byte Ver][12 bytes IV][16 bytes AuthTag][Ciphertext]
 */
function encryptBufferAesGcm(plainBuffer, keyBuffer) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer, iv);
  const ciphertext = Buffer.concat([cipher.update(plainBuffer), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const header = Buffer.alloc(4 + 1 + 12 + 16);
  MAGIC_HEADER.copy(header, 0);
  header.writeUInt8(FORMAT_VERSION, 4);
  iv.copy(header, 5);
  authTag.copy(header, 17);

  return Buffer.concat([header, ciphertext]);
}

/**
 * Decrypts a buffer produced by encryptBufferAesGcm.
 */
function decryptBufferAesGcm(encryptedBuffer, keyBuffer) {
  if (encryptedBuffer.length < 33) {
    throw new Error('Invalid encrypted buffer: too short');
  }

  const magic = encryptedBuffer.subarray(0, 4);
  if (!magic.equals(MAGIC_HEADER)) {
    throw new Error('Invalid backup file header: missing VMBK magic signature');
  }

  const version = encryptedBuffer.readUInt8(4);
  if (version !== 1) {
    throw new Error(`Unsupported backup format version: ${version}`);
  }

  const iv = encryptedBuffer.subarray(5, 17);
  const authTag = encryptedBuffer.subarray(17, 33);
  const ciphertext = encryptedBuffer.subarray(33);

  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Splits a file into chunk parts if it exceeds chunkLimitBytes.
 */
function chunkFileIfNeeded(filePath, chunkLimitBytes = DEFAULT_CHUNK_LIMIT_BYTES) {
  const stat = fs.statSync(filePath);
  if (stat.size <= chunkLimitBytes) {
    return [filePath];
  }

  const parts = [];
  const fd = fs.openSync(filePath, 'r');
  let partIndex = 0;
  let bytesReadTotal = 0;
  const buffer = Buffer.alloc(16 * 1024 * 1024); // 16 MB read buffer

  while (bytesReadTotal < stat.size) {
    const partPath = `${filePath}.part${String(partIndex).padStart(2, '0')}`;
    const outFd = fs.openSync(partPath, 'w');
    let partBytes = 0;

    while (partBytes < chunkLimitBytes && bytesReadTotal < stat.size) {
      const toRead = Math.min(buffer.length, chunkLimitBytes - partBytes, stat.size - bytesReadTotal);
      const read = fs.readSync(fd, buffer, 0, toRead, bytesReadTotal);
      if (read === 0) break;
      fs.writeSync(outFd, buffer, 0, read);
      partBytes += read;
      bytesReadTotal += read;
    }

    fs.closeSync(outFd);
    parts.push(partPath);
    partIndex++;
  }

  fs.closeSync(fd);
  return parts;
}

/**
 * Main function: Exports ClickHouse tables to Parquet, verifies checksums,
 * compresses, encrypts, validates test restore, and publishes to GitHub Releases.
 */
async function runGithubReleaseBackup({
  url = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123',
  database = process.env.CLICKHOUSE_DATABASE || 'verimimari_prod',
  user = process.env.CLICKHOUSE_ADMIN_USER || 'migration_admin',
  password = process.env.CLICKHOUSE_ADMIN_PASSWORD || 'sec_admin_p1_3_test',
  readerUser = process.env.CLICKHOUSE_READER_USER || 'verimimari_reader',
  readerPassword = process.env.CLICKHOUSE_READER_PASSWORD || 'sec_reader_p1_3_test',
  githubRepo = process.env.BACKUP_GITHUB_REPO || 'canerrunal/verimimari-backups',
  tables = ['product_observations', 'category_rank_observations', 'profile_observations', 'inventory_observations'],
  chunkLimitBytes = DEFAULT_CHUNK_LIMIT_BYTES,
  skipUpload = false
} = {}) {
  const timestampStr = new Date().toISOString().replace(/[:.]/g, '-');
  const backupId = `verimimari-backup-${timestampStr}`;
  const workDir = path.join(BACKUP_STAGING_DIR, backupId);

  fs.mkdirSync(workDir, { recursive: true });

  console.log('=============================================================================');
  console.log(`  STARTING SECURE GITHUB RELEASE BACKUP: ${backupId}`);
  console.log(`  Database: ${database} | GitHub Target: ${githubRepo}`);
  console.log('=============================================================================');

  const keyBuffer = resolveEncryptionKey();
  const manifest = {
    backup_id: backupId,
    created_at: new Date().toISOString(),
    database,
    target_repo: githubRepo,
    tables: {},
    total_rows: 0,
    encryption: {
      algorithm: 'AES-256-GCM',
      key_id: crypto.createHash('sha256').update(keyBuffer).digest('hex').slice(0, 16)
    }
  };

  const sha256Lines = [];

  // 1. Export each table to Parquet & compute logical dataset checksum
  for (const tableName of tables) {
    console.log(`\n[STEP 1] Processing table: ${database}.${tableName}...`);

    // Fetch row count
    const countOutput = queryClickHouse(`SELECT count() FROM ${database}.${tableName}`, { url, user: readerUser, password: readerPassword });
    const rowCount = parseInt(countOutput.trim() || '0', 10);
    manifest.total_rows += rowCount;
    console.log(`  Row count: ${rowCount}`);

    let logicalChecksum = null;
    let parquetBuffer = Buffer.alloc(0);

    if (rowCount > 0) {
      // Compute logical dataset checksum from canonical rows
      const rowsJson = queryClickHouse(`SELECT * FROM ${database}.${tableName} FORMAT JSONEachRow`, { url, user: readerUser, password: readerPassword });
      const rows = rowsJson.split('\n').filter(Boolean).map(line => JSON.parse(line));
      logicalChecksum = computeLogicalDatasetChecksum(rows);
      console.log(`  Logical Dataset Checksum: ${logicalChecksum}`);

      // Export Parquet
      parquetBuffer = exportParquet(`SELECT * FROM ${database}.${tableName} FORMAT Parquet`, { url, user: readerUser, password: readerPassword });
    } else {
      console.log('  Table empty, exporting schema placeholder');
      parquetBuffer = exportParquet(`SELECT * FROM ${database}.${tableName} LIMIT 0 FORMAT Parquet`, { url, user: readerUser, password: readerPassword });
      logicalChecksum = crypto.createHash('sha256').update('empty').digest('hex');
    }

    const parquetFilename = `${tableName}.parquet`;
    const parquetFilePath = path.join(workDir, parquetFilename);
    fs.writeFileSync(parquetFilePath, parquetBuffer);

    const fileSha256 = crypto.createHash('sha256').update(parquetBuffer).digest('hex');
    sha256Lines.push(`${fileSha256}  ${parquetFilename}`);

    manifest.tables[tableName] = {
      row_count: rowCount,
      parquet_file: parquetFilename,
      bytes: parquetBuffer.length,
      file_sha256: fileSha256,
      logical_dataset_checksum: logicalChecksum
    };
  }

  // Write manifest.json and SHA256SUMS.txt
  const manifestPath = path.join(workDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  const sha256Manifest = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
  sha256Lines.push(`${sha256Manifest}  manifest.json`);

  const sumsPath = path.join(workDir, 'SHA256SUMS.txt');
  fs.writeFileSync(sumsPath, sha256Lines.join('\n') + '\n', 'utf8');

  // 2. Package into tarball (.tar.gz)
  console.log('\n[STEP 2] Packaging into compressed tar archive...');
  const archivePath = path.join(BACKUP_STAGING_DIR, `${backupId}.tar.gz`);
  execSync(`tar -czf "${archivePath}" -C "${workDir}" .`, { stdio: 'inherit' });
  const archiveBytes = fs.statSync(archivePath).size;
  console.log(`✓ Unencrypted archive generated: ${(archiveBytes / 1024 / 1024).toFixed(2)} MB`);

  // 3. Encrypt archive with AES-256-GCM
  console.log('\n[STEP 3] Encrypting archive with AES-256-GCM...');
  const plainArchiveBuffer = fs.readFileSync(archivePath);
  const encryptedBuffer = encryptBufferAesGcm(plainArchiveBuffer, keyBuffer);

  const encryptedArchivePath = path.join(BACKUP_STAGING_DIR, `${backupId}.tar.gz.enc`);
  fs.writeFileSync(encryptedArchivePath, encryptedBuffer);
  const encryptedBytes = fs.statSync(encryptedArchivePath).size;
  const encryptedSha256 = crypto.createHash('sha256').update(encryptedBuffer).digest('hex');
  console.log(`✓ Encrypted archive created: ${(encryptedBytes / 1024 / 1024).toFixed(2)} MB (SHA256: ${encryptedSha256.slice(0, 16)}...)`);

  // 4. Test Restore Verification
  console.log('\n[STEP 4] Executing Automated Restore Verification Test...');
  const verifyExtractDir = path.join(BACKUP_STAGING_DIR, `${backupId}_verify`);
  fs.mkdirSync(verifyExtractDir, { recursive: true });

  const decryptedBuffer = decryptBufferAesGcm(fs.readFileSync(encryptedArchivePath), keyBuffer);
  const decryptedTarPath = path.join(verifyExtractDir, 'decrypted.tar.gz');
  fs.writeFileSync(decryptedTarPath, decryptedBuffer);

  execSync(`tar -xzf "${decryptedTarPath}" -C "${verifyExtractDir}"`, { stdio: 'inherit' });

  // For each table with data, restore to temporary ClickHouse table and verify
  for (const [tableName, meta] of Object.entries(manifest.tables)) {
    if (meta.row_count === 0) continue;

    const testTable = `_restore_verify_${Date.now()}_${tableName}`;
    console.log(`  Restoring ${tableName} to temporary verification table ${database}.${testTable}...`);

    queryClickHouse(`CREATE TABLE ${database}.${testTable} AS ${database}.${tableName}`, { url, user, password });

    const restoredParquetBuffer = fs.readFileSync(path.join(verifyExtractDir, meta.parquet_file));
    importParquet(`${database}.${testTable}`, restoredParquetBuffer, { url, user, password });

    const verifyCount = parseInt(queryClickHouse(`SELECT count() FROM ${database}.${testTable}`, { url, user, password }).trim(), 10);
    const restoredRowsJson = queryClickHouse(`SELECT * FROM ${database}.${testTable} FORMAT JSONEachRow`, { url, user, password });
    const restoredRows = restoredRowsJson.split('\n').filter(Boolean).map(l => JSON.parse(l));
    const restoredChecksum = computeLogicalDatasetChecksum(restoredRows);

    queryClickHouse(`DROP TABLE IF EXISTS ${database}.${testTable}`, { url, user, password });

    if (verifyCount !== meta.row_count) {
      throw new Error(`Restore Verification FAILED: row count mismatch on ${tableName} (expected: ${meta.row_count}, got: ${verifyCount})`);
    }
    if (restoredChecksum !== meta.logical_dataset_checksum) {
      throw new Error(`Restore Verification FAILED: logical checksum mismatch on ${tableName}`);
    }
    console.log(`  ✓ Table ${tableName} verified: ${verifyCount} rows, Checksum MATCH PASS`);
  }
  console.log('✓ Automated Restore Verification: 100% PASS');

  // Clean up verification extract dir and unencrypted tar
  fs.rmSync(verifyExtractDir, { recursive: true, force: true });
  fs.rmSync(archivePath, { force: true });

  // 5. Partition if asset approaches chunk limit
  const uploadAssets = [];
  const chunkedParts = chunkFileIfNeeded(encryptedArchivePath, chunkLimitBytes);
  if (chunkedParts.length > 1) {
    console.log(`\n[STEP 5] File exceeds ${chunkLimitBytes} bytes; split into ${chunkedParts.length} parts`);
    uploadAssets.push(...chunkedParts);
  } else {
    uploadAssets.push(encryptedArchivePath);
  }
  uploadAssets.push(manifestPath, sumsPath);

  // 6. Publish to GitHub Releases
  let releaseUrl = null;
  if (!skipUpload) {
    console.log(`\n[STEP 6] Publishing release to private GitHub repository ${githubRepo}...`);
    const releaseTag = `v-${backupId}`;
    const releaseTitle = `Verimimari ClickHouse Backup ${new Date().toISOString().slice(0, 10)} (${manifest.total_rows} rows)`;
    const releaseNotes = [
      `## Verimimari ClickHouse Off-Site Backup`,
      `- **Backup ID**: \`${backupId}\``,
      `- **Created At**: \`${manifest.created_at}\``,
      `- **Database**: \`${database}\``,
      `- **Total Historical Rows**: \`${manifest.total_rows}\``,
      `- **Encryption**: \`AES-256-GCM\` (Key ID: \`${manifest.encryption.key_id}\`)`,
      `- **Archive SHA256**: \`${encryptedSha256}\``,
      `- **Automated Restore Verification**: \`PASS (100% Checksum Equivalence)\``,
      ``,
      `### Table Details`,
      ...Object.entries(manifest.tables).map(([t, m]) => `- \`${t}\`: ${m.row_count} rows, logical checksum: \`${m.logical_dataset_checksum}\``)
    ].join('\n');

    const ghArgs = [
      'release', 'create', releaseTag,
      ...uploadAssets,
      '--repo', githubRepo,
      '--title', releaseTitle,
      '--notes', releaseNotes
    ];

    try {
      const ghOutput = execFileSync('gh', ghArgs, { encoding: 'utf8' }).trim();
      releaseUrl = ghOutput;
      console.log(`✓ GitHub Release published successfully: ${releaseUrl}`);
    } catch (err) {
      const msg = ((err.stdout || '') + ' ' + (err.stderr || '') + ' ' + (err.message || '')).trim();
      throw new Error(`Failed to publish GitHub Release: ${msg}`);
    }
  } else {
    console.log('\n[STEP 6] Skipping upload (skipUpload: true). Backup verified locally.');
  }

  // 7. Record latest backup status for dashboard telemetry
  const backupSummary = {
    backup_id: backupId,
    created_at: manifest.created_at,
    total_rows: manifest.total_rows,
    encrypted_bytes: encryptedBytes,
    encrypted_sha256: encryptedSha256,
    release_url: releaseUrl,
    github_repo: githubRepo,
    restore_verification: 'PASS',
    tables: manifest.tables
  };

  fs.writeFileSync(LATEST_BACKUP_STATUS_FILE, JSON.stringify(backupSummary, null, 2), 'utf8');

  console.log('\n=============================================================================');
  console.log(`  BACKUP COMPLETE: ${backupId}`);
  console.log(`  Restore Verification: PASS`);
  if (releaseUrl) console.log(`  Release URL: ${releaseUrl}`);
  console.log('=============================================================================\n');

  return backupSummary;
}

if (require.main === module) {
  const skipUpload = process.argv.includes('--skip-upload') || process.argv.includes('--dry-run');
  runGithubReleaseBackup({ skipUpload })
    .then(summary => {
      console.log('Backup summary:', JSON.stringify(summary, null, 2));
      process.exit(0);
    })
    .catch(err => {
      console.error('Backup error:', err);
      process.exit(1);
    });
}

module.exports = {
  runGithubReleaseBackup,
  encryptBufferAesGcm,
  decryptBufferAesGcm,
  chunkFileIfNeeded,
  resolveEncryptionKey
};
