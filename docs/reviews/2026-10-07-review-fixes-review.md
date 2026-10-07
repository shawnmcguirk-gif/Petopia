# Petopia D1 -- independent review of the S3-S7 review fixes (2026-10-07)

- Reviewer: independent Claude agent (not the builder, not the original reviewer)
- Commit reviewed: `b6f1926` (fixes a5fb4ae + 83db10b; diff vs 5c5d603)
- Date: 2026-10-07
- Ran: 001-014 applied to a fresh Postgres 16 (embedded harness); engine 168/168 green (DB tests ran, none skipped), web 37/37, `tsc --noEmit` clean in engine and web. Extra probe tests in a throwaway copy (`~/review-copy`), not committed.

**Verdict: READY WITH NOTES** -- every finding asked for is fixed or partly fixed (6), with tests that actually exercise it. Nothing must be fixed first. Four should-fix items below; the guard over-dropping (MIN_QUOTE, textsOk) should land before the live A20 acceptance run with a real invoice.

## Findings 1-9, 11, 12

| # | Finding | Verdict | Evidence | Test proves it? |
|---|---|---|---|---|
| 1 | Withdrawing FOLDER_READ doesn't stop reading | FIXED | inbox.ts:157-165 (`GO_AHEAD`/`AI_GO_AHEAD`, `stillAllowed` FOR UPDATE i / FOR SHARE b); read claim + keep-txn re-check (readText); assess:232, claim re-checks the go-ahead in the same UPDATE, keep-txn re-check -> `GO_AHEAD_WITHDRAWN` run, nothing kept (:271); sweep filters DISCOVERED/READ by go-ahead; setConsent:92 (no AI without folder), :98-102 (folder withdrawal also clears AI and writes its own consent_event) | Yes -- inbox.db: 3 tests (at rest, withdrawal mid-read, withdrawal while Claude reads); checks consent_event rows, page_text empty, reader call counts |
| 2 | `decide` etc. have no maySee | FIXED (residual: re-decide, see New issues) | `mustSee` -> 404 like a missing id (inbox.ts:382-387); used in getItem:418, decide:464, decidedItem:524, retryRead:739; route guard server.ts:244 runs `requireSeeItem` before the role check; documentFile -> 404 | Yes -- roles.db "finding 2": 6 by-id routes, body equal to a missing id, no SECRET text, row unchanged; A27 route walk expects 404 on item routes |
| 3 | Quote guard only checks numbers | FIXED (too eager: MIN_QUOTE, textsOk, see New issues) | guard.ts:52/101 MIN_QUOTE 8; :132 `unitIn` (whole word, kg is not g); :118 `textsOk` every free-text field in the quote; :221 provider name in quote; applied :237-238 | Yes -- guard.test: 6.1 kg vs lb, "Cancer" vs kidney quote, "." and "e" quotes, clinic name |
| 4 | day/month swap not flagged | FIXED (noisy: see New issues) | guard.ts:152-176 `dateIn` needs day+month+year; dd/mm vs mm/dd -> `DATE_ORDER_AMBIGUOUS`; doc date: decide refuses until the person sets it (inbox.ts:482); web StepOne leaves the date empty | Yes -- guard.test (swap 2026-03-10 vs 03/10/2026 never OK; year alone no longer passes), inbox.db decide 400, web test |
| 5 | Implausible doc weight saved with plausibility_confirmed=true | FIXED | inbox.ts:505-520 weightCheck/flagUnusualWeights (at step 1 and before accept-all); reviewProposal:540 409 unless `confirm_unusual`, sets UNUSUAL_CONFIRMED + decided_by; writeFacts:618 `plausibility_confirmed = !ok && answered`; fileItem re-checks accepted weights, sends them back (:692); web asks the question | Yes -- inbox.db "finding 5" (42 kg cat: flagged, skipped by accept-all, 409, file refused, then confirmed -> row `plausibility_confirmed=true`, confirmed_by alex); web test checks the two POST bodies |
| 6 | `--tools ""` doesn't isolate the container CLI | PARTIAL | reader.ts:148 always `--strict-mcp-config`, `--disable-slash-commands` only if `--help` lists it. Not done: container `~node/.claude` inspection (hooks, CLAUDE.md, plugins, settings permissions); docker cwd, see New issues | Only arg pinning (guard.test `claudeArgs`); nothing proves the live CLI accepts the flag or is isolated |
| 7 | "today" uses server/browser local time | FIXED (residual: DB current_date) | age.ts:22 and web/format.ts:15 Intl Europe/Dublin | Yes -- age.test (IST/GMT midnight, TZ overridden to Kiritimati/LA), web care.test |
| 8 | Folder uniqueness case-sensitive | FIXED (deploy note: case-duplicates) | inbox.ts:77 `lower()=lower()`; 014:11 unique index on lower(name); 23505 maps to 409 | Yes -- inbox.db: engine 409 and DB 23505 on a raw insert |
| 9 | rename fallback can overwrite; MOVE_FAILED no recovery | FIXED (residual: duplicate copy on partial move) | vault.ts:111 `copyFile(COPYFILE_EXCL)` + SHA-256 compare (:118) before unlinking the source; finishFiling candidates name, -hash8, -hash8-2..9 (inbox.ts:707-721), FILED_UNDER_NEW_NAME; sweep retries FILED_PENDING | Yes -- vault.test (EPERM link mocked, destination written in the race -> 409, both files intact); inbox.db files under `-hash8-2` with both names taken |
| 11 | confirmed_by rewritable on CONFIRMED row | FIXED | 014:13-31 append_only_guard freezes confirmed_by/at once set; same function serves 008 + 009 triggers; only writers of confirmed_by are PROPOSED->CONFIRMED (records.ts:223, inbox.ts:598) | Yes -- inbox.db: UPDATE confirmed_by / confirmed_at -> 23514; status -> DISPUTED still allowed (health.measurement only; the 009 tables share the function) |
| 12 | MANUAL routine with unverified source | FIXED | care.ts:92-100: table+id both or neither; any origin checks the row exists, same animal, not DISPUTED (VET_ADVICE: CONFIRMED); source_table enum-checked by ajv | Yes -- care.db: another animal's record, missing id, id without kind -> 400; own record OK |

