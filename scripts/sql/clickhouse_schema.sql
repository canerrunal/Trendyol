-- =============================================================================
-- Verimimari Marketplace Data Platform V2 — ClickHouse Production DDL Schema
-- =============================================================================
-- Tasarım İlkeleri:
-- 1. Tüm tarihsel observation tabloları MergeTree() motorunu kullanır.
-- 2. Plain MergeTree uniqueness zorlamadığı için satır tekilliği, composite
--    iş anahtarlarından üretilen deterministik `observation_id` ile sağlanır.
--    `observation_id` DB kısıtı değil, mantıksal mutabakat ve event kimliğidir.
--    ClickHouse `insert_deduplication_token` yardımcı savunmadır; sonlu dedup
--    penceresi nedeniyle doğruluk hiçbir zaman yalnız bu pencereye bağlanamaz.
-- 3. İlk DDL sürümünde veri kaybı riskini önlemek için TTL tanımlanmamıştır.
-- 4. Aylık partisyonlama: PARTITION BY toYYYYMM(observed_date)
-- 5. Current/Entity state tablosu (product_state_latest) ClickHouse'a konulmamış;
--    Supabase tek gerçek kaynak (single source of truth) olarak korunmuştur.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS trendyol;

-- -----------------------------------------------------------------------------
-- 1. Ürün Gözlemleri (Daily Product Price, Stock, Ratings & Metrics)
-- Deterministic ID: SHA256(canonical(marketplace:run_id:product_id:merchant_id:variant_id:listing_id:source_scope:captured_at))
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trendyol.product_observations (
    observation_id String, -- Deterministik SHA256 kimliği (mantıksal mutabakat anahtarı)
    marketplace LowCardinality(String) DEFAULT 'trendyol',
    observed_date Date,
    captured_at DateTime64(3, 'Europe/Istanbul'),
    run_id String,
    product_id String,
    merchant_id Nullable(String),
    variant_id Nullable(String),
    listing_id Nullable(String),
    offer_key String,
    price Nullable(Decimal(10, 2)),
    original_price Nullable(Decimal(10, 2)),
    currency LowCardinality(String) DEFAULT 'TRY',
    in_stock Nullable(UInt8), -- 1: true (stokta), 0: false (tükendi), NULL: bilinmiyor
    running_out Nullable(UInt8),
    rating Nullable(Decimal(3, 2)),
    rating_count Nullable(UInt32),
    review_count Nullable(UInt32),
    stock_quantity Nullable(UInt32),
    sales_signal Nullable(String),
    sales_signal_min Nullable(UInt32),
    promotions_count UInt16 DEFAULT 0,
    promotions Array(String) DEFAULT [],
    fast_delivery UInt8 DEFAULT 0,
    rush_delivery_hours Nullable(UInt16),
    source_scope LowCardinality(String) DEFAULT 'taxonomy',
    created_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(observed_date)
ORDER BY (marketplace, product_id, observed_date, offer_key, observation_id)
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 1000;

-- -----------------------------------------------------------------------------
-- 2. Kategori Sıralama Gözlemleri (Category Bestseller Rankings 1..1000)
-- Deterministic ID: SHA256(marketplace:run_id:category_id:product_id:merchant_id:rank_scope:rank)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trendyol.category_rank_observations (
    observation_id String, -- Deterministik SHA256 kimliği
    marketplace LowCardinality(String) DEFAULT 'trendyol',
    observed_date Date,
    captured_at DateTime64(3, 'Europe/Istanbul'),
    run_id String,
    category_id UInt64,
    rank UInt16,
    product_id String,
    merchant_id Nullable(String),
    offer_key String,
    rank_scope LowCardinality(String) DEFAULT 'bestseller',
    price Nullable(Decimal(10, 2)),
    rank_delta Nullable(Int16),
    created_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(observed_date)
ORDER BY (marketplace, category_id, observed_date, rank, observation_id)
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 1000;

-- -----------------------------------------------------------------------------
-- 3. Profil ve Teklif Gözlemleri (Profile BuyBox & Merchant Observations)
-- Deterministic ID: SHA256(marketplace:run_id:profile_slug:product_id:merchant_id:rank_scope)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trendyol.offer_observations (
    observation_id String, -- Deterministik SHA256 kimliği
    marketplace LowCardinality(String) DEFAULT 'trendyol',
    profile_slug LowCardinality(String),
    observed_date Date,
    captured_at DateTime64(3, 'Europe/Istanbul'),
    run_id String,
    product_id String,
    merchant_id Nullable(String),
    offer_key String,
    rank_position Nullable(UInt16),
    rank_scope LowCardinality(String),
    price Nullable(Decimal(10, 2)),
    original_price Nullable(Decimal(10, 2)),
    discount_percent Nullable(Decimal(5, 2)),
    trend_score Nullable(Decimal(6, 2)),
    opportunity_score Nullable(Decimal(6, 2)),
    stock_status Nullable(String),
    stock_signal Nullable(String),
    created_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(observed_date)
ORDER BY (marketplace, profile_slug, observed_date, product_id, offer_key, observation_id)
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 1000;

-- -----------------------------------------------------------------------------
-- 4. Stok ve Envanter Değişim Gözlemleri (Detailed Inventory Observations)
-- Deterministic ID: SHA256(marketplace:run_id:product_id:merchant_id:variant_id:listing_id:captured_at)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trendyol.inventory_observations (
    observation_id String, -- Deterministik SHA256 kimliği
    marketplace LowCardinality(String) DEFAULT 'trendyol',
    observed_date Date,
    captured_at DateTime64(3, 'Europe/Istanbul'),
    run_id String,
    product_id String,
    merchant_id Nullable(String),
    variant_id Nullable(String),
    listing_id Nullable(String),
    inventory_key String,
    stock_quantity UInt32,
    stock_decline_daily Nullable(UInt32),
    is_estimated_sale UInt8 DEFAULT 0,
    created_at DateTime DEFAULT now()
)
ENGINE = MergeTree()
PARTITION BY toYYYYMM(observed_date)
ORDER BY (marketplace, observed_date, product_id, merchant_id, observation_id)
SETTINGS index_granularity = 8192, non_replicated_deduplication_window = 1000;
