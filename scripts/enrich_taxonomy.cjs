const fs = require('fs');
const path = require('path');
const { collectDetail } = require('./collect.cjs');
const { estimateInventory, periodEstimate, METRIC_FIELDS } = require('./product_metrics.cjs');
const { readJson, writeJsonAtomic } = require('./taxonomy_common.cjs');

async function enrichTaxonomy(context, products, root, shard, date, options) {
  const stateFile = path.join(root, '.runtime', 'inventory', `shard-${shard}.json`);
  const state = readJson(stateFile, { watch: [], history: {} });
  const daily = Number(options.detailDailyPerShard ?? 100), rotation = Number(options.detailRotationPerShard ?? 100);
  const byKey = new Map(products.map(p => [p.productKey || `${p.productId}:${p.merchantId}`, p]));
  // Persist URLs so stockout/ranking disappearance does not remove the cohort.
  const watch = new Map((state.watch || []).slice(0, daily).map(p => [p.productKey, p]));
  for (const [key, p] of byKey) { if (watch.size >= daily) break; if (p.url) watch.set(key, {...p, productKey:key}); }
  const rest = [...byKey].filter(([key]) => !watch.has(key)).sort(([a],[b]) => a.localeCompare(b));
  const day = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  const offset = (day % Math.max(1, Math.ceil(rest.length / Math.max(rotation,1)))) * rotation;
  const selected = [...watch.values(), ...rest.slice(offset, offset + rotation).map(([key,p])=>({...p,productKey:key}))];
  const history = state.history || {};
  let cursor = 0, refreshed = 0, quantities = 0;
  async function worker() {
    while (cursor < selected.length) {
      const p = selected[cursor++];
      if (!p.url) continue;
      const url = new URL(p.url); if (p.merchantId) url.searchParams.set('merchantId',p.merchantId);
      const row = await collectDetail(context, {product_id:p.productId,url:url.toString()},0);
      if (!row.detail_ok || (p.merchantId && row.merchant_id !== p.merchantId)) continue;
      const prior = history[p.productKey] || [];
      const old = prior.filter(r => r.stock_observed_at < row.stock_observed_at && r.stock_observed_at.slice(0,10) < row.stock_observed_at.slice(0,10)).at(-1);
      const metrics = {...Object.fromEntries(METRIC_FIELDS.map(k=>[k,row[k]??null])),
        merchant_id:row.merchant_id, seller_name:row.seller_name, seller_score:row.seller_score,
        rating:row.rating, rating_count:row.rating_count, review_count:row.review_count, question_count:row.question_count,
        ...estimateInventory(row,old)};
      metrics.sales_estimate_weekly = periodEstimate(prior,metrics,7);
      metrics.sales_estimate_monthly = periodEstimate(prior,metrics,30);
      const enriched = {...(byKey.get(p.productKey)||p), metrics};
      byKey.set(p.productKey,enriched);
      if (watch.has(p.productKey)) watch.set(p.productKey,enriched);
      history[p.productKey] = [...prior.filter(r=>r.stock_observed_at?.slice(0,10)!==metrics.stock_observed_at?.slice(0,10)),metrics].slice(-32);
      refreshed++; if (metrics.stock_quantity !== null) quantities++;
    }
  }
  await Promise.all(Array.from({length:Math.max(1,Number(options.detailConcurrency||3))},worker));
  // Bound rotation history to 32 days; source files contain only normalized public metrics.
  const threshold = Date.parse(`${date}T00:00:00Z`) - 32*86400000;
  for (const key of Object.keys(history)) { history[key]=history[key].filter(r=>Date.parse(r.stock_observed_at)>=threshold);if(!history[key].length)delete history[key]; }
  writeJsonAtomic(stateFile,{watch:[...watch.values()],history});
  console.log(`TAXONOMY_DETAIL attempted=${selected.length} refreshed=${refreshed} numericStock=${quantities}`);
  return {products:[...byKey.values()],coverage:{attempted:selected.length,refreshed,numericStock:quantities,total:byKey.size}};
}
module.exports={enrichTaxonomy};
