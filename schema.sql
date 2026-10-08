--
-- PostgreSQL database dump
--

\restrict LUQlqbYOYpSHUa4s5hcLnbjsq4cTA0btBQ19VMxbsWuapp1osPRkv30I1kr26tH

-- Dumped from database version 16.14 (Debian 16.14-1.pgdg12+1)
-- Dumped by pg_dump version 16.14 (Debian 16.14-1.pgdg12+1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: animal; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA animal;


--
-- Name: care; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA care;


--
-- Name: core; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA core;


--
-- Name: diet; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA diet;


--
-- Name: health; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA health;


--
-- Name: ingest; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA ingest;


--
-- Name: media; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA media;


--
-- Name: ref; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA ref;


--
-- Name: timeline; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA timeline;


--
-- Name: append_only_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.append_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
END $$;


--
-- Name: apply_provenance(regclass, text); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.apply_provenance(target regclass, pk text) RETURNS void
    LANGUAGE plpgsql
    AS $_$
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
END $_$;


--
-- Name: insert_only_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.insert_only_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'this record is never changed or deleted' USING ERRCODE = 'check_violation';
END $$;


--
-- Name: provenance_guard(); Type: FUNCTION; Schema: core; Owner: -
--

CREATE FUNCTION core.provenance_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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
END $$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: animal; Type: TABLE; Schema: animal; Owner: -
--

CREATE TABLE animal.animal (
    animal_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    name text NOT NULL,
    nickname text,
    species_id bigint NOT NULL,
    breed text,
    module_code text NOT NULL,
    ext jsonb DEFAULT '{}'::jsonb NOT NULL,
    ext_schema_version integer NOT NULL,
    sex text DEFAULT 'UNKNOWN'::text NOT NULL,
    neuter_status text DEFAULT 'UNKNOWN'::text NOT NULL,
    colour_markings text,
    born_on date,
    born_precision text DEFAULT 'UNKNOWN'::text NOT NULL,
    acquired_on date,
    acquired_precision text DEFAULT 'UNKNOWN'::text NOT NULL,
    source text,
    microchip text,
    registration text,
    vet_contact_id bigint,
    emergency_contact_id bigint,
    habitat_id bigint,
    profile_media_id bigint,
    status text DEFAULT 'ACTIVE'::text NOT NULL,
    status_on date,
    kind text DEFAULT 'PET'::text NOT NULL,
    health_status text,
    health_status_by text,
    health_status_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT animal_acquired_pair CHECK (((acquired_on IS NULL) = (acquired_precision = 'UNKNOWN'::text))),
    CONSTRAINT animal_acquired_precision_check CHECK ((acquired_precision = ANY (ARRAY['DAY'::text, 'MONTH'::text, 'YEAR'::text, 'UNKNOWN'::text]))),
    CONSTRAINT animal_born_pair CHECK (((born_on IS NULL) = (born_precision = 'UNKNOWN'::text))),
    CONSTRAINT animal_born_precision_check CHECK ((born_precision = ANY (ARRAY['DAY'::text, 'MONTH'::text, 'YEAR'::text, 'UNKNOWN'::text]))),
    CONSTRAINT animal_ext_check CHECK ((jsonb_typeof(ext) = 'object'::text)),
    CONSTRAINT animal_ext_schema_version_check CHECK ((ext_schema_version > 0)),
    CONSTRAINT animal_health_status_by CHECK (((health_status IS NULL) OR ((health_status_by IS NOT NULL) AND (health_status_at IS NOT NULL)))),
    CONSTRAINT animal_health_status_check CHECK ((health_status = ANY (ARRAY['HEALTHY'::text, 'UNDER_TREATMENT'::text, 'NEEDS_ATTENTION'::text]))),
    CONSTRAINT animal_kind_check CHECK ((kind = ANY (ARRAY['PET'::text, 'CARED_FOR'::text]))),
    CONSTRAINT animal_microchip_check CHECK (((microchip IS NULL) OR (microchip ~ '^[0-9A-Za-z]{6,23}$'::text))),
    CONSTRAINT animal_name_check CHECK (((length(TRIM(BOTH FROM name)) >= 1) AND (length(TRIM(BOTH FROM name)) <= 80))),
    CONSTRAINT animal_neuter_status_check CHECK ((neuter_status = ANY (ARRAY['NEUTERED'::text, 'ENTIRE'::text, 'UNKNOWN'::text]))),
    CONSTRAINT animal_sex_check CHECK ((sex = ANY (ARRAY['FEMALE'::text, 'MALE'::text, 'UNKNOWN'::text]))),
    CONSTRAINT animal_status_check CHECK ((status = ANY (ARRAY['ACTIVE'::text, 'REHOMED'::text, 'DECEASED'::text]))),
    CONSTRAINT animal_status_on CHECK (((status = 'ACTIVE'::text) OR (status_on IS NOT NULL)))
);

ALTER TABLE ONLY animal.animal FORCE ROW LEVEL SECURITY;


--
-- Name: animal_animal_id_seq; Type: SEQUENCE; Schema: animal; Owner: -
--

ALTER TABLE animal.animal ALTER COLUMN animal_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME animal.animal_animal_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: appointment; Type: TABLE; Schema: care; Owner: -
--

CREATE TABLE care.appointment (
    appointment_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    starts_on date NOT NULL,
    starts_time text,
    contact_id bigint,
    reason text,
    state text DEFAULT 'BOOKED'::text NOT NULL,
    calendar_event_id bigint,
    calendar_state text,
    calendar_persona text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT appointment_calendar_state_check CHECK (((calendar_state IS NULL) OR (calendar_state = ANY (ARRAY['SAVED'::text, 'ON_GOOGLE'::text, 'FAILED'::text])))),
    CONSTRAINT appointment_starts_time_check CHECK (((starts_time IS NULL) OR (starts_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'::text))),
    CONSTRAINT appointment_state_check CHECK ((state = ANY (ARRAY['BOOKED'::text, 'CANCELLED'::text])))
);

ALTER TABLE ONLY care.appointment FORCE ROW LEVEL SECURITY;


--
-- Name: appointment_appointment_id_seq; Type: SEQUENCE; Schema: care; Owner: -
--

ALTER TABLE care.appointment ALTER COLUMN appointment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME care.appointment_appointment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: log; Type: TABLE; Schema: care; Owner: -
--

CREATE TABLE care.log (
    log_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    routine_id bigint,
    animal_id bigint NOT NULL,
    kind text NOT NULL,
    due_on date,
    due_slot text DEFAULT ''::text NOT NULL,
    done_at timestamp with time zone DEFAULT now() NOT NULL,
    done_by text NOT NULL,
    amount numeric(8,2),
    note text,
    CONSTRAINT log_amount_check CHECK (((amount IS NULL) OR (amount > (0)::numeric))),
    CONSTRAINT log_due_needs_routine CHECK (((due_on IS NULL) OR (routine_id IS NOT NULL)))
);

ALTER TABLE ONLY care.log FORCE ROW LEVEL SECURITY;


--
-- Name: log_log_id_seq; Type: SEQUENCE; Schema: care; Owner: -
--

ALTER TABLE care.log ALTER COLUMN log_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME care.log_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: routine; Type: TABLE; Schema: care; Owner: -
--

CREATE TABLE care.routine (
    routine_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    kind text NOT NULL,
    title text,
    rrule text NOT NULL,
    times text[] DEFAULT '{}'::text[] NOT NULL,
    medication_id bigint,
    doses_per_time numeric(8,2),
    assigned_to text,
    remind text DEFAULT 'TODAY'::text NOT NULL,
    origin text NOT NULL,
    source_table text,
    source_id bigint,
    active_from date NOT NULL,
    active_to date,
    retired_at timestamp with time zone,
    retired_by text,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT routine_dates CHECK (((active_to IS NULL) OR (active_to >= active_from))),
    CONSTRAINT routine_doses_per_time_check CHECK (((doses_per_time IS NULL) OR (doses_per_time > (0)::numeric))),
    CONSTRAINT routine_kind_check CHECK ((kind = ANY (ARRAY['FEED'::text, 'WALK'::text, 'GROOM'::text, 'BATH'::text, 'NAILS'::text, 'TEETH'::text, 'EARS'::text, 'MEDICATION'::text, 'FLEA'::text, 'WORM'::text, 'VACCINATION'::text, 'TANK_CLEAN'::text, 'WATER_TEST'::text, 'CAGE_CLEAN'::text, 'BEDDING'::text, 'FEEDER_REFILL'::text, 'OTHER'::text]))),
    CONSTRAINT routine_med_kind CHECK (((kind = 'MEDICATION'::text) = (medication_id IS NOT NULL))),
    CONSTRAINT routine_origin_check CHECK ((origin = ANY (ARRAY['SPECIES_DEFAULT'::text, 'MEDICATION'::text, 'VET_ADVICE'::text, 'MANUAL'::text]))),
    CONSTRAINT routine_remind_check CHECK ((remind = ANY (ARRAY['NONE'::text, 'TODAY'::text]))),
    CONSTRAINT routine_retired_pair CHECK (((retired_at IS NULL) = (retired_by IS NULL))),
    CONSTRAINT routine_rrule_check CHECK ((rrule ~ '^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(;INTERVAL=[1-9][0-9]{0,2})?(;BYDAY=(MO|TU|WE|TH|FR|SA|SU)(,(MO|TU|WE|TH|FR|SA|SU)){0,6})?$'::text)),
    CONSTRAINT routine_source_pair CHECK (((source_table IS NULL) = (source_id IS NULL))),
    CONSTRAINT routine_source_table_check CHECK (((source_table IS NULL) OR (source_table = ANY (ARRAY['vaccination'::text, 'treatment'::text, 'vet_visit'::text, 'medication_event'::text])))),
    CONSTRAINT routine_times CHECK ((array_to_string(times, ','::text) ~ '^(([01][0-9]|2[0-3]):[0-5][0-9](,([01][0-9]|2[0-3]):[0-5][0-9]){0,11})?$'::text)),
    CONSTRAINT routine_vet_advice_source CHECK (((origin <> 'VET_ADVICE'::text) OR ((source_table IS NOT NULL) AND (source_id IS NOT NULL))))
);

ALTER TABLE ONLY care.routine FORCE ROW LEVEL SECURITY;


--
-- Name: routine_routine_id_seq; Type: SEQUENCE; Schema: care; Owner: -
--

ALTER TABLE care.routine ALTER COLUMN routine_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME care.routine_routine_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: access_grant; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.access_grant (
    access_grant_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    member_name text NOT NULL,
    granted_by text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_by text,
    revoked_at timestamp with time zone,
    CONSTRAINT access_grant_member_name_check CHECK ((length(TRIM(BOTH FROM member_name)) > 0)),
    CONSTRAINT access_grant_revoked_pair CHECK (((revoked_at IS NULL) = (revoked_by IS NULL)))
);


--
-- Name: access_grant_access_grant_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

ALTER TABLE core.access_grant ALTER COLUMN access_grant_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME core.access_grant_access_grant_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: animal_role; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.animal_role (
    animal_role_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    member_name text NOT NULL,
    role text NOT NULL,
    from_on date DEFAULT CURRENT_DATE NOT NULL,
    to_on date,
    set_by text NOT NULL,
    set_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT animal_role_dates CHECK (((to_on IS NULL) OR (to_on >= from_on))),
    CONSTRAINT animal_role_member_name_check CHECK ((length(TRIM(BOTH FROM member_name)) > 0)),
    CONSTRAINT animal_role_role_check CHECK ((role = ANY (ARRAY['OWNER'::text, 'PRIMARY_CARER'::text, 'FAMILY'::text, 'VIEWER'::text])))
);

ALTER TABLE ONLY core.animal_role FORCE ROW LEVEL SECURITY;


--
-- Name: animal_role_animal_role_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

ALTER TABLE core.animal_role ALTER COLUMN animal_role_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME core.animal_role_animal_role_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: consent_event; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.consent_event (
    consent_event_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    member_name text NOT NULL,
    kind text NOT NULL,
    given boolean NOT NULL,
    words_shown text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT consent_event_kind_check CHECK ((kind = ANY (ARRAY['FOLDER_READ'::text, 'AI_READING'::text])))
);

ALTER TABLE ONLY core.consent_event FORCE ROW LEVEL SECURITY;


--
-- Name: consent_event_consent_event_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

ALTER TABLE core.consent_event ALTER COLUMN consent_event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME core.consent_event_consent_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: contact; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.contact (
    contact_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    kind text NOT NULL,
    name text NOT NULL,
    phone text,
    email text,
    address text,
    retired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    CONSTRAINT contact_kind_check CHECK ((kind = ANY (ARRAY['VET_PRACTICE'::text, 'VET_PERSON'::text, 'EMERGENCY_VET'::text, 'BREEDER'::text, 'RESCUE'::text, 'INSURER'::text, 'GROOMER'::text, 'KENNEL'::text, 'PERSON'::text, 'WILDLIFE_RESCUE'::text]))),
    CONSTRAINT contact_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0))
);

ALTER TABLE ONLY core.contact FORCE ROW LEVEL SECURITY;


--
-- Name: contact_contact_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

ALTER TABLE core.contact ALTER COLUMN contact_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME core.contact_contact_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: habitat; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.habitat (
    habitat_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    name text NOT NULL,
    kind text NOT NULL,
    parent_id bigint,
    ext jsonb DEFAULT '{}'::jsonb NOT NULL,
    retired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    CONSTRAINT habitat_kind_check CHECK ((kind = ANY (ARRAY['HOME'::text, 'GARDEN'::text, 'POND'::text, 'AQUARIUM'::text, 'FEEDER'::text, 'NEST_BOX'::text, 'TERRARIUM'::text, 'STABLE'::text, 'OTHER'::text]))),
    CONSTRAINT habitat_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT habitat_not_own_parent CHECK (((parent_id IS NULL) OR (parent_id <> habitat_id)))
);

ALTER TABLE ONLY core.habitat FORCE ROW LEVEL SECURITY;


--
-- Name: habitat_habitat_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

ALTER TABLE core.habitat ALTER COLUMN habitat_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME core.habitat_habitat_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: member; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.member (
    member_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    member_name text NOT NULL,
    display_name text,
    is_child boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    persona_key text,
    CONSTRAINT member_member_name_check CHECK ((length(TRIM(BOTH FROM member_name)) > 0))
);

ALTER TABLE ONLY core.member FORCE ROW LEVEL SECURITY;


--
-- Name: member_member_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

ALTER TABLE core.member ALTER COLUMN member_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME core.member_member_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: vault_folder_binding; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.vault_folder_binding (
    binding_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    member_name text NOT NULL,
    vault_folder_name text NOT NULL,
    go_ahead_by text,
    go_ahead_at timestamp with time zone,
    ai_go_ahead_by text,
    ai_go_ahead_at timestamp with time zone,
    created_by text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT binding_ai_pair CHECK (((ai_go_ahead_by IS NULL) = (ai_go_ahead_at IS NULL))),
    CONSTRAINT binding_ai_self CHECK (((ai_go_ahead_by IS NULL) OR (ai_go_ahead_by = member_name))),
    CONSTRAINT binding_go_ahead_pair CHECK (((go_ahead_by IS NULL) = (go_ahead_at IS NULL))),
    CONSTRAINT binding_go_ahead_self CHECK (((go_ahead_by IS NULL) OR (go_ahead_by = member_name))),
    CONSTRAINT vault_folder_binding_member_name_check CHECK ((length(TRIM(BOTH FROM member_name)) > 0)),
    CONSTRAINT vault_folder_binding_vault_folder_name_check CHECK (((vault_folder_name ~ '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$'::text) AND (vault_folder_name !~~ '%..%'::text)))
);


--
-- Name: vault_folder_binding_binding_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

ALTER TABLE core.vault_folder_binding ALTER COLUMN binding_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME core.vault_folder_binding_binding_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: workspace; Type: TABLE; Schema: core; Owner: -
--

CREATE TABLE core.workspace (
    workspace_id bigint NOT NULL,
    kind text DEFAULT 'HOUSEHOLD'::text NOT NULL,
    display_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    CONSTRAINT workspace_kind_check CHECK ((kind = 'HOUSEHOLD'::text))
);

ALTER TABLE ONLY core.workspace FORCE ROW LEVEL SECURITY;


--
-- Name: workspace_workspace_id_seq; Type: SEQUENCE; Schema: core; Owner: -
--

ALTER TABLE core.workspace ALTER COLUMN workspace_id ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME core.workspace_workspace_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: feeding_plan; Type: TABLE; Schema: diet; Owner: -
--

CREATE TABLE diet.feeding_plan (
    feeding_plan_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    brand text,
    product text,
    food_type text NOT NULL,
    portion_amount numeric(8,2),
    portion_unit text,
    times text[] DEFAULT '{}'::text[] NOT NULL,
    from_on date NOT NULL,
    to_on date,
    objective text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    status text DEFAULT 'PROPOSED'::text NOT NULL,
    source_class text NOT NULL,
    channel text NOT NULL,
    source_document_id bigint,
    source_page integer,
    source_quote text,
    extraction_method text NOT NULL,
    proposed_by text NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_by text,
    confirmed_at timestamp with time zone,
    supersedes_id bigint,
    CONSTRAINT feeding_plan_channel_check CHECK ((channel = ANY (ARRAY['DOCUMENT'::text, 'MANUAL'::text, 'VOICE'::text, 'CARE_LOG'::text]))),
    CONSTRAINT feeding_plan_dates CHECK (((to_on IS NULL) OR (to_on >= from_on))),
    CONSTRAINT feeding_plan_extraction_method_check CHECK ((extraction_method = ANY (ARRAY['MANUAL'::text, 'TEXT_LAYER'::text, 'OCR'::text, 'LLM_PROPOSAL'::text]))),
    CONSTRAINT feeding_plan_food_type_check CHECK ((food_type = ANY (ARRAY['DRY'::text, 'WET'::text, 'RAW'::text, 'MIXED'::text, 'PELLET'::text, 'FLAKE'::text, 'HAY'::text, 'LIVE'::text, 'OTHER'::text]))),
    CONSTRAINT feeding_plan_names CHECK (((COALESCE(TRIM(BOTH FROM brand), ''::text) <> ''::text) OR (COALESCE(TRIM(BOTH FROM product), ''::text) <> ''::text))),
    CONSTRAINT feeding_plan_portion_amount_check CHECK (((portion_amount IS NULL) OR (portion_amount > (0)::numeric))),
    CONSTRAINT feeding_plan_portion_pair CHECK (((portion_amount IS NULL) = (portion_unit IS NULL))),
    CONSTRAINT feeding_plan_portion_unit_check CHECK ((portion_unit = ANY (ARRAY['g'::text, 'kg'::text, 'ml'::text, 'cup'::text, 'can'::text, 'pouch'::text, 'scoop'::text, 'tbsp'::text, 'piece'::text]))),
    CONSTRAINT feeding_plan_pv_ai_never_confirmed CHECK (((source_class <> 'AI_SUGGESTION'::text) OR (status <> 'CONFIRMED'::text))),
    CONSTRAINT feeding_plan_pv_confirmed_has_confirmer CHECK (((status <> 'CONFIRMED'::text) OR ((confirmed_by IS NOT NULL) AND (confirmed_at IS NOT NULL)))),
    CONSTRAINT feeding_plan_pv_confirmer_is_person CHECK (((confirmed_by IS NULL) OR ((length(TRIM(BOTH FROM confirmed_by)) > 0) AND (confirmed_by <> 'petopia-reader'::text)))),
    CONSTRAINT feeding_plan_pv_document_has_source CHECK (((channel <> 'DOCUMENT'::text) OR (source_document_id IS NOT NULL))),
    CONSTRAINT feeding_plan_pv_page_needs_document CHECK (((source_page IS NULL) OR (source_document_id IS NOT NULL))),
    CONSTRAINT feeding_plan_source_class_check CHECK ((source_class = ANY (ARRAY['VET_RECORD'::text, 'VET_ADVICE'::text, 'OWNER_OBSERVATION'::text, 'AI_SUGGESTION'::text]))),
    CONSTRAINT feeding_plan_source_page_check CHECK (((source_page IS NULL) OR (source_page > 0))),
    CONSTRAINT feeding_plan_status_check CHECK ((status = ANY (ARRAY['PROPOSED'::text, 'CONFIRMED'::text, 'SUPERSEDED'::text, 'DISPUTED'::text]))),
    CONSTRAINT feeding_plan_times_check CHECK ((array_to_string(times, ','::text) ~ '^(([01][0-9]|2[0-3]):[0-5][0-9](,|$))*$'::text))
);

ALTER TABLE ONLY diet.feeding_plan FORCE ROW LEVEL SECURITY;


--
-- Name: feeding_plan_feeding_plan_id_seq; Type: SEQUENCE; Schema: diet; Owner: -
--

ALTER TABLE diet.feeding_plan ALTER COLUMN feeding_plan_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME diet.feeding_plan_feeding_plan_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: allergy; Type: TABLE; Schema: health; Owner: -
--

CREATE TABLE health.allergy (
    allergy_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    substance text NOT NULL,
    substance_kind text DEFAULT 'OTHER'::text NOT NULL,
    reaction text,
    certainty text NOT NULL,
    noted_on date,
    noted_precision text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    status text DEFAULT 'PROPOSED'::text NOT NULL,
    source_class text NOT NULL,
    channel text NOT NULL,
    source_document_id bigint,
    source_page integer,
    source_quote text,
    extraction_method text NOT NULL,
    proposed_by text NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_by text,
    confirmed_at timestamp with time zone,
    supersedes_id bigint,
    CONSTRAINT allergy_certainty_check CHECK ((certainty = ANY (ARRAY['CONFIRMED_BY_VET'::text, 'SUSPECTED'::text]))),
    CONSTRAINT allergy_channel_check CHECK ((channel = ANY (ARRAY['DOCUMENT'::text, 'MANUAL'::text, 'VOICE'::text, 'CARE_LOG'::text]))),
    CONSTRAINT allergy_date_pair CHECK (((noted_on IS NULL) = (noted_precision IS NULL))),
    CONSTRAINT allergy_extraction_method_check CHECK ((extraction_method = ANY (ARRAY['MANUAL'::text, 'TEXT_LAYER'::text, 'OCR'::text, 'LLM_PROPOSAL'::text]))),
    CONSTRAINT allergy_noted_precision_check CHECK ((noted_precision = ANY (ARRAY['DAY'::text, 'MONTH'::text, 'YEAR'::text]))),
    CONSTRAINT allergy_pv_ai_never_confirmed CHECK (((source_class <> 'AI_SUGGESTION'::text) OR (status <> 'CONFIRMED'::text))),
    CONSTRAINT allergy_pv_confirmed_has_confirmer CHECK (((status <> 'CONFIRMED'::text) OR ((confirmed_by IS NOT NULL) AND (confirmed_at IS NOT NULL)))),
    CONSTRAINT allergy_pv_confirmer_is_person CHECK (((confirmed_by IS NULL) OR ((length(TRIM(BOTH FROM confirmed_by)) > 0) AND (confirmed_by <> 'petopia-reader'::text)))),
    CONSTRAINT allergy_pv_document_has_source CHECK (((channel <> 'DOCUMENT'::text) OR (source_document_id IS NOT NULL))),
    CONSTRAINT allergy_pv_page_needs_document CHECK (((source_page IS NULL) OR (source_document_id IS NOT NULL))),
    CONSTRAINT allergy_source_class_check CHECK ((source_class = ANY (ARRAY['VET_RECORD'::text, 'VET_ADVICE'::text, 'OWNER_OBSERVATION'::text, 'AI_SUGGESTION'::text]))),
    CONSTRAINT allergy_source_page_check CHECK (((source_page IS NULL) OR (source_page > 0))),
    CONSTRAINT allergy_status_check CHECK ((status = ANY (ARRAY['PROPOSED'::text, 'CONFIRMED'::text, 'SUPERSEDED'::text, 'DISPUTED'::text]))),
    CONSTRAINT allergy_substance_check CHECK ((length(TRIM(BOTH FROM substance)) > 0)),
    CONSTRAINT allergy_substance_kind_check CHECK ((substance_kind = ANY (ARRAY['FOOD'::text, 'DRUG'::text, 'ENVIRONMENT'::text, 'OTHER'::text])))
);

ALTER TABLE ONLY health.allergy FORCE ROW LEVEL SECURITY;


--
-- Name: allergy_allergy_id_seq; Type: SEQUENCE; Schema: health; Owner: -
--

ALTER TABLE health.allergy ALTER COLUMN allergy_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME health.allergy_allergy_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: condition; Type: TABLE; Schema: health; Owner: -
--

CREATE TABLE health.condition (
    condition_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    name text NOT NULL,
    condition_status text NOT NULL,
    first_noted_on date,
    first_noted_precision text,
    vet_visit_id bigint,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    status text DEFAULT 'PROPOSED'::text NOT NULL,
    source_class text NOT NULL,
    channel text NOT NULL,
    source_document_id bigint,
    source_page integer,
    source_quote text,
    extraction_method text NOT NULL,
    proposed_by text NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_by text,
    confirmed_at timestamp with time zone,
    supersedes_id bigint,
    CONSTRAINT condition_channel_check CHECK ((channel = ANY (ARRAY['DOCUMENT'::text, 'MANUAL'::text, 'VOICE'::text, 'CARE_LOG'::text]))),
    CONSTRAINT condition_condition_status_check CHECK ((condition_status = ANY (ARRAY['SUSPECTED'::text, 'ACTIVE'::text, 'RESOLVED'::text]))),
    CONSTRAINT condition_date_pair CHECK (((first_noted_on IS NULL) = (first_noted_precision IS NULL))),
    CONSTRAINT condition_extraction_method_check CHECK ((extraction_method = ANY (ARRAY['MANUAL'::text, 'TEXT_LAYER'::text, 'OCR'::text, 'LLM_PROPOSAL'::text]))),
    CONSTRAINT condition_first_noted_precision_check CHECK ((first_noted_precision = ANY (ARRAY['DAY'::text, 'MONTH'::text, 'YEAR'::text]))),
    CONSTRAINT condition_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT condition_pv_ai_never_confirmed CHECK (((source_class <> 'AI_SUGGESTION'::text) OR (status <> 'CONFIRMED'::text))),
    CONSTRAINT condition_pv_confirmed_has_confirmer CHECK (((status <> 'CONFIRMED'::text) OR ((confirmed_by IS NOT NULL) AND (confirmed_at IS NOT NULL)))),
    CONSTRAINT condition_pv_confirmer_is_person CHECK (((confirmed_by IS NULL) OR ((length(TRIM(BOTH FROM confirmed_by)) > 0) AND (confirmed_by <> 'petopia-reader'::text)))),
    CONSTRAINT condition_pv_document_has_source CHECK (((channel <> 'DOCUMENT'::text) OR (source_document_id IS NOT NULL))),
    CONSTRAINT condition_pv_page_needs_document CHECK (((source_page IS NULL) OR (source_document_id IS NOT NULL))),
    CONSTRAINT condition_source_class_check CHECK ((source_class = ANY (ARRAY['VET_RECORD'::text, 'VET_ADVICE'::text, 'OWNER_OBSERVATION'::text, 'AI_SUGGESTION'::text]))),
    CONSTRAINT condition_source_page_check CHECK (((source_page IS NULL) OR (source_page > 0))),
    CONSTRAINT condition_status_check CHECK ((status = ANY (ARRAY['PROPOSED'::text, 'CONFIRMED'::text, 'SUPERSEDED'::text, 'DISPUTED'::text])))
);

ALTER TABLE ONLY health.condition FORCE ROW LEVEL SECURITY;


--
-- Name: condition_condition_id_seq; Type: SEQUENCE; Schema: health; Owner: -
--

ALTER TABLE health.condition ALTER COLUMN condition_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME health.condition_condition_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: lab_result; Type: TABLE; Schema: health; Owner: -
--

CREATE TABLE health.lab_result (
    lab_result_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    test text NOT NULL,
    analyte text,
    value_printed text,
    unit_printed text,
    ref_range_printed text,
    flag_printed text,
    sampled_on date NOT NULL,
    sampled_precision text DEFAULT 'DAY'::text NOT NULL,
    vet_visit_id bigint,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    status text DEFAULT 'PROPOSED'::text NOT NULL,
    source_class text NOT NULL,
    channel text NOT NULL,
    source_document_id bigint,
    source_page integer,
    source_quote text,
    extraction_method text NOT NULL,
    proposed_by text NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_by text,
    confirmed_at timestamp with time zone,
    supersedes_id bigint,
    CONSTRAINT lab_result_channel_check CHECK ((channel = ANY (ARRAY['DOCUMENT'::text, 'MANUAL'::text, 'VOICE'::text, 'CARE_LOG'::text]))),
    CONSTRAINT lab_result_extraction_method_check CHECK ((extraction_method = ANY (ARRAY['MANUAL'::text, 'TEXT_LAYER'::text, 'OCR'::text, 'LLM_PROPOSAL'::text]))),
    CONSTRAINT lab_result_pv_ai_never_confirmed CHECK (((source_class <> 'AI_SUGGESTION'::text) OR (status <> 'CONFIRMED'::text))),
    CONSTRAINT lab_result_pv_confirmed_has_confirmer CHECK (((status <> 'CONFIRMED'::text) OR ((confirmed_by IS NOT NULL) AND (confirmed_at IS NOT NULL)))),
    CONSTRAINT lab_result_pv_confirmer_is_person CHECK (((confirmed_by IS NULL) OR ((length(TRIM(BOTH FROM confirmed_by)) > 0) AND (confirmed_by <> 'petopia-reader'::text)))),
    CONSTRAINT lab_result_pv_document_has_source CHECK (((channel <> 'DOCUMENT'::text) OR (source_document_id IS NOT NULL))),
    CONSTRAINT lab_result_pv_page_needs_document CHECK (((source_page IS NULL) OR (source_document_id IS NOT NULL))),
    CONSTRAINT lab_result_sampled_precision_check CHECK ((sampled_precision = ANY (ARRAY['DAY'::text, 'MONTH'::text, 'YEAR'::text]))),
    CONSTRAINT lab_result_source_class_check CHECK ((source_class = ANY (ARRAY['VET_RECORD'::text, 'VET_ADVICE'::text, 'OWNER_OBSERVATION'::text, 'AI_SUGGESTION'::text]))),
    CONSTRAINT lab_result_source_page_check CHECK (((source_page IS NULL) OR (source_page > 0))),
    CONSTRAINT lab_result_status_check CHECK ((status = ANY (ARRAY['PROPOSED'::text, 'CONFIRMED'::text, 'SUPERSEDED'::text, 'DISPUTED'::text]))),
    CONSTRAINT lab_result_test_check CHECK ((length(TRIM(BOTH FROM test)) > 0))
);

ALTER TABLE ONLY health.lab_result FORCE ROW LEVEL SECURITY;


--
-- Name: lab_result_lab_result_id_seq; Type: SEQUENCE; Schema: health; Owner: -
--

ALTER TABLE health.lab_result ALTER COLUMN lab_result_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME health.lab_result_lab_result_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: measurement; Type: TABLE; Schema: health; Owner: -
--

CREATE TABLE health.measurement (
    measurement_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint,
    habitat_id bigint,
    measure text NOT NULL,
    value numeric(9,3) NOT NULL,
    unit text NOT NULL,
    value_as_entered text NOT NULL,
    unit_as_entered text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    time_precision text DEFAULT 'DAY'::text NOT NULL,
    plausibility_confirmed boolean DEFAULT false NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    status text DEFAULT 'PROPOSED'::text NOT NULL,
    source_class text NOT NULL,
    channel text NOT NULL,
    source_document_id bigint,
    source_page integer,
    source_quote text,
    extraction_method text NOT NULL,
    proposed_by text NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_by text,
    confirmed_at timestamp with time zone,
    supersedes_id bigint,
    CONSTRAINT measurement_channel_check CHECK ((channel = ANY (ARRAY['DOCUMENT'::text, 'MANUAL'::text, 'VOICE'::text, 'CARE_LOG'::text]))),
    CONSTRAINT measurement_extraction_method_check CHECK ((extraction_method = ANY (ARRAY['MANUAL'::text, 'TEXT_LAYER'::text, 'OCR'::text, 'LLM_PROPOSAL'::text]))),
    CONSTRAINT measurement_one_subject CHECK (((animal_id IS NULL) <> (habitat_id IS NULL))),
    CONSTRAINT measurement_pv_ai_never_confirmed CHECK (((source_class <> 'AI_SUGGESTION'::text) OR (status <> 'CONFIRMED'::text))),
    CONSTRAINT measurement_pv_confirmed_has_confirmer CHECK (((status <> 'CONFIRMED'::text) OR ((confirmed_by IS NOT NULL) AND (confirmed_at IS NOT NULL)))),
    CONSTRAINT measurement_pv_confirmer_is_person CHECK (((confirmed_by IS NULL) OR ((length(TRIM(BOTH FROM confirmed_by)) > 0) AND (confirmed_by <> 'petopia-reader'::text)))),
    CONSTRAINT measurement_pv_document_has_source CHECK (((channel <> 'DOCUMENT'::text) OR (source_document_id IS NOT NULL))),
    CONSTRAINT measurement_pv_page_needs_document CHECK (((source_page IS NULL) OR (source_document_id IS NOT NULL))),
    CONSTRAINT measurement_source_class_check CHECK ((source_class = ANY (ARRAY['VET_RECORD'::text, 'VET_ADVICE'::text, 'OWNER_OBSERVATION'::text, 'AI_SUGGESTION'::text]))),
    CONSTRAINT measurement_source_page_check CHECK (((source_page IS NULL) OR (source_page > 0))),
    CONSTRAINT measurement_status_check CHECK ((status = ANY (ARRAY['PROPOSED'::text, 'CONFIRMED'::text, 'SUPERSEDED'::text, 'DISPUTED'::text]))),
    CONSTRAINT measurement_time_precision_check CHECK ((time_precision = ANY (ARRAY['EXACT'::text, 'DAY'::text]))),
    CONSTRAINT measurement_value_check CHECK ((value > (0)::numeric))
);

ALTER TABLE ONLY health.measurement FORCE ROW LEVEL SECURITY;


--
-- Name: measurement_measurement_id_seq; Type: SEQUENCE; Schema: health; Owner: -
--

ALTER TABLE health.measurement ALTER COLUMN measurement_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME health.measurement_measurement_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: medication; Type: TABLE; Schema: health; Owner: -
--

CREATE TABLE health.medication (
    medication_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    product_name text NOT NULL,
    strength text,
    form text,
    retired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    CONSTRAINT medication_product_name_check CHECK ((length(TRIM(BOTH FROM product_name)) > 0))
);

ALTER TABLE ONLY health.medication FORCE ROW LEVEL SECURITY;


--
-- Name: medication_event; Type: TABLE; Schema: health; Owner: -
--

CREATE TABLE health.medication_event (
    medication_event_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    medication_id bigint NOT NULL,
    event_kind text NOT NULL,
    event_on date NOT NULL,
    event_precision text DEFAULT 'DAY'::text NOT NULL,
    dose_text text,
    dose_amount numeric(10,3),
    dose_unit text,
    frequency text,
    instructions_verbatim text,
    reason text,
    prescriber_contact_id bigint,
    quantity_supplied numeric(10,2),
    vet_visit_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    status text DEFAULT 'PROPOSED'::text NOT NULL,
    source_class text NOT NULL,
    channel text NOT NULL,
    source_document_id bigint,
    source_page integer,
    source_quote text,
    extraction_method text NOT NULL,
    proposed_by text NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_by text,
    confirmed_at timestamp with time zone,
    supersedes_id bigint,
    CONSTRAINT medication_event_channel_check CHECK ((channel = ANY (ARRAY['DOCUMENT'::text, 'MANUAL'::text, 'VOICE'::text, 'CARE_LOG'::text]))),
    CONSTRAINT medication_event_dose_amount_check CHECK (((dose_amount IS NULL) OR (dose_amount > (0)::numeric))),
    CONSTRAINT medication_event_dose_change CHECK (((event_kind <> 'DOSE_CHANGED'::text) OR (dose_text IS NOT NULL) OR (dose_amount IS NOT NULL))),
    CONSTRAINT medication_event_dose_pair CHECK (((dose_amount IS NULL) = (dose_unit IS NULL))),
    CONSTRAINT medication_event_event_kind_check CHECK ((event_kind = ANY (ARRAY['PRESCRIBED'::text, 'STARTED'::text, 'DOSE_CHANGED'::text, 'STOPPED'::text]))),
    CONSTRAINT medication_event_event_precision_check CHECK ((event_precision = ANY (ARRAY['DAY'::text, 'MONTH'::text, 'YEAR'::text]))),
    CONSTRAINT medication_event_extraction_method_check CHECK ((extraction_method = ANY (ARRAY['MANUAL'::text, 'TEXT_LAYER'::text, 'OCR'::text, 'LLM_PROPOSAL'::text]))),
    CONSTRAINT medication_event_pv_ai_never_confirmed CHECK (((source_class <> 'AI_SUGGESTION'::text) OR (status <> 'CONFIRMED'::text))),
    CONSTRAINT medication_event_pv_confirmed_has_confirmer CHECK (((status <> 'CONFIRMED'::text) OR ((confirmed_by IS NOT NULL) AND (confirmed_at IS NOT NULL)))),
    CONSTRAINT medication_event_pv_confirmer_is_person CHECK (((confirmed_by IS NULL) OR ((length(TRIM(BOTH FROM confirmed_by)) > 0) AND (confirmed_by <> 'petopia-reader'::text)))),
    CONSTRAINT medication_event_pv_document_has_source CHECK (((channel <> 'DOCUMENT'::text) OR (source_document_id IS NOT NULL))),
    CONSTRAINT medication_event_pv_page_needs_document CHECK (((source_page IS NULL) OR (source_document_id IS NOT NULL))),
    CONSTRAINT medication_event_quantity_supplied_check CHECK (((quantity_supplied IS NULL) OR (quantity_supplied > (0)::numeric))),
    CONSTRAINT medication_event_source_class_check CHECK ((source_class = ANY (ARRAY['VET_RECORD'::text, 'VET_ADVICE'::text, 'OWNER_OBSERVATION'::text, 'AI_SUGGESTION'::text]))),
    CONSTRAINT medication_event_source_page_check CHECK (((source_page IS NULL) OR (source_page > 0))),
    CONSTRAINT medication_event_status_check CHECK ((status = ANY (ARRAY['PROPOSED'::text, 'CONFIRMED'::text, 'SUPERSEDED'::text, 'DISPUTED'::text])))
);

ALTER TABLE ONLY health.medication_event FORCE ROW LEVEL SECURITY;


--
-- Name: medication_event_medication_event_id_seq; Type: SEQUENCE; Schema: health; Owner: -
--

ALTER TABLE health.medication_event ALTER COLUMN medication_event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME health.medication_event_medication_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: medication_medication_id_seq; Type: SEQUENCE; Schema: health; Owner: -
--

ALTER TABLE health.medication ALTER COLUMN medication_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME health.medication_medication_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: procedure; Type: TABLE; Schema: health; Owner: -
--

CREATE TABLE health.procedure (
    procedure_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    name text NOT NULL,
    performed_on date NOT NULL,
    performed_precision text DEFAULT 'DAY'::text NOT NULL,
    vet_visit_id bigint,
    outcome text,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    status text DEFAULT 'PROPOSED'::text NOT NULL,
    source_class text NOT NULL,
    channel text NOT NULL,
    source_document_id bigint,
    source_page integer,
    source_quote text,
    extraction_method text NOT NULL,
    proposed_by text NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_by text,
    confirmed_at timestamp with time zone,
    supersedes_id bigint,
    CONSTRAINT procedure_channel_check CHECK ((channel = ANY (ARRAY['DOCUMENT'::text, 'MANUAL'::text, 'VOICE'::text, 'CARE_LOG'::text]))),
    CONSTRAINT procedure_extraction_method_check CHECK ((extraction_method = ANY (ARRAY['MANUAL'::text, 'TEXT_LAYER'::text, 'OCR'::text, 'LLM_PROPOSAL'::text]))),
    CONSTRAINT procedure_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT procedure_performed_precision_check CHECK ((performed_precision = ANY (ARRAY['DAY'::text, 'MONTH'::text, 'YEAR'::text]))),
    CONSTRAINT procedure_pv_ai_never_confirmed CHECK (((source_class <> 'AI_SUGGESTION'::text) OR (status <> 'CONFIRMED'::text))),
    CONSTRAINT procedure_pv_confirmed_has_confirmer CHECK (((status <> 'CONFIRMED'::text) OR ((confirmed_by IS NOT NULL) AND (confirmed_at IS NOT NULL)))),
    CONSTRAINT procedure_pv_confirmer_is_person CHECK (((confirmed_by IS NULL) OR ((length(TRIM(BOTH FROM confirmed_by)) > 0) AND (confirmed_by <> 'petopia-reader'::text)))),
    CONSTRAINT procedure_pv_document_has_source CHECK (((channel <> 'DOCUMENT'::text) OR (source_document_id IS NOT NULL))),
    CONSTRAINT procedure_pv_page_needs_document CHECK (((source_page IS NULL) OR (source_document_id IS NOT NULL))),
    CONSTRAINT procedure_source_class_check CHECK ((source_class = ANY (ARRAY['VET_RECORD'::text, 'VET_ADVICE'::text, 'OWNER_OBSERVATION'::text, 'AI_SUGGESTION'::text]))),
    CONSTRAINT procedure_source_page_check CHECK (((source_page IS NULL) OR (source_page > 0))),
    CONSTRAINT procedure_status_check CHECK ((status = ANY (ARRAY['PROPOSED'::text, 'CONFIRMED'::text, 'SUPERSEDED'::text, 'DISPUTED'::text])))
);

ALTER TABLE ONLY health.procedure FORCE ROW LEVEL SECURITY;


--
-- Name: procedure_procedure_id_seq; Type: SEQUENCE; Schema: health; Owner: -
--

ALTER TABLE health.procedure ALTER COLUMN procedure_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME health.procedure_procedure_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: treatment; Type: TABLE; Schema: health; Owner: -
--

CREATE TABLE health.treatment (
    treatment_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    kind text NOT NULL,
    product text,
    given_on date NOT NULL,
    given_precision text DEFAULT 'DAY'::text NOT NULL,
    next_due_on date,
    vet_visit_id bigint,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    status text DEFAULT 'PROPOSED'::text NOT NULL,
    source_class text NOT NULL,
    channel text NOT NULL,
    source_document_id bigint,
    source_page integer,
    source_quote text,
    extraction_method text NOT NULL,
    proposed_by text NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_by text,
    confirmed_at timestamp with time zone,
    supersedes_id bigint,
    CONSTRAINT treatment_channel_check CHECK ((channel = ANY (ARRAY['DOCUMENT'::text, 'MANUAL'::text, 'VOICE'::text, 'CARE_LOG'::text]))),
    CONSTRAINT treatment_due CHECK (((next_due_on IS NULL) OR (next_due_on > given_on))),
    CONSTRAINT treatment_extraction_method_check CHECK ((extraction_method = ANY (ARRAY['MANUAL'::text, 'TEXT_LAYER'::text, 'OCR'::text, 'LLM_PROPOSAL'::text]))),
    CONSTRAINT treatment_given_precision_check CHECK ((given_precision = ANY (ARRAY['DAY'::text, 'MONTH'::text, 'YEAR'::text]))),
    CONSTRAINT treatment_kind_check CHECK ((kind = ANY (ARRAY['FLEA'::text, 'WORM'::text, 'TICK'::text, 'DENTAL'::text, 'OTHER'::text]))),
    CONSTRAINT treatment_pv_ai_never_confirmed CHECK (((source_class <> 'AI_SUGGESTION'::text) OR (status <> 'CONFIRMED'::text))),
    CONSTRAINT treatment_pv_confirmed_has_confirmer CHECK (((status <> 'CONFIRMED'::text) OR ((confirmed_by IS NOT NULL) AND (confirmed_at IS NOT NULL)))),
    CONSTRAINT treatment_pv_confirmer_is_person CHECK (((confirmed_by IS NULL) OR ((length(TRIM(BOTH FROM confirmed_by)) > 0) AND (confirmed_by <> 'petopia-reader'::text)))),
    CONSTRAINT treatment_pv_document_has_source CHECK (((channel <> 'DOCUMENT'::text) OR (source_document_id IS NOT NULL))),
    CONSTRAINT treatment_pv_page_needs_document CHECK (((source_page IS NULL) OR (source_document_id IS NOT NULL))),
    CONSTRAINT treatment_source_class_check CHECK ((source_class = ANY (ARRAY['VET_RECORD'::text, 'VET_ADVICE'::text, 'OWNER_OBSERVATION'::text, 'AI_SUGGESTION'::text]))),
    CONSTRAINT treatment_source_page_check CHECK (((source_page IS NULL) OR (source_page > 0))),
    CONSTRAINT treatment_status_check CHECK ((status = ANY (ARRAY['PROPOSED'::text, 'CONFIRMED'::text, 'SUPERSEDED'::text, 'DISPUTED'::text])))
);

ALTER TABLE ONLY health.treatment FORCE ROW LEVEL SECURITY;


--
-- Name: treatment_treatment_id_seq; Type: SEQUENCE; Schema: health; Owner: -
--

ALTER TABLE health.treatment ALTER COLUMN treatment_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME health.treatment_treatment_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: vaccination; Type: TABLE; Schema: health; Owner: -
--

CREATE TABLE health.vaccination (
    vaccination_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    vaccine text NOT NULL,
    given_on date NOT NULL,
    given_precision text DEFAULT 'DAY'::text NOT NULL,
    next_due_on date,
    batch text,
    vet_visit_id bigint,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    status text DEFAULT 'PROPOSED'::text NOT NULL,
    source_class text NOT NULL,
    channel text NOT NULL,
    source_document_id bigint,
    source_page integer,
    source_quote text,
    extraction_method text NOT NULL,
    proposed_by text NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_by text,
    confirmed_at timestamp with time zone,
    supersedes_id bigint,
    CONSTRAINT vaccination_channel_check CHECK ((channel = ANY (ARRAY['DOCUMENT'::text, 'MANUAL'::text, 'VOICE'::text, 'CARE_LOG'::text]))),
    CONSTRAINT vaccination_due CHECK (((next_due_on IS NULL) OR (next_due_on > given_on))),
    CONSTRAINT vaccination_extraction_method_check CHECK ((extraction_method = ANY (ARRAY['MANUAL'::text, 'TEXT_LAYER'::text, 'OCR'::text, 'LLM_PROPOSAL'::text]))),
    CONSTRAINT vaccination_given_precision_check CHECK ((given_precision = ANY (ARRAY['DAY'::text, 'MONTH'::text, 'YEAR'::text]))),
    CONSTRAINT vaccination_pv_ai_never_confirmed CHECK (((source_class <> 'AI_SUGGESTION'::text) OR (status <> 'CONFIRMED'::text))),
    CONSTRAINT vaccination_pv_confirmed_has_confirmer CHECK (((status <> 'CONFIRMED'::text) OR ((confirmed_by IS NOT NULL) AND (confirmed_at IS NOT NULL)))),
    CONSTRAINT vaccination_pv_confirmer_is_person CHECK (((confirmed_by IS NULL) OR ((length(TRIM(BOTH FROM confirmed_by)) > 0) AND (confirmed_by <> 'petopia-reader'::text)))),
    CONSTRAINT vaccination_pv_document_has_source CHECK (((channel <> 'DOCUMENT'::text) OR (source_document_id IS NOT NULL))),
    CONSTRAINT vaccination_pv_page_needs_document CHECK (((source_page IS NULL) OR (source_document_id IS NOT NULL))),
    CONSTRAINT vaccination_source_class_check CHECK ((source_class = ANY (ARRAY['VET_RECORD'::text, 'VET_ADVICE'::text, 'OWNER_OBSERVATION'::text, 'AI_SUGGESTION'::text]))),
    CONSTRAINT vaccination_source_page_check CHECK (((source_page IS NULL) OR (source_page > 0))),
    CONSTRAINT vaccination_status_check CHECK ((status = ANY (ARRAY['PROPOSED'::text, 'CONFIRMED'::text, 'SUPERSEDED'::text, 'DISPUTED'::text]))),
    CONSTRAINT vaccination_vaccine_check CHECK ((length(TRIM(BOTH FROM vaccine)) > 0))
);

ALTER TABLE ONLY health.vaccination FORCE ROW LEVEL SECURITY;


--
-- Name: vaccination_vaccination_id_seq; Type: SEQUENCE; Schema: health; Owner: -
--

ALTER TABLE health.vaccination ALTER COLUMN vaccination_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME health.vaccination_vaccination_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: vet_visit; Type: TABLE; Schema: health; Owner: -
--

CREATE TABLE health.vet_visit (
    vet_visit_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    animal_id bigint NOT NULL,
    visit_on date NOT NULL,
    visit_precision text DEFAULT 'DAY'::text NOT NULL,
    kind text DEFAULT 'ROUTINE'::text NOT NULL,
    contact_id bigint,
    vet_name text,
    reason text,
    symptoms text,
    examination text,
    diagnosis_text text,
    treatment_text text,
    follow_up_on date,
    cost_amount numeric(12,2),
    cost_currency text,
    notes text,
    calendar_event_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    status text DEFAULT 'PROPOSED'::text NOT NULL,
    source_class text NOT NULL,
    channel text NOT NULL,
    source_document_id bigint,
    source_page integer,
    source_quote text,
    extraction_method text NOT NULL,
    proposed_by text NOT NULL,
    proposed_at timestamp with time zone DEFAULT now() NOT NULL,
    confirmed_by text,
    confirmed_at timestamp with time zone,
    supersedes_id bigint,
    CONSTRAINT vet_visit_channel_check CHECK ((channel = ANY (ARRAY['DOCUMENT'::text, 'MANUAL'::text, 'VOICE'::text, 'CARE_LOG'::text]))),
    CONSTRAINT vet_visit_cost_amount_check CHECK (((cost_amount IS NULL) OR (cost_amount >= (0)::numeric))),
    CONSTRAINT vet_visit_cost_currency_check CHECK (((cost_currency IS NULL) OR (cost_currency ~ '^[A-Z]{3}$'::text))),
    CONSTRAINT vet_visit_cost_pair CHECK (((cost_amount IS NULL) = (cost_currency IS NULL))),
    CONSTRAINT vet_visit_extraction_method_check CHECK ((extraction_method = ANY (ARRAY['MANUAL'::text, 'TEXT_LAYER'::text, 'OCR'::text, 'LLM_PROPOSAL'::text]))),
    CONSTRAINT vet_visit_follow_up CHECK (((follow_up_on IS NULL) OR (follow_up_on >= visit_on))),
    CONSTRAINT vet_visit_kind_check CHECK ((kind = ANY (ARRAY['ROUTINE'::text, 'ILLNESS'::text, 'EMERGENCY'::text, 'SURGERY'::text, 'REFERRAL'::text, 'FOLLOW_UP'::text]))),
    CONSTRAINT vet_visit_pv_ai_never_confirmed CHECK (((source_class <> 'AI_SUGGESTION'::text) OR (status <> 'CONFIRMED'::text))),
    CONSTRAINT vet_visit_pv_confirmed_has_confirmer CHECK (((status <> 'CONFIRMED'::text) OR ((confirmed_by IS NOT NULL) AND (confirmed_at IS NOT NULL)))),
    CONSTRAINT vet_visit_pv_confirmer_is_person CHECK (((confirmed_by IS NULL) OR ((length(TRIM(BOTH FROM confirmed_by)) > 0) AND (confirmed_by <> 'petopia-reader'::text)))),
    CONSTRAINT vet_visit_pv_document_has_source CHECK (((channel <> 'DOCUMENT'::text) OR (source_document_id IS NOT NULL))),
    CONSTRAINT vet_visit_pv_page_needs_document CHECK (((source_page IS NULL) OR (source_document_id IS NOT NULL))),
    CONSTRAINT vet_visit_source_class_check CHECK ((source_class = ANY (ARRAY['VET_RECORD'::text, 'VET_ADVICE'::text, 'OWNER_OBSERVATION'::text, 'AI_SUGGESTION'::text]))),
    CONSTRAINT vet_visit_source_page_check CHECK (((source_page IS NULL) OR (source_page > 0))),
    CONSTRAINT vet_visit_status_check CHECK ((status = ANY (ARRAY['PROPOSED'::text, 'CONFIRMED'::text, 'SUPERSEDED'::text, 'DISPUTED'::text]))),
    CONSTRAINT vet_visit_visit_precision_check CHECK ((visit_precision = ANY (ARRAY['DAY'::text, 'MONTH'::text, 'YEAR'::text])))
);

ALTER TABLE ONLY health.vet_visit FORCE ROW LEVEL SECURITY;


--
-- Name: vet_visit_vet_visit_id_seq; Type: SEQUENCE; Schema: health; Owner: -
--

ALTER TABLE health.vet_visit ALTER COLUMN vet_visit_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME health.vet_visit_vet_visit_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: extraction_run; Type: TABLE; Schema: ingest; Owner: -
--

CREATE TABLE ingest.extraction_run (
    extraction_run_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    inbox_item_id bigint NOT NULL,
    method text NOT NULL,
    status text NOT NULL,
    model text,
    cli_version text,
    pages integer,
    valid boolean,
    errors text,
    dropped integer DEFAULT 0 NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cost_usd numeric(10,4),
    at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT extraction_run_method_check CHECK ((method = ANY (ARRAY['TEXT_LAYER'::text, 'OCR'::text, 'LLM_PROPOSAL'::text, 'LOCAL_MODEL'::text]))),
    CONSTRAINT extraction_run_status_check CHECK ((status = ANY (ARRAY['OK'::text, 'EMPTY'::text, 'FAILED'::text, 'INVALID'::text])))
);

ALTER TABLE ONLY ingest.extraction_run FORCE ROW LEVEL SECURITY;


--
-- Name: extraction_run_extraction_run_id_seq; Type: SEQUENCE; Schema: ingest; Owner: -
--

ALTER TABLE ingest.extraction_run ALTER COLUMN extraction_run_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME ingest.extraction_run_extraction_run_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: inbox_item; Type: TABLE; Schema: ingest; Owner: -
--

CREATE TABLE ingest.inbox_item (
    inbox_item_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    source_document_id bigint NOT NULL,
    member_name text NOT NULL,
    status text DEFAULT 'DISCOVERED'::text NOT NULL,
    flags text[] DEFAULT '{}'::text[] NOT NULL,
    animal_id bigint,
    animal_proposed_id bigint,
    doc_kind text,
    doc_kind_proposed text,
    document_date date,
    document_date_assumed boolean DEFAULT false NOT NULL,
    found jsonb DEFAULT '{}'::jsonb NOT NULL,
    dropped_count integer DEFAULT 0 NOT NULL,
    decided_by text,
    decided_at timestamp with time zone,
    filed_by text,
    filed_at timestamp with time zone,
    filed_path text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT inbox_item_decided_pair CHECK (((decided_by IS NULL) = (decided_at IS NULL))),
    CONSTRAINT inbox_item_doc_kind_check CHECK ((doc_kind = ANY (ARRAY['VET_LETTER'::text, 'INVOICE'::text, 'VACCINATION_CERT'::text, 'INSURANCE_POLICY'::text, 'INSURANCE_CLAIM'::text, 'PRESCRIPTION'::text, 'LAB_REPORT'::text, 'ADOPTION'::text, 'PEDIGREE'::text, 'MICROCHIP'::text, 'PHOTO'::text, 'SCREENSHOT'::text, 'OTHER'::text]))),
    CONSTRAINT inbox_item_dropped_count_check CHECK ((dropped_count >= 0)),
    CONSTRAINT inbox_item_filed_needs_path CHECK (((status <> 'FILED'::text) OR (filed_path IS NOT NULL))),
    CONSTRAINT inbox_item_status_check CHECK ((status = ANY (ARRAY['DISCOVERED'::text, 'READ'::text, 'ASSESSED'::text, 'NEEDS_REVIEW'::text, 'FILED_PENDING'::text, 'FILED'::text, 'IGNORED'::text, 'ASSESS_FAILED'::text])))
);

ALTER TABLE ONLY ingest.inbox_item FORCE ROW LEVEL SECURITY;


--
-- Name: inbox_item_inbox_item_id_seq; Type: SEQUENCE; Schema: ingest; Owner: -
--

ALTER TABLE ingest.inbox_item ALTER COLUMN inbox_item_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME ingest.inbox_item_inbox_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: page_text; Type: TABLE; Schema: ingest; Owner: -
--

CREATE TABLE ingest.page_text (
    page_text_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    inbox_item_id bigint NOT NULL,
    extraction_run_id bigint NOT NULL,
    page integer NOT NULL,
    text text NOT NULL,
    CONSTRAINT page_text_page_check CHECK ((page > 0))
);

ALTER TABLE ONLY ingest.page_text FORCE ROW LEVEL SECURITY;


--
-- Name: page_text_page_text_id_seq; Type: SEQUENCE; Schema: ingest; Owner: -
--

ALTER TABLE ingest.page_text ALTER COLUMN page_text_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME ingest.page_text_page_text_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: proposal; Type: TABLE; Schema: ingest; Owner: -
--

CREATE TABLE ingest.proposal (
    proposal_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    inbox_item_id bigint NOT NULL,
    extraction_run_id bigint NOT NULL,
    target text NOT NULL,
    payload jsonb NOT NULL,
    corrected jsonb,
    page integer NOT NULL,
    quote text NOT NULL,
    flags text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'PROPOSED'::text NOT NULL,
    decided_by text,
    decided_at timestamp with time zone,
    created_table text,
    created_row_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT proposal_corrected CHECK (((status = 'CORRECTED'::text) = (corrected IS NOT NULL))),
    CONSTRAINT proposal_corrected_check CHECK (((corrected IS NULL) OR (jsonb_typeof(corrected) = 'object'::text))),
    CONSTRAINT proposal_decided CHECK (((status = 'PROPOSED'::text) = (decided_by IS NULL))),
    CONSTRAINT proposal_page_check CHECK ((page > 0)),
    CONSTRAINT proposal_payload_check CHECK ((jsonb_typeof(payload) = 'object'::text)),
    CONSTRAINT proposal_quote_check CHECK ((length(quote) > 0)),
    CONSTRAINT proposal_status_check CHECK ((status = ANY (ARRAY['PROPOSED'::text, 'ACCEPTED'::text, 'CORRECTED'::text, 'DISMISSED'::text]))),
    CONSTRAINT proposal_target_check CHECK ((target = ANY (ARRAY['vet_visit'::text, 'vaccination'::text, 'treatment'::text, 'condition'::text, 'allergy'::text, 'procedure'::text, 'lab_result'::text, 'medication'::text, 'weight'::text, 'contact'::text])))
);

ALTER TABLE ONLY ingest.proposal FORCE ROW LEVEL SECURITY;


--
-- Name: proposal_proposal_id_seq; Type: SEQUENCE; Schema: ingest; Owner: -
--

ALTER TABLE ingest.proposal ALTER COLUMN proposal_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME ingest.proposal_proposal_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: source_document; Type: TABLE; Schema: ingest; Owner: -
--

CREATE TABLE ingest.source_document (
    source_document_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    file_hash text NOT NULL,
    vault_path text NOT NULL,
    file_name text NOT NULL,
    media_type text NOT NULL,
    page_count integer,
    doc_kind text,
    document_date date,
    uploaded_by text NOT NULL,
    discovered_at timestamp with time zone DEFAULT now() NOT NULL,
    original_relpath text,
    CONSTRAINT source_document_doc_kind_check CHECK ((doc_kind = ANY (ARRAY['VET_LETTER'::text, 'INVOICE'::text, 'VACCINATION_CERT'::text, 'INSURANCE_POLICY'::text, 'INSURANCE_CLAIM'::text, 'PRESCRIPTION'::text, 'LAB_REPORT'::text, 'ADOPTION'::text, 'PEDIGREE'::text, 'MICROCHIP'::text, 'PHOTO'::text, 'SCREENSHOT'::text, 'OTHER'::text]))),
    CONSTRAINT source_document_file_hash_check CHECK ((file_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT source_document_page_count_check CHECK (((page_count IS NULL) OR (page_count > 0))),
    CONSTRAINT source_document_vault_path_check CHECK (((length(vault_path) > 0) AND (vault_path !~~ '/%'::text) AND (vault_path !~~ '%..%'::text)))
);

ALTER TABLE ONLY ingest.source_document FORCE ROW LEVEL SECURITY;


--
-- Name: source_document_source_document_id_seq; Type: SEQUENCE; Schema: ingest; Owner: -
--

ALTER TABLE ingest.source_document ALTER COLUMN source_document_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME ingest.source_document_source_document_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: item; Type: TABLE; Schema: media; Owner: -
--

CREATE TABLE media.item (
    media_item_id bigint NOT NULL,
    workspace_id bigint NOT NULL,
    sha256 text NOT NULL,
    path text NOT NULL,
    width integer NOT NULL,
    height integer NOT NULL,
    taken_on date,
    added_by text NOT NULL,
    retired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT item_check CHECK ((path = (('_petopia-media/'::text || sha256) || '.jpg'::text))),
    CONSTRAINT item_height_check CHECK (((height > 0) AND (height <= 1600))),
    CONSTRAINT item_sha256_check CHECK ((sha256 ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT item_width_check CHECK (((width > 0) AND (width <= 1600)))
);

ALTER TABLE ONLY media.item FORCE ROW LEVEL SECURITY;


--
-- Name: item_media_item_id_seq; Type: SEQUENCE; Schema: media; Owner: -
--

ALTER TABLE media.item ALTER COLUMN media_item_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME media.item_media_item_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: measure; Type: TABLE; Schema: ref; Owner: -
--

CREATE TABLE ref.measure (
    code text NOT NULL,
    label text NOT NULL,
    kind text NOT NULL,
    accepted_units text[] NOT NULL,
    CONSTRAINT measure_code_check CHECK ((code ~ '^[a-z_]+$'::text)),
    CONSTRAINT measure_kind_check CHECK ((kind = ANY (ARRAY['MASS'::text, 'LENGTH'::text, 'SCORE'::text])))
);


--
-- Name: measure_unit; Type: TABLE; Schema: ref; Owner: -
--

CREATE TABLE ref.measure_unit (
    measure text NOT NULL,
    unit text NOT NULL
);


--
-- Name: species; Type: TABLE; Schema: ref; Owner: -
--

CREATE TABLE ref.species (
    species_id bigint NOT NULL,
    common_name text NOT NULL,
    scientific_name text,
    "group" text NOT NULL,
    domain text NOT NULL,
    sensitive boolean DEFAULT false NOT NULL,
    facts jsonb DEFAULT '{}'::jsonb NOT NULL,
    module_code text,
    CONSTRAINT species_domain_check CHECK ((domain = ANY (ARRAY['PET'::text, 'WILD'::text, 'BOTH'::text]))),
    CONSTRAINT species_group_check CHECK (("group" = ANY (ARRAY['DOG'::text, 'CAT'::text, 'BIRD'::text, 'MAMMAL'::text, 'AMPHIBIAN'::text, 'REPTILE'::text, 'FISH'::text, 'INSECT'::text, 'OTHER'::text])))
);


--
-- Name: species_module; Type: TABLE; Schema: ref; Owner: -
--

CREATE TABLE ref.species_module (
    code text NOT NULL,
    species_id bigint,
    schema jsonb NOT NULL,
    schema_version integer NOT NULL,
    measures text[] DEFAULT '{}'::text[] NOT NULL,
    default_routines jsonb DEFAULT '[]'::jsonb NOT NULL,
    vaccine_set text[] DEFAULT '{}'::text[] NOT NULL,
    CONSTRAINT species_module_code_check CHECK ((code ~ '^[a-z_]+$'::text)),
    CONSTRAINT species_module_schema_version_check CHECK ((schema_version > 0))
);


--
-- Name: species_species_id_seq; Type: SEQUENCE; Schema: ref; Owner: -
--

ALTER TABLE ref.species ALTER COLUMN species_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME ref.species_species_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: entry_v; Type: VIEW; Schema: timeline; Owner: -
--

CREATE VIEW timeline.entry_v AS
 SELECT v.workspace_id,
    v.animal_id,
    v.visit_on AS on_date,
    v.visit_precision AS "precision",
    'HEALTH'::text AS category,
    'VET_VISIT'::text AS kind,
    COALESCE(v.reason, initcap(replace(v.kind, '_'::text, ' '::text))) AS title,
    NULLIF(concat_ws(' · '::text, v.diagnosis_text, v.vet_name), ''::text) AS detail,
    v.source_class,
    v.status,
    v.channel,
    'vet_visit'::text AS ref_table,
    v.vet_visit_id AS ref_id,
    v.created_at,
    v.source_document_id,
    v.source_page
   FROM health.vet_visit v
  WHERE (v.status = ANY (ARRAY['CONFIRMED'::text, 'PROPOSED'::text]))
UNION ALL
 SELECT x.workspace_id,
    x.animal_id,
    x.given_on AS on_date,
    x.given_precision AS "precision",
    'HEALTH'::text AS category,
    'VACCINATION'::text AS kind,
    x.vaccine AS title,
        CASE
            WHEN (x.next_due_on IS NOT NULL) THEN ('next due '::text || to_char((x.next_due_on)::timestamp with time zone, 'YYYY-MM-DD'::text))
            ELSE NULL::text
        END AS detail,
    x.source_class,
    x.status,
    x.channel,
    'vaccination'::text AS ref_table,
    x.vaccination_id AS ref_id,
    x.created_at,
    x.source_document_id,
    x.source_page
   FROM health.vaccination x
  WHERE (x.status = ANY (ARRAY['CONFIRMED'::text, 'PROPOSED'::text]))
UNION ALL
 SELECT x.workspace_id,
    x.animal_id,
    x.given_on AS on_date,
    x.given_precision AS "precision",
    'HEALTH'::text AS category,
    ('TREATMENT_'::text || x.kind) AS kind,
    COALESCE(x.product, initcap(x.kind)) AS title,
        CASE
            WHEN (x.next_due_on IS NOT NULL) THEN ('next due '::text || to_char((x.next_due_on)::timestamp with time zone, 'YYYY-MM-DD'::text))
            ELSE NULL::text
        END AS detail,
    x.source_class,
    x.status,
    x.channel,
    'treatment'::text AS ref_table,
    x.treatment_id AS ref_id,
    x.created_at,
    x.source_document_id,
    x.source_page
   FROM health.treatment x
  WHERE (x.status = ANY (ARRAY['CONFIRMED'::text, 'PROPOSED'::text]))
UNION ALL
 SELECT x.workspace_id,
    x.animal_id,
    COALESCE(x.first_noted_on, (x.created_at)::date) AS on_date,
    COALESCE(x.first_noted_precision, 'DAY'::text) AS "precision",
    'HEALTH'::text AS category,
    'CONDITION'::text AS kind,
    x.name AS title,
    lower(x.condition_status) AS detail,
    x.source_class,
    x.status,
    x.channel,
    'condition'::text AS ref_table,
    x.condition_id AS ref_id,
    x.created_at,
    x.source_document_id,
    x.source_page
   FROM health.condition x
  WHERE (x.status = ANY (ARRAY['CONFIRMED'::text, 'PROPOSED'::text]))
UNION ALL
 SELECT x.workspace_id,
    x.animal_id,
    COALESCE(x.noted_on, (x.created_at)::date) AS on_date,
    COALESCE(x.noted_precision, 'DAY'::text) AS "precision",
    'HEALTH'::text AS category,
    'ALLERGY'::text AS kind,
    x.substance AS title,
    x.reaction AS detail,
    x.source_class,
    x.status,
    x.channel,
    'allergy'::text AS ref_table,
    x.allergy_id AS ref_id,
    x.created_at,
    x.source_document_id,
    x.source_page
   FROM health.allergy x
  WHERE (x.status = ANY (ARRAY['CONFIRMED'::text, 'PROPOSED'::text]))
UNION ALL
 SELECT x.workspace_id,
    x.animal_id,
    x.performed_on AS on_date,
    x.performed_precision AS "precision",
    'HEALTH'::text AS category,
    'PROCEDURE'::text AS kind,
    x.name AS title,
    x.outcome AS detail,
    x.source_class,
    x.status,
    x.channel,
    'procedure'::text AS ref_table,
    x.procedure_id AS ref_id,
    x.created_at,
    x.source_document_id,
    x.source_page
   FROM health.procedure x
  WHERE (x.status = ANY (ARRAY['CONFIRMED'::text, 'PROPOSED'::text]))
UNION ALL
 SELECT x.workspace_id,
    x.animal_id,
    x.sampled_on AS on_date,
    x.sampled_precision AS "precision",
    'HEALTH'::text AS category,
    'LAB_RESULT'::text AS kind,
    (x.test || COALESCE((': '::text || x.analyte), ''::text)) AS title,
    NULLIF(concat_ws(' '::text, x.value_printed, x.unit_printed, (('('::text || x.flag_printed) || ')'::text)), ''::text) AS detail,
    x.source_class,
    x.status,
    x.channel,
    'lab_result'::text AS ref_table,
    x.lab_result_id AS ref_id,
    x.created_at,
    x.source_document_id,
    x.source_page
   FROM health.lab_result x
  WHERE (x.status = ANY (ARRAY['CONFIRMED'::text, 'PROPOSED'::text]))
UNION ALL
 SELECT e.workspace_id,
    e.animal_id,
    e.event_on AS on_date,
    e.event_precision AS "precision",
    'HEALTH'::text AS category,
    ('MEDICATION_'::text || e.event_kind) AS kind,
    m.product_name AS title,
    NULLIF(concat_ws(' · '::text, e.dose_text, e.frequency), ''::text) AS detail,
    e.source_class,
    e.status,
    e.channel,
    'medication_event'::text AS ref_table,
    e.medication_event_id AS ref_id,
    e.created_at,
    e.source_document_id,
    e.source_page
   FROM (health.medication_event e
     JOIN health.medication m ON (((m.workspace_id = e.workspace_id) AND (m.medication_id = e.medication_id))))
  WHERE (e.status = ANY (ARRAY['CONFIRMED'::text, 'PROPOSED'::text]))
UNION ALL
 SELECT x.workspace_id,
    x.animal_id,
    ((x.observed_at AT TIME ZONE 'Europe/Dublin'::text))::date AS on_date,
    'DAY'::text AS "precision",
        CASE
            WHEN (x.measure = 'weight'::text) THEN 'WEIGHT'::text
            ELSE 'HEALTH'::text
        END AS category,
    ('MEASUREMENT_'::text || upper(x.measure)) AS kind,
    ((TRIM(BOTH '.'::text FROM to_char(x.value, 'FM999999990.999'::text)) || ' '::text) || x.unit) AS title,
    x.note AS detail,
    x.source_class,
    x.status,
    x.channel,
    'measurement'::text AS ref_table,
    x.measurement_id AS ref_id,
    x.created_at,
    x.source_document_id,
    x.source_page
   FROM health.measurement x
  WHERE ((x.animal_id IS NOT NULL) AND (x.status = ANY (ARRAY['CONFIRMED'::text, 'PROPOSED'::text])))
UNION ALL
 SELECT x.workspace_id,
    x.animal_id,
    x.from_on AS on_date,
    'DAY'::text AS "precision",
    'FOOD'::text AS category,
    'FOOD_STARTED'::text AS kind,
    concat_ws(' '::text, x.brand, x.product) AS title,
    x.objective AS detail,
    x.source_class,
    x.status,
    x.channel,
    'feeding_plan'::text AS ref_table,
    x.feeding_plan_id AS ref_id,
    x.created_at,
    x.source_document_id,
    x.source_page
   FROM diet.feeding_plan x
  WHERE (x.status = ANY (ARRAY['CONFIRMED'::text, 'PROPOSED'::text]));


--
-- Name: animal animal_pkey; Type: CONSTRAINT; Schema: animal; Owner: -
--

ALTER TABLE ONLY animal.animal
    ADD CONSTRAINT animal_pkey PRIMARY KEY (animal_id);


--
-- Name: animal animal_ws_id; Type: CONSTRAINT; Schema: animal; Owner: -
--

ALTER TABLE ONLY animal.animal
    ADD CONSTRAINT animal_ws_id UNIQUE (workspace_id, animal_id);


--
-- Name: appointment appointment_pkey; Type: CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.appointment
    ADD CONSTRAINT appointment_pkey PRIMARY KEY (appointment_id);


--
-- Name: appointment appointment_ws_id; Type: CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.appointment
    ADD CONSTRAINT appointment_ws_id UNIQUE (workspace_id, appointment_id);


--
-- Name: log log_pkey; Type: CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.log
    ADD CONSTRAINT log_pkey PRIMARY KEY (log_id);


--
-- Name: log log_ws_id; Type: CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.log
    ADD CONSTRAINT log_ws_id UNIQUE (workspace_id, log_id);


--
-- Name: routine routine_pkey; Type: CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.routine
    ADD CONSTRAINT routine_pkey PRIMARY KEY (routine_id);


--
-- Name: routine routine_ws_id; Type: CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.routine
    ADD CONSTRAINT routine_ws_id UNIQUE (workspace_id, routine_id);


--
-- Name: access_grant access_grant_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.access_grant
    ADD CONSTRAINT access_grant_pkey PRIMARY KEY (access_grant_id);


--
-- Name: access_grant access_grant_workspace_id_member_name_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.access_grant
    ADD CONSTRAINT access_grant_workspace_id_member_name_key UNIQUE (workspace_id, member_name);


--
-- Name: animal_role animal_role_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.animal_role
    ADD CONSTRAINT animal_role_pkey PRIMARY KEY (animal_role_id);


--
-- Name: vault_folder_binding binding_folder_unique; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.vault_folder_binding
    ADD CONSTRAINT binding_folder_unique UNIQUE (vault_folder_name);


--
-- Name: vault_folder_binding binding_member_unique; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.vault_folder_binding
    ADD CONSTRAINT binding_member_unique UNIQUE (workspace_id, member_name);


--
-- Name: consent_event consent_event_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.consent_event
    ADD CONSTRAINT consent_event_pkey PRIMARY KEY (consent_event_id);


--
-- Name: contact contact_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.contact
    ADD CONSTRAINT contact_pkey PRIMARY KEY (contact_id);


--
-- Name: contact contact_ws_id; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.contact
    ADD CONSTRAINT contact_ws_id UNIQUE (workspace_id, contact_id);


--
-- Name: habitat habitat_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.habitat
    ADD CONSTRAINT habitat_pkey PRIMARY KEY (habitat_id);


--
-- Name: habitat habitat_ws_id; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.habitat
    ADD CONSTRAINT habitat_ws_id UNIQUE (workspace_id, habitat_id);


--
-- Name: habitat habitat_ws_name; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.habitat
    ADD CONSTRAINT habitat_ws_name UNIQUE (workspace_id, name);


--
-- Name: member member_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.member
    ADD CONSTRAINT member_pkey PRIMARY KEY (member_id);


--
-- Name: member member_workspace_id_member_name_key; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.member
    ADD CONSTRAINT member_workspace_id_member_name_key UNIQUE (workspace_id, member_name);


--
-- Name: vault_folder_binding vault_folder_binding_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.vault_folder_binding
    ADD CONSTRAINT vault_folder_binding_pkey PRIMARY KEY (binding_id);


--
-- Name: workspace workspace_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.workspace
    ADD CONSTRAINT workspace_pkey PRIMARY KEY (workspace_id);


--
-- Name: feeding_plan feeding_plan_pkey; Type: CONSTRAINT; Schema: diet; Owner: -
--

ALTER TABLE ONLY diet.feeding_plan
    ADD CONSTRAINT feeding_plan_pkey PRIMARY KEY (feeding_plan_id);


--
-- Name: feeding_plan feeding_plan_ws_id; Type: CONSTRAINT; Schema: diet; Owner: -
--

ALTER TABLE ONLY diet.feeding_plan
    ADD CONSTRAINT feeding_plan_ws_id UNIQUE (workspace_id, feeding_plan_id);


--
-- Name: allergy allergy_pkey; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.allergy
    ADD CONSTRAINT allergy_pkey PRIMARY KEY (allergy_id);


--
-- Name: allergy allergy_ws_id; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.allergy
    ADD CONSTRAINT allergy_ws_id UNIQUE (workspace_id, allergy_id);


--
-- Name: condition condition_pkey; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.condition
    ADD CONSTRAINT condition_pkey PRIMARY KEY (condition_id);


--
-- Name: condition condition_ws_id; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.condition
    ADD CONSTRAINT condition_ws_id UNIQUE (workspace_id, condition_id);


--
-- Name: lab_result lab_result_pkey; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.lab_result
    ADD CONSTRAINT lab_result_pkey PRIMARY KEY (lab_result_id);


--
-- Name: lab_result lab_result_ws_id; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.lab_result
    ADD CONSTRAINT lab_result_ws_id UNIQUE (workspace_id, lab_result_id);


--
-- Name: measurement measurement_pkey; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.measurement
    ADD CONSTRAINT measurement_pkey PRIMARY KEY (measurement_id);


--
-- Name: measurement measurement_ws_id; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.measurement
    ADD CONSTRAINT measurement_ws_id UNIQUE (workspace_id, measurement_id);


--
-- Name: medication_event medication_event_pkey; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication_event
    ADD CONSTRAINT medication_event_pkey PRIMARY KEY (medication_event_id);


--
-- Name: medication_event medication_event_ws_id; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication_event
    ADD CONSTRAINT medication_event_ws_id UNIQUE (workspace_id, medication_event_id);


--
-- Name: medication medication_pkey; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication
    ADD CONSTRAINT medication_pkey PRIMARY KEY (medication_id);


--
-- Name: medication medication_ws_animal_id; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication
    ADD CONSTRAINT medication_ws_animal_id UNIQUE (workspace_id, animal_id, medication_id);


--
-- Name: medication medication_ws_id; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication
    ADD CONSTRAINT medication_ws_id UNIQUE (workspace_id, medication_id);


--
-- Name: procedure procedure_pkey; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.procedure
    ADD CONSTRAINT procedure_pkey PRIMARY KEY (procedure_id);


--
-- Name: procedure procedure_ws_id; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.procedure
    ADD CONSTRAINT procedure_ws_id UNIQUE (workspace_id, procedure_id);


--
-- Name: treatment treatment_pkey; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.treatment
    ADD CONSTRAINT treatment_pkey PRIMARY KEY (treatment_id);


--
-- Name: treatment treatment_ws_id; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.treatment
    ADD CONSTRAINT treatment_ws_id UNIQUE (workspace_id, treatment_id);


--
-- Name: vaccination vaccination_pkey; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vaccination
    ADD CONSTRAINT vaccination_pkey PRIMARY KEY (vaccination_id);


--
-- Name: vaccination vaccination_ws_id; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vaccination
    ADD CONSTRAINT vaccination_ws_id UNIQUE (workspace_id, vaccination_id);


--
-- Name: vet_visit vet_visit_pkey; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vet_visit
    ADD CONSTRAINT vet_visit_pkey PRIMARY KEY (vet_visit_id);


--
-- Name: vet_visit vet_visit_ws_id; Type: CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vet_visit
    ADD CONSTRAINT vet_visit_ws_id UNIQUE (workspace_id, vet_visit_id);


--
-- Name: extraction_run extraction_run_pkey; Type: CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.extraction_run
    ADD CONSTRAINT extraction_run_pkey PRIMARY KEY (extraction_run_id);


--
-- Name: extraction_run extraction_run_ws_id; Type: CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.extraction_run
    ADD CONSTRAINT extraction_run_ws_id UNIQUE (workspace_id, extraction_run_id);


--
-- Name: inbox_item inbox_item_one_per_document; Type: CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.inbox_item
    ADD CONSTRAINT inbox_item_one_per_document UNIQUE (workspace_id, source_document_id);


--
-- Name: inbox_item inbox_item_pkey; Type: CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.inbox_item
    ADD CONSTRAINT inbox_item_pkey PRIMARY KEY (inbox_item_id);


--
-- Name: inbox_item inbox_item_ws_id; Type: CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.inbox_item
    ADD CONSTRAINT inbox_item_ws_id UNIQUE (workspace_id, inbox_item_id);


--
-- Name: page_text page_text_one; Type: CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.page_text
    ADD CONSTRAINT page_text_one UNIQUE (workspace_id, extraction_run_id, page);


--
-- Name: page_text page_text_pkey; Type: CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.page_text
    ADD CONSTRAINT page_text_pkey PRIMARY KEY (page_text_id);


--
-- Name: proposal proposal_pkey; Type: CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.proposal
    ADD CONSTRAINT proposal_pkey PRIMARY KEY (proposal_id);


--
-- Name: proposal proposal_ws_id; Type: CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.proposal
    ADD CONSTRAINT proposal_ws_id UNIQUE (workspace_id, proposal_id);


--
-- Name: source_document source_document_pkey; Type: CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.source_document
    ADD CONSTRAINT source_document_pkey PRIMARY KEY (source_document_id);


--
-- Name: source_document source_document_ws_hash; Type: CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.source_document
    ADD CONSTRAINT source_document_ws_hash UNIQUE (workspace_id, file_hash);


--
-- Name: source_document source_document_ws_id; Type: CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.source_document
    ADD CONSTRAINT source_document_ws_id UNIQUE (workspace_id, source_document_id);


--
-- Name: item item_pkey; Type: CONSTRAINT; Schema: media; Owner: -
--

ALTER TABLE ONLY media.item
    ADD CONSTRAINT item_pkey PRIMARY KEY (media_item_id);


--
-- Name: item media_item_ws_id; Type: CONSTRAINT; Schema: media; Owner: -
--

ALTER TABLE ONLY media.item
    ADD CONSTRAINT media_item_ws_id UNIQUE (workspace_id, media_item_id);


--
-- Name: item media_item_ws_sha; Type: CONSTRAINT; Schema: media; Owner: -
--

ALTER TABLE ONLY media.item
    ADD CONSTRAINT media_item_ws_sha UNIQUE (workspace_id, sha256);


--
-- Name: measure measure_pkey; Type: CONSTRAINT; Schema: ref; Owner: -
--

ALTER TABLE ONLY ref.measure
    ADD CONSTRAINT measure_pkey PRIMARY KEY (code);


--
-- Name: measure_unit measure_unit_pkey; Type: CONSTRAINT; Schema: ref; Owner: -
--

ALTER TABLE ONLY ref.measure_unit
    ADD CONSTRAINT measure_unit_pkey PRIMARY KEY (measure, unit);


--
-- Name: species species_common_name_key; Type: CONSTRAINT; Schema: ref; Owner: -
--

ALTER TABLE ONLY ref.species
    ADD CONSTRAINT species_common_name_key UNIQUE (common_name);


--
-- Name: species_module species_module_pkey; Type: CONSTRAINT; Schema: ref; Owner: -
--

ALTER TABLE ONLY ref.species_module
    ADD CONSTRAINT species_module_pkey PRIMARY KEY (code);


--
-- Name: species species_pkey; Type: CONSTRAINT; Schema: ref; Owner: -
--

ALTER TABLE ONLY ref.species
    ADD CONSTRAINT species_pkey PRIMARY KEY (species_id);


--
-- Name: uq_animal_microchip; Type: INDEX; Schema: animal; Owner: -
--

CREATE UNIQUE INDEX uq_animal_microchip ON animal.animal USING btree (workspace_id, upper(microchip)) WHERE (microchip IS NOT NULL);


--
-- Name: idx_log_animal; Type: INDEX; Schema: care; Owner: -
--

CREATE INDEX idx_log_animal ON care.log USING btree (workspace_id, animal_id, done_at DESC);


--
-- Name: uq_log_occurrence; Type: INDEX; Schema: care; Owner: -
--

CREATE UNIQUE INDEX uq_log_occurrence ON care.log USING btree (workspace_id, routine_id, due_on, due_slot) WHERE ((routine_id IS NOT NULL) AND (due_on IS NOT NULL));


--
-- Name: idx_access_grant_member; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_access_grant_member ON core.access_grant USING btree (member_name) WHERE (revoked_at IS NULL);


--
-- Name: uq_animal_role_current; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX uq_animal_role_current ON core.animal_role USING btree (workspace_id, animal_id, member_name) WHERE (to_on IS NULL);


--
-- Name: uq_binding_folder_ci; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX uq_binding_folder_ci ON core.vault_folder_binding USING btree (lower(vault_folder_name));


--
-- Name: uq_feeding_plan_current; Type: INDEX; Schema: diet; Owner: -
--

CREATE UNIQUE INDEX uq_feeding_plan_current ON diet.feeding_plan USING btree (workspace_id, animal_id) WHERE ((to_on IS NULL) AND (status = 'CONFIRMED'::text));


--
-- Name: idx_measurement_animal; Type: INDEX; Schema: health; Owner: -
--

CREATE INDEX idx_measurement_animal ON health.measurement USING btree (workspace_id, animal_id, measure, observed_at DESC);


--
-- Name: idx_medication_event_med; Type: INDEX; Schema: health; Owner: -
--

CREATE INDEX idx_medication_event_med ON health.medication_event USING btree (workspace_id, medication_id, event_on);


--
-- Name: idx_inbox_item_status; Type: INDEX; Schema: ingest; Owner: -
--

CREATE INDEX idx_inbox_item_status ON ingest.inbox_item USING btree (workspace_id, status);


--
-- Name: uq_species_name_ci; Type: INDEX; Schema: ref; Owner: -
--

CREATE UNIQUE INDEX uq_species_name_ci ON ref.species USING btree (lower(common_name));


--
-- Name: log insert_only_guard; Type: TRIGGER; Schema: care; Owner: -
--

CREATE TRIGGER insert_only_guard BEFORE DELETE OR UPDATE ON care.log FOR EACH ROW EXECUTE FUNCTION core.insert_only_guard();


--
-- Name: consent_event insert_only_guard; Type: TRIGGER; Schema: core; Owner: -
--

CREATE TRIGGER insert_only_guard BEFORE DELETE OR UPDATE ON core.consent_event FOR EACH ROW EXECUTE FUNCTION core.insert_only_guard();


--
-- Name: feeding_plan append_only_guard; Type: TRIGGER; Schema: diet; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON diet.feeding_plan FOR EACH ROW EXECUTE FUNCTION core.append_only_guard('to_on');


--
-- Name: feeding_plan provenance_guard; Type: TRIGGER; Schema: diet; Owner: -
--

CREATE TRIGGER provenance_guard BEFORE INSERT OR UPDATE ON diet.feeding_plan FOR EACH ROW EXECUTE FUNCTION core.provenance_guard();


--
-- Name: allergy append_only_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON health.allergy FOR EACH ROW EXECUTE FUNCTION core.append_only_guard();


--
-- Name: condition append_only_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON health.condition FOR EACH ROW EXECUTE FUNCTION core.append_only_guard();


--
-- Name: lab_result append_only_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON health.lab_result FOR EACH ROW EXECUTE FUNCTION core.append_only_guard();


--
-- Name: measurement append_only_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON health.measurement FOR EACH ROW EXECUTE FUNCTION core.append_only_guard();


--
-- Name: medication_event append_only_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON health.medication_event FOR EACH ROW EXECUTE FUNCTION core.append_only_guard();


--
-- Name: procedure append_only_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON health.procedure FOR EACH ROW EXECUTE FUNCTION core.append_only_guard();


--
-- Name: treatment append_only_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON health.treatment FOR EACH ROW EXECUTE FUNCTION core.append_only_guard();


--
-- Name: vaccination append_only_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON health.vaccination FOR EACH ROW EXECUTE FUNCTION core.append_only_guard();


--
-- Name: vet_visit append_only_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER append_only_guard BEFORE DELETE OR UPDATE ON health.vet_visit FOR EACH ROW EXECUTE FUNCTION core.append_only_guard('calendar_event_id');


--
-- Name: allergy provenance_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER provenance_guard BEFORE INSERT OR UPDATE ON health.allergy FOR EACH ROW EXECUTE FUNCTION core.provenance_guard();


--
-- Name: condition provenance_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER provenance_guard BEFORE INSERT OR UPDATE ON health.condition FOR EACH ROW EXECUTE FUNCTION core.provenance_guard();


--
-- Name: lab_result provenance_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER provenance_guard BEFORE INSERT OR UPDATE ON health.lab_result FOR EACH ROW EXECUTE FUNCTION core.provenance_guard();


--
-- Name: measurement provenance_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER provenance_guard BEFORE INSERT OR UPDATE ON health.measurement FOR EACH ROW EXECUTE FUNCTION core.provenance_guard();


--
-- Name: medication_event provenance_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER provenance_guard BEFORE INSERT OR UPDATE ON health.medication_event FOR EACH ROW EXECUTE FUNCTION core.provenance_guard();


--
-- Name: procedure provenance_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER provenance_guard BEFORE INSERT OR UPDATE ON health.procedure FOR EACH ROW EXECUTE FUNCTION core.provenance_guard();


--
-- Name: treatment provenance_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER provenance_guard BEFORE INSERT OR UPDATE ON health.treatment FOR EACH ROW EXECUTE FUNCTION core.provenance_guard();


--
-- Name: vaccination provenance_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER provenance_guard BEFORE INSERT OR UPDATE ON health.vaccination FOR EACH ROW EXECUTE FUNCTION core.provenance_guard();


--
-- Name: vet_visit provenance_guard; Type: TRIGGER; Schema: health; Owner: -
--

CREATE TRIGGER provenance_guard BEFORE INSERT OR UPDATE ON health.vet_visit FOR EACH ROW EXECUTE FUNCTION core.provenance_guard();


--
-- Name: animal animal_emergency_fk; Type: FK CONSTRAINT; Schema: animal; Owner: -
--

ALTER TABLE ONLY animal.animal
    ADD CONSTRAINT animal_emergency_fk FOREIGN KEY (workspace_id, emergency_contact_id) REFERENCES core.contact(workspace_id, contact_id);


--
-- Name: animal animal_habitat_fk; Type: FK CONSTRAINT; Schema: animal; Owner: -
--

ALTER TABLE ONLY animal.animal
    ADD CONSTRAINT animal_habitat_fk FOREIGN KEY (workspace_id, habitat_id) REFERENCES core.habitat(workspace_id, habitat_id);


--
-- Name: animal animal_module_code_fkey; Type: FK CONSTRAINT; Schema: animal; Owner: -
--

ALTER TABLE ONLY animal.animal
    ADD CONSTRAINT animal_module_code_fkey FOREIGN KEY (module_code) REFERENCES ref.species_module(code);


--
-- Name: animal animal_photo_fk; Type: FK CONSTRAINT; Schema: animal; Owner: -
--

ALTER TABLE ONLY animal.animal
    ADD CONSTRAINT animal_photo_fk FOREIGN KEY (workspace_id, profile_media_id) REFERENCES media.item(workspace_id, media_item_id);


--
-- Name: animal animal_species_id_fkey; Type: FK CONSTRAINT; Schema: animal; Owner: -
--

ALTER TABLE ONLY animal.animal
    ADD CONSTRAINT animal_species_id_fkey FOREIGN KEY (species_id) REFERENCES ref.species(species_id);


--
-- Name: animal animal_vet_fk; Type: FK CONSTRAINT; Schema: animal; Owner: -
--

ALTER TABLE ONLY animal.animal
    ADD CONSTRAINT animal_vet_fk FOREIGN KEY (workspace_id, vet_contact_id) REFERENCES core.contact(workspace_id, contact_id);


--
-- Name: animal animal_workspace_id_fkey; Type: FK CONSTRAINT; Schema: animal; Owner: -
--

ALTER TABLE ONLY animal.animal
    ADD CONSTRAINT animal_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: appointment appointment_animal_fk; Type: FK CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.appointment
    ADD CONSTRAINT appointment_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: appointment appointment_contact_fk; Type: FK CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.appointment
    ADD CONSTRAINT appointment_contact_fk FOREIGN KEY (workspace_id, contact_id) REFERENCES core.contact(workspace_id, contact_id);


--
-- Name: appointment appointment_workspace_id_fkey; Type: FK CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.appointment
    ADD CONSTRAINT appointment_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: log log_animal_fk; Type: FK CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.log
    ADD CONSTRAINT log_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: log log_routine_fk; Type: FK CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.log
    ADD CONSTRAINT log_routine_fk FOREIGN KEY (workspace_id, routine_id) REFERENCES care.routine(workspace_id, routine_id);


--
-- Name: log log_workspace_id_fkey; Type: FK CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.log
    ADD CONSTRAINT log_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: routine routine_animal_fk; Type: FK CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.routine
    ADD CONSTRAINT routine_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: routine routine_med_fk; Type: FK CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.routine
    ADD CONSTRAINT routine_med_fk FOREIGN KEY (workspace_id, animal_id, medication_id) REFERENCES health.medication(workspace_id, animal_id, medication_id);


--
-- Name: routine routine_workspace_id_fkey; Type: FK CONSTRAINT; Schema: care; Owner: -
--

ALTER TABLE ONLY care.routine
    ADD CONSTRAINT routine_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: access_grant access_grant_workspace_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.access_grant
    ADD CONSTRAINT access_grant_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: animal_role animal_role_animal_fk; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.animal_role
    ADD CONSTRAINT animal_role_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: animal_role animal_role_workspace_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.animal_role
    ADD CONSTRAINT animal_role_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: consent_event consent_event_workspace_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.consent_event
    ADD CONSTRAINT consent_event_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: contact contact_workspace_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.contact
    ADD CONSTRAINT contact_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: habitat habitat_parent_fk; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.habitat
    ADD CONSTRAINT habitat_parent_fk FOREIGN KEY (workspace_id, parent_id) REFERENCES core.habitat(workspace_id, habitat_id);


--
-- Name: habitat habitat_workspace_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.habitat
    ADD CONSTRAINT habitat_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: member member_workspace_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.member
    ADD CONSTRAINT member_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: vault_folder_binding vault_folder_binding_workspace_id_fkey; Type: FK CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.vault_folder_binding
    ADD CONSTRAINT vault_folder_binding_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: feeding_plan feeding_plan_animal_fk; Type: FK CONSTRAINT; Schema: diet; Owner: -
--

ALTER TABLE ONLY diet.feeding_plan
    ADD CONSTRAINT feeding_plan_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: feeding_plan feeding_plan_pv_source_fk; Type: FK CONSTRAINT; Schema: diet; Owner: -
--

ALTER TABLE ONLY diet.feeding_plan
    ADD CONSTRAINT feeding_plan_pv_source_fk FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id);


--
-- Name: feeding_plan feeding_plan_pv_supersedes_fk; Type: FK CONSTRAINT; Schema: diet; Owner: -
--

ALTER TABLE ONLY diet.feeding_plan
    ADD CONSTRAINT feeding_plan_pv_supersedes_fk FOREIGN KEY (workspace_id, supersedes_id) REFERENCES diet.feeding_plan(workspace_id, feeding_plan_id);


--
-- Name: feeding_plan feeding_plan_workspace_id_fkey; Type: FK CONSTRAINT; Schema: diet; Owner: -
--

ALTER TABLE ONLY diet.feeding_plan
    ADD CONSTRAINT feeding_plan_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: allergy allergy_animal_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.allergy
    ADD CONSTRAINT allergy_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: allergy allergy_pv_source_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.allergy
    ADD CONSTRAINT allergy_pv_source_fk FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id);


--
-- Name: allergy allergy_pv_supersedes_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.allergy
    ADD CONSTRAINT allergy_pv_supersedes_fk FOREIGN KEY (workspace_id, supersedes_id) REFERENCES health.allergy(workspace_id, allergy_id);


--
-- Name: allergy allergy_workspace_id_fkey; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.allergy
    ADD CONSTRAINT allergy_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: condition condition_animal_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.condition
    ADD CONSTRAINT condition_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: condition condition_pv_source_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.condition
    ADD CONSTRAINT condition_pv_source_fk FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id);


--
-- Name: condition condition_pv_supersedes_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.condition
    ADD CONSTRAINT condition_pv_supersedes_fk FOREIGN KEY (workspace_id, supersedes_id) REFERENCES health.condition(workspace_id, condition_id);


--
-- Name: condition condition_visit_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.condition
    ADD CONSTRAINT condition_visit_fk FOREIGN KEY (workspace_id, vet_visit_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id);


--
-- Name: condition condition_workspace_id_fkey; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.condition
    ADD CONSTRAINT condition_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: lab_result lab_result_animal_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.lab_result
    ADD CONSTRAINT lab_result_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: lab_result lab_result_pv_source_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.lab_result
    ADD CONSTRAINT lab_result_pv_source_fk FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id);


--
-- Name: lab_result lab_result_pv_supersedes_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.lab_result
    ADD CONSTRAINT lab_result_pv_supersedes_fk FOREIGN KEY (workspace_id, supersedes_id) REFERENCES health.lab_result(workspace_id, lab_result_id);


--
-- Name: lab_result lab_result_visit_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.lab_result
    ADD CONSTRAINT lab_result_visit_fk FOREIGN KEY (workspace_id, vet_visit_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id);


--
-- Name: lab_result lab_result_workspace_id_fkey; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.lab_result
    ADD CONSTRAINT lab_result_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: measurement measurement_animal_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.measurement
    ADD CONSTRAINT measurement_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: measurement measurement_habitat_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.measurement
    ADD CONSTRAINT measurement_habitat_fk FOREIGN KEY (workspace_id, habitat_id) REFERENCES core.habitat(workspace_id, habitat_id);


--
-- Name: measurement measurement_pv_source_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.measurement
    ADD CONSTRAINT measurement_pv_source_fk FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id);


--
-- Name: measurement measurement_pv_supersedes_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.measurement
    ADD CONSTRAINT measurement_pv_supersedes_fk FOREIGN KEY (workspace_id, supersedes_id) REFERENCES health.measurement(workspace_id, measurement_id);


--
-- Name: measurement measurement_unit_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.measurement
    ADD CONSTRAINT measurement_unit_fk FOREIGN KEY (measure, unit) REFERENCES ref.measure_unit(measure, unit);


--
-- Name: measurement measurement_workspace_id_fkey; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.measurement
    ADD CONSTRAINT measurement_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: medication medication_animal_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication
    ADD CONSTRAINT medication_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: medication_event medication_event_med_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication_event
    ADD CONSTRAINT medication_event_med_fk FOREIGN KEY (workspace_id, animal_id, medication_id) REFERENCES health.medication(workspace_id, animal_id, medication_id);


--
-- Name: medication_event medication_event_prescriber_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication_event
    ADD CONSTRAINT medication_event_prescriber_fk FOREIGN KEY (workspace_id, prescriber_contact_id) REFERENCES core.contact(workspace_id, contact_id);


--
-- Name: medication_event medication_event_pv_source_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication_event
    ADD CONSTRAINT medication_event_pv_source_fk FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id);


