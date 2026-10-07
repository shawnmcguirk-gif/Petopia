-- =============================================================
-- Petopia DB -- 014: fixes from the independent review of D1 slices S3-S7 (2026-10-07). Idempotent.
--   1. core.vault_folder_binding: a vault folder name is unique CASE-INSENSITIVELY. The vault lives on macOS, where
--      "Ryan" and "ryan" are one directory: two people bound to them would share one inbox (finding 8). The engine
--      compares with lower() too (inbox.ts setFolder); this index is the second line.
--   2. core.append_only_guard: once a fact has a confirmer, confirmed_by and confirmed_at are frozen. The status flow
--      (CONFIRMED -> SUPERSEDED / DISPUTED) still moves `status`, but nobody can rewrite WHO confirmed it or WHEN
--      (finding 11). Same function as 008 otherwise, so every fact table that uses it (008, 009) gets the rule.
-- =============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_binding_folder_ci ON core.vault_folder_binding (lower(vault_folder_name));

CREATE OR REPLACE FUNCTION core.append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE keep text[] := ARRAY['status','confirmed_by','confirmed_at'] || TG_ARGV;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'records are never deleted; mark one "not right" or correct it instead' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - keep) IS DISTINCT FROM (to_jsonb(OLD) - keep) THEN
    RAISE EXCEPTION 'a recorded fact is never changed in place; correct it with a new row' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(OLD)->>'confirmed_by') IS NOT NULL
     AND ((to_jsonb(NEW)->>'confirmed_by') IS DISTINCT FROM (to_jsonb(OLD)->>'confirmed_by')
          OR (to_jsonb(NEW)->>'confirmed_at') IS DISTINCT FROM (to_jsonb(OLD)->>'confirmed_at')) THEN
    RAISE EXCEPTION 'who confirmed a record, and when, never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF 'to_on' = ANY (TG_ARGV) AND (to_jsonb(OLD)->>'to_on') IS NOT NULL AND (to_jsonb(NEW)->>'to_on') IS DISTINCT FROM (to_jsonb(OLD)->>'to_on') THEN
    RAISE EXCEPTION 'an ended entry stays ended' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
