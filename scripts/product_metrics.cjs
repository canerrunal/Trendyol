// Only decode JSON belonging to known product fragments; never execute page scripts.
function assignedObject(source, name) {
  const marker = `window["${name}"]`;
  let start = source.indexOf(marker);
  if (start < 0) return null;
  start = source.indexOf('=', start + marker.length) + 1;
  while (/\s/.test(source[start] || '') && start < source.length) start++;
  if (source[start] !== '{') return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < source.length; i++) {
    const c = source[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(source.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}
function numeric(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null;
}
function count(v) { const n = numeric(v); return Number.isSafeInteger(n) ? n : null; }
function id(v) { return typeof v === 'string' || typeof v === 'number' ? String(v) || null : null; }
function extractProductMetrics(source, expectedProductId) {
  const shared = assignedObject(source, '__envoy__SHARED_PROPS');
  const p = shared?.product || assignedObject(source, '__envoy_product-image-gallery__PROPS')?.product;
  if (!p || id(p.id) !== String(expectedProductId)) return null;
  const listing = p.merchantListing || {};
  const winner = listing.winnerVariant || {};
  const merchant = listing.merchant || {};
  const merchantId = id(merchant.id);
  const variantId = id(winner.itemNumber);
  const listingId = id(winner.listingId);
  const price = winner.price || {};
  const observedAt = new Date().toISOString();
  const variants = (listing.variants || p.variants || []).map(v => ({
    variant_id: id(v.itemNumber), label: v.value || null, in_stock: typeof v.inStock === 'boolean' ? v.inStock : null,
    stock_quantity: id(v.itemNumber) === variantId ? count(winner.quantity) : count(v.quantity),
    selected: id(v.itemNumber) === variantId,
  }));
  const sellers = new Map();
  const addSeller = (m, v = {}) => {
    const key = id(m?.id); if (!key) return;
    sellers.set(key, { merchant_id: key, name: m.name || null, score: numeric(m.sellerScore?.value),
      price: numeric(v.price?.sellingPrice?.value), variant_id: id(v.itemNumber), listing_id: id(v.listingId), stock_quantity: count(v.quantity) });
  };
  addSeller(merchant, winner);
  for (const other of listing.otherMerchants || []) {
    const variant = other.variants?.find(v => id(v.itemNumber) === variantId) || other.variants?.[0] || {};
    addSeller(other, variant);
  }
  const pageProps = assignedObject(source, '__envoy__PROPS');
  const sideProps = assignedObject(source, '__envoy_side-other-seller__PROPS');
  const otherCount = count(sideProps?.otherMerchantCount ?? pageProps?.otherMerchantCount);
  const totalSellers = count(listing.merchantCount ?? p.merchantCount) ?? (otherCount !== null && merchantId ? otherCount + 1 : null);
  for (const other of listing.otherMerchantsVariants || []) addSeller(other.merchant || { id: other.merchantId }, other.winnerVariant || other);
  return {
    merchant_id: merchantId, offer_key: `${p.id}:${merchantId || 'unknown'}`,
    seller_name: merchant.name || null, seller_score: numeric(merchant.sellerScore?.value),
    variant_id: variantId, variant_label: variants.find(v => v.selected)?.label || null, listing_id: listingId,
    inventory_key: merchantId && variantId && listingId ? `${p.id}:${merchantId}:${variantId}:${listingId}` : null,
    stock_quantity: count(winner.quantity), stock_quantity_source: count(winner.quantity) === null ? null : 'merchantListing.winnerVariant.quantity',
    stock_quantity_kind: count(winner.quantity) === null ? 'unavailable' : 'reported',
    stock_observed_at: observedAt, max_sale_limit: count(winner.maxSaleLimit),
    stock_status: winner.inStock === true ? 'InStock' : winner.inStock === false ? 'OutOfStock' : null,
    stock_signal: winner.isRunningOut ? 'Tükeniyor' : null,
    price: numeric(price.sellingPrice?.value ?? price.discountedPrice?.value), original_price: numeric(price.originalPrice?.value),
    rating: numeric(p.ratingScore?.averageRating), rating_count: count(p.ratingScore?.totalCount),
    review_count: count(p.ratingScore?.commentCount), favorite_count: count(p.favoriteCount),
    question_count: count(p.questionCount),
    // A fragment may show only a subset of sellers. Never claim this is the total.
    seller_count: totalSellers,
    seller_count_observed: sellers.size || null, seller_count_kind: totalSellers === null ? 'observed_minimum' : 'reported_total',
    sellers: [...sellers.values()], variants,
  };
}
const METRIC_FIELDS = ['variant_id','variant_label','listing_id','inventory_key','stock_quantity','stock_quantity_source','stock_quantity_kind','stock_observed_at','max_sale_limit','seller_count','seller_count_observed','seller_count_kind','sellers','variants','favorite_count','inventory_decrease','sales_estimate_daily','sales_estimate_weekly','sales_estimate_monthly','sales_estimate_status','sales_estimate_hours','sales_estimate_source'];
function estimateInventory(current, previous) {
  const result = { inventory_decrease: null, sales_estimate_daily: null, sales_estimate_weekly: null, sales_estimate_monthly: null,
    sales_estimate_status: 'missing_baseline', sales_estimate_hours: null, sales_estimate_source: 'inventory_net_decrease' };
  if (current.detail_status !== 'refreshed') return { ...result, sales_estimate_status: 'stale_observation' };
  if (!previous) return result;
  if (!current.inventory_key || current.inventory_key !== previous.inventory_key) return { ...result, sales_estimate_status: 'identity_changed_or_unknown' };
  const before = count(previous.stock_quantity), after = count(current.stock_quantity);
  if (before === null || after === null || current.stock_quantity_source !== previous.stock_quantity_source || current.stock_quantity_kind !== 'reported' || previous.stock_quantity_kind !== 'reported') return { ...result, sales_estimate_status: 'quantity_unavailable' };
  const hours = (Date.parse(current.stock_observed_at) - Date.parse(previous.stock_observed_at)) / 3600000;
  if (!Number.isFinite(hours) || hours < 18 || hours > 30) return { ...result, sales_estimate_status: 'observation_gap' };
  result.sales_estimate_hours = Math.round(hours * 100) / 100;
  if (after > before) return { ...result, sales_estimate_status: 'restock_or_adjustment' };
  if (after === before) return { ...result, sales_estimate_status: 'unchanged_stock' };
  const decrease = before - after;
  return { ...result, inventory_decrease: decrease, sales_estimate_daily: Math.round(decrease * 24 / hours * 100) / 100, sales_estimate_status: 'estimated' };
}
// Sum measured intervals only. No daily * 7/30 extrapolation and no missing-day zeros.
function periodEstimate(rows, current, days) {
  if (!current.inventory_key) return null;
  const end = Date.parse(current.stock_observed_at), start = end - days * 86400000;
  const byEnd = new Map();
  for (const row of [...rows, current]) {
    const t = Date.parse(row.stock_observed_at);
    if (row.inventory_key === current.inventory_key && t > start && t <= end) byEnd.set(t, row);
  }
  const intervals = [...byEnd].sort(([a], [b]) => a - b);
  let cursor = start, total = 0;
  for (const [t, row] of intervals) {
    if (row.sales_estimate_status !== 'estimated' || count(row.inventory_decrease) === null) return null;
    const from = t - Number(row.sales_estimate_hours) * 3600000;
    if (Math.abs(from - cursor) > 60000) return null;
    total += Number(row.inventory_decrease); cursor = t;
  }
  return Math.abs(cursor - end) <= 60000 && intervals.length ? total : null;
}
module.exports = { assignedObject, extractProductMetrics, numeric, count, METRIC_FIELDS, estimateInventory, periodEstimate };
