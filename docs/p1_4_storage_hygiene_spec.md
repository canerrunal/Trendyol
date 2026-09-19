# P1.4 Storage Hygiene Teknik Şartnamesi (24 Saatlik Baseline Sonrası Uygulama Seti)

> **Zamanlama İlkesi:** Bu belgede tanımlanan optimizasyonlar, P1.4 Stage 1'in **ilk 24 saatlik ampirik disk ve operasyonel baseline'ı tamamlanana kadar KESİNLİKLE UYGULANMAYACAKTIR.**
> İlk 24 saat boyunca crawler/storage davranışı salt-okunur (read-only) izlenir. 24 saat dolduktan sonra bu değişiklik seti uygulanacak ve ardından **yeni bir 24 saatlik post-fix baseline** başlatılacaktır.
> **Supabase Dokunulmazlığı:** Supabase tarihsel tablolarında (`product_observations`, `rankings`, `market_observations`) **0 DROP, 0 DELETE, 0 TRUNCATE, 0 INDEX DROP** ilkesi esastır.

---

## 1. Ön Koşul: Bütünlük ve Yedekleme Doğrulama Kapısı (Pre-Fix Verification)

Storage hygiene değişiklikleri devreye alınmadan önce aşağıdaki 3 adımlı güvenlik kapısı zorunludur:

1. **Şifreli Parquet Yedekleme:**
   ```bash
   node scripts/github_release_backup.cjs
   ```
   - Tüm `verimimari_prod` tabloları Parquet formatında dışa aktarılır.
   - AES-256-GCM ile şifrelenerek özel GitHub Releases deposuna yüklenir.
2. **Mantıksal Sağlama Toplamı (Dataset Checksum):**
   - ClickHouse ile Supabase arasındaki `computeLogicalDatasetChecksum` mutabakatı doğrulanır (`MATCH`).
3. **Restore-Test Doğrulaması:**
   - En son alınan yedek arşivinin test ClickHouse örneğine geri yüklenebildiği ve SHA256 checksum'larının eşleştiği teyit edilir (`restore_test_pass == 'PASS'`).

---

## 2. ClickHouse Dahili `system.*_log` Tabloları Şema Doğrulamalı Retention & Bounded TTL

Teşhis raporumuzda `.runtime/clickhouse_prod/var/lib/clickhouse/store` altındaki büyümenin **%99.9**'unun dahili sistem log tablolarından (`system.text_log`, `system.trace_log`, `system.asynchronous_metric_log`, `system.part_log`) kaynaklandığı ve saatte **~30–40 MB** disk tükettiği tespit edilmiştir.

> [!WARNING]
> **Kritik Kural (Generic DDL Yasağı):** `system.*_log` tablolarına tek tip genel (generic) bir `ALTER TABLE ... MODIFY TTL` DDL komutu körü körüne **uygulanamaz**. Her bir sistem tablosunun tablo motoru (`engine`) ve şeması önceden sorgulanmalı, yalnızca MergeTree motoruna sahip ve `event_date` sütunu barındıran tablolara uygun TTL uygulanmalıdır.

### Tablo Bazında Doğrulama Matrisi (Canlı ClickHouse 26.8 LTS İncelemesi):

| Tablo Adı | Tablo Motoru (`engine`) | Desteklenen Retention / TTL Yöntemi | Planlanan Retention |
| :--- | :--- | :--- | :--- |
| `system.trace_log` | `MergeTree` | XML `<ttl>` veya `ALTER TABLE MODIFY TTL` | 3 Gün (`event_date + INTERVAL 3 DAY`) |
| `system.text_log` | `MergeTree` | XML `<ttl>` veya `ALTER TABLE MODIFY TTL` | 3 Gün (`event_date + INTERVAL 3 DAY`) |
| `system.asynchronous_metric_log` | `MergeTree` | XML `<ttl>` veya `ALTER TABLE MODIFY TTL` | 3 Gün (`event_date + INTERVAL 3 DAY`) |
| `system.metric_log` | `MergeTree` | XML `<ttl>` veya `ALTER TABLE MODIFY TTL` | 3 Gün (`event_date + INTERVAL 3 DAY`) |
| `system.part_log` | `MergeTree` | XML `<ttl>` veya `ALTER TABLE MODIFY TTL` | 7 Gün (`event_date + INTERVAL 7 DAY`) |
| `system.query_log` | `MergeTree` | XML `<ttl>` veya `ALTER TABLE MODIFY TTL` | 7 Gün (`event_date + INTERVAL 7 DAY`) |
| `system.processors_profile_log` | `MergeTree` | XML `<ttl>` veya `ALTER TABLE MODIFY TTL` | 3 Gün (`event_date + INTERVAL 3 DAY`) |
| `system.asynchronous_insert_log`| `MergeTree` | XML `<ttl>` veya `ALTER TABLE MODIFY TTL` | 3 Gün (`event_date + INTERVAL 3 DAY`) |
| `system.user_query_log` | `SystemUserQueryLog` | **ALTER TABLE DESTEKLEMEZ**; Server XML config veya handler üzerinden yönetilir | Config bazlı kontrol |

