# Progress

## Done
- Phase 1: mining (gh merged PRs or git first-parent commits), filtering (tests + source, no dependency changes, size cap), validation (fail before fix, pass with fix) in history-free workspaces.
- Phase 2: agent adapters (claude, codex, gemini, cursor-agent, custom shell agents), parallel runs, grading with the PR's own tests, resumable results.jsonl.
- Phase 3: report.html, leaderboard.svg share card, badge.svg, summary.md, terminal table.
- Tests: unit + fixture end-to-end with fake agents (`npm test`).

## Next
- Real-agent run on a real repo (only `claude` is installed on this machine; codex/gemini/cursor-agent adapters are untested).
- Browser check of report.html at 1440px and 390px.
- Phase 4: README with demo, npm publish, private GitHub repo.
