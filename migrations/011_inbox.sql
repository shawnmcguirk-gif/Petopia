-- =============================================================
-- Petopia DB -- 011: the document inbox and AI reading (D1 spec sec 3.7, 4, 5; slice S5; A20, A21).
--   core.vault_folder_binding  one per person: <Name>/Pets/inbox/ under VAULT_ROOT. Inert until THAT person gives the
--                              go-ahead to read it (go_ahead_*), and document text goes to Claude only after their
--                              separate AI go-ahead (ai_go_ahead_*) -- both off until given, both only by the person
--                              themselves (CHECKs below). Gate table like core.access_grant: no RLS, because the
--                              engine's sweep reads it before choosing a household (Vitalis S5.0 #2 / 008).
--   core.consent_event         insert-only record of every go-ahead given or withdrawn, with the words shown.
--   ingest.inbox_item          one per discovered document: status flow DISCOVERED -> READ -> ASSESSED ->
--                              NEEDS_REVIEW -> FILED_PENDING -> FILED (or IGNORED / ASSESS_FAILED).
--   ingest.extraction_run      every text read (TEXT_LAYER / OCR) and every model read (LLM_PROPOSAL / LOCAL_MODEL):
--                              model, CLI version, tokens, cost, how many values the quote guard dropped. Never the
--                              prompt, never the raw answer (sec 5.2 rules).
--   ingest.page_text           the engine's own text of each page: what quotes are checked against and shown beside.
--   ingest.proposal            what the reader proposed, value by value, with page + quote; a person accepts,
--                              corrects or dismisses each one. Nothing here is a fact: real rows are written only when
--                              a person files the item (engine/src/inbox.ts), as PROPOSED/CONFIRMED by the sec 4 rules.
-- FORCE RLS on every content table, fail-closed. Idempotent.
-- =============================================================

