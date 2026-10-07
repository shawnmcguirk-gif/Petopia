# Petopia — decisions record (DESIGN.md)

North Star and architecture/policy decisions for Petopia, D-numbered.
Scaffolded 2026-10-07 via Axiom's D14 new-project convention.

## Decision Record convention (Axiom D14 §3 — read this before adding a decision)

**The stage tag on every heading below (and the matching cells 2-3 in
HANDOFF.md's Pipeline State table) is generated, not hand-typed (D51 job
#768, "Stage as a fold," 2026-09-11).** Both surfaces are a fold over that
D-number's `decision`/`gate`/`stage`/`version` receipts, replayed in order
-- `kit stage-render` is the writer, run automatically after every receipt
(the router) and once a minute across every registered project (the
sweep). To change a stage, file a `stage` receipt (or a gate verdict that
carries one); to raise a decision, file a `decision` receipt. A hand-typed
tag still parses and displays, but it lasts exactly one sweep tick -- the
next run overwrites it back to whatever the fold says, and H31 records
that a hand-typed value was overwritten. Full grammar:
`kit/CONVENTIONS.md` sec 3/sec 6.

Every decision heading carries a square-bracket stage tag, the last one in
the heading wins if more than one appears:

| Tag | Meaning |
|---|---|
| `[Open]` | Raised and numbered; no decision yet. |
| `[Decided]` | Decided; no build artifact will ever exist (policy/convention rulings). Terminal unless superseded. |
| `[Briefed]` | Requirement + context written; technical design still owed. |
| `[Spec'd]` | Technical spec exists and is accepted; build not started (or not finished). |
| `[Built]` | Code/files exist and pass their own checks; not yet running live. |
| `[Installed]` | Deployed to the live stack; not yet verified. |
| `[Verified]` | Confirmed working against the live system by a human or a real reproduction — never by the session that built it. |
| `[Superseded by D<n>]` | Terminal off-ramp; points at the replacement. |
| `[Dropped]` | Terminal off-ramp; abandoned deliberately. |

A build-track decision moves Briefed → Spec'd → Built → Installed →
Verified; a policy decision moves Open → Decided. Skipping forward is legal
when stages genuinely collapse. Whoever completes a stage updates the tag in
the *same session*, dated — a session that ships a build and leaves the tag
at `[Spec'd]` has not finished shipping. **"Dated" means a full timestamp, not just a
date** (2026-08-27 amendment, D14 §3.1) -- write `[Verified
2026-08-27T14:32Z]`, not `[Verified 2026-08-27]`, so a same-day movement
can't be confused with an earlier one from the same day.

**Keep the `Z` -- it is load-bearing (2026-08-27T15:31:28Z parser fix, Axiom D23):** do not drop the timezone designator when writing that stamp. `qualifierDate()`'s own regex used to capture the timestamp but stop at the seconds, throwing the trailing `Z` away -- and ECMA-262 parses a date-time string with NO designator as *local* time (while a date-only string is parsed as UTC), after which the board re-renders it through a `timeZone: 'UTC'` formatter. Net effect: a correctly `Z`-stamped tag displayed one hour early on this UTC+1 machine, and would shift by whatever zone the *viewer* happened to be in -- the exact bug class the GMT work was meant to end, reintroduced by the regex. Fixed in `CommandCentre.tsx` so `Z` and `+HH:MM` offsets survive into `Date.parse`; bare `YYYY-MM-DD` and designator-less timestamps parse exactly as they always did, so no historical tag re-dates itself. Verified against all 152 real tags across every mounted project: only the two genuinely `Z`-stamped ones moved, both by the missing hour.

**Flag tags (Axiom D21) — independent of stage, and REQUIRED when a decision is
waiting on a human.** A heading may carry a second bracket tag *after* the stage
tag. It does not affect the stage:

| Tag | Meaning |
|---|---|
| `[Question: <text>]` | Blocked on a human answer — an open question, an approval, a naming or scope call. |
| `[Issue: <text>]` | Something is wrong or at risk that a human should see. |

Write the flag **after** the stage tag — stage parsing takes the last *stage*
tag, and a flag tag is not one. `extractFlagTag()` in the kit parses these and
the board renders a FlagBadge on Arrivals, which is how **"needs a decision"** is
kept distinct from **"needs verification"** (a gate on finished work that only a
human can pass). Merging the two would dilute the verification signal, which is
the one that must never be missed.

**The rule (2026-08-28, Axiom D24 — do not skip this):** a session that leaves a
decision waiting on Ryan MUST tag it before the session ends. Writing a brief
with open questions, raising a naming or scope call, or parking work pending an
approval all qualify. An untagged decision is *invisible as an ask* — on the
board it looks like work in progress that nobody is waiting on, and it will sit
there. Clear the flag in the same session the answer lands.

Heading shape (Agentle/Tessera convention — use this for new decisions):

```
### D<n>: <title> — [Open]
```

Once a decision actually moves stage, the tag's qualifier carries a real
timestamp, e.g.:

```
### D<n>: <title> — [Built 2026-08-27T09:14Z]
```

## Decisions

### D1: Petopia core -- pets, care records, document inbox, reminders, Synapse menu -- [Spec'd 2026-10-07T00:48:32Z -- was: Briefed 2026-10-07T00:41:59Z]

Lifted from `docs/concepts/2026-10-07-petopia/` (Ryan's brief frozen in `REQUEST.md`; hero art in `reference/`).
D1's own file: `docs/specs/D1-petopia-core.md` (Opus draft 1, 781 lines, NOT yet independently cold-read).
Same setup as Vitalis: own `petopia` database, TS engine, React web UI at `/petopia/` behind Caddy, tile on the Synapse home menu.
Lifted document is an already-complete spec draft, not a bare brief. Open at lift: Benji's breed/age (Q1), who owns which pet (Q2), inbox location (Q3), AI-reading go-ahead (Q4), Synapse feature-vocabulary + n8n edits (Q5).

**Pointers (2026-10-07 14:50):** spec `docs/specs/D1-petopia-core.md` (copy: concept folder `SPEC.md`); concept `docs/concepts/2026-10-07-petopia/` (REQUEST.md verbatim, reference/ hero images, QUESTIONS.md, annotations.md, MANIFEST.json); reviews `docs/reviews/`; exact state and resume steps in HANDOFF.md ("EXACT STATE AT PAUSE") and `docs/RESUME-PROMPT.md`. Synapse-side wiring is Petopia-owned, code lives in Synapse commit `7d39a42`. Built: S1-S7 deployed on main `5c5d603`; review fixes unverified on branch `wip/review-fixes-s3-s7`. Open for Ryan: Q1-Q5 (spec sec 13).
