# Verimimari Marketplace Data Platform V2 — New Mac Installation Guide

Bu belge, Verimimari platformunun **sıfır bir macOS (Apple Silicon veya Intel) makinede** hiçbir ön kurulum olmadan, tek komutluk scriptlerle sıfırdan kurulması ve ayağa kaldırılması sürecini adım adım anlatır.

---

## 🏛️ Temel Mimari Ayrım (Separation of Concerns)

Sistemin taşınabilirliği 3 bağımsız katmana dayanır:

1. **GitHub Kod Deposu (`canerrunal/Trendyol`)**:
   - Sadece uygulama kodu, şema tanımları (`scripts/sql/`), launchd şablonları (`ops/launchd/`), ClickHouse yapılandırma şablonları (`ops/clickhouse/`), dondurulmuş manifestler (`ops/manifests/`) ve dokümantasyon bulunur.
   - **KESİNLİKLE SIFIR SECRET**: Hiçbir token, şifre, özel anahtar veya ortam değişkeni git'e girmez.
2. **GitHub Releases Veri Yedekleri (`canerrunal/verimimari-backups`)**:
   - ClickHouse 26.8 LTS üretim tablolarının Parquet formatında dışa aktarılmış, AES-256-GCM ile şifrelenmiş snapshot'ları.
   - SHA256SUMS ve mantıksal veri seti sağlama toplamı (`logical_dataset_checksum`) manifestleri ile doğrulanır.
