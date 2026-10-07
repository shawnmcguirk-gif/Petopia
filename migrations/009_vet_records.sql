-- =============================================================
-- Petopia DB -- 009: vet records, entered by hand (D1 spec sec 3.5, 7.2; slice S4; A17, A18).
-- Fact tables (provenance block via core.apply_provenance, append-only via core.append_only_guard, FORCE RLS):
--   health.vet_visit, vaccination, treatment, condition, allergy, procedure, lab_result, medication_event.
-- health.medication is a "thing" (product, strength, form): no provenance, soft-closed with retired_at.
-- The CURRENT medication list is never stored: the engine derives it from confirmed medication_event rows
-- (engine/src/medications.ts, as Vitalis currentRegimen) -- a STOPPED event takes a medicine off it.
-- A date a person may only half-remember carries <name>_precision (DAY / MONTH / YEAR, sec 3.2).
-- Lab values are kept exactly as printed (value_printed, ref_range_printed, flag_printed): Petopia never interprets
-- them. A row inserted by a Family member is PROPOSED until an Owner / Primary carer confirms it (sec 7.2).
-- Idempotent.
-- =============================================================

CREATE TABLE IF NOT EXISTS health.vet_visit (
  vet_visit_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id      bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id         bigint NOT NULL,
  visit_on          date NOT NULL,
  visit_precision   text NOT NULL DEFAULT 'DAY' CHECK (visit_precision IN ('DAY','MONTH','YEAR')),
  kind              text NOT NULL DEFAULT 'ROUTINE' CHECK (kind IN ('ROUTINE','ILLNESS','EMERGENCY','SURGERY','REFERRAL','FOLLOW_UP')),
  contact_id        bigint NULL,                     -- the clinic / practice
  vet_name          text NULL,                       -- the vet seen, as the person wrote it
  reason            text NULL,
  symptoms          text NULL,
  examination       text NULL,
  diagnosis_text    text NULL,                       -- the vet's words, never generated
  treatment_text    text NULL,
  follow_up_on      date NULL,
  cost_amount       numeric(12,2) NULL CHECK (cost_amount IS NULL OR cost_amount >= 0),
  cost_currency     text NULL CHECK (cost_currency IS NULL OR cost_currency ~ '^[A-Z]{3}$'),
  notes             text NULL,
  calendar_event_id text NULL,                       -- S6
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL,
  CONSTRAINT vet_visit_ws_id UNIQUE (workspace_id, vet_visit_id),
  CONSTRAINT vet_visit_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT vet_visit_contact_fk FOREIGN KEY (workspace_id, contact_id) REFERENCES core.contact(workspace_id, contact_id),
  CONSTRAINT vet_visit_cost_pair CHECK ((cost_amount IS NULL) = (cost_currency IS NULL)),
  CONSTRAINT vet_visit_follow_up CHECK (follow_up_on IS NULL OR follow_up_on >= visit_on)
);

CREATE TABLE IF NOT EXISTS health.vaccination (
  vaccination_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id        bigint NOT NULL,
  vaccine          text NOT NULL CHECK (length(trim(vaccine)) > 0),
  given_on         date NOT NULL,
  given_precision  text NOT NULL DEFAULT 'DAY' CHECK (given_precision IN ('DAY','MONTH','YEAR')),
  next_due_on      date NULL,                        -- only when the vet wrote one
  batch            text NULL,
  vet_visit_id     bigint NULL,
  notes            text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text NOT NULL,
  CONSTRAINT vaccination_ws_id UNIQUE (workspace_id, vaccination_id),
  CONSTRAINT vaccination_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT vaccination_visit_fk FOREIGN KEY (workspace_id, vet_visit_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id),
  CONSTRAINT vaccination_due CHECK (next_due_on IS NULL OR next_due_on > given_on)
);

