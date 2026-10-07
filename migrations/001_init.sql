-- =============================================================
-- Petopia DB -- 001: bootstrap (D1 spec sec 2, A1). Run as the cluster admin first by bootstrap-db.sh, then
-- recorded by migrate.sh. Idempotent. No tables here. Copied from Vitalis 001 with Petopia names.
-- =============================================================
CREATE SCHEMA IF NOT EXISTS core AUTHORIZATION petopia_app;
CREATE SCHEMA IF NOT EXISTS ref AUTHORIZATION petopia_app;
CREATE SCHEMA IF NOT EXISTS animal AUTHORIZATION petopia_app;
CREATE SCHEMA IF NOT EXISTS media AUTHORIZATION petopia_app;
CREATE SCHEMA IF NOT EXISTS ingest AUTHORIZATION petopia_app;
