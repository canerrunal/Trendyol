const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { generateRunId, createLineageRecord } = require('./lib/lineage.cjs');
const { normalizeProduct } = require('./taxonomy_common.cjs');

const ROOT = path.resolve(__dirname, '..');

test('run_id format adheres to trendyol-YYYYMMDD-HHmmss-xxxxx standard', () => {
  const runId = generateRunId('trendyol');
  assert.match(runId, /^trendyol-\d{8}-\d{6}-[a-f0-9]{5}$/);
});

test('lineage record contains all 16 mandatory lineage fields', () => {
  const lineage = createLineageRecord({
    expectedShards: 4,
    successfulShards: 4,
    failedShards: 0,
    categoryCount: 3955,
    productCount: 248721,
    freshCount: 240000,
    carriedForwardCount: 0,
    qualityStatus: 'PASS',
    publishStatus: 'READY_FOR_PUBLISH'
  });

  const expectedFields = [
    'run_id', 'marketplace', 'started_at', 'finished_at',
    'source_git_commit', 'collector_version', 'schema_version', 'config_hash',
    'expected_shards', 'successful_shards', 'failed_shards',
    'category_count', 'product_count', 'fresh_count', 'carried_forward_count',
    'quality_status', 'publish_status'
  ];

  for (const field of expectedFields) {
    assert.ok(field in lineage, `Lineage record missing field: ${field}`);
    assert.notEqual(lineage[field], undefined, `Field ${field} is undefined`);
  }
  assert.equal(lineage.marketplace, 'trendyol');
  assert.equal(lineage.schema_version, 2);
});

test('product identity is separate from offer identity and preserves legacy productKey contract', () => {
  const rawItem1 = {
    id: '76241080',
    title: 'Long Line Puf',
    brandName: 'ZEM',
    url: '/zem/long-line-puf-p-76241080',
    merchantId: '1001',
    singlePrice: { strikethroughPriceNumeric: 1499 },
    price: { current: 1299 },
    inStock: true
  };

  const rawItem2 = {
    ...rawItem1,
    merchantId: '2002' // Different seller / BuyBox winner
  };

  const product1 = normalizeProduct(rawItem1);
  const product2 = normalizeProduct(rawItem2);

  // Canonical product ID and marketplace product identity must be strictly identical
  assert.equal(product1.productId, product2.productId);
  assert.equal(product1.productId, '76241080');
  assert.equal(product1.marketplaceProductId, 'trendyol:76241080');
  assert.equal(product2.marketplaceProductId, 'trendyol:76241080');

  // Legacy productKey contract (productId:merchantId) is preserved for existing downstream consumers
  assert.equal(product1.productKey, '76241080:1001');
  assert.equal(product2.productKey, '76241080:2002');

  // Offer keys must differ because merchants are different
  assert.notEqual(product1.offerKey, product2.offerKey);
  assert.equal(product1.offerKey, '76241080:1001');
  assert.equal(product2.offerKey, '76241080:2002');
});

test('availability is tri-state (true | false | null) and unknown stock never defaults to true', () => {
  const inStockRaw = {
    id: '12345',
    title: 'Test Ürün',
    url: '/test-p-12345',
    inStock: true
  };
  const outOfStockRaw = {
    id: '12345',
    title: 'Test Ürün',
    url: '/test-p-12345',
    inStock: false
  };
  const unknownStockRaw = {
    id: '12345',
    title: 'Test Ürün',
    url: '/test-p-12345'
    // inStock not provided / unobserved
  };

  const inStockNorm = normalizeProduct(inStockRaw);
  const outOfStockNorm = normalizeProduct(outOfStockRaw);
  const unknownNorm = normalizeProduct(unknownStockRaw);

  assert.equal(inStockNorm.available, true);
  assert.equal(inStockNorm.inStock, true);

  assert.equal(outOfStockNorm.available, false);
  assert.equal(outOfStockNorm.inStock, false);

  assert.equal(unknownNorm.available, null);
  assert.equal(unknownNorm.inStock, null);
});

test('no hardcoded /Users/ paths exist in scripts, hermes, or dashboard', () => {
  const dirsToCheck = ['scripts', 'hermes', 'dashboard'];
  for (const dir of dirsToCheck) {
    const fullDir = path.join(ROOT, dir);
    if (!fs.existsSync(fullDir)) continue;
    const files = fs.readdirSync(fullDir, { recursive: true });
    for (const f of files) {
      const fullPath = path.join(fullDir, f);
      if (fs.statSync(fullPath).isDirectory()) continue;
      if (fullPath.endsWith('.log') || fullPath.endsWith('.tmp')) continue;
      const content = fs.readFileSync(fullPath, 'utf8');
      assert.doesNotMatch(
        content,
        /\/Users\/canerramazanunal/,
        `Hardcoded /Users/ path found in: ${fullPath}`
      );
    }
  }
});

test('scheduler single source of truth exists and defines all schedules', () => {
  const schedulePath = path.join(ROOT, 'config', 'schedule.json');
  assert.ok(fs.existsSync(schedulePath), 'config/schedule.json must exist');
  const schedule = JSON.parse(fs.readFileSync(schedulePath, 'utf8'));

  assert.equal(schedule.repository, 'canerrunal/Trendyol');
  assert.ok(Array.isArray(schedule.trendyol.taxonomy.shards));
  assert.equal(schedule.trendyol.taxonomy.shards.length, 4);
  assert.equal(schedule.trendyol.taxonomy.finalize, '19:10');
  assert.equal(Object.keys(schedule.trendyol.profiles).length, 12);
  assert.equal(schedule.trendyol.profiles['cocuk'], '20:00');
});

test('node runtime is pinned to Node 24 LTS in package.json and .nvmrc', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines?.node, '>=24 <25');

  const nvmrcPath = path.join(ROOT, '.nvmrc');
  assert.ok(fs.existsSync(nvmrcPath));
  assert.equal(fs.readFileSync(nvmrcPath, 'utf8').trim(), '24');
});

test('dual status segregation preserves latest_published when latest_attempt is PARTIAL', () => {
  const previousPublished = {
    runId: 'trendyol-20260913-151000-pass1',
    date: '2026-09-13',
    status: 'PASS',
    qualityGateStatus: 'PASS'
  };

  // Simulate a PARTIAL run today
  const partialAttempt = {
    runId: 'trendyol-20260917-151000-part1',
    date: '2026-09-17',
    status: 'PARTIAL',
    qualityGateStatus: 'FAIL',
    publishStatus: 'BLOCKED_PARTIAL'
  };

  // In status.json:
  const statusJson = {
    schemaVersion: 2,
    runId: partialAttempt.runId,
    status: partialAttempt.status,
    latest_attempt: partialAttempt,
    latest_published: previousPublished // Must remain the previous PASS!
  };

  assert.equal(statusJson.latest_attempt.status, 'PARTIAL');
  assert.equal(statusJson.latest_attempt.runId, 'trendyol-20260917-151000-part1');
  assert.equal(statusJson.latest_published.status, 'PASS');
  assert.equal(statusJson.latest_published.runId, 'trendyol-20260913-151000-pass1');
});