3. **macOS Keychain & Harici Ortam (Secret'lar & Anahtarlar)**:
   - Cloudflare Access belirteçleri, Cloudflare Tunnel run token'ı, Supabase credential'ları ve AES-256-GCM backup encryption key doğrudan macOS Keychain'de (`login` keychain) güvenle saklanır.

---

## 🚀 Yeni Mac Kurulum Adımları (Turnkey Setup)

### Adım 1: Depoyu Klonlayın
```bash
git clone https://github.com/canerrunal/Trendyol.git
cd Trendyol
```

---

### Adım 2: Tek Komutla Sistemi Hazırlayın (Bootstrap)
Yeni Mac üzerinde aşağıdaki scripti çalıştırın:

```bash
bash scripts/bootstrap_new_mac.sh
```

Bu script sırasıyla şu adımları otomatik olarak gerçekleştirir:
1. **İşletim Sistemi & Mimari Kontrolü**: macOS Darwin (arm64 / x86_64) doğrulanır.
2. **Node.js 24 LTS Doğrulaması / Kurulumu**: Node sürümü kontrol edilir; yoksa nvm veya Homebrew aracılığıyla Node 24 kurulur.
3. **Bağımlılık Kurulumu (`npm ci`)**: Proje bağımlılıkları temiz bir şekilde yüklenir.
4. **Cloudflare Tunnel (`cloudflared`) Kontrolü**: Binary kontrol edilir ve gerekirse Homebrew üzerinden kurulur.
5. **Runtime Dizinleri & İzinler**: `.runtime/` hiyerarşisi oluşturulur, `chmod 700` ile kısıtlanır.
6. **ClickHouse 26.8 LTS Kurulumu & Yapılandırması**:
   - ClickHouse binary'si çözümlenir veya resmi kaynaktan indirilir.
   - `ops/clickhouse/` şablonları yeni makinenin çalışma dizinine dinamik olarak render edilir.
7. **ClickHouse Daemon Başlatma**: ClickHouse server başlatılır ve `http://127.0.0.1:8123/ping` yanıtı doğrulanır.
8. **Şema & RBAC Yükleme**:
   - `CREATE DATABASE IF NOT EXISTS verimimari_prod`
   - `scripts/sql/clickhouse_prod_schema.sql` (4 üretim tablosu: `product_observations`, `category_rank_observations`, `profile_observations`, `inventory_observations`)
   - `scripts/sql/clickhouse_prod_rbac.sql` (Admin, Writer, Reader rolleri)
9. **LaunchAgent Servis Şablonları**:
   - `com.verimimari.clickhouse.plist` -> `~/Library/LaunchAgents/`
   - `com.verimimari.outbox-recovery.plist` -> `~/Library/LaunchAgents/`
   - `com.verimimari.cloudflared.plist` -> `~/Library/LaunchAgents/`
10. **Manifest Doğrulaması**: `ops/manifests/` altındaki dondurulmuş Stage 2-5 manifestleri doğrulanır.

---

### Adım 3: Secret'ları Keychain'e Ekleyin
Sistemin çalışması için gereken gizli anahtarları güvenli şekilde girin:

```bash
bash scripts/setup_secrets.sh
```

Terminalde maskeli (ekranda görünmeyen ve bash history'ye kaydedilmeyen) olarak şu değerleri girmeniz istenecektir:
- `CF_ACCESS_CLIENT_ID`: Cloudflare Access Service Auth Client ID
- `CF_ACCESS_CLIENT_SECRET`: Cloudflare Access Service Auth Client Secret
- `CF_TUNNEL_TOKEN`: Cloudflare Named Tunnel çalıştırma token'ı
- `BACKUP_ENCRYPTION_KEY`: 64 karakterlik HEX AES-256-GCM yedek şifreleme anahtarı
- `SUPABASE_URL`: Supabase veritabanı URL'si
- `SUPABASE_SERVICE_ROLE_KEY`: Supabase Service Role API key
- `TELEGRAM_BOT_TOKEN`: (Opsiyonel) Hermes Telegram bot token'ı

> [!CAUTION]
> `BACKUP_ENCRYPTION_KEY` olmadan private GitHub Releases'teki yedekleri açmak matematiksel olarak imkansızdır. Bu anahtarın harici bir USB/fiziksel medyada (`/Volumes/...`) güvenli kopyası bulunmalıdır.

---

### Adım 4: Üretim Verilerini Geri Yükleyin (Restore)
Özel GitHub Releases deposundaki en güncel doğrulanmış yedekten verileri geri yükleyin:

```bash
bash scripts/restore_production.sh --latest
```

Bu script:
1. En güncel yedek sürümünü (`canerrunal/verimimari-backups`) tespit eder.
2. VMBK şifreli arşivini indirir ve SHA256 özetini doğrular.
3. macOS Keychain'den AES-256-GCM anahtarını okuyup arşivi deşifre eder.
4. Verileri önce geçici doğrulama tablolarına (`_restore_staging_*`) yükler.
5. Satır sayısını ve mantıksal veri seti sağlama toplamını (`logical_dataset_checksum`) doğrular.
6. %100 başarılı olursa `EXCHANGE TABLES` ile atomik olarak üretim tablolarına terfi ettirir (`verimimari_prod.*`).

---

### Adım 5: Kurulum Sağlığını Doğrulayın
Tüm platformun eksiksiz ve hatasız çalıştığını tek komutla teyit edin:

```bash
bash scripts/verify_fresh_install.sh
```

Beklenen çıktı:
```
=============================================================================
  VERIMIMARI PLATFORM V2 — FRESH INSTALL & RECOVERY VERIFICATION
=============================================================================
Node version                     PASS
ClickHouse version               PASS
Schema 4/4                       PASS
Product checksum                 PASS
Rank checksum                    PASS
Supabase connection              PASS
Outbox                           PASS
Cloudflare tunnel                PASS
Authenticated SELECT             PASS
Unauthenticated blocked          PASS
Backup/restore                   PASS
launchd services                 PASS
Hermes schedules                 PASS
Dashboard :4317                  PASS
npm test                         95/95 PASS
=============================================================================
  🎉 100% ALL VERIFICATIONS PASSED: PLATFORM IS PRODUCTION OPERATIONAL
=============================================================================
```

Artık yeni Mac, sıfır veri kaybı ve tam mimari bütünlükle canlı üretim ortamı olarak hazırdır!
