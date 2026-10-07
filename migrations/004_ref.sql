-- =============================================================
-- Petopia DB -- 004: reference data (D1 spec sec 3.3, 3.8; A6). Shared by every household, so no workspace_id
-- and no RLS: these rows say nothing about anyone's animals. ref.species is shared by pets and (v2) wildlife.
-- ref.species_module is the extension registry: an animal's `ext` is validated against its module's JSON Schema
-- by ajv in the engine. A new species = a new module row + schema file; no migration of animal.animal.
-- The two schema bodies below are byte-identical copies of engine/schemas/species/{dog,cat}.json
-- (engine/test/species.test.ts fails if they drift). Idempotent.
-- =============================================================

CREATE TABLE IF NOT EXISTS ref.species (
  species_id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  common_name     text NOT NULL UNIQUE,
  scientific_name text NULL,
  "group"         text NOT NULL CHECK ("group" IN ('DOG','CAT','BIRD','MAMMAL','AMPHIBIAN','REPTILE','FISH','INSECT','OTHER')),
  domain          text NOT NULL CHECK (domain IN ('PET','WILD','BOTH')),
  sensitive       boolean NOT NULL DEFAULT false,
  facts           jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS ref.species_module (
  code             text PRIMARY KEY CHECK (code ~ '^[a-z_]+$'),
  species_id       bigint NULL REFERENCES ref.species(species_id),
  schema           jsonb NOT NULL,
  schema_version   integer NOT NULL CHECK (schema_version > 0),
  measures         text[] NOT NULL DEFAULT '{}',
  default_routines jsonb NOT NULL DEFAULT '[]'::jsonb,
  vaccine_set      text[] NOT NULL DEFAULT '{}'
);

INSERT INTO ref.species (common_name, scientific_name, "group", domain) VALUES
  ('Dog', 'Canis familiaris', 'DOG', 'PET'),
  ('Cat', 'Felis catus', 'CAT', 'PET')
  ON CONFLICT (common_name) DO NOTHING;

INSERT INTO ref.species_module (code, species_id, schema, schema_version, measures, default_routines, vaccine_set)
VALUES
  ('dog', (SELECT species_id FROM ref.species WHERE common_name = 'Dog'), $dog${
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "petopia/species/dog/1",
  "title": "Dog extension (Petopia D1 sec 3.3)",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "coat_type": { "type": "string", "enum": ["SHORT", "MEDIUM", "LONG", "WIRE", "CURLY", "DOUBLE", "HAIRLESS"] },
    "walk_minutes_target": { "type": "integer", "minimum": 0, "maximum": 600 },
    "kennel_club_reg": { "type": "string", "minLength": 1, "maxLength": 64 }
  }
}$dog$::jsonb, 1,
   ARRAY['weight','bcs'],
   '["WALK","GROOM","NAILS","TEETH","FLEA","WORM","VACCINATION"]'::jsonb,
   ARRAY['DHPPi','Leptospirosis','Kennel cough','Rabies']),
  ('cat', (SELECT species_id FROM ref.species WHERE common_name = 'Cat'), $cat${
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "petopia/species/cat/1",
  "title": "Cat extension (Petopia D1 sec 3.3)",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "coat_type": { "type": "string", "enum": ["SHORT", "MEDIUM", "LONG", "HAIRLESS"] },
    "indoor_outdoor": { "type": "string", "enum": ["INDOOR", "OUTDOOR", "BOTH"] },
    "registry_reg": { "type": "string", "minLength": 1, "maxLength": 64 }
  }
}$cat$::jsonb, 1,
   ARRAY['weight','bcs'],
   '["GROOM","NAILS","TEETH","FLEA","WORM","VACCINATION"]'::jsonb,
   ARRAY['Feline enteritis','Cat flu','Feline leukaemia','Rabies'])
ON CONFLICT (code) DO UPDATE SET schema = EXCLUDED.schema, schema_version = EXCLUDED.schema_version
  WHERE ref.species_module.schema_version < EXCLUDED.schema_version;
