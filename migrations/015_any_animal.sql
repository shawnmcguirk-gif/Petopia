-- =============================================================
-- Petopia DB -- 015: any kind of animal (Ryan, 2026-10-08: "the app needs to support any type of animal not just cats and
-- dogs"). Spec sec 3.3's species modules, pulled forward from v2.1. Idempotent.
--   * ref.species.module_code: which module an animal of that species uses. Many species share one module (rabbit and
--     guinea pig are both small_mammal), so the species picker no longer needs one module per species.
--   * Eight new modules (small_mammal, cage_bird, poultry, reptile, amphibian, aquarium_fish, equine, other) and ~35
--     species rows. "Other animal" is the type-it-yourself fallback: the person's own words go in the animal's own
--     ext.species_name (the engine requires it for that species), never into this shared table.
--   * vaccine_set stays empty except for horses: the app offers names only where the list is uncontroversial.
-- The schema bodies below are byte-identical copies of engine/schemas/species/<code>.json
-- (engine/test/species.test.ts fails if they drift).
-- =============================================================

ALTER TABLE ref.species ADD COLUMN IF NOT EXISTS module_code text NULL REFERENCES ref.species_module(code);

INSERT INTO ref.species_module (code, species_id, schema, schema_version, measures, default_routines, vaccine_set)
VALUES
  ('small_mammal', NULL, $small_mammal${
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "petopia/species/small_mammal/1",
  "title": "Small mammal extension (Petopia D1 sec 3.3)",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "housing": { "type": "string", "enum": ["INDOOR", "OUTDOOR", "BOTH"] },
    "registry_reg": { "type": "string", "minLength": 1, "maxLength": 64 }
  }
}$small_mammal$::jsonb, 1,
   ARRAY['weight']::text[],
   '["FEED","GROOM","NAILS","TEETH","CAGE_CLEAN","BEDDING"]'::jsonb,
   ARRAY[]::text[]),
  ('cage_bird', NULL, $cage_bird${
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "petopia/species/cage_bird/1",
  "title": "Bird extension (Petopia D1 sec 3.3)",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "ring_number": { "type": "string", "minLength": 1, "maxLength": 64 },
    "wings_clipped": { "type": "boolean" }
  }
}$cage_bird$::jsonb, 1,
   ARRAY['weight']::text[],
   '["FEED","BATH","NAILS","CAGE_CLEAN","BEDDING"]'::jsonb,
   ARRAY[]::text[]),
  ('poultry', NULL, $poultry${
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "petopia/species/poultry/1",
  "title": "Poultry extension (Petopia D1 sec 3.3)",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "flock_name": { "type": "string", "minLength": 1, "maxLength": 80 },
    "ring_number": { "type": "string", "minLength": 1, "maxLength": 64 }
  }
}$poultry$::jsonb, 1,
   ARRAY['weight']::text[],
   '["FEED","CAGE_CLEAN","BEDDING","WORM","OTHER"]'::jsonb,
   ARRAY[]::text[]),
  ('reptile', NULL, $reptile${
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "petopia/species/reptile/1",
  "title": "Reptile extension (Petopia D1 sec 3.3)",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "basking_temp_target_c": { "type": "integer", "minimum": 0, "maximum": 60 },
    "uvb_lamp_changed_on": { "type": "string", "pattern": "^[0-9]{4 }-[0-9]{2 }-[0-9]{2 }$" }
  }
}$reptile$::jsonb, 1,
   ARRAY['weight']::text[],
   '["FEED","BATH","CAGE_CLEAN","BEDDING","OTHER"]'::jsonb,
   ARRAY[]::text[]),
  ('amphibian', NULL, $amphibian${
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "petopia/species/amphibian/1",
  "title": "Amphibian extension (Petopia D1 sec 3.3)",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "enclosure_type": { "type": "string", "enum": ["AQUATIC", "SEMI_AQUATIC", "TERRESTRIAL"] }
  }
}$amphibian$::jsonb, 1,
   ARRAY['weight']::text[],
   '["FEED","TANK_CLEAN","WATER_TEST","CAGE_CLEAN"]'::jsonb,
   ARRAY[]::text[]),
  ('aquarium_fish', NULL, $aquarium_fish${
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "petopia/species/aquarium_fish/1",
  "title": "Fish extension (Petopia D1 sec 3.3)",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "water_type": { "type": "string", "enum": ["FRESH", "MARINE", "BRACKISH"] },
    "group_size": { "type": "integer", "minimum": 1, "maximum": 10000 }
  }
}$aquarium_fish$::jsonb, 1,
   ARRAY[]::text[],
   '["FEED","TANK_CLEAN","WATER_TEST"]'::jsonb,
   ARRAY[]::text[]),
  ('equine', NULL, $equine${
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "petopia/species/equine/1",
  "title": "Horse extension (Petopia D1 sec 3.3)",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "passport_number": { "type": "string", "minLength": 1, "maxLength": 64 },
    "height_hands": { "type": "number", "minimum": 1, "maximum": 30 }
  }
}$equine$::jsonb, 1,
   ARRAY['weight']::text[],
   '["FEED","GROOM","TEETH","WORM","VACCINATION","OTHER"]'::jsonb,
   ARRAY['Equine influenza','Tetanus']::text[]),
  ('other', NULL, $other${
  "$schema": "http://json-schema.org/draft-07/schema#",
  "$id": "petopia/species/other/1",
  "title": "Other animal extension (Petopia D1 sec 3.3)",
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "species_name": { "type": "string", "minLength": 1, "maxLength": 80 }
  }
}$other$::jsonb, 1,
   ARRAY['weight']::text[],
   '["FEED","GROOM","BATH","NAILS","TEETH","CAGE_CLEAN","BEDDING","OTHER"]'::jsonb,
   ARRAY[]::text[])
