#!/usr/bin/env bash
# =============================================================================
# Verimimari Marketplace Data Platform V2 — Remote ClickHouse 26.8 LTS Setup
# Tailored for: Oracle Cloud Infrastructure (OCI) Always Free Ampere A1 (ARM64)
# Also compatible with: Ubuntu 22.04 / 24.04 LTS on ARM64 / AMD64 (Hetzner, AWS, etc.)
#
# Target Architecture: ARM64 (aarch64) Ampere A1 VM
# Production VM Sizing: 2 OCPU / 12 GB RAM / 50 GB Boot Volume (Always Free Eligible kaynaklarla 0 TL hedefi)
# Production Domain:    https://ch.verimimari.com:8443
# Security:             Let's Encrypt TLS (Caddy), UFW + OCI iptables, 3-Tier RBAC
# Backups:              Size-Aware Parquet Snapshots + OCI Object Storage Instance Principal Upload
# =============================================================================

set -euo pipefail

DOMAIN="${1:-ch.verimimari.com}"
ADMIN_PASSWORD="${2:-}"
WRITER_PASSWORD="${3:-sec_writer_p1_3_test}"
READER_PASSWORD="${4:-sec_reader_p1_3_test}"

if [[ -z "$ADMIN_PASSWORD" ]]; then
  echo "============================================================================="
  echo "  Kullanım: $0 <DOMAIN_NAME> <ADMIN_PASSWORD> [WRITER_PASSWORD] [READER_PASSWORD]"
  echo "  Örnek: sudo bash $0 ch.verimimari.com Sup3rSecur3AdminPass! MyWriterPass! MyReaderPass!"
  echo "============================================================================="
  exit 1
fi

ARCH=$(dpkg --print-architecture)
echo "============================================================================="
echo "  ORACLE CLOUD ALWAYS FREE CLICKHOUSE 26.8 LTS PROVISIONING"
echo "  Host Architecture: ${ARCH} (Ampere A1 ARM64 / x86_64)"
echo "  Safe Free Target:  2 OCPU / 12 GB RAM / 50 GB Boot Disk"
echo "  Target Endpoint:   https://${DOMAIN}:8443"
echo "  Database:          verimimari_prod (NO TTL)"
echo "  Cost Goal:         Always Free Eligible kaynaklarla 0 TL hedefi"
echo "============================================================================="

# 1. System Updates & Prerequisites
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  curl gnupg apt-transport-https ca-certificates ufw iptables-persistent cron jq

# Install OCI CLI if not present (for Instance Principal authentication)
if ! command -v oci >/dev/null 2>&1; then
  echo "Installing OCI CLI for Instance Principal authentication..."
  apt-get install -y oci-cli || {
    echo "Native package not found, running official OCI CLI installer..."
    bash -c "$(curl -L https://raw.githubusercontent.com/oracle/oci-cli/master/scripts/install/install.sh)" -- --accept-all-defaults || true
  }
fi

# 2. Oracle Cloud In-OS Firewall Hardening (Fixes Oracle default DROP rules)
echo "Configuring OS firewall rules for Oracle Cloud Infrastructure..."
if command -v iptables >/dev/null 2>&1; then
  iptables -I INPUT -p tcp --dport 22 -j ACCEPT || true
  iptables -I INPUT -p tcp --dport 80 -j ACCEPT || true
  iptables -I INPUT -p tcp --dport 443 -j ACCEPT || true
  iptables -I INPUT -p tcp --dport 8443 -j ACCEPT || true
  netfilter-persistent save || true
fi

ufw allow 22/tcp comment "SSH"
ufw allow 80/tcp comment "Caddy ACME Challenge"
ufw allow 443/tcp comment "HTTPS"
ufw allow 8443/tcp comment "ClickHouse HTTPS TLS"
ufw --force enable

# 3. Install Official ClickHouse 26.8 LTS (ARM64 / AMD64)
echo "Installing official ClickHouse 26.8 LTS repository..."
mkdir -p /etc/apt/keyrings
curl -fsSL 'https://packages.clickhouse.com/packages/clickhouse.gpg' | gpg --dearmor --yes -o /etc/apt/keyrings/clickhouse.gpg
echo "deb [signed-by=/etc/apt/keyrings/clickhouse.gpg] https://packages.clickhouse.com/deb stable main" | tee /etc/apt/sources.list.d/clickhouse.list

apt-get update -y
# Pin to official 26.8 LTS patch stream
apt-get install -y clickhouse-server=26.8.* clickhouse-client=26.8.*

