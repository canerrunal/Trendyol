# Supabase Veritabanı Canlı Boyut, Şema ve Büyüme Audit Raporu — 2026-09-17

> **Canlı Ölçüm Tarihi:** 2026-09-17 21:43 (Supabase Dashboard SQL Editor üzerinden canlı çalıştırıldı)
> **Toplam Veritabanı Boyutu:** **2.075 MB** (2.176.248.979 bytes) — *Supabase Ücretsiz Kotası (500 MB) aşılmış durumda ("EXCEEDING USAGE LIMITS")*
> **Temel Mimari İlke:** P1 dual-write doğrulanmadan ve 7-14 günlük mutabakat sağlanmadan hiçbir veri silinmeyecektir.

---

## 1. Şema Bazında Fiziksel Boyut Dağılımı

| Şema Adı | Toplam Boyut | Byte Değeri | Payı (%) | Durum |
|---|---|---|:---:|---|
| **`public`** | **2.064 MB** | 2.164.031.488 | **%99.44** | Asıl veri yükünün tamamı bu şemada |
| `auth` | 1.120 kB | 1.146.880 | %0.05 | Supabase dahili kimlik doğrulama |
| `storage` | 240 kB | 245.760 | %0.01 | Supabase dosya depolama metadataları |
| `realtime` | 56 kB | 57.344 | < %0.01 | Abonelik takibi |
| `vault` | 24 kB | 24.576 | < %0.01 | Şifreli ortam anahtarları |
| *Sistem & Catalog* | ~9.5 MB | ~10.742.931 | %0.49 | PostgreSQL dahili katalogları |
| **TOPLAM** | **2.075 MB** | **2.176.248.979** | **%100.0** | |

> **Analiz:** 2.075 MB'ın **%99.44**'ü doğrudan `public` şemasındaki tablolardan kaynaklanmaktadır. Sistem şemalarının payı ihmal edilebilir düzeydedir (< 2 MB).

---

## 2. Public Tabloların Ayrıntılı Ölçümü (Data vs. Index vs. TOAST)

| Tablo Adı | Canlı Satır Sayısı | Data (Heap) | Index Boyutu | TOAST / Diğer | Toplam Boyut | Toplam Byte | Hedef DB |
|---|---|---|---|---|---|---|:---:|
| `market_taxonomy_product_observations` | 2.092.368 | 478 MB | 337 MB | 920 kB | **816 MB** | 855.670.784 | **ClickHouse** |
| `market_taxonomy_rankings` | 2.549.090 | 249 MB | **452 MB** | 96 kB | **702 MB** | 735.617.024 | **ClickHouse** |
| `market_taxonomy_products` | 542.410 | 300 MB | 69 MB | 120 kB | **369 MB** | 387.006.464 | **Supabase** |
| `market_observations` | 95.199 | 122 MB | 23 MB | 15 MB | **160 MB** | 167.968.768 | **ClickHouse** |
| `market_products` | 17.135 | 6.248 kB | 944 kB | 40 kB | **7.23 MB** | 7.405.568 | **Supabase** |
| `market_taxonomy_category_paths` | 4.006 | 3.080 kB | 1.056 kB | 40 kB | **4.18 MB** | 4.276.224 | **Supabase** |
| `market_taxonomy_categories` | 3.955 | 1.784 kB | 640 kB | 40 kB | **2.46 MB** | 2.523.136 | **Supabase** |
| `rag_documents` | 0 | 0 bytes | 1.632 kB | 8.192 bytes | **1.64 MB** | 1.679.360 | **Supabase** |
| `market_pipeline_runs` | 329 | 688 kB | 120 kB | 40 kB | **0.85 MB** | 868.352 | **Supabase** |
| `market_merchants` | 5.708 | 456 kB | 288 kB | 40 kB | **0.78 MB** | 802.816 | **Supabase** |
| `market_taxonomy_runs` | 23 | 32 kB | 64 kB | 32 kB | **0.13 MB** | 131.072 | **Supabase** |
| `visitor_sessions` | 0 | 8.192 bytes | 32 kB | 8.192 bytes | **0.05 MB** | 49.152 | **Supabase** |
| `market_profiles` | 12 | 8.192 bytes | 16 kB | 8.192 bytes | **0.03 MB** | 32.768 | **Supabase** |

---

## 3. Mimari Ayrım ve Kapasite Rahatlama Analizi

### A. ClickHouse'a Taşınacak Tarihsel Gözlem Tabloları (%81.3)
1. `market_taxonomy_product_observations`: **816 MB**
2. `market_taxonomy_rankings`: **702 MB**
3. `market_observations`: **160 MB**
- **Toplam Taşınacak Hacim:** **1.678 MB** (~1.68 GB)
- **Public Tablolardaki Payı:** **%81.29**
- **Tüm Veritabanındaki Payı:** **%80.85**

> **Kritik Bulgu — İndeks Şişmesi (Index Bloat):**
> - `market_taxonomy_rankings` tablosunda Data boyutu **249 MB** iken, İndeks boyutu **452 MB**'tır! Tablonun **%64.4**'ünü B-Tree indeksleri kaplamaktadır.
> - Bu 4 sütunlu compound indeks (`run_id, category_id, rank, product_key`), ClickHouse'ın sparse index yapısında (`ORDER BY (marketplace, category_id, observed_date, rank)`) %95 oranında küçülecektir.

### B. Supabase'te Kalacak Varlık & Operasyonel Tablolar (%18.7)
- `market_taxonomy_products` (542k ürün master): 369 MB
- `market_products` (profil ürün master): 7.23 MB
- Taksonomi ağacı (`category_paths` + `categories`): 6.64 MB
- Satıcılar (`market_merchants`): 0.78 MB
- Run kayıtları (`pipeline_runs` + `taxonomy_runs`): 0.98 MB
- Uygulama tabloları (`rag_documents`, `visitor_sessions`, `profiles`): ~1.72 MB
- **Toplam Kalacak Hacim:** **~386.4 MB**