ON CONFLICT (code) DO UPDATE SET schema = EXCLUDED.schema, schema_version = EXCLUDED.schema_version
  WHERE ref.species_module.schema_version < EXCLUDED.schema_version;

INSERT INTO ref.species (common_name, scientific_name, "group", domain) VALUES
  ('Rabbit', 'Oryctolagus cuniculus', 'MAMMAL', 'PET'),
  ('Guinea pig', 'Cavia porcellus', 'MAMMAL', 'PET'),
  ('Hamster', NULL, 'MAMMAL', 'PET'),
  ('Gerbil', NULL, 'MAMMAL', 'PET'),
  ('Rat', 'Rattus norvegicus', 'MAMMAL', 'PET'),
  ('Mouse', 'Mus musculus', 'MAMMAL', 'PET'),
  ('Chinchilla', 'Chinchilla lanigera', 'MAMMAL', 'PET'),
  ('Ferret', 'Mustela furo', 'MAMMAL', 'PET'),
  ('Hedgehog', NULL, 'MAMMAL', 'PET'),
  ('Degu', 'Octodon degus', 'MAMMAL', 'PET'),
  ('Budgerigar', 'Melopsittacus undulatus', 'BIRD', 'PET'),
  ('Cockatiel', 'Nymphicus hollandicus', 'BIRD', 'PET'),
  ('Parrot', NULL, 'BIRD', 'PET'),
  ('Canary', 'Serinus canaria', 'BIRD', 'PET'),
  ('Finch', NULL, 'BIRD', 'PET'),
  ('Chicken', 'Gallus gallus domesticus', 'BIRD', 'PET'),
  ('Duck', 'Anas platyrhynchos domesticus', 'BIRD', 'PET'),
  ('Goose', 'Anser anser domesticus', 'BIRD', 'PET'),
  ('Bearded dragon', 'Pogona vitticeps', 'REPTILE', 'PET'),
  ('Leopard gecko', 'Eublepharis macularius', 'REPTILE', 'PET'),
  ('Corn snake', 'Pantherophis guttatus', 'REPTILE', 'PET'),
  ('Ball python', 'Python regius', 'REPTILE', 'PET'),
  ('Tortoise', NULL, 'REPTILE', 'PET'),
  ('Turtle or terrapin', NULL, 'REPTILE', 'PET'),
  ('Axolotl', 'Ambystoma mexicanum', 'AMPHIBIAN', 'PET'),
  ('Frog', NULL, 'AMPHIBIAN', 'PET'),
  ('Goldfish', 'Carassius auratus', 'FISH', 'PET'),
  ('Betta', 'Betta splendens', 'FISH', 'PET'),
  ('Koi', 'Cyprinus rubrofuscus', 'FISH', 'PET'),
  ('Bala shark', 'Balantiocheilos melanopterus', 'FISH', 'PET'),
  ('Angelfish', 'Pterophyllum scalare', 'FISH', 'PET'),
  ('Tiger barb', 'Puntigrus tetrazona', 'FISH', 'PET'),
  ('Torpedo barb', 'Sahyadria denisonii', 'FISH', 'PET'),
  ('Tropical fish', NULL, 'FISH', 'PET'),
  ('Horse', 'Equus ferus caballus', 'MAMMAL', 'PET'),
  ('Pony', NULL, 'MAMMAL', 'PET'),
  ('Donkey', 'Equus asinus', 'MAMMAL', 'PET'),
  ('Goat', 'Capra hircus', 'MAMMAL', 'PET'),
  ('Sheep', 'Ovis aries', 'MAMMAL', 'PET'),
  ('Pig', 'Sus scrofa domesticus', 'MAMMAL', 'PET'),
  ('Other animal', NULL, 'OTHER', 'PET')