--
-- Name: medication_event medication_event_pv_supersedes_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication_event
    ADD CONSTRAINT medication_event_pv_supersedes_fk FOREIGN KEY (workspace_id, supersedes_id) REFERENCES health.medication_event(workspace_id, medication_event_id);


--
-- Name: medication_event medication_event_visit_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication_event
    ADD CONSTRAINT medication_event_visit_fk FOREIGN KEY (workspace_id, vet_visit_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id);


--
-- Name: medication_event medication_event_workspace_id_fkey; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication_event
    ADD CONSTRAINT medication_event_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: medication medication_workspace_id_fkey; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.medication
    ADD CONSTRAINT medication_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: procedure procedure_animal_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.procedure
    ADD CONSTRAINT procedure_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: procedure procedure_pv_source_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.procedure
    ADD CONSTRAINT procedure_pv_source_fk FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id);


--
-- Name: procedure procedure_pv_supersedes_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.procedure
    ADD CONSTRAINT procedure_pv_supersedes_fk FOREIGN KEY (workspace_id, supersedes_id) REFERENCES health.procedure(workspace_id, procedure_id);


--
-- Name: procedure procedure_visit_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.procedure
    ADD CONSTRAINT procedure_visit_fk FOREIGN KEY (workspace_id, vet_visit_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id);


