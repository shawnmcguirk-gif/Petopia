# D2 slice A1 (About pages and aliases): independent review, 2026-10-08

Reviewer: a separate Claude agent that did not write the code (read-only: it read the working tree and the spec, ran type-check and lint,
touched no database). Author: Claude (Cloud/Sonnet 5.5, Ryan's session). Reviewed: migration 017, `about.ts`, `aboutguard.ts`,
`aboutpage.ts`, `animals.ts`, `server.ts`, `load-about.mjs`, `content/aliases.json`, the web About card/page/sheet, and their tests.
Verdict before fixes: **not as it stood; no data-loss path found; design sound.** Verdict after the fixes below: all blocker and
high items closed, all medium items fixed, low items fixed or accepted with a reason.

## Platform facts (spec sec 3.1 first step, recorded)

| Check | `petopia` (live) | `petopia_test` |
|---|---|---|
| `SELECT version()` | PostgreSQL 16.14 (Debian 16.14-1.pgdg12+1) | same server |
| `SHOW server_encoding` | UTF8 | UTF8 |
| `datcollate` / `datctype` (`SHOW lc_ctype` is not a Postgres setting; `pg_database` is the source) | en_US.utf8 / en_US.utf8 | en_US.utf8 / en_US.utf8 |

Postgres 16 is past the 13+ the spec needs, the encoding is UTF8 and the locale is not `C`, so the `Écureuil` and accent rows stay in.

## Findings

| area | finding | severity | fix |
|---|---|---|---|
| Migration / test validity | `migrate.sh` records only the file name, so 017 edited after `petopia_test` applied it would not re-run there; no test applied it twice. | high | **Fixed.** The final 017 was applied to `petopia_test` twice with `psql -1` (both exit 0, adoption returns 0), then the full suite re-run (277 engine, 64 web). The live database gets the final file fresh, in one transaction, after a backup. The spec rule "a migration is not edited once it has run" is kept for the live database; the one edit happened only on the throwaway test database (the placeholder is matched by name, not module: Goat, Sheep and Pig also use module `other`). |
| Adoption on live data | `adopt_typed_kinds` is irreversible; typed text is deleted; broad aliases (`parakeet`, `fish`, `hog`, `ass`) could mis-switch a real animal. | medium | **Fixed.** Read-only preview on the live database: 0 "Other animal" animals exist, so nothing would switch. The four general words are no longer aliases (tested). The `RAISE NOTICE` per animal remains the record; the backup is the undo. |
| Adoption filter | Selected `module_code = 'other'`, so a Goat with a stray `species_name` could be adopted. | low | **Fixed.** Requires the species to be "Other animal" (as spec 3.5 says). Test: a Goat with a stray typed name is left alone. |
| switchSpecies / updateAnimal | The 409 check and the UPDATE were not atomic; concurrent requests were last-writer-wins. | medium | **Fixed.** The UPDATE is guarded by the species read first; zero rows changed gives 409. |
| normalise_kind | Depends on locale; header did not record it; changing the function later would not rebuild the index/CHECK. | medium | **Fixed.** Locale recorded above; the 017 header says a later change needs a REINDEX and an alias re-check. |
| normalise_kind (non-Latin) | Combining marks are deleted, so some scripts collapse. | low | **Accepted.** Matters only for A3's `kind_key`; noted for then. |
| Typed-kind validation | An emoji-only kind got the message "letters, not only punctuation"; a legacy kind could not be re-saved. | low | **Fixed.** Message is "using letters or numbers"; the check is skipped when the kind is unchanged. Tests for both. |
| Display-time guard | Stored sources went to the page unchecked (scheme, types); reviewer name not guarded. | medium | **Fixed.** `cleanSources` keeps only well-formed `https://` sources; a `reviewed_by` that looks like a link or is over 80 characters is not shown. Unit and database tests. |
| Malformed stored page | `sourceCount` threw on a section with no `sources`, giving a 500. | medium | **Fixed.** Defensive, with a database test on a damaged row. |
| Web resilience | `isPage` checked only `state`; a bad shape could blank the Overview. | medium | **Fixed.** `isPage` validates the shape; the card is wrapped so it vanishes rather than breaking the Overview; page and sheet say "couldn't be loaded" for a bad answer. Tests. |
| Web a11y / plain words | No chevron on sections; the sheet did not take focus; load failure read as "no page"; duplicate source link keys. | low | **Fixed** (chevron, focus in and back, separate messages, index in key). A full Tab trap in the sheet is not done: **accepted** for A1 (Escape and the Close button work; revisit with the A3 sheets). |
| Loader | `retire --dry-run X` took the flag as the name; unknown species exited 0; a punctuation-only alias died on the CHECK; an empty `{}` file silently deleted every alias. | low | **Fixed.** Name parsing, exit 1 on unknown species / no live page, friendly alias error, `{}` refused. Tests. |
| Write guard | Row triggers do not fire on `TRUNCATE`. | low | **Fixed.** Statement-level `BEFORE TRUNCATE` guards on both tables; test. |
| Spec 3.4 step 2 | "Two species" branch can never fire (names and aliases are unique) and no warning is logged. | low | **Fixed in the spec** (corrected; the function still treats any count other than one as "no match"). A test now proves every alias and every species name resolves to its owner. |
| Repo hygiene | `ACTIONS.md` is generated and shows as modified; `content/about/` is empty. | low | `ACTIONS.md` is not committed. The empty folder is expected until A2. |
| Test gaps (DB) | Adoption tested only as "not negative"; no two households, deceased, stray Goat, wild-kind, blank-kind cases; no retire/dry-run cases. | medium | **Fixed.** All added, plus the loader and `TRUNCATE` cases. One reviewer item is not added: a loader database error on the second of two files rolling back the first. Validation runs first and the write is one transaction, so the case needs a fault injected into Postgres; accepted. Concurrent `switchSpecies` is covered by the guarded UPDATE, not by a race test. |
| Test gaps (normalise / HTTP / web) | No no-break space, zero-width, combining-only, emoji, or expansion tests; no stranger/bad-body HTTP tests; no malformed-shape web tests. | low | **Fixed.** All added. |

## Checked by the reviewer and found fine

The guard rules match spec sec 6.2/6.3; the three new routes use the same guards as their neighbours and `about/kind` writes nothing;
the loader flag is transaction-local and a test scans `engine/src` for it; retire-then-insert order, content hash and
validate-everything-first are right; the consent-kind block matches one constraint and repeats safely; `adopt_typed_kinds` copes with an
uncalled sequence and resets the household setting; statements render as plain text with `rel="noopener noreferrer"` links; the real alias
file has no clash or shadowing.

## After the fixes

Engine 277 / 277 and web 64 / 64 on the iMac (real Postgres), lint and type-check clean. Not deployed at the time of writing; the deploy
batch follows this file.
