const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function getGitCommit(root = ROOT) {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim();
  } catch {
    return 'unknown';
  }
}

function calculateConfigHash(configPath) {
  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return crypto.createHash('sha256').update(content).digest('hex').slice(0, 12);
  } catch {
    return '000000000000';
  }
}

function generateRunId(marketplace = 'trendyol', timestamp = new Date()) {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const iso = date.toISOString(); // 2026-09-17T15:10:00.000Z
  const datePart = iso.slice(0, 10).replace(/-/g, '');
  const timePart = iso.slice(11, 19).replace(/:/g, '');
  const randomSuffix = crypto.randomBytes(3).toString('hex').slice(0, 5);
  return `${marketplace}-${datePart}-${timePart}-${randomSuffix}`;
}

function createLineageRecord(options = {}) {
  const {
    runId = generateRunId(options.marketplace || 'trendyol'),
    marketplace = 'trendyol',
    startedAt = new Date().toISOString(),
    finishedAt = new Date().toISOString(),
    sourceGitCommit = getGitCommit(),
    collectorVersion = '2.0.0',
    schemaVersion = 2,
    configHash = calculateConfigHash(path.join(ROOT, 'taxonomy', 'collection-config.json')),
    expectedShards = 4,
    successfulShards = 0,
    failedShards = 0,
    categoryCount = 0,
    productCount = 0,
    freshCount = 0,
    carriedForwardCount = 0,
    qualityStatus = 'PENDING',
    publishStatus = 'PENDING'
  } = options;

  return {
    run_id: runId,
    marketplace,
    started_at: startedAt,
    finished_at: finishedAt,
    source_git_commit: sourceGitCommit,
    collector_version: collectorVersion,
    schema_version: schemaVersion,
    config_hash: configHash,
    expected_shards: expectedShards,
    successful_shards: successfulShards,
    failed_shards: failedShards,
    category_count: categoryCount,
    product_count: productCount,
    fresh_count: freshCount,
    carried_forward_count: carriedForwardCount,
    quality_status: qualityStatus,
    publish_status: publishStatus
  };
}

module.exports = {
  getGitCommit,
  calculateConfigHash,
  generateRunId,
  createLineageRecord
};