ON CONFLICT (common_name) DO NOTHING;

UPDATE ref.species s SET module_code = v.module_code
  FROM (VALUES
    ('Dog','dog'),('Cat','cat'),
    ('Rabbit','small_mammal'),
    ('Guinea pig','small_mammal'),
    ('Hamster','small_mammal'),
    ('Gerbil','small_mammal'),
    ('Rat','small_mammal'),
    ('Mouse','small_mammal'),
    ('Chinchilla','small_mammal'),
    ('Ferret','small_mammal'),
    ('Hedgehog','small_mammal'),
    ('Degu','small_mammal'),
    ('Budgerigar','cage_bird'),
    ('Cockatiel','cage_bird'),
    ('Parrot','cage_bird'),
    ('Canary','cage_bird'),
    ('Finch','cage_bird'),
    ('Chicken','poultry'),
    ('Duck','poultry'),
    ('Goose','poultry'),
    ('Bearded dragon','reptile'),
    ('Leopard gecko','reptile'),
    ('Corn snake','reptile'),
    ('Ball python','reptile'),
    ('Tortoise','reptile'),
    ('Turtle or terrapin','reptile'),
    ('Axolotl','amphibian'),
    ('Frog','amphibian'),
    ('Goldfish','aquarium_fish'),
    ('Betta','aquarium_fish'),
    ('Koi','aquarium_fish'),
    ('Bala shark','aquarium_fish'),
    ('Angelfish','aquarium_fish'),
    ('Tiger barb','aquarium_fish'),
    ('Torpedo barb','aquarium_fish'),
    ('Tropical fish','aquarium_fish'),
    ('Horse','equine'),
    ('Pony','equine'),
    ('Donkey','equine'),
    ('Goat','other'),
    ('Sheep','other'),
    ('Pig','other'),
    ('Other animal','other')
  ) AS v(common_name, module_code)
 WHERE s.common_name = v.common_name AND s.module_code IS NULL;

-- Garden wildlife the household watches (Ryan, 2026-10-08): reference rows only, domain WILD, no module -- so they are
-- NOT offered in "Add animal" (they are not pets). v2's Wildlife (sightings, Species We've Seen, Named Visitors) uses them.
INSERT INTO ref.species (common_name, scientific_name, "group", domain) VALUES
  ('Robin', 'Erithacus rubecula', 'BIRD', 'WILD'),
  ('Collared dove', 'Streptopelia decaocto', 'BIRD', 'WILD'),
  ('Blackbird', 'Turdus merula', 'BIRD', 'WILD'),
  ('House sparrow', 'Passer domesticus', 'BIRD', 'WILD'),
  ('Tree sparrow', 'Passer montanus', 'BIRD', 'WILD'),
  ('Starling', 'Sturnus vulgaris', 'BIRD', 'WILD'),
  ('Feral pigeon', 'Columba livia domestica', 'BIRD', 'WILD'),
  ('Wood pigeon', 'Columba palumbus', 'BIRD', 'WILD'),
  ('Blue tit', 'Cyanistes caeruleus', 'BIRD', 'WILD'),
  ('Great tit', 'Parus major', 'BIRD', 'WILD'),
  ('Coal tit', 'Periparus ater', 'BIRD', 'WILD'),
  ('Long-tailed tit', 'Aegithalos caudatus', 'BIRD', 'WILD'),
  ('Bullfinch', 'Pyrrhula pyrrhula', 'BIRD', 'WILD'),
  ('Song thrush', 'Turdus philomelos', 'BIRD', 'WILD'),
  ('Mistle thrush', 'Turdus viscivorus', 'BIRD', 'WILD'),
  ('Redwing', 'Turdus iliacus', 'BIRD', 'WILD'),
  ('Sparrowhawk', 'Accipiter nisus', 'BIRD', 'WILD'),
  ('Red fox', 'Vulpes vulpes', 'MAMMAL', 'WILD'),
  ('Grey squirrel', 'Sciurus carolinensis', 'MAMMAL', 'WILD'),
  ('Red squirrel', 'Sciurus vulgaris', 'MAMMAL', 'WILD'),
  ('Common frog', 'Rana temporaria', 'AMPHIBIAN', 'WILD')
ON CONFLICT (common_name) DO NOTHING;