CREATE TABLE IF NOT EXISTS core.vault_folder_binding (
  binding_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id      bigint NOT NULL REFERENCES core.workspace(workspace_id),
  member_name       text NOT NULL CHECK (length(trim(member_name)) > 0),
  vault_folder_name text NOT NULL CHECK (vault_folder_name ~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$' AND vault_folder_name NOT LIKE '%..%'),
  go_ahead_by       text NULL,
  go_ahead_at       timestamptz NULL,
  ai_go_ahead_by    text NULL,
  ai_go_ahead_at    timestamptz NULL,
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT binding_folder_unique UNIQUE (vault_folder_name),
  CONSTRAINT binding_member_unique UNIQUE (workspace_id, member_name),
  CONSTRAINT binding_go_ahead_pair CHECK ((go_ahead_by IS NULL) = (go_ahead_at IS NULL)),
  CONSTRAINT binding_ai_pair CHECK ((ai_go_ahead_by IS NULL) = (ai_go_ahead_at IS NULL)),
  -- "given by that person": nobody can give another person's go-ahead, not even an admin.
  CONSTRAINT binding_go_ahead_self CHECK (go_ahead_by IS NULL OR go_ahead_by = member_name),
  CONSTRAINT binding_ai_self CHECK (ai_go_ahead_by IS NULL OR ai_go_ahead_by = member_name)
);

CREATE TABLE IF NOT EXISTS core.consent_event (
  consent_event_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     bigint NOT NULL REFERENCES core.workspace(workspace_id),
  member_name      text NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('FOLDER_READ','AI_READING')),
  given            boolean NOT NULL,
  words_shown      text NOT NULL,
  at               timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION core.insert_only_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'this record is never changed or deleted' USING ERRCODE = 'check_violation';
END $fn$;
DROP TRIGGER IF EXISTS insert_only_guard ON core.consent_event;
CREATE TRIGGER insert_only_guard BEFORE UPDATE OR DELETE ON core.consent_event FOR EACH ROW EXECUTE FUNCTION core.insert_only_guard();

ALTER TABLE ingest.source_document ADD COLUMN IF NOT EXISTS original_relpath text NULL;

CREATE TABLE IF NOT EXISTS ingest.inbox_item (
  inbox_item_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id           bigint NOT NULL REFERENCES core.workspace(workspace_id),
  source_document_id     bigint NOT NULL,
  member_name            text NOT NULL,                 -- whose folder it came from (decides the AI go-ahead)
  status                 text NOT NULL DEFAULT 'DISCOVERED' CHECK (status IN ('DISCOVERED','READ','ASSESSED','NEEDS_REVIEW','FILED_PENDING','FILED','IGNORED','ASSESS_FAILED')),
  flags                  text[] NOT NULL DEFAULT '{}',
  animal_id              bigint NULL,
  animal_proposed_id     bigint NULL,                   -- the reader's match (microchip, else name + species); a person decides animal_id
  doc_kind               text NULL CHECK (doc_kind IN ('VET_LETTER','INVOICE','VACCINATION_CERT','INSURANCE_POLICY','INSURANCE_CLAIM','PRESCRIPTION','LAB_REPORT','ADOPTION','PEDIGREE','MICROCHIP','PHOTO','SCREENSHOT','OTHER')),
  doc_kind_proposed      text NULL,
  document_date          date NULL,
  document_date_assumed  boolean NOT NULL DEFAULT false, -- no date printed: the file date, which the reviewer must set
  found                  jsonb NOT NULL DEFAULT '{}'::jsonb, -- what the reader saw (animal as printed, provider, quotes) for step 1
  dropped_count          integer NOT NULL DEFAULT 0 CHECK (dropped_count >= 0), -- values the quote guard threw away
  decided_by             text NULL,
  decided_at             timestamptz NULL,
  filed_by               text NULL,
  filed_at               timestamptz NULL,
  filed_path             text NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbox_item_ws_id UNIQUE (workspace_id, inbox_item_id),
  CONSTRAINT inbox_item_one_per_document UNIQUE (workspace_id, source_document_id),
  CONSTRAINT inbox_item_doc_fk FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id),
  CONSTRAINT inbox_item_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT inbox_item_animal_proposed_fk FOREIGN KEY (workspace_id, animal_proposed_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT inbox_item_filed_needs_path CHECK (status <> 'FILED' OR filed_path IS NOT NULL),
  CONSTRAINT inbox_item_decided_pair CHECK ((decided_by IS NULL) = (decided_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_inbox_item_status ON ingest.inbox_item (workspace_id, status);

CREATE TABLE IF NOT EXISTS ingest.extraction_run (
  extraction_run_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id      bigint NOT NULL REFERENCES core.workspace(workspace_id),
  inbox_item_id     bigint NOT NULL,
  method            text NOT NULL CHECK (method IN ('TEXT_LAYER','OCR','LLM_PROPOSAL','LOCAL_MODEL')),
  status            text NOT NULL CHECK (status IN ('OK','EMPTY','FAILED','INVALID')),
  model             text NULL,
  cli_version       text NULL,
  pages             integer NULL,
  valid             boolean NULL,                       -- the model's answer passed ajv
  errors            text NULL,                          -- short reason codes only; never document text
  dropped           integer NOT NULL DEFAULT 0,
  input_tokens      integer NULL,
  output_tokens     integer NULL,
  cost_usd          numeric(10,4) NULL,
  at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT extraction_run_ws_id UNIQUE (workspace_id, extraction_run_id),
  CONSTRAINT extraction_run_item_fk FOREIGN KEY (workspace_id, inbox_item_id) REFERENCES ingest.inbox_item(workspace_id, inbox_item_id)
);

CREATE TABLE IF NOT EXISTS ingest.page_text (
  page_text_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id      bigint NOT NULL REFERENCES core.workspace(workspace_id),
  inbox_item_id     bigint NOT NULL,
  extraction_run_id bigint NOT NULL,
  page              integer NOT NULL CHECK (page > 0),
  text              text NOT NULL,
  CONSTRAINT page_text_item_fk FOREIGN KEY (workspace_id, inbox_item_id) REFERENCES ingest.inbox_item(workspace_id, inbox_item_id),
  CONSTRAINT page_text_run_fk FOREIGN KEY (workspace_id, extraction_run_id) REFERENCES ingest.extraction_run(workspace_id, extraction_run_id),
  CONSTRAINT page_text_one UNIQUE (workspace_id, extraction_run_id, page)
);

CREATE TABLE IF NOT EXISTS ingest.proposal (
  proposal_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id      bigint NOT NULL REFERENCES core.workspace(workspace_id),
  inbox_item_id     bigint NOT NULL,
  extraction_run_id bigint NOT NULL,
  target            text NOT NULL CHECK (target IN ('vet_visit','vaccination','treatment','condition','allergy','procedure','lab_result','medication','weight','contact')),
  payload           jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),   -- as read, ajv-checked, after the guard
  corrected         jsonb NULL CHECK (corrected IS NULL OR jsonb_typeof(corrected) = 'object'), -- a person's values
  page              integer NOT NULL CHECK (page > 0),
  quote             text NOT NULL CHECK (length(quote) > 0),
  flags             text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'PROPOSED' CHECK (status IN ('PROPOSED','ACCEPTED','CORRECTED','DISMISSED')),
  decided_by        text NULL,
  decided_at        timestamptz NULL,
  created_table     text NULL,
  created_row_id    bigint NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT proposal_ws_id UNIQUE (workspace_id, proposal_id),
  CONSTRAINT proposal_item_fk FOREIGN KEY (workspace_id, inbox_item_id) REFERENCES ingest.inbox_item(workspace_id, inbox_item_id),
  CONSTRAINT proposal_run_fk FOREIGN KEY (workspace_id, extraction_run_id) REFERENCES ingest.extraction_run(workspace_id, extraction_run_id),
  CONSTRAINT proposal_decided CHECK ((status = 'PROPOSED') = (decided_by IS NULL)),
  CONSTRAINT proposal_corrected CHECK ((status = 'CORRECTED') = (corrected IS NOT NULL))
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['core.consent_event','ingest.inbox_item','ingest.extraction_run','ingest.page_text','ingest.proposal'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON %s', t);
    EXECUTE format($p$CREATE POLICY workspace_isolation ON %s USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::bigint)$p$, t);
  END LOOP;
END $$;
