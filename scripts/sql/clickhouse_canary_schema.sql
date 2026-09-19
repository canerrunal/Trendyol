-- =============================================================================
-- Verimimari Marketplace Data Platform V2 — ClickHouse Canary DDL Schema
-- Isolated schema 'trendyol_canary' for P1.2 Real Canary Dual-Write Testing
-- =============================================================================

CREATE DATABASE IF NOT EXISTS trendyol_canary;

-- -----------------------------------------------------------------------------
-- 1. Canary Ürün Gözlemleri (Daily Product Price, Stock, Ratings & Metrics)
-- Deterministic ID: SHA256(canonical(marketplace:run_id:product_id:merchant_id:variant_id:listing_id:source_scope:captured_at))
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trendyol_canary.product_observations (
    observation_id String,
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
    in_stock Nullable(UInt8), -- 1: true, 0: false, NULL: bilinmiyor
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
-- 2. Canary Kategori Sıralama Gözlemleri (Category Bestseller Rankings 1..1000)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trendyol_canary.category_rank_observations (
    observation_id String,
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
-- 3. Canary Profil ve Teklif Gözlemleri (Profile BuyBox & Merchant Observations)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trendyol_canary.offer_observations (
    observation_id String,
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
