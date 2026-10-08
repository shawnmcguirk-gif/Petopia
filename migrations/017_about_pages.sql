-- =============================================================
-- Petopia DB -- 017: About pages, slice A1 (D2 spec sec 3.1, 3.2, 3.4, 3.5; docs/specs/D2-about-pages.md).
--   ref.normalise_kind   the ONE definition of "the same typed name" (SQL; the engine calls it, there is no TypeScript copy)
--   ref.resolve_kind     typed name -> species_id (name, alias, then the same minus one trailing "s"); NULL when no single match
--   ref.species_alias    other names for a species, stored already normalised; loaded from content/aliases.json
--   ref.species_about    researched pages, shared across households, versioned; loaded from content/about/*.json
--   write guards         both tables change only inside the content loader (SET LOCAL petopia.loader = 'on'); a guard against
--                        mistakes, not a security boundary (petopia_app owns the schema and runs the engine)
--   consent kind         core.consent_event.kind gains 'ABOUT_DRAFT' (used from slice A3)
--   animal.adopt_typed_kinds()  switches "Other animal" animals whose typed kind now matches a pet species; idempotent
-- Needs Postgres 13+ and a UTF8 database in a non-C locale (so accented letters count as letters): checked on the iMac 2026-10-08,
-- the values are recorded in docs/reviews/2026-10-08-about-a1-review.md. Idempotent (re-applied to petopia_test twice).
-- CHANGING ref.normalise_kind LATER needs a REINDEX of uq_species_normalised and a re-check of every stored alias: the index and the
-- alias CHECK were built with this definition, and Postgres does not revalidate them when the function body changes.
-- =============================================================

CREATE OR REPLACE FUNCTION ref.normalise_kind(t text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $fn$
  SELECT btrim(regexp_replace(
           regexp_replace(
             translate(lower(normalize(regexp_replace(t, '[[:space:][:cntrl:]]', ' ', 'g'), NFKC)), '-_/', '   '),
             '[^[:alnum:] ]', '', 'g'),
           ' +', ' ', 'g'))
$fn$;

-- Names are unique once normalised (016 only made them unique case-insensitively).
CREATE UNIQUE INDEX IF NOT EXISTS uq_species_normalised ON ref.species (ref.normalise_kind(common_name));

CREATE TABLE IF NOT EXISTS ref.species_alias (
  alias       text PRIMARY KEY CHECK (alias <> '' AND alias = ref.normalise_kind(alias) AND length(alias) BETWEEN 2 AND 80),
  species_id  bigint NOT NULL REFERENCES ref.species(species_id)
);

CREATE TABLE IF NOT EXISTS ref.species_about (
  about_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  species_id    bigint NOT NULL REFERENCES ref.species(species_id),
  version       integer NOT NULL CHECK (version > 0),
  sections      jsonb   NOT NULL CHECK (jsonb_typeof(sections) = 'object'),
  checked_on    date    NOT NULL,
  written_by    text    NOT NULL,
  reviewed_by   text    NULL,
  content_hash  text    NOT NULL,
  retired_at    timestamptz NULL,
  loaded_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (species_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_species_about_live ON ref.species_about (species_id) WHERE retired_at IS NULL;

-- Resolve a typed name to a species (sec 3.4 steps 1-2). Skips the "Other animal" placeholder (by name: Goat, Sheep and Pig also use module 'other'). A step that finds
-- more than one species is skipped as "no match" (only the stripped forms can collide). The caller checks domain / module.
CREATE OR REPLACE FUNCTION ref.resolve_kind(typed text) RETURNS bigint
LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  n text := ref.normalise_kind(typed);
  s text;
  ids bigint[];
BEGIN
  IF n = '' THEN RETURN NULL; END IF;
  s := CASE WHEN length(n) > 3 AND n LIKE '%s' AND n NOT LIKE '%ss' THEN left(n, -1) END;
  SELECT array_agg(species_id) INTO ids FROM ref.species WHERE ref.normalise_kind(common_name) = n AND common_name <> 'Other animal';
  IF cardinality(ids) = 1 THEN RETURN ids[1]; END IF;
  SELECT array_agg(a.species_id) INTO ids FROM ref.species_alias a JOIN ref.species sp USING (species_id) WHERE a.alias = n AND sp.common_name <> 'Other animal';
  IF cardinality(ids) = 1 THEN RETURN ids[1]; END IF;
  IF s IS NOT NULL THEN
    SELECT array_agg(species_id) INTO ids FROM ref.species WHERE ref.normalise_kind(common_name) = s AND common_name <> 'Other animal';
    IF cardinality(ids) = 1 THEN RETURN ids[1]; END IF;
    SELECT array_agg(a.species_id) INTO ids FROM ref.species_alias a JOIN ref.species sp USING (species_id) WHERE a.alias = s AND sp.common_name <> 'Other animal';
    IF cardinality(ids) = 1 THEN RETURN ids[1]; END IF;
  END IF;
  RETURN NULL;
END $fn$;

-- ---- write guards and clash triggers (DROP IF EXISTS + CREATE, the 007 pattern, so re-running is safe)
CREATE OR REPLACE FUNCTION ref.loader_guard() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF coalesce(current_setting('petopia.loader', true), '') <> 'on' THEN
    RAISE EXCEPTION 'this reference table is changed only by the content loader' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS species_about_loader_guard ON ref.species_about;
CREATE TRIGGER species_about_loader_guard BEFORE INSERT OR UPDATE OR DELETE ON ref.species_about FOR EACH ROW EXECUTE FUNCTION ref.loader_guard();
DROP TRIGGER IF EXISTS species_alias_loader_guard ON ref.species_alias;
CREATE TRIGGER species_alias_loader_guard BEFORE INSERT OR UPDATE OR DELETE ON ref.species_alias FOR EACH ROW EXECUTE FUNCTION ref.loader_guard();
-- TRUNCATE skips row triggers, so it gets its own statement-level guard
CREATE OR REPLACE FUNCTION ref.loader_guard_truncate() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF coalesce(current_setting('petopia.loader', true), '') <> 'on' THEN
    RAISE EXCEPTION 'this reference table is changed only by the content loader' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $fn$;
DROP TRIGGER IF EXISTS species_about_truncate_guard ON ref.species_about;
CREATE TRIGGER species_about_truncate_guard BEFORE TRUNCATE ON ref.species_about FOR EACH STATEMENT EXECUTE FUNCTION ref.loader_guard_truncate();
DROP TRIGGER IF EXISTS species_alias_truncate_guard ON ref.species_alias;
CREATE TRIGGER species_alias_truncate_guard BEFORE TRUNCATE ON ref.species_alias FOR EACH STATEMENT EXECUTE FUNCTION ref.loader_guard_truncate();

CREATE OR REPLACE FUNCTION ref.species_alias_clash() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM ref.species WHERE ref.normalise_kind(common_name) = NEW.alias AND species_id <> NEW.species_id) THEN
    RAISE EXCEPTION 'alias "%" is the name of another species', NEW.alias USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM ref.species WHERE species_id = NEW.species_id AND common_name = 'Other animal') THEN
    RAISE EXCEPTION 'the "Other animal" placeholder cannot have aliases' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS species_alias_clash ON ref.species_alias;
CREATE TRIGGER species_alias_clash BEFORE INSERT OR UPDATE ON ref.species_alias FOR EACH ROW EXECUTE FUNCTION ref.species_alias_clash();

CREATE OR REPLACE FUNCTION ref.species_name_clash() RETURNS trigger LANGUAGE plpgsql AS $fn$
BEGIN
  IF EXISTS (SELECT 1 FROM ref.species_alias WHERE alias = ref.normalise_kind(NEW.common_name) AND species_id <> NEW.species_id) THEN
    RAISE EXCEPTION 'species name "%" is already an alias of another species', NEW.common_name USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $fn$;
DROP TRIGGER IF EXISTS species_name_clash ON ref.species;
CREATE TRIGGER species_name_clash BEFORE INSERT OR UPDATE OF common_name ON ref.species FOR EACH ROW EXECUTE FUNCTION ref.species_name_clash();

-- ---- consent kind: the CHECK was created inline, so find it by what it says
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint
   WHERE conrelid = 'core.consent_event'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%AI_READING%';
  IF c IS NOT NULL AND (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = c AND conrelid = 'core.consent_event'::regclass) NOT LIKE '%ABOUT_DRAFT%' THEN
    EXECUTE format('ALTER TABLE core.consent_event DROP CONSTRAINT %I', c);
    ALTER TABLE core.consent_event ADD CONSTRAINT consent_event_kind_check CHECK (kind IN ('FOLDER_READ','AI_READING','ABOUT_DRAFT'));
  END IF;
END $$;

-- ---- adopt "Other animal" animals whose typed kind now matches a pet species (sec 3.5)
-- animal.animal and core.workspace are FORCE-RLS, so with no household set nothing is visible: loop the workspace ids and set each.
CREATE OR REPLACE FUNCTION animal.adopt_typed_kinds() RETURNS integer LANGUAGE plpgsql AS $fn$
DECLARE
  seq text := pg_get_serial_sequence('core.workspace', 'workspace_id');
  lastv bigint; called boolean; ws bigint; n integer := 0;
  a record; sid bigint; sp record;
BEGIN
  EXECUTE format('SELECT last_value, is_called FROM %s', seq) INTO lastv, called;
  IF NOT called THEN RETURN 0; END IF;
  FOR ws IN 1..lastv LOOP
    PERFORM set_config('app.current_workspace_id', ws::text, true);
    FOR a IN SELECT animal_id, ext->>'species_name' AS typed FROM animal.animal
              WHERE module_code = 'other' AND coalesce(ext->>'species_name', '') <> ''
                AND species_id = (SELECT species_id FROM ref.species WHERE common_name = 'Other animal') ORDER BY animal_id LOOP
      sid := ref.resolve_kind(a.typed);
      CONTINUE WHEN sid IS NULL;
      SELECT s.species_id, s.common_name, s.module_code, m.schema_version INTO sp
        FROM ref.species s JOIN ref.species_module m ON m.code = s.module_code
       WHERE s.species_id = sid AND s.domain IN ('PET', 'BOTH') AND s.module_code IS NOT NULL;
      CONTINUE WHEN sp.species_id IS NULL;
      UPDATE animal.animal SET species_id = sp.species_id, module_code = sp.module_code, ext_schema_version = sp.schema_version,
             ext = ext - 'species_name', updated_at = now()
       WHERE animal_id = a.animal_id;
      n := n + 1;
      RAISE NOTICE 'adopt_typed_kinds: household %, animal %, "%" is now %', ws, a.animal_id, a.typed, sp.common_name;
    END LOOP;
  END LOOP;
  PERFORM set_config('app.current_workspace_id', '', true);
  RETURN n;
END $fn$;

SELECT animal.adopt_typed_kinds();
