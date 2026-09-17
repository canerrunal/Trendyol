#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const {
  ROOT, ROOT_URL, launchBrowser, parseAssignedJson, flattenTree, nowIstanbul,
  writeJsonAtomic, writeCsvAtomic
} = require('./taxonomy_common.cjs');
const { generateRunId } = require('./lib/lineage.cjs');

const OUTPUT_DIR = path.join(ROOT, 'taxonomy');

async function discover() {
  const { browser, context } = await launchBrowser();
  try {
    const page = await context.newPage();
    const fragment = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Kategori ağacı yanıtı 90 saniyede gelmedi.')), 90000);
      page.on('response', async response => {
        if (!response.url().includes('/top-ranking/cok-satanlar?__renderMode=stream')) return;
        try { clearTimeout(timer); resolve(await response.json()); }
        catch (error) { clearTimeout(timer); reject(error); }
      });
    });
    await page.goto(ROOT_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    const payload = await fragment;
    const props = parseAssignedJson(String(payload.main || ''));
    const categories = props?.data?.CategoryTreeData?.categories;
    if (!Array.isArray(categories) || !categories.length) throw new Error('Trendyol kategori ağacı boş geldi.');
    const nodes = flattenTree(categories).sort((a, b) => a.path.localeCompare(b.path, 'tr'));
    const { timestamp } = nowIstanbul();
    const levels = Object.fromEntries([...new Set(nodes.map(node => node.level))].sort((a, b) => a - b).map(level => [level, nodes.filter(node => node.level === level).length]));
    const uniqueCategoryIds = new Set(nodes.map(node => node.categoryId));
    const runId = generateRunId('trendyol', timestamp);
    const catalog = {
      schemaVersion: 2, runId, sourceUrl: ROOT_URL, generatedAt: timestamp,
      stats: {
        total: nodes.length, uniqueCategoryIds: uniqueCategoryIds.size, duplicatePaths: nodes.length - uniqueCategoryIds.size,
        roots: nodes.filter(node => node.level === 0).length, leaves: nodes.filter(node => !node.hasChildren).length,
        parents: nodes.filter(node => node.hasChildren).length, maxDepth: Math.max(...nodes.map(node => node.level)), levels
      },
      roots: nodes.filter(node => node.level === 0).map(node => ({ categoryId: node.categoryId, name: node.name, descendants: nodes.filter(candidate => candidate.rootId === node.categoryId).length - 1 })),
      nodes
    };
    writeJsonAtomic(path.join(OUTPUT_DIR, 'catalog.json'), catalog);
    writeJsonAtomic(path.join(OUTPUT_DIR, 'tree.json'), categories);
    writeCsvAtomic(path.join(OUTPUT_DIR, 'catalog.csv'), nodes.map(node => ({ ...node, pathIds: node.pathIds.join(' > ') })), ['categoryId','name','parentId','level','hasChildren','childCount','rootId','rootName','path','pathIds','pathSlug','url']);
    const rootRows = catalog.roots.map(root => `| [${root.name}](https://www.trendyol.com/cok-satanlar?categoryId=${root.categoryId}&type=bestSeller&webGenderId=1) | ${root.categoryId} | ${root.descendants + 1} |`).join('\n');
    const catalogReport = `# Trendyol Çok Satanlar Kategori Kataloğu\n\n` +
      `Son keşif: **${timestamp}**\n\n` +
      `- Menüdeki kategori yolu: **${catalog.stats.total.toLocaleString('tr-TR')}**\n` +
      `- Benzersiz kategori kimliği: **${catalog.stats.uniqueCategoryIds.toLocaleString('tr-TR')}**\n` +
      `- Birden fazla yolda görünen tekrar: **${catalog.stats.duplicatePaths.toLocaleString('tr-TR')}**\n` +
      `- Ana kategori: **${catalog.stats.roots}**\n- Uç kategori: **${catalog.stats.leaves.toLocaleString('tr-TR')}**\n` +
      `- En derin yol: **${catalog.stats.maxDepth + 1} seviye**\n\n` +
      `| Ana kategori | Kimlik | Toplam dal |\n|---|---:|---:|\n${rootRows}\n\n` +
      `Tam katalog: [catalog.csv](../catalog.csv) · [catalog.json](../catalog.json)\n`;
    fs.mkdirSync(path.join(OUTPUT_DIR, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(OUTPUT_DIR, 'reports', 'catalog.md'), catalogReport);
    return catalog;
  } finally { await context.close(); await browser.close(); }
}

if (require.main === module) discover().then(catalog => {
  console.log(`TAXONOMY_DISCOVERY_OK total=${catalog.stats.total} roots=${catalog.stats.roots} leaves=${catalog.stats.leaves} maxDepth=${catalog.stats.maxDepth}`);
}).catch(error => { console.error(`TAXONOMY_DISCOVERY_FAILED ${error.stack || error.message}`); process.exitCode = 1; });

module.exports = { discover };