--
-- Name: procedure procedure_workspace_id_fkey; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.procedure
    ADD CONSTRAINT procedure_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: treatment treatment_animal_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.treatment
    ADD CONSTRAINT treatment_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: treatment treatment_pv_source_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.treatment
    ADD CONSTRAINT treatment_pv_source_fk FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id);


--
-- Name: treatment treatment_pv_supersedes_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.treatment
    ADD CONSTRAINT treatment_pv_supersedes_fk FOREIGN KEY (workspace_id, supersedes_id) REFERENCES health.treatment(workspace_id, treatment_id);


--
-- Name: treatment treatment_visit_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.treatment
    ADD CONSTRAINT treatment_visit_fk FOREIGN KEY (workspace_id, vet_visit_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id);


--
-- Name: treatment treatment_workspace_id_fkey; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.treatment
    ADD CONSTRAINT treatment_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: vaccination vaccination_animal_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vaccination
    ADD CONSTRAINT vaccination_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: vaccination vaccination_pv_source_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vaccination
    ADD CONSTRAINT vaccination_pv_source_fk FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id);


--
-- Name: vaccination vaccination_pv_supersedes_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vaccination
    ADD CONSTRAINT vaccination_pv_supersedes_fk FOREIGN KEY (workspace_id, supersedes_id) REFERENCES health.vaccination(workspace_id, vaccination_id);


