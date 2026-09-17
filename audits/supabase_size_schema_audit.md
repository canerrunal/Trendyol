# Supabase Veritabanı Boyut, Şema ve Büyüme Audit Raporu — 2026-09-17

> **Mevcut Kota Durumu:** Supabase ücretsiz kota (500 MB) aşılmış durumda (~875 MB canlı kullanım).
> **Kritik Mimari Karar:** Hiçbir history tablosu P1 ClickHouse migrasyonu tamamlanmadan ve 7-14 günlük dual-write doğrulanmadan silinmeyecektir.

## 1. Tablo Envanteri ve Gelecek Hedef Ayrımı

| Table Name | Büyüme Tipi | Hedef DB | Günlük Satır Artışı | Tahmini Boyut / Büyüme | Eylem Planı |
|---|---|---|---|---|---|
| `market_taxonomy_product_observations` | History (Daily Observations) | **ClickHouse** | 60.000 - 120.000 | ~350 MB - 600 MB | ClickHouse product_observations tablosuna taşınacak. Supabase dual-write sonrası arşivlenecek. |
| `market_taxonomy_rankings` | History (Daily Observations) | **ClickHouse** | 80.000 - 150.000 | ~250 MB - 400 MB | ClickHouse category_rank_observations tablosuna taşınacak. |
| `market_observations` | History (Daily Observations) | **ClickHouse** | 3.600 - 6.000 | ~20 MB - 40 MB | ClickHouse profile_observations tablosuna taşınacak. |
| `market_taxonomy_products` | Entity (Slowly Changing Dimension) | **Supabase** | Yeni ürünler eklendikçe artar (~480.000 toplam ürün) | ~80 MB - 120 MB | Supabase Current/Entity DB olarak korunacak. |
| `market_products` | Entity (Slowly Changing Dimension) | **Supabase** | Yeni ürünler eklendikçe artar (~30.000 toplam ürün) | ~15 MB - 25 MB | Supabase Current/Entity DB olarak korunacak. |
| `market_taxonomy_categories` | Entity (Dimensions) | **Supabase** | Sabit (~3.955 kategori) | ~2 MB | Supabase Current/Entity DB olarak korunacak. |
| `market_taxonomy_category_paths` | Entity (Dimensions) | **Supabase** | Sabit (~4.006 yol) | ~3 MB | Supabase Current/Entity DB olarak korunacak. |
| `market_merchants` | Entity (Dimensions) | **Supabase** | Yeni satıcılar eklendikçe artar (~50.000 satıcı) | ~10 MB | Supabase Current/Entity DB olarak korunacak. |
| `market_taxonomy_runs` | Operational / Audit | **Supabase** | 1 satır/gün | < 1 MB | Supabase Current/Entity DB olarak korunacak. |
| `market_pipeline_runs` | Operational / Audit | **Supabase** | 12 satır/gün | < 1 MB | Supabase Current/Entity DB olarak korunacak. |
| `market_profiles` | Configuration | **Supabase** | Sabit (12 profil) | < 1 MB | Supabase Current/Entity DB olarak korunacak. |
| `submissions` | Operational / App | **Supabase** | Organik kullanıcı trafiği | < 1 MB | Supabase App DB olarak korunacak. |

## 2. Boyut Analizi ve Büyüme Özeti

### ClickHouse'a Taşınacak Tarihsel Tablolar (Toplam hacmin ~%85'i)
- `market_taxonomy_product_observations`: En büyük tablo. Her run için ~100.000 satır observation üretir.
- `market_taxonomy_rankings`: İkinci en büyük tablo. Her kategori sırası için bir observation satırı üretir.
- `market_observations`: 12 profilin günlük 300'er ürünlük detay ve rank kayıtları.

> **Tasarruf Tahmini:** ClickHouse devreye alınıp bu 3 tablo taşındığında Supabase boyutu 875 MB'tan ~120 MB seviyesine düşecek ve 500 MB kotasının altına inecektir.

### Supabase'te Kalacak Güncel / Varlık (Entity) Tabloları (Toplam hacmin ~%15'i)
- `market_taxonomy_products` & `market_products`: Ürün master entity tabloları (yalnızca taze katalog ürünleri).
- `market_taxonomy_categories` & `market_taxonomy_category_paths`: Sabit taksonomi ağacı (~4.000 kayıt).
- `market_merchants`: Satıcı master entity tablosu.
- `market_taxonomy_runs` & `market_pipeline_runs`: Çalışma logları ve kalite durumu.
- `market_profiles` & `submissions`: Uygulama ayarları ve formlar.

## 3. Canlı Boyut Ölçümü İçin 3 Aşamalı SQL Denetimi

> **Teknik Not:** `pg_database_size(current_database())` PostgreSQL WAL (`pg_wal`) dizinini **içermez**. 
> Veritabanı boyutundaki fark; heap tablosu dışındaki **TOAST tabloları (`toast_and_other_size`)**, **indeksler (`index_size`)** ve **public dışındaki Supabase sistem şemalarından (`auth`, `storage`, `realtime`, `vault`)** kaynaklanmaktadır.

Supabase Dashboard → SQL Editor ekranında sırasıyla şu 3 sorgu çalıştırılmalıdır:

