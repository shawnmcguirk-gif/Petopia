-- =============================================================
-- Petopia DB -- 016: fixes from the independent review of "any kind of animal" (2026-10-08, docs/reviews/2026-10-08-any-animal-review.md).
-- Written as explicit UPDATEs, NOT as 015 edits and NOT with 004/015's "ON CONFLICT ... WHERE schema_version <" upsert:
-- migrate.sh runs each file once and that upsert skips a changed row, so an edited 015 would never reach a database that
-- has already run it (finding 4). engine/test/any-animal.db.test.ts now also checks the DATABASE against the schema files.
--   * Rabbits get their own module: a Myxomatosis / RHD vaccination reminder and vaccine names (finding 5).
--   * Suggested routines per module corrected: no "daily teeth" for horses and rabbits, no baths for a tarantula, no
--     meaningless "Care" (kind OTHER) suggestion; OTHER stays a valid kind a person can add by hand (finding 1).
--   * equine ext: `height_hands` (15.2 hh means 15 hands 2 inches, not 15.2) becomes `height_cm` (finding 13). No animal can
--     hold the old field yet (equine shipped in 015, a day earlier, with none added).
--   * Species names are unique ignoring case, so resolving one by name is never ambiguous (finding 9).
--   * Red squirrel is protected in Ireland: sensitive = true now, so v2 never shows its location (finding 15).
-- `measures` and `vaccine_set` are informational today: nothing in the engine or web reads them yet (finding 14).
-- =============================================================

CREATE UNIQUE INDEX IF NOT EXISTS uq_species_name_ci ON ref.species (lower(common_name));

INSERT INTO ref.species_module (code, species_id, schema, schema_version, measures, default_routines, vaccine_set)
VALUES ('rabbit', NULL, $rabbit${
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "petopia/species/rabbit/1",
  "title": "Rabbit extension (Petopia D1 sec 3.3)",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "housing": { "type": "string", "enum": ["INDOOR", "OUTDOOR", "BOTH"] },
    "registry_reg": { "type": "string", "minLength": 1, "maxLength": 64 }
  }
}$rabbit$::jsonb, 1,
   ARRAY['weight']::text[],
   '["FEED","GROOM","NAILS","VACCINATION","CAGE_CLEAN","BEDDING"]'::jsonb,
   ARRAY['Myxomatosis','RHD1','RHD2']::text[])
ON CONFLICT (code) DO NOTHING;

UPDATE ref.species SET module_code = 'rabbit' WHERE common_name = 'Rabbit' AND module_code = 'small_mammal';
UPDATE ref.species SET sensitive = true WHERE common_name = 'Red squirrel';

UPDATE ref.species_module SET default_routines = '["FEED","GROOM","NAILS","CAGE_CLEAN","BEDDING"]'::jsonb WHERE code = 'small_mammal';
UPDATE ref.species_module SET default_routines = '["FEED","BATH","NAILS","CAGE_CLEAN","BEDDING"]'::jsonb WHERE code = 'cage_bird';
UPDATE ref.species_module SET default_routines = '["FEED","CAGE_CLEAN","BEDDING","WORM"]'::jsonb WHERE code = 'poultry';
UPDATE ref.species_module SET default_routines = '["FEED","BATH","CAGE_CLEAN","BEDDING"]'::jsonb WHERE code = 'reptile';
UPDATE ref.species_module SET default_routines = '["FEED","TANK_CLEAN","WATER_TEST","CAGE_CLEAN"]'::jsonb WHERE code = 'amphibian';
UPDATE ref.species_module SET default_routines = '["FEED","TANK_CLEAN","WATER_TEST"]'::jsonb WHERE code = 'aquarium_fish';
UPDATE ref.species_module SET default_routines = '["FEED","GROOM","WORM","VACCINATION"]'::jsonb WHERE code = 'equine';
UPDATE ref.species_module SET default_routines = '["FEED","GROOM","CAGE_CLEAN","BEDDING"]'::jsonb WHERE code = 'other';

UPDATE ref.species_module SET schema = $equine${
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "petopia/species/equine/2",
  "title": "Horse extension (Petopia D1 sec 3.3)",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "passport_number": { "type": "string", "minLength": 1, "maxLength": 64 },
    "height_cm": { "type": "integer", "minimum": 30, "maximum": 220 }
  }
}$equine$::jsonb, schema_version = 2, vaccine_set = ARRAY['Equine influenza','Tetanus']::text[]
 WHERE code = 'equine' AND schema_version = 1;
