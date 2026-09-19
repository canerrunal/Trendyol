'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileObservations, reconcileDataset10Metrics } = require('./verify_reconciliation.cjs');

test('reconcileObservations returns MATCH for identical sets', () => {
  const sourceA = [
    { product_id: '101', merchant_id: '1', offer_key: '101:1', price: 100, in_stock: true, rank: 1 },
    { product_id: '102', merchant_id: '1', offer_key: '102:1', price: 200, in_stock: false, rank: 2 },
    { product_id: '103', merchant_id: '2', offer_key: '103:2', price: 300, in_stock: null, rank: 3 }
  ];

  // Source B uses ClickHouse conventions (UInt8 for boolean: 1, 0, null)
  const sourceB = [
    { product_id: '101', merchant_id: '1', offer_key: '101:1', price: 100.00, in_stock: 1, rank: 1 },
    { product_id: '102', merchant_id: '1', offer_key: '102:1', price: 200.00, in_stock: 0, rank: 2 },
    { product_id: '103', merchant_id: '2', offer_key: '103:2', price: 300.00, in_stock: null, rank: 3 }
  ];

  const result = reconcileObservations(sourceA, sourceB);
  assert.equal(result.status, 'MATCH');
  assert.equal(result.isFullMatch, true);
  assert.equal(result.matchRate, 100);
  assert.equal(result.counts.exactMatches, 3);
  assert.equal(result.counts.discrepancies, 0);
  assert.equal(result.counts.missingInSourceB, 0);
});

test('reconcileObservations catches price discrepancies exceeding tolerance', () => {
  const sourceA = [
    { offer_key: '101:1', price: 100.00, in_stock: true }
  ];
  const sourceB = [
    { offer_key: '101:1', price: 105.00, in_stock: 1 }
  ];

  const result = reconcileObservations(sourceA, sourceB, { tolerancePrice: 0.01 });
  assert.equal(result.status, 'DISCREPANCY');
  assert.equal(result.isFullMatch, false);
  assert.equal(result.counts.discrepancies, 1);
  assert.equal(result.sampleDiscrepancies[0].diffs[0].field, 'price');
});

test('reconcileObservations detects missing records in either source', () => {
  const sourceA = [
    { offer_key: '101:1', price: 100, in_stock: true },
    { offer_key: '102:1', price: 200, in_stock: true }
  ];
  const sourceB = [
    { offer_key: '102:1', price: 200, in_stock: 1 },
    { offer_key: '103:1', price: 300, in_stock: 1 }
  ];

  const result = reconcileObservations(sourceA, sourceB);
  assert.equal(result.status, 'DISCREPANCY');
  assert.equal(result.counts.missingInSourceB, 1); // 101:1 missing in B
  assert.equal(result.counts.missingInSourceA, 1); // 103:1 missing in A
  assert.deepEqual(result.sampleMissingInB, ['101:1']);
  assert.deepEqual(result.sampleMissingInA, ['103:1']);
});

test('reconcileObservations handles empty datasets gracefully', () => {
  const result = reconcileObservations([], []);
  assert.equal(result.status, 'MATCH');
  assert.equal(result.isFullMatch, true);
  assert.equal(result.matchRate, 100);
});

test('reconcileDataset10Metrics returns PASS with 10/10 metrics matching', () => {
  const datasetA = {
    run_id: 'trendyol-20260917-151000-canary',
    observations: [
      { observation_id: 'obs-1', run_id: 'trendyol-20260917-151000-canary', product_id: 'p1', merchant_id: 'm1', observed_date: '2026-09-17', price: 100.50, in_stock: true },
      { observation_id: 'obs-2', run_id: 'trendyol-20260917-151000-canary', product_id: 'p2', merchant_id: 'm2', observed_date: '2026-09-17', price: null, in_stock: false },
      { observation_id: 'obs-3', run_id: 'trendyol-20260917-151000-canary', product_id: 'p3', merchant_id: 'm1', observed_date: '2026-09-17', price: 250.00, in_stock: null }
    ],
    rankings: [
      { rank: 1, category_id: 10, product_id: 'p1' },
      { rank: 2, category_id: 10, product_id: 'p2' }
    ]
  };

  // Dataset B has different row order and ClickHouse UInt8 stock conventions
  const datasetB = {
    run_id: 'trendyol-20260917-151000-canary',
    observations: [
      { observation_id: 'obs-3', run_id: 'trendyol-20260917-151000-canary', product_id: 'p3', merchant_id: 'm1', observed_date: '2026-09-17', price: 250.00, in_stock: null },
      { observation_id: 'obs-1', run_id: 'trendyol-20260917-151000-canary', product_id: 'p1', merchant_id: 'm1', observed_date: '2026-09-17', price: 100.50, in_stock: 1 },
      { observation_id: 'obs-2', run_id: 'trendyol-20260917-151000-canary', product_id: 'p2', merchant_id: 'm2', observed_date: '2026-09-17', price: null, in_stock: 0 }
    ],
    rankings: [
      { rank: 2, category_id: 10, product_id: 'p2' },
      { rank: 1, category_id: 10, product_id: 'p1' }
    ]
  };

  const rec = reconcileDataset10Metrics(datasetA, datasetB);
  assert.equal(rec.status, 'PASS');
  assert.equal(rec.isFullPass, true);
  assert.equal(rec.totalMetrics, 14);
  assert.equal(rec.passedMetrics, 14);
  assert.equal(rec.failedMetrics, 0);

  assert.equal(rec.metrics.run_id.pass, true);
  assert.equal(rec.metrics.observation_count.pass, true);
  assert.equal(rec.metrics.ranking_count.pass, true);
  assert.equal(rec.metrics.distinct_products.pass, true);
  assert.equal(rec.metrics.distinct_merchants.pass, true);
  assert.equal(rec.metrics.distinct_offer_key.pass, true);
  assert.equal(rec.metrics.duplicate_observation_id_count.pass, true);
  assert.equal(rec.metrics.date_range.pass, true);
  assert.equal(rec.metrics.captured_at_range.pass, true);
  assert.equal(rec.metrics.null_price_count.pass, true);
  assert.equal(rec.metrics.stock_distribution.pass, true);
  assert.equal(rec.metrics.price_sum.pass, true);
  assert.equal(rec.metrics.rank_checksum.pass, true);
  assert.equal(rec.metrics.logical_dataset_checksum.pass, true);
});

