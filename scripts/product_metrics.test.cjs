const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/product-1164529918.json');
const { extractProductMetrics, estimateInventory, periodEstimate } = require('./product_metrics.cjs');
const html = `window["__envoy_product-image-gallery__PROPS"]=${JSON.stringify(fixture)};`;
test('actual supplied source: selected M stock differs from purchase limit and ratings differ from comments', () => {
  const p = extractProductMetrics(html, '1164529918');
  assert.equal(p.stock_quantity, 4); assert.equal(p.max_sale_limit, 11);
  assert.equal(p.variant_id, '1630539527'); assert.equal(p.merchant_id, '868610');
  assert.equal(p.price, 429.9); assert.equal(p.rating_count, 48); assert.equal(p.review_count, 34);
  assert.equal(p.rating, 3.9375); assert.equal(p.seller_count, null); assert.equal(p.seller_count_observed, 1);
  assert.equal(p.variants.length, 4); assert.equal(p.variants.find(v => v.label === 'XS').stock_quantity, null);
  assert.equal(JSON.stringify(p).includes('taxNumber'), false);
});
test('unrelated/recommended product and scripts are never used', () => {
  assert.equal(extractProductMetrics(html, 'other'), null);
  assert.equal(extractProductMetrics('window["__envoy_product-image-gallery__PROPS"]=alert(1)', '1'), null);
});
const base = { detail_status: 'refreshed', inventory_key: 'p:m:v:l', stock_quantity: 10, stock_quantity_source: 'quantity', stock_quantity_kind: 'reported', stock_observed_at: '2026-09-01T09:00:00Z' };
const next = { ...base, stock_quantity: 5, stock_observed_at: '2026-09-02T09:00:00Z' };
test('10 to 5 in 24h produces a 5/day estimate, without weekly extrapolation', () => {
  const r = estimateInventory(next, base); assert.equal(r.sales_estimate_daily, 5); assert.equal(r.sales_estimate_weekly, null);
  assert.equal(periodEstimate([], {...next,...r},7),null);
});
test('seller/variant/listing change, missing quantity, restock, stale and missing days suppress estimates', () => {
  for (const patch of [{inventory_key:'p:m2:v:l'}, {stock_quantity:null}, {stock_quantity:12}, {stock_quantity:10}, {detail_status:'carried_forward'}, {stock_observed_at:'2026-09-04T09:00:00Z'}, {stock_quantity_kind:'capped'}]) {
    assert.equal(estimateInventory({...next,...patch},base).sales_estimate_daily,null);
  }
  assert.equal(estimateInventory({...next,stock_quantity:0},base).sales_estimate_daily,10);
});
test('full weekly observations aggregate; gaps and duplicate snapshots do not inflate totals', () => {
  const rows = Array.from({length:7},(_,i)=>({...base,stock_observed_at:`2026-09-0${i+2}T09:00:00Z`,sales_estimate_status:'estimated',sales_estimate_hours:24,inventory_decrease:2}));
  assert.equal(periodEstimate([...rows,rows[0]],rows.at(-1),7),14);
  assert.equal(periodEstimate(rows.slice(1),rows.at(-1),7),null);
});
test('fresh payload absence and stale carry-forward cannot inherit numeric stock', () => {
  const { mergePoolProducts } = require('./collect.cjs');
  const old={...base,product_id:'p',date:'2026-09-01'};
  const [row]=mergePoolProducts([{product_id:'p'}],[],[old],'2026-09-02T09:00:00Z','2026-09-02',{});
  assert.equal(row.stock_quantity,null); assert.equal(row.inventory_key,null);
});
test('shared source exposes all 16 merchants with their own quantities and explicit total', () => {
  const shared=require('./fixtures/product-35509789-sellers.json');
  const source=`window["__envoy__SHARED_PROPS"]=${JSON.stringify(shared)};window["__envoy_side-other-seller__PROPS"]={"otherMerchantCount":15};`;
  const metrics=extractProductMetrics(source,'35509789');
  assert.equal(metrics.seller_count,16);assert.equal(metrics.seller_count_observed,16);
  assert.equal(metrics.sellers.find(s=>s.name==='ON8').stock_quantity,6369);
  assert.equal(metrics.sellers.find(s=>s.name==='ON8').price,2282);
  assert.equal(metrics.stock_quantity,2709);
});