CREATE TABLE IF NOT EXISTS health.treatment (
  treatment_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id        bigint NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('FLEA','WORM','TICK','DENTAL','OTHER')),
  product          text NULL,
  given_on         date NOT NULL,
  given_precision  text NOT NULL DEFAULT 'DAY' CHECK (given_precision IN ('DAY','MONTH','YEAR')),
  next_due_on      date NULL,
  vet_visit_id     bigint NULL,
  notes            text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text NOT NULL,
  CONSTRAINT treatment_ws_id UNIQUE (workspace_id, treatment_id),
  CONSTRAINT treatment_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT treatment_visit_fk FOREIGN KEY (workspace_id, vet_visit_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id),
  CONSTRAINT treatment_due CHECK (next_due_on IS NULL OR next_due_on > given_on)
);

CREATE TABLE IF NOT EXISTS health.condition (
  condition_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id          bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id             bigint NOT NULL,
  name                  text NOT NULL CHECK (length(trim(name)) > 0),
  condition_status      text NOT NULL CHECK (condition_status IN ('SUSPECTED','ACTIVE','RESOLVED')),
  first_noted_on        date NULL,
  first_noted_precision text NULL CHECK (first_noted_precision IN ('DAY','MONTH','YEAR')),
  vet_visit_id          bigint NULL,
  notes                 text NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text NOT NULL,
  CONSTRAINT condition_ws_id UNIQUE (workspace_id, condition_id),
  CONSTRAINT condition_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT condition_visit_fk FOREIGN KEY (workspace_id, vet_visit_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id),
  CONSTRAINT condition_date_pair CHECK ((first_noted_on IS NULL) = (first_noted_precision IS NULL))
);

CREATE TABLE IF NOT EXISTS health.allergy (
  allergy_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id     bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id        bigint NOT NULL,
  substance        text NOT NULL CHECK (length(trim(substance)) > 0),
  substance_kind   text NOT NULL DEFAULT 'OTHER' CHECK (substance_kind IN ('FOOD','DRUG','ENVIRONMENT','OTHER')),
  reaction         text NULL,
  certainty        text NOT NULL CHECK (certainty IN ('CONFIRMED_BY_VET','SUSPECTED')),
  noted_on         date NULL,
  noted_precision  text NULL CHECK (noted_precision IN ('DAY','MONTH','YEAR')),
  notes            text NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       text NOT NULL,
  CONSTRAINT allergy_ws_id UNIQUE (workspace_id, allergy_id),
  CONSTRAINT allergy_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT allergy_date_pair CHECK ((noted_on IS NULL) = (noted_precision IS NULL))
);

CREATE TABLE IF NOT EXISTS health.procedure (
  procedure_id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id        bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id           bigint NOT NULL,
  name                text NOT NULL CHECK (length(trim(name)) > 0),
  performed_on        date NOT NULL,
  performed_precision text NOT NULL DEFAULT 'DAY' CHECK (performed_precision IN ('DAY','MONTH','YEAR')),
  vet_visit_id        bigint NULL,
  outcome             text NULL,
  notes               text NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          text NOT NULL,
  CONSTRAINT procedure_ws_id UNIQUE (workspace_id, procedure_id),
  CONSTRAINT procedure_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT procedure_visit_fk FOREIGN KEY (workspace_id, vet_visit_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id)
);

CREATE TABLE IF NOT EXISTS health.lab_result (
  lab_result_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id      bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id         bigint NOT NULL,
  test              text NOT NULL CHECK (length(trim(test)) > 0),
  analyte           text NULL,
  value_printed     text NULL,
  unit_printed      text NULL,
  ref_range_printed text NULL,
  flag_printed      text NULL,
  sampled_on        date NOT NULL,
  sampled_precision text NOT NULL DEFAULT 'DAY' CHECK (sampled_precision IN ('DAY','MONTH','YEAR')),
  vet_visit_id      bigint NULL,
  notes             text NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        text NOT NULL,
  CONSTRAINT lab_result_ws_id UNIQUE (workspace_id, lab_result_id),
  CONSTRAINT lab_result_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT lab_result_visit_fk FOREIGN KEY (workspace_id, vet_visit_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id)
);

