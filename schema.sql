--
-- PostgreSQL database dump
--

\restrict beWnMrTRMxZ8ZzmTRCQy8hfvwUzJCi2CEsOX8lXVKwuWVIazAtNKHe4SmrzJEA2

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
-- Name: core; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA core;


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
-- Name: workspace workspace_pkey; Type: CONSTRAINT; Schema: core; Owner: -
--

ALTER TABLE ONLY core.workspace
    ADD CONSTRAINT workspace_pkey PRIMARY KEY (workspace_id);


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
-- Name: idx_access_grant_member; Type: INDEX; Schema: core; Owner: -
--

CREATE INDEX idx_access_grant_member ON core.access_grant USING btree (member_name) WHERE (revoked_at IS NULL);


--
-- Name: uq_animal_role_current; Type: INDEX; Schema: core; Owner: -
--

CREATE UNIQUE INDEX uq_animal_role_current ON core.animal_role USING btree (workspace_id, animal_id, member_name) WHERE (to_on IS NULL);


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
-- Name: animal_role; Type: ROW SECURITY; Schema: core; Owner: -
--

ALTER TABLE core.animal_role ENABLE ROW LEVEL SECURITY;

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
-- Name: source_document; Type: ROW SECURITY; Schema: ingest; Owner: -
--

ALTER TABLE ingest.source_document ENABLE ROW LEVEL SECURITY;

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

\unrestrict beWnMrTRMxZ8ZzmTRCQy8hfvwUzJCi2CEsOX8lXVKwuWVIazAtNKHe4SmrzJEA2