## New issues

| Sev | Where | Issue | Suggested fix |
|---|---|---|---|
| should-fix | inbox.ts decide (~461-484) | Once an item has an animal, any Family member on that animal passes `mustSee` and can re-run step 1 on someone else's document: probe -> 200, a Family member moved alex's document onto their own dog (`decided_by` = them). Goes against the fix's own test comment ("step 1 on alex's own document is alex's or a manager's"). The document then follows the new animal's visibility. | In decide (PROCESS/KEEP_ONLY too, not only NOT_PET): require `it.member_name === member \|\| managesAny`. Add a test. |
| should-fix | guard.ts:101 MIN_QUOTE | Legitimate short quotes are dropped: probes `"6.1 kg"` and `"Wt: 6kg"` -> QUOTE_TOO_SHORT, doc date `"2/10/26"` dropped -> DATE_ASSUMED. The prompt asks for "a short quote" and does not mention the 8-char minimum. With textsOk + numbersOk + dateIn, the "." / "e" case is already caught. | Drop MIN_QUOTE or lower it to ~4, or apply it only when the fact has no number/date; tell the prompt "at least a few words". |
| should-fix | guard.ts:118, :238 textsOk | All-or-nothing per fact: one free-text field not in the single quote drops the whole fact. vet_visit has 7 text fields (vet_name, reason, symptoms, examination, ...), usually on different lines; probe: vet_name in the header + reason in the body -> whole visit dropped; a light paraphrase ("Limping (right foreleg)") -> dropped. The visit is the hub of the S5 acceptance ("visit, vaccination and weight on the Timeline"). Same risk for lab_result.test (panel header). | Null only the unsupported text field and flag the fact (e.g. FIELD_NOT_IN_QUOTE); keep the drop for required fields. Or allow a quote per field. Measure the drop rate on a real invoice before A20. |
| note | guard.ts:118 textsOk | Plain substring, no word boundary or minimum length: vaccine `"a"` passes against any quote; "Cat" matches "Category"; "Cancer" passes against "Cancer screening: negative". | Whole-word match (as unitIn does) and a minimum value length of 2-3. |
| note | guard.ts:165 / decide | Every Irish numeric date with day <= 12 is AMBIGUOUS (~40% of dates): step 1 always needs the date typed, those facts are kept out of "accept all", and the date the person sets is not carried over to the fact dates on the same page (a swapped fact date can still be accepted one by one). Also MISSING: `3 / 10 / 2026`, `03 10 2026`, `3rd day of October 2026`, `Oct 3, 26`, `3OCT2026`. | Settle the order per document: if any date on the page is unambiguous (25/10) or the person sets the doc date, settle the others; prefill the Irish reading with a one-tap confirm. |
| should-fix | reader.ts:170 + claudeCommand | `cwd: tmpdir()` sets the cwd of the host `docker` process, not of `claude` inside n8n. That runs in the container's workdir (likely /home/node = ~), so project-level `.claude/`, `CLAUDE.md` and `.mcp.json` there load as well as the user-level ones. `--strict-mcp-config` does not cover hooks, CLAUDE.md or settings. | Add `-w /tmp` (an empty dir) to the default `docker exec`; consider `--setting-sources` / `--settings` with an empty settings file if the installed CLI supports them; do the container inspection (still open). |
| note | migrations/014:11 | On the live DB the index fails (23505, verified) if two bindings differ only by case. Safe because migrate.sh runs one transaction per file, but the deploy would stop there. | Before migrating: `SELECT lower(vault_folder_name), count(*) FROM core.vault_folder_binding GROUP BY 1 HAVING count(*) > 1;` |
| note | access.ts:123, :190 | Role end dates use the DB `current_date` (container TZ, likely UTC): wrong day between 00:00 and 01:00 Irish Summer Time. Rest of finding 7 is fixed. | `(now() AT TIME ZONE 'Europe/Dublin')::date` or pass todayIso(). |
| note | inbox.ts finishFiling / vault.ts safeMove | If the link/copy succeeds and `unlink(from)` fails, the next pass finds the name taken and files a SECOND copy under `-hash8` (duplicate in filed/). Earlier code had the same gap. | When a candidate exists with the same SHA-256 as the source, treat it as done: unlink the source and record that path. |
| note | care.ts addRoutine | `medication_id` is still not checked to be this animal's (the same class as finding 12). | Same exists/same-animal check. |
| note | HANDOFF.md:50 | Still says "014 only on the WIP branch"; it is on main at b6f1926 (not yet applied live). `schema.sql` is stale until the live migrate.sh run. | Update at deploy. |
| note | inbox (finding 1 scope) | After a withdrawal, items already read (NEEDS_REVIEW with page_text) stay visible and reviewable. Probably intended (nothing new is read), but the spec does not say so. | Confirm with Ryan; add one line to spec 5.1. |

