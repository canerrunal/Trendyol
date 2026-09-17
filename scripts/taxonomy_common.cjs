#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TIMEZONE = 'Europe/Istanbul';
const ROOT_URL = 'https://www.trendyol.com/cok-satanlar?type=bestSeller&webGenderId=1';
const API_BASE = 'https://apigw.trendyol.com/discovery-sfint-browsing-service/api/top-rankings-v2/top-ranking-contents';
const SEARCH_API_BASE = 'https://apigw.trendyol.com/discovery-sfint-search-service/api/search/products/';

function mkdir(directory) { fs.mkdirSync(directory, { recursive: true }); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJsonAtomic(file, value) {
  mkdir(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temporary, file);
}
function writeGzipJsonAtomic(file, value) {
  mkdir(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, zlib.gzipSync(Buffer.from(JSON.stringify(value)), { level: 9, mtime: 0 }));
  fs.renameSync(temporary, file);
}
function readGzipJson(file) { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); }
function nowIstanbul(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, timestamp: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+03:00` };
}
function slugify(value) {
  return String(value || '').toLocaleLowerCase('tr-TR')
    .replaceAll('ı', 'i').replaceAll('ğ', 'g').replaceAll('ü', 'u').replaceAll('ş', 's').replaceAll('ö', 'o').replaceAll('ç', 'c')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kategori';
}
function csvCell(value) {
  const raw = value == null ? '' : String(value);
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}
function writeCsvAtomic(file, rows, columns) {
  mkdir(path.dirname(file));
  const temporary = `${file}.${process.pid}.tmp`;
  const body = [columns.join(','), ...rows.map(row => columns.map(column => csvCell(row[column])).join(','))].join('\n') + '\n';
  fs.writeFileSync(temporary, body);
  fs.renameSync(temporary, file);
}
function parseAssignedJson(source, marker = 'window["__top-ranking__PROPS"]') {
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Kategori verisi işareti bulunamadı: ${marker}`);
  const start = source.indexOf('{', markerIndex);
  if (start < 0) throw new Error('Kategori JSON başlangıcı bulunamadı.');
  let depth = 0; let quoted = false; let escaped = false;
  for (let index = start; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === '{') depth++;
    else if (character === '}' && --depth === 0) return JSON.parse(source.slice(start, index + 1));
  }
  throw new Error('Kategori JSON sonu bulunamadı.');
}
function flattenTree(categories) {
  const rows = [];
  function visit(node, parent, ancestors, root) {
    const categoryId = Number(node.id ?? node.categoryId);
    if (!Number.isFinite(categoryId)) return;
    const name = String(node.name || node.categoryName || `Kategori ${categoryId}`).trim();
    const children = Array.isArray(node.children) ? node.children : Array.isArray(node.subCategories) ? node.subCategories : [];
    const lineage = [...ancestors, { id: categoryId, name }];
    const rootNode = root || { id: categoryId, name };
    rows.push({
      categoryId, name, slug: slugify(name), parentId: parent?.categoryId || null,
      level: ancestors.length, hasChildren: children.length > 0, childCount: children.length,
      rootId: rootNode.id, rootName: rootNode.name,
      path: lineage.map(item => item.name).join(' > '),
      pathIds: lineage.map(item => item.id),
      pathSlug: lineage.map(item => slugify(item.name)).join('/'),
      url: `https://www.trendyol.com/cok-satanlar?categoryId=${categoryId}&type=bestSeller&webGenderId=1`
    });
    for (const child of children) visit(child, { categoryId, name }, lineage, rootNode);
  }
  for (const category of categories || []) visit(category, null, [], null);
  return rows;
}
async function launchBrowser() {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--disable-blink-features=AutomationControlled', '--lang=tr-TR'] });
  const context = await browser.newContext({
    locale: 'tr-TR', timezoneId: TIMEZONE,
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 1000 }
  });
  return { browser, context };
}
async function prepareRankingPage(context) {
  const page = await context.newPage();
  await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(1500);
  return page;
}
function rankingUrl(categoryId, page = 1, pageSize = 20) {
  const url = new URL(API_BASE);
  url.searchParams.set('categoryId', String(categoryId));
  url.searchParams.set('rankingType', 'bestSeller');
  url.searchParams.set('webGenderId', '1');
  url.searchParams.set('page', String(page));
  url.searchParams.set('pageSize', String(pageSize));
  url.searchParams.set('storefrontId', '1');
  url.searchParams.set('language', 'tr');
  url.searchParams.set('countryCode', 'TR');
  url.searchParams.set('channelId', '1');
  return url.toString();
}
async function fetchRankingPage(page, categoryId, pageNumber, attempts = 3) {
  const url = rankingUrl(categoryId, pageNumber);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await page.evaluate(async target => {
        const response = await fetch(target, { credentials: 'include', headers: { accept: 'application/json' } });
        return { ok: response.ok, status: response.status, text: await response.text() };
      }, url);
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      const payload = JSON.parse(result.text);
      const products = payload?.products || payload?.result?.content || payload?.content || payload?.result?.products || [];
      if (!Array.isArray(products)) throw new Error('Ürün listesi beklenen biçimde değil.');
      return products;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1000 * attempt);
    }
  }
  throw new Error(`Kategori ${categoryId}, sayfa ${pageNumber}: ${lastError?.message || 'bilinmeyen hata'}`);
}
function searchFallbackUrl(categoryId, page = 1, pageSize = 36, sort = 'BEST_SELLER') {
  const url = new URL(SEARCH_API_BASE);
  const params = {
    promotionSearch: 'false', stickyShellNavigation: 'true', isDynamicRenderingAgent: 'false',
    channelId: '1', subPathStrategy: 'no-subpath', wc: String(categoryId),
    tyPlusStripViewEnabled: 'true', pi: String(page), pageSize: String(pageSize), sst: String(sort)
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}
async function fetchSearchPage(page, categoryId, pageNumber, pageSize = 36, attempts = 3, sort = 'BEST_SELLER') {
  const url = searchFallbackUrl(categoryId, pageNumber, pageSize, sort);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const result = await page.evaluate(async target => {
        const response = await fetch(target, { credentials: 'include', headers: { accept: 'application/json' } });
        return { ok: response.ok, status: response.status, text: await response.text() };
      }, url);
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
      const payload = JSON.parse(result.text);
      const products = payload?.products || payload?.data?.products || payload?.result?.content || [];
      if (!Array.isArray(products)) throw new Error('Kategori arama yedeği beklenen biçimde değil.');
      products.total = Number(payload?.total ?? payload?.data?.total ?? payload?.result?.total) || null;
      return products;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await sleep(1000 * attempt);
    }
  }
  throw new Error(`Kategori araması ${categoryId}, ${sort}, sayfa ${pageNumber}: ${lastError?.message || 'bilinmeyen hata'}`);
}
function moneyValue(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value === 'object') return moneyValue(value.value ?? value.amount ?? value.price);
  const parsed = Number(String(value).replace(/\./g, '').replace(',', '.').replace(/[^\d.-]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}
function normalizeProduct(product) {
  const finalPrice = moneyValue(product?.sanitizedPrice?.finalPrice ?? product?.price?.discountedPrice ?? product?.price);
  const originalCandidates = [
    product?.sanitizedPrice?.originalPrice, product?.price?.originalPrice, product?.price?.current,
    product?.singlePrice?.strikethroughPriceNumeric, product?.recommendedRetailPrice?.sellingPriceNumerized,
  ].map(moneyValue).filter(value => Number.isFinite(value));
  const originalPrice = originalCandidates.length ? Math.max(...originalCandidates) : null;
  const promotions = [
    ...(Array.isArray(product.promotions) ? product.promotions : product.promotions ? [product.promotions] : []),
    ...(Array.isArray(product.promotion) ? product.promotion : product.promotion ? [product.promotion] : [])
  ]
    .map(item => typeof item === 'string' ? item : item?.name || item?.description || item?.title).filter(Boolean);
  const relativeUrl = product.url || product.productUrl || '';
  const productId = String(product.id || product.productId || '');
  const merchantId = String(product.merchantId || product?.winnerVariant?.merchantId || '');
  const inStock = typeof product.inStock === 'boolean' ? product.inStock : typeof product?.tagStockBar?.isSoldOut === 'boolean' ? !product.tagStockBar.isSoldOut : null;
  const available = inStock === true ? true : inStock === false ? false : null;
  const productKey = product.productKey || (productId ? `${productId}:${merchantId || 'default'}` : '');
  return {
    productId,
    merchantId,
    productKey,
    marketplace: 'trendyol',
    marketplaceProductId: productId ? `trendyol:${productId}` : '',
    offerKey: productId ? `${productId}:${merchantId || 'default'}` : '',
    name: product.name || product.title || null,
    brand: product?.brandInfo?.name || product.brandName || (typeof product.brand === 'string' ? product.brand : null),
    url: relativeUrl ? new URL(relativeUrl, 'https://www.trendyol.com').toString() : null,
    imageUrl: product.imageUrl || product.image || null,
    categoryName: product?.category?.name || null,
    price: finalPrice,
    originalPrice: originalPrice && originalPrice > finalPrice ? originalPrice : null,
    currency: 'TRY',
    inStock,
    available,
    runningOut: Boolean(product.isRunningOut),
    rating: Number(product?.ratingScore?.averageRating ?? product.rating ?? 0) || null,
    ratingCount: require('./product_metrics.cjs').count(product?.ratingScore?.totalCount ?? product.ratingCount),
    promotions: [...new Set(promotions)],
    fastDelivery: Boolean(product?.badges?.fastDelivery || product.hasFastDeliveryTag),
    rushDeliveryHours: Number(product?.winnerVariant?.rushDeliveryDuration ?? 0) || null
  };
}

module.exports = {
  ROOT, ROOT_URL, TIMEZONE, mkdir, sleep, readJson, writeJsonAtomic, writeGzipJsonAtomic, readGzipJson,
  nowIstanbul, slugify, writeCsvAtomic, parseAssignedJson, flattenTree, launchBrowser, prepareRankingPage,
  fetchRankingPage, searchFallbackUrl, fetchSearchPage, normalizeProduct
};
