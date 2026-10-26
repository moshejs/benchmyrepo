# Progress

## Done
- Phase 1: mining (gh merged PRs or git first-parent commits), filtering (tests + source, no dependency changes, size cap), validation (fail before fix, pass with fix) in history-free workspaces.
- Phase 2: agent adapters (claude, codex, gemini, cursor-agent, custom shell agents), parallel runs, grading with the PR's own tests, resumable results.jsonl.
- Phase 3: report.html, leaderboard.svg share card, badge.svg, summary.md, terminal table. Checked at 1440px and 390px in light and dark mode.
- Phase 4 (partial): README, MIT license, `npm pack` works (25.6 kB).
- Verified: `npm test` (unit + fixture end-to-end with fake agents); real `claude` run on the fixture (2/2, $0.37); `init` on pallets/markupsafe found 3 valid tasks from 150 PRs in about 5s.

## Not verified
- codex, gemini and cursor-agent adapters (those CLIs aren't installed here). Flags come from their docs and may need adjusting.
- Real agent runs on a real third-party repo (blocked by the local auto-mode guard on running external code).

## Next
- Demo GIF for the README (asciinema/vhs of `init` + `run`).
- Install codex/gemini and run all four agents on a real repo; fix the adapters.
- (Done 2026-10-26) Published `benchmyrepo@0.1.0` to npm, tagged v0.1.0. `repobench` was taken, hence the rename. GitHub repo made public the same day.
- Ideas: `--since` defaulting per model cutoff, a GitHub Action that posts the card, flaky-test rerun during validation.
