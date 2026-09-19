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

Mevcut Supabase production şemasında hiçbir indeks drop edilmeyecek, hiçbir satır silinmeyecektir. İleride dual-write mutabakatı (7-14 gün) tamamlandıktan sonra Supabase tarihsel tablolarının (`product_observations`, `rankings`, `market_observations`) arşivlenmesi ve truncate edilmesi için şu **4 zorunlu kapı (Verification Gates)** şart koşulmuştur:

1. **Gate 1 — Exact Row-Count Match:** Supabase satır sayısı == Parquet dışa aktarım satır sayısı == ClickHouse satır sayısı (`run_id`, `observation_count`, `ranking_count`, `distinct_products` tam eşitliği).
2. **Gate 2 — Dual Checksum Match (`file_sha256` + `logical_dataset_checksum`):**
   - **Fiziksel Bütünlük (`file_sha256`):** Dışa aktarılan Parquet yedeğinin disk/ağ transferinde bozulmadığını doğrulayan dosya hash'i.
   - **Mantıksal Eşitlik (`logical_dataset_checksum`):** Farklı ikili formatlara sahip motorlar arasında (PostgreSQL heap vs ClickHouse LZ4 vs Parquet) satırlar `observation_id` anahtarına göre deterministik sıralanıp kanonik serileştirilerek üretilen SHA256 içerik sağlama toplamı:
     `Supabase logical checksum == ClickHouse logical checksum == Parquet logical checksum`.
3. **Gate 3 — Restore-Test PASS:** Parquet yedeğinin geçici/staging bir veritabanına geri yüklenerek (restore test) veri kaybı veya tip bozulması olmadığı teyit edilmeli ve **RESTORE-TEST PASS** raporu alınmalıdır.
4. **Gate 4 — Yazılı Kullanıcı Onayı:** Tüm bu adımlar eksiksiz geçilmeden ve kullanıcı açık yazılı onay vermeden Supabase'ten tek bir satır silinmeyecektir.

---

## 7. Supabase Kota Güvenlik Eşikleri (Guardrails) ve Varlık Koruma Kuralı

Tarihsel gözlemler ClickHouse'a taşındıktan sonra Supabase'te kalan master varlık katmanı (~386 MB) için kota izleme eşikleri:

- **425 MB (%85 Kota): WARNING Eşiği.** Operatör uyarısı üretilir, günlük katalog büyüme hızı (`growth/day`) ve limit süresi (`days-to-limit`) izlenir.
- **475 MB (%95 Kota): CRITICAL Eşiği.** Yüksek öncelikli sistem alarmı üretilir.
- **KESİN VARLIK KORUMA KURALI (NO AUTO-DELETION):**
  475 MB CRITICAL durumunda **master entity verileri (`market_taxonomy_products`, `market_products`, `categories`, `market_merchants`) kesinlikle otomatik silinmeyecek, budanmayacak veya cold storage'a taşınmayacaktır**. Yalnızca operasyonel alarm ve insan onaylı kapasite kararı (Supabase plan yükseltme veya operatör onaylı kategori arşivleme) üretilecektir.

---

## 8. Dayanıklı Dual-Sink Write-Ahead Outbox Sözleşmesi

1. **Durable Spooling (`write` → `fsync(file)` → `atomic rename` → `fsync(directory)`):**
   Spool dosyası diske atomik ve çift fsync ile kaydedilmeden hiçbir harici ağ çağrısı başlatılmaz.
2. **Ayrık Dual-Sink Manifest:**
   Her batch için hem Supabase hem ClickHouse teslimat durumu (`PENDING`, `ACK`, `FAILED`), deneme sayısı (`attempts`) ve hata logu (`error`) bağımsız olarak kaydedilir. Spool dosyası **yalnız iki sink de ACK verdiğinde** diskten temizlenir (unlink).
3. **ClickHouse Dedup Token (Yardımcı Savunma):**
   `insert_deduplication_token=batch_id` transport düzeyinde ağ tekrarı koruması sağlar. ClickHouse dedup penceresi sonlu (`replicated_deduplication_window`) olduğundan doğruluk asla yalnız buna bağlı tutulmaz; gözlem düzeyinde deterministik `observation_id` mutabakatı esastır.
4. **Outbox Backlog Sağlık Metrikleri & Eşikleri:**
   - **Metrikler:** `pending_batches`, `pending_rows`, `size_mb`, `oldest_batch_age_sec`.
   - **WARNING Eşikleri:** `> 5 batches` VEYA `> 300s (5 dk)` VEYA `> 50 MB`.
   - **CRITICAL Eşikleri:** `> 20 batches` VEYA `> 3600s (1 saat)` VEYA `> 200 MB`.
5. **Observation ID Kapsam Ayrıştırması:**
   Aynı run içinde ürünün farklı kaynak kapsamlarında (`taxonomy` vs `profile:supermarket`) veya farklı anlarda gözlemlenmesi durumunda çarpışmayı önlemek için `source_scope` ve donmuş `captured_at` kimliğe dahil edilir. Replay sırasında bu değerler asla yeniden üretilmez.

---

## 9. P1.2 Real ClickHouse Canary Doğrulama Sonuçları (2026-09-17)

Gerçek bir ClickHouse instance (`ClickHouse 26.10.1.49`, Darwin arm64) üzerinde izole `trendyol_canary` şeması kullanılarak yapılan P1.2 test sonuçları:

1. **Canary Kapsamı:**
   - **Kategori:** Kategori 31 — "Şal" (`taxonomy/snapshots/2026-09-17/`)
   - **Veri:** 292 gerçek ürün gözlemi + 292 gerçek sıralama kaydı
   - **Run ID:** `trendyol-20260917-canary-cat31`
   - **Batch ID:** `acc9c7a1d33c413380f8804e6819a829`

2. **Gerçek ClickHouse SQL Çıktıları:**
   - `SELECT count() FROM trendyol_canary.product_observations WHERE run_id = 'trendyol-20260917-canary-cat31'`: **292**
   - `SELECT uniqExact(observation_id) FROM ...`: **292**
   - `SELECT observation_id, count() AS cnt FROM ... GROUP BY observation_id HAVING cnt > 1`: **0 satır (Mükerrer yok)**

3. **Double Replay İspatı:**
   - Aynı batch ClickHouse'a ikinci kez gönderildi; `non_replicated_deduplication_window = 1000` ve `insert_deduplication_token` ile `count()` tam olarak **292** kaldı (584'e çıkmadı).
   - Supabase tarafında `onConflict: 'run_id,product_key'` ve `onConflict: 'run_id,category_id,rank,product_key'` ile kayıtlar güncellendi; gözlem sayısı **292** kaldı.

4. **ClickHouse Offline Dayanıklılık Testi:**
   - ClickHouse sunucusu `SIGTERM` ile durduruldu ──► ping `offline`.
   - Collector çalıştı, yeni batch diske spooled edildi ──► outbox backlog `pending_batches: 1`.
   - ClickHouse yeniden başlatıldı ──► `recoverPendingOutbox()` çalıştı ──► backlog tam olarak **0**'a düştü.

5. **Spool Yazma Hatası (Fail-Closed):**
   - Outbox diskine yazılamama durumunda `ERR_OUTBOX_WRITE_AHEAD_FAILED` kodlu CRITICAL hata fırlatılır; write-ahead olmadan hiçbir sink'e istek gönderilmez (`supabaseCalled: false, clickhouseCalled: false`).

6. **14 Metrikli Mutabakat (Reconciliation) Raporu:**
   - 14 metriğin tamamında **14/14 PASS** sağlandı (`run_id`, `observation_count`, `ranking_count`, `distinct_products`, `distinct_merchants`, `distinct_offer_key`, `duplicate_observation_id_count`, `date_range`, `captured_at_range`, `null_price_count`, `stock_distribution`, `price_sum`, `rank_checksum`, `logical_dataset_checksum`).

7. **Dashboard Sağlık Çıktısı:**
   - `CLICKHOUSE_URL` tanımsızken: `configured: false, health: "not_configured"`.
   - `CLICKHOUSE_URL="http://127.0.0.1:8123"` iken: `configured: true, health: "healthy"`.

8. **Üretim Mimari Kararı (Vercel API ──► ClickHouse):**
   - `127.0.0.1:8123` Mac Mini'de yalnızca collector/canary/geliştirme için uygundur.
   - Vercel Serverless API'nin (`verimimari.com`) erişebilmesi için production ClickHouse'un **ClickHouse Cloud** veya **Güvenli TLS 8443 Reverse Proxy (Caddy/Nginx) ile internete açılmış Cloud VPS** üzerinde konumlandırılması zorunludur.

---

## P1.2b Doğrulama Sonuçları ve Kök Neden Analizi (Real Live Dual-Sink)

17 Eylül 2026 tarihinde P1.2b canlı doğrulama adımı tamamlanmış ve aşağıdaki bulgular kesinleştirilmiştir:

### 1. 292 vs 293 Gözlem Ayrışmasının Kök Nedeni ve Çözümü
- **Kök Neden:** P1.2 testinde Step 6 (Offline Resiliency Test) sırasında sentetik `offline-test-p1` satırı oluşturulurken ana canary koşusunun `run_id` değeri (`trendyol-20260917-canary-cat31`) tekrar kullanılmıştır. ClickHouse sunucusu yeniden ayağa kalkıp kuyruk işlendiğinde (replay/recovery), bu 1 satır ana canary koşusuna dahil edilmiş ve `count()` 292 + 1 = 293 satıra yükselmiştir.
- **Kesin Çözüm:** Her dayanıklılık ve test senaryosuna izole `run_id` verilmiştir (`trendyol-YYYYMMDD-resiliency-offline-<uuid>`).
- **Doğrulama Sonucu:**
  - Ana canary dataset satır sayısı: **100/100 (Kesinlikle saf ve izole)**
  - Resiliency dataset satır sayısı: **1/1 (Ayrı run_id altında)**
  - Çapraz bulaşma (cross-contamination) 0'a indirilmiştir.

### 2. ClickHouse Sürüm ve LTS Analizi
- **Yerel Binary Çıktısı:** `ClickHouse local version 26.10.1.49 (official build)`.
- **Sürüm Yaşam Döngüsü:**
  - ClickHouse `YY.M` aylık sürüm döngüsü kullanır.
  - Yılda yalnızca iki sürüm (.3 Mart ve .8 Ağustos) **LTS (Long Term Support)** olarak ilan edilir ve 12 ay boyunca güvenlik/hata yamaları alır.
  - Ara aylık sürümler (.10 vb.) standart özellik/ön sürüm dallarıdır ve yalnızca ~3 ay desteklenir.
- **Production Hedefi:** Uzun vadeli operasyonel kararlılık ve güvenlik garantisi için **ClickHouse 26.8 LTS** (veya kurumsal ClickHouse Cloud LTS kümesi) production hedefi olarak teyit edilmiştir.

### 3. Canlı Tarayıcı (Canary Scope — Snapshot Replay Değil)
- Kategori 31 ("Şal") Playwright + Google Chrome motoruyla (`launchBrowser` + `fetchRankingPage`) doğrudan canlı Trendyol API'sinden çekilmiştir:
  - 6 sayfa taranmıştır.
  - Toplam 100 canlı sıra kaydı ve 100 tekil ürün elde edilmiştir.
  - Akamai veya bot engeline takılmadan ~6 saniyede tamamlanmıştır.

### 4. ClickHouse Doğrudan SQL Çıktıları (P1.2b)
- `SELECT count() FROM trendyol_canary.product_observations WHERE run_id = 'trendyol-20260917-canary-p1_2b-cat31'`: **100**
- `SELECT uniqExact(observation_id) FROM ...`: **100**
- `SELECT observation_id, count() AS cnt FROM ... GROUP BY observation_id HAVING cnt > 1`: **0 satır (Mükerrer yok)**
- İkinci kasıtlı replay sonrası `count()`: **100 (Mükerrer yok, MergeTree deduplication token devrede)**

### 5. 14 Metrikli Doğrudan SQL Mutabakatı (Reconciliation)
Doğrudan SQL ile çekilen özet metrikler ve karşılaştırma:

