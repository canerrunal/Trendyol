-- =============================================================================
-- Verimimari Marketplace Data Platform V2 — ClickHouse RBAC Policies
-- Target Database: verimimari_prod
--
-- Roles:
-- 1. migration_admin_role: DDL, ALTER, CREATE, DROP on verimimari_prod (Admin only)
-- 2. collector_writer_role: INSERT only on historical tables (Worker only)
-- 3. verimimari_reader_role: SELECT only on all tables (Vercel / Downstream only)
-- =============================================================================

-- 1. Roles
CREATE ROLE IF NOT EXISTS migration_admin_role;
CREATE ROLE IF NOT EXISTS collector_writer_role;
CREATE ROLE IF NOT EXISTS verimimari_reader_role;

-- 2. Privileges for migration_admin_role (DDL only)
GRANT ALL ON verimimari_prod.* TO migration_admin_role;

-- 3. Privileges for collector_writer_role (Least Privilege - Insert on historical tables + Select for dedup)
GRANT INSERT ON verimimari_prod.product_observations TO collector_writer_role;
GRANT INSERT ON verimimari_prod.category_rank_observations TO collector_writer_role;
GRANT INSERT ON verimimari_prod.profile_observations TO collector_writer_role;
GRANT INSERT ON verimimari_prod.inventory_observations TO collector_writer_role;
GRANT SELECT(observation_id, run_id) ON verimimari_prod.product_observations TO collector_writer_role;
GRANT SELECT(observation_id, run_id) ON verimimari_prod.category_rank_observations TO collector_writer_role;
GRANT SELECT(observation_id, run_id) ON verimimari_prod.profile_observations TO collector_writer_role;
GRANT SELECT(observation_id, run_id) ON verimimari_prod.inventory_observations TO collector_writer_role;

-- 4. Privileges for verimimari_reader_role (Read only + system monitoring)
GRANT SELECT ON verimimari_prod.* TO verimimari_reader_role;
GRANT SELECT ON system.parts TO verimimari_reader_role;
GRANT SELECT ON system.tables TO verimimari_reader_role;
GRANT SELECT ON system.merges TO verimimari_reader_role;
GRANT SELECT ON system.part_log TO verimimari_reader_role;
GRANT SELECT ON system.query_log TO verimimari_reader_role;