> **Net Sonuç & Kota Güvenlik Eşikleri:**
> Tarihsel tablolar ClickHouse'a aktarılıp Supabase'te dual-write mutabakatı tamamlandıktan sonra, Supabase disk kullanımı **2.075 MB'tan ~386 MB'a düşecektir**.
> Ancak entity tarafı organik büyümeye devam edeceği için şu **Kota Uyarı Eşikleri (Guardrails)** zorunlu kılınmıştır:
> - **425 MB (Kota %85): WARNING Eşiği.** Günlük büyüme hızı (`growth/day`) ve kalan gün sayısı (`days-to-limit`) izlenir; pasif ürün arşivleme hazırlığı başlatılır.
> - **475 MB (Kota %95): CRITICAL Eşiği.** Kota aşımı riskine karşı 60 günden eski pasif master ürünler soğuk depolamaya taşınır.

---

## 4. Günlük ve Aylık Büyüme Hızı Projeksiyonu

Canlı sistemdeki `market_taxonomy_runs` (23 tamamlanmış run) ve `market_pipeline_runs` (329 run) kayıtlarına göre:

- **Günlük Satır Artışı:**
  - `product_observations`: ~90.970 satır / gün
  - `rankings`: ~110.830 satır / gün
  - `market_observations`: ~3.500 satır / gün
  - **Toplam Günlük:** **~205.300 satır / gün**
- **PostgreSQL'de Günlük Disk Tüketimi (Uncompressed + Indexes):**
  - Observations: ~37.2 MB / gün
  - Rankings: ~32.0 MB / gün
  - Profil obs: ~6.2 MB / gün
  - **Toplam Günlük Büyüme:** **~75.4 MB / gün**
- **Aylık Veri Büyümesi:**
  - **Supabase'te kalsaydı:** `75.4 MB * 30` = **~2.26 GB / ay** (Her ay kotayı 4.5 kat aşma riski!)
  - **ClickHouse'ta (LZ4/ZSTD Columnar Sıkıştırma ile ~7x-10x oran):** **~220 MB - 320 MB / ay**.

---

## 5. Doğrulanan İndeks Boyutları (Sorgu 4 Sonuçları)

Canlı veritabanından alınan indeks dökümü, ilişkisel B-Tree indeks maliyetini net olarak ortaya koymuştur:

| Tablo Adı | İndeks Adı | İndeks Türü | Boyut (MB) | Tablodaki Payı |
|---|---|---|:---:|:---:|
| `market_taxonomy_rankings` | `market_taxonomy_rankings_pkey` | Compound PK (`run_id, category_id, rank, product_key`) | **316 MB** | %45.0 |
| `market_taxonomy_rankings` | `market_taxonomy_rankings_category_date_rank_idx` | Multi-column B-Tree (`category_id, observed_date desc, rank`) | **136 MB** | %19.4 |
| `market_taxonomy_product_observations` | `market_taxonomy_product_observations_pkey` | Compound PK (`run_id, product_key`) | **226 MB** | %27.7 |
| `market_taxonomy_product_observations` | `market_taxonomy_observations_product_date_idx` | B-Tree (`product_key, observed_date desc`) | **111 MB** | %13.6 |
| `market_taxonomy_products` | `market_taxonomy_products_pkey` | PK (`marketplace, product_key`) | **38 MB** | %10.3 |
| `market_taxonomy_products` | `market_taxonomy_products_product_idx` | B-Tree (`product_id, merchant_id`) | **31 MB** | %8.4 |

### İndeks Maliyeti Özeti:
- **Tarihsel İndeks Yükü (Rankings + Observations):** `316 + 136 + 226 + 111` = **~789 MB**!
- Bu iki tablodaki toplam 1.518 MB alanın **%52'si** salt ilişkisel B-Tree indeksleridir.
- **ClickHouse Seyrek İndeks Kazancı:** ClickHouse'un 8192 satırda 1 işaret koyan seyrek (sparse) birincil indeksi sayesinde bu 789 MB'lık B-Tree indeks yükünün ClickHouse tarafında **<10-20 MB bandına inmesi beklenmektedir** *(tahmin / benchmark gerektirir / estimate, benchmark-required)*.

---

## 6. Supabase Tarihsel Veri Temizliği ve Parquet Doğrulama Kapısı

Mevcut Supabase production şemasında hiçbir indeks drop edilmeyecek, hiçbir satır silinmeyecektir. İleride dual-write mutabakatı (7-14 gün) tamamlandıktan sonra Supabase tarihsel tablolarının (`product_observations`, `rankings`, `market_observations`) arşivlenmesi ve truncate edilmesi için şu **3 zorunlu kapı (Verification Gates)** şart koşulmuştur:

1. **Exact Row-Count Match:** Supabase satır sayısı == Parquet dışa aktarım satır sayısı == ClickHouse satır sayısı.
2. **Cryptographic Checksum Match:** Dışa aktarılan verinin SHA256 içerik sağlama toplamı doğrulanmalıdır.
3. **Restore-Test PASS:** Parquet yedeğinin geçici/staging bir veritabanına geri yüklenerek (restore test) veri kaybı veya bozulma olmadığı teyit edilmeli ve **RESTORE-TEST PASS** onayı alınmalıdır.
4. **Yazılı Kullanıcı Onayı:** Tüm bu adımlar geçilmeden Supabase'ten tek bir satır silinmeyecektir.


