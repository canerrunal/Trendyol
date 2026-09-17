#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { ROOT, readJson, readGzipJson, writeJsonAtomic, nowIstanbul, mkdir } = require('./taxonomy_common.cjs');
const { createLineageRecord, getGitCommit, calculateConfigHash } = require('./lib/lineage.cjs');

function formatNumber(value) { return new Intl.NumberFormat('tr-TR').format(value); }
function writeTextAtomic(file, text) {
  mkdir(path.dirname(file)); const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text); fs.renameSync(temporary, file);
}
function gzipLines(file, rows) {
  mkdir(path.dirname(file)); const temporary = `${file}.${process.pid}.tmp`;
  const body = `${rows.map(row => JSON.stringify(row)).join('\n')}\n`;
  fs.writeFileSync(temporary, zlib.gzipSync(Buffer.from(body), { level: 9, mtime: 0 }));
  fs.renameSync(temporary, file);
}
function readNdjsonGzip(file) {
  return zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')
    .split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function findPreviousSnapshot(currentDate) {
  const snapshotRoot = path.join(ROOT, 'taxonomy', 'snapshots');
  let dates = [];
  try { dates = fs.readdirSync(snapshotRoot).filter(item => /^\d{4}-\d{2}-\d{2}$/.test(item) && item < currentDate).sort().reverse(); }
  catch { return null; }
  for (const date of dates) {
    const root = path.join(snapshotRoot, date);
    const productsFile = path.join(root, 'products.ndjson.gz');
    const rankingsFile = path.join(root, 'rankings.ndjson.gz');
    if (!fs.existsSync(productsFile) || !fs.existsSync(rankingsFile)) continue;
    try {
      return { date, products: readNdjsonGzip(productsFile), memberships: readNdjsonGzip(rankingsFile) };
    } catch { /* Bozuk eski snapshot yerine bir önceki geçerli snapshot denenir. */ }
  }
  return null;
}

function finalize({ shardCount = 4 } = {}) {
  const { date, timestamp } = nowIstanbul();
  const catalog = readJson(path.join(ROOT, 'taxonomy', 'catalog.json'));
  if (!catalog?.nodes?.length) throw new Error('Kategori kataloğu bulunamadı.');
  const catalogRunId = catalog.runId || catalog.generatedAt;
  if (!catalogRunId || Number.isNaN(Date.parse(catalog.generatedAt))) throw new Error('Kategori kataloğu çalışma kimliği geçersiz.');
  const runtimeDir = path.join(ROOT, '.runtime', 'taxonomy', date);
  const previous = findPreviousSnapshot(date);
  const catalogCategoryIds = new Set(catalog.nodes.map(node => String(node.categoryId)));
  const previousMembershipsByCategory = new Map();
  const previousProductsByKey = new Map((previous?.products || []).filter(product => product?.productKey).map(product => [String(product.productKey), product]));
  for (const membership of previous?.memberships || []) {
    const categoryId = String(membership.categoryId);
    if (!catalogCategoryIds.has(categoryId)) continue;
    if (!previousMembershipsByCategory.has(categoryId)) previousMembershipsByCategory.set(categoryId, []);
    previousMembershipsByCategory.get(categoryId).push(membership);
  }
  const productMap = new Map(); const membershipMap = new Map(); const failures = []; const successfulCategoryIds = [];
  const fallbackCategoryIds = new Set(); const expansionCategoryIds = new Set();
  const shards = [];
  const carriedForwardCategoryIds = new Set();
  const missingShardIds = [];
  for (let shard = 0; shard < shardCount; shard++) {
    const assignedCategoryIds = new Set(catalog.nodes
      .filter(node => Number(node.categoryId) % shardCount === shard)
      .map(node => String(node.categoryId)));
    const file = path.join(runtimeDir, `shard-${shard}.json.gz`);
    let result = null;
    try { if (fs.existsSync(file)) result = readGzipJson(file); } catch { result = null; }
    const shardStartedAt = result?.startedAt || result?.capturedAt;
    const validResult = Boolean(result && result.date === date && result.shard === shard && result.shardCount === shardCount &&
      result.catalogRunId === catalogRunId && result.catalogGeneratedAt === catalog.generatedAt &&
      shardStartedAt && !Number.isNaN(Date.parse(shardStartedAt)) && Date.parse(shardStartedAt) >= Date.parse(catalog.generatedAt));
    if (!validResult) {
      missingShardIds.push(shard);
      result = { schemaVersion: 2, date, shard, shardCount, status: 'MISSING', totalCategories: assignedCategoryIds.size,
        completedCategories: 0, failedCategories: 0, successRate: 0, products: [], memberships: [], failures: [],
        successfulCategoryIds: [], fallbackCategoryIds: [], expansionCategoryIds: [], detailCoverage: null,
        newestDiscovery: {}, priorityPages: 0, priorityProducts: 0 };
    }
    const successfulIds = new Set((result.successfulCategoryIds?.length
      ? result.successfulCategoryIds
      : (result.memberships || []).map(row => row.categoryId)).map(String).filter(categoryId => assignedCategoryIds.has(categoryId)));
    const currentMemberships = (result.memberships || []).filter(row => assignedCategoryIds.has(String(row.categoryId)) && successfulIds.has(String(row.categoryId)));
    const fallbackIds = [...assignedCategoryIds].filter(categoryId => !successfulIds.has(categoryId));
    for (const categoryId of fallbackIds) {
      if (previousMembershipsByCategory.has(categoryId)) carriedForwardCategoryIds.add(categoryId);
    }
    for (const membership of currentMemberships) membershipMap.set(`${membership.categoryId}:${membership.rank}:${membership.productKey}`, membership);
    for (const categoryId of fallbackIds) {
      for (const membership of previousMembershipsByCategory.get(categoryId) || []) {
        membershipMap.set(`${membership.categoryId}:${membership.rank}:${membership.productKey}`, membership);
        const prior = previousProductsByKey.get(String(membership.productKey));
        if (prior) productMap.set(String(prior.productKey), prior);
      }
    }
    for (const product of result.products || []) {
      if (!product?.productKey) continue;
      const key = String(product.productKey); const prior = productMap.get(key);
      productMap.set(key, { ...product, metrics: product.metrics || prior?.metrics });
    }
    failures.push(...(result.failures || []));
    successfulCategoryIds.push(...successfulIds);
    for (const categoryId of result.fallbackCategoryIds || []) fallbackCategoryIds.add(categoryId);
    for (const categoryId of result.expansionCategoryIds || []) expansionCategoryIds.add(categoryId);
    shards.push(result);
  }
  const memberships = [...membershipMap.values()];
  memberships.sort((a, b) => a.categoryId - b.categoryId || a.rank - b.rank || a.productKey.localeCompare(b.productKey));
  const products = [...productMap.values()].sort((a, b) => a.productKey.localeCompare(b.productKey));
  const productKeysByRoot = new Map();
  const rootByCategory = new Map(catalog.nodes.map(node => [String(node.categoryId), node.rootName]));
  for (const membership of memberships) {
    const rootName = rootByCategory.get(String(membership.categoryId));
    if (!rootName || !membership.productKey) continue;
    if (!productKeysByRoot.has(rootName)) productKeysByRoot.set(rootName, new Set());
    productKeysByRoot.get(rootName).add(String(membership.productKey));
  }
  const newestMemberships = memberships.filter(row => row.source === 'category_search_newest' || row.source === 'category_search_newest_baseline');
  const newestProductKeys = new Set(newestMemberships.map(row => row.productKey));
  const newestProducts = products.filter(product => newestProductKeys.has(product.productKey));
  const freshCovered = new Set(successfulCategoryIds.map(String));
  const covered = new Set([...freshCovered, ...carriedForwardCategoryIds]);
  const categoriesWithProducts = new Set(memberships.map(row => row.categoryId));
  const outputDir = path.join(ROOT, 'taxonomy', 'snapshots', date);
  gzipLines(path.join(outputDir, 'rankings.ndjson.gz'), memberships);
  gzipLines(path.join(outputDir, 'products.ndjson.gz'), products);
  gzipLines(path.join(outputDir, 'new-products.ndjson.gz'), newestProducts);
  const roots = catalog.roots.map(root => {
    const ids = new Set(catalog.nodes.filter(node => node.rootId === root.categoryId).map(node => node.categoryId));
    const coveredCount = [...ids].filter(id => covered.has(String(id))).length;
    return { ...root, totalCategories: ids.size, coveredCategories: coveredCount, coverage: Math.round(coveredCount / ids.size * 10000) / 100,
      productCount: productKeysByRoot.get(root.name)?.size || 0, minimumProducts: 1000 };
  });
  const uniqueCategories = catalog.stats.uniqueCategoryIds || new Set(catalog.nodes.map(node => node.categoryId)).size;
  const coverage = Math.round(covered.size / uniqueCategories * 10000) / 100;
  const freshCoverage = Math.round(freshCovered.size / uniqueCategories * 10000) / 100;
  const qualityPass = failures.length <= Math.ceil(uniqueCategories * 0.05) && freshCoverage >= 95 && carriedForwardCategoryIds.size === 0 && missingShardIds.length === 0;
  const status = qualityPass ? 'PASS' : 'PARTIAL';
  const categoriesWithDetailHistory = shards.reduce((total, shard) => total + Number(shard.detailCoverage?.categoriesObserved || 0), 0);
  const detailCategoryCoverage = categoriesWithProducts.size
    ? Math.round(categoriesWithDetailHistory / categoriesWithProducts.size * 10000) / 100
    : 100;
  const detailAttempts = shards.reduce((total, shard) => total + Number(shard.detailCoverage?.attempted || 0), 0);
  const detailRefreshed = shards.reduce((total, shard) => total + Number(shard.detailCoverage?.refreshed || 0), 0);
  const detailNewCoverage = shards.reduce((total, shard) => total + Number(shard.detailCoverage?.newCoverage || 0), 0);
  const fallbackDetailAttempts = shards.reduce((total, shard) => total + Number(shard.detailCoverage?.fallbackRotation || 0), 0);
  const newestDetailAttempts = shards.reduce((total, shard) => total + Number(shard.detailCoverage?.newestRotation || 0), 0);
  const listingSources = {
    topRanking: memberships.filter(row => row.source === 'top_ranking').length,
    categoryExpansion: memberships.filter(row => row.source === 'category_search_expansion').length,
    categoryFallback: memberships.filter(row => row.source === 'category_search_fallback').length,
    priorityCategorySearch: memberships.filter(row => row.source === 'priority_category_search').length,
    newest: memberships.filter(row => row.source === 'category_search_newest').length,
    newestBaseline: memberships.filter(row => row.source === 'category_search_newest_baseline').length,
  };
  const expansionPageFailures = shards.reduce((total, shard) => total + Number(shard.expansionPageFailures || 0), 0);
  const priorityPages = shards.reduce((total, shard) => total + Number(shard.priorityPages || 0), 0);
  const priorityProducts = shards.reduce((total, shard) => total + Number(shard.priorityProducts || 0), 0);
  const newestDiscovery = {
    products: newestProducts.length,
    memberships: newestMemberships.length,
    categories: new Set(newestMemberships.map(row => row.categoryId)).size,
    pages: shards.reduce((total, shard) => total + Number(shard.newestDiscovery?.pages || 0), 0),
    baselineCategories: shards.reduce((total, shard) => total + Number(shard.newestDiscovery?.baselineCategories || 0), 0),
    caughtUpCategories: shards.reduce((total, shard) => total + Number(shard.newestDiscovery?.caughtUpCategories || 0), 0),
    uncaughtCategories: shards.reduce((total, shard) => total + Number(shard.newestDiscovery?.uncaughtCategories || 0), 0),
    pageFailures: shards.reduce((total, shard) => total + Number(shard.newestDiscovery?.pageFailures || 0), 0),
  };
  const publishStatus = qualityPass ? 'READY_FOR_PUBLISH' : 'BLOCKED_PARTIAL';
  const lineage = createLineageRecord({
    runId: catalogRunId,
    marketplace: 'trendyol',
    startedAt: catalog.generatedAt || timestamp,
    finishedAt: timestamp,
    sourceGitCommit: getGitCommit(ROOT),
    collectorVersion: '2.0.0',
    schemaVersion: 2,
    configHash: calculateConfigHash(path.join(ROOT, 'taxonomy', 'collection-config.json')),
    expectedShards: shardCount,
    successfulShards: shards.filter(s => s.status !== 'MISSING').length,
    failedShards: missingShardIds.length,
    categoryCount: uniqueCategories,
    productCount: products.length,
    freshCount: freshCovered.size,
    carriedForwardCount: carriedForwardCategoryIds.size,
    qualityStatus: status,
    publishStatus
  });

  const currentStatus = readJson(path.join(ROOT, 'taxonomy', 'status.json'), {});
  const previousPublished = currentStatus.latest_published || (currentStatus.status === 'PASS' ? {
    runId: currentStatus.runId || currentStatus.catalogRunId,
    date: currentStatus.date,
    publishedAt: currentStatus.generatedAt,
    status: 'PASS',
    qualityGateStatus: 'PASS',
    sourceGitCommit: currentStatus.lineage?.source_git_commit || null,
    uniqueProducts: currentStatus.uniqueProducts,
    coveredCategories: currentStatus.coveredCategories,
    coverage: currentStatus.coverage
  } : null);

  const latestAttempt = {
    runId: catalogRunId,
    date,
    generatedAt: timestamp,
    status,
    qualityGateStatus: qualityPass ? 'PASS' : 'FAIL',
    publishStatus,
    totalCategoryPaths: catalog.stats.total,
    totalCategories: uniqueCategories,
    coveredCategories: covered.size,
    coverage,
    freshCoveredCategories: freshCovered.size,
    freshCoverage,
    carriedForwardCategories: carriedForwardCategoryIds.size,
    missingShards: missingShardIds,
    uniqueProducts: products.length,
    rankingMemberships: memberships.length,
    categoriesWithProducts: categoriesWithProducts.size,
    emptyCategories: Math.max(0, covered.size - categoriesWithProducts.size),
    failedCategories: failures.length
  };

  const latestPublished = (qualityPass && status === 'PASS')
    ? {
        runId: catalogRunId,
        date,
        publishedAt: timestamp,
        status: 'PASS',
        qualityGateStatus: 'PASS',
        sourceGitCommit: lineage.source_git_commit,
        uniqueProducts: products.length,
        coveredCategories: covered.size,
        coverage
      }
    : previousPublished;

  const summary = {
    schemaVersion: 2, runId: catalogRunId, date, generatedAt: timestamp, status,
    publishStatus,
    qualityGateStatus: qualityPass ? 'PASS' : 'FAIL',
    latest_attempt: latestAttempt,
    latest_published: latestPublished,
    lineage,
    catalogRunId, catalogGeneratedAt: catalog.generatedAt, totalCategoryPaths: catalog.stats.total,
    totalCategories: uniqueCategories,
    coveredCategories: covered.size, coverage, freshCoveredCategories: freshCovered.size, freshCoverage,
    carriedForwardCategories: carriedForwardCategoryIds.size, missingShards: missingShardIds,
    previousSnapshotDate: previous?.date || null,
    uniqueProducts: products.length,
    metricCoverage: {
      numericStock: products.filter(p => p.metrics?.stock_quantity != null).length,
      detail: products.filter(p => p.metrics).length,
      total: products.length,
      attempted: detailAttempts,
      refreshed: detailRefreshed,
      newProductHistory: detailNewCoverage,
      fallbackDetailAttempted: fallbackDetailAttempts,
      newestDetailAttempted: newestDetailAttempts,
      categoriesWithDetailHistory,
      detailCategoryCoverage,
    },
    rankingMemberships: memberships.length, categoriesWithProducts: categoriesWithProducts.size,
    fallbackCategories: fallbackCategoryIds.size,
    expansionCategories: expansionCategoryIds.size, expansionPageFailures, priorityPages, priorityProducts, listingSources,
    newestDiscovery,
    emptyCategories: Math.max(0, covered.size - categoriesWithProducts.size), failedCategories: failures.length,
    roots, levels: catalog.stats.levels, shards: shards.map(item => ({ shard: item.shard, categories: item.totalCategories, successRate: item.successRate, products: item.products.length, memberships: item.memberships.length }))
  };
  writeJsonAtomic(path.join(outputDir, 'summary.json'), summary);
  writeJsonAtomic(path.join(ROOT, 'taxonomy', 'status.json'), summary);
  const rootRows = roots.map(root => `| ${root.name} | ${formatNumber(root.coveredCategories)}/${formatNumber(root.totalCategories)} | %${root.coverage.toLocaleString('tr-TR')} |`).join('\n');
  const report = `# Trendyol Çok Satanlar Kategori Evreni — ${date}\n\n` +
    `## Yönetici özeti\n\n` +
    `- **Run ID:** \`${catalogRunId}\`\n` +
    `- **Kalite:** ${status}\n` +
    `- **Yayın durumu:** ${publishStatus}\n` +
    `- **Kategori kataloğu:** ${formatNumber(catalog.stats.total)} menü yolu, ${formatNumber(uniqueCategories)} benzersiz kategori kimliği, ${catalog.stats.maxDepth + 1} seviye\n` +
    `- **Günlük güncellenen kategori:** ${formatNumber(freshCovered.size)}/${formatNumber(uniqueCategories)} (%${freshCoverage.toLocaleString('tr-TR')})\n` +
    `- **Canlı yayına girecek toplam kapsama:** ${formatNumber(covered.size)}/${formatNumber(uniqueCategories)} (%${coverage.toLocaleString('tr-TR')})\n` +
    `- **Benzersiz ürün:** ${formatNumber(products.length)}\n- **Kategori–ürün sıralama kaydı:** ${formatNumber(memberships.length)}\n` +
    `- **Ürün döndüren kategori:** ${formatNumber(categoriesWithProducts.size)}\n- **Başarılı fakat boş kategori:** ${formatNumber(Math.max(0, covered.size - categoriesWithProducts.size))}\n` +
    `- **Normal kategori vitriniyle kurtarılan:** ${formatNumber(fallbackCategoryIds.size)}\n` +
    `- **Dönen uzak kategori sayfalarıyla genişletilen:** ${formatNumber(expansionCategoryIds.size)} kategori, ${formatNumber(listingSources.categoryExpansion)} ek kayıt\n` +
    `- **Öncelikli dört kök kategori taraması:** ${formatNumber(priorityProducts)} ek ürün, ${formatNumber(priorityPages)} kategori arama sayfası\n` +
    `- **Atlanan uzak sayfa isteği:** ${formatNumber(expansionPageFailures)}\n` +
    `- **En yeni sıralamasında bulunan:** ${formatNumber(newestDiscovery.products)} ürün, ${formatNumber(newestDiscovery.categories)} kategori, ${formatNumber(newestDiscovery.pages)} sayfa\n` +
    `- **Öncelikli en yeni ürün detayı:** ${formatNumber(newestDetailAttempts)}\n` +
    `- **Yeni ürün kontrol noktası:** ${formatNumber(newestDiscovery.caughtUpCategories)} tamamlandı, ${formatNumber(newestDiscovery.uncaughtCategories)} yoğun kategori sınıra ulaştı, ${formatNumber(newestDiscovery.baselineCategories)} ilk ölçüm\n` +
    `- **Detay geçmişi olan kategori:** ${formatNumber(categoriesWithDetailHistory)}/${formatNumber(categoriesWithProducts.size)} (%${detailCategoryCoverage.toLocaleString('tr-TR')})\n` +
    `- **Bugün yenilenen ürün detayı:** ${formatNumber(detailRefreshed)}/${formatNumber(detailAttempts)}; ilk kez ölçülen ${formatNumber(detailNewCoverage)}\n` +
    `- **Öncelikli fallback ürün detayı:** ${formatNumber(fallbackDetailAttempts)}\n` +
    `- **Hatalı kategori:** ${formatNumber(failures.length)}\n- **Önceki geçerli veriden taşınan kategori:** ${formatNumber(carriedForwardCategoryIds.size)}\n- **Eksik shard çıktısı:** ${missingShardIds.length ? missingShardIds.join(', ') : 'yok'}\n\n` +
    `## Tarama stratejisi\n\nBütün kategorilerin ilk 40 ürünü her gün izlenir; Çok Satanlar servisinin desteklediği üst sınır olan ilk 100 ürün ana, birinci seviye ve 10 günlük dönüşüme giren kategorilerde alınır. Ayrıca her ürün döndüren kategorinin normal vitrindeki 3–100. sayfaları 49 günlük dönüşümle ikişer sayfa taranır. Seçilen sayfa kategori ürün sayısını aşarsa istek gerçek son sayfa aralığına döndürülür. Her kategori ayrıca \`MOST_RECENT\` sırasıyla taranır; önceki günün kontrol ürünlerine ulaşılana kadar en çok 10 sayfa ilerlenir. İlk çalışmada iki sayfalık başlangıç kaydı oluşturulur. Çok Satanlar servisi boş dönerse aynı kategori normal ürün aramasında en çok satan sırasıyla otomatik yeniden taranır. Bütün bulunan ürünler aynı detay ve ertesi gün stok karşılaştırma kuyruğuna girer.\n\n` +
    `## Ana kategori kapsamı\n\n| Ana kategori | Kapsanan / Toplam | Oran |\n|---|---:|---:|\n${rootRows}\n\n` +
    `## Veri dosyaları\n\n- [Kategori kataloğu](../catalog.csv)\n- [Günlük özet](../snapshots/${date}/summary.json)\n- Günlük sıralamalar: \`taxonomy/snapshots/${date}/rankings.ndjson.gz\`\n- Tekilleştirilmiş ürünler: \`taxonomy/snapshots/${date}/products.ndjson.gz\`\n- En yeni sıralamasında bulunan ürünler: \`taxonomy/snapshots/${date}/new-products.ndjson.gz\`\n`;
  writeTextAtomic(path.join(ROOT, 'taxonomy', 'reports', `${date}.md`), report);
  writeTextAtomic(path.join(ROOT, 'taxonomy', 'reports', 'latest.md'), report);

  let telegram = '';
  if (status === 'PASS') {
    telegram = `✅ TRENDYOL DAILY RUN\n\n` +
      `Run:\n${catalogRunId}\n\n` +
      `Durum:\nPASS\n\n` +
      `Kategori:\n${formatNumber(covered.size)} / ${formatNumber(uniqueCategories)}\n\n` +
      `Ürün:\n${formatNumber(products.length)}\n\n` +
      `Yeni:\n${formatNumber(newestDiscovery.products)}\n\n` +
      `Fresh:\n%${freshCoverage.toLocaleString('tr-TR')}\n\n` +
      `Detail:\n${formatNumber(detailRefreshed)} / ${formatNumber(detailAttempts)}\n\n` +
      `Production publish:\n✅ Approved\n\n` +
      `🔗 https://github.com/canerrunal/Trendyol/blob/main/taxonomy/reports/${date}.md\n`;
  } else {
    const shardStatusLines = shards.map(s => `Shard ${s.shard} ${s.status === 'MISSING' ? '❌' : '✅'}`).join('\n');
    telegram = `🚨 TRENDYOL RUN PROBLEMİ\n\n` +
      `Run:\n${catalogRunId}\n\n` +
      `Quality:\nPARTIAL\n\n` +
      `${shardStatusLines}\n\n` +
      `Fresh:\n%${freshCoverage.toLocaleString('tr-TR')}\n\n` +
      `Production publish:\n⛔ BLOCKED\n\n` +
      `Verimimari current dataset:\n${previous?.date || 'N/A'} PASS\n\n` +
      `🔗 https://github.com/canerrunal/Trendyol/blob/main/taxonomy/reports/${date}.md\n`;
  }
  writeTextAtomic(path.join(ROOT, 'taxonomy', 'reports', 'telegram-latest.txt'), telegram);
  if (status !== 'PASS') {
    console.warn(`TAXONOMY_FINALIZE_PARTIAL kalite kapısı geçilemedi: fresh=%${freshCoverage} live=%${coverage}. Production publish BLOCKED.`);
  }
  return summary;
}

if (require.main === module) {
  try { const summary = finalize(); console.log(`TAXONOMY_FINALIZE_OK categories=${summary.coveredCategories}/${summary.totalCategories} products=${summary.uniqueProducts} memberships=${summary.rankingMemberships}`); }
  catch (error) { console.error(`TAXONOMY_FINALIZE_FAILED ${error.stack || error.message}`); process.exitCode = 1; }
}

module.exports = { finalize };
