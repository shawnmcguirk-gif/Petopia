-- =============================================================
-- Petopia DB -- 008: feeding and measurements (D1 spec sec 3.2, 3.5, 9.4 "Weight"; slice S3; A15, A16).
--   ref.measure / ref.measure_unit  the measurement registry: weight (kg), length + height (cm), body condition
--                                   score (/9 or /5). The engine (engine/src/measures.ts) holds the conversions and the
--                                   plausibility question; test/feeding-weight.db.test.ts fails if the two drift.
--   health.measurement              one reading of an animal (or, later, a habitat): stored in the registry's unit
--                                   plus exactly what the person typed. Provenance block (fact table).
--   diet.feeding_plan               what an animal eats. History is kept: a change of food closes the old row with
--                                   an end date (to_on = the day the new food started) and inserts a new one.
-- Facts are append-only (sec 3.2 "never delete clinical facts"): core.append_only_guard refuses DELETE and any UPDATE
-- other than the status flow (status/confirmed_by/confirmed_at) and the columns named in the trigger's arguments
-- (feeding_plan: to_on, which can be set once and never moved again). FORCE RLS, fail-closed. Idempotent.
-- =============================================================
CREATE SCHEMA IF NOT EXISTS health;
CREATE SCHEMA IF NOT EXISTS diet;
REVOKE ALL ON SCHEMA health, diet FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE keep text[] := ARRAY['status','confirmed_by','confirmed_at'] || TG_ARGV;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'records are never deleted; mark one "not right" or correct it instead' USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - keep) IS DISTINCT FROM (to_jsonb(OLD) - keep) THEN
    RAISE EXCEPTION 'a recorded fact is never changed in place; correct it with a new row' USING ERRCODE = 'check_violation';
  END IF;
  IF 'to_on' = ANY (TG_ARGV) AND (to_jsonb(OLD)->>'to_on') IS NOT NULL AND (to_jsonb(NEW)->>'to_on') IS DISTINCT FROM (to_jsonb(OLD)->>'to_on') THEN
    RAISE EXCEPTION 'an ended entry stays ended' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;

-- ---- the registry (shared reference data: no workspace, no RLS) ----
CREATE TABLE IF NOT EXISTS ref.measure (
  code           text PRIMARY KEY CHECK (code ~ '^[a-z_]+$'),
  label          text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('MASS','LENGTH','SCORE')),
  accepted_units text[] NOT NULL
);
CREATE TABLE IF NOT EXISTS ref.measure_unit (      -- the unit(s) a value may be STORED in
  measure text NOT NULL REFERENCES ref.measure(code),
  unit    text NOT NULL,
  PRIMARY KEY (measure, unit)
);
INSERT INTO ref.measure (code, label, kind, accepted_units) VALUES
  ('weight', 'Weight', 'MASS', ARRAY['kg','g','lb']),
  ('length', 'Length', 'LENGTH', ARRAY['cm','mm','in']),
  ('height', 'Height', 'LENGTH', ARRAY['cm','mm','in']),
  ('bcs', 'Body condition score', 'SCORE', ARRAY['/9','/5'])
  ON CONFLICT (code) DO NOTHING;
INSERT INTO ref.measure_unit (measure, unit) VALUES
  ('weight', 'kg'), ('length', 'cm'), ('height', 'cm'), ('bcs', '/9'), ('bcs', '/5')
  ON CONFLICT DO NOTHING;

-- ---- health.measurement (fact) ----
CREATE TABLE IF NOT EXISTS health.measurement (
  measurement_id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id            bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id               bigint NULL,
  habitat_id              bigint NULL,
  measure                 text NOT NULL,
  value                   numeric(9,3) NOT NULL CHECK (value > 0),
  unit                    text NOT NULL,
  value_as_entered        text NOT NULL,
  unit_as_entered         text NOT NULL,
  observed_at             timestamptz NOT NULL,
  time_precision          text NOT NULL DEFAULT 'DAY' CHECK (time_precision IN ('EXACT','DAY')),
  plausibility_confirmed  boolean NOT NULL DEFAULT false, -- the person answered "yes, that's right" to the question
  note                    text NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              text NOT NULL,
  CONSTRAINT measurement_ws_id UNIQUE (workspace_id, measurement_id),
  CONSTRAINT measurement_one_subject CHECK ((animal_id IS NULL) <> (habitat_id IS NULL)),
  CONSTRAINT measurement_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT measurement_habitat_fk FOREIGN KEY (workspace_id, habitat_id) REFERENCES core.habitat(workspace_id, habitat_id),
  CONSTRAINT measurement_unit_fk FOREIGN KEY (measure, unit) REFERENCES ref.measure_unit(measure, unit)
);
CREATE INDEX IF NOT EXISTS idx_measurement_animal ON health.measurement (workspace_id, animal_id, measure, observed_at DESC);
SELECT core.apply_provenance('health.measurement', 'measurement_id');

-- ---- diet.feeding_plan (fact, history kept) ----
CREATE TABLE IF NOT EXISTS diet.feeding_plan (
  feeding_plan_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id    bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id       bigint NOT NULL,
  brand           text NULL,
  product         text NULL,
  food_type       text NOT NULL CHECK (food_type IN ('DRY','WET','RAW','MIXED','PELLET','FLAKE','HAY','LIVE','OTHER')),
  portion_amount  numeric(8,2) NULL CHECK (portion_amount IS NULL OR portion_amount > 0),
  portion_unit    text NULL CHECK (portion_unit IN ('g','kg','ml','cup','can','pouch','scoop','tbsp','piece')),
  times           text[] NOT NULL DEFAULT '{}' CHECK (array_to_string(times, ',') ~ '^(([01][0-9]|2[0-3]):[0-5][0-9](,|$))*$'),
  from_on         date NOT NULL,
  to_on           date NULL,                       -- the day the next food started; NULL = current
  objective       text NULL,
  notes           text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      text NOT NULL,
  CONSTRAINT feeding_plan_ws_id UNIQUE (workspace_id, feeding_plan_id),
  CONSTRAINT feeding_plan_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT feeding_plan_names CHECK (coalesce(trim(brand), '') <> '' OR coalesce(trim(product), '') <> ''),
  CONSTRAINT feeding_plan_portion_pair CHECK ((portion_amount IS NULL) = (portion_unit IS NULL)),
  CONSTRAINT feeding_plan_dates CHECK (to_on IS NULL OR to_on >= from_on)
);
SELECT core.apply_provenance('diet.feeding_plan', 'feeding_plan_id');
-- At most one current (confirmed, not ended) food per animal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_feeding_plan_current ON diet.feeding_plan (workspace_id, animal_id) WHERE to_on IS NULL AND status = 'CONFIRMED';

DROP TRIGGER IF EXISTS append_only_guard ON health.measurement;
CREATE TRIGGER append_only_guard BEFORE UPDATE OR DELETE ON health.measurement FOR EACH ROW EXECUTE FUNCTION core.append_only_guard();
DROP TRIGGER IF EXISTS append_only_guard ON diet.feeding_plan;
CREATE TRIGGER append_only_guard BEFORE UPDATE OR DELETE ON diet.feeding_plan FOR EACH ROW EXECUTE FUNCTION core.append_only_guard('to_on');

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['health.measurement','diet.feeding_plan'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON %s', t);
    EXECUTE format($p$CREATE POLICY workspace_isolation ON %s USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::bigint)$p$, t);
  END LOOP;
END $$;
