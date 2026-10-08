# D2 About pages: cold read (2026-10-08)

- **Input:** `docs/specs/D2-about-pages.md` (draft 1, 486 lines), read on its own. No other file, code, spec, brief or git history was opened.
- **Method:** skill `spec-cold-reader`. Questions only. This is not an approval, rejection or sign-off.
- **Count:** 51 questions. 22 NOT STATED, 18 AMBIGUOUS, 10 CONTRADICTION, 1 UNBUILDABLE.

---

## (a) What I believe would be built

- **Three new tables in migration `017_about.sql`:**
  - `ref.species_about`: shared, versioned, researched pages per species. The engine role can only read it. A separate loader writes it from `content/about/*.json`.
  - `ref.species_alias`: other names for a species, seeded in 017.
  - `animal.kind_about` and `animal.kind_about_run`: per-household AI drafts for a typed kind, and a log of each Claude call. Both use household RLS.
- **Alias lookup in `createAnimal`:** typing "Budgie" saves a Budgerigar, not "Other animal". A one-off backfill in 017 fixes animals that were already saved that way.
- **Researched pages:** fixed sections (summary, characteristics, habits, diet, housing, lifespan, breeding, health, care_notes) with sources for each section. They are written by separate content sessions in two waves (27 kinds, then about 35) and loaded by `load-about.mjs`.
- **Draft flow for a kind with no page:**
  1. The person gives a per-person consent.
  2. Call 1 suggests up to 4 candidates and the person picks one, or picks "in general".
  3. Call 2 writes a draft. It never has breeding or health sections.
  4. A rule-based guard checks the draft. It is saved as READY or set to FAILED.
  - The draft is shown with an amber "AI draft" badge.
  - The guard runs again every time the page is displayed.
  - Each household is capped at 10 drafts per rolling 24 h.
- **Web screens:** an About card on the animal Overview, an About page, a consent sheet, the candidate buttons, Writing and Failed states, and a "What is a …?" link in the picker.
- **Readings I had to choose between:**
  - *What "withdraw" means.*
    - Reading A: `POST kinds/:id/withdraw` withdraws the draft.
    - Reading B: it withdraws the person's consent.
    - The state machine (WITHDRAWN only on consent loss mid-call) supports **B**, so the endpoint looks misnamed.
  - *What "no candidates" means.*
    - Reading A: no candidates means "describe in general" (sec 4.4).
    - Reading B: no candidates means "Couldn't find an animal" (sec 5 and 11).
    - B.1's `is_animal` flag suggests both: false gives the error, and true with an empty list gives "general". The text never says so.
  - *Whether promotion happens.*
    - As written, a drafted kind cannot become a species inside D2 (Q25), so PROMOTED is effectively dead in D2.

---

## (b) Questions a builder would still have to ask