### 1. Veritabanı Toplam Fiziksel Disk Boyutu
```sql
SELECT
  pg_size_pretty(pg_database_size(current_database())) AS total_database_size,
  pg_database_size(current_database()) AS total_database_bytes;
```

### 2. Public Tabloların Ayrıntılı Boyut Dağılımı (Data, Index, TOAST)
```sql
SELECT
  n.nspname AS schema_name,
  c.relname AS table_name,
  COALESCE(s.n_live_tup, 0) AS estimated_row_count,
  pg_size_pretty(pg_relation_size(c.oid)) AS data_size,
  pg_size_pretty(pg_indexes_size(c.oid)) AS index_size,
  pg_size_pretty(
    pg_total_relation_size(c.oid)
    - pg_relation_size(c.oid)
    - pg_indexes_size(c.oid)
  ) AS toast_and_other_size,
  pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
  pg_total_relation_size(c.oid) AS total_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE n.nspname = 'public'
  AND c.relkind = 'r'
ORDER BY total_bytes DESC;
```

### 3. Şema Bazında Toplam Boyut Dağılımı
> **Teknik Düzeltme:** `pg_total_relation_size(base_table)` zaten o tablonun TOAST verisini içerir. `pg_toast` şemasını ayrıca toplamak mükerrer sayıma (double-counting) yol açacağı için `pg_toast` ve geçici şemalar hariç tutulmalıdır.

```sql
SELECT
  n.nspname AS schema_name,
  pg_size_pretty(SUM(pg_total_relation_size(c.oid))) AS total_size,
  SUM(pg_total_relation_size(c.oid)) AS total_bytes
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname NOT IN (
    'pg_catalog',
    'information_schema',
    'pg_toast'
  )
  AND n.nspname NOT LIKE 'pg_toast_temp_%'
  AND n.nspname NOT LIKE 'pg_temp_%'
GROUP BY n.nspname
ORDER BY total_bytes DESC;
```

### 4. En Fazla Yer Kaplayan İndekslerin Analizi
> Bu sorgu ile `market_taxonomy_rankings` ve `market_taxonomy_product_observations` tablolarındaki compound indeks şişmesi (B-Tree index bloat) somut olarak tespit edilir.

```sql
SELECT
  schemaname,
  tablename,
  indexname,
  pg_size_pretty(pg_relation_size(indexrelid)) AS index_size,
  pg_relation_size(indexrelid) AS index_bytes
FROM pg_stat_user_indexes
ORDER BY index_bytes DESC
LIMIT 30;
```

## 4. ClickHouse Engine Seçim Stratejisi (MergeTree vs. ReplacingMergeTree)

Tüm tarihsel observation tablolarına otomatik olarak `ReplacingMergeTree` verilmeyecektir:
1. **Saf Append-Only / Değişmez Observation Akışları (`MergeTree`):**
   - Tekil run_id ve zaman damgasıyla bir defa yazılan, geçmişe dönük update almayan ve immutable olan gözlemler için `MergeTree` tercih edilecektir. Böylece arka plan merge yükü ve deduplication belirsizliği olmadan en yüksek yazma performansı ve öngörülebilir sıkıştırma sağlanır.
2. **Idempotent Snapshot / Son Durum Güncellemeleri (`ReplacingMergeTree`):**
   - Aynı gün/run içinde tekrar çalıştırılan veya belirli bir business key üzerinde son halini koruması gereken durumlar için `ReplacingMergeTree(version)` veya `ReplacingMergeTree()` değerlendirilecektir.
3. **Kesin Karar Aşaması:** Tablo bazlı engine seçimi, canlı Supabase satır tekillik (uniqueness) ve yeniden çalıştırma (re-run/update) senaryoları netleştikten sonra P1 tasarımında belirlenecektir.

## 5. 3 Aşamalı Çalışma Durumu Modeli (3-Tier Status Architecture)

Sistem durumu ve pipeline güvenliği 3 ayrı kavrama ayrılmıştır:
- `latest_attempt`: Son çalıştırılan run (başarılı, kısmi veya başarısız tüm denemeler).
- `latest_pass`: Son kalite ve veri bütünlüğü onayını (Quality Gate PASS) alan run.
- `latest_published`: Canlı üretim ortamına (production/downstream) başarıyla yazılmış son run.

## 6. Güvenli Migrasyon ve Doğrulama Adımları (P1 Öncesi)

1. **Audit Doğrulaması:** 4 SQL sorgusunun canlı çıktıları incelenecek.
2. **Backup:** Canlı Supabase yedeği (pg_dump) alınacak.
3. **ClickHouse Dual-Write:** Collector aynı anda hem Supabase hem ClickHouse'a yazacak.
4. **7-14 Gün Doğrulama:** Ürün sayısı, kategori sayısı, fiyat, rank, rating, review_count karşılaştırılacak.
5. **API Facade:** Verimimari frontend API'si tarihsel verileri ClickHouse'tan, güncel verileri Supabase'den çekecek.
6. **Arşiv & Drop:** Eski tarihsel tablolar yalnız tüm grafikler doğrulandıktan sonra temizlenecek.