test('reconcileDatasetMetrics flags failure when metrics differ', () => {
  const datasetA = {
    run_id: 'run-a',
    observations: [
      { observation_id: 'obs-1', product_id: 'p1', merchant_id: 'm1', observed_date: '2026-09-17', price: 100, in_stock: true }
    ],
    rankings: []
  };
  const datasetB = {
    run_id: 'run-b', // run_id mismatch
    observations: [
      { observation_id: 'obs-1', product_id: 'p1', merchant_id: 'm1', observed_date: '2026-09-17', price: 105, in_stock: true } // price mismatch
    ],
    rankings: []
  };

  const rec = reconcileDataset10Metrics(datasetA, datasetB);
  assert.equal(rec.status, 'FAIL');
  assert.equal(rec.isFullPass, false);
  assert.equal(rec.metrics.run_id.pass, false);
  assert.equal(rec.metrics.price_sum.pass, false);
  assert.equal(rec.metrics.logical_dataset_checksum.pass, false);
  assert.equal(rec.metrics.observation_count.pass, true); // this one still passes
});

test('reconcileDedicatedRankMetrics succeeds on identical ranking sets', () => {
  const { reconcileDedicatedRankMetrics } = require('./verify_reconciliation.cjs');

  const supabaseRankings = [
    { run_id: 'run-rank-1', category_id: 101, rank: 1, product_id: 'p1', captured_at: '2026-09-18T10:00:00.000Z' },
    { run_id: 'run-rank-1', category_id: 101, rank: 2, product_id: 'p2', captured_at: '2026-09-18T10:00:00.000Z' },
    { run_id: 'run-rank-1', category_id: 102, rank: 1, product_id: 'p3', captured_at: '2026-09-18T10:00:00.000Z' }
  ];

  const clickhouseRankings = [
    { run_id: 'run-rank-1', category_id: 101, rank: 1, product_id: 'p1', captured_at: '2026-09-18 10:00:00.000' },
    { run_id: 'run-rank-1', category_id: 101, rank: 2, product_id: 'p2', captured_at: '2026-09-18 10:00:00.000' },
    { run_id: 'run-rank-1', category_id: 102, rank: 1, product_id: 'p3', captured_at: '2026-09-18 10:00:00.000' }
  ];

  const result = reconcileDedicatedRankMetrics(supabaseRankings, clickhouseRankings);
  assert.equal(result.status, 'PASS');
  assert.equal(result.isFullPass, true);
  assert.equal(result.passedChecks, result.totalChecks);
  assert.equal(result.checks.run_id.pass, true);
  assert.equal(result.checks.count.pass, true);
  assert.equal(result.checks.distinct_products.pass, true);
  assert.equal(result.checks.distinct_categories.pass, true);
  assert.equal(result.checks.category_product_membership.pass, true);
  assert.equal(result.checks.rank_values.pass, true);
  assert.equal(result.checks.rank_checksum.pass, true);
  assert.equal(result.checks.duplicate_count.pass, true);
});

test('reconcileDedicatedRankMetrics detects rank mismatch and duplicates', () => {
  const { reconcileDedicatedRankMetrics } = require('./verify_reconciliation.cjs');

  const sourceA = [
    { run_id: 'run-rank-1', category_id: 101, rank: 1, product_id: 'p1', observation_id: 'obs-1' },
    { run_id: 'run-rank-1', category_id: 101, rank: 2, product_id: 'p2', observation_id: 'obs-2' }
  ];

  const sourceB = [
    { run_id: 'run-rank-1', category_id: 101, rank: 2, product_id: 'p1', observation_id: 'obs-1' }, // rank swapped
    { run_id: 'run-rank-1', category_id: 101, rank: 1, product_id: 'p2', observation_id: 'obs-2' }
  ];

  const resRankMismatch = reconcileDedicatedRankMetrics(sourceA, sourceB);
  assert.equal(resRankMismatch.status, 'FAIL');
  assert.equal(resRankMismatch.checks.rank_values.pass, false);

  // Duplicate test
  const duplicateSource = [
    { run_id: 'run-rank-1', category_id: 101, rank: 1, product_id: 'p1', observation_id: 'obs-dup' },
    { run_id: 'run-rank-1', category_id: 101, rank: 1, product_id: 'p1', observation_id: 'obs-dup' }
  ];
  const resDup = reconcileDedicatedRankMetrics(duplicateSource, sourceA);
  assert.equal(resDup.status, 'FAIL');
  assert.equal(resDup.checks.duplicate_count.pass, false);
});

