#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { ROOT, readJson, readGzipJson, writeJsonAtomic, nowIstanbul, mkdir } = require('./taxonomy_common.cjs');

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

function finalize({ shardCount = 4 } = {}) {
  const { date, timestamp } = nowIstanbul();
  const catalog = readJson(path.join(ROOT, 'taxonomy', 'catalog.json'));
  if (!catalog?.nodes?.length) throw new Error('Kategori kataloğu bulunamadı.');
  const catalogRunId = catalog.runId || catalog.generatedAt;
  if (!catalogRunId || Number.isNaN(Date.parse(catalog.generatedAt))) throw new Error('Kategori kataloğu çalışma kimliği geçersiz.');
  const runtimeDir = path.join(ROOT, '.runtime', 'taxonomy', date);
  const shards = [];
  for (let shard = 0; shard < shardCount; shard++) {
    const file = path.join(runtimeDir, `shard-${shard}.json.gz`);
    if (!fs.existsSync(file)) throw new Error(`Shard çıktısı eksik: ${file}`);
    const result = readGzipJson(file);
    if (result.status !== 'PASS') throw new Error(`Shard ${shard} kalite durumu ${result.status}`);
    if (result.date !== date || result.shard !== shard || result.shardCount !== shardCount) {
      throw new Error(`Shard ${shard} çalışma kapsamı güncel finalle eşleşmiyor.`);
    }
    if (result.catalogRunId !== catalogRunId || result.catalogGeneratedAt !== catalog.generatedAt) {
      throw new Error(`Shard ${shard} güncel kategori kataloğuyla eşleşmiyor.`);
    }
    const shardStartedAt = result.startedAt || result.capturedAt;
    if (!shardStartedAt || Date.parse(shardStartedAt) < Date.parse(catalog.generatedAt)) {
      throw new Error(`Shard ${shard} kategori keşfinden önce üretilmiş.`);
    }
    shards.push(result);
  }
  const productMap = new Map(); const membershipMap = new Map(); const failures = []; const successfulCategoryIds = [];
  for (const shard of shards) {
    for (const product of shard.products) {
      const prior = productMap.get(product.productKey);
      productMap.set(product.productKey, { ...product, metrics: product.metrics || prior?.metrics });
    }
    for (const membership of shard.memberships) membershipMap.set(`${membership.categoryId}:${membership.rank}:${membership.productKey}`, membership);
    failures.push(...shard.failures);
    successfulCategoryIds.push(...(shard.successfulCategoryIds || shard.memberships.map(row => row.categoryId)));
  }
  const memberships = [...membershipMap.values()];
  memberships.sort((a, b) => a.categoryId - b.categoryId || a.rank - b.rank || a.productKey.localeCompare(b.productKey));
  const products = [...productMap.values()].sort((a, b) => a.productKey.localeCompare(b.productKey));
  const covered = new Set(successfulCategoryIds);
  const categoriesWithProducts = new Set(memberships.map(row => row.categoryId));
  const outputDir = path.join(ROOT, 'taxonomy', 'snapshots', date);
  gzipLines(path.join(outputDir, 'rankings.ndjson.gz'), memberships);
  gzipLines(path.join(outputDir, 'products.ndjson.gz'), products);
  const roots = catalog.roots.map(root => {
    const ids = new Set(catalog.nodes.filter(node => node.rootId === root.categoryId).map(node => node.categoryId));
    const coveredCount = [...ids].filter(id => covered.has(id)).length;
    return { ...root, totalCategories: ids.size, coveredCategories: coveredCount, coverage: Math.round(coveredCount / ids.size * 10000) / 100 };
  });
  const uniqueCategories = catalog.stats.uniqueCategoryIds || new Set(catalog.nodes.map(node => node.categoryId)).size;
  const coverage = Math.round(covered.size / uniqueCategories * 10000) / 100;
  const status = failures.length <= Math.ceil(uniqueCategories * 0.05) && coverage >= 95 ? 'PASS' : 'FAIL';
  const summary = {
    schemaVersion: 2, date, generatedAt: timestamp, status,
    catalogRunId, catalogGeneratedAt: catalog.generatedAt, totalCategoryPaths: catalog.stats.total,
    totalCategories: uniqueCategories,
    coveredCategories: covered.size, coverage, uniqueProducts: products.length,
    metricCoverage: { numericStock: products.filter(p=>p.metrics?.stock_quantity != null).length, detail: products.filter(p=>p.metrics).length, total: products.length },
    rankingMemberships: memberships.length, categoriesWithProducts: categoriesWithProducts.size,
    emptyCategories: Math.max(0, covered.size - categoriesWithProducts.size), failedCategories: failures.length,
    roots, levels: catalog.stats.levels, shards: shards.map(item => ({ shard: item.shard, categories: item.totalCategories, successRate: item.successRate, products: item.products.length, memberships: item.memberships.length }))
  };
  writeJsonAtomic(path.join(outputDir, 'summary.json'), summary);
  writeJsonAtomic(path.join(ROOT, 'taxonomy', 'status.json'), summary);
  const rootRows = roots.map(root => `| ${root.name} | ${formatNumber(root.coveredCategories)}/${formatNumber(root.totalCategories)} | %${root.coverage.toLocaleString('tr-TR')} |`).join('\n');
  const report = `# Trendyol Çok Satanlar Kategori Evreni — ${date}\n\n` +
    `## Yönetici özeti\n\n` +
    `- **Kalite:** ${status}\n- **Kategori kataloğu:** ${formatNumber(catalog.stats.total)} menü yolu, ${formatNumber(uniqueCategories)} benzersiz kategori kimliği, ${catalog.stats.maxDepth + 1} seviye\n` +
    `- **Günlük kapsama:** ${formatNumber(covered.size)}/${formatNumber(uniqueCategories)} benzersiz kategori (%${coverage.toLocaleString('tr-TR')})\n` +
    `- **Benzersiz ürün:** ${formatNumber(products.length)}\n- **Kategori–ürün sıralama kaydı:** ${formatNumber(memberships.length)}\n` +
    `- **Ürün döndüren kategori:** ${formatNumber(categoriesWithProducts.size)}\n- **Başarılı fakat boş kategori:** ${formatNumber(Math.max(0, covered.size - categoriesWithProducts.size))}\n` +
    `- **Hatalı kategori:** ${formatNumber(failures.length)}\n\n` +
    `## Tarama stratejisi\n\nBütün kategorilerin ilk 40 ürünü her gün izlenir. Ana ve birinci seviye kategoriler günlük 200 ürüne kadar taranır. Daha derin kategoriler 10 günlük dönüşümle sırayla 200 ürüne kadar genişletilir. Böylece bütün ağaç günlük görünür kalırken Trendyol'a ve bilgisayara aşırı yük bindirilmez.\n\n` +
    `## Ana kategori kapsamı\n\n| Ana kategori | Kapsanan / Toplam | Oran |\n|---|---:|---:|\n${rootRows}\n\n` +
    `## Veri dosyaları\n\n- [Kategori kataloğu](../catalog.csv)\n- [Günlük özet](../snapshots/${date}/summary.json)\n- Günlük sıralamalar: \`taxonomy/snapshots/${date}/rankings.ndjson.gz\`\n- Tekilleştirilmiş ürünler: \`taxonomy/snapshots/${date}/products.ndjson.gz\`\n`;
  writeTextAtomic(path.join(ROOT, 'taxonomy', 'reports', `${date}.md`), report);
  writeTextAtomic(path.join(ROOT, 'taxonomy', 'reports', 'latest.md'), report);
  const telegram = `🌳 Trendyol Çok Satanlar Kategori Evreni — ${date}\n${status === 'PASS' ? '✅' : '⚠️'} ${formatNumber(covered.size)}/${formatNumber(uniqueCategories)} benzersiz kategori (%${coverage.toLocaleString('tr-TR')})\n🗂️ ${formatNumber(catalog.stats.total)} menü yolu · ${formatNumber(catalog.stats.duplicatePaths || 0)} tekrar yol\n📦 ${formatNumber(products.length)} benzersiz ürün · ${formatNumber(memberships.length)} sıralama kaydı\n📭 ${formatNumber(Math.max(0, covered.size - categoriesWithProducts.size))} başarılı fakat boş kategori\n🧭 ${catalog.stats.maxDepth + 1} seviye · ${catalog.stats.roots} ana kategori\n🔗 https://github.com/canerrunal/Trendyol/blob/main/taxonomy/reports/${date}.md\n`;
  writeTextAtomic(path.join(ROOT, 'taxonomy', 'reports', 'telegram-latest.txt'), telegram);
  if (status !== 'PASS') throw new Error(`Kategori evreni kalite kapısı başarısız: %${coverage}`);
  return summary;
}

if (require.main === module) {
  try { const summary = finalize(); console.log(`TAXONOMY_FINALIZE_OK categories=${summary.coveredCategories}/${summary.totalCategories} products=${summary.uniqueProducts} memberships=${summary.rankingMemberships}`); }
  catch (error) { console.error(`TAXONOMY_FINALIZE_FAILED ${error.stack || error.message}`); process.exitCode = 1; }
}

module.exports = { finalize };