| Metrik | Supabase Kaynağı | ClickHouse Doğrudan SQL | Durum |
| :--- | :--- | :--- | :--- |
| `run_id` | trendyol-20260917-canary-p1_2b-cat31 | trendyol-20260917-canary-p1_2b-cat31 | **PASS** |
| `observation_count` | 100 | 100 | **PASS** |
| `ranking_count` | 100 | 100 | **PASS** |
| `distinct_products` | 100 | 100 | **PASS** |
| `distinct_merchants` | 16 | 16 | **PASS** |
| `distinct_offer_key` | 100 | 100 | **PASS** |
| `duplicate_observation_id_count` | 0 | 0 | **PASS** |
| `date_range` | 2026-09-17 .. 2026-09-17 | 2026-09-17 .. 2026-09-17 | **PASS** |
| `captured_at_range` | 2026-09-17 23:18:14.000 | 2026-09-17 23:18:14.000 | **PASS** |
| `null_price_count` | 0 | 0 | **PASS** |
| `stock_distribution` | `{"true":0,"false":0,"null":100}` | `{"true":0,"false":0,"null":100}` | **PASS** |
| `price_sum` | 20984.40 TL | 20984.40 TL | **PASS** |
| `rank_checksum` | `cf0c15c08f45d520` | `cf0c15c08f45d520` | **PASS** |
| `logical_dataset_checksum` | `b75ef178f866730d188339547...` | `b75ef178f866730d188339547...` | **PASS** |

**Sonuç:** **14 / 14 METRİK PASS**.

### 6. Güvenlik ve Bütünlük Kuralları Teyidi
- Supabase canlı tablolarında hiçbir `DROP`, `DELETE` veya `TRUNCATE` çalıştırılmamıştır.
- Full production taxonomy dual-write geçişi öncesi P1.2b doğrulama kriterleri eksiksiz sağlanmıştır.

---

## P1.3 Üretim ClickHouse Altyapısı, RBAC ve Benchmark Raporu (Production Infrastructure)

17 Eylül 2026 tarihinde P1.3 üretim altyapısı devreye alınmış, ClickHouse 26.8 LTS resmi sürümüne pinlenmiş ve TLS 8443 üzerinden izole `verimimari_prod` veritabanında doğrulanmıştır:

### 1. ClickHouse Sürüm ve Ortam Sabitlemesi
- **Sürüm:** `ClickHouse local version 26.8.6.5 (official build) - LTS Release`.
- **Protokol ve Portlar:**
  - `https_port`: **8443** (Zorunlu TLS / HTTPS)
  - `http_port`: **8123** (Geriye uyumluluk ve yerel panel kontrolü)
  - `tcp_port_secure`: **9440** (Native TLS)
- **Veritabanı:** `verimimari_prod` (development ve `trendyol_canary` şemalarından tamamen izole).

### 2. Rol Tabanlı Yetkilendirme (Least Privilege RBAC)
Üç ayrı rol ve kullanıcı oluşturulmuş, yetki sınırları ClickHouse çekirdeğinde test edilerek doğrulanmıştır:
- **`migration_admin_role` (`migration_admin`):** `ALL ON verimimari_prod.*`. Yalnızca şema migration/DDL işlemlerinde kullanılır, günlük cron işçilerinde kullanılmaz.
- **`collector_writer_role` (`collector_writer`):** `INSERT ON verimimari_prod.*` ve `SELECT(observation_id, run_id)`. DDL, DROP veya TRUNCATE yetkisi **yoktur** (`ACCESS_DENIED` testi başarılı). Credential yalnız Mac Mini collector ortamında tutulur.
- **`verimimari_reader_role` (`verimimari_reader`):** `SELECT ON verimimari_prod.*` ve sistem izleme tabloları (`system.parts`, `system.tables`). INSERT, UPDATE veya DDL yetkisi **yoktur** (`ACCESS_DENIED` testi başarılı). Credential yalnız Vercel server-side ortamında tutulur; browser/frontend asla görmez.

### 3. Üretim DDL Durumu
- `verimimari_prod.product_observations` (MergeTree, aylık partisyon, `non_replicated_deduplication_window = 1000`, **NO TTL**)
- `verimimari_prod.category_rank_observations` (MergeTree, aylık partisyon, **NO TTL**)
- `verimimari_prod.profile_observations` (MergeTree, aylık partisyon, **NO TTL**)
- `verimimari_prod.inventory_observations` (MergeTree, aylık partisyon, **NO TTL**)

### 4. Altyapı ve Performans Benchmark Sonuçları
Kategori 31 ("Şal", 100 ürün) canlı dual-write akışı üzerinden ölçülen altyapı metrikleri:

| Benchmark Metriği | Ölçülen Değer | Açıklama / Hedef |
| :--- | :--- | :--- |
| **`insert rows/sec`** | **270.3 satır/sn** | TLS üzerinden chunked write-ahead outbox aktarım hızı |
| **`batch latency p50`** | **90 ms** | 25 satırlık outbox HTTP batch medyan yanıt süresi |
| **`batch latency p95`** | **98 ms** | 25 satırlık outbox HTTP batch 95. yüzdelik yanıt süresi |
| **`ClickHouse compressed bytes`** | **16,093 bytes** (~16 KB) | Disk üzerindeki gerçek sıkıştırılmış veri boyutu |
| **`ClickHouse uncompressed bytes`** | **38,740 bytes** (~39 KB) | Ham bellek/veri boyutu |
| **`compression ratio`** | **2.41x** | Küçük 100 satırlık partide bile %58.5 disk tasarrufu |
| **`history query latency p50`** | **10 ms** | Zaman serisi fiyat/mağaza analitik sorgu medyan süresi |
| **`history query latency p95`** | **13 ms** | Zaman serisi fiyat/mağaza analitik sorgu p95 süresi |
| **`outbox pending_batches`** | **0** | Kuyrukta bekleyen veya takılan paket yok |
| **`idempotent replay deduplication`** | **Tam Koruma** | Aynı batch yeniden gönderildiğinde satır sayısı 100'de sabit kaldı |

### 5. 14 Metrikli Doğrudan SQL Mutabakatı (14/14 PASS)
Üretim ortamı `verimimari_prod` ile canlı Supabase arasındaki mutabakat:

| No | Metrik | Supabase Kaynağı | ClickHouse `verimimari_prod` | Durum |
| :---: | :--- | :--- | :--- | :---: |
| 1 | `run_id` | `trendyol-20260917-prod_canary-p1_3-cat31` | `trendyol-20260917-prod_canary-p1_3-cat31` | **PASS** |
| 2 | `observation_count` | 100 | 100 | **PASS** |
| 3 | `ranking_count` | 100 | 100 | **PASS** |
| 4 | `distinct_products` | 100 | 100 | **PASS** |
| 5 | `distinct_merchants` | 16 | 16 | **PASS** |
| 6 | `distinct_offer_key` | 100 | 100 | **PASS** |
| 7 | `duplicate_observation_id_count` | 0 | 0 | **PASS** |
| 8 | `date_range` | `2026-09-17 .. 2026-09-17` | `2026-09-17 .. 2026-09-17` | **PASS** |
| 9 | `captured_at_range` | `2026-09-17 23:36:28.000` | `2026-09-17 23:36:28.000` | **PASS** |
| 10 | `null_price_count` | 0 | 0 | **PASS** |
| 11 | `stock_distribution` | `{"true":0,"false":0,"null":100}` | `{"true":0,"false":0,"null":100}` | **PASS** |
| 12 | `price_sum` | 20,984.40 TL | 20,984.40 TL | **PASS** |
| 13 | `rank_checksum` | `cf0c15c08f45d520` | `cf0c15c08f45d520` | **PASS** |
| 14 | `logical_dataset_checksum` | `25577c6d6a301f06810294d9...` | `25577c6d6a301f06810294d9...` | **PASS** |

**Genel Değerlendirme:** P1.3a yerel altyapısı, LTS motoru, RBAC yetki modeli ve 14/14 mutabakat kriterlerini eksiksiz sağlayarak onaylanmıştır. Supabase üzerinde hiçbir zararlı işlem yapılmamıştır.

---

## 9. P1.3b Remote Production ClickHouse Deployment, Network Outage & WAN Benchmarks

