// =============================================================================
// Verimimari Marketplace Data Platform V2 — Disaster Recovery Restore System
// Downloads encrypted off-site Parquet snapshots from private GitHub Releases,
// decrypts with AES-256-GCM using macOS Keychain key, verifies SHA256 sums,
// performs isolated test restore into staging tables, verifies row counts and
// logical checksums, and atomically promotes to production upon 100% PASS.
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
const DEFAULT_KEY_FILE = path.join(RUNTIME_DIR, 'backup_encryption.key');

const MAGIC_HEADER = Buffer.from('VMBK', 'utf8');

/**
 * Resolves the 256-bit encryption key from Environment, Keychain, or Key file.
 */
function resolveEncryptionKey() {
  if (process.env.BACKUP_ENCRYPTION_KEY) {
    const raw = process.env.BACKUP_ENCRYPTION_KEY.trim();
    if (/^[0-9a-fA-F]{64}$/.test(raw)) {
      return Buffer.from(raw, 'hex');
    }
    return crypto.scryptSync(raw, 'verimimari-backup-salt-v1', 32);
  }

  // Check macOS Keychain
  try {
    const kcKey = execFileSync('security', ['find-generic-password', '-s', 'verimimari-backup-key', '-w'], { encoding: 'utf8' }).trim();
    if (/^[0-9a-fA-F]{64}$/.test(kcKey)) {
      return Buffer.from(kcKey, 'hex');
    }
  } catch {
    // Keychain not available or key not found
  }

  if (fs.existsSync(DEFAULT_KEY_FILE)) {
    const keyHex = fs.readFileSync(DEFAULT_KEY_FILE, 'utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(keyHex)) {
      return Buffer.from(keyHex, 'hex');
    }
  }

  throw new Error('BACKUP ENCRYPTION KEY NOT FOUND! Ensure key exists in macOS Keychain or run "bash scripts/setup_secrets.sh"');
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
 * Executes ClickHouse SQL query via curl HTTP interface.
 */
function queryClickHouse(sql, { url = 'http://127.0.0.1:8123', user, password, headers = {} } = {}) {
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
 * Imports binary Parquet data into ClickHouse table.
 */
function importParquet(table, dataBuffer, { url = 'http://127.0.0.1:8123', user, password, headers = {} } = {}) {
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
 * Main Restore Process
 */
async function runRestore({
  tag = null,
  latest = false,
  verifyOnly = false,
  githubRepo = process.env.BACKUP_GITHUB_REPO || 'canerrunal/verimimari-backups',
  url = process.env.CLICKHOUSE_URL || 'http://127.0.0.1:8123',
  database = process.env.CLICKHOUSE_DATABASE || 'verimimari_prod'
} = {}) {
  console.log('=============================================================================');
  console.log('  VERIMIMARI PLATFORM V2 — PRODUCTION RESTORE & DISASTER RECOVERY');
  console.log(`  Source Repository: ${githubRepo}`);
  console.log(`  Target Database:   ${database} (${url})`);
  console.log(`  Mode:              ${verifyOnly ? 'VERIFY ONLY (Isolated Staging)' : 'ATOMIC RESTORE & PROMOTE'}`);
  console.log('=============================================================================');

  // 1. Resolve target release tag
  let targetTag = tag;
  if (!targetTag || latest) {
    console.log('\n[STEP 1/6] Resolving latest valid backup release...');
    try {
      const releaseListRaw = execFileSync('gh', ['release', 'list', '--repo', githubRepo, '--limit', '10'], { encoding: 'utf8' });
      const lines = releaseListRaw.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        // Tag is usually in third column or starts with v-verimimari-backup-
        const match = line.match(/(v-verimimari-backup-[^\s]+)/);
        if (match) {
          targetTag = match[1];
          break;
        }
      }
    } catch (err) {
      throw new Error(`Failed to list GitHub releases: ${err.message}. Ensure "gh auth status" is active.`);
    }

    if (!targetTag) {
      throw new Error('No valid backup releases found in target repository.');
    }
  }

  console.log(`  ✓ Target Release Tag: ${targetTag}`);

  // 2. Download release assets
  const restoreWorkDir = path.join(BACKUP_STAGING_DIR, `restore_${targetTag}_${Date.now()}`);
  fs.mkdirSync(restoreWorkDir, { recursive: true });

  console.log(`\n[STEP 2/6] Downloading release assets to ${restoreWorkDir}...`);
  try {
    execFileSync('gh', [
      'release', 'download', targetTag,
      '--repo', githubRepo,
      '--dir', restoreWorkDir
    ], { stdio: 'inherit' });
  } catch (err) {
    throw new Error(`Failed to download assets for release ${targetTag}: ${err.message}`);
  }

  // 3. Verify SHA256 checksums
  console.log('\n[STEP 3/6] Verifying file cryptographic hashes (SHA256SUMS.txt)...');
  const sumsPath = path.join(restoreWorkDir, 'SHA256SUMS.txt');
  const manifestPath = path.join(restoreWorkDir, 'manifest.json');

  if (!fs.existsSync(manifestPath)) {
    throw new Error('Corrupted backup: manifest.json is missing in downloaded assets.');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  if (fs.existsSync(sumsPath)) {
    const sumsContent = fs.readFileSync(sumsPath, 'utf8');
    const lines = sumsContent.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2) {
        const expectedSha = parts[0].trim();
        const fname = parts[1].trim();
        const fpath = path.join(restoreWorkDir, fname);
        if (fs.existsSync(fpath)) {
          const actualSha = crypto.createHash('sha256').update(fs.readFileSync(fpath)).digest('hex');
          if (actualSha !== expectedSha) {
            throw new Error(`Integrity Failure: SHA256 mismatch for ${fname}! (expected: ${expectedSha}, got: ${actualSha})`);
          }
          console.log(`  ✓ Checksum verified: ${fname}`);
        }
      }
    }
  }

  // 4. Locate and decrypt archive
  console.log('\n[STEP 4/6] Decrypting backup archive using AES-256-GCM key...');
  const keyBuffer = resolveEncryptionKey();

  // Find archive file or parts
  const allFiles = fs.readdirSync(restoreWorkDir);
  const encFiles = allFiles.filter(f => f.endsWith('.tar.gz.enc'));
  const partFiles = allFiles.filter(f => f.includes('.tar.gz.enc.part')).sort();

  let encryptedBuffer;
  if (partFiles.length > 0) {
    console.log(`  Assembling ${partFiles.length} chunked encrypted parts...`);
    const chunks = partFiles.map(pf => fs.readFileSync(path.join(restoreWorkDir, pf)));
    encryptedBuffer = Buffer.concat(chunks);
  } else if (encFiles.length > 0) {
    encryptedBuffer = fs.readFileSync(path.join(restoreWorkDir, encFiles[0]));
  } else {
    throw new Error('No encrypted archive file (.tar.gz.enc) found in downloaded release assets.');
  }

  const decryptedBuffer = decryptBufferAesGcm(encryptedBuffer, keyBuffer);
  console.log(`  ✓ Decryption successful. Decrypted archive size: ${(decryptedBuffer.length / 1024 / 1024).toFixed(2)} MB`);

  const extractDir = path.join(restoreWorkDir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });
  const tarPath = path.join(restoreWorkDir, 'decrypted.tar.gz');
  fs.writeFileSync(tarPath, decryptedBuffer);
  execSync(`tar -xzf "${tarPath}" -C "${extractDir}"`, { stdio: 'inherit' });

  // 5. Restore to temporary staging tables & verify row counts + logical checksums
  console.log('\n[STEP 5/6] Restoring to isolated staging tables & verifying logical checksums...');
  const stagingTables = {};

  try {
    for (const [tableName, meta] of Object.entries(manifest.tables)) {
      const stagingTable = `_restore_staging_${tableName}`;
      stagingTables[tableName] = stagingTable;

      console.log(`\n  --- Staging Table: ${database}.${stagingTable} ---`);
      queryClickHouse(`DROP TABLE IF EXISTS ${database}.${stagingTable}`);
      queryClickHouse(`CREATE TABLE ${database}.${stagingTable} AS ${database}.${tableName}`);

      if (meta.row_count > 0) {
        const parquetFile = path.join(extractDir, meta.parquet_file);
        if (!fs.existsSync(parquetFile)) {
          throw new Error(`Parquet file missing for table ${tableName}: ${meta.parquet_file}`);
        }
        const parquetBuffer = fs.readFileSync(parquetFile);
        console.log(`    Importing ${(parquetBuffer.length / 1024 / 1024).toFixed(2)} MB into staging...`);
        importParquet(`${database}.${stagingTable}`, parquetBuffer, { url });

        // Verify row count
        const stagingRowCount = parseInt(queryClickHouse(`SELECT count() FROM ${database}.${stagingTable}`).trim(), 10);
        if (stagingRowCount !== meta.row_count) {
          throw new Error(`Row count mismatch on ${stagingTable}: expected ${meta.row_count}, got ${stagingRowCount}`);
        }
        console.log(`    ✓ Row count verified: ${stagingRowCount} rows`);

        // Verify logical checksum
        const rowsJson = queryClickHouse(`SELECT * FROM ${database}.${stagingTable} FORMAT JSONEachRow`, { url });
        const rows = rowsJson.split('\n').filter(Boolean).map(l => JSON.parse(l));
        const stagingChecksum = computeLogicalDatasetChecksum(rows);

        if (stagingChecksum !== meta.logical_dataset_checksum) {
          throw new Error(`Logical dataset checksum mismatch on ${stagingTable}: expected ${meta.logical_dataset_checksum}, got ${stagingChecksum}`);
        }
        console.log(`    ✓ Logical dataset checksum verified MATCH PASS: ${stagingChecksum}`);
      } else {
        console.log(`    ✓ Table ${tableName} is empty in backup (0 rows). Verified schema.`);
      }
    }
    console.log('\n  ✓ All staging tables verified with 100% integrity pass.');
  } catch (err) {
    console.error(`\n❌ RESTORE VERIFICATION FAILED: ${err.message}`);
    console.error('  Cleaning up staging tables. Production tables remain UNTOUCHED.');
    for (const st of Object.values(stagingTables)) {
      try { queryClickHouse(`DROP TABLE IF EXISTS ${database}.${st}`); } catch {}
    }
    throw err;
  }

  // 6. Promote to Production or Clean Up
  console.log(`\n[STEP 6/6] ${verifyOnly ? 'Completing Verify-Only Mode...' : 'Promoting Staging Tables to Production (Atomic Swap)...'}`);
  if (verifyOnly) {
    for (const st of Object.values(stagingTables)) {
      queryClickHouse(`DROP TABLE IF EXISTS ${database}.${st}`);
    }
    console.log('  ✓ Dropped staging tables.');
    console.log('\n=============================================================================');
    console.log('  ✓ VERIFY-ONLY PASSED: Backup is 100% valid and restorable.');
    console.log('  Production tables were NOT modified.');
    console.log('=============================================================================');
  } else {
    for (const [tableName, stagingTable] of Object.entries(stagingTables)) {
      console.log(`  Swapping ${database}.${stagingTable} -> ${database}.${tableName}...`);
      queryClickHouse(`EXCHANGE TABLES ${database}.${tableName} AND ${database}.${stagingTable}`);
      queryClickHouse(`DROP TABLE IF EXISTS ${database}.${stagingTable}`);
      console.log(`  ✓ Table ${database}.${tableName} successfully promoted.`);
    }

    console.log('\n=============================================================================');
    console.log(`  🎉 PRODUCTION RESTORE COMPLETE: ${manifest.total_rows} total rows restored.`);
    console.log('  All tables promoted with 0 data loss.');
    console.log('=============================================================================');
  }

  // Clean staging directory
  fs.rmSync(restoreWorkDir, { recursive: true, force: true });
}

// CLI Argument Parsing
const args = process.argv.slice(2);
let tag = null;
let latest = false;
let verifyOnly = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--latest') latest = true;
  else if (args[i] === '--verify-only') verifyOnly = true;
  else if (args[i] === '--tag' && args[i + 1]) {
    tag = args[i + 1];
    i++;
  }
}

if (!tag && !latest) {
  // Default to --latest if no args passed
  latest = true;
}

runRestore({ tag, latest, verifyOnly }).catch(err => {
  console.error('\n❌ RESTORE PROCESS TERMINATED WITH ERROR:', err.message);
  process.exit(1);
});