| # | Sec | Type | Question | Why a builder is blocked |
|---|---|---|---|---|
| 1 | 3.2, 3.4 | CONTRADICTION | Seeded aliases are written with hyphens ("guinea-pig", "wood-pigeon"). But lookup turns hyphens into spaces, and the CHECK only enforces `lower(btrim())`. Are stored aliases fully normalised (hyphens, trailing "s") on insert, and should the CHECK enforce that? | As written, "guinea-pig" never matches, so the A1 acceptance fails. |
| 2 | 3.2 | NOT STATED | "The full list is the builder's job": who approves the alias seed? How are aliases added after 017? A new migration conflicts with sec 9's "content updates are data loads, not migrations". | The builder invents content, and later aliases have no path. |
| 3 | 3.4, 4.1 | AMBIGUOUS | "Exact name" match against `ref.species`: is it case-sensitive? Is it normalised the same way as aliases? Which column is used (`common_name`, per B.3)? | "Budgie" and "budgie" can behave differently. |
| 4 | 3.2 | NOT STATED | The strip-one-trailing-"s" rule on names like Bass, Octopus or Asp: does it always apply? What happens when an alias collides with another species' common name? | This decides `kind_key` uniqueness and causes false matches. |
| 5 | 3.3, 4.1, 4.2 | CONTRADICTION | `UNIQUE(workspace_id, kind_key)` is absolute, but 4.2 says only one *active* row. Lookup skips WITHDRAWN rows and offers Write, and Write would then hit the UNIQUE. Should Write reuse or reset the WITHDRAWN row, delete it, or should the index be partial? | Write after a withdrawal errors. |
| 6 | 4.2 | NOT STATED | Call 1 failure (unreachable, timeout, unparseable) leaves CONFIRMING with no transition. FAILED → Try again goes to WRITING, which needs `chosen`. | Rows get stuck in CONFIRMING, and the retry path is undefined. |
| 7 | 4.4, 4.7 | NOT STATED | Call-1 candidates are not stored (no column). When the person returns later, or presses "Wrong animal", is call 1 re-run? Does that count against the cap? | The Which-animal screen cannot be rebuilt. |
| 8 | 4.7, 5 | NOT STATED | `POST kinds/:id/choose { chosen }` accepts free text from the client. Sec 5 says `chosen` is "text from call 1". Is it checked against the call-1 candidates? | Without that check, any 80 characters of client text reach Claude, so the sec 5 guarantee is not enforced. |
| 9 | B.2, 5 | AMBIGUOUS | The B.2 prompt puts `{chosen}` *outside* the `<<<NAME … NAME>>>` delimiters, and only the typed kind inside. Is `chosen` also treated as delimited data? | The injection boundary is unclear. |
| 10 | 4.4, B.1 | CONTRADICTION | 4.4 specifies a `not_sure` boolean. B.1 has `is_animal` and no `not_sure`. Which is right? | `candidates.json` cannot match both. |
| 11 | 4.4, 5, 11 | CONTRADICTION | With no candidates, 4.4 says offer "describe in general", while 5 and 11 say show "Couldn't find an animal". What happens for `is_animal:false` with candidates? What status does the row end in (CONFIRMING forever, deleted)? Does it count against the cap? | The UI branch and the row lifecycle are undefined. |
| 12 | 6, 4.4 | NOT STATED | Do the sec 6 guards run on call-1 output (`name`, `one_line`), which is shown to the person? | Unguarded model text reaches the screen. |
| 13 | 4.2, 6.4 | CONTRADICTION | 4.2 allows Try again with no limit. 6.4 says FAILED stays after two guard rejections in a row. No column counts consecutive rejections. Do timeouts count? Can a terminal FAILED ever leave (Regenerate, Wrong animal, next day)? | A counter and a terminal-state rule are missing. |
| 14 | 4.2, 4.5 | NOT STATED | On Regenerate from READY, are the old `sections` kept and shown while WRITING? Are they kept if the new run fails or is rejected? Sec 3.3 says `sections` is "NULL until READY". | Regenerate may destroy a good draft. |
| 15 | 4.2, 10 | NOT STATED | How is a row stuck in WRITING recovered, for example after an engine restart that drops the background job or an in-memory queue? What does "Taking longer than usual — try again" call? There is no WRITING→WRITING transition. | Rows get stuck permanently. |
| 16 | 4.2, 4.3 | AMBIGUOUS | For "consent withdrawn while a call is in flight → WITHDRAWN", whose consent counts: the requester, the person who pressed choose, or any member? Consent is per person, but the row is per household. | The check cannot be coded. |
| 17 | 4.2, 4.3 | NOT STATED | Person A starts and person B chooses or regenerates: does B need their own go-ahead? The second presser of Write "gets the first's row". With or without consent? What does B see while call 1 is still in flight? | The target of the consent check is undefined. |
| 18 | 4.2, 4.7 | AMBIGUOUS | `POST kinds/:id/withdraw`: does it withdraw the draft or the consent? What does it do to a READY row, given that the state machine only reaches WITHDRAWN mid-call? | The endpoint's meaning is undefined. |
| 19 | 4.3, 7 | NOT STATED | What happens to existing READY drafts when the requester later withdraws consent (kept, hidden, deleted)? Can a household delete a draft at all? | The data lifecycle is undefined. |
| 20 | 4.7, 4.3 | CONTRADICTION | `GET about/kind` returns "the household's consent state", but consent is per person. | It returns the wrong value. |
| 21 | 4.6, 10 | AMBIGUOUS | For "10 new drafts per rolling 24 h", what is counted: rows created, call-2 runs, all runs including call 1, or Try again and Regenerate too? Sec 10 says "+1 per Try again/Regenerate" in calls. Is it per household only? Which table is counted? | The cap test cannot be written. |
| 22 | 4.6, 4.7 | NOT STATED | Call 1 runs synchronously inside `POST about/kinds` with a 300 s timeout, behind a one-at-a-time queue. What is the HTTP timeout? What does the client see while queued? | Requests can hang for minutes. |
| 23 | 4.6 | AMBIGUOUS | "One call at a time per engine process": how many engine processes are there? Is the queue persistent? Does the shared `claudeJson` queue also serialise the inbox reader, which "does not change"? | The concurrency model conflicts with "reader behaviour does not change". |
| 24 | 3.4, 9 | CONTRADICTION | 3.4 says an "Other animal" is corrected by the 017 backfill "and nothing else". 9 says promotion switches the animal's species when the animal is opened. | It is unclear which rule wins. |
| 25 | 4.2, 9, 11 | UNBUILDABLE | Promotion needs a drafted kind to match a species or alias, but a kind gets a draft only because it matches neither. D2 has no path to add a species (the loader refuses unknown species) or an alias after 017. The "Chilean rose tarantula is now a species" example cannot happen. Should promotion match on `kind_key` ("tarantula") or on `chosen`? | PROMOTED is unreachable. |
| 26 | 9, 4.2 | AMBIGUOUS | Promotion fires "the next time an animal … is opened". That makes a read (possibly by a Viewer) write a species switch, a timeline entry and a status change. Which endpoint and role does this? Does it promote all animals with that kind or only the opened one? Where is the "one-time" notice state stored? | Side effects happen on read, and the other animals lose their draft. |
| 27 | 4.1, 4.2 | CONTRADICTION | Lookup step 3 shows any status except WITHDRAWN, which includes PROMOTED, but PROMOTED means "page no longer shown". | The display rule conflicts. |
| 28 | 4.1, 8 | NOT STATED | What does the About card show for each status (CONFIRMING, WRITING, FAILED, terminal FAILED, PROMOTED)? | The screens are listed but not mapped to statuses. |
| 29 | 11 | NOT STATED | When the chosen candidate equals a known species or alias: how is the match made (exact or normalised)? Where is the "confirmed by the person" screen or endpoint? What status does the row end in? | The flow is missing from the state machine and the API. |
| 30 | 3.3, 4.1, 11 | NOT STATED | How does an animal find its kind row? There is no FK. Is it by normalising `ext.species_name`, which is only named in sec 11? What is `ext`? What happens if the typed kind is edited? | The card cannot locate its draft. |
| 31 | 2, 3.1, 8, B.3 | CONTRADICTION | Sec 2 says a page carries `kind`, `scientific_name`, `language` and `written_at`. `ref.species_about` has none of them (only `checked_on`), and B.3 has no `scientific_name`. Are they stored inside `sections` or dropped? Which date does "Researched by Claude on *date*" use? | Columns and schema do not match. |
| 32 | 3.1, B.3 | AMBIGUOUS | The column `sections` is "validated against page.json", but page.json describes the whole file (species, language, sections). Is it one schema or two? | The validation points are unclear. |
| 33 | 9, 3.1 | NOT STATED | "New version only when the content hash changed": there is no hash column. What is hashed (bytes, canonical JSON, including `checked_on` and `reviewed_by`)? Does a new version retire the old one? What happens if a file is deleted? Who sets `retired_at`? | The idempotency acceptance cannot be tested. |
| 34 | 3.1, 9 | NOT STATED | How is `reviewed_by` set ("Ryan may mark a page read"): a file field, a loader flag, or SQL? Does a new version keep it or clear it? | There is no write path. |
| 35 | 2, 9 | NOT STATED | Which column on `ref.species` marks pet versus wildlife? That decides whether `health` is optional and whether the heading is "habitat". | The validation rule depends on an unknown flag. |
| 36 | 2, B.3 | AMBIGUOUS | Sec 2 asks for "two independent publishers", B.3 for "distinct `publisher` strings". Is string inequality enough? | "Independent" is not testable. |
| 37 | 8 | AMBIGUOUS | Badge "checked 8 Oct 2026 · 5 sources": is the date the page `checked_on` or the oldest per-source `checked_on`? Is the count all entries or distinct URLs? Where does the plural in "About Rabbits" come from? | Derived display values are undefined. |
| 38 | 6.2 | AMBIGUOUS | The banned list is not enumerated: "diagnosis or reassurance", "instruction to treat at home", "near a verb", and external Vitalis lists. Literal "is likely", "you have" and "your \<animal\> has" would reject normal text ("is likely to live 8 years"; "if your rabbit has stopped eating, ring the vet"). What are the exact regexes? | A3's "every banned pattern has a failing test" cannot be checked. |
| 39 | 6.3, 2, B.2 | AMBIGUOUS | Digits or numbers: are number words ("two", "a dozen") allowed outside lifespan and characteristics? The B.2 prompt never tells the model the digit rule, so "fed 2-3 times a day" in `diet` fails. Is that intended? | The guard and the prompt do not agree, which predicts high failure. |
| 40 | 6.5 | AMBIGUOUS | Does the display-time guard on RESEARCHED pages keep the number allowance? If every statement in a section is withheld, is the section still shown? | The rendering rule is undefined. |
| 41 | 14, 3.3, 12 | CONTRADICTION | 14 (under A1) requires a DB CHECK refusing a stored `breeding` in an AI draft. 3.3 defines no such CHECK, and `kind_about` is an A3 deliverable. | The constraint is missing and the slice is wrong. |
| 42 | 3.3 | NOT STATED | `kind_about_run.workspace_id` has no FK. `outcome` values are not listed. Is `requested_by` a user id, an email or a login? The 80-character limit on `display_name` has no CHECK. Who maintains `updated_at`? What is the ON DELETE behaviour? | There are data-model holes. |
| 43 | 4.6, 3.3 | NOT STATED | Under FORCE RLS, which role and household context does the background call-2 job use when it writes? | The write fails or bypasses RLS. |
| 44 | 0, 5 | NOT STATED | "Never an animal's name": nothing stops a person typing the pet's name ("Banoffee") or other personal text as the kind. Only length and control-character checks exist. Is a check intended, or should the claim be softened? | The privacy claim is not enforced. |
| 45 | 4.7, 7 | AMBIGUOUS | "Family and above" versus the `ADD_MEDIA` role action: can a Viewer PUT consent? Are regenerate, wrong and withdraw guarded the same way? | The role guard mapping is unclear. |
| 46 | 1.2, 8, Q3 | AMBIGUOUS | Wildlife pages are "stored only", but `GET about/species/:id` and the picker link would serve any species. Are wildlife species hidden? Are they in the picker at all? | The exposure rule is unclear. |
| 47 | 8, 9 | AMBIGUOUS | For a picker species with no page, is the "What is a …?" link hidden, or does it show "Page coming"? | The UI is undefined. |
| 48 | 11, 3.4 | NOT STATED | The backfill: which column holds the typed name? How is the "module" derived? What happens if two species match? Is the backfill safe to re-run? | The migration cannot be written. |
| 49 | 12 | AMBIGUOUS | "The real call is proved once on the iMac by Ryan" and "no unresolved 'wrong claim'": what records the proof, and what format marks a claim resolved? | The acceptance cannot be checked by a builder. |
| 50 | 2, B.2 | AMBIGUOUS | Statement bounds: RESEARCHED `summary` is 1-3, but the draft allows 1-8 for every section. What are the minimums for other RESEARCHED sections? B.2's 10-character minimum is not in sec 2. | The schema bounds are unclear. |
| 51 | many | NOT STATED | The spec is not self-sufficient. It depends on definitions held elsewhere: D1 sec 2, 3.3.1, 5.1, 5.2, 9.1, 10, 10.1 and 10.3; migrations 004, 006 and 015/016; `inbox.ts` `setConsent`; `reader.ts` `claudeReader`; Vitalis `EXTRA_BANNED`, `lintText` and `aiguard.ts`; the "vault_folder_binding rule"; "D1 review 2026-10-07 finding 1"; the Axiom runner, `migrate.sh` and `kit advance`; `PETOPIA_CLAUDE_CMD`; and HANDOFF.md and DESIGN.md. | A builder must leave this file to learn RLS policy, the consent pattern, the spawn flags' behaviour and the banned-word lists. |

---

## (c) What I could not judge

- **Fit with the live system.** A cold read checks only whether the spec stands on its own. I cannot tell whether these exist as the spec assumes:
  - `ref.species` (and its `common_name`, `module` and pet/wildlife columns)
  - `core.consent_event` and its `kind` CHECK
  - `core.workspace`, `ext.species_name` and the `ADD_MEDIA` role action
  - migration number 017 being free
  - the 27 wave-1 species already being in `ref.species`
- **Whether copying migration 006's RLS policy** is correct for the two new tables, including the background writer.
- **Whether the `claude -p --json-schema` flags behave as stated.** Appendix A already says this is unproven.
- **Whether the Vitalis guard lists suit animals.** They were not readable here.
- **Whether the sources in sec 9 publish enough per species.**
- **Cost, token and latency figures.** Nothing in the file lets me check that 300 s, 3 s polling or 10/day are sensible.
- **Ryan's intent on Q1-Q7.** The defaults are stated; whether they match what he meant is outside a cold read.
