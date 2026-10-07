-- =============================================================
-- Petopia DB -- 012: routines, the shared care log, vet appointments (D1 spec sec 3.5, 6, 9.3; slice S6; A22-A25)
-- and the member's Synapse persona (for the calendar).
--   care.routine      feed, walk, groom, flea, worm, vaccination, medication ...: a small RRULE subset (DAILY, WEEKLY
--                     [+BYDAY], MONTHLY, YEARLY, with INTERVAL), anchored at active_from, with times of day. Where it
--                     came from: a species default, a medicine, a vet's advice (linked), or a person. Non-clinical, so
--                     soft-closed with retired_at (sec 3.2). Today / Coming Up are DERIVED from these, never stored.
--   care.log          "Fed", "Walked", "Medication given": who and when. One row per occurrence a routine asked for --
--                     the unique key makes a second tap on another phone a no-op, not a second row. Insert-only.
--   care.appointment  a booked vet appointment (a plan, not a fact: Vitalis plan.visit). It can be moved or cancelled;
--                     each change is sent to the Synapse calendar via /webhook/events (engine/src/calendar.ts).
-- FORCE RLS, fail-closed. Idempotent.
-- =============================================================
CREATE SCHEMA IF NOT EXISTS care;
REVOKE ALL ON SCHEMA care FROM PUBLIC;

-- Synapse's persona_key for a member, recorded when they open Petopia (verify-device returns it), so a vet appointment
-- can go on the Primary carer's calendar even when someone else books it.
ALTER TABLE core.member ADD COLUMN IF NOT EXISTS persona_key text NULL;

CREATE TABLE IF NOT EXISTS care.routine (
  routine_id     bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id      bigint NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('FEED','WALK','GROOM','BATH','NAILS','TEETH','EARS','MEDICATION','FLEA','WORM','VACCINATION','TANK_CLEAN','WATER_TEST','CAGE_CLEAN','BEDDING','FEEDER_REFILL','OTHER')),
  title          text NULL,
  rrule          text NOT NULL CHECK (rrule ~ '^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;INTERVAL=[1-9][0-9]{0,2})?(;BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU)){0,6})?$'),
  times          text[] NOT NULL DEFAULT '{}',        -- 'HH:MM', Europe/Dublin wall clock
  medication_id  bigint NULL,
  doses_per_time numeric(8,2) NULL CHECK (doses_per_time IS NULL OR doses_per_time > 0),
  assigned_to    text NULL,
  remind         text NOT NULL DEFAULT 'TODAY' CHECK (remind IN ('NONE','TODAY')),
  origin         text NOT NULL CHECK (origin IN ('SPECIES_DEFAULT','MEDICATION','VET_ADVICE','MANUAL')),
  source_table   text NULL CHECK (source_table IS NULL OR source_table IN ('vaccination','treatment','vet_visit','medication_event')),
  source_id      bigint NULL,
  active_from    date NOT NULL,
  active_to      date NULL,
  retired_at     timestamptz NULL,
  retired_by     text NULL,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT routine_ws_id UNIQUE (workspace_id, routine_id),
  CONSTRAINT routine_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT routine_med_fk FOREIGN KEY (workspace_id, animal_id, medication_id) REFERENCES health.medication(workspace_id, animal_id, medication_id),
  CONSTRAINT routine_med_kind CHECK ((kind = 'MEDICATION') = (medication_id IS NOT NULL)),
  CONSTRAINT routine_vet_advice_source CHECK (origin <> 'VET_ADVICE' OR (source_table IS NOT NULL AND source_id IS NOT NULL)),
  CONSTRAINT routine_source_pair CHECK ((source_table IS NULL) = (source_id IS NULL)),
  CONSTRAINT routine_dates CHECK (active_to IS NULL OR active_to >= active_from),
  CONSTRAINT routine_retired_pair CHECK ((retired_at IS NULL) = (retired_by IS NULL)),
  CONSTRAINT routine_times CHECK (array_to_string(times, ',') ~ '^(([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9]){0,11})?$')
);

CREATE TABLE IF NOT EXISTS care.log (
  log_id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id bigint NOT NULL REFERENCES core.workspace(workspace_id),
  routine_id   bigint NULL,
  animal_id    bigint NOT NULL,
  kind         text NOT NULL,
  due_on       date NULL,                    -- the occurrence this ticks off (null for an unplanned "walked her")
  due_slot     text NOT NULL DEFAULT '',     -- its time of day 'HH:MM', or '' for a routine without times
  done_at      timestamptz NOT NULL DEFAULT now(),
  done_by      text NOT NULL,
  amount       numeric(8,2) NULL CHECK (amount IS NULL OR amount > 0), -- doses given (medication supply)
  note         text NULL,
  CONSTRAINT log_ws_id UNIQUE (workspace_id, log_id),
  CONSTRAINT log_routine_fk FOREIGN KEY (workspace_id, routine_id) REFERENCES care.routine(workspace_id, routine_id),
  CONSTRAINT log_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT log_due_needs_routine CHECK (due_on IS NULL OR routine_id IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_log_occurrence ON care.log (workspace_id, routine_id, due_on, due_slot) WHERE routine_id IS NOT NULL AND due_on IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_log_animal ON care.log (workspace_id, animal_id, done_at DESC);
DROP TRIGGER IF EXISTS insert_only_guard ON care.log;
CREATE TRIGGER insert_only_guard BEFORE UPDATE OR DELETE ON care.log FOR EACH ROW EXECUTE FUNCTION core.insert_only_guard();

CREATE TABLE IF NOT EXISTS care.appointment (
  appointment_id    bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id      bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id         bigint NOT NULL,
  starts_on         date NOT NULL,
  starts_time       text NULL CHECK (starts_time IS NULL OR starts_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  contact_id        bigint NULL,
  reason            text NULL,
  state             text NOT NULL DEFAULT 'BOOKED' CHECK (state IN ('BOOKED','CANCELLED')),
  calendar_event_id bigint NULL,
  calendar_state    text NULL CHECK (calendar_state IS NULL OR calendar_state IN ('SAVED','ON_GOOGLE','FAILED')),
  calendar_persona  text NULL,              -- whose calendar it went on
  created_by        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        text NOT NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointment_ws_id UNIQUE (workspace_id, appointment_id),
  CONSTRAINT appointment_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT appointment_contact_fk FOREIGN KEY (workspace_id, contact_id) REFERENCES core.contact(workspace_id, contact_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['care.routine','care.log','care.appointment'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON %s', t);
    EXECUTE format($p$CREATE POLICY workspace_isolation ON %s USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::bigint)$p$, t);
  END LOOP;
END $$;
