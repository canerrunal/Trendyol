# Verimimari Platform V2 — Disaster Recovery (DR) & Cold-Start Runbook

Bu belge, birincil Mac Mini veya geliştirme makinesinin tamamen fiziksel olarak yok olması, SSD'nin arızalanması, sistemin çalınması veya işletim sisteminin sıfırlanması senaryosunda ("Total Hardware Loss"), Verimimari Marketplace Data Platform V2 sisteminin yedek bir makinede sıfırdan ve veri bütünlüğü garantisiyle ayağa kaldırılması sürecini belgeler.

---

## ⏱️ RPO & RTO Tanımları ve Teknik Sınırlar

| Metrik | Mevcut Standart | İyileştirilmiş Hedef | Açıklama |
| :--- | :--- | :--- | :--- |
| **RTO (Recovery Time Objective)** | **< 5 Dakika** | **< 5 Dakika** | Bootstrap + Restore + Verify scriptlerinin uçtan uca çalışma süresi. |
| **RPO (Recovery Point Objective)** | **<= 24 Saat** | **<= 1 Saat** | Felaket anında kaybedilebilecek maksimum lokal veri penceresi. |

### "Sıfır Veri Kaybı" (RPO = 0) Hakkında Teknik Gerçekler
- **Asenkron Yedeklemenin Sınırı**: Mevcut yedek standardı günlük (RPO <= 24h) çalıştığında, eğer donanım tam yedekten 23 saat 59 dakika sonra bozulursa, son yedekten sonra ClickHouse'a yazılan lokal veriler kaybolma riski taşır.
- **Supabase Çift Yazma (Dual-Write) Tamponu**: P1.1+ mimarisinde uygulanan Outbox çift yazma mimarisi sayesinde, ClickHouse'a yazılan gözlemler eşzamanlı olarak Supabase'e de kuyruklanır. Dolayısıyla ClickHouse yerel diski çökse bile Supabase canlı akışı veri kaybını minimize eder.
- **RPO'yu 1 Saate İndirme Yolu**: ClickHouse AES-256-GCM yedeklerini saatlik artımlı (hourly incremental snapshot) + günlük tam yedek şeklinde yapılandırmak veri kaybı penceresini 24 saatten ~1 saate düşürür.
- **Gerçek RPO = 0**: Ancak iki bağımsız Mac Mini arasında senkron ClickHouse replikasyonu (ClickHouse Keeper / Raft) kurularak sağlanabilir.

---

## 🔐 3 Katmanlı Güvenlik & Ayrım Mimarisi

```
             ┌──────────────────────────────────────────────┐
             │       KOD: GitHub Repo (Açık/Private)         │
             │       canerrunal/Trendyol                    │
             │       (0 Secret, 0 Key, 0 Data Snapshot)     │
             └──────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────┐  ┌──────────────────────────────────┐
│  VERİ: Private GitHub Releases   │  │  SECRET: macOS Keychain / USB    │
│  canerrunal/verimimari-backups   │  │  /Volumes/TWINMOS/...            │
│  • AES-256-GCM Şifreli Parquet   │  │  • 64-karakter AES Hex Key       │
│  • SHA256SUMS.txt                │  │  • Cloudflare Access Credentials │
│  • manifest.json Checksum'lar    │  │  • Supabase URL & Service Role   │
└──────────────────────────────────┘  └──────────────────────────────────┘
```

> [!CRITICAL]
> **Harici Fiziksel Anahtar Saklama Politikası**:
> AES-256-GCM yedekleme anahtarı (`BACKUP_ENCRYPTION_KEY`), birincil Mac'in dışında bağımsız fiziksel bir ortamda (harici SSD/USB veya şifreli parola yöneticisi) saklanmalıdır. Mac tamamen imha olduğunda bu anahtar elinizde yoksa, GitHub Releases'taki yedekler matematiksel olarak açılamaz!

