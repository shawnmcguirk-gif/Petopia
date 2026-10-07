-- =============================================================
-- Petopia DB -- 006: animals and the per-animal roles (D1 spec sec 3.3, 3.7, 7; A5, A6).
-- One animal.animal table for every animal; species-specific fields live in `ext`, validated in the engine by
-- ajv against ref.species_module.schema (the DB keeps the version it was validated against). Age is never
-- stored: it is computed from born_on + born_precision. health_status is set by a person (Owner / Primary
-- carer), never computed, and stays NULL until someone sets it (sec 9.3).
-- core.animal_role: OWNER / PRIMARY_CARER / FAMILY / VIEWER. A member with household access and no role on an
-- animal is treated as FAMILY by the engine (sec 7.1). The last-Owner rule is enforced in engine/src/access.ts
-- under a row lock (Vitalis last-manager pattern). FORCE RLS, fail-closed. Idempotent.
-- =============================================================
CREATE TABLE IF NOT EXISTS animal.animal (
  animal_id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id         bigint NOT NULL REFERENCES core.workspace(workspace_id),
  name                 text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  nickname             text NULL,
  species_id           bigint NOT NULL REFERENCES ref.species(species_id),
  breed                text NULL,
  module_code          text NOT NULL REFERENCES ref.species_module(code),
  ext                  jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(ext) = 'object'),
  ext_schema_version   integer NOT NULL CHECK (ext_schema_version > 0),
  sex                  text NOT NULL DEFAULT 'UNKNOWN' CHECK (sex IN ('FEMALE','MALE','UNKNOWN')),
  neuter_status        text NOT NULL DEFAULT 'UNKNOWN' CHECK (neuter_status IN ('NEUTERED','ENTIRE','UNKNOWN')),
  colour_markings      text NULL,
  born_on              date NULL,
  born_precision       text NOT NULL DEFAULT 'UNKNOWN' CHECK (born_precision IN ('DAY','MONTH','YEAR','UNKNOWN')),
  acquired_on          date NULL,
  acquired_precision   text NOT NULL DEFAULT 'UNKNOWN' CHECK (acquired_precision IN ('DAY','MONTH','YEAR','UNKNOWN')),
  source               text NULL,
  microchip            text NULL CHECK (microchip IS NULL OR microchip ~ '^[0-9A-Za-z]{6,23}$'),
  registration         text NULL,
  vet_contact_id       bigint NULL,
  emergency_contact_id bigint NULL,
  habitat_id           bigint NULL,
  profile_media_id     bigint NULL,
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','REHOMED','DECEASED')),
  status_on            date NULL,
  kind                 text NOT NULL DEFAULT 'PET' CHECK (kind IN ('PET','CARED_FOR')),
  health_status        text NULL CHECK (health_status IN ('HEALTHY','UNDER_TREATMENT','NEEDS_ATTENTION')),
  health_status_by     text NULL,
  health_status_at     timestamptz NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           text NOT NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT animal_ws_id UNIQUE (workspace_id, animal_id),
  CONSTRAINT animal_born_pair CHECK ((born_on IS NULL) = (born_precision = 'UNKNOWN')),
  CONSTRAINT animal_acquired_pair CHECK ((acquired_on IS NULL) = (acquired_precision = 'UNKNOWN')),
  CONSTRAINT animal_status_on CHECK (status = 'ACTIVE' OR status_on IS NOT NULL),
  CONSTRAINT animal_health_status_by CHECK (health_status IS NULL OR (health_status_by IS NOT NULL AND health_status_at IS NOT NULL)),
  CONSTRAINT animal_vet_fk FOREIGN KEY (workspace_id, vet_contact_id) REFERENCES core.contact(workspace_id, contact_id),
  CONSTRAINT animal_emergency_fk FOREIGN KEY (workspace_id, emergency_contact_id) REFERENCES core.contact(workspace_id, contact_id),
  CONSTRAINT animal_habitat_fk FOREIGN KEY (workspace_id, habitat_id) REFERENCES core.habitat(workspace_id, habitat_id),
  CONSTRAINT animal_photo_fk FOREIGN KEY (workspace_id, profile_media_id) REFERENCES media.item(workspace_id, media_item_id)
);
-- The microchip is the strongest key for matching documents: unique per household when present.
CREATE UNIQUE INDEX IF NOT EXISTS uq_animal_microchip ON animal.animal (workspace_id, upper(microchip)) WHERE microchip IS NOT NULL;

CREATE TABLE IF NOT EXISTS core.animal_role (
  animal_role_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id   bigint NOT NULL REFERENCES core.workspace(workspace_id),
  animal_id      bigint NOT NULL,
  member_name    text NOT NULL CHECK (length(trim(member_name)) > 0),
  role           text NOT NULL CHECK (role IN ('OWNER','PRIMARY_CARER','FAMILY','VIEWER')),
  from_on        date NOT NULL DEFAULT current_date,
  to_on          date NULL,
  set_by         text NOT NULL,
  set_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT animal_role_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id),
  CONSTRAINT animal_role_dates CHECK (to_on IS NULL OR to_on >= from_on)
);
-- One current role per member per animal; history rows (to_on set) are kept.
CREATE UNIQUE INDEX IF NOT EXISTS uq_animal_role_current ON core.animal_role (workspace_id, animal_id, member_name) WHERE to_on IS NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['animal.animal','core.animal_role'] LOOP
    EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS workspace_isolation ON %s', t);
    EXECUTE format($p$CREATE POLICY workspace_isolation ON %s USING (workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::bigint)$p$, t);
  END LOOP;
END $$;
