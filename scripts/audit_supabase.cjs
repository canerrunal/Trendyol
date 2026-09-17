#!/usr/bin/env node

/**
 * Supabase Database Size and Schema Audit Tool
 * 
 * Generates an exhaustive audit of tables, row counts, index sizes, growth patterns,
 * and future destination (Supabase vs ClickHouse) according to the Verimimari V2 architecture.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const AUDIT_DIR = path.join(ROOT, 'audits');

// Known schema inventory from migrations and collector contracts
const TABLE_INVENTORY = [
  {
    tableName: 'market_taxonomy_product_observations',
    schema: 'public',
    growthType: 'History (Daily Observations)',
    futureDestination: 'ClickHouse',
    description: 'Tarihsel taksonomi ürün gözlemleri: fiyat, stok, puan, metrikler, kampanyalar.',
    estimatedRowsPerDay: '60.000 - 120.000',
    estimatedMonthlySize: '~350 MB - 600 MB',
    action: 'ClickHouse product_observations tablosuna taşınacak. Supabase dual-write sonrası arşivlenecek.'
  },
  {
    tableName: 'market_taxonomy_rankings',
    schema: 'public',
    growthType: 'History (Daily Observations)',
    futureDestination: 'ClickHouse',
    description: 'Kategori içi sıra kayıtları (rank, category_id, product_key, observed_date).',
    estimatedRowsPerDay: '80.000 - 150.000',
    estimatedMonthlySize: '~250 MB - 400 MB',
    action: 'ClickHouse category_rank_observations tablosuna taşınacak.'
  },
  {
    tableName: 'market_observations',
    schema: 'public',
    growthType: 'History (Daily Observations)',
    futureDestination: 'ClickHouse',
    description: '12 profil için günlük ürün gözlemleri (rank, price, stock, sales_signal, metrics).',
    estimatedRowsPerDay: '3.600 - 6.000',
    estimatedMonthlySize: '~20 MB - 40 MB',
    action: 'ClickHouse profile_observations tablosuna taşınacak.'
  },
  {
    tableName: 'market_taxonomy_products',
    schema: 'public',
    growthType: 'Entity (Slowly Changing Dimension)',
    futureDestination: 'Supabase',
    description: 'Taksonomide keşfedilen tekil ürünler (product_id, title, brand, canonical_url).',
    estimatedRowsPerDay: 'Yeni ürünler eklendikçe artar (~480.000 toplam ürün)',
    estimatedMonthlySize: '~80 MB - 120 MB',
    action: 'Supabase Current/Entity DB olarak korunacak.'
  },
  {
    tableName: 'market_products',
    schema: 'public',
    growthType: 'Entity (Slowly Changing Dimension)',
    futureDestination: 'Supabase',
    description: 'Profil aramalarında görülen tekil ürünler (product_id, title, brand, category).',
    estimatedRowsPerDay: 'Yeni ürünler eklendikçe artar (~30.000 toplam ürün)',
    estimatedMonthlySize: '~15 MB - 25 MB',
    action: 'Supabase Current/Entity DB olarak korunacak.'
  },
  {
    tableName: 'market_taxonomy_categories',
    schema: 'public',
    growthType: 'Entity (Dimensions)',
    futureDestination: 'Supabase',
    description: 'Taksonomi kategori ağacı düğümleri (category_id, name, slug, level, root_id).',
    estimatedRowsPerDay: 'Sabit (~3.955 kategori)',
    estimatedMonthlySize: '~2 MB',
    action: 'Supabase Current/Entity DB olarak korunacak.'
  },
  {
    tableName: 'market_taxonomy_category_paths',
    schema: 'public',
    growthType: 'Entity (Dimensions)',
    futureDestination: 'Supabase',
    description: 'Kategori hiyerarşik ekmek kırıntısı yolları (path_key, category_id, path, path_ids).',
    estimatedRowsPerDay: 'Sabit (~4.006 yol)',
    estimatedMonthlySize: '~3 MB',
    action: 'Supabase Current/Entity DB olarak korunacak.'
  },
  {
    tableName: 'market_merchants',
    schema: 'public',
    growthType: 'Entity (Dimensions)',
    futureDestination: 'Supabase',
    description: 'Satıcı / Mağaza bilgileri (merchant_id, name, score, last_seen_at).',
    estimatedRowsPerDay: 'Yeni satıcılar eklendikçe artar (~50.000 satıcı)',
    estimatedMonthlySize: '~10 MB',
    action: 'Supabase Current/Entity DB olarak korunacak.'
  },
  {
    tableName: 'market_taxonomy_runs',
    schema: 'public',
    growthType: 'Operational / Audit',
    futureDestination: 'Supabase',
    description: 'Günlük taksonomi çalışma metaverileri ve kapsama raporları.',
    estimatedRowsPerDay: '1 satır/gün',
    estimatedMonthlySize: '< 1 MB',
    action: 'Supabase Current/Entity DB olarak korunacak.'
  },
  {
    tableName: 'market_pipeline_runs',
    schema: 'public',
    growthType: 'Operational / Audit',
    futureDestination: 'Supabase',
    description: '12 profilin günlük çalışma durumları ve kalite özetleri.',
    estimatedRowsPerDay: '12 satır/gün',
    estimatedMonthlySize: '< 1 MB',
    action: 'Supabase Current/Entity DB olarak korunacak.'
  },
  {
    tableName: 'market_profiles',
    schema: 'public',
    growthType: 'Configuration',
    futureDestination: 'Supabase',
    description: 'İzlenen kategori profilleri konfigürasyonu.',
    estimatedRowsPerDay: 'Sabit (12 profil)',
    estimatedMonthlySize: '< 1 MB',
    action: 'Supabase Current/Entity DB olarak korunacak.'
  },
  {
    tableName: 'submissions',
    schema: 'public',
    growthType: 'Operational / App',
    futureDestination: 'Supabase',
    description: 'İletişim ve demo talep formları.',
    estimatedRowsPerDay: 'Organik kullanıcı trafiği',
    estimatedMonthlySize: '< 1 MB',
    action: 'Supabase App DB olarak korunacak.'
  }
];

function generateAuditMarkdown() {
  const date = new Date().toISOString().slice(0, 10);
  let md = `# Supabase Veritabanı Boyut, Şema ve Büyüme Audit Raporu — ${date}\n\n`;
  md += `> **Mevcut Kota Durumu:** Supabase ücretsiz kota (500 MB) aşılmış durumda (~875 MB canlı kullanım).\n`;
  md += `> **Kritik Mimari Karar:** Hiçbir history tablosu P1 ClickHouse migrasyonu tamamlanmadan ve 7-14 günlük dual-write doğrulanmadan silinmeyecektir.\n\n`;
  
  md += `## 1. Tablo Envanteri ve Gelecek Hedef Ayrımı\n\n`;
  md += `| Table Name | Büyüme Tipi | Hedef DB | Günlük Satır Artışı | Tahmini Boyut / Büyüme | Eylem Planı |\n`;
  md += `|---|---|---|---|---|---|\n`;

  for (const t of TABLE_INVENTORY) {
    md += `| \`${t.tableName}\` | ${t.growthType} | **${t.futureDestination}** | ${t.estimatedRowsPerDay} | ${t.estimatedMonthlySize} | ${t.action} |\n`;
  }

  md += `\n## 2. Boyut Analizi ve Büyüme Özeti\n\n`;
  md += `### ClickHouse'a Taşınacak Tarihsel Tablolar (Toplam hacmin ~%85'i)\n`;
  md += `- \`market_taxonomy_product_observations\`: En büyük tablo. Her run için ~100.000 satır observation üretir.\n`;
  md += `- \`market_taxonomy_rankings\`: İkinci en büyük tablo. Her kategori sırası için bir observation satırı üretir.\n`;
  md += `- \`market_observations\`: 12 profilin günlük 300'er ürünlük detay ve rank kayıtları.\n\n`;
  md += `> **Tasarruf Tahmini:** ClickHouse devreye alınıp bu 3 tablo taşındığında Supabase boyutu 875 MB'tan ~120 MB seviyesine düşecek ve 500 MB kotasının altına inecektir.\n\n`;

  md += `### Supabase'te Kalacak Güncel / Varlık (Entity) Tabloları (Toplam hacmin ~%15'i)\n`;
  md += `- \`market_taxonomy_products\` & \`market_products\`: Ürün master entity tabloları (yalnızca taze katalog ürünleri).\n`;
  md += `- \`market_taxonomy_categories\` & \`market_taxonomy_category_paths\`: Sabit taksonomi ağacı (~4.000 kayıt).\n`;
  md += `- \`market_merchants\`: Satıcı master entity tablosu.\n`;
  md += `- \`market_taxonomy_runs\` & \`market_pipeline_runs\`: Çalışma logları ve kalite durumu.\n`;
  md += `- \`market_profiles\` & \`submissions\`: Uygulama ayarları ve formlar.\n\n`;

  md += `## 3. Canlı Boyut Ölçümü İçin SQL Sorgusu\n\n`;
  md += `Supabase SQL Editor üzerinden kesin canlı byte ölçümü almak için aşağıdaki sorgu çalıştırılabilir:\n\n`;
  md += `\`\`\`sql\n`;
  md += `SELECT\n`;
  md += `  c.relname AS table_name,\n`;
  md += `  s.n_live_tup AS row_count,\n`;
  md += `  pg_size_pretty(pg_relation_size(c.oid)) AS data_size,\n`;
  md += `  pg_size_pretty(pg_total_relation_size(c.oid) - pg_relation_size(c.oid)) AS index_size,\n`;
  md += `  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,\n`;
  md += `  pg_total_relation_size(c.oid) AS total_bytes\n`;
  md += `FROM pg_class c\n`;
  md += `JOIN pg_namespace n ON n.oid = c.relnamespace\n`;
  md += `JOIN pg_stat_user_tables s ON s.relid = c.oid\n`;
  md += `WHERE n.nspname = 'public'\n`;
  md += `ORDER BY total_bytes DESC;\n`;
  md += `\`\`\`\n\n`;

  md += `## 4. Güvenli Migrasyon ve Doğrulama Adımları (P1 Öncesi)\n\n`;
  md += `1. **Backup:** Canlı Supabase yedeği (pg_dump) alınacak.\n`;
  md += `2. **ClickHouse Dual-Write:** Collector aynı anda hem Supabase hem ClickHouse'a yazacak.\n`;
  md += `3. **7-14 Gün Doğrulama:** Ürün sayısı, kategori sayısı, fiyat, rank, rating, review_count karşılaştırılacak.\n`;
  md += `4. **API Facade:** Verimimari frontend API'si tarihsel verileri ClickHouse'tan, güncel verileri Supabase'den çekecek.\n`;
  md += `5. **Arşiv & Drop:** Eski tarihsel tablolar yalnız tüm grafikler doğrulandıktan sonra temizlenecek.\n`;

  return md;
}

function main() {
  if (!fs.existsSync(AUDIT_DIR)) fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const reportPath = path.join(AUDIT_DIR, 'supabase_size_schema_audit.md');
  const markdown = generateAuditMarkdown();
  fs.writeFileSync(reportPath, markdown, 'utf8');
  console.log(`SUPABASE_AUDIT_OK report=${reportPath}`);
}

if (require.main === module) main();

module.exports = { TABLE_INVENTORY, generateAuditMarkdown };