## Could not verify

- That the n8n container's `claude` accepts `--strict-mcp-config` (an older CLI fails every read -> READER_FAILED); what is in `~node/.claude` (hooks, CLAUDE.md, plugins, permissions); the container workdir.
- Migration 014 on the live iMac DB: case-duplicates, function ownership (`CREATE OR REPLACE` needs the 008 owner), the live GRANTs needed by `FOR SHARE OF b` (UPDATE privilege on vault_folder_binding).
- Drop rate of the stricter guard on real documents with live Claude output (the MIN_QUOTE, textsOk and date-ambiguity issues come from probes).
- The copy fallback on the real vault volume (APFS normally allows hard links, so the fallback may never run there); iMac TZ / Postgres TimeZone.
- The race between withdrawal and the keep-transaction is reasoned from the locks; the tests cover withdrawal before the keep-txn, not during it.

## Re-check of the 4 should-fix items (9e67351)

Diff 60ba667..9e67351 (60ba667 = b6f1926 + schema.sql). Fresh Postgres, 001-014: engine 170/170 green (+3 probe tests of mine in `~/review-copy`, also green); web 37/37; engine `tsc` clean. Container inspection and live 014 are as the coordinator reported (runner); I did not re-check them myself.

| Item | Verdict | Evidence |
|---|---|---|
| Re-run of step 1 by a Family member | FIXED | inbox.ts `mayDecide` (folder's person; else CONFIRM_RECORDS on the item's animal; managesAny before an animal is set) is checked in decide for every action after `mustSee`. Probes: Owner of another animal who is only Family on the item's animal -> 403 for PROCESS and NOT_PET; Owner of the item's animal -> 200. inbox.db asserts 403 for the Family member. |
| MIN_QUOTE 8 -> 3 | FIXED | guard.ts:55. "6.1 kg", "Wt: 6kg" and "2/10/26" pass (guard.test); "." and "e" still dropped. |
| Text value blanked, not whole fact dropped | FIXED, 2 follow-ups (below) | `textsMissing` + `fieldsFit`: blanks the field, flags FIELD_NOT_IN_QUOTE, drops only when a required field goes. Probe: a multi-line visit keeps `reason` and blanks `vet_name`. A missing vaccine (required) is still dropped. |
| wordsIn whole-word match | FIXED, 1 follow-up | Escaped literal with `u` flag, Unicode letter/number boundaries. Probes OK: "Cat"/"Category" no; Ó, combining accents (NFKC), ®, "<0.5", "C++", "$100", parentheses, ligature "ﬂ" all behave. |
| `-w /tmp` on docker exec | FIXED | reader.ts default command; guard.test pins it. |

