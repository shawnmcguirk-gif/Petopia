# Prompt to resume Petopia cold (any account with the `dev` folder connected)

Paste this as the first message:

> resume concept petopia petopia
>
> Then read `~/dev/Petopia/HANDOFF.md` -- the entry headed "EXACT STATE AT PAUSE" -- and `docs/reviews/2026-10-07-s3-s7-review.md`. Petopia D1 (Pets & Wildlife module of Synapse) has all v1 slices S1-S7 deployed, but an independent review said "needs fixes first". The unfinished, UNVERIFIED fixes are on branch `wip/review-fixes-s3-s7` (a5fb4ae), not on main. Follow "RESUME HERE" in order: verify the WIP branch (lint, build, tests), finish findings 1-9, 11, 12, merge, deploy through the Axiom runner (`bash`-invoke the scripts), get a fresh independent review, then ask Ryan to try it on his phone and say `verified`. Ryan already pre-approved lift/build/review/deploy for D1 (quote in the D1 receipts), so don't re-ask for those stage words; do keep the folder-read and AI-reading go-aheads off until the fixes are live. Use short bullets, not long paragraphs. End every commit message with exactly:
> Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
> Claude-Session: https://claude.ai/code/session_01Jej4GGFnwbnWN4EhhmBo1F  (or the new session's own line)

Sources of truth: `docs/specs/D1-petopia-core.md` (design), `DESIGN.md` D1 (decision), `docs/concepts/2026-10-07-petopia/` (Ryan's brief + hero images + Q&A).