### Uygulanacak Konfigürasyon:
`.runtime/clickhouse_prod/etc/clickhouse-server/config.d/system_logs_retention.xml` dosyası oluşturularak log tablolarına declarative TTL ve log seviyesi politikası eklenecektir:

```xml
<clickhouse>
    <!-- 1. Text Logları için 3 Günlük Bounded TTL -->
    <text_log>
        <database>system</database>
        <table>text_log</table>
        <ttl>event_date + INTERVAL 3 DAY</ttl>
        <flush_interval_milliseconds>7500</flush_interval_milliseconds>
    </text_log>

    <!-- 2. Trace Log için 3 Günlük TTL -->
    <trace_log>
        <database>system</database>
        <table>trace_log</table>
        <ttl>event_date + INTERVAL 3 DAY</ttl>
        <flush_interval_milliseconds>7500</flush_interval_milliseconds>
    </trace_log>

    <!-- 3. Metrik Logları için 3 Günlük TTL -->
    <asynchronous_metric_log>
        <database>system</database>
        <table>asynchronous_metric_log</table>
        <ttl>event_date + INTERVAL 3 DAY</ttl>
        <flush_interval_milliseconds>60000</flush_interval_milliseconds>
    </asynchronous_metric_log>

    <!-- 4. Part Log (Bölüm Hareketleri) için 7 Günlük TTL -->
    <part_log>
        <database>system</database>
        <table>part_log</table>
        <ttl>event_date + INTERVAL 7 DAY</ttl>
        <flush_interval_milliseconds>7500</flush_interval_milliseconds>
    </part_log>

    <!-- 5. Sunucu Log Seviyesinin Bilgi (Information) Düzeyine İndirilmesi (Trace bloat engelleme) -->
    <logger>
        <level>information</level>
    </logger>
</clickhouse>
```

---

## 3. `clickhouse-server.log` için Bounded Log Rotation

Teşhis raporunda `clickhouse-server.log` dosyasının tek başına **119.5 MB** büyüklüğe ulaştığı ve saatte **~14.4 MB** hızla büyüdüğü belirlenmiştir.

### Uygulanacak Konfigürasyon:
ClickHouse sunucu konfigürasyonundaki `<logger>` bloğuna dosya boyutu sınırı ve maksimum arşiv sayısı getirilecektir:

```xml
<clickhouse>
    <logger>
        <size>50M</size>
        <count>3</count>
    </logger>
</clickhouse>
```
- **Tasarruf:** Sunucu metin logları en fazla $3 \times 50\text{ MB} = \mathbf{150\text{ MB}}$ tavan boyutta sınırlanacak; diskin loglar tarafından tüketilmesi kalıcı olarak engellenecektir.

---

## 4. `categories/` Dizini Full-File Rewrite Davranışının Değiştirilmesi

Teşhis raporumuzda profil toplayıcılarının (`elektronik`, `kozmetik`, `otomobil-motosiklet`, `hobi`, `mobilya`, `hamile`) her saat başı tüm `history.csv`, `latest.csv`, `latest.json` dosyalarını append yerine tam boyutla baştan ürettiği (**REPEATED_FULL_FILE_REWRITE**) ve saatte **~32.9 MB** disk artışına yol açtığı tespit edilmiştir.

### Uygulanacak Crawler Çıktı Mimarisi:
1. **`latest.json` ve `latest.csv`:**
   - Salt yerinde (in-place atomic write: `temp -> rename`) üzerine yazma (overwrite) moduna geçirilecek. Geçmiş veriyi barındırmayacak, yalnızca son geçerli tarama durumunu gösterecektir ($O(1)$ sabit disk alanı).
2. **`history.csv`:**
   - Her saat tüm dosyanın baştan yazılması iptal edilecektir.
   - Sadece taranan yeni `observed_date` / `captured_at` gözlem satırları dosyanın sonuna eklenecektir (**incremental append-only**).
   - Aylık dilimleme ve sıkıştırma: 30 günden eski satırlar `history-YYYY-MM.csv.gz` olarak gzip sıkıştırmalı arşive alınacaktır.
3. **Mükerrer Full Snapshot JSON Üretiminin Kaldırılması:**
   - Sıralama ve fiyat değişimi olmayan yaprak kategoriler için her saat başı yeni `snapshots/YYYY-MM-DD/HH-mm.json` üretilmeyecektir. Yalnızca rank veya fiyat delta'sı olan ürünler kaydedilecektir.

---

## 5. Uygulama Sonrası 24 Saatlik Post-Fix Baseline

Storage hygiene değişiklikleri uygulandıktan hemen sonra:
1. `rolloutState.post_fix_baseline_started_at = new Date().toISOString()` kaydedilecek.
2. `scripts/stage_1_daily_monitor.cjs` yeni 24 saatlik gözlem sayacını başlatacaktır.
3. **Stage 2 Hard Gate:**
   - $\text{days\_to\_10gb\_warning} \ge 60$ koşulu, yeni storage hygiene mimarisi altında toplanan **en az 24 saatlik gerçek veri akışı** üzerinden doğrulanacaktır.
   - Bu süre dolmadan ve insan onayı verilmeden Stage 2'ye geçilemez.
