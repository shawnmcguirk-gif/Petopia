# D2 About pages: second cold read (2026-10-08)

- **Input:** `docs/specs/D2-about-pages.md` draft 2 (906 lines, commit fb20d9f), read on its own by a fresh agent that opened nothing else.
- **Method:** skill `spec-cold-reader`. Questions only. This is not an approval, rejection or sign-off.
- **Count:** 57 questions. 25 NOT STATED, 19 AMBIGUOUS, 11 CONTRADICTION, 2 UNBUILDABLE. (Disposition: spec Appendix E.)
- The reader hand-evaluated regexes and SQL; it could not run them.

---

## (a) What the reader believed would be built

Two tiers of About pages: RESEARCHED (shared, sourced, loaded offline by `load-about.mjs pages|aliases|retire`) and AI draft (per household, unsourced, no breeding or health). Migration 017 (A1): `ref.normalise_kind`, `ref.species_alias`, `ref.species_about` (versioned, hashed, one live row), write-guard triggers, `alias_clash`, `ABOUT_DRAFT` consent kind, `animal.adopt_typed_kinds()`. Migration 018 (A3): `animal.kind_about` (LOOKING, CONFIRMING, WRITING, READY, FAILED) and `kind_about_run` (also the daily cap's counter), household RLS. Engine: `aboutguard.ts`, `claudejson.ts`, an in-process queue, a 20-calls cap, a 5-minute stale sweep, ten endpoints, and a changed `createAnimal`/`updateAnimal`. Screens: card, page, consent sheet, Which-animal, picker link. Slices A1 to A4. It read the draft flow as starting only on a button press, per-person consent per call, and drafts as household-level with no link to an animal.

---

## (b) Questions

| # | Sec | Type | Question |
|---|---|---|---|
| 1 | 3.1 | NOT STATED | Target DB encoding and locale? `lower()`, `[:alnum:]`, `normalize()` depend on UTF8 and locale; the 3.1 table and A1 test can pass or fail on a setting never stated. |
| 2 | 3.1 | AMBIGUOUS | The `ǅ` row says output `dž`. NFKC then lower gives two code points, not U+01C6; and it is not a "ligature". Which does the test expect? |
| 3 | 3.1, 5 | NOT STATED | When are control characters removed relative to normalisation; are tab/newline spaces or deleted ("a<TAB>b" becomes "ab")? |
| 4 | 3.1 | AMBIGUOUS | Does "more than three characters" and "does not end in ss" apply to the whole string or the last word (`wood pigeons`)? |
| 5 | 3.4, C.7 | CONTRADICTION | "The unique index from 016 and the clash triggers make the answer unique", but 016's index is case-insensitive on `common_name` only; not `normalise_kind`, the stripped-`s` form, or alias vs stripped name. What does `createAnimal` do if two species match? |
| 6 | 3.4, 3.5, 4.5, 8.1, 9.5, A1 | CONTRADICTION | A1 requires typed "Wood pigeon" to save the real species, but it is a WILD reference species; 3.5 and 4.5 limit adoption to PET/BOTH and 3.4 has no domain filter. Does a typed WILD species become a real animal? Domains are never listed. |
| 7 | 3.4, 3.5 | AMBIGUOUS | 3.4 says the animal gets "its module, care suggestions, weight limits… as 016 does"; 3.5 sets only species, module, ext version, ext. Are routines, vaccine sets, measures created at switch or derived on read? |
| 8 | 3.4 | NOT STATED | A typed "Other animal"/"other" normalises to the placeholder's own name. A match? Does `adopt_typed_kinds` loop on it? |
| 9 | 3.5, 5, C.7 | NOT STATED | Schema-qualified animal table and column names, the workspace sequence name, a never-called sequence, archived/rehomed animals. |
| 10 | 3.5 | NOT STATED | Does the new module's ext schema accept every other key in the old `ext`? Is `ext` revalidated? |
| 11 | 3.5, 4.8 | NOT STATED | `POST animals/:id/species`: unknown/WILD species, name vs id, 403 vs 409 order, must the target have a page? |
| 12 | 3.5 | NOT STATED | What is the "timeline entry" (table, columns, type, actor, text)? |
| 13 | 4.5, 3.5, 11 | CONTRADICTION | 3.5 says an existing draft is left alone; 4.5 says the switch endpoint deletes the draft when it has no sections. Safe when other animals share the kind, or the row is in flight? |
| 14 | 3.2 | AMBIGUOUS | "The two triggers above" vs at least four; names, events, idempotent re-creation; how the inline CHECK is found by name. |
| 15 | 3.2, 9.2 | CONTRADICTION | "Inserts version + 1 and retires the previous in the same transaction": the partial unique index is not deferrable; insert-before-update violates it. Which order? |
| 16 | 3.2, 9.2 | NOT STATED | After `retire`, the file still exists; does the next `pages` run un-retire it? |
| 17 | 3.2, A1 | NOT STATED | Which species get aliases; who loads `content/aliases.json` in a fresh `petopia_test`? |
| 18 | 3.3, App D #42 | CONTRADICTION | The DDL for `run_draft_fk` has no `ON DELETE SET NULL (kind_about_id)`; as written `DELETE` fails whenever runs exist. |
| 19 | 3.3, B.1 | AMBIGUOUS | `candidates` comment omits `confidence`; stored, shown or ordered? |
| 20 | 0, 3.3, 4.8, 5 | AMBIGUOUS | 80-char limit on the raw or normalised string; which exact string goes in the prompt? An 85-char name normalising to 78 passes §5 but fails the CHECK. |
| 21 | 3.2, 3.3, 9.1, B.2 | NOT STATED | Response shapes of the GET endpoints (sections differ by tier; `domain`, `scientific_name`, `checked_on`, `version`, `reviewed_by`, terminal flag, 412 body). |
| 22 | 4.3, 3.3 | CONTRADICTION | The sweep on a regenerating row goes to READY with `failure = 'INTERRUPTED'`, but `kind_about_ready` requires `failure IS NULL`. |
| 23 | 4.3, C.1 | UNBUILDABLE | The sweep and the cap's counting run with no household set; household tables and `core.workspace` read as empty under FORCE RLS. Only `adopt_typed_kinds` gets the `generate_series` trick. |
| 24 | 4.3, 4.7 | NOT STATED | Does the sweep clear `current_run_id`; does a job re-check status; a queued row can pass 10 minutes before its job starts. |
| 25 | 4.3, 8.2 | CONTRADICTION | `last_failure` is kept after a retry; the card shows "Couldn't refresh" for any READY with `last_failure`. Nothing clears it. |
| 26 | 4.3 | CONTRADICTION | NOT_AN_ANIMAL is "terminal" but the terminal rule is only attempts >= 3 or two guard rejections. |
| 27 | 4.3 | NOT STATED | "Last two failures of this step were GUARD_REJECTED": no column holds that; after Choose again (`attempts = 0`) do earlier rejections count? |
| 28 | 4.3, 4.8 | NOT STATED | Response for events in states the table does not list (retry when not FAILED, choose when READY, regenerate while WRITING…). |
| 29 | 4.3, 4.8 | NOT STATED | `POST about/kinds {name}` has no animal id: does it run 3.4 and refuse species names; must the name match an animal's typed kind; precedence among 400/409/412/429; what does the §5 name check compare. |
| 30 | 4.3, 4.5 | AMBIGUOUS | Order of checks in `choose`; if the matched species is WILD? |
| 31 | 4.3 | AMBIGUOUS | "`candidates` exist" when `candidates` is `[]`; are `failed_step`, `last_failure`, `attempts` reset on READY to wrong? |
| 32 | 4.3 | AMBIGUOUS | The generic any-failure row and the regenerating failure row overlap; which wins; is `failed_step` set? |
| 33 | 6.1, 4.4 | AMBIGUOUS | A draft with a `breeding`/`health` key "fails the whole answer": `BAD_ANSWER` or `GUARD_REJECTED`? |
| 34 | 4.5, 6.3 | CONTRADICTION | 4.5 says "sec 6.2 `BAN_ALL`" but no rule has that name; 6.3 says "the every-page rules". Which set; with what tier/section arguments; display-time guard on candidates? |
| 35 | 4.5, 11 | AMBIGUOUS | "Letters" in the candidate charset: ASCII or Unicode? The B.1 prompt does not ask for English. |
| 36 | 6.2 | UNBUILDABLE | "Rules are JavaScript regular expressions exactly as written", but patterns are written with `\|` (the markdown table escape); read literally the alternations break. |
| 37 | 6.2 | AMBIGUOUS | "Passes (must not be rejected)": by that rule alone, or by `guardStatement` for a tier and section? Several pass-sentences contain digits, which `DIGIT` rejects in an AI draft outside lifespan/characteristics. |
| 38 | 6.2 | AMBIGUOUS | `SECOND_PERSON_STATE` alt 2 needs `\s+` before `'ve got`, so "you've got" never matches; "ring your vet" is matched by no rule though the style rule says never "your"; `IMPERATIVE_HEALTH` rejects descriptive "give a loud call". |
| 39 | 6.2 | AMBIGUOUS | `PHONE` matches any 9-char digit-and-dash run ("1000-1500 g"), not only year ranges; "2019-2021" is eight digits, not nine. |
| 40 | 6.4 | NOT STATED | Which single rule id is written when several match. |
| 41 | 4.4, 8.2 | NOT STATED | Card text for `BAD_ANSWER` and for terminal rows ending in BAD_ANSWER, INTERRUPTED, CONSENT_WITHDRAWN. |
| 42 | 8.2, 7, C.3 | AMBIGUOUS | "Hidden for a Viewer-only member": Viewer on this animal or on all? The API uses `requireAny`. Which controls are hidden for Viewers? |
| 43 | 8.1, 12 | NOT STATED | How does the picker know which species have a page; the article rule for "What is a …?". |
| 44 | 8.1 | NOT STATED | Badge text for one source ("1 sources"); does "Read by name" replace the whole footer; does a draft page head with the typed kind or the chosen candidate. |
| 45 | 8.2 | NOT STATED | Card for an "Other animal" whose `species_name` is empty or missing. |
| 46 | 12, 14, 3.3, 4.8 | AMBIGUOUS | What are "the A1 states" of the card; `GET about/kind` returns `draft` and `my_consent` but those arrive in A3. What does it return in A1? |
| 47 | header, 8, App C | NOT STATED | The header claims everything is restated in Appendix C; there is no web code (framework, router, component conventions); D1 sec 9.1/3.3.1 are only cited. |
| 48 | 4.7, C.4 | NOT STATED | Where in the `claude -p --output-format json` envelope are the answer, token counts and cost; how are unreachable/timeout/bad answer distinguished? |
| 49 | 5, B.1, B.2 | AMBIGUOUS | "Strips `<<<`, `>>>` and the words NAME/PICKED adjacent": how, case; what goes in PICKED when `chosen` is null; acceptance pins "exact prompt text" while A3 tunes prompts. |
| 50 | 9.2, 2 | AMBIGUOUS | Loader refuses any repeated `publisher` when two are required; is three sources with two sharing a publisher refused? |
| 51 | 2, 14 | CONTRADICTION | `health` is optional for WILD; the A2 acceptance says all 27 species show two publishers for `health`. |
| 52 | 9.5 | AMBIGUOUS | "Every other pet species (37 at 016)": total or remainder; A4 acceptance does not require the pages to show. |
| 53 | 9.1, B.3 | NOT STATED | Slug rule for punctuation; where `page.json` lives; the B.3 example `checked_on` 2026-10-09 is after today and would be refused. |
| 54 | 14 | NOT STATED | "Independent review file… no unresolved finding" for A1 code has no format; the `note` receipt syntax; HANDOFF/DESIGN entry format. |
| 55 | 6.2, 14 | CONTRADICTION | 6.2 says A1 and A3 check every sentence test; the A3 list has no guard-test item. |
| 56 | App A, 3.1 | NOT STATED | PG13+ needed for `normalize()` but no fallback if lower. |
| 57 | 4.2 | NOT STATED | Ordering of "latest" consent row (`at` or id); what words are recorded on withdrawal. |

---

## (c) What the reader could not judge

Fit with live code and DB (016, `animals.ts`, `inbox.ts`, `access.ts`, `reader.ts`, `db.ts`, the web code, D1); execution of regexes and SQL (traced by hand; the listed examples matched apart from row 36); environment facts (Postgres version/locale/encoding, CLI flags, runner and `kit` behaviour); content quality and the realism of the cap and timings; Ryan's intent on Q1 to Q7.
