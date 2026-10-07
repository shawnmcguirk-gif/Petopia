-- =============================================================
-- Petopia DB -- 007: the provenance block (D1 spec sec 4.2; A4) and the source document it points at (sec 3.7).
-- Every fact table (marked P in the spec: measurement, vet visit, vaccination, ... from S3 on) is created with
--   SELECT core.apply_provenance('<schema>.<table>', '<pk column>');
-- which adds the block's columns, the database CHECKs and the guard trigger, idempotently. So the rules live in
-- Postgres once, not copied per table, and the engine is only the first line (Vitalis S0.7 / 005).
-- The four rules of sec 4.2:
--   1. CONFIRMED needs confirmed_by (and confirmed_at)                       -> CHECK <t>_pv_confirmed_has_confirmer
--   2. channel = DOCUMENT needs source_document_id                           -> CHECK <t>_pv_document_has_source
--   3. extraction_method = LLM_PROPOSAL can never be INSERTED as CONFIRMED    -> guard trigger, raises check_violation
--      (a CHECK cannot tell an insert from a person's later promotion, which is allowed -- as Vitalis 005)
--   4. source_class = AI_SUGGESTION can never be CONFIRMED                   -> CHECK <t>_pv_ai_never_confirmed
-- Plus: confirmed_by is always a person (never the reader), and status moves only along the sec 4.3 flow.
-- Idempotent.
-- =============================================================

CREATE TABLE IF NOT EXISTS ingest.source_document (
  source_document_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id       bigint NOT NULL REFERENCES core.workspace(workspace_id),
  file_hash          text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  vault_path         text NOT NULL CHECK (length(vault_path) > 0 AND vault_path NOT LIKE '/%' AND vault_path NOT LIKE '%..%'),
  file_name          text NOT NULL,
  media_type         text NOT NULL,
  page_count         integer NULL CHECK (page_count IS NULL OR page_count > 0),
  doc_kind           text NULL CHECK (doc_kind IN ('VET_LETTER','INVOICE','VACCINATION_CERT','INSURANCE_POLICY','INSURANCE_CLAIM','PRESCRIPTION','LAB_REPORT','ADOPTION','PEDIGREE','MICROCHIP','PHOTO','SCREENSHOT','OTHER')),
  document_date      date NULL,
  uploaded_by        text NOT NULL,
  discovered_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT source_document_ws_id UNIQUE (workspace_id, source_document_id),
  CONSTRAINT source_document_ws_hash UNIQUE (workspace_id, file_hash)
);
ALTER TABLE ingest.source_document ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingest.source_document FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_isolation ON ingest.source_document;
CREATE POLICY workspace_isolation ON ingest.source_document
  USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::bigint);

-- Guard trigger (rule 3 + the status flow of sec 4.3).
CREATE OR REPLACE FUNCTION core.provenance_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.extraction_method = 'LLM_PROPOSAL' AND NEW.status <> 'PROPOSED' THEN
      RAISE EXCEPTION 'an LLM_PROPOSAL can only be inserted as PROPOSED' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'PROPOSED'  AND NEW.status IN ('CONFIRMED','DISPUTED','SUPERSEDED'))
    OR (OLD.status = 'CONFIRMED' AND NEW.status IN ('SUPERSEDED','DISPUTED'))
    OR (OLD.status = 'DISPUTED'  AND NEW.status IN ('CONFIRMED','SUPERSEDED'))
  ) THEN
    RAISE EXCEPTION 'status cannot move from % to %', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.source_class IS DISTINCT FROM OLD.source_class OR NEW.channel IS DISTINCT FROM OLD.channel
     OR NEW.extraction_method IS DISTINCT FROM OLD.extraction_method OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
     OR NEW.proposed_by IS DISTINCT FROM OLD.proposed_by OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at THEN
    RAISE EXCEPTION 'where a fact came from cannot be rewritten; correct it with a new row' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

-- Adds the block to one fact table. The table must already have workspace_id and UNIQUE (workspace_id, <pk>).
CREATE OR REPLACE FUNCTION core.apply_provenance(target regclass, pk text) RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
  t   text := (SELECT relname FROM pg_class WHERE oid = target);
  add text[] := ARRAY[
    $c$status text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','CONFIRMED','SUPERSEDED','DISPUTED'))$c$,
    $c$source_class text NOT NULL CHECK (source_class IN ('VET_RECORD','VET_ADVICE','OWNER_OBSERVATION','AI_SUGGESTION'))$c$,
    $c$channel text NOT NULL CHECK (channel IN ('DOCUMENT','MANUAL','VOICE','CARE_LOG'))$c$,
    $c$source_document_id bigint NULL$c$,
    $c$source_page integer NULL CHECK (source_page IS NULL OR source_page > 0)$c$,
    $c$source_quote text NULL$c$,
    $c$extraction_method text NOT NULL CHECK (extraction_method IN ('MANUAL','TEXT_LAYER','OCR','LLM_PROPOSAL'))$c$,
    $c$proposed_by text NOT NULL$c$,
    $c$proposed_at timestamptz NOT NULL DEFAULT now()$c$,
    $c$confirmed_by text NULL$c$,
    $c$confirmed_at timestamptz NULL$c$,
    $c$supersedes_id bigint NULL$c$
  ];
  col text;
  checks text[][] := ARRAY[
    ARRAY['pv_confirmed_has_confirmer', $c$status <> 'CONFIRMED' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)$c$],
    ARRAY['pv_document_has_source',     $c$channel <> 'DOCUMENT' OR source_document_id IS NOT NULL$c$],
    ARRAY['pv_ai_never_confirmed',      $c$source_class <> 'AI_SUGGESTION' OR status <> 'CONFIRMED'$c$],
    ARRAY['pv_confirmer_is_person',     $c$confirmed_by IS NULL OR (length(trim(confirmed_by)) > 0 AND confirmed_by <> 'petopia-reader')$c$],
    ARRAY['pv_page_needs_document',     $c$source_page IS NULL OR source_document_id IS NOT NULL$c$]
  ];
  i int;
BEGIN
  FOREACH col IN ARRAY add LOOP
    EXECUTE format('ALTER TABLE %s ADD COLUMN IF NOT EXISTS %s', target, col);
  END LOOP;
  FOR i IN 1 .. array_length(checks, 1) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = target AND conname = t || '_' || checks[i][1]) THEN
      EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s)', target, t || '_' || checks[i][1], checks[i][2]);
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = target AND conname = t || '_pv_source_fk') THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id)', target, t || '_pv_source_fk');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = target AND conname = t || '_pv_supersedes_fk') THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I FOREIGN KEY (workspace_id, supersedes_id) REFERENCES %s(workspace_id, %I)', target, t || '_pv_supersedes_fk', target, pk);
  END IF;
  EXECUTE format('DROP TRIGGER IF EXISTS provenance_guard ON %s', target);
  EXECUTE format('CREATE TRIGGER provenance_guard BEFORE INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION core.provenance_guard()', target);
END $fn$;