---

## 🛠️ Soğuk Başlangıç (Cold-Start) Kurtarma Prosedürü

### Senaryo: Birincil Mac tamamen öldü, masaya yeni bir Mac kondu.

### Adım 1: Yeni Makinede Kodu Klonlayın
```bash
git clone https://github.com/canerrunal/Trendyol.git
cd Trendyol
```

### Adım 2: Çevreyi Tek Komutla Hazırlayın (Bootstrap)
```bash
bash scripts/bootstrap_new_mac.sh
```
Bu adım Node 24, `npm ci`, ClickHouse 26.8 LTS binary, `verimimari_prod` şeması, RBAC kullanıcıları ve launchd servislerini otomatik kurar.

### Adım 3: Harici Ortamdan Secret'ları Girin
Harici fiziksel medyadaki anahtarlarınızı kullanarak Keychain'e yükleyin:
```bash
bash scripts/setup_secrets.sh
```
İstenen 5 temel gizli bilgiyi yapıştırın:
1. `CF_ACCESS_CLIENT_ID`
2. `CF_ACCESS_CLIENT_SECRET`
3. `CF_TUNNEL_TOKEN`
4. `BACKUP_ENCRYPTION_KEY` (64 karakterlik HEX anahtar)
5. `SUPABASE_URL` & `SUPABASE_SERVICE_ROLE_KEY`

### Adım 4: Üretim Verisini İndirip Doğrulayarak Terfi Edin
```bash
bash scripts/restore_production.sh --latest
```

**Güvenlik Garantisi**:
- Yedek indirilir, SHA256 doğrulanır.
- AES-256-GCM ile deşifre edilir.
- Parquet dosyaları **izole geçici doğrulama tablolarına (`_restore_staging_*`)** yüklenir.
- Satır sayısı ve mantıksal veri seti sağlama toplamı (`logical_dataset_checksum`) %100 doğrulanır.
- Eğer 1 satır bile eksikse veya bozuksa, işlem hemen durdurulur ve üretim tablolarına ASLA dokunulmaz.
- %100 başarı sağlandığında ClickHouse'un atomik `EXCHANGE TABLES` komutu ile canlıya alınır.

### Adım 5: Sistem Sağlığını Doğrulayın
```bash
bash scripts/verify_fresh_install.sh
```

Tek raporda 15/15 bileşenin yeşil (`PASS`) olduğunu görün:
```
Node version                    PASS
ClickHouse version              PASS
Schema 4/4                      PASS
Product checksum                PASS
Rank checksum                   PASS
Supabase connection             PASS
Outbox                          PASS
Cloudflare tunnel               PASS
Authenticated SELECT            PASS
Unauthenticated blocked         PASS
Backup/restore                  PASS
launchd services                PASS
Hermes schedules                PASS
Dashboard :4317                 PASS
npm test                        95/95 PASS
```

---

## 📋 Felaket Sonrası Kontrol Listesi (Post-Recovery Checklist)

1. [ ] ClickHouse Server yerel port 8123'te aktif mi? (`curl -s http://127.0.0.1:8123/ping`)
2. [ ] Tablo satır sayıları beklenen değerde mi? (`SELECT count() FROM verimimari_prod.product_observations`)
3. [ ] Cloudflare Named Tunnel çalışıyor mu? (`ch.verimimari.com` erişimi)
4. [ ] Outbox dizininde takılı kalmış kuyruk var mı? (`.runtime/clickhouse_outbox/`)
5. [ ] Hermes zamanlanmış görevleri devrede mi?
6. [ ] Dashboard arayüzü 4317 portunda yanıt veriyor mu? (`http://localhost:4317`)
7. [ ] Tüm testler eksiksiz geçiyor mu? (`npm test` -> 95/95 PASS)

Tüm adımlar tamamlandığında sistem kesintisiz olarak eski üretim hızında çalışmaya devam eder.
