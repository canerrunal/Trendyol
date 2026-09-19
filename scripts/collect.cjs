#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { extractProductMetrics, METRIC_FIELDS, estimateInventory, periodEstimate, count } = require('./product_metrics.cjs');

const ROOT = path.resolve(__dirname, '..');
function cliArg(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  const inline = process.argv.find(arg => arg.startsWith(`--${name}=`));
  if (inline) return inline.slice(name.length + 3);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}
const PROFILE = cliArg('profile', 'cocuk');
const CONFIG_FILE = PROFILE === 'cocuk' ? path.join(ROOT, 'config.json') : path.join(ROOT, 'profiles', `${PROFILE}.json`);
if (!fs.existsSync(CONFIG_FILE)) throw new Error(`Profil ayarı bulunamadı: ${CONFIG_FILE}`);
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const OUTPUT_ROOT = PROFILE === 'cocuk' ? ROOT : path.join(ROOT, 'categories', PROFILE);
const OUTPUT_PREFIX = path.relative(ROOT, OUTPUT_ROOT).split(path.sep).join('/');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const LISTING_CACHE_FILE = path.join(OUTPUT_ROOT, 'data', 'listing-cache.json');


function mkdir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function nowIstanbul() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date()).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, timestamp: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+03:00` };
}
function normalize(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function firstMatch(text, regex, group = 1) { const m = String(text || '').match(regex); return m ? normalize(m[group]) : null; }
function trNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).replace(/[^\d.,-]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(s); return Number.isFinite(n) ? n : null;
}
function schemaNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
function compactNumber(value) {
  if (!value) return null;
  const m = String(value).replace(',', '.').match(/([\d.]+)\s*(B|M|K)?\+?/i);
  if (!m) return null;
  const base = Number(m[1]);
  const mult = { B: 1000, K: 1000, M: 1000000 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(base * mult);
}
function parseSalesSignal(value) {
  const text = normalize(value);
  const match = text.match(/(?:Son\s+)?(\d+)\s+günde\s+([\d.,]+[BMK]?\+?)/i);
  if (!match) return { sales_signal_days: null, sales_signal_min: null, sales_signal_daily_min: null };
  const days = Number(match[1]);
  const minimum = compactNumber(match[2]);
  return {
    sales_signal_days: Number.isFinite(days) && days > 0 ? days : null,
    sales_signal_min: minimum,
    sales_signal_daily_min: days > 0 && minimum !== null ? Math.round((minimum / days) * 10) / 10 : null
  };
}
function rankScope(sourceSegment) { return `${PROFILE}:${normalize(sourceSegment) || 'unknown'}`; }
function offerKey(product, merchant) { return `${normalize(product) || 'unknown'}:${normalize(merchant) || 'unknown'}`; }
function productId(url) { return firstMatch(url, /-p-(\d+)/); }
function merchantId(url) { try { return new URL(url).searchParams.get('merchantId'); } catch { return null; } }
function brandFromUrl(url, title) {
  try {
    const slug = new URL(url).pathname.split('/').filter(Boolean)[0] || '';
    if (slug === 'h-m') return 'H&M';
    const wordCount = Math.max(1, slug.split('-').length);
    return normalize(title).split(' ').slice(0, wordCount).join(' ') || null;
  } catch { return null; }
}
function csvCell(v) {
  const raw = v === null || v === undefined ? '' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
  return /[",\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}
function writeTextAtomic(file, text) {
  mkdir(path.dirname(file));
  const temporary = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(temporary, text);
  fs.renameSync(temporary, file);
}
function writeJsonAtomic(file, value) {
  writeTextAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
}
function writeCsv(file, rows, columns) {
  const out = [columns.join(','), ...rows.map(r => columns.map(c => csvCell(r[c])).join(','))].join('\n') + '\n';
  writeTextAtomic(file, out);
}
function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  const text = fs.readFileSync(file, 'utf8').trim();
  if (!text) return [];
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
    else if (ch === '"') quoted = !quoted;
    else if (ch === ',' && !quoted) { row.push(cell); cell = ''; }
    else if (ch === '\n' && !quoted) { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (ch !== '\r') cell += ch;
  }
  row.push(cell); rows.push(row);
  const headers = rows.shift();
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] || ''])));
}
function writeListingCache(listingResult) {
  const minimum = Number(config.minimumProducts || config.maxProducts || 100);
  if (!listingResult || listingResult.items.length < minimum) return;
  writeJsonAtomic(LISTING_CACHE_FILE, {
    profile: PROFILE,
    searchUrl: config.searchUrl,
    capturedAt: new Date().toISOString(),
    items: listingResult.items,
    pageStats: listingResult.pageStats
  });
}
function recoveryRunId(timestamp) {
  return `${String(timestamp || new Date().toISOString()).replace(/[^0-9A-Za-z-]/g, '-')}-${process.pid}-${Date.now()}`;
}
function writeRecoveryBackup({ date, timestamp, status, reason, listingResult, listed, selection, detailed, products, quality, error }) {
  const runId = recoveryRunId(timestamp);
  const backupDir = path.join(OUTPUT_ROOT, 'data', 'backups', date || 'unknown-date', runId);
  const detailRows = (detailed || []).filter(Boolean);
  mkdir(backupDir);
  writeJsonAtomic(path.join(backupDir, 'manifest.json'), {
    schemaVersion: 1,
    profile: PROFILE,
    date: date || null,
    capturedAt: timestamp || new Date().toISOString(),
    savedAt: new Date().toISOString(),
    status,
    reason: reason || null,
    listedCount: Array.isArray(listed) ? listed.length : 0,
    detailResultCount: detailRows.length,
    productCount: Array.isArray(products) ? products.length : 0,
    quality: quality || null,
    error: error ? { name: error.name || 'Error', message: String(error.message || error).slice(0, 1000) } : null
  });
  if (listingResult) writeJsonAtomic(path.join(backupDir, 'listing.json'), listingResult);
  else if (Array.isArray(listed)) writeJsonAtomic(path.join(backupDir, 'listing.json'), { items: listed, pageStats: [] });
  if (selection) writeJsonAtomic(path.join(backupDir, 'selection.json'), selection);
  if (detailRows.length) writeJsonAtomic(path.join(backupDir, 'detail-results.json'), detailRows);
  if (Array.isArray(products) && products.length) {
    writeJsonAtomic(path.join(backupDir, 'products.json'), products);
    writeCsv(path.join(backupDir, 'products.csv'), products, columns);
  }
  return backupDir;
}
function readFreshListingCache() {
  if (!fs.existsSync(LISTING_CACHE_FILE)) return null;
  try {
    const cached = JSON.parse(fs.readFileSync(LISTING_CACHE_FILE, 'utf8'));
    const ageMs = Date.now() - new Date(cached.capturedAt).getTime();
    const maxAgeMs = Number(config.listingCacheMaxAgeMinutes || 30) * 60 * 1000;
    const minimum = Number(config.minimumProducts || config.maxProducts || 100);
    if (cached.profile !== PROFILE || cached.searchUrl !== config.searchUrl || ageMs < 0 || ageMs > maxAgeMs || !Array.isArray(cached.items) || cached.items.length < minimum) return null;
    return { items: cached.items, pageStats: cached.pageStats || [], fromCache: true, capturedAt: cached.capturedAt };
  } catch { return null; }
}
const numericHistoryFields = new Set([
  'source_page','search_position','bestseller_rank','category_rank','rank_scope_position','rank_delta','trend_score','niche_score','seller_score','price','original_price','discount_percent','price_delta_percent',
  'sales_signal_days','sales_signal_min','sales_signal_daily_min','rating','rating_count','review_count','review_delta','question_count','shipping_cost','handling_days_min','handling_days_max','transit_days_min','transit_days_max','sample_review_count','sample_review_avg','detail_age_days'
]);
const jsonHistoryFields = new Set(['campaigns','properties','data_sources','field_availability','detail_selection']);
function hydrateHistoryRow(row) {
  const out = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (value === '') out[key] = null;
    else if (numericHistoryFields.has(key)) out[key] = Number(value);
    else if (jsonHistoryFields.has(key)) { try { out[key] = JSON.parse(value); } catch { out[key] = value; } }
    else if (key === 'detail_ok' || key === 'detail_attempted') out[key] = value === 'true' ? true : value === 'false' ? false : null;
    else out[key] = value;
  }
  return out;
}
function latestHistoryByProduct(history) {
  const rows = history.map(hydrateHistoryRow).sort((a, b) => String(b.captured_at || b.date || '').localeCompare(String(a.captured_at || a.date || '')));
  const map = new Map();
  for (const row of rows) if (row.product_id && !map.has(row.product_id)) map.set(row.product_id, row);
  return map;
}
function chooseDetailItems(listed, history, date) {
  const topN = Number(config.dailyFullDetailTopN || 200);
  const rotateN = Number(config.dailyRotatingDetailN ?? 200);
  const hotLimit = Number(config.hotDetailLimit || 50);
  const reasons = new Map();
  const add = (item, reason) => {
    if (!item) return;
    if (!reasons.has(item.product_id)) reasons.set(item.product_id, new Set());
    reasons.get(item.product_id).add(reason);
  };
  listed.slice(0, topN).forEach(item => add(item, 'daily_top'));
  const rotationPool = listed.slice(topN);
  const blockCount = Math.max(1, Math.ceil(rotationPool.length / Math.max(1, rotateN)));
  const dayNumber = Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000);
  const rotationIndex = ((dayNumber % blockCount) + blockCount) % blockCount;
  rotationPool.slice(rotationIndex * rotateN, rotationIndex * rotateN + rotateN).forEach(item => add(item, `rotation_${rotationIndex + 1}_of_${blockCount}`));
  const previous = latestHistoryByProduct(history.filter(row => row.date && row.date < date));
  const hot = listed.filter(item => {
    const old = previous.get(item.product_id);
    if (!old) return false;
    const rankMove = Math.abs(Number(old.bestseller_rank || 0) - Number(item.bestseller_rank || 0));
    const priceMove = Number(old.price) > 0 && Number(item.price) > 0 ? Math.abs(Number(item.price) / Number(old.price) - 1) * 100 : 0;
    return rankMove >= 20 || priceMove >= 5 || old.stock_status !== item.stock_status;
  }).sort((a, b) => {
    const ao = previous.get(a.product_id); const bo = previous.get(b.product_id);
    return Math.abs(Number(bo?.bestseller_rank || 0) - b.bestseller_rank) - Math.abs(Number(ao?.bestseller_rank || 0) - a.bestseller_rank);
  }).slice(0, hotLimit);
  hot.forEach(item => add(item, 'hot_change'));
  const items = listed.filter(item => reasons.has(item.product_id)).map(item => ({ ...item, detail_selection: [...reasons.get(item.product_id)] }));
  return { items, reasons, topN: Math.min(topN, listed.length), rotationN: Math.min(rotateN, rotationPool.length), rotationIndex, rotationBlocks: blockCount, hotN: hot.length };
}
function extractMoney(text) {
  const lines = String(text || '').split(/\n+/).map(normalize).filter(Boolean);
  const priceLines = lines.filter(line => /\bTL\b/.test(line) && !/Kupon|Taksit|aylık|başlayan|\/adet/i.test(line));
  return priceLines.flatMap(line => [...line.matchAll(/(?:^|\s)(\d{1,3}(?:\.\d{3})*(?:,\d{2})?|\d+(?:,\d{2})?)\s*TL\b/g)].map(m => trNumber(m[1])));
}
function pickCampaigns(text) {
  const patterns = [
    /Sepette\s+%\d+\s+İndirim/gi, /\d+[.,]?\d*\s*TL\s+Kupon/gi,
    /Kargo Bedava/gi, /Peşin Fiyatına\s+\d+\s+Taksit/gi,
    /Son 10 Günün En Düşük Fiyatı/gi, /Trendyol Plus'a Özel/gi,
    /Süper Fırsat Ürünü/gi
  ];
  return [...new Set(patterns.flatMap(r => [...String(text || '').matchAll(r)].map(m => normalize(m[0]))))];
}
function parseListingCard(raw, position, href, listingTitle, listingBrand, sourcePage, sourceSegment, sourceQuery, segmentPosition) {
  const text = normalize(raw);
  const monies = extractMoney(raw);
  const explicitRank = firstMatch(text, /En Çok Satan\s+(\d+)\.\s*Ürün/i);
  const hubRank = firstMatch(text, /^(\d+)\b/);
  const price = monies.length ? monies[monies.length >= 2 ? monies.length - 2 : 0] : null;
  const originalPrice = monies.length >= 2 ? monies[monies.length - 1] : null;
  const rating = schemaNumber(firstMatch(text, /\b([1-5][.,]\d)\s*\([\d.]+\)/));
  const ratingCount = trNumber(firstMatch(text, /\b[1-5][.,]\d\s*\(([\d.]+)\)/));
  const title = normalize(listingTitle);
  const product = productId(href);
  const merchant = merchantId(href);
  const salesSignal = firstMatch(text, /((?:Son\s+)?\d+\s+günde\s+[\d.,]+[BMK]?\+?\s+ürün\s+satıldı!?)/i);
  return {
    product_id: product, url: href.split('#')[0], merchant_id: merchant, offer_key: offerKey(product, merchant),
    search_position: position, bestseller_rank: position, category_rank: explicitRank ? Number(explicitRank) : (hubRank ? Number(hubRank) : null),
    rank_scope: rankScope(sourceSegment), rank_scope_position: segmentPosition,
    source_segment: sourceSegment, source_query: sourceQuery, segment_position: segmentPosition, source_page: sourcePage,
    listing_title: title, listing_brand: normalize(listingBrand), title,
    brand: normalize(listingBrand || brandFromUrl(href, title)),
    listing_text: text, listing_price: price, listing_original_price: originalPrice,
    price, original_price: originalPrice && originalPrice > price ? originalPrice : null,
    discount_percent: originalPrice && price && originalPrice > price ? Math.round((1 - price / originalPrice) * 1000) / 10 : null,
    currency: 'TRY', rating, rating_count: ratingCount,
    stock_status: /Stokta Yok/i.test(text) ? 'OutOfStock' : 'InStock',
    stock_signal: firstMatch(text, /(son \d+ ürün|tükenmek üzere|stokta yok)/i),
    sales_signal: salesSignal,
    ...parseSalesSignal(salesSignal),
    campaigns: pickCampaigns(text),
    badge: firstMatch(text, /(En Çok Satan\s+\d+\.\s*Ürün|En Çok Ziyaret Edilen\s+\d+\.\s*Ürün|En Çok Favorilenen\s+\d+\.\s*Ürün|Fenomen Seçimi)/i),
    detail_status: 'listing_only', detail_attempted: false, detail_ok: null
  };
}
async function gotoWithRetry(page, url, attempts = 3, timeoutMs = 60000) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForTimeout(2600 + i * 1200);
      const title = await page.title();
      if (/Just a moment|Access denied|Cloudflare/i.test(title)) throw new Error(`blocked title: ${title}`);
      return;
    } catch (e) { last = e; await sleep(2500 * (i + 1)); }
  }
  throw last;
}
async function collectListing(page) {
  const seen = new Set(); const unique = []; const pageStats = [];
  const segments = config.searchSegments?.length ? config.searchSegments : [{ name: 'genel-cocuk', query: config.query }];
  const maxPages = Number(config.maxPagesPerSegment || 16);
  const maxConsecutiveZeroPages = Number(config.maxConsecutiveZeroPages || 3);
  const isBestSellerHub = config.listingMode === 'bestSellerHub';
  const requireAddToCart = config.requireAddToCart !== false;
  let listingError = null;
  try {
    segmentLoop: for (const segment of segments) {
    let zeroStreak = 0; let segmentPosition = 0;
    const segmentMaxPages = Number(segment.maxPages || maxPages);
    for (let pageNo = 1; pageNo <= segmentMaxPages && unique.length < config.maxProducts; pageNo++) {
      const pageUrl = new URL(segment.url || config.searchUrl);
      const sourceQuery = segment.tab || segment.query || (segment.wc ? `wc=${segment.wc}` : null) || (segment.bu ? `bu=${segment.bu}` : null) || config.sourceLabel || segment.name;
      if (segment.wc) {
        pageUrl.searchParams.set('wc', segment.wc);
      }
      if (segment.bu) {
        pageUrl.searchParams.set('bu', segment.bu);
      }
      if (!segment.wc && !segment.bu && !segment.preserveUrl && segment.query) {
        pageUrl.searchParams.set('q', segment.query); pageUrl.searchParams.set('qt', segment.query); pageUrl.searchParams.set('st', segment.query);
      }
      if (!isBestSellerHub) pageUrl.searchParams.set('pi', String(pageNo));
      let cards = [];
      const contentAttempts = segment === segments[0] && pageNo === 1
        ? Number(config.firstPageContentAttempts || 3)
        : 1;
      for (let contentAttempt = 0; contentAttempt < contentAttempts; contentAttempt++) {
        await gotoWithRetry(page, pageUrl.toString());
        if (isBestSellerHub && segment.tab) {
          const tab = page.getByRole('button', { name: segment.tab, exact: true });
          await tab.first().waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          if (await tab.count() === 0) {
            const error = `Çok Satanlar kategori sekmesi bulunamadı: ${segment.tab}`;
            console.warn(error);
            pageStats.push({ segment: segment.name, page: pageNo, added: 0, error });
            continue segmentLoop;
          }
          const beforeId = await page.locator('a[href*="-p-"]').first().getAttribute('href').catch(() => null);
          await tab.first().click({ force: true });
          await page.waitForFunction(previous => {
            const href = document.querySelector('a[href*="-p-"]')?.getAttribute('href') || null;
            return href && href !== previous;
          }, beforeId, { timeout: 10000 }).catch(() => {});
          await page.waitForTimeout(1800);
        }
        const scrollCount = Number(config.listingScrollCount || 5);
        for (let i = 0; i < scrollCount; i++) { await page.mouse.wheel(0, 2200); await page.waitForTimeout(650); }
        const useHubCardTitles = isBestSellerHub || pageUrl.pathname === '/cok-satanlar';
        cards = await page.locator('a[href*="-p-"]').evaluateAll((els, hubMode) => els.map(e => {
          const text = e.innerText;
          const lines = text.split(/\n+/).map(line => line.trim()).filter(Boolean);
          let hubTitle = '';
          if (hubMode) {
            let titleIndex = /^\d+$/.test(lines[0] || '') ? 1 : 0;
            while (/^(?:🚀\s*)?Popüler$|^\d+\s+Sıra\s+(?:Yükseldi|Düştü)$/i.test(lines[titleIndex] || '')) titleIndex++;
            hubTitle = lines[titleIndex] || '';
          }
          return {
            href: e.href,
            text,
            title: hubTitle || e.querySelector('.prdct-desc-cntnr-name')?.textContent || e.querySelector('h2')?.innerText || e.querySelector('img[alt]')?.getAttribute('alt') || '',
            brand: e.querySelector('.prdct-desc-cntnr-ttl')?.textContent || e.querySelector('h2 strong')?.innerText || e.querySelector('strong')?.innerText || ''
          };
        }), useHubCardTitles);
        const usable = cards.filter(card => /-p-\d+/.test(card.href) && (card.title || card.text.trim())).length;
        if (usable >= 10 || contentAttempt === contentAttempts - 1) break;
        await sleep(15000 * (contentAttempt + 1));
      }
      let added = 0;
      for (const card of cards) {
        const id = (card.href.match(/-p-(\d+)/) || [])[1];
        if (!id || seen.has(id) || (!card.title && !card.text.trim())) continue;
        const isOutOfStock = /Tükendi|Stokta Yok|gelince haber ver/i.test(card.text);
        const isInStock = /Sepete Ekle|Şimdi Al/i.test(card.text);
        const available = isOutOfStock ? false : isInStock ? true : null;
        seen.add(id); segmentPosition++; unique.push({ ...card, product_id: id, available, sourcePage: pageNo, sourceSegment: segment.name, sourceQuery, segmentPosition }); added++;
        if (unique.length >= config.maxProducts || added >= Number(segment.limit || config.maxProducts)) break;
      }
      pageStats.push({ segment: segment.name, query: sourceQuery, page: pageNo, cards: cards.length, added, segmentTotal: segmentPosition, total: unique.length, url: pageUrl.toString() });
      console.log(`LISTING_PROGRESS profile=${PROFILE} segment=${segment.name} page=${pageNo} added=${added} total=${unique.length}`);
      if (segment === segments[0] && pageNo === 1 && added < 10) {
        console.warn(`LISTING_PRIMARY_WEAK profile=${PROFILE} added=${added}; yedek segmentlere devam ediliyor.`);
      }
      if (added >= Number(segment.limit || config.maxProducts)) break;
      zeroStreak = added === 0 ? zeroStreak + 1 : 0;
      if (zeroStreak >= maxConsecutiveZeroPages) break;
      await sleep(added === 0 ? config.requestDelayMs * 3 : config.requestDelayMs);
    }
    if (unique.length >= config.maxProducts) break;
    }
  } catch (error) {
    listingError = { name: error.name || 'Error', message: String(error.message || error).slice(0, 1000) };
    console.error(`LISTING_PARTIAL profile=${PROFILE} products=${unique.length} error=${listingError.message}`);
  }
  return {
    items: unique.slice(0, config.maxProducts).map((c, i) => parseListingCard(c.text, i + 1, c.href, c.title, c.brand, c.sourcePage, c.sourceSegment, c.sourceQuery, c.segmentPosition)),
    pageStats,
    error: listingError
  };
}
function jsonLdProduct(items) {
  for (const raw of items) {
    try {
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : parsed['@graph'] || [parsed];
      const found = candidates.find(x => x && x['@type'] === 'Product');
      if (found) return found;
    } catch {}
  }
  return {};
}
function jsonLdBreadcrumb(items) {
  for (const raw of items) {
    try {
      const parsed = JSON.parse(raw);
      const candidates = Array.isArray(parsed) ? parsed : parsed['@graph'] || [parsed];
      const found = candidates.find(x => x && (x['@type'] === 'BreadcrumbList' || x['@type'] === 'Breadcrumb'));
      if (found?.itemListElement?.length) {
        const sorted = [...found.itemListElement].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
        const names = sorted.map(item => item.name || item.item?.name).filter(Boolean);
        if (names.length) return names[names.length - 1];
      }
    } catch {}
  }
  return null;
}
async function collectDetail(context, item, index, options = {}) {
  const page = await context.newPage();
  // Question totals arrive after the initial HTML. Retain only the aggregate,
  // never question text or customer details, and match this exact product.
  let resolveQuestions;
  const questionsReady = new Promise(resolve => { resolveQuestions = resolve; });
  page.on('response', async response => {
    try {
      const url = new URL(response.url());
      if (url.hostname !== 'apigw.trendyol.com' || !url.pathname.endsWith(`/merchant-questions/content/${item.product_id}/answered`) || !response.ok()) return;
      const total = count((await response.json())?.questions?.totalElements);
      if (total !== null) resolveQuestions(total);
    } catch { /* Missing dynamic data remains unknown. */ }
  });
  try {
    await gotoWithRetry(
      page,
      item.url,
      Number(config.detailNavigationAttempts || 1),
      Number(config.detailNavigationTimeoutMs || 30000)
    );
    // Most product pages now include the aggregate question count in the initial
    // product payload. Avoid waiting for the secondary question request when the
    // public HTML already contains the value.
    const initialHtml = await page.content();
    const initialMetrics = extractProductMetrics(initialHtml, item.product_id);
    const questionTotal = initialMetrics?.question_count ?? await Promise.race([
      questionsReady,
      sleep(Number(options.questionWaitMs ?? 4000)).then(() => null)
    ]);
    const payload = await page.evaluate(() => ({
      body: document.body.innerText,
      html: document.documentElement.outerHTML,
      jsonld: [...document.querySelectorAll('script[type="application/ld+json"]')].map(x => x.textContent),
      canonical: document.querySelector('link[rel="canonical"]')?.href || location.href
    }));
    const p = jsonLdProduct(payload.jsonld);
    const metrics = extractProductMetrics(payload.html, item.product_id) || initialMetrics;
    if (!p.name && !metrics) throw new Error('Product payload missing; refusing successful detail status');
    const body = payload.body;
    const offer = Array.isArray(p.offers) ? (p.offers[0] || {}) : (p.offers || {});
    const rating = p.aggregateRating || {};
    const shipping = offer.shippingDetails || {};
    const delivery = shipping.deliveryTime || {};
    const title = normalize(p.name) || item.listing_title || firstMatch(body, /En Çok Satılan #\d+\s+(.+?)\s+\d[.,]\d\s+\d+ Değerlendirme/s);
    const sellerCandidate = normalize(offer.seller?.name || offer.seller?.legalName) ||
      firstMatch(body, /Bu ürün\s+(.+?)\s+tarafından gönderilecektir\./i) ||
      firstMatch(body, /Öne Çıkan Özellikler:\s*Bu ürün\s+(.+?)\s+tarafından/i) ||
      firstMatch(body, /(?:^|\n)Satıcı\s*:?\s*\n([^\n]{2,100})/im);
    const seller = /^(?:Trendyol'da Satış Yap|Giriş Yap|Favorilerim|Sepetim)$/i.test(sellerCandidate || '') ? null : sellerCandidate;
    const sellerBlock = seller ? body.slice(Math.max(0, body.lastIndexOf(seller)), body.lastIndexOf(seller) + 250) : '';
    const price = schemaNumber(offer.price) ?? item.listing_price;
    const original = item.listing_original_price && item.listing_original_price > price ? item.listing_original_price : null;
    const stockText = firstMatch(body, /(\d+\s+adetten fazla stok sunulmuştur|son \d+ ürün|tükenmek üzere|stokta yok)/i);
    const deliveryText = firstMatch(body, /([^\n]{0,80}(?:yarın kargoda|Tahmini Teslim|en geç)[^\n]{0,100})/i);
    const question = firstMatch(body, /([\d.,]+)\s+Soru\s*[-–]\s*Cevap/i) || firstMatch(body, /Satıcı Soruları\s*\(([\d.,]+)\)/i);
    const reviews = Array.isArray(p.review) ? p.review : [];
    const properties = Object.fromEntries((p.additionalProperty || []).map(x => [normalize(x.name), normalize(x.unitText || x.value)]));
    const salesSignal = item.sales_signal || firstMatch(body, /(\d+\s+günde\s+[\d.,]+[BMK]?\+?\s+ürün satıldı!?)/i);
    const breadcrumbCategory = jsonLdBreadcrumb(payload.jsonld);
    const category = normalize(p.category?.name || p.category || breadcrumbCategory || item.listing_category || item.category || null);
    const result = {
      ...item, detail_status: 'refreshed', detail_attempted: true, detail_ok: true, detail_error: null, canonical_url: payload.canonical,
      title, brand: normalize(p.brand?.name || p.manufacturer || item.listing_brand || brandFromUrl(item.url, title)), category,
      available: (offer.availability ? (String(offer.availability).includes('InStock') ? true : String(offer.availability).includes('OutOfStock') ? false : null) : null) ?? (/tükendi|stokta yok/i.test(body) ? false : /Sepete Ekle|Şimdi Al/i.test(body) ? true : null) ?? item.available ?? null,
      seller_name: seller, seller_score: trNumber(firstMatch(sellerBlock, new RegExp(`${String(seller || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+([0-9]+(?:[.,][0-9]+)?)`))),
      price, original_price: original,
      discount_percent: original && price ? Math.round((1 - price / original) * 1000) / 10 : null,
      currency: offer.priceCurrency || 'TRY', campaigns: [...new Set([...(item.campaigns || []), ...pickCampaigns(body)])],
      stock_status: String(offer.availability || '').split('/').pop() || (/stokta yok/i.test(body) ? 'OutOfStock' : (/Sepete Ekle|Şimdi Al/i.test(body) ? 'InStock' : null)), stock_signal: stockText,
      rating: schemaNumber(rating.ratingValue) ?? schemaNumber(firstMatch(body, /\n(\d[.,]\d)\n[\d.]+\s+Değerlendirme/i)),
      rating_count: schemaNumber(rating.ratingCount) ?? trNumber(firstMatch(body, /\n([\d.]+)\s+Değerlendirme/i)),
      review_count: schemaNumber(rating.reviewCount), question_count: questionTotal ?? trNumber(question),
      sales_signal: salesSignal,
      ...parseSalesSignal(salesSignal),
      basket_signal: firstMatch(body, /([\d.,]+[BMK]?\s+kişinin sepetinde)/i),
      favorite_signal: firstMatch(body, /([\d.,]+[BMK]?\s+kişi favoriledi)/i),
      view_signal: firstMatch(body, /(Son 24 saatte\s+[\d.,]+[BMK]?\s+kişi görüntüledi)/i),
      shipping_cost: trNumber(shipping.shippingRate?.value), shipping_currency: shipping.shippingRate?.currency || null,
      handling_days_min: Number(delivery.handlingTime?.minValue) || 0, handling_days_max: Number(delivery.handlingTime?.maxValue) || null,
      transit_days_min: Number(delivery.transitTime?.minValue) || null, transit_days_max: Number(delivery.transitTime?.maxValue) || null,
      delivery_summary: deliveryText, image_url: Array.isArray(p.image?.contentUrl) ? p.image.contentUrl[0] : p.image?.contentUrl || p.image || null,
      properties, sample_review_count: reviews.length,
      sample_review_avg: reviews.length ? Math.round(reviews.reduce((a, r) => a + Number(r.reviewRating?.ratingValue || 0), 0) / reviews.length * 100) / 100 : null
    };
    if (metrics) {
      // Clear missing metrics explicitly so yesterday's quantity cannot masquerade as fresh.
      for (const field of METRIC_FIELDS) result[field] = metrics[field] ?? null;
      for (const field of ['merchant_id','offer_key','seller_name','seller_score','stock_status','stock_signal','price','original_price','rating','rating_count','review_count','question_count']) {
        if (metrics[field] !== null && metrics[field] !== undefined) result[field] = metrics[field];
      }
    } else for (const field of METRIC_FIELDS) result[field] = null;
    result.original_price = result.original_price > result.price ? result.original_price : null;
    result.discount_percent = result.original_price && result.price ? Math.round((1-result.price/result.original_price)*1000)/10 : null;
    result.detail_refreshed_at = new Date().toISOString();
    return result;
  } catch (e) {
    return { ...item, detail_status: 'failed', detail_attempted: true, detail_ok: false, detail_error: normalize(e.message).slice(0, 300) };
  } finally {
    await Promise.race([page.close(), sleep(5000)]).catch(() => {});
    await sleep(config.requestDelayMs);
  }
}
function ageInDays(date, timestamp) {
  if (!timestamp) return null;
  const current = Date.parse(`${date}T00:00:00Z`);
  const previous = Date.parse(`${String(timestamp).slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(current) && Number.isFinite(previous) ? Math.max(0, Math.floor((current - previous) / 86400000)) : null;
}
function mergePoolProducts(listed, detailResults, history, timestamp, date, selection) {
  const resultMap = new Map(detailResults.map(p => [p.product_id, p]));
  const previous = latestHistoryByProduct(history);
  return listed.map(item => {
    const old = previous.get(item.product_id);
    const fresh = resultMap.get(item.product_id);
    let base;
    if (fresh?.detail_ok) {
      base = { ...old, ...fresh, detail_status: 'refreshed', detail_attempted: true, detail_ok: true, detail_refreshed_at: fresh.detail_refreshed_at || timestamp, detail_age_days: 0 };
    } else if (fresh) {
      const oldRefreshedAt = old?.detail_refreshed_at || old?.captured_at || null;
      base = { ...old, ...item, ...fresh, detail_status: old ? 'failed_carried_forward' : 'failed', detail_attempted: true, detail_ok: false, detail_refreshed_at: oldRefreshedAt, detail_age_days: ageInDays(date, oldRefreshedAt) };
    } else {
      const oldRefreshedAt = old?.detail_refreshed_at || (old?.detail_ok ? old.captured_at : null);
      base = { ...old, ...item, detail_status: oldRefreshedAt ? 'carried_forward' : 'listing_only', detail_attempted: false, detail_ok: null, detail_refreshed_at: oldRefreshedAt, detail_age_days: ageInDays(date, oldRefreshedAt), detail_selection: [] };
    }
    if (base.detail_status !== 'refreshed') for (const field of METRIC_FIELDS) base[field] = null;
    base.date = date; base.captured_at = timestamp; base.query = config.query; base.sort = config.sort;
    base.data_sources = base.detail_status === 'refreshed' ? ['search_result_dom','product_detail_jsonld','product_detail_dom'] : old ? ['search_result_dom','historical_product_detail'] : ['search_result_dom'];
    return base;
  });
}
function previousObservations(history, today) {
  const prior = history.map(hydrateHistoryRow).filter(r => r.date && r.date < today).sort((a, b) => b.date.localeCompare(a.date));
  const byProduct = new Map();
  const byRankScope = new Map();
  const byOffer = new Map();
  for (const row of prior) {
    if (row.product_id && !byProduct.has(row.product_id)) byProduct.set(row.product_id, row);
    const scope = row.rank_scope || rankScope(row.source_segment);
    const rankKey = row.product_id && scope ? `${row.product_id}:${scope}` : null;
    if (rankKey && !byRankScope.has(rankKey)) byRankScope.set(rankKey, row);
    const currentOfferKey = row.offer_key || offerKey(row.product_id, row.merchant_id);
    if (row.product_id && currentOfferKey && !byOffer.has(currentOfferKey)) byOffer.set(currentOfferKey, row);
  }
  return { byProduct, byRankScope, byOffer };
}
function scoreProducts(products, history, today) {
  const previous = previousObservations(history, today);
  return products.map(p => {
    const scope = p.rank_scope || rankScope(p.source_segment);
    const scopePosition = Number(p.rank_scope_position || p.segment_position || p.bestseller_rank || 0);
    const oldProduct = previous.byProduct.get(p.product_id);
    const oldRank = previous.byRankScope.get(`${p.product_id}:${scope}`);
    const currentOfferKey = p.offer_key || offerKey(p.product_id, p.merchant_id);
    const oldOffer = previous.byOffer.get(currentOfferKey);
    const oldScopePosition = Number(oldRank?.rank_scope_position || oldRank?.segment_position || oldRank?.bestseller_rank || 0);
    const rankDelta = oldRank && oldScopePosition > 0 && scopePosition > 0 ? oldScopePosition - scopePosition : null;
    const priceDeltaPct = oldOffer && Number(oldOffer.price) ? Math.round((Number(p.price) / Number(oldOffer.price) - 1) * 1000) / 10 : null;
    const reviewDelta = oldProduct && p.review_count != null && oldProduct.review_count !== '' && oldProduct.review_count != null ? Number(p.review_count) - Number(oldProduct.review_count) : null;
    const estimate = estimateInventory(p, oldProduct);
    const measured = { ...p, ...estimate };
    estimate.sales_estimate_weekly = periodEstimate(history, measured, 7);
    estimate.sales_estimate_monthly = periodEstimate(history, measured, 30);
    const competitionCount = p.review_count ?? p.rating_count;
    const trendScore = Math.round((Math.max(0, 40 - scopePosition) * 2 + Math.log10((competitionCount || 0) + 1) * 8 + Math.min(30, (p.sales_signal_daily_min || 0) / 20) + Math.max(0, p.discount_percent || 0)) * 10) / 10;
    const nicheScore = competitionCount === null || competitionCount === undefined ? null : Math.round((Math.min(50, (p.sales_signal_daily_min || 0) / 8) + Math.max(0, 30 - Math.log10(competitionCount + 1) * 8) + Math.max(0, 25 - scopePosition / 2)) * 10) / 10;
    return { ...p, ...estimate, rank_scope: scope, rank_scope_position: scopePosition, offer_key: currentOfferKey, rank_delta: rankDelta, price_delta_percent: priceDeltaPct, review_delta: reviewDelta, trend_score: trendScore, niche_score: nicheScore };
  });
}
const columns = [
  ...METRIC_FIELDS,
  'date','captured_at','query','sort','source_segment','source_query','segment_position','source_page','search_position','bestseller_rank','category_rank','rank_scope','rank_scope_position','rank_delta','trend_score','niche_score',
  'product_id','merchant_id','offer_key','title','brand','category','url','seller_name','seller_score','price','original_price','discount_percent','price_delta_percent','currency',
  'campaigns','stock_status','stock_signal','sales_signal','sales_signal_days','sales_signal_min','sales_signal_daily_min','rating','rating_count','review_count','review_delta','question_count',
  'basket_signal','favorite_signal','view_signal','shipping_cost','shipping_currency','handling_days_min','handling_days_max','transit_days_min','transit_days_max','delivery_summary',
  'badge','image_url','properties','sample_review_count','sample_review_avg','detail_status','detail_selection','detail_attempted','detail_refreshed_at','detail_age_days','data_sources','field_availability','detail_ok','detail_error'
];
function mdTable(rows, fields) {
  if (!rows.length) return '_Bugün bu liste için yeterli karşılaştırmalı sinyal oluşmadı._';
  const header = `| ${fields.map(f => f[1]).join(' | ')} |\n| ${fields.map(() => '---').join(' | ')} |`;
  const body = rows.map(r => `| ${fields.map(([k]) => {
    const value = normalize(Array.isArray(r[k]) ? r[k].join('; ') : r[k] ?? '-').replace(/\|/g, '/');
    return k === 'title' && r.url && value !== '-' ? `[${value.replace(/\]/g, '\\]')}](${r.url})` : value;
  }).join(' | ')} |`).join('\n');
  return `${header}\n${body}`;
}
const listCols = ['rank_scope','rank_scope_position','bestseller_rank','rank_delta','trend_score','niche_score','product_id','merchant_id','offer_key','title','brand','seller_name','price','original_price','price_delta_percent','stock_status','sales_signal','sales_signal_days','sales_signal_min','sales_signal_daily_min','rating','review_count','review_delta','question_count','campaigns','delivery_summary','detail_status','detail_age_days','url'];
const listMdFields = [['rank_scope_position','Kapsam içi sıra'],['rank_delta','Sıra Δ'],['trend_score','Trend'],['niche_score','Niche'],['title','Ürün'],['brand','Marka'],['seller_name','Satıcı'],['price','Fiyat TL'],['stock_status','Stok'],['rating','Puan'],['review_count','Yorum'],['question_count','Soru'],['detail_status','Detay'],['detail_age_days','Yaş (gün)'],['campaigns','Kampanya']];
const listTitles = {
  'rising.csv': 'Yükselen Ürünler', 'falling.csv': 'Düşen Ürünler', 'trending.csv': 'Trend Ürünler',
  'niche.csv': 'Niche Fırsatlar', 'campaigns.csv': 'Kampanyalı Ürünler',
  'stock-risk.csv': 'Stok Riski', 'price-drops.csv': 'Fiyatı Düşen Ürünler'
};
function buildLists(scored) {
  return {
    'rising.csv': scored.filter(p=>(p.rank_delta||0)>0||(p.review_delta||0)>0).sort((a,b)=>(b.rank_delta||0)-(a.rank_delta||0)||(b.review_delta||0)-(a.review_delta||0)),
    'falling.csv': scored.filter(p=>(p.rank_delta||0)<0||p.stock_status==='OutOfStock').sort((a,b)=>(a.rank_delta||0)-(b.rank_delta||0)),
    'trending.csv': [...scored].sort((a,b)=>b.trend_score-a.trend_score),
    'niche.csv': scored.filter(p=>(p.sales_signal_min||0)>=100&&(p.review_count??p.rating_count)!==null&&(p.review_count??p.rating_count)<2500).sort((a,b)=>b.niche_score-a.niche_score),
    'campaigns.csv': scored.filter(p=>p.campaigns?.length||p.discount_percent).sort((a,b)=>(b.discount_percent||0)-(a.discount_percent||0)),
    'stock-risk.csv': scored.filter(p=>p.stock_status==='OutOfStock'||/son \d+ ürün|tüken/i.test(p.stock_signal||'')),
    'price-drops.csv': scored.filter(p=>(p.price_delta_percent||0)<0).sort((a,b)=>a.price_delta_percent-b.price_delta_percent)
  };
}
function median(nums) { const a = nums.filter(Number.isFinite).sort((x,y)=>x-y); return a.length ? a[Math.floor(a.length / 2)] : null; }
function generateReport(products, date, quality) {
  const rising = products.filter(p => (p.rank_delta || 0) > 0 || (p.review_delta || 0) > 0).sort((a,b)=>(b.rank_delta||0)-(a.rank_delta||0)||(b.review_delta||0)-(a.review_delta||0));
  const falling = products.filter(p => (p.rank_delta || 0) < 0 || p.stock_status === 'OutOfStock').sort((a,b)=>(a.rank_delta||0)-(b.rank_delta||0));
  const trending = [...products].sort((a,b)=>b.trend_score-a.trend_score);
  const niche = products.filter(p => (p.sales_signal_min || 0) >= 100 && (p.review_count ?? p.rating_count) !== null && (p.review_count ?? p.rating_count) < 2500).sort((a,b)=>b.niche_score-a.niche_score);
  const campaigns = products.filter(p => p.campaigns?.length || p.discount_percent).sort((a,b)=>(b.discount_percent||0)-(a.discount_percent||0));
  const stockRisk = products.filter(p => p.stock_status === 'OutOfStock' || /son \d+ ürün|tüken/i.test(p.stock_signal || ''));
  const prices = products.map(p => Number(p.price)).filter(Number.isFinite);
  const brandCounts = Object.entries(products.reduce((a,p)=>{a[p.brand||'Belirsiz']=(a[p.brand||'Belirsiz']||0)+1;return a;},{})).sort((a,b)=>b[1]-a[1]).slice(0,5);
  const themes = (config.themes || []).map(theme => {
    const re = new RegExp(theme.keywords, 'i');
    return [theme.name, products.filter(p => re.test(p.title || '')).length];
  }).sort((a,b)=>b[1]-a[1]);
  const priceBands = [
    ['250 TL altı', p=>p<250], ['250–500 TL', p=>p>=250&&p<500],
    ['500–1.000 TL', p=>p>=500&&p<1000], ['1.000 TL+', p=>p>=1000]
  ].map(([name,fn])=>[name, prices.filter(fn).length]);
  const firstDay = products.every(p => p.rank_delta === null);
  const detailStrategy = Number(quality.selection?.topN || 0) >= products.length
    ? `${products.length} ürünün tamamı günlük detay yenilemesinde.`
    : `İlk ${quality.selection?.topN || 0} ürün günlük, ${quality.selection?.rotationN || 0} ürün dönüşümlü yenileniyor${quality.selection?.hotN ? `; ${quality.selection.hotN} hızlı değişen ürün ayrıca önceliklendirildi` : ''}.`;
  const topFields = [['rank_scope_position','Kapsam içi sıra'],['source_query','Kapsam'],['title','Ürün'],['price','Fiyat TL'],['seller_name','Satıcı'],['rating','Puan'],['rating_count','Değerlendirme'],['review_count','Yorum'],['question_count','Soru'],['sales_signal','Satış sinyali']];
  return `# ${config.reportTitle || config.name} — ${date}\n\n` +
    `> Kaynak: [${config.sourceLabel || config.name}](${config.searchUrl})\n> Toplama zamanı: ${products[0]?.captured_at || '-'}\n> Havuz: ${products.length} ürün | Bugün detay yenilenen: ${quality.detailRefreshed}/${quality.detailAttempted} | Kalite: **${quality.status}**\n\n` +
    `## Yönetici özeti\n\n` +
    `- İzlenen ürünlerde medyan fiyat **${median(prices)?.toLocaleString('tr-TR') || '-'} TL**.\n` +
    `- En görünür markalar: ${brandCounts.map(([b,c])=>`${b} (${c})`).join(', ') || '-'}.\n` +
    `- Baskın ürün temaları: ${themes.map(([t,c])=>`${t} (${c})`).join(', ')}.\n` +
    `- Fiyat dağılımı: ${priceBands.map(([b,c])=>`${b}: ${c}`).join(', ')}.\n` +
    `- Kampanyalı ürün: **${campaigns.length}**, açık stok riski: **${stockRisk.length}**.\n` +
    `- Detay stratejisi: ${detailStrategy}\n` +
    `- Havuz durumu: **${quality.detailRefreshed}** bugün yenilendi, **${quality.carriedForward}** geçmiş detay taşıyor, **${quality.listingOnly}** yalnız liste sinyalleriyle izleniyor.\n` +
    `- ${firstDay ? 'Bugün baz çizgisi oluşturuldu; yükseliş/düşüş yorumu ikinci günlük ölçümden itibaren güvenilirleşecek.' : `Yükseliş sinyali ${rising.length}, düşüş sinyali ${falling.length} üründe görüldü.`}\n\n` +
    `## En çok satan ürünler\n\n${mdTable(products.slice(0,15), topFields)}\n\n` +
    `## Yükselen ürünler\n\n${mdTable(rising.slice(0,15), [['rank_delta','Sıra artışı'],['title','Ürün'],['price_delta_percent','Fiyat Δ%'],['review_delta','Yorum Δ'],['sales_signal','Satış sinyali']])}\n\n` +
    `## Düşen ürünler\n\n${mdTable(falling.slice(0,15), [['rank_delta','Sıra değişimi'],['title','Ürün'],['price_delta_percent','Fiyat Δ%'],['stock_status','Stok'],['stock_signal','Stok sinyali']])}\n\n` +
    `## Trend listesi\n\n${mdTable(trending.slice(0,15), [['trend_score','Trend skoru'],['bestseller_rank','Sıra'],['title','Ürün'],['sales_signal','Satış'],['review_count','Yorum'],['campaigns','Kampanya']])}\n\n` +
    `## Niche fırsat listesi\n\n${mdTable(niche.slice(0,15), [['niche_score','Niche skoru'],['title','Ürün'],['sales_signal','Satış'],['rating_count','Değerlendirme'],['review_count','Yorum'],['price','Fiyat TL'],['seller_name','Satıcı']])}\n\n` +
    `## Kampanya ve fiyat fırsatları\n\n${mdTable(campaigns.slice(0,15), [['discount_percent','İndirim %'],['title','Ürün'],['price','Fiyat TL'],['original_price','Eski fiyat'],['campaigns','Kampanyalar']])}\n\n` +
    `## Stok ve teslimat izlemesi\n\n${mdTable(products.slice(0,15), [['title','Ürün'],['stock_status','Stok'],['stock_signal','Stok sinyali'],['delivery_summary','Teslimat'],['seller_name','Satıcı']])}\n\n` +
    `## E-ticaret ve dijital pazarlama yorumu\n\n` +
    `1. **Talep doğrulama:** Yüksek satış sinyali ile düşük/orta değerlendirme hacmini birlikte taşıyan ürünler niche testine öncelik vermeli; yalnız sıralama rozetine bakılmamalı.\n` +
    `2. **Fiyat stratejisi:** Kampanya oranı yüksek ürünlerde indirimin kalıcılığı günlük fiyat geçmişinden kontrol edilmeli. Tek günlük “indirim” etiketi marj kararı için yeterli değildir.\n` +
    `3. **Reklam stratejisi:** Trend skoru yüksek, stokta olan ve hızlı teslim sinyali taşıyan ürünler performans reklamı için ilk adaylardır. Stok riski olan ürünlerde bütçe azaltılmalıdır.\n` +
    `4. **Ürün geliştirme:** Niche listesinde tekrarlanan tema, yaş, paket içeriği ve özellikler yeni ürün/tedarik brief'ine dönüştürülmelidir.\n` +
    `5. **Müşteri içgörüsü:** Soru ve yorum artışı, satış sinyalinden önce hızlanıyorsa yaklaşan talebin öncü göstergesi olarak izlenmelidir.\n` +
    `6. **Bugünün aksiyonu:** ${niche[0] ? `Niche testinde önce “${niche[0].title}” benzeri ürünlerin tedarik maliyeti, reklam CPC'si ve yorum bariyeri doğrulansın.` : 'İlk karşılaştırma verisi oluşana kadar küçük bütçeli ürün/anahtar kelime testleriyle talep doğrulansın.'}\n\n` +
    `## Veri kalitesi\n\n` +
    `- ${products.length} ürünlük çekirdek alan kapsaması: **${quality.coreCoverage}%**\n- Planlanan detay denemesi: **${quality.detailAttempted}**\n- Detay sayfası başarısı: **${quality.detailSuccessRate}%**\n- Yenilenen detaylarda satıcı kapsaması: **${quality.detailCoverage?.seller_name || 0}%**\n- Yenilenen detaylarda değerlendirme kapsaması: **${quality.detailCoverage?.rating_count || 0}%**\n- Havuz genelinde eksikliği yüksek alanlar: ${quality.lowCoverageFields.join(', ') || 'yok'}\n` +
    `\n_Not: Sıralama ve görünür sinyaller Trendyol sayfasının toplama anındaki durumudur; gerçek satış adedi veya stok miktarı olarak yorumlanmamalıdır._\n`;
}
function qualityFor(products) {
  const fields = ['stock_quantity','seller_count_observed','variant_id','inventory_key','product_id','title','url','price','seller_name','stock_status','rating','rating_count','review_count','question_count','delivery_summary'];
  const coverageFor = rows => Object.fromEntries(fields.map(f => [f, rows.length ? Math.round(rows.filter(p => p[f] !== null && p[f] !== undefined && p[f] !== '').length / rows.length * 1000) / 10 : 0]));
  const coverage = coverageFor(products);
  const attempted = products.filter(p => p.detail_attempted === true);
  const refreshed = products.filter(p => p.detail_status === 'refreshed' && p.detail_ok === true);
  const detailCoverage = coverageFor(refreshed);
  const core = ['product_id','title','url','price'];
  const coreCoverage = Math.round(core.reduce((a,f)=>a+coverage[f],0)/core.length*10)/10;
  const detailSuccessRate = attempted.length ? Math.round(refreshed.length/attempted.length*1000)/10 : 0;
  const detailTarget = Math.min(products.length, Number(config.dailyFullDetailTopN ?? 200) + Number(config.dailyRotatingDetailN ?? 200));
  const minimumRatingCountCoverage = Number(config.minimumRatingCountCoverage ?? 80);
  const status = products.length >= Number(config.minimumProducts || config.maxProducts || 200) && coreCoverage >= 95 && attempted.length >= detailTarget && detailSuccessRate >= 80 && detailCoverage.seller_name >= 80 && coverage.stock_status >= 90 && detailCoverage.rating_count >= minimumRatingCountCoverage ? 'PASS' : 'FAIL';
  return {
    status, productCount: products.length, coreCoverage, detailTarget,
    detailAttempted: attempted.length, detailRefreshed: refreshed.length, detailSuccessRate,
    carriedForward: products.filter(p=>/carried_forward/.test(p.detail_status || '')).length,
    listingOnly: products.filter(p=>p.detail_status === 'listing_only').length,
    coverage, detailCoverage, lowCoverageFields: fields.filter(f=>coverage[f]<70),
    thresholds: { minimumRatingCountCoverage }
  };
}
async function main() {
  // SAFETY OVERRIDE: Nonessential crawler schedules paused when host capacity guardrail triggers
  const CRAWLER_PAUSE_FILE = path.join(ROOT, '.runtime', 'crawler_pause_state.json');
  if (fs.existsSync(CRAWLER_PAUSE_FILE)) {
    try {
      const pauseState = JSON.parse(fs.readFileSync(CRAWLER_PAUSE_FILE, 'utf8'));
      if (pauseState && pauseState.crawlers_paused === true) {
        console.log(`[SAFETY_OVERRIDE] Nonessential crawler schedule PAUSED (reason: ${pauseState.pause_reason || 'CAPACITY_GUARDRAIL_TRIGGERED'}). Exiting safely without disk writes (ZERO_AUTOMATED_DELETION).`);
        process.exit(0);
      }
    } catch {}
  }

  const { chromium } = require('playwright');
  if (!fs.existsSync(CHROME)) throw new Error(`Chrome bulunamadı: ${CHROME}`);
  const { date, timestamp } = nowIstanbul();
  mkdir(path.join(OUTPUT_ROOT, 'data')); mkdir(path.join(OUTPUT_ROOT, 'reports')); mkdir(path.join(OUTPUT_ROOT, 'quality'));
  const browser = await chromium.launch({ headless: true, executablePath: CHROME, args: ['--disable-blink-features=AutomationControlled','--lang=tr-TR'] });
  const context = await browser.newContext({ locale: 'tr-TR', timezoneId: config.timezone, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
  let scored = null;
  let listingResult = null;
  let listed = [];
  let history = [];
  let selection = null;
  let detailed = [];
  let quality = null;
  const onTerminate = (signal, exitCode) => {
    try {
      const partialProducts = scored || (selection ? mergePoolProducts(listed, detailed, history, timestamp, date, selection) : listed);
      const backupDir = writeRecoveryBackup({ date, timestamp, status: 'terminated', reason: signal, listingResult, listed, selection, detailed, products: partialProducts, quality });
      console.error(`RECOVERY_BACKUP_WRITTEN status=terminated path=${backupDir}`);
    } catch (backupError) {
      console.error(`RECOVERY_BACKUP_FAILED ${backupError.stack || backupError.message}`);
    } finally {
      process.exit(exitCode);
    }
  };
  const handleSigterm = () => onTerminate('SIGTERM', 143);
  const handleSigint = () => onTerminate('SIGINT', 130);
  process.once('SIGTERM', handleSigterm);
  process.once('SIGINT', handleSigint);
  try {
    const listingSourceFile = cliArg('listing-source-file');
    listingResult = process.argv.includes('--use-listing-cache') ? readFreshListingCache() : null;
    if (!listingResult && listingSourceFile) {
      const imported = JSON.parse(fs.readFileSync(path.resolve(listingSourceFile), 'utf8'));
      listingResult = {
        items: imported.items.map((card, index) => parseListingCard(
          card.text, index + 1, card.href, card.title, card.brand,
          card.sourcePage, card.sourceSegment, card.sourceQuery, card.segmentPosition
        )),
        pageStats: imported.pageStats || [],
        importedAt: imported.capturedAt || null
      };
      writeListingCache(listingResult);
    }
    if (!listingResult) {
      const listingPage = await context.newPage();
      try { listingResult = await collectListing(listingPage); }
      finally { await listingPage.close(); }
      writeListingCache(listingResult);
    }
    listed = listingResult.items;
    if (process.argv.includes('--listing-only')) {
      console.log(JSON.stringify({ ok: listed.length >= Number(config.minimumProducts || config.maxProducts || 100), listingOnly: true, fromCache: Boolean(listingResult.fromCache), uniqueProducts: listed.length, pageStats: listingResult.pageStats, first: listed[0], last: listed[listed.length - 1] }, null, 2));
      if (listed.length < Number(config.minimumProducts || config.maxProducts || 100)) {
        const backupDir = writeRecoveryBackup({ date, timestamp, status: 'listing_partial', reason: 'listing_only_below_minimum', listingResult, listed });
        console.error(`RECOVERY_BACKUP_WRITTEN status=listing_partial path=${backupDir}`);
        process.exitCode = 2;
      }
      return;
    }
    if (listed.length < Number(config.minimumProducts || config.maxProducts || 100)) throw new Error(`Liste sayfalarından yalnız ${listed.length} benzersiz ürün alındı; gereken minimum ${config.minimumProducts || config.maxProducts || 100}. Son geçerli rapor korunuyor. Sayfa özeti: ${JSON.stringify(listingResult.pageStats)}`);
    const historyFile = path.join(OUTPUT_ROOT, 'data', 'history.csv');
    history = readCsv(historyFile);
    selection = chooseDetailItems(listed, history, date);
    detailed = new Array(selection.items.length); let cursor = 0; let completed = 0;
    console.log(`DETAIL_START profile=${PROFILE} products=${selection.items.length} concurrency=${config.detailConcurrency}`);
    async function worker() {
      while (true) {
        const i = cursor++;
        if (i >= selection.items.length) return;
        detailed[i] = await collectDetail(context, selection.items[i], i);
        completed++;
        if (completed % 10 === 0 || completed === selection.items.length) {
          const refreshed = detailed.filter(Boolean).filter(row => row.detail_ok === true).length;
          console.log(`DETAIL_PROGRESS profile=${PROFILE} completed=${completed}/${selection.items.length} refreshed=${refreshed}`);
        }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, config.detailConcurrency) }, worker));
    const pooled = mergePoolProducts(listed, detailed, history, timestamp, date, selection);
    const availabilityFields = [...METRIC_FIELDS,'title','brand','seller_name','seller_score','price','original_price','campaigns','stock_status','stock_signal','rating','rating_count','review_count','question_count','delivery_summary','shipping_cost','properties'];
    const enriched = pooled.map(p => {
      const base = { ...p };
      base.field_availability = Object.fromEntries(availabilityFields.map(f => [f, base[f] === null || base[f] === undefined || base[f] === '' || (Array.isArray(base[f]) && !base[f].length) ? 'unavailable' : 'observed']));
      return base;
    });
    scored = scoreProducts(enriched, history, date);
    quality = qualityFor(scored); quality.date = date; quality.generatedAt = timestamp;
    quality.selection = { topN: selection.topN, rotationN: selection.rotationN, rotationIndex: selection.rotationIndex + 1, rotationBlocks: selection.rotationBlocks, hotN: selection.hotN };
    if (quality.status !== 'PASS') {
      const backupDir = writeRecoveryBackup({ date, timestamp, status: 'quality_failed', reason: 'quality_gate_failed', listingResult, listed, selection, detailed, products: scored, quality });
      console.log(JSON.stringify({ ok: false, date, quality, preservedLastValidReport: true, recoveryBackup: backupDir }, null, 2));
      process.exitCode = 2;
      return;
    }
    const snapshotDir = path.join(OUTPUT_ROOT, 'snapshots', date); mkdir(snapshotDir);
    writeJsonAtomic(path.join(snapshotDir, 'products.json'), scored);
    // Incremental Append-Only Storage Hygiene (avoid repeated full rewrite)
    if (!fs.existsSync(historyFile)) {
      writeCsv(historyFile, scored, columns);
    } else {
      const dateAlreadyInHistory = history.some(r => r.date === date);
      if (!dateAlreadyInHistory) {
        const lines = scored.map(r => columns.map(c => {
          const v = r[c] === null || r[c] === undefined ? '' : String(r[c]);
          return v.includes(',') || v.includes('"') || v.includes('\n') ? `"${v.replace(/"/g, '""')}"` : v;
        }).join(','));
        fs.appendFileSync(historyFile, lines.join('\n') + '\n', 'utf8');
      } else {
        const existingTodayCount = history.filter(r => r.date === date).length;
        if (scored.length > existingTodayCount) {
          const oldOtherDays = history.filter(r => r.date !== date);
          writeCsv(historyFile, [...oldOtherDays, ...scored], columns);
        }
      }
    }
    const listsDir = path.join(OUTPUT_ROOT, 'lists', date); mkdir(listsDir);
    const lists = buildLists(scored);
    for (const [name, rows] of Object.entries(lists)) {
      writeCsv(path.join(listsDir, name), rows, listCols);
      writeTextAtomic(path.join(listsDir, name.replace(/\.csv$/, '.md')), `# ${listTitles[name]} — ${date}\n\n${mdTable(rows, listMdFields)}\n`);
    }
    writeJsonAtomic(path.join(OUTPUT_ROOT, 'quality', `${date}.json`), quality);
    writeJsonAtomic(path.join(OUTPUT_ROOT, 'quality', 'latest.json'), quality);
    const report = generateReport(scored, date, quality);
    writeTextAtomic(path.join(OUTPUT_ROOT, 'reports', `${date}.md`), report);
    writeTextAtomic(path.join(OUTPUT_ROOT, 'reports', 'latest.md'), report);
    const topTrend = [...scored].sort((a,b)=>b.trend_score-a.trend_score).slice(0,3);
    const topNiche = scored.filter(p=>(p.sales_signal_min||0)>=100&&(p.review_count??p.rating_count)!==null&&(p.review_count??p.rating_count)<2500).sort((a,b)=>b.niche_score-a.niche_score).slice(0,3);
    const telegramStrategy = Number(quality.selection?.topN || 0) >= scored.length
      ? `♻️ ${scored.length} ürünün tamamı günlük detay taramasında`
      : `♻️ İlk ${quality.selection.topN} günlük + ${quality.selection.rotationN} dönüşümlü + ${quality.selection.hotN} hızlı değişen ürün`;
    const telegram = [
      `📊 ${config.telegramTitle || config.name} — ${date}`,
      `✅ ${scored.length} ürünlük havuz | ${quality.detailRefreshed}/${quality.detailAttempted} detay yenilendi | kalite ${quality.status}`,
      telegramStrategy,
      `🔥 Trend: ${topTrend.map((p,i)=>`${i+1}) ${p.title} (${p.price} TL)`).join(' | ')}`,
      `🎯 Niche: ${topNiche.map((p,i)=>`${i+1}) ${p.title}`).join(' | ') || 'Baz çizgisi oluşuyor'}`,
      `📁 GitHub: https://github.com/canerrunal/Trendyol/blob/main/${OUTPUT_PREFIX ? `${OUTPUT_PREFIX}/` : ''}reports/${date}.md`,
      `Not: Yükselen/düşen listeleri ikinci ölçümden itibaren günlük farklarla dolacaktır.`
    ].join('\n');
    writeTextAtomic(path.join(OUTPUT_ROOT, 'reports', 'telegram-latest.txt'), telegram + '\n');
    writeJsonAtomic(path.join(OUTPUT_ROOT, 'data', 'latest.json'), scored);
    writeCsv(path.join(OUTPUT_ROOT, 'data', 'latest.csv'), scored, columns);
    const partialRun = Boolean(listingResult.error) || quality.detailSuccessRate < 100 || quality.detailRefreshed < quality.detailAttempted;
    const recoveryBackup = partialRun
      ? writeRecoveryBackup({ date, timestamp, status: 'partial_success', reason: listingResult.error ? 'listing_partial' : 'detail_partial', listingResult, listed, selection, detailed, products: scored, quality })
      : null;
    if (recoveryBackup) console.error(`RECOVERY_BACKUP_WRITTEN status=partial_success path=${recoveryBackup}`);
    const prefix = OUTPUT_PREFIX ? `${OUTPUT_PREFIX}/` : '';
    console.log(JSON.stringify({ ok: quality.status === 'PASS', profile: PROFILE, date, quality, recoveryBackup, files: { report: `${prefix}reports/${date}.md`, snapshot: `${prefix}snapshots/${date}/products.csv`, lists: `${prefix}lists/${date}` } }, null, 2));
  } catch (error) {
    try {
      const partialProducts = scored || (selection ? mergePoolProducts(listed, detailed, history, timestamp, date, selection) : listed);
      const backupDir = writeRecoveryBackup({ date, timestamp, status: 'aborted', reason: 'collector_error', listingResult, listed, selection, detailed, products: partialProducts, quality, error });
      console.error(`RECOVERY_BACKUP_WRITTEN status=aborted path=${backupDir}`);
    } catch (backupError) {
      console.error(`RECOVERY_BACKUP_FAILED ${backupError.stack || backupError.message}`);
    }
    throw error;
  } finally {
    process.removeListener('SIGTERM', handleSigterm);
    process.removeListener('SIGINT', handleSigint);
    await context.close(); await browser.close();
  }
}
module.exports = { ROOT, OUTPUT_ROOT, PROFILE, config, columns, listCols, listMdFields, listTitles, buildLists, generateReport, mdTable, qualityFor, writeCsv, parseSalesSignal, rankScope, offerKey, scoreProducts, collectDetail, mergePoolProducts };
if (require.main === module) main().catch(err => { console.error(err.stack || err.message); process.exit(1); });
