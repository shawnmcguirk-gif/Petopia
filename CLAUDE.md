# Petopia — read this first

This is the Petopia project. Scaffolded 2026-10-07 via Axiom's D14 new-project
convention (`~/dev/Axiom/kit/new-project.mjs`) — this file is the canonical
house-rules file for AI sessions working here. `AGENTS.md` is a one-line
pointer to this file, not a second rules file (Axiom D14 §2) — put any rule
you'd have put in AGENTS.md here instead.

## House rules

See `~/dev/Axiom/kit/CONVENTIONS.md` for the shared session/logging/pipeline
conventions every project follows (request the Axiom folder if it isn't
mounted in this session). This file below carries only what's genuinely
local to Petopia. Which CONVENTIONS version this project was last synced
against lives in `PROJECT.yaml` (`conventions_version`) and nowhere else --
never cite a version number here (CONVENTIONS sec 22).

## Local to this project

1. Read `HANDOFF.md` (root of this folder) — the running work log, newest
   first. If it grows large, move superseded entries into
   `HANDOFF-HISTORY.md` rather than letting this file regrow (the Agentle
   343KB lesson, 2026-08-10).
2. Read `DESIGN.md` if the task touches an architecture or policy decision
   for this project.
3. Read `ACTIONS.md` at the root per the shared session-start protocol
   (CONVENTIONS.md §1).
4. Briefs and specs go in `docs/specs/`; concept folders in
   `docs/concepts/<date>-<slug>/` (the concept skill's per-project home).

End of session: update `HANDOFF.md` (state + anything still owed), and tick
`DESIGN.md` stage tags for anything that moved stage this session — in the
same session it moved, dated (CONVENTIONS.md §§2, 6).

This file is a stub scaffold — extend it with this project's own real
conventions as they emerge, the way Agentle's `CLAUDE.md` grew from a
similar starting point.

### Two sessions at once, and going live (CONVENTIONS sec 38)

Two sessions may work here at once. Follow CONVENTIONS sec 38: say which piece of work you're on
(D-number, or quick fix); commit only your own files, by name, with the D-number (or `quick:`) in
the commit subject; add handoff entries only at the top, re-reading first; and before any deploy,
show the person every app commit since the last live one that isn't yours, and ask whether any other
session is working here right now or stopped partway through.

**Live is served straight from this folder:** the engine on the iMac serves `web/dist` from
here, so a web build is live at once. There is no deploy job yet: build only from a clean worktree
of your own commit, by hand, after the check above.