-- The medicine itself: a "thing", no provenance (sec 3.5).
CREATE TABLE IF NOT EXISTS health.medication (
  medication_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id     bigint NOT NULL,
  product_name  text NOT NULL CHECK (length(trim(product_name)) > 0),
  strength      text NULL,
  form          text NULL,
  retired_at    timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    text NOT NULL,
  CONSTRAINT medication_ws_id UNIQUE (workspace_id, medication_id),
  CONSTRAINT medication_ws_animal_id UNIQUE (workspace_id, animal_id, medication_id),
  CONSTRAINT medication_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id)
);

CREATE TABLE IF NOT EXISTS health.medication_event (
  medication_event_id   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id          bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id             bigint NOT NULL,
  medication_id         bigint NOT NULL,
  event_kind            text NOT NULL CHECK (event_kind IN ('PRESCRIBED','STARTED','DOSE_CHANGED','STOPPED')),
  event_on              date NOT NULL,
  event_precision       text NOT NULL DEFAULT 'DAY' CHECK (event_precision IN ('DAY','MONTH','YEAR')),
  dose_text             text NULL,
  dose_amount           numeric(10,3) NULL CHECK (dose_amount IS NULL OR dose_amount > 0),
  dose_unit             text NULL,
  frequency             text NULL,
  instructions_verbatim text NULL,
  reason                text NULL,
  prescriber_contact_id bigint NULL,
  quantity_supplied     numeric(10,2) NULL CHECK (quantity_supplied IS NULL OR quantity_supplied > 0),
  vet_visit_id          bigint NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  created_by            text NOT NULL,
  CONSTRAINT medication_event_ws_id UNIQUE (workspace_id, medication_event_id),
  -- the event belongs to the same animal as its medicine
  CONSTRAINT medication_event_med_fk FOREIGN KEY (workspace_id, animal_id, medication_id) REFERENCES health.medication(workspace_id, animal_id, medication_id),
  CONSTRAINT medication_event_prescriber_fk FOREIGN KEY (workspace_id, prescriber_contact_id) REFERENCES core.contact(workspace_id, contact_id),
  CONSTRAINT medication_event_visit_fk FOREIGN KEY (workspace_id, vet_visit_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id),
  CONSTRAINT medication_event_dose_pair CHECK ((dose_amount IS NULL) = (dose_unit IS NULL)),
  CONSTRAINT medication_event_dose_change CHECK (event_kind <> 'DOSE_CHANGED' OR dose_text IS NOT NULL OR dose_amount IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_medication_event_med ON health.medication_event (workspace_id, medication_id, event_on);

DO $$
DECLARE
  facts text[][] := ARRAY[
    ARRAY['health.vet_visit','vet_visit_id','calendar_event_id'],
    ARRAY['health.vaccination','vaccination_id',''],
    ARRAY['health.treatment','treatment_id',''],
    ARRAY['health.condition','condition_id',''],
    ARRAY['health.allergy','allergy_id',''],
    ARRAY['health.procedure','procedure_id',''],
    ARRAY['health.lab_result','lab_result_id',''],
    ARRAY['health.medication_event','medication_event_id','']
  ];
  i int;
  t text;
BEGIN
  FOR i IN 1 .. array_length(facts, 1) LOOP
    PERFORM core.apply_provenance(facts[i][1]::regclass, facts[i][2]);
    EXECUTE format('DROP TRIGGER IF EXISTS append_only_guard ON %s', facts[i][1]);
    IF facts[i][3] = '' THEN
      EXECUTE format('CREATE TRIGGER append_only_guard BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.append_only_guard()', facts[i][1]);
    ELSE
      EXECUTE format('CREATE TRIGGER append_only_guard BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION core.append_only_guard(%L)', facts[i][1], facts[i][3]);
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['health.vet_visit','health.vaccination','health.treatment','health.condition','health.allergy',
                           'health.procedure','health.lab_result','health.medication','health.medication_event'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON %s', t);
    EXECUTE format($p$CREATE POLICY workspace_isolation ON %s USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::bigint)$p$, t);
  END LOOP;
END $$;