**New from these fixes:**

| Sev | Where | Issue | Suggested fix |
|---|---|---|---|
| should-fix | guard.ts blanking | Blanking can leave a fact with no printed value at all. Probes: a made-up `vet_visit {kind: EMERGENCY, vet_name, reason, diagnosis}` with quote "Invoice 77" survives as `{kind: EMERGENCY}`; a treatment survives as `{kind: WORM}`. b6f1926 would have dropped both. They are flagged, so "accept all" skips them, but one tap files an EMERGENCY visit. A code-only fact with a 3-character quote ("Riv") passes with NO flag. | Drop a fact that has no non-code value left (no text, number or date) after the checks. |
| should-fix | guard.ts `delete fields[k]` + web ProposalCard | A blanked field is deleted from the payload, and the Correct form lists only payload keys. So the field the flag says to "check" ("left blank, check it") has no input box. | Set blanked fields to `null` (fieldsFit already treats null as missing; the web maps null to ''). |
| note | guard.ts wordsIn | The digit boundary blanks units printed against the number: `dose_unit` "mg" in "25mg" and `unit_printed` "mmol/L" in "5.2mmol/L" are not found (flagged, not dropped). A trailing "." on the value ("Feline enteritis.") also fails. `"a"` still matches as a word. | Allow digit neighbours for unit-like fields (as unitIn does); trim trailing punctuation on values; minimum value length of 2. |
| note | mayDecide | Once an Owner moves a document onto another animal, that animal's Owner gets step-1 rights over it (probe: moved back -> 200). Follows from the rule; just noting it. | None needed unless Ryan wants step 1 limited to the folder's person + managers of the ORIGINAL animal. |
| note | install-launchagent.sh:37 | `PETOPIA_CLAUDE_CMD` from the environment is copied into the plist. If the live plist sets it, the new `-w /tmp` default never applies. | Check the live plist; if it is set, add `-w /tmp` there. |

**Updated verdict: READY WITH NOTES** -- all 4 should-fix items are fixed. The two new should-fix items (evidence-free facts left after blanking; blanked fields missing from the Correct form) are small and should land before the live A20 run.

