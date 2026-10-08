# Petopia — design spec (draft 1)

**Status:** proposal spec, draft 1, 2026-10-07. Written from `REQUEST.md` (Ryan's brief, frozen), `QUESTIONS.md`,
`annotations.md` and a read of the live Synapse, Vitalis, Epicure and Truehaven repos. Not accepted. No D-number
yet: on lift this becomes **Petopia D1 (Petopia core: pets, care records, inbox, reminders)**, filed by a `decision`
receipt (CONVENTIONS sec 29) and moved only by Ryan's stage words (sec 33).

**How to read the tags** used throughout:

| Tag | Means |
|---|---|
| **[R]** | Ryan said it (REQUEST.md section number, or QUESTIONS.md Qn) |
| **[I]** | Inferred from the repos — the file is named so it can be checked |
| **[P]** | Proposed by this spec — a design choice, open to Ryan's veto |

---

## 0. Petopia in one minute

- **What:** the household's pets-and-wildlife centre inside Synapse. Two questions it must answer well **[R end]**:
  - "How are the animals we care for doing?"
  - "What animals are sharing our world with us?"
- **How it is built [P, copying I]:** a new engine exactly like Vitalis — its own `petopia` Postgres database,
  a TypeScript engine that owns every rule, a React web UI served by the engine, reached inside Synapse at
  `/petopia/` through Caddy, opened from a new tile on the Synapse home menu.
- **v1 [R end]:** Add Banoffee → photograph → basic profile → feeding → weight → vet records → reminders.
- **Trust rule [R §4, §30]:** anything a model reads or suggests is a *proposal* until a person confirms it.
  The original document is always kept.
- **Navigation [P]:** four places — **Home · Animals · Wildlife · Inbox** — plus an **Ask** button on every screen.
  Health, care, timeline, documents and costs live *inside* each animal, not as top-level menus.

---

## 1. Scope — v1 and later

### 1.1 The v1 cut line

**v1 = the brief's own order, plus only what it needs to work [R end].** Everything below the line is designed for
(tables and fields exist where cheap) but not built.

| # | v1 step | What "done" looks like for Banoffee |
|---|---|---|
| 1 | Add an animal | Banoffee exists: dog, Shih Tzu, estimated birth year 2018, Owner set |
| 2 | Photograph | A photo taken or uploaded on the phone is her profile picture; location data stripped |
| 3 | Basic profile | Name, sex, colour, microchip, neutered, vet practice, emergency contact, insurer (name + policy number only) |
| 4 | Feeding | Current food (brand, product, portion, times); history kept when the food changes |
| 5 | Weight | 6.1 kg recorded; chart; change since last; plausibility question on odd entries |
| 6 | Vet records | Vet visits, vaccinations, treatments (flea/worm), medication, conditions, allergies; vet documents dropped in the Inbox, read by AI, confirmed by a person |
| 7 | Reminders | Today and Coming Up lists in Petopia; care routines (feed, walk, groom, flea, worm, vaccination due, medication); vet appointments sent to the Synapse calendar |

Plus, needed for v1 to be usable at all:
- The Synapse menu tile and hero (sec 11), using Ryan's two images **[R Q1]**.
- Home dashboard with **Our Pets, Today, Coming Up** (sections with nothing to show are hidden, not shown empty).
- Roles on each animal (Owner / Primary carer / Family member / Viewer) and the shared care log ("Fed", "Walked",
  "Medication given") **[R §21]** — the care log *is* how reminders get ticked off.
- Habitats as a table from day one (Home, Garden seeded) so wildlife and aquariums need no redesign **[R §25]**.

**───────────── v1 cut line ─────────────**

### 1.2 Later, in order

| Release | Adds | Why this order |
|---|---|---|
| **v1.1** | Vet Pack (sec 9.4); life timeline with memories, photos, milestones; costs by animal/category; insurance policy + claims + renewal reminder | All built from v1 data; no new AI |
| **v1.2** | Petopia assistant ("Ask") over the record (sec 10) | Needs a full v1 record to be worth asking |
| **v2** | Wildlife: photo identification, sightings journal, Species We've Seen, Named Visitors, Wildlife Today on Home | Separate domain; reuses habitats and the inbox photo path |
| **v2.1** | Species modules beyond dog/cat: fish + aquarium water tests, birds, horses, reptiles, small mammals (sec 3.3) | The extension mechanism ships in v1; modules are data |
| **v3** | Discover (species/breed pages), Garden Wildlife advice, Insights on Home, "The Story of Banoffee" album | Need reference content and enough history |
| **v3+** | Integrations beyond the calendar: Truehaven read view, Epicure shopping needs, Scout topics (sec 6) | Each waits on the other app's side (Scout is dark today **[I Synapse/DESIGN.md D17]**) |

---

## 2. Architecture — copy Vitalis, invent nothing

Everything in this table is copied from a live sibling. Petopia adds no new kind of infrastructure.

| Layer | Petopia choice [P] | Copied from [I] |
|---|---|---|
| Database | Own `petopia` DB on the shared `postgres` container; role `petopia_app`; CONNECT revoked from PUBLIC | Vitalis S2.1, `Vitalis/migrations/001-002` |
| Isolation | One workspace = the household. FORCE row-level security on every content table, fail-closed policy `workspace_id = NULLIF(current_setting('app.current_workspace_id', true), '')::bigint` | Vitalis S0.2, Epicure sec 3 |
| Migrations | Numbered, idempotent raw SQL; `engine/scripts/migrate.sh`; `schema.sql` dump | `Vitalis/engine/scripts/migrate.sh` |
| Engine | TypeScript, framework-free `node:http`, `pg` + Kysely, `decimal.js` (money, weights), `ajv` (every AI output and every species extension), Vitest, ESLint | `Vitalis/engine/`, `Epicure/engine/package.json` |
| Identity | Synapse device token `X-Serenity-Device`, verified against n8n `verify-device`; any approved member; fails closed | `Epicure/engine/src/auth.ts`, Vitalis S0.4 |
| Feature gate | `verify-device` returns `allowed_features`; engine refuses a member without `petopia` (once the vocabulary has it, sec 11.3) | Synapse HANDOFF 2026-10-07 (D39) |
| Web | React 19 + Vite + Tailwind 4, built to `web/dist`, served by the engine; installable PWA | `Vitalis/web/package.json` |
| Hosting | **Native LaunchAgent** `com.petopia.engine` on the iMac, port **4400** | Vitalis `engine/deploy/install-launchagent.sh` (:4200). Native, not a container, because the AI reader runs the `claude` CLI on the iMac (sec 5) |
| Routing | Caddy `handle_path /petopia/*` → `host.docker.internal:4400` | `Synapse/serenity-web/Caddyfile` lines 355-373 |
| Documents | The Obsidian household vault is the only copy; DB stores vault path + SHA-256 | Vitalis S0.5, `Vitalis/engine/src/vault.ts` |
| Photos | Decoded and re-encoded (max 1600 px JPEG, **all metadata stripped incl. GPS**), named by SHA-256, kept in `<vault>/_petopia-media/` | `Epicure/engine/src/photos.ts` |
| OCR | glm-ocr on the Alienware Ollama over Tailscale (`OLLAMA_URL`) | Vitalis LaunchAgent env |
| AI reading | `claude -p` headless, **no tools**, JSON schema output, one document per call | Vitalis S7 v2 |
| Scheduling | The engine sweeps its own inbox every 60 s; n8n never touches the DB | `Vitalis/engine/src/sweep.ts` |
| Calendar | Engine calls Synapse `/webhook/events` with `X-Serenity-Service` | `Vitalis/engine/src/calendar.ts` |

Port 4400 is the next free number after Truehaven 4100, Vitalis 4200, Epicure 4300 **[I Caddyfile]** — to be
re-checked with `lsof -i :4400` before install.

---

## 3. Entities and relationships

### 3.1 The shape, in one picture

```
Household (workspace)
 ├─ Member ──< AnimalRole >── Animal ──< extension (species module, jsonb)
 │                              │
 │                              ├──< Measurement (weight, length, BCS...)      ┐
 │                              ├──< FeedingPlan (history kept)                │
 │                              ├──< VetVisit ──< Vaccination / Treatment      │  all of these are
 │                              ├──< Condition, Allergy, Procedure, LabResult  │  EVENTS: each one
 │                              ├──< Medication ──< MedicationEvent            ├─ appears on ONE
 │                              ├──< Routine ──< CareLog                       │  Timeline (a view,
 │                              ├──< Cost, InsurancePolicy ──< Claim           │  not a table)
 │                              └──< Moment (photo, milestone, memory)         ┘
 ├─ Habitat (Home, Garden, Pond, Aquarium, Feeder...) ── animals live in / sightings happen in
 ├─ Contact (vet, clinic, breeder, insurer, emergency contact)
 ├─ SourceDocument ── evidence for any event above (provenance, sec 4)
 └─ Wildlife: Species (ref) ──< Sighting >── NamedVisitor
```

### 3.2 Conventions for every table [P, copying I Vitalis S2.2 / Epicure sec 5]

- Primary key `bigint GENERATED ALWAYS AS IDENTITY`; `workspace_id` on every row except `ref.*`.
- `created_by` / `created_at`; people are stored as the Synapse `member_name` text.
- Never delete clinical facts: a correction inserts a new row that `supersedes_id` the old one.
  Non-clinical rows (photos, moments, routines) are soft-closed with `retired_at`.
- Money: `numeric(12,2)` + `currency` (EUR default). Weight stored in kg, `numeric(7,3)`.
- Dates that may be vague carry a `*_precision` column: `DAY` / `MONTH` / `YEAR` / `UNKNOWN`.
- Every **fact table** (marked ⓟ below) carries the provenance block in sec 4.2.

### 3.3 Animal core + species extensions

**Design [P]:** one `animal` table for every animal. Species-specific fields live in a **species module**: a
registry row with a JSON Schema. The animal's `ext` (jsonb) is validated against it by `ajv`. Things that change
over time (water pH, hoof trims) are **not** in `ext` — they are measurements or routines, which already work for
every species. New species = new module row + schema file. No migration, no core change **[R §24]**.

`animal.animal`

| Field | Type | Notes |
|---|---|---|
| `name` | text | "Banoffee" |
| `nickname` | text null | |
| `species_id` | FK `ref.species` | Dog |
| `breed` | text null | "Shih Tzu" — free text in v1; `ref.breed` later |
| `module_code` | FK `ref.species_module` | `dog` — decides which extension fields and default routines apply |
| `ext` | jsonb | validated against the module schema + `ext_schema_version` |
| `sex` | `FEMALE`/`MALE`/`UNKNOWN` | |
| `neuter_status` | `NEUTERED`/`ENTIRE`/`UNKNOWN` | |
| `colour_markings` | text null | |
| `born_on` + `born_precision` | date + precision | Banoffee: 2018-01-01, `YEAR` → shown "about 8" |
| `acquired_on` + precision | date | Brief example: 2019 **[R §12]** |
| `source` | text null | breeder / rescue / previous owner |
| `microchip` | text null | unique per workspace when present; the strongest key for matching documents |
| `registration` | text null | pedigree / licence numbers |
| `vet_contact_id` | FK `core.contact` | the usual practice |
| `emergency_contact_id` | FK `core.contact` | |
| `habitat_id` | FK `core.habitat` | Home |
| `profile_media_id` | FK `media.item` | |
| `status` | `ACTIVE`/`REHOMED`/`DECEASED` + `status_on` | a pet who has died keeps their whole record and story |
| `kind` | `PET` / `CARED_FOR` | cared-for = a neighbour's dog we mind, a foster |

Age is never stored: it is computed from `born_on` and shown with its precision ("about 8 years").

`ref.species_module` — the extension registry (v1 ships `dog` and `cat`; **amended 2026-10-08: the other modules below ship in v1 too, see sec 3.3.1**)

| Field | Notes |
|---|---|
| `code` | `dog`, `cat`, `aquarium_fish`, `cage_bird`, `equine`, `reptile`, `small_mammal`, `poultry` |
| `schema` jsonb, `schema_version` | JSON Schema for `ext` |
| `measures` | measure codes offered (dog: `weight`, `bcs`; fish: none per animal — water tests go on the aquarium habitat) |
| `default_routines` jsonb | proposed when an animal is added, never auto-created (dog: walk, groom, nails, teeth, flea, worm, annual vaccination) |
| `vaccine_set` | names offered in pick lists |

Example `ext` per module **[R §24]**:

| Module | `ext` fields |
|---|---|
| dog | `coat_type`, `walk_minutes_target`, `kennel_club_reg` |
| aquarium_fish | `tank_habitat_id`, `group_size`, `water_type` (fresh/marine) |
| cage_bird | `enclosure_habitat_id`, `wings_clipped`, `ring_number` |
| equine | `stable_habitat_id`, `passport_number`, `farrier_contact_id`, `height_hands` |
| reptile | `enclosure_habitat_id`, `basking_temp_target_c`, `uvb_lamp_changed_on` |

### 3.3.1 Amendment 2026-10-08 — any kind of animal ships in v1 (Ryan: "the app needs to support any type of animal not just cats and dogs")

Pulls the v2.1 species modules forward. Built as migrations 015 + 016; reviewed in `docs/reviews/2026-10-08-any-animal-review.md`.

- **Many species, one module.** `ref.species.module_code` names the module an animal of that species uses (rabbit and hamster differ; goldfish and tiger barb share). `ref.species_module.species_id` is legacy (dog, cat only). Species names are unique ignoring case.
- **Modules shipped:** `dog`, `cat`, `rabbit`, `small_mammal` (hamster, guinea pig, gerbil, rat, mouse, chinchilla, ferret, hedgehog, degu), `cage_bird`, `poultry` (chicken, duck, goose), `reptile`, `amphibian` (axolotl, frog), `aquarium_fish` (goldfish, betta, koi, bala shark, angelfish, tiger barb, torpedo barb, tropical fish), `equine` (horse, pony, donkey), `other`.
- **`other` and "Other animal".** Goat, sheep and pig sit on `other`. The species "Other animal" is the type-it-yourself fallback: the person's words go in that animal's own `ext.species_name` (required, trimmed; refused on any other species). Nothing a household types is written to `ref.*`. Typing a kind we already hold ("Rabbit") is resolved to that species and its module.
- **Ext deviations from the sec 3.3 examples:** habitat links (`tank_habitat_id`, `enclosure_habitat_id`, `stable_habitat_id`) and `farrier_contact_id` are NOT in v1 schemas (an ext cannot hold a foreign key the DB checks; habitats for tanks/enclosures arrive with water tests in v2.1). Equine uses `height_cm`, not `height_hands` (15.2 hh is 15 hands 2 inches, so a decimal misleads).
- **Suggested care is per module** (never auto-created): e.g. rabbit gets feed, groom, nails, vaccination (Myxomatosis, RHD1, RHD2), cage, bedding; a horse gets feed, groom, worming, vaccination; "Other animal" gets feed, groom, cage, bedding. `measures` and `vaccine_set` are informational today (nothing reads them yet). Weight typing-slip bounds are per module in `measures.ts`.
- **Wildlife is still v2.** The garden species Ryan listed (robin, collared dove, blackbird, house/tree sparrow, starling, feral and wood pigeon, blue/great/coal/long-tailed tit, bullfinch, song/mistle thrush, redwing, sparrowhawk, red fox, grey/red squirrel, common frog) are seeded in `ref.species` with `domain = 'WILD'`, no module, and are not offered in Add animal. Red squirrel is `sensitive`.

### 3.4 Habitat (first-class) [R §25]

`core.habitat`

| Field | Notes |
|---|---|
| `name` | "Home", "Back garden", "Pond", "Kitchen aquarium", "Feeder by the shed" |
| `kind` | `HOME`, `GARDEN`, `POND`, `AQUARIUM`, `FEEDER`, `NEST_BOX`, `TERRARIUM`, `STABLE`, `OTHER` |
| `parent_id` | Feeder → Back garden → Home |
| `ext` jsonb | per kind: aquarium `litres`, `water_type`; feeder `food_type` |

Habitats can have measurements (aquarium pH), routines (refill feeder) and sightings. Two seeded: Home, Garden.

### 3.5 Health and care events (all appear on the Timeline)

| Table | Key fields | ⓟ |
|---|---|---|
| `health.measurement` | `subject` = `animal_id` **or** `habitat_id` (CHECK exactly one), `measure` (registry code), `value`, `unit`, `value_as_entered`, `unit_as_entered`, `observed_at`, `time_precision` | ⓟ |
| `health.vet_visit` | `animal_id`, `visit_on`, `kind` (`ROUTINE`,`ILLNESS`,`EMERGENCY`,`SURGERY`,`REFERRAL`,`FOLLOW_UP`), `contact_id` (vet/clinic), `reason`, `symptoms`, `examination`, `diagnosis_text`, `treatment_text`, `follow_up_on`, `notes`, `calendar_event_id` | ⓟ |
| `health.vaccination` | `animal_id`, `vaccine`, `given_on`, `next_due_on`, `batch`, `vet_visit_id` | ⓟ |
| `health.treatment` | `animal_id`, `kind` (`FLEA`,`WORM`,`TICK`,`DENTAL`,`OTHER`), `product`, `given_on`, `next_due_on`, `vet_visit_id` | ⓟ |
| `health.condition` | `animal_id`, `name`, `status` (`SUSPECTED`,`ACTIVE`,`RESOLVED`), `first_noted_on`, `vet_visit_id` | ⓟ |
| `health.allergy` | `animal_id`, `substance` (food or drug), `reaction`, `certainty` (`CONFIRMED_BY_VET`,`SUSPECTED`) | ⓟ |
| `health.procedure` | `animal_id`, `name`, `performed_on`, `vet_visit_id`, `outcome` (operations, dental, imaging) | ⓟ |
| `health.lab_result` | `animal_id`, `test`, `analyte`, `value_printed`, `unit_printed`, `ref_range_printed`, `flag_printed`, `sampled_on`, `vet_visit_id` | ⓟ |
| `health.medication` | `animal_id`, `product_name`, `strength`, `form` — a "thing", no provenance | |
| `health.medication_event` | `medication_id`, `event_kind` (`PRESCRIBED`,`STARTED`,`DOSE_CHANGED`,`STOPPED`), `event_on`, `dose_text`, `dose_amount`, `dose_unit`, `frequency`, `instructions_verbatim`, `reason`, `prescriber_contact_id`, `quantity_supplied`, `vet_visit_id` | ⓟ |
| `diet.feeding_plan` | `animal_id`, `brand`, `product`, `food_type` (`DRY`,`WET`,`RAW`,`MIXED`,`PELLET`,`FLAKE`,`HAY`,`LIVE`,`OTHER`), `portion_amount`, `portion_unit`, `times` (time[]), `from_on`, `to_on`, `objective` (e.g. "keep weight steady") | ⓟ |
| `diet.food_note` | `animal_id`, `food` text, `reaction` (`LIKES`,`DISLIKES`,`DIGESTIVE`,`ALLERGIC`,`AVOID`), `noted_on` | ⓟ |
| `care.routine` | `subject` animal or habitat, `kind` (`FEED`,`WALK`,`GROOM`,`BATH`,`NAILS`,`TEETH`,`EARS`,`MEDICATION`,`FLEA`,`WORM`,`VACCINATION`,`TANK_CLEAN`,`WATER_TEST`,`CAGE_CLEAN`,`BEDDING`,`FEEDER_REFILL`,`OTHER`), `rrule`, `times`, `medication_id` null, `assigned_to` null, `remind` (`NONE`,`TODAY`,`CALENDAR`), `active_from`, `active_to` | |
| `care.log` | `routine_id` null, `subject`, `kind`, `done_at`, `by`, `amount` null, `note` — "Fed", "Walked", "Medication given", "Bird feeder filled" **[R §21]** | |
| `life.moment` | `animal_id`, `kind` (`PHOTO`,`VIDEO`,`MILESTONE`,`BIRTHDAY`,`FUNNY`,`HOLIDAY`,`ACHIEVEMENT`,`STORY`,`FAVOURITE`), `on`, `precision`, `title`, `body`, `media_ids` | (v1.1) |
| `money.cost` | `animal_id` null (null = household pets in general), `habitat_id` null, `category` (`FOOD`,`VET`,`MEDICATION`,`INSURANCE`,`GROOMING`,`EQUIPMENT`,`TOYS`,`BOARDING`,`TRAINING`,`LICENCE`,`OTHER`) **[R §10]**, `amount`, `currency`, `incurred_on`, `vendor`, `vet_visit_id`, `claim_id`, `truehaven_ref` null | ⓟ (v1.1) |
| `money.insurance_policy` | `animal_id`, `insurer_contact_id`, `policy_number`, `starts_on`, `renews_on`, `premium`, `premium_period`, `excess`, `cover_summary`, `annual_limit` | ⓟ (v1: number + insurer only) |
| `money.insurance_claim` | `policy_id`, `vet_visit_id`, `claimed_on`, `amount_claimed`, `amount_paid`, `status` | ⓟ (v1.1) |

**Due dates are derived, not stored twice [P]:** "next vaccination due" = latest confirmed vaccination's
`next_due_on` (if the vet wrote one) else the routine's rrule. "Overdue" is always computed.

**Medication supply [P]:** remaining = `quantity_supplied` − doses logged in `care.log` since dispensing. When it
drops below 7 days of doses, "Prescription renewal approaching" appears in Coming Up **[R §8]**.

**Current medication** is derived from `medication_event`, exactly like Vitalis `currentRegimen` **[I Vitalis S2.3]**.

### 3.6 Timeline [R §3, §12]

- **Not a table.** A database view `timeline.entry_v` unions every event table above (plus `life.moment`,
  `care.log` milestones only, and `wild.sighting` for habitats) into `(animal_id, on, precision, kind, title,
  summary, source_class, status, ref_table, ref_id)`.
- So there is one place every event lands, and it can never drift from the record.
- Filters: All · Health · Care · Food · Weight · Memories. Clinical and family entries are mixed by default
  **[R §12]**; each carries its source badge (sec 4).
- Routine care logs (every walk) do **not** go on the timeline — only firsts and milestones would be noise otherwise.

### 3.7 People, contacts, documents, media

| Table | Key fields |
|---|---|
| `core.member` | `member_name` (Synapse identity), `display_name`, `is_child` |
| `core.access_grant` | `member_name`, granted/revoked by/at — household access, deny by default **[I Truehaven 008 via Epicure sec 3]** |
| `core.animal_role` | `animal_id`, `member_name`, `role` (`OWNER`,`PRIMARY_CARER`,`FAMILY`,`VIEWER`), `from_on`, `to_on` |
| `core.contact` | `kind` (`VET_PRACTICE`,`VET_PERSON`,`EMERGENCY_VET`,`BREEDER`,`RESCUE`,`INSURER`,`GROOMER`,`KENNEL`,`PERSON`,`WILDLIFE_RESCUE`), `name`, `phone`, `email`, `address` |
| `core.vault_folder_binding` | `vault_folder_name` UNIQUE, `member_name`, `go_ahead_by/at` (inert until the person says yes) **[I Vitalis S5.0 #2]** |
| `ingest.source_document` | `file_hash` (UNIQUE per workspace), `vault_path`, `file_name`, `media_type`, `page_count`, `doc_kind`, `document_date`, `uploaded_by`, `discovered_at` |
| `media.item` | `sha256`, `path` (`_petopia-media/<sha>.jpg`), `width`, `height`, `taken_on` (kept from EXIF before stripping), `added_by` |

### 3.8 Wildlife (v2; tables created in v2)

| Table | Key fields |
|---|---|
| `ref.species` | shared by pets and wildlife: `common_name`, `scientific_name`, `group` (`DOG`,`CAT`,`BIRD`,`MAMMAL`,`AMPHIBIAN`,`REPTILE`,`FISH`,`INSECT`,`OTHER`), `domain` (`PET`,`WILD`,`BOTH`), `sensitive` bool, `facts` jsonb with `source_url` + `checked_on` |
| `wild.sighting` | `species_id` null, `id_status` (`PERSON_CONFIRMED`,`AI_PROBABLE`,`UNIDENTIFIED`), `ai_candidates` jsonb (name + confidence, top 3), `observed_at`, `habitat_id`, `count`, `behaviour`, `note`, `media_ids`, `lat`/`lng` null, `location_precision` (`HABITAT_ONLY` default, `ROUGH_1KM`, `EXACT`), `visitor_id` null, `by` |
| `wild.named_visitor` | `name` ("Freddie"), `species_id`, `favourite_habitat_id`, `notes`; "first seen" and "seen N times" are counted from sightings |

Linking a sighting to a named visitor is **always a person's choice**, never automatic, and the visitor page says
plainly that one robin can look like another **[R §15]**.

---

## 4. Provenance and trust [R §4, §30]

### 4.1 The six kinds of information, kept apart

The brief names six things that must never blur together. Each gets its own badge in the UI and a distinct
stored value. "Read from a document" is a *state*, not a source: once a person confirms it, the badge says who
the information really came from (usually the vet), with a link back to the document.

| # | Brief's name [R §30] | Badge shown | Stored as [P] | Can it be authoritative? |
|---|---|---|---|---|
| 1 | Stored veterinary records | **Vet record** | `source_class = VET_RECORD`, `status = CONFIRMED` | Yes — confirmed by a person, usually with a document behind it |
| 2 | Information extracted from documents | **Read from document — check** | any `source_class`, `status = PROPOSED`, `channel = DOCUMENT`, `extraction_method` = `TEXT_LAYER`/`OCR`/`LLM_PROPOSAL` | **No** — never on charts, totals, due dates or the Vet Pack until confirmed |
| 3 | Owner observations | **Our note** | `source_class = OWNER_OBSERVATION`, `CONFIRMED` (by the person who entered it) | Yes, as an observation ("we saw her limp"), never as a diagnosis |
| 4 | General reference information | **Reference** + source and date | `ref.*` rows with `source_url`, `checked_on` | Context only; never written into an animal's record |
| 5 | AI suggestions | **AI suggestion** | not stored as a fact at all; shown, or saved as a `PROPOSED` row the person must confirm | **No** |
| 6 | Veterinary advice | **Vet advice** | `source_class = VET_ADVICE` (instructions: "60 g twice a day", "recheck in 3 months") | Yes — it can create a routine or follow-up, linked to its source |

### 4.2 The provenance block (on every ⓟ table) [P, copying I Vitalis S0.7]

| Column | Values |
|---|---|
| `status` | `PROPOSED`, `CONFIRMED`, `SUPERSEDED`, `DISPUTED` |
| `source_class` | `VET_RECORD`, `VET_ADVICE`, `OWNER_OBSERVATION`, `AI_SUGGESTION` |
| `channel` | `DOCUMENT`, `MANUAL`, `VOICE`, `CARE_LOG` |
| `source_document_id`, `source_page`, `source_quote` | the original and the exact words the value came from |
| `extraction_method` | `MANUAL`, `TEXT_LAYER`, `OCR`, `LLM_PROPOSAL` |
| `proposed_by` / `proposed_at` | a member, or `petopia-reader` for the AI |
| `confirmed_by` / `confirmed_at` | always a person |
| `supersedes_id` | the row this one corrects |

**Database CHECKs [P, as Vitalis]** — enforced in Postgres, not only in code:
- `CONFIRMED` needs `confirmed_by`.
- `channel = DOCUMENT` needs `source_document_id`.
- `extraction_method = LLM_PROPOSAL` can never be inserted as `CONFIRMED`.
- `source_class = AI_SUGGESTION` can never be `CONFIRMED` (a person confirming it turns it into `OWNER_OBSERVATION` with a note "from an AI suggestion").

### 4.3 Confirm / correct flow

1. Proposal appears in the Inbox with its badge, the original page beside it and the quote highlighted.
2. Person taps **Confirm** → row becomes `CONFIRMED`, `confirmed_by` = them.
3. Or **Correct** → a new confirmed row with the fixed value; the proposal is `SUPERSEDED`, the original stays.
4. Or **Not right** → `DISPUTED`; hidden from views, kept for the record.
5. Later edits of a confirmed fact always go through Correct — the old value stays visible in the fact's history.

Who may confirm what is in sec 7.

### 4.4 The original stays as evidence

- The vault file is never edited, never overwritten, never deleted by Petopia **[I Vitalis vault.ts]**.
- Every confirmed value from a document links to file + page + quote; tapping a value opens the page.
- Deleting a pet's record is not offered in v1; `REHOMED`/`DECEASED` keeps everything.

---

## 5. Document inbox and ingestion [R §4]

### 5.1 How files get in [P, copying I Vitalis S5 / S7]

| Way in | Lands in |
|---|---|
| Drop a file in the vault | `<Name>/Pets/inbox/` (the dropping person's own folder) |
| **Add** button in Petopia (phone camera, file, screenshot) | engine writes it to the same folder (Vitalis `capturephoto.ts` pattern) |
| Profile / moment photo | not the inbox: straight to `_petopia-media/` after re-encoding (sec 2) |

A person's folder is read only after their own one-time go-ahead **[I Vitalis S5.0 #2]**. The go-ahead text says
plainly that document text is sent to Claude (Anthropic) to be read **[I Vitalis S7 v3]** (Open question Q4).

### 5.2 The pipeline

```
Discover (SHA-256, idempotent)
  → Read text: text layer (PDF/DOCX) | glm-ocr on the Alienware (photos, scans)
  → Assess: claude -p, no tools, JSON schema, one document per call
  → Guard: every value's quote must be found on its page, every number must be in its quote
  → Propose: which animal, what kind of document, the values (all PROPOSED)
  → Review, two steps (person)
  → Confirm: real rows written in one transaction
  → File: move to <Name>/Pets/filed/<kind>/ only after the commit succeeds
```

**What the assessor proposes [R §4 items 1-10]:**

| # | Brief asks | Proposal |
|---|---|---|
| 1 | Identify the animal | Match by microchip (strongest), then name + species. Ambiguous or no match → asks; never guesses |
| 2 | Document type | `VET_LETTER`, `INVOICE`, `VACCINATION_CERT`, `INSURANCE_POLICY`, `INSURANCE_CLAIM`, `PRESCRIPTION`, `LAB_REPORT`, `ADOPTION`, `PEDIGREE`, `MICROCHIP`, `PHOTO`, `SCREENSHOT`, `OTHER` |
| 3 | Dates | each value carries its own date; a document with no date gets the file date marked *assumed*, which the reviewer must set |
| 4 | Vet/provider | matched to `core.contact`, or a new contact proposed |
| 5-8 | Conditions, medications, vaccinations, weights | rows in the sec 3.5 tables, `PROPOSED` |
| 9 | Costs | `money.cost` lines + total; lines must add up to the total (within 2 cent) or the invoice is flagged, never silently fixed **[I Epicure sec 6.9]** |
| 10 | Timeline entries | a `vet_visit` tying the above together |

**Review — two steps, in order [I Vitalis S7.1 #4]:**
1. *What is it?* "This looks like a vet invoice for **Banoffee** from 3 Oct 2026, with a vaccination and a weight.
   Process it?" — buttons: Yes · Different animal · Different type · Keep document only · Not a pet document.
2. *The values*, one by one, or "Accept all 4 that passed checks" after the list has been opened.

**Rules [P]:**
- The document is data, never instructions; anything that reads like an instruction inside it is ignored.
- A failed or unparseable model run leaves the item as "Couldn't read — enter by hand"; nothing is guessed.
- Same file twice → flagged *possible duplicate* for a person to dismiss.
- Model, tokens and cost of every run are kept in `ingest.extraction_run`; prompts and answers are never logged.
- Photos of animals dropped in the inbox are offered as "Add to Banoffee's photos?" — not read for facts.

### 5.3 Ingest tables [P, copying I Vitalis 007 / Epicure 5.8]

| Table | Key fields |
|---|---|
| `ingest.inbox_item` | `source_document_id`, `member_name`, `status` (`DISCOVERED`,`READ`,`ASSESSED`,`NEEDS_REVIEW`,`FILED_PENDING`,`FILED`,`IGNORED`,`ASSESS_FAILED`), `flags[]`, `animal_id` (once decided), `doc_kind`, `decided_by/at` |
| `ingest.extraction_run` | `inbox_item_id`, `method`, `model`, `cli_version`, `output` jsonb, `valid`, `errors`, `tokens`, `cost`, `at` |
| `ingest.proposal` | `inbox_item_id`, `target_table`, `payload` jsonb (ajv-checked), `quote`, `page`, `status` (`PROPOSED`,`ACCEPTED`,`CORRECTED`,`DISMISSED`), `created_row_id` |

---

## 6. Integrations — who owns what

**The rule [P]:** every fact has exactly one owner. Other apps either *read* it through the owner's API or hold a
*pointer* to it. Nobody copies a value and keeps it up to date by hand.

| Thing | Owner | Petopia holds | Others hold | When |
|---|---|---|---|---|
| Animals, health, care, routines, due dates | **Petopia** | the record | nothing | v1 |
| Calendar events (vet appointments) | **Synapse Planner** (`core.events`) **[I Synapse D25]** | `calendar_event_id` on the visit | the event, created by Petopia via `/webhook/events` | v1 |
| Daily care (feed, walk, meds) | **Petopia** | routines + care log | nothing — not sent to Planner (no notification noise **[R §22]**) | v1 |
| Document files | **Vault** (Obsidian household) **[I Synapse D10]** | path + hash | the file | v1 |
| Pet costs from vet invoices | **Petopia** (`money.cost`) | the cost, linked to its invoice | — | v1.1 |
| Bank transactions, budget | **Truehaven** | optional `truehaven_ref` pointer on a cost | the transaction | v3+ |
| Pet-spend summary for budgeting | **Petopia**, read-only endpoint with a service token for one household | the summary endpoint | Truehaven reads it | v3+ (Epicure's `truehaven.ts` pattern **[I]**) |
| What each animal eats, how fast it runs out | **Petopia** (`diet.feeding_plan`) | the plan | — | v1 |
| Shopping lists, receipts, prices | **Epicure** | nothing | the list item | v3+: Petopia asks Epicure to add a need ("Royal Canin Shih Tzu 1.5 kg"); Epicure owns it from then |
| Pet food on a supermarket receipt | **Epicure** | not imported (would double-count) | the receipt | — |
| Research topics and findings | **Synapse Scout** (`core.research_topics`) | nothing | topics with `area = 'pets'` | when Scout is live; it is dark today **[I Synapse D17]** |
| Human health | **Vitalis** | nothing | — | never mixed |

**Calendar detail [P, copying I Vitalis calendar.ts]:**
- A vet visit with a date and time → one event via `POST /webhook/events` with `X-Serenity-Service`, title
  "Banoffee: vet — annual vaccination", on the Primary carer's calendar, Europe/Dublin time.
- Moving or cancelling the visit in Petopia updates or cancels the event. Edits made in Google do not flow back.
- Failure never blocks saving the visit; it shows "not on a calendar" with a retry.

**Double-counting guard [P]:** Petopia's cost totals and Truehaven's spending totals are different views. When a
cost is linked to a Truehaven transaction, Truehaven still counts the transaction; Petopia shows the link, not a
second amount.

---

## 7. Permissions [R §21]

### 7.1 Two layers

1. **Household access** — a member can open Petopia at all: Synapse `allowed_features` includes `petopia`, and a
   `core.access_grant` row exists. Deny by default.
2. **Role per animal** — `core.animal_role`. A member with household access but no role on an animal is treated
   as **Family member** for that animal (the household default) **[P]**, unless an Owner sets Viewer.

### 7.2 What each role can do [P]

| Action | Owner | Primary carer | Family member | Viewer |
|---|---|---|---|---|
| See profile, photos, timeline, today's care | ✓ | ✓ | ✓ | ✓ |
| Log care: fed, walked, medication given, feeder filled | ✓ | ✓ | ✓ | — |
| Add photos, memories, our-note observations, weights | ✓ | ✓ | ✓ | — |
| Drop documents in the inbox | ✓ | ✓ | ✓ | — |
| Confirm / correct vet records and AI proposals | ✓ | ✓ | — (can propose) | — |
| Add or change medication, routines, feeding plan | ✓ | ✓ | — | — |
| See costs and insurance details | ✓ | ✓ | totals only | — |
| See documents (originals) | ✓ | ✓ | ✓ | — |
| Generate a Vet Pack | ✓ | ✓ | ✓ | — |
| Change roles, mark rehomed/deceased | ✓ | — | — | — |

- Every animal has at least one Owner; the last Owner cannot remove themselves (Vitalis last-manager rule **[I S2.10]**).
- Children (`is_child`) get the same rights as their role — no special rule (Epicure Q17.4 precedent **[I]**).
- Enforced in the engine on every route **and** by RLS for the household layer.

### 7.3 Wildlife locations [R §14]

- **Default is habitat only:** a sighting stores "Back garden", not coordinates.
- Photos have GPS stripped before storage (sec 2), so a picture cannot leak a location either.
- Coordinates are kept only if the person turns on "save rough location", and are rounded to about 1 km.
- `ref.species.sensitive = true` (for example bats and badgers, protected in Ireland) → never any coordinates,
  never shown outside the household, never sent to any outside service, and the Ask assistant will not say where
  one was seen beyond the habitat name.
- No sighting is shared or exported to outside recording schemes in any release covered here.

---

## 8. Information architecture [R §28]

### 8.1 The brief's ten items, checked

The brief asks for this to be evaluated, not copied **[R §28]**.

| Brief item | Verdict [P] | Why |
|---|---|---|
| Home | **Keep** | The dashboard |
| Our Animals | **Keep** as *Animals* | The main object |
| Health | **Move inside each animal** | Health is always *someone's* health; a top-level Health page just asks "which animal?" again |
| Care | **Move inside each animal**; today's care is on Home | Same reason; the household-wide "what's due" is Home's Today list |
| Wildlife | **Keep** | The second big question **[R end]** |
| Discover | **Fold in** | Reached from where it matters: "About Shih Tzus" on Banoffee's page, "About robins" on a sighting; a Discover page joins Wildlife in v3 |
| Timeline | **Move inside each animal** | Each timeline is one animal's life |
| Documents | **Split**: the *Inbox* is top-level (it's a to-do); filed documents live inside each animal | The inbox is the only place that asks for effort |
| Costs | **Move inside each animal**; household total as a Home card (v1.1) | Rarely visited; a card is enough |
| Scout | **Fold into Ask** (v3+) | Scout is "keep asking this over time" — an option on a question, not a place |

### 8.2 Recommended navigation [P]

**Home · Animals · Wildlife · Inbox**, with **Ask** as a floating button on every screen and a small
**Household** link (people, roles, habitats, contacts) under the menu.

- Four tabs fit a phone's bottom bar; ten do not.
- It matches the house style: Epicure has 7, Vitalis has a handful **[I Epicure sec 7.2]**.
- Wildlife shows as a tab from v1 with a short "coming soon" card only if Ryan wants the promise visible;
  otherwise it appears in v2 **[P default: hidden until v2]**.

### 8.3 Inside an animal

Tabs: **Overview · Timeline · Health · Care & food · Files & money**

| Tab | Holds |
|---|---|
| Overview | photo, identity, alerts, next care item, weight sparkline, current food, current medication |
| Timeline | sec 3.6 |
| Health | vet visits, vaccinations, treatments, conditions, allergies, procedures, lab results, weight chart |
| Care & food | routines, care log, feeding plan and food history, food likes/reactions |
| Files & money | documents, insurance, costs (v1.1) |

---

## 9. Screens and visual language

### 9.1 Visual language [R §27]

- **Belongs to Synapse:** dark base and gold accents from `serenity/src/styles/synapse-tokens.css`
  (`--syn-bg-950 #04080D`, `--syn-gold-500 #E3BB63`, `--syn-text #F3E9D3`) **[I]**; light theme from the same tokens.
- **Its own identity [P]:** a deep moss green taken from the hero's wordmark as the Petopia accent, used for
  "healthy/on track"; gold stays for Synapse chrome. Warm amber for "due soon"; a calm red only for "overdue" and
  the urgent-symptom card.
- **Photography does the work:** real photos of Banoffee and Benji on the cards; the cinematic hero image on Home.
- **No cartoon paw prints [R §27]:** no paw icons, bones or cartoon mascots anywhere in the UI chrome. Icons from
  `lucide-react` (already in Synapse **[I serenity/package.json]**), line style. The single paw inside the wordmark's
  "o" in Ryan's own logo stays, because it is his art.
- Clean, premium, lots of space; a serif for animal names, sans for everything else (Epicure precedent **[I]**).
- Mobile-first: care is logged on a phone at the food bowl.

### 9.2 Use of the two images [R Q1, annotations]

| Image | Use [P] |
|---|---|
| `petopia-hero.png` (1672×941, wordmark + tagline baked in) | Petopia Home hero; the Synapse home-screen hero preview; the tap-to-enter splash. Same size as the other apps' `final/hero-*.jpg` **[I]** |
| `petopia-hero-portrait.png` (1055×1490, white wordmark, no tagline) | Synapse menu tile (`final/menu-petopia.png`, cropped to the 13:20 tile shape) and the phone-width Home hero |

Because both images already carry the name, the splash title overlay is switched off (`hideSplashTitle`, as
Rainbowglen **[I SynapseAppGrid.tsx]**).

### 9.3 Home dashboard [R §1, §26]

Order top to bottom; any section with nothing real to show is hidden.

| Section | Shows | Source | Release |
|---|---|---|---|
| Hero | the landscape image | — | v1 |
| **Our Pets** | large photo card per animal: photo, name, species, breed, age, current weight, status, next care item, alerts | animal + latest confirmed weight + next due | v1 |
| **Today** | "Benji — medication 08:00", "Banoffee — grooming", "Bird feeder — refill": each with a one-tap **Done** that writes `care.log` | routines due today minus logs | v1 |
| **Coming Up** | next 30 days: vet appointments, vaccinations, flea/worm, prescription renewals, insurance renewal | derived due dates | v1 (insurance v1.1) |
| **Inbox waiting** | "2 documents to check" | inbox | v1 |
| **Wildlife Today** | recent sightings with photos | sightings | v2 |
| **Insights** | max 3, each a computed fact with its numbers: "Banoffee's weight has stayed within 0.2 kg for six months" | rules over confirmed data only; no model text | v3 |

Banoffee's card, exactly as the brief draws it **[R §1]**:

```
[photo]  Banoffee
         Shih Tzu · about 8 years · 6.1 kg
         Healthy
         Next: Annual vaccination — 18 days
```

"Healthy" is the **status** an Owner/Primary carer sets (`HEALTHY`, `UNDER_TREATMENT`, `NEEDS_ATTENTION`), never
computed by AI **[P]**.

### 9.4 Other screens

| Screen | What's on it | Release |
|---|---|---|
| **Add animal** | 3 steps: name + species (+ breed); photo (camera or library); the rest optional. Default routines offered as tick-boxes from the species module | v1 |
| **Animal profile** | sec 8.3 tabs | v1 |
| **Weight** | entry with unit choice (kg/lb), plausibility question ("6.1 → 61 kg? did you mean 6.1?"), chart over 3 months / 1 year / all, change since last. Breed ranges only where a source is stored, labelled *Reference*, with "not a diagnosis" **[R §6]** | v1 |
| **Timeline** | sec 3.6; year headers like the brief's example **[R §12]** | v1 (memories v1.1) |
| **Inbox** | list of waiting items; review screen with original page on the left, proposals on the right (phone: stacked) | v1 |
| **Vet Pack** | pick animal → tick sections (identity, microchip, conditions, allergies, current medication, vaccinations, weight last 12 months, procedures, recent visits, key results, insurance, emergency contact) → preview → **Print / Save as PDF**. Confirmed facts only. No share link: Synapse is reachable only on the household network, so a vet could not open one **[I README]** | v1.1 |
| **Ask** | sec 10 | v1.2 |
| **Wildlife** | Recently Seen · Species We've Seen (count this year) · Named Visitors · **Identify** (photo → top 3 with confidence) | v2 |
| **Household** | members and roles per animal, habitats, contacts | v1 |

---

## 10. Assistant ("Ask") [R §19, §30]

### 10.1 How it works [P, copying I Epicure 6.11 / Synapse rule 1]

- The engine, not the model, fetches the record slice the question needs (weights, vaccinations, costs...).
- The model gets that slice as data and returns JSON that **points at record ids**; the engine renders every
  number and date from the database. A model can never put a number on screen that isn't in the record.
- Model: `claude -p` with no tools, same wrapper as the inbox reader.

### 10.2 Two boxes, never mixed [R §19]

```
┌ From Banoffee's records ───────────────────────────────┐
│ Last vaccination: 2 Oct 2025 (Vet record · invoice p1) │
│ Next due: 2 Oct 2026                                   │
└────────────────────────────────────────────────────────┘
┌ General guidance (AI — not veterinary advice) ─────────┐
│ ...                                                    │
└────────────────────────────────────────────────────────┘
```

- Questions the brief lists **[R §19]** answer from the first box only ("When was Benji's last vaccination?",
  "How much did we spend on vet bills last year?", "Summarise his medical history for a new vet" → opens Vet Pack).
- "What bird did we photograph yesterday?" answers from sightings (v2).
- If the record has no answer it says so: "No vaccination recorded for Benji."

### 10.3 Safety rules (rule-based, run before and after the model) [R §30]

**Urgent symptoms.** If a question mentions any red-flag sign, the answer starts with a red card and the model's
general text is withheld:
- breathing difficulty, collapse, seizure, pale or blue gums, heavy bleeding, swollen hard belly with retching,
  straining to pass urine with nothing coming, suspected poisoning (for example chocolate, grapes/raisins,
  xylitol, lilies for cats, rat poison, antifreeze), heatstroke, hit by a car.
- Card: "This could be an emergency. Ring your vet now" + the stored vet and emergency-vet numbers + "out of hours?
  ring your vet's out-of-hours line". No guess at a cause.
- Logged as a `safety_event` (Vitalis precedent **[I migration 021]**).

**Never:** a diagnosis, a medicine or dose change, "it's probably fine", or a breed average presented as a finding
**[R §6]**. Banned phrasing is checked by a display-time guard like Vitalis `aiguard.ts` **[I]**.

**Wildlife handling [R §30]:**
- Never suggest picking up or handling an injured or wild animal beyond "keep pets and children away, keep it
  quiet, contact a wildlife rescue or the NPWS for advice".
- Never handle bats (disease risk) or approach foxes and badgers.
- Leave nests, eggs and fledglings alone; a fledgling on the ground is usually being fed by its parents.
- Never give a sensitive species' location (sec 7.3).
- Contact numbers for rescues are stored contacts the household adds — the assistant does not invent phone numbers.

---

## 11. Plugging into the Synapse app menu

### 11.1 How the menu works today [I]

- Home-screen tiles are the `SYNAPSE_APPS` array in `Synapse/serenity/src/components/SynapseAppGrid.tsx`.
- The "final" art set picks `assets/synapse-brand/final/menu-<stem>.png` (tile) and `final/hero-<stem>.jpg`
  (hero + splash) through `FINAL_ART_STEM` and `applyArtSet()` in the same file.
- `Synapse/serenity/src/App.tsx` gives each tile its `onClick` in the `homeApps` switch (lines ~395-440); each
  embedded app is a full-screen takeover (`epicureOpen`, `vitalisOpen`...) rendering a small screen component.
- That component is an iframe of `/<app>/`, same origin, so the app reads the Synapse device session itself;
  no token in the URL (`components/EpicureScreen.tsx`, `VitalisScreen.tsx`).
- Caddy (`Synapse/serenity-web/Caddyfile`) proxies `/<app>/*` to the engine's port; the engine does the auth.
- Per-member visibility: `core.feature_vocabulary()` (latest in `migrations/058_d39_hardening.sql`),
  `serenity-verify-device-workflow.json` (compat `hidden_apps` list), `member-admin-workflow.json` (`validApps`),
  `components/MembersAdmin.tsx` (`FEATURE_LABEL`).

### 11.2 Exact changes for Petopia [P]

| # | File | Change |
|---|---|---|
| 1 | `serenity/src/assets/synapse-brand/final/menu-petopia.png` | from `petopia-hero-portrait.png`, cropped to the tile shape, same pixel size as `menu-epicure.png` (273×461) |
| 2 | `serenity/src/assets/synapse-brand/final/hero-petopia.jpg` | `petopia-hero.png` as JPEG, 1672×941 (same as `hero-epicure.jpg`) |
| 3 | `serenity/src/assets/synapse-brand/cards/bg-petopia-hero.jpg` | same landscape image, for the "classic" art set |
| 4 | `SynapseAppGrid.tsx` | import `bg-petopia-hero.jpg`; add `{ id: 'petopia', title: 'Petopia', background: petopiaBg, hideSplashTitle: true }` to `SYNAPSE_APPS` after Games (Ryan's 2026-10-06 order: "Planner, Epicure, Truehaven, Lounge, Vitalis, Games, then the rest" **[I]**); add `petopia: 'petopia'` to `FINAL_ART_STEM` |
| 5 | `SynapseAppGrid.tsx` `applyArtSet()` | today it forces `hideSplashTitle: false` for every final card; add an optional `artHasTitle` flag on the card and pass `hideSplashTitle: !!card.artHasTitle`, set true for Petopia only (its art already shows the name) |
| 6 | `serenity/src/components/PetopiaScreen.tsx` | copy of `EpicureScreen.tsx` with title "Petopia" and `src="/petopia/"` |
| 7 | `serenity/src/App.tsx` | import `PetopiaScreen`; `const [petopiaOpen, setPetopiaOpen] = useState(false)`; early-return block like `epicureOpen`; `case 'petopia': return { ...card, onClick: () => setPetopiaOpen(true) }` |
| 8 | `serenity-web/Caddyfile` | after the Epicure block: `redir /petopia /petopia/ 308` and `handle_path /petopia/* { reverse_proxy host.docker.internal:4400 }`, with the same "Caddy is transport only" comment |
| 9 | `serenity/src/components/MembersAdmin.tsx` | `FEATURE_LABEL.petopia = 'Petopia'` |
| 10 | `Synapse/migrations/059_petopia_feature.sql` | redefine `core.feature_vocabulary()` with `('petopia', true)` added (STABLE, as 058) |
| 11 | n8n `member-admin-workflow.json`, `serenity-verify-device-workflow.json` | add `'petopia'` to `validApps` and to the compat `hidden_apps` list |

- Items 1-9 are a plain frontend + Caddy change: the estate rebuilds and deploys those without a separate
  approval (CONVENTIONS sec 9) **[I]**.
- Items 10-11 are a database migration and n8n changes: **Ryan's call** (CONVENTIONS sec 9, sec 26) — Open question Q5.
- Until 10-11 land, the tile shows for every approved member and the engine admits any approved member
  (Epicure's position today **[I MembersAdmin.tsx line 297]**).
- The Synapse-side decision is a cross-reference only: "Petopia-owned: see Petopia D1; code lives in
  `serenity/...`" (Axiom D34, decision ownership across the seam **[I Truehaven/CLAUDE.md]**).

---

## 12. Build plan

### 12.1 Slices (v1)

Each slice is shippable and ends with a check someone other than the builder can run. Real pet data is entered
through the app by Ryan; tests and seeds use a fictional animal ("Biscuit", a cat) only **[P, as I Vitalis S0.5]**.

| Slice | Delivers | Acceptance check |
|---|---|---|
| **S1 Foundation** | `petopia` DB + `petopia_app` role; migrations `core`, `ref`, `animal`, `media`, provenance block + CHECKs; `auth.ts`, `access.ts` (grants + animal roles), `animals.ts`, species modules `dog`/`cat` with ajv, habitats seeded, `photos.ts`; JSON API; tests | On the iMac: lint, build, tests green; RLS test: workspace A sees nothing of B, unset setting sees nothing; `POST /api/animals` for Biscuit with `born 2018, precision YEAR` returns age "about 8"; LLM_PROPOSAL-as-CONFIRMED is refused by the DB |
| **S2 Shell, menu, deploy** | React shell (Home with hero + Our Pets, Add animal, animal Overview, photo upload); LaunchAgent on :4400; Caddy route; Synapse tile + splash (sec 11.2 items 1-9) | Ryan, on his phone: Synapse home → Petopia tile → splash without a doubled title → Home → adds **Banoffee** with a photo → her card shows photo, "Shih Tzu · about 8 years". No token → 401 at `/petopia/api/me` |
| **S3 Feeding + weight** | `diet.feeding_plan` with history; `health.measurement` with registry (kg/lb), plausibility question; weight chart; Overview shows current food + weight | Enter 6.1 kg → card shows "6.1 kg"; entering 61 asks "did you mean 6.1?"; change food → old food in history with dates |
| **S4 Vet records (manual)** | vet visits, vaccinations, treatments, medication + events (derived current list), conditions, allergies, procedures, lab results; contacts; Timeline view | Add last year's vaccination with next-due date → appears on Timeline with **Our note**/**Vet record** badge; stopping a medicine removes it from "current" |
| **S5 Inbox + AI reading** | vault binding + go-ahead; `<Name>/Pets/inbox/` sweep; text layer / glm-ocr; `claude -p` assessor with schema + quote guard; two-step review; filing; Add-document button | A real vet invoice dropped for Banoffee → "vet invoice for Banoffee, 3 values" → confirm → visit, vaccination and weight on the Timeline linked to page 1; file moved to `Pets/filed/invoice/`; a test file with a fake number not in its quote is dropped and counted |
| **S6 Reminders + care log** | routines (from species defaults, medication, vet advice), `care.log`, Today with one-tap Done, Coming Up (30 days), medication supply warning, calendar events for vet visits via `/webhook/events` | Today shows "Banoffee — grooming"; tapping Done on one phone clears it on another after refresh; a vet appointment appears on the Primary carer's Synapse calendar and moves when the visit moves |
| **S7 Household + roles UI, v1 review** | Household screen (members, roles per animal, habitats, contacts); role checks in every screen; independent review (not the builder); Ryan's click-through | Viewer cannot log care; Family member's vet-record edit becomes a proposal; last Owner cannot leave; review findings fixed or recorded |

**v1 is done** when every A-line for S1-S7 in sec 14 is ticked and Ryan has used it for Banoffee and Benji.

### 12.2 Later slices (names only; each gets its own slice spec before building)

v1.1 S8 Vet Pack · S9 Memories + photo timeline · S10 Costs + insurance + claims — v1.2 S11 Ask — v2 S12
Wildlife identify + sightings · S13 Named visitors · v2.1 S14 more species modules + aquarium water tests —
v3 S15 Discover + Garden advice · S16 Insights · S17 Story album — v3+ S18 Truehaven read view · S19 Epicure needs ·
S20 Scout topics.

### 12.3 Deploy path, as this estate does it [I CONVENTIONS sec 9, Vitalis S2.10]

| Step | How | Gate |
|---|---|---|
| Commit | the session commits its own work | none |
| Push | queue `cd ~/dev/Petopia && git push` on the **Axiom runner** (the device bridge cannot reach GitHub) | none — automatic |
| DB + role | `engine/scripts/bootstrap-db.sh` through the runner (creates role, DB, writes `engine/.env`, never committed) | database work: Ryan's go-ahead ("build and deploy" in QUESTIONS A1 is that go-ahead for Petopia's own new DB, per sec 26 — the session still shows the batch first) |
| Migrate | `engine/scripts/migrate.sh` through the runner | same |
| Build + test | `cd ~/dev/Petopia/engine && npm ci && npm run build && npm test`; same in `web/` | none |
| Engine live | `engine/deploy/install-launchagent.sh` (label `com.petopia.engine`, :4400, log `/tmp/petopia-engine.log`, refuses `PETOPIA_AUTH=off`) | covered by the deploy go-ahead |
| Caddy | edit `Synapse/serenity-web/Caddyfile`, back up the old file to `/tmp/Caddyfile.pre-petopia.bak`, `caddy validate`, reload — as Vitalis S2.10 did | covered by the deploy go-ahead |
| Synapse UI | `cd ~/dev/Synapse/serenity && npm run build` (Caddy serves `dist/` live) | none — automatic for frontend |
| Synapse DB + n8n | migration 059 + the two workflow edits via `runner/n8n-deploy.sh --apply` | **Ryan's explicit call** (Q5) |
| Check live | `/petopia/health` direct and via Caddy; no token → 401; bogus token → 401 "device not approved"; `/vitalis/` and `/epicure/` still 200 | — |
| Verify | Ryan on a real device; never the building session (DESIGN.md `[Verified]` rule) | Ryan |

Stage moves happen only through Ryan's words and `kit advance` (CONVENTIONS sec 33); HANDOFF.md and the
D-number's stage are updated in the same session as each move.

---

## 13. Open questions for Ryan (only ones that block)

| # | Question | Blocks | Recommended default if no answer |
|---|---|---|---|
| Q1 | **Benji:** what species and breed is he, and roughly how old? (The hero shows two Shih Tzus, so I've guessed a second Shih Tzu — not confirmed.) | S2 acceptance (adding Benji) | Add him as a dog, breed "unknown", age unknown; Ryan fills it in on screen |
| Q2 | **Who's who for the pets:** who is Owner and who is Primary carer for Banoffee and for Benji, and which household members should see Petopia? | S6 calendar (whose calendar gets vet appointments), S7 | Ryan is Owner of both; no Primary carer set (appointments go to the Owner's calendar); every household member with Petopia is a Family member |
| Q3 | **Where should pet documents be dropped?** Each person's own `<Name>/Pets/inbox/` (like Health and food), or one shared household folder? | S5 | Each person's own `<Name>/Pets/inbox/`, same as Vitalis and Epicure |
| Q4 | **AI reading:** OK for Petopia to send the *text* of pet documents to Claude to read them (photos/scans are OCR'd at home first, images never sent), with one go-ahead per person's folder — same as you agreed for Vitalis? | S5 | Yes, same as Vitalis S7 v3; if no, the local Ollama model reads them instead (weaker) |
| Q5 | **Synapse changes outside Petopia:** OK to add `petopia` to the feature list (Synapse migration 059) and two small n8n edits so you can switch Petopia on/off per person in Members admin? | per-person access; not the tile itself | Do it during S2 on your go-ahead; until then the tile shows for every approved member |
| Q6 | **File name:** QUESTIONS Q3 left this file's name open. Keep `SPEC.md` here and copy it to `docs/specs/D1-petopia-core.md` when it's lifted to a D-number? | the lift | Yes |

Not asked because they don't block v1 (defaults stand unless Ryan says otherwise): Wildlife tab hidden until v2;
Petopia tile placed after Games; Vet Pack as printable PDF only; no phone push notifications (Synapse D42, push
notifications, is only briefed **[I Synapse DESIGN.md]**) — phones get reminders only through the calendar's Google
mirror for people who connected Google **[I Vitalis calendar.ts]**.

---

## 14. Acceptance checklist (CONVENTIONS sec 10 — ticked per slice, in the same pass that ships it)

| # | Item | Slice | Status |
|---|---|---|---|
| A1 | `petopia` DB + `petopia_app` role; CONNECT revoked from PUBLIC | S1 | ☐ |
| A2 | Migrations apply via `migrate.sh`; `schema.sql` generated | S1 | ☐ |
| A3 | FORCE RLS + fail-closed policy on every content table | S1 | ☐ |
| A4 | Provenance block + the four CHECKs (sec 4.2) in the DB | S1 | ☐ |
| A5 | `auth.ts` (device token, fails closed) + `access.ts` (grants + animal roles, last-Owner rule) | S1 | ☐ |
| A6 | `animal` table, species modules `dog`/`cat`, `ext` validated by ajv | S1 | ☐ |
| A7 | Habitats table, Home + Garden seeded | S1 | ☐ |
| A8 | Photo pipeline: re-encode, strip metadata incl. GPS, SHA-256 name | S1 | ☐ |
| A9 | Tests green on the iMac (pure + DB-gated); fictional fixtures only | S1 | ☐ |
| A10 | Web shell: Home (hero, Our Pets), Add animal, Overview | S2 | ☐ |
| A11 | LaunchAgent `com.petopia.engine` on :4400 | S2 | ☐ |
| A12 | Caddy `/petopia/` route; no token → 401 | S2 | ☐ |
| A13 | Synapse tile, hero, splash (sec 11.2 items 1-9); no doubled title | S2 | ☐ |
| A14 | Feature vocabulary + n8n lists (sec 11.2 items 10-11) | S2 | ☐ (Q5) |
| A15 | Feeding plan with history | S3 | ☐ |
| A16 | Weight: units, plausibility question, chart, change since last | S3 | ☐ |
| A17 | Vet visits, vaccinations, treatments, conditions, allergies, procedures, lab results | S4 | ☐ |
| A18 | Medication events + derived current medication | S4 | ☐ |
| A19 | Timeline view with source badges | S4 | ☐ |
| A20 | Inbox: binding + go-ahead, sweep, text/OCR, assessor, quote guard | S5 | ☐ |
| A21 | Two-step review, confirm/correct/dispute, filing after commit | S5 | ☐ |
| A22 | Routines, care log, one-tap Done | S6 | ☐ |
| A23 | Today + Coming Up (derived; empty sections hidden) | S6 | ☐ |
| A24 | Medication supply warning | S6 | ☐ |
| A25 | Vet appointments → Synapse calendar via `/webhook/events` | S6 | ☐ |
| A26 | Household screen: members, roles, habitats, contacts | S7 | ☐ |
| A27 | Role rules (sec 7.2) enforced on every route | S7 | ☐ |
| A28 | Independent review (not the builder), findings fixed or recorded | S7 | ☐ |
| A29 | Ryan's click-through with Banoffee and Benji (Verified) | S7 | ☐ |

---

## Appendix A — Banoffee, worked through v1

| Step | What happens | Stored as |
|---|---|---|
| Add | Ryan taps Add → "Banoffee", Dog, Shih Tzu, born "2018" (year only) | `animal`, `born_precision = YEAR`; Ryan = Owner |
| Photo | Takes a photo on his phone | `media.item`, GPS stripped; profile photo |
| Profile | Adds microchip, neutered, vet practice | `animal` fields; vet in `core.contact` |
| Feeding | "Dry food, 60 g, 08:00 and 18:00" | `diet.feeding_plan` (Our note) |
| Weight | 6.1 kg | `health.measurement`, CONFIRMED, Our note |
| Vet record | Drops last October's vet invoice in `Ryan/Pets/inbox/` | inbox → "vet invoice for Banoffee" → confirms vaccination (next due in 18 days), weight, cost line → Vet record badges, linked to page 1 |
| Reminder | Annual vaccination routine from the vet's next-due date | Coming Up: "Annual vaccination — 18 days"; when booked, the appointment goes to the calendar |
| Home | Her card: photo · Shih Tzu · about 8 years · 6.1 kg · Healthy · Next: Annual vaccination — 18 days | exactly the brief's example **[R §1]** |

Values above other than name, breed, age and 6.1 kg are illustrations, not facts about Banoffee.

## Appendix B — What I could not confirm (so nothing here is invented)

| Gap | What the spec does |
|---|---|
| Benji's species, breed, age | Q1 |
| Who in the household cares for which pet | Q2 |
| Whether Epicure has an API for another app to add a shopping need | Not checked; Epicure link is v3+ and gets its own slice spec |
| `POST /webhook/items` (Planner to-dos) currently has an auth gap for header-less callers **[I Synapse HANDOFF 2026-10-07, D39 deferred H1]** | Petopia does not write Planner to-dos; it uses calendar events only (the path Vitalis already uses) |
| Exact Caddy reload command | Follow Vitalis S2.10's record; not restated here |
| Port 4400 free on the iMac | Checked against the Caddyfile only; re-check with `lsof` at install |
| Wildlife photo identification model | Decided in the v2 slice spec (a vision model is needed; images would leave the house only with Ryan's say-so) |
| Brief §16 "season and region" data, §17 reference content sources | Decided in the v3 slice spec; every reference fact must carry its source and date |