--
-- Name: vaccination vaccination_visit_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vaccination
    ADD CONSTRAINT vaccination_visit_fk FOREIGN KEY (workspace_id, vet_visit_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id);


--
-- Name: vaccination vaccination_workspace_id_fkey; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vaccination
    ADD CONSTRAINT vaccination_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: vet_visit vet_visit_animal_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vet_visit
    ADD CONSTRAINT vet_visit_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: vet_visit vet_visit_contact_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vet_visit
    ADD CONSTRAINT vet_visit_contact_fk FOREIGN KEY (workspace_id, contact_id) REFERENCES core.contact(workspace_id, contact_id);


--
-- Name: vet_visit vet_visit_pv_source_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vet_visit
    ADD CONSTRAINT vet_visit_pv_source_fk FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id);


--
-- Name: vet_visit vet_visit_pv_supersedes_fk; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vet_visit
    ADD CONSTRAINT vet_visit_pv_supersedes_fk FOREIGN KEY (workspace_id, supersedes_id) REFERENCES health.vet_visit(workspace_id, vet_visit_id);


--
-- Name: vet_visit vet_visit_workspace_id_fkey; Type: FK CONSTRAINT; Schema: health; Owner: -
--

ALTER TABLE ONLY health.vet_visit
    ADD CONSTRAINT vet_visit_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: extraction_run extraction_run_item_fk; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.extraction_run
    ADD CONSTRAINT extraction_run_item_fk FOREIGN KEY (workspace_id, inbox_item_id) REFERENCES ingest.inbox_item(workspace_id, inbox_item_id);