## Final check (c5d7c29)

Diff 9e67351..c5d7c29 (guard.ts + guard.test only). Fresh Postgres 001-014: engine 170/170, web 37/37, engine `tsc` clean. Probes rerun in a refreshed `~/review-copy`.

| Item | Verdict | Evidence |
|---|---|---|
| Fact with nothing printed left is dropped (`hasPrintedValue`) | FIXED, 1 gap | Probes: `{kind: EMERGENCY}` with quote "Invoice 77" -> dropped; code-only fact with a 3-char quote ("Riv") -> dropped. Gap: a date that failed its check still counts as "printed". A made-up visit `{kind: EMERGENCY, visit_on, reason}` with quote "Invoice 77" survives as `{EMERGENCY, 2026-10-03}` (flags FIELD_NOT_IN_QUOTE + DATE_NOT_IN_QUOTE). |
| Blanked fields set to `null` | FIXED | `fields[k] = null`; the web view hides nulls and the Correct form shows them as empty boxes; DB tests green with null payload fields. |
| Unit-like fields accept a digit before | FIXED | `/unit/` keys (dose_unit, unit_printed): "mg" in "25mg" yes, "g" in "25mg" no; medication probe passes clean, no flags. |
| Trailing punctuation trimmed | FIXED | "Byrne." matches "Byrne". |
| Values under 2 chars fail | FIXED, 1 regression | "a" no longer matches. But real 1-char lab values are now blanked: `value_printed` "5" ("Glucose 5 mmol/L") and `flag_printed` "H" ("ALT 120 U/L H") -> null + FIELD_NOT_IN_QUOTE. |
| `-w /tmp` / live plist | Could not verify | Coordinator is checking the live plist; `.env` reportedly does not set `PETOPIA_CLAUDE_CMD`. |

| Sev | Where | Issue | Suggested fix |
|---|---|---|---|
| should-fix | guard.ts `wordsIn` min length | Single-character lab values ("5", "H"/"L") are blanked: real data lost, person must retype. | Skip the 2-char minimum for `value_printed` (numbersOk already checks its numbers) and `flag_printed`, or apply it only to free-text fields. |
| should-fix | guard.ts `hasPrintedValue` | A date flagged DATE_NOT_IN_QUOTE counts as printed, so a made-up visit can survive on codes + an unsupported date. Flagged and kept out of "accept all", but one tap files it. | Don't count a date whose `dateIn` was MISSING. |

**Final verdict: READY WITH NOTES** -- everything asked for in c5d7c29 is fixed; two small should-fix gaps above. Both are flagged, never accepted silently. Fix them before the live A20 run or record them as known items.

## Builder's response to the final check (61e5b21) -- written by the builder, not the reviewer

| Item | Response |
|---|---|
| One-character lab values ("5", "H") | Fixed in 61e5b21: the 2-char minimum is for free text only; `value_printed` / `flag_printed` may be 1 char. Test added. |
| A failed date still counts as "printed" | **Kept as is, on purpose (known item).** Not counting it also drops a REAL visit whose date was misread (the existing test, quote "Invoice date: 03/10/2026", visit_on read as 30 Oct). A made-up visit that survives this way carries DATE_NOT_IN_QUOTE + FIELD_NOT_IN_QUOTE, is never taken by "accept all", and shows both warnings. Revisit after the first live A20 run with real documents. |
| Notes not done (open) | finding 10 (re-hash each sweep); `current_date` in access.ts uses the DB time zone; routine `medication_id` not checked to be the same animal; safeMove duplicate copy if unlink fails; finding-1 scope (already-read documents stay reviewable after a withdrawal -- Ryan to confirm); step-1 re-run by the Owner of an animal a document was moved to. |
| Container (finding 6) | Inspected live: CLI 2.1.226 knows all three flags; settings.json only `theme`; no hooks/MCP/plugins/CLAUDE.md; `-w /tmp` works; plist does not override PETOPIA_CLAUDE_CMD. |
