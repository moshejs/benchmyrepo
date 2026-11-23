# Progress

## Done
- Phase 1: mining (gh merged PRs or git first-parent commits), filtering (tests + source, no dependency changes, size cap), validation (fail before fix, pass with fix) in history-free workspaces.
- Phase 2: agent adapters (claude, codex, gemini, cursor-agent, custom shell agents), parallel runs, grading with the PR's own tests, resumable results.jsonl.
- Phase 3: report.html, leaderboard.svg share card, badge.svg, summary.md, terminal table. Checked at 1440px and 390px in light and dark mode.
- Phase 4 (partial): README, MIT license, `npm pack` works (25.6 kB).
- Verified: `npm test` (unit + fixture end-to-end with fake agents); real `claude` run on the fixture (2/2, $0.37); `init` on pallets/markupsafe found 3 valid tasks from 150 PRs in about 5s.

- (2026-11-12) First real run on a third-party repo: pallets/click, 8 tasks, claude:opus/sonnet/haiku. Sonnet 2/8, Opus 2/8, Haiku 0/8, $3.93 reported. All 24 grades re-checked by hand. Seven bugs found and fixed (branch-merge PRs, helper files run as tests, inherited session env, user Claude settings, commits hiding the diff, card task count, ties shown as wins). Added CI. See docs/first-run.md.

- (2026-11-23) GitHub Action (`action.yml`, `examples/benchmyrepo.yml`): daily npm release check for claude/codex/gemini, bench on a new release or by hand, README block + card committed by github-actions[bot]. New `readme` command. Tests no longer see agent credentials. Tested locally only: unit tests, actionlint + shellcheck, and the action's steps end to end on throwaway repos with fake agents.

## Not verified
- codex, gemini and cursor-agent adapters (those CLIs aren't installed here). Flags come from their docs and may need adjusting.
- Repeat runs (variance) and runs with `--yolo` on a real repo.
- Fixes since 0.1.0 are unreleased on npm.
- The GitHub Action has never run on GitHub (Actions billing is blocked on the owner's account), and never with a real agent in CI.

## Next
- Demo GIF for the README (asciinema/vhs of `init` + `run`).
- Install codex/gemini and run all four agents on a real repo; fix the adapters.
- (Done 2026-10-26) Published `benchmyrepo@0.1.0` to npm, tagged v0.1.0. `repobench` was taken, hence the rename. GitHub repo made public the same day.
- Ideas: `--since` defaulting per model cutoff, flaky-test rerun during validation.
- Run the GitHub Action on GitHub once billing is fixed: a dispatch on a small repo with `claude:haiku`, then tag a release so consumers can pin its SHA.