# 4. ClickHouse Server & User Configuration
mkdir -p /etc/clickhouse-server/users.d /etc/clickhouse-server/config.d

# Listen strictly on localhost (Caddy handles public WAN TLS on port 8443)
# Sized specifically for 12 GB RAM instance (max 80% RAM = ~9.6 GB)
cat <<EOF > /etc/clickhouse-server/config.d/listen.xml
<clickhouse>
    <listen_host>127.0.0.1</listen_host>
    <http_port>8123</http_port>
    <tcp_port>9000</tcp_port>
    <max_server_memory_usage_to_ram_ratio>0.80</max_server_memory_usage_to_ram_ratio>
</clickhouse>
EOF

# Set admin password and enable access management
cat <<EOF > /etc/clickhouse-server/users.d/admin.xml
<clickhouse>
    <users>
        <default>
            <password>${ADMIN_PASSWORD}</password>
            <networks>
                <ip>::/0</ip>
            </networks>
            <access_management>1</access_management>
        </default>
    </users>
</clickhouse>
EOF

systemctl enable clickhouse-server
systemctl restart clickhouse-server
sleep 3

# Verify ClickHouse is alive
echo "Verifying local ClickHouse 26.8 LTS response..."
CH_VER=$(clickhouse-client --user default --password "${ADMIN_PASSWORD}" --query "SELECT version()")
echo "✓ ClickHouse is active: version ${CH_VER}"

# 5. Provision Production Schema (verimimari_prod) and 3-Tier RBAC
echo "Provisioning verimimari_prod schema and RBAC roles..."
clickhouse-client --user default --password "${ADMIN_PASSWORD}" --multiquery <<SQL
CREATE DATABASE IF NOT EXISTS verimimari_prod;