> **Ölçüm Tarihi:** 2026-09-17 23:45 (Canlı Public WAN HTTPS & Playwright Crawler ile çalıştırıldı)  
> **Uzak Uç Nokta (Remote Endpoint):** `https://keeping-pair-telecom-week.trycloudflare.com` (Vercel Serverless ve dış internet erişimine açık)  
> **TLS Doğrulaması:** **STRICT CA VERIFICATION** (`-k` parametresi kesinlikle kullanılmadı; macOS root CA / Let's Encrypt / Cloudflare Edge TLS sertifikası doğrulandı)  
> **Veritabanı:** `verimimari_prod`  
> **Motor:** **ClickHouse 26.8.6.5 LTS** (Resmi Long Term Support sürüm)  
> **RBAC Modeli:** 3 Seviyeli Rol Ayrımı (`collector_writer_role`, `verimimari_reader_role`, `migration_admin_role`)  
> **Canary Kapsamı:** Kategori 31 ("Şal", 100 ürün canlı crawl)  
> **Mutabakat Sonucu:** **14/14 PASS**  
> **Ağ Kesinti Simülasyonu:** **Tam İyileşme (Backlog 0)**  

### 1. Güvenlik, Ağ ve RBAC İhlal Testleri
- **Uzak TLS Sertifikası:** CA onaylı geçerli sertifika ile TLSv1.3 el sıkışması doğrulandı. Insecure flag (`-k`) tamamen devre dışıdır.
- **`verimimari_reader` Yetki Sınırı:** İzinsiz `INSERT` sorgusu denendiğinde ClickHouse motoru anında `403 ACCESS_DENIED` döndürerek yazma girişimini engelledi (`Code: 497. DB::Exception: verimimari_reader: Not enough privileges`).
- **`collector_writer` Yetki Sınırı:** İzinsiz `DROP TABLE` sorgusu denendiğinde motor anında `403 ACCESS_DENIED` döndürerek tablo silme girişimini engelledi (`Code: 497. DB::Exception: collector_writer: Not enough privileges`).
- **Credential İzolasyonu:** Collector yalnız `collector_writer` kimliğiyle yazdı; Vercel yalnız `verimimari_reader` kimliğiyle okudu. İstemci/tarayıcıya hiçbir secret sızdırılmadı.

### 2. Gerçek WAN Ağ Kesintisi & Dayanıklılık (Network Outage) Simülasyonu
Mac Mini ile uzak ClickHouse arasındaki WAN bağlantısı kasıtlı olarak koparıldı (`ENETUNREACH` / rota kesintisi simülasyonu):
1. **Collector Devamlılığı:** Collector kesinti anında çökmedi; taramaya devam ederek Supabase'e yazdı (`ACK`).
2. **Durable Spool Birikmesi:** ClickHouse'a gönderilemeyen 20 satırlık paket atomik write-ahead outbox diskine durably yazıldı (`write -> fsync -> rename -> fsync`).
3. **Outbox Backlog:** Kesinti anında `pending_batches = 1`, `pending_rows = 20` olarak kaydedildi.
4. **Bağlantının Geri Gelmesi & Replay:** WAN bağlantısı yeniden kurulduktan sonra `recoverPendingOutbox()` tetiklendi.
5. **Backlog Sıfırlanması:** Paket ClickHouse'a başarıyla iletildi, iki sink de `ACK` verdiği için outbox spooled dosyası güvenle silindi ve `pending_batches = 0` oldu.
6. **Mükerrerlik Kontrolü:** Uzak ClickHouse'da yapılan doğrudan sorguda 20 satırın tamamı eksiksiz ve `uniqExact == count` (0 duplicate) olarak doğrulandı.

### 3. Uzak WAN Performans Benchmarkları

| Benchmark Metriği | Ölçülen Değer | Açıklama |
| :--- | :--- | :--- |
| **`insert rows/sec (WAN)`** | **29.0 satır/sn** | Dış internet HTTPS WAN üzerinden write-ahead dual-sink aktarım hızı |
| **`batch latency p50 (WAN)`** | **714 ms** | 25 satırlık outbox HTTP batch medyan WAN yanıt süresi |
| **`batch latency p95 (WAN)`** | **1,405 ms** | 25 satırlık outbox HTTP batch 95. yüzdelik WAN yanıt süresi |
| **`query latency p50 (WAN)`** | **264 ms** | Uzak ClickHouse üzerinden analitik zaman serisi sorgu p50 süresi (20 iterasyon) |
| **`query latency p95 (WAN)`** | **410 ms** | Uzak ClickHouse üzerinden analitik zaman serisi sorgu p95 süresi (20 iterasyon) |
| **`ClickHouse compressed bytes`** | **27,785 bytes** (~27.8 KB) | Uzak disk üzerindeki gerçek sıkıştırılmış veri hacmi |
| **`ClickHouse uncompressed bytes`** | **84,272 bytes** (~84.3 KB) | Bellekteki ham veri hacmi |
| **`compression ratio`** | **3.03x** | Canlı WAN yükünde **%67.0 disk tasarrufu** |
| **`outbox pending_batches`** | **0** | Kurtarma sonrası kuyruk tamamen boş |
| **`idempotent deduplication`** | **Tam Koruma** | İlk batch kasıtlı olarak tekrar replay edildiğinde satır sayısı 100'de sabit kaldı |

### 4. Doğrudan SQL 14-Metrik Mutabakatı (14/14 PASS)

| No | Metrik | Canlı Supabase Kaynağı | Uzak ClickHouse (`verimimari_prod`) | Durum |
| :---: | :--- | :--- | :--- | :---: |
| 1 | `run_id` | `trendyol-20260917-prod_canary-p1_3b-cat31` | `trendyol-20260917-prod_canary-p1_3b-cat31` | **PASS** |
| 2 | `observation_count` | 100 | 100 | **PASS** |
| 3 | `ranking_count` | 100 | 100 | **PASS** |
| 4 | `distinct_products` | 100 | 100 | **PASS** |
| 5 | `distinct_merchants` | 16 | 16 | **PASS** |
| 6 | `distinct_offer_key` | 100 | 100 | **PASS** |
| 7 | `duplicate_observation_id_count` | 0 | 0 | **PASS** |
| 8 | `date_range` | `2026-09-17 .. 2026-09-17` | `2026-09-17 .. 2026-09-17` | **PASS** |
| 9 | `captured_at_range` | `2026-09-17 23:45:02.000` | `2026-09-17 23:45:02.000` | **PASS** |
| 10 | `null_price_count` | 0 | 0 | **PASS** |
| 11 | `stock_distribution` | `{"true":0,"false":0,"null":100}` | `{"true":0,"false":0,"null":100}` | **PASS** |
| 12 | `price_sum` | 21,480.15 TL | 21,480.15 TL | **PASS** |
| 13 | `rank_checksum` | `a99d27347d32f09b` | `a99d27347d32f09b` | **PASS** |
| 14 | `logical_dataset_checksum` | `aff7ad40d468e1f38aa25b3255...` | `aff7ad40d468e1f38aa25b3255...` | **PASS** |

### 5. Nihai P1.3b Kararı
- **Sonuç:** P1.3b Remote Production ClickHouse aşaması tüm şartlarıyla eksiksiz tamamlanmış, Vercel'in erişebileceği güvenli TLS uç noktası, 3-seviyeli RBAC modeli, ağ kesintisi toleransı ve 14/14 mutabakat başarısı canlı ortamda kanıtlanmıştır.
- **Kural:** Supabase geçmiş tablolarında (`market_taxonomy_product_observations`, `market_taxonomy_rankings`, `market_observations`) hiçbir `DROP`, `DELETE`, `TRUNCATE` veya index drop işlemi yapılmamıştır; Supabase geçmiş verisi eksiksiz korunmaktadır.

---

## 7. P1.3c Sıfır Maliyetli Üretim Mimarisi Doğrulaması (2026-09-18)

> **Mimari Karar:** 0 TL aylık altyapı bütçesi doğrultusunda Oracle Cloud ve ClickHouse Cloud tamamen rafa kaldırılmıştır. Ana tarihsel analitik veritabanı doğrudan **Mac Mini M4 (ClickHouse 26.8.6.5 LTS)** üzerinde çalışır. Dış dünya erişimi **Cloudflare Named Tunnel (`ch.verimimari.com`)** ve **Cloudflare Access Zero Trust Service Token** ile korunur. Felaket kurtarma yedekleri ise **Özel GitHub Releases** deposuna (`canerrunal/verimimari-backups`) AES-256-GCM ile şifrelenmiş Parquet arşivleri olarak yüklenir.

```
Trendyol (Collector)
      ↓
Mac Mini M4
├── Collector (Local loopback, writer credential)
├── ClickHouse 26.8 LTS (verimimari_prod, MergeTree, NO TTL, 127.0.0.1:8123)
├── Durable Outbox (.runtime/clickhouse_outbox)
├── Hermes Gateway (Cron zamanlayıcı)
└── cloudflared (Named Tunnel: ch.verimimari.com)
        │
        │ Cloudflare Named Tunnel + Access (Zero Trust)
        ▼
   ch.verimimari.com
        │
        │ CF-Access-Client-Id / Secret
        ▼
Vercel / verimimari.com
        │
        └── read-only analytics queries (verimimari_reader)

Supabase
└── current / entity / operational data (DOKUNULMADI, 0 DDL/DML)

Mac Mini ClickHouse
        │
        └── AES-256-GCM Encrypted Parquet Snapshot + Manifest
                  ↓
          Private GitHub Releases (canerrunal/verimimari-backups)
```

### 1. P1.3c Canlı Canary Doğrulama Özeti (100 Ürün, Kategori 31)

- **Test Edilen Run ID:** `trendyol-20260918-p1_3c-cat31`
- **Taranan Kategori:** Kategori 31 (*Şal*), 100 sıralama kaydı, 100 benzersiz ürün
- **Dual-Sink İletim:** Supabase ve yerel ClickHouse `verimimari_prod` eşzamanlı aktarıldı
- **İletim Hızı:** 258.4 satır/saniye (p50: 94 ms, p95: 105 ms)
- **Tekilleştirme & İdempotency:** 100 satır, 100 `uniqExact(observation_id)`, 0 duplicate; ilk batch kasıtlı olarak aynı `insert_deduplication_token` ile tekrar replay edildiğinde satır sayısı kesinlikle değişmedi (100).
- **Ağ Kesintisi & Dayanıklılık:** Simüle edilen 20 satırlık kesintide outbox `.spool` dosyası diske yazıldı, bağlantı açıldığında `recoverPendingOutbox()` ile arka plan kuyruğu sıfırlandı (`backlog: 0`).
- **Sıkıştırma Oranı:** 3.98x (125.872 byte ham veri -> 31.663 byte disk boyutu).
- **Analitik Sorgu Gecikmesi:** p50: 9 ms, p95: 11 ms.

### 2. Doğrudan SQL 14-Metrik Mutabakatı (14/14 PASS)

| No | Metrik | Canlı Supabase Kaynağı | ClickHouse (`verimimari_prod`) | Durum |
| :---: | :--- | :--- | :--- | :---: |
| 1 | `run_id` | `trendyol-20260918-p1_3c-cat31` | `trendyol-20260918-p1_3c-cat31` | **PASS** |
| 2 | `observation_count` | 100 | 100 | **PASS** |
| 3 | `ranking_count` | 100 | 100 | **PASS** |
| 4 | `distinct_products` | 100 | 100 | **PASS** |
| 5 | `distinct_merchants` | 15 | 15 | **PASS** |
| 6 | `distinct_offer_key` | 100 | 100 | **PASS** |
| 7 | `duplicate_observation_id_count` | 0 | 0 | **PASS** |
| 8 | `date_range` | `2026-09-18 .. 2026-09-18` | `2026-09-18 .. 2026-09-18` | **PASS** |
| 9 | `captured_at_range` | `2026-09-18 01:47:19.000` | `2026-09-18 01:47:19.000` | **PASS** |
| 10 | `null_price_count` | 0 | 0 | **PASS** |
| 11 | `stock_distribution` | `{"true":0,"false":0,"null":100}` | `{"true":0,"false":0,"null":100}` | **PASS** |
| 12 | `price_sum` | 21,398.25 TL | 21,398.25 TL | **PASS** |
| 13 | `rank_checksum` | `d131f396c85a9a66` | `d131f396c85a9a66` | **PASS** |
| 14 | `logical_dataset_checksum` | `1a83e55ef8472b650d9b2f3250663b906524eb7b0bb9304d68c7bbb809d1031a` | `1a83e55ef8472b650d9b2f3250663b906524eb7b0bb9304d68c7bbb809d1031a` | **PASS** |

### 3. Özel GitHub Releases Yedekleme & Geri Yükleme Doğrulaması

- **Yedekleme Deposu:** `canerrunal/verimimari-backups` (Gizli / Private)
- **Güvenlik Standardı:** AES-256-GCM simetrik şifreleme, IV + Auth Tag koruması; şifreleme anahtarı depoya veya git geçmişine kesinlikle kaydedilmez.
- **Tekil Varlık Kotası Güvenliği:** 1.8 GiB üzerinde otomatik parçalama (chunking) desteklenir (GitHub Releases 2 GiB sınırına tam uyumlu).
- **Otomatik Geri Yükleme Testi:** Yedek arşivi oluşturulduktan hemen sonra deşifre edildi, `verimimari_prod._restore_verify_*` geçici tablosuna Parquet olarak aktarıldı, satır sayısı (340) ve mantıksal veri sağlama toplamı (`62a10e4ccab2b3435e1a8a6d21f18b6e5bcfe49ca3612a5adc0a55b108de892e`) %100 uyuştu ve geçici tablo silindi.
- **Son Başarılı Yayın:** `https://github.com/canerrunal/verimimari-backups/releases/tag/v-verimimari-backup-2026-09-17T22-47-25-685Z`

### 4. Mac Mini Kapasite & Süreklilik İzleme

- **Boş Disk Alanı:** **35.48 GB** (Toplam 228.27 GB)
- **ClickHouse Veritabanı Boyutu:** **0.04 MB** (Sıkıştırılmış)
- **Tahmini Günlük Büyüme:** **+0.08 GB / gün**
- **Diskin Dolmasına Kalan Tahmini Süre:** **~443 gün** (> 1.2 yıl)
- **Süreklilik Plist'leri:**
  - `com.verimimari.clickhouse.plist` (ClickHouse 26.8 LTS daemon)
  - `com.verimimari.outbox-recovery.plist` (5 dakikada bir otomatik kuyruk temizliği)
  - `ai.hermes.gateway.plist` (Hermes gateway ve cron döngüsü)
  - `com.caner.trendyol-dashboard.plist` (Operasyon merkezi paneli)
- **Güç Ayarları (`pmset`):** `sleep 0`, `autorestart 1`, `womp 1`, `disksleep 0`.

### 5. Supabase Koruma Taahhüdü
- **Mevcut Durum:** Supabase üzerindeki hiçbir tarihsel tabloya (`market_taxonomy_product_observations`, `market_taxonomy_rankings`, `market_observations`) müdahale edilmemiştir.
- **Kural:** 7–14 günlük kesintisiz dual-write üretim doğrulaması ve tüm kademeli rollout aşamaları (%1 -> %10 -> %25 -> %50 -> %100) tamamlanana kadar Supabase üzerinde hiçbir `DROP`, `DELETE` veya `TRUNCATE` işlemi uygulanmayacaktır.

---

## 8. P1.4 Kademeli Rollout, Güvenlik Kapıları & Gerçek %1 Taxonomy Doğrulaması (2026-09-18)

> **Mevcut Durum Özeti:**
> - **P1.3c Sıfır Maliyetli Mimari:** ✅ **PASS** (Mac Mini loopback + Cloudflare Named Tunnel `ch.verimimari.com` + Access Service Auth + Private GitHub Releases)
> - **P1.4 Güvenlik Kapıları:** ✅ **4/4 KESİN PASS** (Kapı 1 gerçek off-host anahtar doğrulaması ile kapatıldı)
> - **P1.4 Micro Canary:** ✅ **PASS** (5 kategori, 98 ürün, 14/14 mutabakat PASS)
> - **P1.4 Stage 1 — Gerçek %1 Rollout:** ✅ **TAMAMLANDI — 24–72 SAAT İZLEMEDE** (40 yaprak kategori, 604 ürün, 14/14 mutabakat PASS)
> - **Stage 2 — %10 Scope:** ⛔ **KESİNLİKLE DONDURULDU (FROZEN)** (24–72 saatlik gözlem ve gerçek büyüme ölçümü bekleniyor)

### 1. Dört Ön Güvenlik Kapısı Kesin Doğrulama Dökümü

| Kapı No | Güvenlik Kapısı | Doğrulama Yöntemi & Bulgular | Durum |
| :---: | :--- | :--- | :---: |
| **Kapı 1** | **Gerçek Off-Host Yedekleme Anahtarı** | • Dahili SSD yolları (`~/.config/...`, `/Users/...`) **kesin olarak reddedildi** (Donanım arızasında SSD ile birlikte yok olmaması için).<br>• İki bağımsız fiziksel/hesap bağımsız lokasyon doğrulandı ([verify_offhost_backup_key.cjs](file:///Users/canerramazanunal/Documents/Trendyol/scripts/verify_offhost_backup_key.cjs)):<br>  1. **Fiziksel Harici Depolama:** `/Volumes/TWINMOS/verimimari_keys/backup_recovery.key`<br>  2. **Apple iCloud Keychain HSM:** `verimimari-backup-key` (Hesap: `canerramazanunal`)<br>• SHA-256 anahtar parmak izi eşleşti (`fda0d5f4f48963f1`). Chat, log ve Git'e sıfır secret sızdırıldı. | **KESİN PASS** |
| **Kapı 2** | **Vercel Serverless Function & Cloudflare Access Service Auth** | • `verimimari-metrics/src/lib/clickhouse.ts` istemcisi ve `/api/analytics/clickhouse` rotası kuruldu ([verify_vercel_access_route.cjs](file:///Users/canerramazanunal/Documents/Trendyol/scripts/verify_vercel_access_route.cjs)):<br>  - Service Token + Reader SELECT $\rightarrow$ **HTTP 200 PASS**<br>  - Cloudflare Access tokensız istek $\rightarrow$ **HTTP 403 DENIED**<br>  - Reader ile INSERT denemesi $\rightarrow$ **HTTP 403 ACCESS_DENIED**<br>  - Timeout (5000ms), satır limiti (1000) ve salt-okunur doğrulama guardrail'leri devrede. | **PASS** |
| **Kapı 3** | **Cloudflare Service Token Süre Takibi** | • `CF_ACCESS_TOKEN_EXPIRES_AT` izleme mekanizması panelle entegre edildi.<br>• Bitişe <30 gün kaldığında otomatik `WARNING` alarmı ve bildirim üretme kuralı aktif (Kalan: 365 gün). | **PASS** |
| **Kapı 4** | **Dinamik Disk Büyüme Kalibrasyonu** | • [disk_growth_monitor.cjs](file:///Users/canerramazanunal/Documents/Trendyol/scripts/lib/disk_growth_monitor.cjs) ile statik canary varsayımı yerine 24–72 saatlik gerçek $\Delta \text{GB}/\text{gün}$ izleme motoru bağlandı.<br>• 35.12 GB boş disk üzerinden taban projeksiyonu: ~351 gün. | **PASS** |

---

### 2. P1.4 Micro Canary vs. Gerçek Stage 1 (%1) Kapsam Karşılaştırması

| Metrik | P1.4 Micro Canary (Önceki Koşu) | P1.4 Stage 1 Gerçek %1 Rollout (Mevcut Koşu) |
| :--- | :--- | :--- |
| **Rol / Tanım** | Ön doğrulama / Pipeline duman testi | **Gerçek %1 Taxonomy Kapsamı (24–72h baseline)** |
| **Kategori Sayısı** | 5 kategori | **40 kategori** (3.515 yaprak kategoriden her 87. yaprak) |
| **Root Kapsamı** | Yalnız 3-4 departman | **15 root departmanın tamamı** (Giyim, Elektronik, Süpermarket vb.) |
| **Sıralama Kaydı** | 98 sıralama | **604 sıralama** |
| **Tekil Ürün Sayısı** | 98 ürün | **604 benzersiz ürün** |
| **Dual-Sink İletim Hızı** | 518.5 satır/sn (0.19s) | **867.8 satır/sn (0.70s)** |
| **MergeTree Tekilleştirme** | `count = 98`, `uniqExact = 98`, `dup = 0` | **`count = 604`, `uniqExact = 604`, `dup = 0`** |
| **14-Metrik Mutabakatı** | 14/14 PASS | **14/14 PASS** |
| **Şifreli Off-Site Snapshot** | 535 satır restore verified | **1042 satır restore verified** (Checksum MATCH PASS) |
| **GitHub Release** | [v-verimimari-backup-2026-09-17T23-06-05-549Z](https://github.com/canerrunal/verimimari-backups/releases/tag/v-verimimari-backup-2026-09-17T23-06-05-549Z) | [v-verimimari-backup-2026-09-17T23-06-51-411Z](https://github.com/canerrunal/verimimari-backups/releases/tag/v-verimimari-backup-2026-09-17T23-06-51-411Z) |

---

### 3. Gerçek Stage 1 Taranan 40 Kategorinin Tam Envanteri

| No | Category ID | Kategori Adı | Taksonomi Yolu (Path) |
| :---: | :---: | :--- | :--- |
| 1 | `171453` | Kristal Set | Aksesuar > Aksesuar Set > Kristal Set |
| 2 | `103546` | Bijuteri Kolye | Aksesuar > Takı & Mücevher > Kolye > Bijuteri Kolye |
| 3 | `144052` | Kaydırak | Anne & Bebek & Çocuk > Oyuncak > Bahçe & Dış Mekan Oyuncakları > Kaydırak |
| 4 | `101431` | Stiletto | Ayakkabı > Topuklu Ayakkabı > Stiletto |
| 5 | `105742` | Misina | Bahçe & Yapı Market > Bahçe & Elektrikli El Aletleri > Bahçe Ürünleri > Misina |
| 6 | `109224` | El Kurutma Makinesi | Bahçe & Yapı Market > Banyo Yapı & Hırdavat > El Kurutma Makinesi |
| 7 | `109267` | İş Güvenliği Maske | Bahçe & Yapı Market > Hırdavat Ürünleri > İş Güvenliği Maske |
| 8 | `103625` | Çamaşır Makinesi | Elektronik > Beyaz Eşya > Çamaşır Makinesi |
| 9 | `103666` | Laptop Soğutucu | Elektronik > Bilgisayar&Tablet > Laptop Soğutucu |
| 10 | `144646` | Elektrikli Ev Aletleri Aksesuar | Elektronik > Elektrikli Ev Aletleri > Elektrikli Ev Aletleri Aksesuar |
| 11 | `146094` | Boyun Bantlı Bluetooth kulaklık | Elektronik > Kulaklık > Bluetooth Kulaklık > Boyun Bantlı |
| 12 | `144149` | Çocuk Odası Aydınlatma | Ev ve Mobilya > Aydınlatma > Bebek&Çocuk Aydınlatma > Çocuk Odası Aydınlatma |
| 13 | `102770` | Çift Kişilik Nevresim Takımı | Ev ve Mobilya > Ev Tekstili > Nevresim Takımı > Çift Kişilik |
| 14 | `104516` | Mutfak Sandalyesi | Ev ve Mobilya > Mobilya > Mutfak Mobilyası > Mutfak Sandalyesi |
| 15 | `104177` | Sebzelik | Ev ve Mobilya > Sofra&Mutfak > Saklama&Düzenleme > Sebzelik |
| 16 | `55` | Abiye Elbise | Giyim > Abiye Elbise |
| 17 | `109051` | Fantezi Sütyen | Giyim > İç Giyim > Fantezi Giyim > Fantezi Sütyen |
| 18 | `104151` | Astronot Tulum | Giyim > Tulum&Salopet > Astronot Tulum |
| 19 | `109704` | Fermuar | Hobi > Hobi Malzemeleri > Fermuar |
| 20 | `109408` | Kontrabas | Hobi > Müzik > Müzik Aletleri > Yaylı Çalgılar > Kontrabas |
| 21 | `110835` | RC Ekipman | Hobi > Uzaktan Kumandalı Araçlar > RC Araçlar > RC Ekipman |
| 22 | `144507` | Termal Rulo | Kırtasiye & Ofis Malzemeleri > Kırtasiye Kağıt Ürünleri > Termal Rulo |
| 23 | `104293` | Bilim & Teknik & Mühendislik | Kitap > Hobi ve Sanat Kitapları > Akademik > Bilim & Teknik |
| 24 | `104072` | Pamuk & Disk | Kozmetik & Kişisel Bakım > Bakım Aksesuarları > Pamuk & Disk |
| 25 | `108823` | BB & CC Krem | Kozmetik & Kişisel Bakım > Makyaj > Ten Makyajı > BB & CC Krem |
| 26 | `144324` | Motorcu Montu | Otomobil & Motosiklet > Motosiklet > Motosiklet Giyim > Motorcu Montu |
| 27 | `103880` | Buğu Giderici | Otomobil & Motosiklet > Oto Aksesuarları > Kış Ürünleri > Buğu Giderici |
| 28 | `110630` | Oto Lambaları | Otomobil & Motosiklet > Otomobil Yedek Parça > Elektrik > Oto Lambaları |
| 29 | `110703` | Oto Termostat | Otomobil & Motosiklet > Otomobil Yedek Parça > Mekanik > Oto Termostat |
| 30 | `142651` | Fotoğraf | Sanat Eseri > Fotoğraf |
| 31 | `187555` | Termos Aksesuarı | Spor&Outdoor > Outdoor > Outdoor Ekipmanları > Termos Aksesuarı |
| 32 | `109385` | Dart Matı | Spor&Outdoor > Spor Aletleri > Branş Sporları > Dart > Dart Matı |
| 33 | `145811` | Atlama İpi | Spor&Outdoor > Spor Aletleri > Fitness ve Kondisyon > Atlama İpi |
| 34 | `145888` | Spor Bileklik | Spor&Outdoor > Spor Aletleri > Sporcu Aksesuarları > Spor Bileklik |
| 35 | `103769` | Bebek Krem & Yağlar | Süpermarket > Anne Bebek > Bebek Bakım ve Kozmetik > Bebek Krem & Yağlar |
| 36 | `103937` | Çöp Torbası | Süpermarket > Deterjan ve Temizlik > Mutfak Sarf Malzemeleri > Çöp Torbası |
| 37 | `144217` | Fonksiyonel İçecek | Süpermarket > Gıda ve İçecek > Gazsız İçecek > Fonksiyonel İçecek |
| 38 | `145387` | Jelatin | Süpermarket > Gıda ve İçecek > Kuru Gıda > Tatlı Yapım > Jelatin |
| 39 | `103585` | Akvaryum Testleri | Süpermarket > Pet Shop > Akvaryum Ürünleri > Akvaryum Testleri |
| 40 | `146011` | Dildo | Süpermarket > Sağlık > Cinsel Sağlık > Cinsel Oyuncak > Dildo |

---

### 4. 24–72 Saatlik Gözlem Denetim Motoru & Metrik Ayrıştırması

[stage_1_daily_monitor.cjs](file:///Users/canerramazanunal/Documents/Trendyol/scripts/stage_1_daily_monitor.cjs) aracı `--audit` parametresiyle çağrıldığında gözlem dönemi boyunca biriken veriyi şu temel ilkeler doğrultusunda denetler:

1. **ClickHouse Depolama Büyümesi (Authoritative Ölçüm):**
   - `system.parts` tablosunda yalnız `active = 1` parçaları (`bytes_on_disk`) üzerinden authoritative (bağlayıcı/resmi) olarak ölçülür.
   - Formül: $\text{clickhouse\_growth\_gb\_day} = \frac{\Delta \text{bytes} / 1024^3}{\text{elapsed\_hours} / 24}$. Yalnız ClickHouse depolama kapasitesi metriğidir.
2. **Host Boş Disk Tüketimi (Kapasite & Erken Uyarı Guardrail - Decoupled):**
   - Ana makine boş disk alanı (`free_disk_gb`) ClickHouse büyümesiyle karıştırılmaz; işletim sistemi ve browser önbelleklerinden etkilendiği için ayrı bir host metriği olarak hesaplanır:
     $$\text{host\_disk\_consumption\_gb\_day} = \frac{\text{start\_free\_gb} - \text{end\_free\_gb}}{\text{elapsed\_days}}$$
   - Ayrı erken uyarı eşikleri:
     - `days_to_10gb_warning`: Boş diskin 10 GB güvenlik eşiğine inmesine kalan tahmini gün sayısı.
     - `days_to_5gb_critical`: Boş diskin 5 GB kritik eşiğine inmesine kalan tahmini gün sayısı.
   - **Provisional (Geçici) Durum:** İlk 24 saat dolmadan host trendi kesin kapasite tahmini olarak kabul edilmez; raporda açıkça `PROVISIONAL` olarak işaretlenir.
3. **Delta-Based Monitored Paths Analizi (Kök Neden Tespiti):**
   - Statik klasör boyutları asla "kesinleşmiş neden" (confirmed cause) olarak kabul edilmez.
   - Analiz her izlenen yol için $\Delta \text{bytes} = \text{end\_bytes} - \text{start\_bytes}$ delta ölçümüyle yürütülür:
     - **ClickHouse Aktif Veri Boyutu (`system.parts active=1`):** Başlangıç: 67.0 KB $\rightarrow$ Bitiş: 127.6 KB ($\Delta = \mathbf{+60.58\text{ KB}}$).
     - **ClickHouse Sunucu Logları (`.runtime/clickhouse_prod`):** Başlangıç: 320.0 MB $\rightarrow$ Bitiş: 1338.8 MB ($\Delta = \mathbf{+1018.8\text{ MB}}$).
     - **Kategori Tarayıcı Çıktıları (`categories/`):** Başlangıç: 1248.0 MB $\rightarrow$ Bitiş: 1571.8 MB ($\Delta = \mathbf{+323.8\text{ MB}}$).
     - **Cron Logları (`.runtime/cron-logs`):** Başlangıç: 5.83 MB $\rightarrow$ Bitiş: 5.91 MB ($\Delta = \mathbf{+84.0\text{ KB}}$).
     - **GitHub Backup Staging (`.runtime/backup_staging`):** Başlangıç: 216 KB $\rightarrow$ Bitiş: 508 KB ($\Delta = \mathbf{+292.0\text{ KB}}$).
     - **İzlenmeyen Dış Önbellekler:** `/private/var/folders` ve `~/Library/Caches` gibi geçici işletim sistemi ve Chrome önbellekleri APFS dinamik purge mekanizmasına tabidir; statik boyutları confirmed cause sayılmaz.
   - **Politika:** **STRICT_READ_ONLY — Hiçbir dosya otomatik olarak silinmez.**
4. **Read-Only ClickHouse Ölçek (Scale) Metrikleri:**
   - `active_parts_count`: 1
   - `max_parts_per_partition`: 1
   - `merges_running`: 0
   - `insert_batch_rows_p50`: 25 rows
   - `insert_batch_rows_p95`: 334 rows
   - `inserts_per_hour`: 5.64 batches/hr
5. **Koşu Sayısı ve Mutabakat Kapsamı Ayrımı (100% PASS Şartı):**
   - Tüm geçmiş/test koşuları (`total_runs`) ile gerçek Stage 1 kapsamındaki (%1 taksonomi) canlı koşular (`eligible_stage1_runs`) ayrıştırılmıştır.
   - Stage 2 açılış şartı: `reconciled_runs == eligible_stage1_runs` ve `reconciliation_pass_rate == 100.0%` olmalıdır.
6. **Outbox Gözlem Penceresi Zirve Metrikleri:**
   - Yalnızca anlık değer değil, gözlem penceresi boyunca `peak_pending_batches` ve `max_oldest_spool_age_sec` raporlanır (Her ikisi de 0 / sağlıklı).
7. **Yedekleme & Restore Test Tazelik (Freshness) Kapısı:**
   - `backup_age_hours <= 24.0`
   - `restore_test_age_hours <= 24.0`
   - Restore testi son yayınlanan yedek ID (`latest_backup_id`) ile birebir aynı snapshot üzerinde doğrulanmış olmalıdır.
8. **Mükerrerlik Doğrulama Terminolojisi:**
   - `duplicate_observation_count == 0` durumu için mutlak iddialar yerine **"current validation PASS (0 Duplicates)"** ifadesi kullanılır.
9. **Stage 2 İlerleme Kapısı ve Hard Gates Önceliği:**
   - Stage 2 (%10) **FROZEN** durumdadır.
   - **Hard Gates Kuralı:** Stage 2 hard gate kriterleri PASS olmadan human approval bile rollout başlatamaz. Human approval gereklidir fakat başarısız bir hard gate'i asla override edemez.
   - 24 saatlik asgari gözlem süresi dolana kadar yalnız read-only ölçüm yapılır; crawler/storage davranışı değiştirilmez.

4. **Cloudflare Tunnel Çok Faktörlü Read-Only Sağlık Teşhisi:**
   - `tunnel_status = not_configured` durumu çok faktörlü read-only ölçüm ile ayrıştırılmıştır:
     - `cloudflared process alive?`: İşletim sistemi seviyesinde süreç durumu (`pgrep -x cloudflared`) kontrol edilir (Şu an: **NO / Process Down**).
     - `named tunnel connected?`: Yerel metriks uç noktası (`127.0.0.1:20241/metrics`) üzerinden tünel bağlantı durumu taranır (Şu an: **NO**).
     - `ch.verimimari.com Access protected SELECT reachable?`: Cloudflare Access Service Token ile korunan SELECT sorgusu test edilir (Şu an: **UNREACHABLE**).
     - `MONITOR_CONFIG_MISSING` Ayrımı: Gözlem ve test ortamında `CF_ACCESS_CLIENT_ID` veya `CF_ACCESS_CLIENT_SECRET` tanımlı değilse bu durum `unknown` veya `healthy` sayılmaz; açıkça **`MONITOR_CONFIG_MISSING`** olarak etiketlenir.
     - **Hard Gate Kuralı:** `not_configured`, `unknown`, `unreachable` veya `MONITOR_CONFIG_MISSING` hiçbir durumda `healthy` sayılmaz (`is_healthy = false`).
     - Stage 2'ye geçişte `tunnel_status == HEALTHY` zorunludur; `not_configured` veya `unknown` insan onayı (human approval) ile dahi **OVERRIDE EDİLEMEZ**.

5. **`.runtime/clickhouse_prod` Alt Dizin Bazında Delta Parçalama (+~1 GB Büyüme Analizi):**
   - ClickHouse sunucusunun ~1.3 GB'lık disk izi alt dizin seviyesinde incelenmiştir:
     - `usr/local/bin`: **850.29 MB** ($\Delta \approx 0$ B/saat). Statik ClickHouse 26.8 LTS binary dosyasıdır (sabit dosya).
     - `var/lib/clickhouse/store`: **357.46 MB** ($\Delta \approx \mathbf{+40.67\text{ MB/saat}}$). ClickHouse dahili sistem log tabloları (`system.text_log`, `system.trace_log`, `system.asynchronous_metric_log`, `system.part_log`) ve `verimimari_prod` tablolarını barındırır.
     - `var/log/clickhouse-server`: **128.39 MB** ($\Delta \approx \mathbf{+15.43\text{ MB/saat}}$). ClickHouse sunucu metin loglarıdır.
     - `var/lib/clickhouse/data`: **0 B** (ClickHouse Atomic veritabanı motoru tüm veriyi `store/` altında tutar).
     - `var/lib/clickhouse/tmp`: **0 B** (Geçici işlem dosyası bulunmamaktadır).
     - `var/lib/clickhouse/metadata`: **16 KB** (DDL şema tanımları).
     - `var/lib/clickhouse/preprocessed_configs`: **112 KB** (İşlenmiş XML konfigürasyonları).
     - `var/lib/clickhouse/access`: **48 KB** (Kullanıcı ve RBAC erişim tanımları).
   - **Önemli Sonuç:** `verimimari_prod.product_observations` tablosundaki gerçek kullanıcı verisi yalnızca **127.6 KB** iken, büyümenin %99'u ClickHouse dahili sistem logları (`system.*_log`) ve sunucu text loglarından (`clickhouse-server.log`) kaynaklanmaktadır.

6. **ClickHouse Server Log Dosyaları Büyüme Hızı Sıralaması (Read-Only):**
   1. `clickhouse-server.log`: **119.45 MB** — Büyüme Hızı: **~14.36 MB/saat** (15.054.213 B/saat)
   2. `clickhouse-server.err.log`: **327.52 KB** — Büyüme Hızı: **~0.038 MB/saat** (40.310 B/saat)
   3. `stderr.log`: **0.53 KB** — Büyüme Hızı: **< 0.001 MB/saat**
   4. `stdout.log`: **0.00 B**
   - **Politika:** **STRICT_READ_ONLY — 24 saatlik gözlem dolana kadar henüz log rotation veya silme uygulanmaz.**

7. **`categories/` Dizini Delta ve Rewrite Davranış Analizi:**
   - Stage 1 başlangıcından bu yana üretilen yeni/güncellenen dosya: **156 dosya (+273.64 MB)**
   - Büyüme Hızı: **~32.89 MB/saat**
   - Dosya Tipi Dağılımı:
     - `latest.json`: 12 dosya
     - `latest.csv`: 6 dosya
     - `history.csv`: 6 dosya
     - `snapshot.json`: 23 dosya
     - `reports.md`: 54 dosya
     - Diğer / alt yapraklar: 55 dosya
   - **Rewrite Davranışı Tespiti:** **REPEATED_FULL_FILE_REWRITE.** Saatlik profil toplayıcıları (`elektronik`: 61.3 MB / 31 dosya, `kozmetik`: 47.92 MB / 25 dosya, `otomobil-motosiklet`: 42.46 MB / 25 dosya, `hobi`: 41.46 MB, `mobilya`: 40.72 MB, `hamile`: 39.78 MB) her koşuda append yerine tam dosya (full snapshot/history) üretmektedir.
   - **Politika:** **STRICT_READ_ONLY — 24 saatlik gözlem tamamlanana kadar crawler dosya yazma davranışına dokunulmaz.**

8. **Host Disk Kapasite Projeksiyonu ve Stage 2 Hard Gate:**
   - Host disk projeksiyonu 24 saatlik gözlem süresi tamamlanana kadar **PROVISIONAL** tutulur.
   - **Stage 2 Hard Gate Şartı:** $\text{days\_to\_10gb\_warning} \ge 60$ koşulu, 24+ saatlik gerçek ampirik baseline üzerinden hesaplanmadan kesinlikle PASS sayılamaz.
   - 24 saat dolana kadar hiçbir auto-cleanup, log rotation, cache purge veya crawler output optimizasyonu uygulanmaz.
   - Supabase history tabloları dokunulmazdır (0 DROP, 0 DELETE, 0 TRUNCATE, 0 INDEX DROP).

```
=============================================================================
  VERIMIMARI PLATFORM V2 — P1.4 STAGE 1 RESMİ GÖZLEM RAPORU
=============================================================================
✓ Gözlem Başlangıcı:               2026-09-17T22:58:29.108Z
✓ Son Değerlendirme:               2026-09-18T07:44:35.000Z
✓ Geçen Gözlem Süresi:             8.32 saat (0.3467 gün)
✓ 24-72h Asgari Süre Tamamlandı mı: HAYIR (Gözlem Devam Ediyor)
-----------------------------------------------------------------------------
1. AUTHORITATIVE CLICKHOUSE DEPOLAMA BÜYÜMESİ (system.parts active = 1):
   • Başlangıç Boyutu (start_bytes):   66.97 KB (68581 bytes)
   • Bitiş Boyutu (end_bytes):         127.55 KB (130616 bytes)
   • Gerçek Delta (delta_bytes):       +0.0592 MB (62035 bytes)
   • Ölçüm Kaynağı:                    system.parts / bytes_on_disk (active = 1, Authoritative)
2. GERÇEK GÜNLÜK CLICKHOUSE BÜYÜME HIZI (clickhouse_growth_gb_day = delta / elapsed):
   • clickhouse_growth_gb_day:         +0.000167 GB/gün
   • Hesaplama Modu:                   IN_PROGRESS_OBSERVATION (8.32h elapsed)
   • Formül:                           clickhouse_growth_gb_day = (delta_bytes / 1024^3) / (elapsed_hours / 24)
3. READ-ONLY CLICKHOUSE SCALE METRİKLERİ:
   • active_parts_count:               1
   • max_parts_per_partition:          1
   • merges_running:                   0
   • insert_batch_rows_p50:            25 rows
   • insert_batch_rows_p95:            334 rows
   • inserts_per_hour:                 5.64 batches/hr
4. .RUNTIME/CLICKHOUSE_PROD ALT DİZİN BAZINDA DELTA PARÇALAMA:
   • [+128.39 MB] Server Logs (clickhouse-server) (var/log/clickhouse-server)
     - Start: 0.5 KB | End: 131468.0 KB | Hız: 15.431 MB/saat (16180612 B/saat)
   • [+338.39 MB] MergeTree Tables (Data & System Logs) (var/lib/clickhouse/store)
     - Start: 19531.3 KB | End: 366040.0 KB | Hız: 40.672 MB/saat (42647231 B/saat)
   • [  +0.00 MB] Legacy Data Symlinks (data) (var/lib/clickhouse/data)
     - Start: 0.0 KB | End: 0.0 KB | Hız: 0 MB/saat (0 B/saat)
   • [  +0.02 MB] Schema Metadata (metadata) (var/lib/clickhouse/metadata)
     - Start: 0.3 KB | End: 16.0 KB | Hız: 0.002 MB/saat (1935 B/saat)
   • [  +0.00 MB] Temporary Processing (tmp) (var/lib/clickhouse/tmp)
     - Start: 0.0 KB | End: 0.0 KB | Hız: 0 MB/saat (0 B/saat)
   • [  +0.00 MB] User Files (user_files) (var/lib/clickhouse/user_files)
     - Start: 0.0 KB | End: 0.0 KB | Hız: 0 MB/saat (0 B/saat)
   • [  +0.00 MB] Preprocessed Configs (var/lib/clickhouse/preprocessed_configs)
     - Start: 112.0 KB | End: 112.0 KB | Hız: 0 MB/saat (0 B/saat)
   • [  +0.00 MB] Access Control (var/lib/clickhouse/access)
     - Start: 48.0 KB | End: 48.0 KB | Hız: 0 MB/saat (0 B/saat)
   • [  +0.00 MB] Server Static Binary (usr/local/bin) (usr/local/bin)
     - Start: 870694.9 KB | End: 870696.0 KB | Hız: 0 MB/saat (141 B/saat)
5. CLICKHOUSE SERVER LOG DOSYALARI BÜYÜME HIZI SIRALAMASI:
   1. clickhouse-server.log      Boyut: 119.45 MB | Hız: 14.357 MB/saat (15054213 B/saat)
   2. clickhouse-server.err.log  Boyut: 327.52 KB | Hız: 0.038 MB/saat (40310 B/saat)
   3. stderr.log                 Boyut:   0.53 KB | Hız: 0 MB/saat (65 B/saat)
   4. stdout.log                 Boyut:   0.00 KB | Hız: 0 MB/saat (0 B/saat)
   • İnceleme Statüsü:                 STRICT_READ_ONLY (Henüz log rotation veya dosya silme uygulanmaz)
6. CATEGORIES/ DİZİNİ DELTA VE REWRITE ANALİZİ:
   • Stage 1 Yeni/Güncellenen Dosya:   156 dosya (+273.64 MB)
   • Büyüme Hızı:                      32.89 MB/saat
   • Dosya Tipi Dağılımı:              latest.json: 12, latest.csv: 6, history.csv: 6, snapshot.json: 23, reports.md: 54
   • Rewrite Davranışı:                REPEATED_FULL_FILE_REWRITE (Saatlik profil toplayıcıları her koşuda append yerine tam dosya üretmektedir)
   • Top Rewrite Kategorileri:         elektronik (61.3 MB, 31 dosya), kozmetik (47.92 MB, 25 dosya), otomobil-motosiklet (42.46 MB, 25 dosya), hobi (41.46 MB, 25 dosya), mobilya (40.72 MB, 25 dosya), hamile (39.78 MB, 25 dosya)
   • Politika:                         STRICT_READ_ONLY (Crawler davranışına 24 saat dolana kadar müdahale edilmez)
7. HOST BOŞ DİSK (FREE-DISK) TÜKETİMİ VE ERKEN UYARI KORUMASI (DECOUPLED):
   • Güncel Boş Alan:                  33.33 GB
   • Başlangıç Boş Alan:               35.14 GB
   • Boş Alan Değişimi:                1.81 GB
   • Host Tüketim Hızı:                5.2237 GB/gün
   • 10 GB Uyarı Eşiğine Kalan Gün:    ~4 gün (days_to_10gb_warning)
   • 5 GB Kritik Eşiğine Kalan Gün:    ~5 gün (days_to_5gb_critical)
   • Projeksiyon Güvenirlik Durumu:    PROVISIONAL (< 24h baseline; 8.32h elapsed)
   • Host Disk Güvenlik Statüsü:       SAFE (Min > 10.0 GB SAFE)
   • Rolü:                             Host Capacity / Early Warning Guardrail Only (Decoupled from ClickHouse Growth)
8. DELTA-BASED MONITORED PATHS DİSK TÜKETİM ANALİZİ:
   • [ +60.58 KB] ClickHouse verimimari_prod (Active User Data)
     - Yol: system.parts (verimimari_prod, active=1) | Start: 67.0 KB -> End: 127.6 KB
   • [+1016.46 MB] ClickHouse Server Logs & Internal State
     - Yol: .runtime/clickhouse_prod | Start: 327680.0 KB -> End: 1368532.0 KB
   • [+323.80 MB] Category Crawler Outputs (Dual-write local JSON/CSV)
     - Yol: categories/ | Start: 1277952.0 KB -> End: 1609524.0 KB
   • [ +84.00 KB] Application Cron Logs
     - Yol: .runtime/cron-logs | Start: 5968.0 KB -> End: 6052.0 KB
   • [+292.00 KB] GitHub Backup Staging
     - Yol: .runtime/backup_staging | Start: 216.0 KB -> End: 508.0 KB
   • Not: Unmonitored external OS caches (/private/var/folders, ~/Library/Caches) are subject to APFS dynamic purging. Total static folder sizes are strictly NOT reported as confirmed causes.
9. KOŞU SAYILARI VE RECONCILIATION KAPSAMI (100% PASS KURALI):
   • Toplam Koşular (total_runs):      7 (Tüm geçmiş ve test koşuları)
   • Gerçek Stage 1 (eligible_runs):   2 (>= 36 yaprak kategori canlı rollout)
   • Mutabakatı Biten (reconciled):    2
   • Mutabakat Başarı Oranı:           100.0% (2/2 eligible runs PASS, 14/14 metrics)
   • Stage 2 Şartı (reconciled==eligible && pass==100%): PASS
10. OUTBOX GÖZLEM PENCERESİ BACKLOG VE SPOOL METRİKLERİ:
   • Güncel Pending Batches:           0 batches
   • Peak Pending Batches (Zirve):     0 batches
   • Güncel Oldest Spool Age:          0s
   • Max Oldest Spool Age (Zirve):     0s
   • Durum:                            PASS (0 Peak Backlog)
11. CLOUDFLARE TUNNEL ÇOK FAKTÖRLÜ TEŞHİS:
   • Toplam Reconnect:                 0
   • Tünel Statüsü (tunnel_status):    MONITOR_CONFIG_MISSING
   • Sağlık Durumu (is_healthy):       UNHEALTHY (Hard Gate BLOCKED)
   • cloudflared Process Alive:        NO (Process Down)
   • Named Tunnel Connected:          NO
   • Access Protected SELECT:          UNREACHABLE
   • Monitor Env Konfigürasyonu:       MONITOR_CONFIG_MISSING
   • Teşhis Detayı:                    NOT_CHECKED (MONITOR_CONFIG_MISSING)
12. YEDEKLEME + RESTORE-TEST FRESHNESS DURUMU:
   • Son Yedek ID:                     verimimari-backup-2026-09-17T23-06-51-411Z
   • Backup Age:                       8.63 saat (Limit: <= 24h)
   • Backup Status:                    PASS
   • Restore-Test Age:                 8.63 saat (Limit: <= 24h)
   • Restore Test Snapshot Eşleşmesi:  MATCH (Aynı Snapshot)
   • Restore-Test Status:              PASS (Checksum MATCH)
   • Tazelik (Freshness) Durumu:       PASS
13. MÜKERRER KAYIT (DUPLICATE) DOĞRULAMASI:
   • Duplicate Observations:           0
   • Doğrulama Durumu:                 current validation PASS (0 Duplicates)
-----------------------------------------------------------------------------
RESMİ DR STANDARDI:                    RPO <= 24h, RTO <= 2h; son doğrulanmış snapshot'a kadar geri yükleme garanti edilir.
SUPABASE DOKUNULMAZLIK:                PASS (0 DROP, 0 DELETE, 0 TRUNCATE, 0 INDEX DROP)
STAGE 2 (%10) İLERLEME KAPISI:         FROZEN
HUMAN APPROVAL POLİTİKASI:             BLOCKED (Hard gates not yet met; observation window < 24h)
GEREKÇE / KARAR:                       24-72 saatlik asgari gözlem süreci devam ediyor (Geçen: 8.32 sa / 24 sa zorunlu). Host trendi PROVISIONAL; hard gate tamamlanmadan human approval rollout başlatamaz.
=============================================================================
```

---

### 5. Tek Makine Arıza Alanı (Single Failure Domain) Analizi & RTO / RPO Taahhüdü

Bu mimaride ClickHouse artık bir risk değildir; ancak Mac Mini'nin **tek hata alanı (single failure domain)** olması operasyonel süreklilik sınırını belirler:

```
[ARIZA SENARYOSU]
Mac Mini Kapanır / SSD Ölür
        │
        ├──► Collector durur
        ├──► ClickHouse durur
        ├──► cloudfla## 9. P1.4 Canlı Metrik Motoru Sertleştirmesi, Host Disk Kalıcılığı & Kapasite Güvenliği (2026-09-18)

> **Mevcut Durum Özeti:**
> - **Stage 1 Gözlemi:** 24 saatlik baseline devam ediyor (yaklaşık 14.8 / 24 saat tamamlandı).
> - **Stage 2:** ⛔ **KESİNLİKLE DONDURULMUŞTUR (FROZEN)**. 24 saatlik ilk baseline + Storage Hygiene uygulaması + 24 saatlik post-fix baseline tamamlanmadan açılamaz.
> - **Kapasite Güvenliği (Safety Override):** Boş disk $\le 15$ GB veya pist $< 2$ gün veya hızlanan trend durumunda nonessential crawler'lar anında güvenle duraklatılır (`ZERO_AUTOMATED_DELETION` / `NO_DESTRUCTIVE_DELETE`).
> - **Fiziksel Veri Güvenliği Standardı:** Resmi DR standardımız **RPO $\le 24$h, RTO $\le 2$h** olup hiçbir otomatik yıkıcı silme (`NO_DESTRUCTIVE_DELETE`) yapılmaz.
> - **Supabase Dokunulmazlığı:** 0 DROP, 0 DELETE, 0 TRUNCATE, 0 INDEX DROP ile tam korunmaktadır.

### 1. Host Disk Tüketim Metriği ve Kalıcı Durum (Persistence Engine)

Önceki süreçlerde process restart veya son iki anlık snapshot nedeniyle host tüketim hızının sıfıra resetlenmesi problemi kalıcı state mimarisiyle giderilmiştir.
Tüm serbest disk ölçümleri aynı APFS volume/mount (`/System/Volumes/Data`) üzerinde, aynı metotla (`fs.statfsSync(ROOT).bavail * statfsSync(ROOT).bsize`) alınmaktadır.

- **Kalıcı Durum Dosyası:** `.runtime/host_disk_consumption_state.json`
- **Kalıcı Durum Alanları:**
  - `baseline_start_timestamp`: İlk gözlem anı (`ISO-8601 UTC ...Z`)
  - `baseline_start_free_bytes`: Başlangıçtaki boş byte miktarı
  - `current_free_bytes`: Canlı boş byte miktarı
  - `baseline_net_consumption_gb_day`: Başlangıçtan bu yana net tüketim hızı
  - `rolling_3h_consumption_gb_day`: Son 3 saatlik kayan pencere tüketim hızı
  - `rolling_6h_consumption_gb_day`: Son 6 saatlik kayan pencere tüketim hızı
  - `sample_count`: Kaydedilen örnek sayısı
  - `effective_host_consumption_rate`: $\max(\text{pozitif baseline hızı}, \text{pozitif rolling 6h hızı})$
  - `volume_mount`: `/System/Volumes/Data` (APFS tutarlılık denetimi)
- **Belirsizlik Kuralı:** State eksikse veya resetlenmişse `host_disk_consumption_gb_day = UNKNOWN` üretilir; asla yapay 0 üretilmez.
- **Safety Karar Formülü:**
  $$\text{effective\_host\_consumption\_rate} = \max(\text{pozitif baseline hızı}, \text{pozitif rolling 6h hızı})$$
  $$\text{days\_to\_10gb\_warning} = \frac{\text{current\_free\_gb} - 10}{\text{effective\_host\_consumption\_rate}}$$
  Eğer $\text{days\_to\_10gb\_warning} < 2\text{ gün}$ ise 24 saatlik baseline beklenmeksizin derhal `CAPACITY_GUARDRAIL_TRIGGERED` ve `CAPACITY_PAUSE` devreye girer.

---

### 2. ClickHouse User-Data Büyüme Birim Hatasının Giderilmesi

Fiziksel ~169 KiB aktif kullanıcı verisi (`verimimari_prod`) varken raporlanan yapay $+0.1\text{ GB/gün}$ projeksiyon fallback'i tamamen kaldırılmıştır.

- **Tek Yetkili Kaynak (Authoritative Source):**
  ```sql
  SELECT sum(bytes_on_disk)
  FROM system.parts
  WHERE database = 'verimimari_prod' AND active = 1
  ```
- **Kesin Hesaplama Formülü:**
  $$\text{clickhouse\_user\_data\_growth\_gb\_day} = \frac{(\text{end\_bytes} - \text{start\_bytes}) / 1024^3}{\text{elapsed\_seconds} / 86400}$$
- **Raporlanan Ham Telemetri Değerleri:**
  - `start_bytes`: $68,581\text{ bytes}$
  - `end_bytes`: $222,515\text{ bytes}$
  - `delta_bytes`: $+153,934\text{ bytes}$ ($+150.33\text{ KB}$)
  - `elapsed_seconds`: $53,040\text{ saniye}$ (~$14.73\text{ saat}$)
  - `computed_gb_day`: $+0.000234\text{ GB/gün}$ (~$0.24\text{ MB/gün}$)

---

### 3. Fail-Safe Circuit Breaker (Metrik Belirsizliğinde Fail-Open Engeli)

Devre kesici, metrik belirsizliği durumlarında asla `NORMAL` üretmeyecek şekilde sertleştirilmiştir.
Aşağıdaki durumlardan biri oluşursa devre kesici en az **`CAPACITY_WARNING / METRIC_UNCERTAIN`** olarak işaretlenir:
1. `host_rate == 'UNKNOWN'`
2. `clock_state_invalid` (Saat sapması veya geleceğe ait zaman damgası)
3. `measurement_volume_changed` (APFS mount noktasının değişmesi)
4. `baseline_state_disappeared` (Kalıcı state kaydı eksik veya bozuk)

#### 4-Kademeli Devre Kesici Tablosu:
| Seviye | Koşul | Sistem Davranışı |
| :--- | :--- | :--- |
| **`CRITICAL`** | $\text{free\_disk} < 5\text{ GB}$ veya kritik veri bütünlüğü hatası (duplicate, outbox tıkanıklığı) | Aşama kilitli, acil müdahale |
| **`CAPACITY_PAUSE`** | Safety override aktif ($\text{free} \le 15\text{ GB}$, pist $< 2\text{ gün}$, veya 3 ardışık hızlanan tüketim) | Nonessential crawler'lar duraklatılır, taze yedek alınır, baseline güvenle iptal edilir |
| **`CAPACITY_WARNING / METRIC_UNCERTAIN`** | Metrik belirsizliği / state kaybı / saat sapması | Asla fail-open yapılmaz; belirsizlik uyarısı verilir |
| **`CAPACITY_WARNING`** | $\text{free} \le 20\text{ GB}$ veya pist $< 7\text{ gün}$ | Kapasite alarmı |
| **`NORMAL`** | $\text{free} > 20\text{ GB}$, pist $\ge 7\text{ gün}$, metrikler kesin biliniyor, 0 hata | Normal operasyon |

---

### 4. Test Süiti Envanteri & Regresyon Araştırması

Önceki 91 testten 68 teste düşme anomalisi detaylı araştırılmıştır:
- **Kök Neden:** Crawler duraklatma mekanizması (`crawler_pause_state.json`) aktif olduğunda, `scripts/collect.cjs` modülünün tepe seviyesinde `process.exit(0)` çağrısı bulunmaktaydı. `collect.contract.test.cjs`, `product_metrics.test.cjs` ve `taxonomy.test.cjs` testleri bu modülü `require` ettiğinde test koşucu process erken sonlanmakta ve 23 test sessizce discovery dışı kalmaktaydı.
- **Düzeltme:** Duraklatma kontrolü yalnız CLI çalıştırma bloğuna (`require.main === module`) taşınmıştır.
- **Kalıcı Regresyon Koruması:** `scripts/test_inventory.cjs` aracı oluşturulmuş ve `package.json` içindeki `npm test` scriptine entegre edilmiştir (`node scripts/test_inventory.cjs --ci && node --test ...`).
- **Güncel Envanter:** 11 test dosyası, **95/95 test PASS** ($\ge 91$ asgari sınır sağlanmaktadır).

---

### 5. Terminoloji, Katı UTC ve Canlı Tablo Envanteri

- **Sıfır Silme İlkesi:** Eski `0 Data Loss` yanıltıcı ifadesi, resmi DR standardımız (**RPO $\le 24$h, RTO $\le 2$h**) çerçevesinde **`ZERO_AUTOMATED_DELETION (NO_DESTRUCTIVE_DELETE)`** olarak güncellenmiştir.
- **Katı ISO-8601 UTC:** Tüm `last_insert_at` ve operasyonel zaman damgaları katı UTC `YYYY-MM-DDTHH:mm:ssZ` formatında üretilmektedir.

#### Canlı Üretim Tablo Envanteri & Aşama Sözleşmesi Durumu (Strict UTC)

| Tablo Adı (`table`) | Şema Varlığı | Aşama Beklentisi | Satır (`rows`) | Disk Boyutu | Parça | Son Yazma (`last_insert_at`) | Durum (`write_status`) |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `product_observations` | **PASS** | `REQUIRED_ACTIVE` | 1,042 | 127.55 KB | 1 | `2026-09-17T23:06:51Z` | **ACTIVE_HEALTHY** (PASS) |
| `category_rank_observations` | **PASS** | `PRODUCTION_EMPTY_PREFLIGHT_PRESENT` | 838 | 89.75 KB | 1 | `2026-09-18T15:36:33Z` | **PRODUCTION_EMPTY_PREFLIGHT_PRESENT** (PASS) |
| `profile_observations` | **PASS** | `EMPTY_ALLOWED_BY_STAGE` | 0 | 0.00 KB | 0 | `YOK (Henüz yazılmadı)` | **EMPTY_ALLOWED_BY_STAGE** (PASS) |
| `inventory_observations` | **PASS** | `EMPTY_ALLOWED_BY_STAGE` | 0 | 0.00 KB | 0 | `YOK (Henüz yazılmadı)` | **EMPTY_ALLOWED_BY_STAGE** (PASS) |

---

### 6. Stage 2 Kesin Açılış Şartları (Hard Gates Doğrulama Çizelgesi)

| No | Güvenlik / Sağlık Kapısı | Gerekli Kriter | Mevcut Canlı Değer | Çizelge Durumu |
| :---: | :--- | :--- | :--- | :---: |
| 1 | `tunnel_health` | Authenticated Uptime $\ge 99\%$, rolling window $\ge 24$h, SELECT 200, unauthenticated DENIED | Token bekleniyor (`MONITOR_CONFIG_MISSING`) | `[ ]` **WAITING/BLOCKED** |
| 2 | `eligible_reconciliation_pass_rate` | %100 eligible runs PASS (14/14 metrik) | 2/2 eligible run (%100) PASS | `[x]` **PASS** |
| 3 | `duplicate_current_validation` | Current validation PASS (0 mükerrerlik) | 0 duplicate | `[x]` **PASS** |
| 4 | `outbox_health` | Backlog 0, peak backlog 0, spool age normal | 0 pending, 0s age | `[x]` **PASS** |
| 5 | `backup_freshness` & `restore_freshness` | Live uncached: yaş $\le 24$h, aynı snapshot ID | Taze ve canlı doğrulanmış (Snapshot MATCH) | `[x]` **PASS** |
| 6 | `days_to_10gb_warning >= 60` | 24+ saatlik host disk trendine göre $\ge 60$ gün | 14.8h elapsed (PROVISIONAL) | `[ ]` **WAITING/BLOCKED (Baseline < 24h)** |
| 7a | `schema_health` | 4/4 beklenen üretim tablosu şemada mevcut | 4/4 Tablo Mevcut | `[x]` **PASS** |
| 7b | `parts_health` | Aktif parça $\le 50$, devam eden merge $= 0$ | Tablo başına $\le 3$ aktif parça, 0 merge | `[x]` **PASS** |
| 7c | `stage1_write_coverage` | Stage 1 sözleşmesi (`stage1_production_rank_rows == 0` EXPECTED) | Sözleşme sağlandı (Üretim rank satırı: 0) | `[x]` **PASS** |
| 7d | `stage_2_ranking_ready` | Dinamik 6 koşul (PASS, yaş $\le 24$h, post-hygiene, 9/9 rec, 0 dup, outbox 0) | `PRE_STORAGE_HYGIENE_PASS` (Post-Storage-Hygiene canary gerekli) | `[ ]` **WAITING/BLOCKED** |
| 8 | `post_fix_baseline` | Storage hygiene sonrası temiz baseline $\ge 24$h | İlk baseline aşamasında | `[ ]` **WAITING/BLOCKED** |
| 9 | `capacity_guardrail_safe` | free_disk > 15GB, days_to_10gb >= 2, hızlanan trend yok | Safe (Boş disk: 43.8 GB) | `[x]` **PASS** |
| 10 | `utc_clock_freshness` | Tüm operasyonel damgalar katı UTC ve clock skew yok | 0 clock skew | `[x]` **PASS** |
| 11 | **Human Approval** | Yalnızca 1–10 tüm hard gate'ler aynı anda PASS olduğunda geçerlidir | Dondurulmuş (`FROZEN`) | `[ ]` **BLOCKED** |

### 7. ClickHouse Zaman Penceresi Hizalaması & Çift Sensörlü Kapasite Emniyeti (Dual Capacity Guardrail)

Son denetim bulgularında tespit edilen iki teknik tutarsızlık giderilmiş ve üretim güvenliği sertleştirilmiştir:

#### A. ClickHouse User Data Büyüme Ölçümünün Atomik Zaman Hizalaması (Time-Window Alignment)
- **Kök Neden:** Önceki raw telemetride `start_bytes = 68,581` (baseline başlangıcı) kullanılırken `elapsed_seconds` yalnızca son snapshot aralığını (502 saniye) yansıtıyordu. Ayrıca ClickHouse'un anlık sıkıştırılmış boyutu ile telemetrideki `end_bytes` arasında sürüm kayması (misalignment) mevcuttu.
- **Çözüm:** `clickhouse_user_data_growth` ölçümü, `.runtime/clickhouse_user_data_samples.json` üzerinde atomik olarak saklanan `{ measured_at, bytes_on_disk }` snapshot serisine bağlandı. Rate hesabı strictly aynı serinin iki snapshot'ı arasından yapılmaktadır.
- **Doğrulanmış Canlı Raw Telemetri (Strict UTC):**
  - `measurement_start_at`: `2026-09-17T22:58:29.108Z`
  - `measurement_end_at`: `2026-09-18T19:00:21.628Z`
  - `start_bytes`: `68,581` bytes (66.97 KB)
  - `end_bytes`: `243,878` bytes (238.16 KB)
  - `delta_bytes`: `175,297` bytes (171.19 KB)
  - `elapsed_seconds`: `72,113` saniye (~20.03 saat)
  - `computed_gb_day`: `+0.000196` GB/gün (~0.20 MB/gün)
  - `Sample Eşleşme Doğrulaması`: **MATCH_PASS** (`current compressed size == end_bytes`)
- **Uyuşmazlık Koruyucu (Guardrail):** Eğer anlık ClickHouse compressed boyutu ile `end_bytes` uyuşmazsa derhal `CLICKHOUSE_GROWTH_SAMPLE_MISMATCH` üretilir, büyüme metriği `UNKNOWN` yapılır ve Stage 2 asla fail-open yapmayarak kilitli kalır.

#### B. APFS Reclaim vs Kalıcı Proje Büyümesi: Çift Sensörlü Kapasite Kapısı (Dual Capacity Guardrail)
- **Kök Neden:** macOS APFS dinamik cache purge/reclaim mekanizması nedeniyle host boş alanı 35.14 GB'tan 42.4+ GB'a yükselmiş ve net host tüketimi güvenlik amacıyla 0 olarak clamp edilmiştir. Ancak aynı anda izlenen kalıcı proje dizinleri (`categories/`, ClickHouse logları, cron logları, runtime) fiziksel olarak büyümeye devam etmektedir.
- **Çözüm (Çift Sensör):**
  1. **Sensör 1 (Authoritative Host Disk):** `effective_host_consumption_rate` (0 GB/gün, pist: ~365 gün).
  2. **Sensör 2 (Conservative Persistent Monitored Growth):** `persistent_monitored_growth_gb_day` (+1.7395 GB/gün, pist: ~18 gün). Yalnızca gerçek proje yolları (`system.parts` user data, `.runtime/clickhouse_prod` logları, `categories/`, `.runtime/cron-logs`, `.runtime/backup_staging`) dahil edilmekte; geçici OS önbellekleri hariç tutulmaktadır.
- **Stage 2 Kapasite Kapısı Kuralı:**
  $$\text{Capacity Gate} = \text{host\_capacity\_safe} \land \text{persistent\_growth\_capacity\_safe}$$
  Böylece APFS reclaim işlemi kalıcı proje büyümesini asla maskeleyemez.
- **Pist Emniyeti:** Eğer `persistent_days_to_10gb_warning < 2` olursa derhal `CAPACITY_GUARDRAIL_TRIGGERED` ve `CAPACITY_PAUSE` üretilir.

#### C. Terminoloji ve Mükerrerlik Standardizasyonu
- Mükerrerlik denetimi, garanti yanıltması yaratmamak adına kesinleşen formata dönüştürülmüştür:
  `Duplicate Observations: 0 (current validation PASS (0 Duplicates))`.

---

### 8. Stage 2 Kesin Açılış Şartları (Hard Gates Doğrulama Çizelgesi)

| No | Güvenlik / Sağlık Kapısı | Gerekli Kriter | Mevcut Canlı Değer | Çizelge Durumu |
| :---: | :--- | :--- | :--- | :---: |
| 1 | `tunnel_health` | Authenticated Uptime $\ge 99\%$, rolling window $\ge 24$h, SELECT 200, unauthenticated DENIED | Token bekleniyor (`MONITOR_CONFIG_MISSING`) | `[ ]` **WAITING/BLOCKED** |
| 2 | `eligible_reconciliation_pass_rate` | %100 eligible runs PASS (14/14 metrik) | 2/2 eligible run (%100) PASS | `[x]` **PASS** |
| 3 | `duplicate_current_validation` | Current validation PASS (0 mükerrerlik) | `0 (current validation PASS (0 Duplicates))` | `[x]` **PASS** |
| 4 | `outbox_health` | Backlog 0, peak backlog 0, spool age normal | 0 pending, 0s age | `[x]` **PASS** |
| 5 | `backup_freshness` & `restore_freshness` | Live uncached: yaş $\le 24$h, aynı snapshot ID | Taze ve canlı doğrulanmış (0.01h, Snapshot MATCH) | `[x]` **PASS** |
| 6 | `dual_capacity_safe` | `host_capacity_safe` AND `persistent_growth_capacity_safe` | 20.03h elapsed (PROVISIONAL) | `[ ]` **WAITING/BLOCKED (Baseline < 24h)** |
| 6b | `clickhouse_sample_match` | Compressed Size == end_bytes | `243,878 B == 243,878 B` (MATCH_PASS) | `[x]` **PASS** |
| 7a | `schema_health` | 4/4 beklenen üretim tablosu şemada mevcut | 4/4 Tablo Mevcut | `[x]` **PASS** |
| 7b | `parts_health` | Aktif parça $\le 50$, devam eden merge $= 0$ | Aktif parça: 6, merge: 0 | `[x]` **PASS** |
| 7c | `stage1_write_coverage` | Stage 1 sözleşmesi (`stage1_production_rank_rows == 0` EXPECTED) | Sözleşme sağlandı (Üretim rank satırı: 0) | `[x]` **PASS** |
| 7d | `stage_2_ranking_ready` | Dinamik 6 koşul (PASS, yaş $\le 24$h, post-hygiene, 9/9 rec, 0 dup, outbox 0) | `PRE_STORAGE_HYGIENE_PASS` (Storage Hygiene & post-fix canary bekleniyor) | `[ ]` **WAITING/BLOCKED** |
| 8 | `post_fix_baseline` | Storage hygiene sonrası temiz baseline $\ge 24$h | İlk baseline aşamasında | `[ ]` **WAITING/BLOCKED** |
| 9 | **Human Approval** | Yalnızca 1–8 tüm hard gate'ler aynı anda PASS olduğunda geçerlidir | Dondurulmuş (`FROZEN`) | `[ ]` **BLOCKED** |

**Kesin Karar:** Stage 2 kesinlikle **DONDURULMUŞTUR (FROZEN)**. İlk 24 saatlik baseline tamamlanıp Storage Hygiene uygulanana ve yeni 24 saatlik post-fix baseline sonrası STAGE_2_PREFLIGHT_RANKING_CANARY tekrar çalıştırılana kadar Stage 2 açılamaz. Supabase geçmişi **0 DROP, 0 DELETE, 0 TRUNCATE, 0 INDEX DROP** ile %100 dokunulmazdır.

---

## 10. Kapasite Statüsü Ayrıştırması, Sıfır Yazımlı Denetim ve Test Değişmezlik Koruması (2026-09-18)

Kullanıcı direktifleri doğrultusunda canlı sistemde aşağıdaki kritik mimari mantık düzeltmeleri devreye alınmıştır:

### 1. Kapasite Statüsünün İkiye Ayrılması (Capacity Status Segregation)

Operasyonel acil durum yönetimi ile Stage 2'ye geçiş olgunluğu birbirinden kesin sınırlarla ayrılmıştır:

| Statü Alanı | Kural ve Eşikler | Mevcut Değer | Durum |
| :--- | :--- | :--- | :---: |
| **`operational_capacity_status`** | • `persistent runway >= 2 gün` AND `free_disk > 20 GB` $\to$ **SAFE**<br>• `runway < 2 gün` OR `free_disk <= 15 GB` $\to$ **CAPACITY_PAUSE** | Free Disk: 42.3 GB, Runway: 17 gün | **SAFE** |
| **`stage2_capacity_readiness`** | • `host_days_to_10gb >= 60` AND `persistent_days_to_10gb >= 60` AND `!isProvisional` $\to$ **READY**<br>• Şartlar sağlanmazsa $\to$ **BLOCKED** | Host: 365 gün, Persistent: 17 gün (< 60 gün) | **BLOCKED** |

Mevcut durumda `persistent_days_to_10gb = 17–18 gün` olduğu için acil crawler durdurması yapılmaz (`operational_capacity_status = SAFE`), ancak 60 gün şartı sağlanmadığı için Stage 2 engellenir (`stage2_capacity_readiness = BLOCKED`).

### 2. `stage_1_daily_monitor.cjs` Kesin Sıfır Yazım İlkesi (Strict Zero-Write Audit)

Denetim (`--audit` veya periyodik denetim) çalıştırıldığında:
- ⛔ **Ranking canary başlatma yasaktır.**
- ⛔ **ClickHouse insert kesinlikle yasaktır.**
- ⛔ **Supabase insert kesinlikle yasaktır.**
- ⛔ **Yeni preflight run oluşturulmaz.**
- ⛔ **`crawler_pause_state.json` veya `rollout_state.json` üzerinde hiçbir durum değişikliği yapılamaz.**
- `STAGE_2_PREFLIGHT_RANKING_CANARY` yalnızca açıkça `node scripts/stage_2_preflight_ranking_canary.cjs` çağrıldığında çalışır.
- Denetim yalnız en son tamamlanmış canary sonucunu (`.runtime/stage_2_ranking_canary_state.json`) **SALT OKUNUR (READ-ONLY)** olarak okur.

### 3. Test İzolasyonu & Preflight Değişmezlik Koruması (`npm test`)

- Testler production ClickHouse (`verimimari_prod.category_rank_observations`) veya Supabase üzerine gerçek preflight satırı yazamaz. Test kipinde in-memory mock sink (`clickhouseRankingsStore`, `supabaseRankingsStore`) kullanılır.
- `npm test` çalıştırıldığında:
  $$\text{total\_preflight\_rank\_rows\_before} == \text{total\_preflight\_rank\_rows\_after}$$
  şartı `scripts/test_inventory.cjs --pre-guard` ve `--post-guard` adımlarıyla otomatik olarak denetlenir. Satır sayısında herhangi bir artış veya değişim olursa test süiti 1 çıkış kodu ile başarısız olur.
- Doğrulama: `total_preflight_rank_rows_before = 1198 == total_preflight_rank_rows_after = 1198 (0 rows inserted)`.

### 4. Tek `evaluation_timestamp` ve Zaman Sapması Toleransı

- Denetim raporu üretilirken başında tek bir `evaluation_timestamp` (ISO-8601 UTC `...Z`) oluşturulur.
- Tüm tazelik ve yaş hesaplamaları (yedekleme, restore-test, ranking canary) bu referans zamana göre hesaplanır.
- Eğer `latest_preflight_completed_at > evaluation_timestamp`:
  - $\le 60\text{ saniye}$ tolerans içinde ise: asla pozitif yaş üretilmez, **`FUTURE_TIMESTAMP_WITHIN_TOLERANCE`** ve `age_hours = 0` atanır.
  - $> 60\text{ saniye}$ tolerans dışı ise: **`CLOCK_SKEW_DETECTED`** ve `age_hours = -1` atanır.

### 5. Storage Hygiene ve Post-Fix Baseline Yol Haritası

1. **İlk Baseline:** Mevcut 24 saatlik baseline tamamlanacak (~21 saat tamamlandı).
2. **Storage Hygiene:** `scripts/sql/p1_4_storage_hygiene.sql` ve kategori dosya rotasyonu uygulanacak.
3. **Post-Fix Baseline:** Temizlenen sistemde 24 saatlik yeni baseline başlatılacak ve persistent runway yeniden ölçülecek.
4. **Stage 2 Kapasite PASS:** Yalnızca post-fix persistent runway $\ge 60$ gün olduğunda verilecektir.
5. **Cloudflare Authenticated Epoch:** Ayrı bir bağımsız engelleyici olarak kalmaya devam edecek, kimlik bilgileri log/chat ortamına yazılmayacaktır.

---

## 11. Ayrık Yol Kovaları (Exclusive Path Buckets), Çift Sayım Koruması & Reader-Only Denetim Güvenliği (2026-09-18)

Kullanıcı talimatları doğrultusunda disk büyüme muhasebesi, yetkilendirme ve terminoloji tam matematiksel kesinliğe kavuşturulmuştur:

### 1. Non-Overlapping / Exclusive Path Buckets Mimarisı
`persistent_monitored_growth_gb_day` yalnız birbiriyle çakışmayan 5 bağımsız fiziksel dizin kovası üzerinden hesaplanır:
1. **`clickhouse_server_logs`**: `.runtime/clickhouse_prod/var/log` (clickhouse-server.log, stderr, stdout)
2. **`clickhouse_store`**: `.runtime/clickhouse_prod/var/lib` (MergeTree database verileri, system tabloları, query logları, metadata)
3. **`categories`**: `categories/` (crawler snapshot JSON'ları ve history CSV'leri)
4. **`cron_logs`**: `.runtime/cron-logs` (otomatik görev çalıştırma logları)
5. **`backup_staging`**: `.runtime/backup_staging` (şifrelenmiş Parquet yedek hazırlık alanı)

`clickhouse_store` fiziksel dizini zaten `verimimari_prod` kullanıcı tablolarını içerdiğinden, **`system.parts` kullanıcı verisi ayrıca persistent toplamına eklenmez**; mükerrer sayım (double-counting) engellenerek yalnızca açıklayıcı alt metrik (`explanatory_submetrics`) olarak raporlanır.

### 2. Kalıcı Kök Delta & Mükerrer Sayım Denetimi (Persistent Root Accounting)
Audit çıktısında aşağıdaki matematiksel eşitlik ve koruyucu denetlenir:
- **`persistent_root_delta_bytes`**: Proje kök dizininin (`ROOT`) başlangıçtan bugüne gerçek büyümesi (+801.09 MB)
- **`sum_exclusive_bucket_deltas`**: 5 ayrık kovanın net deltasının toplamı (+726.48 MB)
- **`persistent_unattributed_delta_bytes`**: Kovalar dışındaki kök büyümesi (+74.61 MB)
- **`double_count_detected`**: `false (ACCOUNTING_OK)`

**Emniyet Kuralı:** Eğer `sum_exclusive_bucket_deltas > persistent_root_delta_bytes + tolerance` olursa:
$$\implies \text{double\_count\_detected} = \text{true}$$
$$\implies \text{PERSISTENT\_ACCOUNTING\_OVERLAP}$$
$$\implies \text{stage2\_capacity\_readiness} = \text{FAIL}$$

### 3. Terminoloji Düzeltmesi & Telemetri Ayrıştırması
`stage_1_daily_monitor.cjs` host disk state ve ClickHouse sample dosyalarını güncellediği için "Strict Zero-Write Audit" yerine teknik olarak kesin olan terminoloji benimsenmiştir:
- **Denetim Modu:** `DATA_SINK_READ_ONLY_AUDIT`
- **Üretim Verisi Statüsü:** `NO_PRODUCTION_DATA_MUTATION` (ClickHouse ve Supabase üretim tablolarına 0 yazım)
- **İzinli Telemetri Yazımları:** `ALLOWED_TELEMETRY_WRITES (.runtime/host_disk_consumption_state.json, .runtime/clickhouse_user_data_samples.json)`

### 4. Reader-Only Veritabanı Yetkilendirmesi (Database-Level Protection)
Denetim mekanizması ClickHouse'a `READER_ONLY_CREDENTIAL (verimimari_reader)` ile bağlanır:
- `verimimari_reader` yalnızca `SELECT` yetkisine sahiptir; `INSERT`, `UPDATE`, `ALTER`, `DROP`, `TRUNCATE` yetkisi 0'dır.
- Admin fallback tamamen kaldırılmıştır. Kod hatası olsa dahi ClickHouse veritabanı motoru seviyesinde `Code: 497 (ACCESS_DENIED)` ile yazım engellenir.
- Supabase denetim bağlantısı da aynı şekilde sıfır mutasyon kipiyle sınırlandırılmıştır (`READER_ONLY_RESTRICTED`).













