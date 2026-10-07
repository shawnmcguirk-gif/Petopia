-- =============================================================
-- Petopia DB -- 002: connection hardening (D1 spec sec 2, A1; Vitalis 002 / Truehaven 003's lesson).
-- Postgres grants CONNECT on a new database to PUBLIC; close that so no other cluster role opens a session here.
-- Deny by default: PUBLIC gets nothing on any Petopia schema, now or for objects created later.
-- KNOWN LIMIT: the cluster superuser bypasses every grant and RLS.
-- Written for a fresh database (run as the cluster admin); idempotent.
-- =============================================================
DO $$ BEGIN
  EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO petopia_app', current_database());
END $$;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA core, ref, animal, media, ingest FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE petopia_app REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE petopia_app REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE petopia_app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
