const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { verifyOffHostRecoveryKey, assertTrulyOffHostPath } = require('./verify_offhost_backup_key.cjs');

test('assertTrulyOffHostPath strictly rejects internal SSD paths', () => {
  const badPaths = [
    path.join(os.homedir(), '.config', 'verimimari', 'backup_recovery.key'),
    '/Users/test/backup.key',
    '/tmp/backup.key',
    '/private/var/backup.key',
    '/Volumes/Macintosh HD/Users/test/backup.key'
  ];

  for (const p of badPaths) {
    assert.throws(
      () => assertTrulyOffHostPath(p),
      /SECURITY VIOLATION: Path .* is on the Mac Mini internal SSD\/APFS volume/,
      `Expected ${p} to be rejected as internal SSD path`
    );
  }
});

test('assertTrulyOffHostPath accepts valid external volume paths', () => {
  const validPath = '/Volumes/TWINMOS/verimimari_keys/backup_recovery.key';
  const resolved = assertTrulyOffHostPath(validPath);
  assert.equal(resolved, validPath);
});

test('verifyOffHostRecoveryKey verifies off-host copy and ensures zero secret leakage', () => {
  const report = verifyOffHostRecoveryKey();
  assert.equal(report.status, 'PASS');
  assert.ok(report.keyId);
  assert.equal(report.keyId.length, 16);
  assert.ok(Array.isArray(report.offHostLocations));
  assert.ok(report.offHostLocations.length > 0);
  assert.equal(report.zeroLeakCompliance, true);
  // Ensure no raw secret key field in report
  assert.equal(report.primaryKey, undefined);
  assert.equal(report.rawKey, undefined);
});