--
-- Name: extraction_run extraction_run_workspace_id_fkey; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.extraction_run
    ADD CONSTRAINT extraction_run_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: inbox_item inbox_item_animal_fk; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.inbox_item
    ADD CONSTRAINT inbox_item_animal_fk FOREIGN KEY (workspace_id, animal_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: inbox_item inbox_item_animal_proposed_fk; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.inbox_item
    ADD CONSTRAINT inbox_item_animal_proposed_fk FOREIGN KEY (workspace_id, animal_proposed_id) REFERENCES animal.animal(workspace_id, animal_id);


--
-- Name: inbox_item inbox_item_doc_fk; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.inbox_item
    ADD CONSTRAINT inbox_item_doc_fk FOREIGN KEY (workspace_id, source_document_id) REFERENCES ingest.source_document(workspace_id, source_document_id);


--
-- Name: inbox_item inbox_item_workspace_id_fkey; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.inbox_item
    ADD CONSTRAINT inbox_item_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: page_text page_text_item_fk; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.page_text
    ADD CONSTRAINT page_text_item_fk FOREIGN KEY (workspace_id, inbox_item_id) REFERENCES ingest.inbox_item(workspace_id, inbox_item_id);


--
-- Name: page_text page_text_run_fk; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.page_text
    ADD CONSTRAINT page_text_run_fk FOREIGN KEY (workspace_id, extraction_run_id) REFERENCES ingest.extraction_run(workspace_id, extraction_run_id);


--
-- Name: page_text page_text_workspace_id_fkey; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.page_text
    ADD CONSTRAINT page_text_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: proposal proposal_item_fk; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.proposal
    ADD CONSTRAINT proposal_item_fk FOREIGN KEY (workspace_id, inbox_item_id) REFERENCES ingest.inbox_item(workspace_id, inbox_item_id);


--
-- Name: proposal proposal_run_fk; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.proposal
    ADD CONSTRAINT proposal_run_fk FOREIGN KEY (workspace_id, extraction_run_id) REFERENCES ingest.extraction_run(workspace_id, extraction_run_id);


--
-- Name: proposal proposal_workspace_id_fkey; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.proposal
    ADD CONSTRAINT proposal_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: source_document source_document_workspace_id_fkey; Type: FK CONSTRAINT; Schema: ingest; Owner: -
--

ALTER TABLE ONLY ingest.source_document
    ADD CONSTRAINT source_document_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: item item_workspace_id_fkey; Type: FK CONSTRAINT; Schema: media; Owner: -
--

ALTER TABLE ONLY media.item
    ADD CONSTRAINT item_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES core.workspace(workspace_id);


--
-- Name: measure_unit measure_unit_measure_fkey; Type: FK CONSTRAINT; Schema: ref; Owner: -
--

ALTER TABLE ONLY ref.measure_unit
    ADD CONSTRAINT measure_unit_measure_fkey FOREIGN KEY (measure) REFERENCES ref.measure(code);


--
-- Name: species species_module_code_fkey; Type: FK CONSTRAINT; Schema: ref; Owner: -
--

ALTER TABLE ONLY ref.species
    ADD CONSTRAINT species_module_code_fkey FOREIGN KEY (module_code) REFERENCES ref.species_module(code);


--
-- Name: species_module species_module_species_id_fkey; Type: FK CONSTRAINT; Schema: ref; Owner: -
--

ALTER TABLE ONLY ref.species_module
    ADD CONSTRAINT species_module_species_id_fkey FOREIGN KEY (species_id) REFERENCES ref.species(species_id);


--
-- Name: animal; Type: ROW SECURITY; Schema: animal; Owner: -
--

ALTER TABLE animal.animal ENABLE ROW LEVEL SECURITY;

--
-- Name: animal workspace_isolation; Type: POLICY; Schema: animal; Owner: -
--

CREATE POLICY workspace_isolation ON animal.animal USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: appointment; Type: ROW SECURITY; Schema: care; Owner: -
--

ALTER TABLE care.appointment ENABLE ROW LEVEL SECURITY;

--
-- Name: log; Type: ROW SECURITY; Schema: care; Owner: -
--

ALTER TABLE care.log ENABLE ROW LEVEL SECURITY;

--
-- Name: routine; Type: ROW SECURITY; Schema: care; Owner: -
--

ALTER TABLE care.routine ENABLE ROW LEVEL SECURITY;

--
-- Name: appointment workspace_isolation; Type: POLICY; Schema: care; Owner: -
--

CREATE POLICY workspace_isolation ON care.appointment USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: log workspace_isolation; Type: POLICY; Schema: care; Owner: -
--

CREATE POLICY workspace_isolation ON care.log USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: routine workspace_isolation; Type: POLICY; Schema: care; Owner: -
--

CREATE POLICY workspace_isolation ON care.routine USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: animal_role; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.animal_role ENABLE ROW LEVEL SECURITY;

--
-- Name: consent_event; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.consent_event ENABLE ROW LEVEL SECURITY;

--
-- Name: contact; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.contact ENABLE ROW LEVEL SECURITY;

--
-- Name: habitat; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.habitat ENABLE ROW LEVEL SECURITY;

--
-- Name: member; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.member ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.workspace ENABLE ROW LEVEL SECURITY;

--
-- Name: animal_role workspace_isolation; Type: POLICY; Schema: core; Owner: -
--

CREATE POLICY workspace_isolation ON core.animal_role USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: consent_event workspace_isolation; Type: POLICY; Schema: core; Owner: -
--

CREATE POLICY workspace_isolation ON core.consent_event USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: contact workspace_isolation; Type: POLICY; Schema: core; Owner: -
--

CREATE POLICY workspace_isolation ON core.contact USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: habitat workspace_isolation; Type: POLICY; Schema: core; Owner: -
--

CREATE POLICY workspace_isolation ON core.habitat USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: member workspace_isolation; Type: POLICY; Schema: core; Owner: -
--

CREATE POLICY workspace_isolation ON core.member USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: workspace workspace_isolation; Type: POLICY; Schema: core; Owner: -
--

CREATE POLICY workspace_isolation ON core.workspace USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: feeding_plan; Type: ROW SECURITY; Schema: diet; Owner: -
--

ALTER TABLE diet.feeding_plan ENABLE ROW LEVEL SECURITY;

--
-- Name: feeding_plan workspace_isolation; Type: POLICY; Schema: diet; Owner: -
--

CREATE POLICY workspace_isolation ON diet.feeding_plan USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: allergy; Type: ROW SECURITY; Schema: health; Owner: -
--

ALTER TABLE health.allergy ENABLE ROW LEVEL SECURITY;

--
-- Name: condition; Type: ROW SECURITY; Schema: health; Owner: -
--

ALTER TABLE health.condition ENABLE ROW LEVEL SECURITY;

--
-- Name: lab_result; Type: ROW SECURITY; Schema: health; Owner: -
--

ALTER TABLE health.lab_result ENABLE ROW LEVEL SECURITY;

--
-- Name: measurement; Type: ROW SECURITY; Schema: health; Owner: -
--

ALTER TABLE health.measurement ENABLE ROW LEVEL SECURITY;

--
-- Name: medication; Type: ROW SECURITY; Schema: health; Owner: -
--

ALTER TABLE health.medication ENABLE ROW LEVEL SECURITY;

--
-- Name: medication_event; Type: ROW SECURITY; Schema: health; Owner: -
--

ALTER TABLE health.medication_event ENABLE ROW LEVEL SECURITY;

--
-- Name: procedure; Type: ROW SECURITY; Schema: health; Owner: -
--

ALTER TABLE health.procedure ENABLE ROW LEVEL SECURITY;

--
-- Name: treatment; Type: ROW SECURITY; Schema: health; Owner: -
--

ALTER TABLE health.treatment ENABLE ROW LEVEL SECURITY;

--
-- Name: vaccination; Type: ROW SECURITY; Schema: health; Owner: -
--

ALTER TABLE health.vaccination ENABLE ROW LEVEL SECURITY;

--
-- Name: vet_visit; Type: ROW SECURITY; Schema: health; Owner: -
--

ALTER TABLE health.vet_visit ENABLE ROW LEVEL SECURITY;

--
-- Name: allergy workspace_isolation; Type: POLICY; Schema: health; Owner: -
--

CREATE POLICY workspace_isolation ON health.allergy USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: condition workspace_isolation; Type: POLICY; Schema: health; Owner: -
--

CREATE POLICY workspace_isolation ON health.condition USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: lab_result workspace_isolation; Type: POLICY; Schema: health; Owner: -
--

CREATE POLICY workspace_isolation ON health.lab_result USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: measurement workspace_isolation; Type: POLICY; Schema: health; Owner: -
--

CREATE POLICY workspace_isolation ON health.measurement USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: medication workspace_isolation; Type: POLICY; Schema: health; Owner: -
--

CREATE POLICY workspace_isolation ON health.medication USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: medication_event workspace_isolation; Type: POLICY; Schema: health; Owner: -
--

CREATE POLICY workspace_isolation ON health.medication_event USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: procedure workspace_isolation; Type: POLICY; Schema: health; Owner: -
--

CREATE POLICY workspace_isolation ON health.procedure USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: treatment workspace_isolation; Type: POLICY; Schema: health; Owner: -
--

CREATE POLICY workspace_isolation ON health.treatment USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: vaccination workspace_isolation; Type: POLICY; Schema: health; Owner: -
--

CREATE POLICY workspace_isolation ON health.vaccination USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: vet_visit workspace_isolation; Type: POLICY; Schema: health; Owner: -
--

CREATE POLICY workspace_isolation ON health.vet_visit USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: extraction_run; Type: ROW SECURITY; Schema: ingest; Owner: -
--

ALTER TABLE ingest.extraction_run ENABLE ROW LEVEL SECURITY;

--
-- Name: inbox_item; Type: ROW SECURITY; Schema: ingest; Owner: -
--

ALTER TABLE ingest.inbox_item ENABLE ROW LEVEL SECURITY;

--
-- Name: page_text; Type: ROW SECURITY; Schema: ingest; Owner: -
--

ALTER TABLE ingest.page_text ENABLE ROW LEVEL SECURITY;

--
-- Name: proposal; Type: ROW SECURITY; Schema: ingest; Owner: -
--

ALTER TABLE ingest.proposal ENABLE ROW LEVEL SECURITY;

--
-- Name: source_document; Type: ROW SECURITY; Schema: ingest; Owner: -
--

ALTER TABLE ingest.source_document ENABLE ROW LEVEL SECURITY;

--
-- Name: extraction_run workspace_isolation; Type: POLICY; Schema: ingest; Owner: -
--

CREATE POLICY workspace_isolation ON ingest.extraction_run USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: inbox_item workspace_isolation; Type: POLICY; Schema: ingest; Owner: -
--

CREATE POLICY workspace_isolation ON ingest.inbox_item USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: page_text workspace_isolation; Type: POLICY; Schema: ingest; Owner: -
--

CREATE POLICY workspace_isolation ON ingest.page_text USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: proposal workspace_isolation; Type: POLICY; Schema: ingest; Owner: -
--

CREATE POLICY workspace_isolation ON ingest.proposal USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: source_document workspace_isolation; Type: POLICY; Schema: ingest; Owner: -
--

CREATE POLICY workspace_isolation ON ingest.source_document USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- Name: item; Type: ROW SECURITY; Schema: media; Owner: -
--

ALTER TABLE media.item ENABLE ROW LEVEL SECURITY;

--
-- Name: item workspace_isolation; Type: POLICY; Schema: media; Owner: -
--

CREATE POLICY workspace_isolation ON media.item USING ((workspace_id = (NULLIF(current_setting('app.current_workspace_id'::text, true), ''::text))::bigint));


--
-- PostgreSQL database dump complete
--

\unrestrict LUQlqbYOYpSHUa4s5hcLnbjsq4cTA0btBQ19VMxbsWuapp1osPRkv30I1kr26tH