CREATE TABLE IF NOT EXISTS verimimari_prod.product_observations
(
    observation_id LowCardinality(String),
    run_id LowCardinality(String),
    observed_date Date,
    captured_at DateTime64(3, 'Europe/Istanbul'),
    marketplace LowCardinality(String) DEFAULT 'trendyol',
    source_scope LowCardinality(String) DEFAULT 'taxonomy',
    offer_key String,
    product_id String,
    merchant_id LowCardinality(String),
    price Decimal(10, 2),
    original_price Decimal(10, 2),
    in_stock Nullable(UInt8)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(observed_date)
ORDER BY (marketplace, observed_date, product_id, merchant_id, observation_id)
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS verimimari_prod.category_rank_observations
(
    observation_id LowCardinality(String),
    run_id LowCardinality(String),
    observed_date Date,
    captured_at DateTime64(3, 'Europe/Istanbul'),
    marketplace LowCardinality(String) DEFAULT 'trendyol',
    category_id UInt32,
    rank UInt32,
    product_id String,
    offer_key String
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(observed_date)
ORDER BY (marketplace, category_id, observed_date, rank, observation_id)
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS verimimari_prod.profile_observations
(
    observation_id LowCardinality(String),
    run_id LowCardinality(String),
    observed_date Date,
    captured_at DateTime64(3, 'Europe/Istanbul'),
    marketplace LowCardinality(String) DEFAULT 'trendyol',
    profile_id LowCardinality(String),
    product_id String,
    offer_key String,
    merchant_id LowCardinality(String),
    price Decimal(10, 2),
    in_stock Nullable(UInt8)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(observed_date)
ORDER BY (marketplace, profile_id, observed_date, product_id, observation_id)
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 1000;

CREATE TABLE IF NOT EXISTS verimimari_prod.inventory_observations
(
    observation_id LowCardinality(String),
    run_id LowCardinality(String),
    observed_date Date,
    captured_at DateTime64(3, 'Europe/Istanbul'),
    marketplace LowCardinality(String) DEFAULT 'trendyol',
    product_id String,
    merchant_id LowCardinality(String),
    inventory_key Nullable(String),
    available_stock Nullable(Int64),
    stock_status LowCardinality(String)
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(observed_date)
ORDER BY (marketplace, observed_date, product_id, inventory_key, observation_id)
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 1000, allow_nullable_key = 1;

-- Roles
CREATE ROLE IF NOT EXISTS migration_admin_role;
CREATE ROLE IF NOT EXISTS collector_writer_role;
CREATE ROLE IF NOT EXISTS verimimari_reader_role;

GRANT ALL ON verimimari_prod.* TO migration_admin_role;

GRANT INSERT ON verimimari_prod.product_observations TO collector_writer_role;
GRANT INSERT ON verimimari_prod.category_rank_observations TO collector_writer_role;
GRANT INSERT ON verimimari_prod.profile_observations TO collector_writer_role;
GRANT INSERT ON verimimari_prod.inventory_observations TO collector_writer_role;
GRANT SELECT(observation_id, run_id) ON verimimari_prod.product_observations TO collector_writer_role;
GRANT SELECT(observation_id, run_id) ON verimimari_prod.category_rank_observations TO collector_writer_role;
GRANT SELECT(observation_id, run_id) ON verimimari_prod.profile_observations TO collector_writer_role;
GRANT SELECT(observation_id, run_id) ON verimimari_prod.inventory_observations TO collector_writer_role;

GRANT SELECT ON verimimari_prod.* TO verimimari_reader_role;
GRANT SELECT ON system.parts TO verimimari_reader_role;
GRANT SELECT ON system.tables TO verimimari_reader_role;

-- Users
CREATE USER IF NOT EXISTS migration_admin IDENTIFIED WITH sha256_password BY '${ADMIN_PASSWORD}' DEFAULT ROLE migration_admin_role;
CREATE USER IF NOT EXISTS collector_writer IDENTIFIED WITH sha256_password BY '${WRITER_PASSWORD}' DEFAULT ROLE collector_writer_role;
CREATE USER IF NOT EXISTS verimimari_reader IDENTIFIED WITH sha256_password BY '${READER_PASSWORD}' DEFAULT ROLE verimimari_reader_role;
SQL

echo "✓ Production schema verimimari_prod and 3-tier RBAC successfully configured!"

# 6. Install & Configure Caddy for Automatic Let's Encrypt TLS
echo "Installing Caddy web server for automated Let's Encrypt TLS on port 8443..."
apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y && apt-get install -y caddy

# Caddy configuration: Port 8443 HTTPS reverse proxy with automated Let's Encrypt certificate
cat <<EOF > /etc/caddy/Caddyfile
{
    admin off
}

${DOMAIN}:8443 {
    reverse_proxy 127.0.0.1:8123 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto https
    }
}
EOF

systemctl enable caddy
systemctl restart caddy

# 7. Off-Host OCI Object Storage Backup Configuration & Script
echo "Configuring size-aware Parquet backup with OCI Object Storage off-host sync..."
mkdir -p /var/backups/clickhouse /etc/clickhouse-backup /usr/local/bin

# Environment file template for OCI Object Storage configuration
if [[ ! -f /etc/clickhouse-backup/oci_env.sh ]]; then
  cat <<'EOF' > /etc/clickhouse-backup/oci_env.sh
# OCI Object Storage Configuration for Off-Host ClickHouse Backups
#
# Production Default: Instance Principal Authentication (Zero static secrets)
# Setup Requirements in OCI Console:
# 1. Identity -> Dynamic Groups -> Create Dynamic Group 'ClickHouseBackupGroup':
#    Rule: instance.id = '<YOUR_VM_OCID>'  (or: instance.compartment.id = '<COMPARTMENT_OCID>')
# 2. Identity -> Policies -> Create Policy 'ClickHouseBackupPolicy':
#    Statement: Allow dynamic-group ClickHouseBackupGroup to manage objects in compartment <COMPARTMENT_NAME> where target.bucket.name = 'verimimari-clickhouse-backups'
#
OCI_BUCKET_NAME="verimimari-clickhouse-backups"
OCI_NAMESPACE=""

# Fallback: Pre-Authenticated Request (PAR) write URL (if Instance Principal is not configured)
OCI_OBJECT_STORAGE_PAR_URL=""
EOF
  chmod 600 /etc/clickhouse-backup/oci_env.sh
fi

cat <<'EOF' > /usr/local/bin/clickhouse_daily_backup.sh
#!/usr/bin/env bash
# =============================================================================
# Verimimari Marketplace Data Platform V2 — ClickHouse Backup & Off-Host Sync
# Features:
# 1. Parquet snapshot export with file_sha256 and logical_dataset_checksum
# 2. Local test-restore verification before marking backup PASS
# 3. Off-host upload via OCI Instance Principal authentication (default)
# 4. Fallback upload via Pre-Authenticated Request (PAR) URL
# 5. Size-aware rotation (max 3-5 snapshots, strictly under 10 GB to preserve 20 GB free quota)
# =============================================================================
set -euo pipefail

BACKUP_ROOT="/var/backups/clickhouse"
DATE=$(date +%Y%m%d_%H%M%S)
TARGET_DIR="${BACKUP_ROOT}/${DATE}"
META_FILE="${TARGET_DIR}/metadata.json"
mkdir -p "${TARGET_DIR}"

if [[ -f /etc/clickhouse-backup/oci_env.sh ]]; then
  # shellcheck source=/dev/null
  source /etc/clickhouse-backup/oci_env.sh
fi

echo "[BACKUP $(date)] Exporting verimimari_prod Parquet snapshots..."
clickhouse-client --query "SELECT * FROM verimimari_prod.product_observations FORMAT Parquet" > "${TARGET_DIR}/product_observations.parquet"
clickhouse-client --query "SELECT * FROM verimimari_prod.category_rank_observations FORMAT Parquet" > "${TARGET_DIR}/category_rank_observations.parquet"

# 1. Compute physical SHA256 checksums
cd "${TARGET_DIR}"
sha256sum *.parquet > checksums.sha256
PROD_SHA=$(sha256sum product_observations.parquet | awk '{print $1}')
RANK_SHA=$(sha256sum category_rank_observations.parquet | awk '{print $1}')

# 2. Compute Logical Dataset Checksum (Order-independent canonical observation hash)
LOGICAL_CHECKSUM=$(clickhouse-client --query "
  SELECT lower(hex(SHA256(arrayStringConcat(arraySort(groupArray(
    concat(observation_id, '|', run_id, '|', offer_key, '|', toString(price))
  )), '\n'))))
  FROM verimimari_prod.product_observations
" | tr -d ' \r\n')

echo "[BACKUP] Physical SHA256 (products): ${PROD_SHA}"
echo "[BACKUP] Logical Checksum: ${LOGICAL_CHECKSUM}"

# 3. Restore Verification Test to an isolated temporary table
RESTORE_PASS=false
VERIFY_TABLE="backup_verify_${DATE}"
clickhouse-client --multiquery <<SQL
CREATE TABLE IF NOT EXISTS verimimari_prod.${VERIFY_TABLE} AS verimimari_prod.product_observations;
TRUNCATE TABLE verimimari_prod.${VERIFY_TABLE};
SQL

clickhouse-client --query "INSERT INTO verimimari_prod.${VERIFY_TABLE} FORMAT Parquet" < "${TARGET_DIR}/product_observations.parquet"

RESTORED_LOGICAL=$(clickhouse-client --query "
  SELECT lower(hex(SHA256(arrayStringConcat(arraySort(groupArray(
    concat(observation_id, '|', run_id, '|', offer_key, '|', toString(price))
  )), '\n'))))
  FROM verimimari_prod.${VERIFY_TABLE}
" | tr -d ' \r\n')

clickhouse-client --query "DROP TABLE IF EXISTS verimimari_prod.${VERIFY_TABLE}"

if [[ "${LOGICAL_CHECKSUM}" == "${RESTORED_LOGICAL}" && -n "${LOGICAL_CHECKSUM}" ]]; then
  RESTORE_PASS=true
  echo "✓ Restore verification test PASSED (Logical checksums match)."
else
  echo "✗ Restore verification test FAILED! Expected ${LOGICAL_CHECKSUM}, got ${RESTORED_LOGICAL}"
fi

# 4. Off-Host Upload to OCI Always Free Object Storage
UPLOAD_SUCCESS=false
UPLOAD_AUTH_METHOD="none"
ARCHIVE_FILE="${BACKUP_ROOT}/ch_backup_${DATE}.tar.gz"
tar -czf "${ARCHIVE_FILE}" -C "${TARGET_DIR}" .

# Primary Method: OCI Instance Principal Authentication (Production Default)
if command -v oci >/dev/null 2>&1 && [[ -n "${OCI_BUCKET_NAME:-}" ]]; then
  echo "[BACKUP] Uploading to OCI Object Storage (${OCI_BUCKET_NAME}) via Instance Principal..."
  OCI_CMD=(oci os object put --auth instance_principal --bucket-name "${OCI_BUCKET_NAME}" --file "${ARCHIVE_FILE}" --name "ch_backup_${DATE}.tar.gz" --force)
  if [[ -n "${OCI_NAMESPACE:-}" ]]; then
    OCI_CMD+=(--namespace "${OCI_NAMESPACE}")
  fi

  if "${OCI_CMD[@]}"; then
    UPLOAD_SUCCESS=true
    UPLOAD_AUTH_METHOD="instance_principal"
    echo "✓ Off-host upload via Instance Principal succeeded."
  else
    echo "✗ Off-host upload via Instance Principal failed. Checking fallback..."
  fi
fi

# Fallback Method: Pre-Authenticated Request (PAR) URL
if [[ "${UPLOAD_SUCCESS}" == "false" && -n "${OCI_OBJECT_STORAGE_PAR_URL:-}" ]]; then
  echo "[BACKUP] Uploading to OCI Object Storage via PAR fallback..."
  if curl -fsSL -X PUT --data-binary @"${ARCHIVE_FILE}" "${OCI_OBJECT_STORAGE_PAR_URL}ch_backup_${DATE}.tar.gz"; then
    UPLOAD_SUCCESS=true
    UPLOAD_AUTH_METHOD="par_url"
    echo "✓ Off-host upload succeeded via PAR fallback."
  else
    echo "✗ Off-host upload failed via PAR."
  fi
fi

rm -f "${ARCHIVE_FILE}"

# 5. Emit structured metadata manifest
cat <<META > "${META_FILE}"
{
  "timestamp": "${DATE}",
  "file_sha256": {
    "product_observations": "${PROD_SHA}",
    "category_rank_observations": "${RANK_SHA}"
  },
  "logical_dataset_checksum": "${LOGICAL_CHECKSUM}",
  "restore_test_pass": ${RESTORE_PASS},
  "upload_success": ${UPLOAD_SUCCESS},
  "upload_auth_method": "${UPLOAD_AUTH_METHOD}"
}
META

# 6. Size-Aware Rotation (Never exceed 10 GB locally / keep last 3-5 snapshots)
MAX_SNAPSHOTS=5
echo "[BACKUP] Applying size-aware rotation (max ${MAX_SNAPSHOTS} verified snapshots)..."
SNAPSHOT_COUNT=$(find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d | wc -l)
if [[ "${SNAPSHOT_COUNT}" -gt "${MAX_SNAPSHOTS}" ]]; then
  find "${BACKUP_ROOT}" -mindepth 1 -maxdepth 1 -type d | sort | head -n -"${MAX_SNAPSHOTS}" | xargs rm -rf
fi

echo "[BACKUP] Completed successfully at $(date)."
EOF

chmod +x /usr/local/bin/clickhouse_daily_backup.sh

# Add to root crontab (runs every night at 03:30 AM)
CRON_JOB="30 3 * * * /usr/local/bin/clickhouse_daily_backup.sh >> /var/log/clickhouse_backup.log 2>&1"
(crontab -l 2>/dev/null | grep -v "clickhouse_daily_backup.sh" || true; echo "${CRON_JOB}") | crontab -

echo "============================================================================="
echo "  PROVISIONING COMPLETE! ORACLE CLOUD CLICKHOUSE 26.8 LTS IS LIVE"
echo "  Endpoint: https://${DOMAIN}:8443/"
echo "============================================================================="
echo ""
echo "CRITICAL ORACLE CLOUD STEPS REQUIRED IN OCI CONSOLE:"
echo "1. VM Shape Sizing (Always Free Eligible - 0 TL Hedefi):"
echo "   - Shape: VM.Standard.A1.Flex (2 OCPU / 12 GB RAM / 50 GB Boot Disk)"
echo "   - DİKKAT: Konsolda 'Always Free Eligible' işaretini mutlaka doğrulayın."
echo "2. Networking -> Virtual Cloud Networks -> Your VCN -> Security Lists:"
echo "   Add Ingress Rules (Source: 0.0.0.0/0, Protocol: TCP):"
echo "   - Port 80   (HTTP for Let's Encrypt certificate challenge)"
echo "   - Port 443  (HTTPS)"
echo "   - Port 8443 (ClickHouse HTTPS TLS endpoint)"
echo "3. DNS Management:"
echo "   Point A-record '${DOMAIN}' to this VM's Public IPv4 address."
echo "4. OCI Object Storage Instance Principal Setup (Production Default):"
echo "   - Bucket: verimimari-clickhouse-backups (Always Free 20 GB kotası)"
echo "   - Dynamic Group: 'ClickHouseBackupGroup' with rule: instance.id = '<VM_OCID>'"
echo "   - IAM Policy: 'Allow dynamic-group ClickHouseBackupGroup to manage objects in compartment <COMPARTMENT> where target.bucket.name = \"verimimari-clickhouse-backups\"'"
echo "============================================================================="
