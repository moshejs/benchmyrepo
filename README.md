# repobench

**Which coding agent is actually best on _your_ code?** Public leaderboards measure someone else's repo. repobench takes your repo's own merged PRs, gives each one to the agents you already have installed, and grades them with the tests that shipped with the PR.

```bash
npx repobench init        # turn merged PRs into tasks
npx repobench run         # run every installed agent on them
```

```
#  agent          solved  rate  cost    $/solve  median
1  codex          8/12    67%   $5.13   $0.64    2.8m
2  claude:opus    8/12    67%   $6.91   $0.86    3.1m
3  gemini         7/12    58%   $2.16   $0.31    2.2m
```
<sub>Example output. Your numbers come from your repo.</sub>

You get a single-file `report.html`, a `leaderboard.svg` card to share, and a `badge.svg` for your README.

## Why it's different

- **Local, one command.** It runs in your dev environment, where your tests already pass. No accounts, no Docker images, no cloud.
- **Uses the agents you already pay for.** It drives `claude`, `codex`, `gemini` and `cursor-agent` in headless mode on your existing plans. You don't need API keys.
- **Graded by your real tests.** There's no LLM judge and no AI-written tests. A task counts only if the PR's tests **fail before** the fix and **pass with** the original fix on your machine.
- **No peeking.** Each agent works in a throwaway copy of the repo at the pre-PR commit, with no git history, so it can't look up the answer.
- **Your code stays on your machine.** It goes only to the agents you choose.

## How it works

1. **Mine.** It reads merged PRs with `gh` (or first-parent commits with `--source git`). It keeps PRs that change both source and test files, don't touch dependency manifests, and have a fix under 400 lines.
2. **Validate.** For each candidate, it makes a clean copy at the base commit, adds the PR's tests, and checks that they fail. Then it applies the PR's fix and checks that they pass.
3. **Run.** Each agent gets only the PR title, description and linked issues, with pasted diffs removed. It runs in its own copy.
4. **Grade.** The PR's test files are restored to their merged versions and run. Pass or fail is all that counts.

## Commands

```bash
npx repobench init   [--tasks 20] [--scan 200] [--since 2026-01-01] [--source github|git] [--test-cmd "…{files}"]
npx repobench tasks
npx repobench run    [--agents claude,claude:haiku,codex] [--tasks 10] [--concurrency 2] [--timeout 20] [--yolo]
npx repobench report [runId] [--open]
npx repobench doctor
```

- `agent:model` picks a model, for example `claude:opus` or `codex:gpt-5.5`.
- `--yolo` lets agents run shell commands such as your test suite without asking. Without it, Claude runs with edit permissions only, Codex runs in its workspace sandbox, and Gemini auto-approves edits only. Agents run on your machine, so only use `--yolo` on code you trust.
- `--resume <runId>` continues an interrupted run.

### Custom agents

Add any CLI to `.repobench/config.json`:

```json
{ "agents": { "aider": "aider --yes-always --message-file {prompt_file}" } }
```

## Supported today

| | |
|---|---|
| Test runners | vitest, jest, mocha, `npm test`, `node --test`, pytest, `go test`, `cargo test` (or any command via `--test-cmd`) |
| Agents | Claude Code (tested), Codex, Gemini CLI, cursor-agent (adapters written, not yet tested against live CLIs), custom |
| Platforms | macOS, Linux; Node 20+ |

## Limitations

- PRs without tests can't become tasks. On many repos, most PRs get skipped (dependency bumps, docs).
- Public repos may be in a model's training data. Use `--since` to keep only PRs merged after a model's cutoff.
- Monorepos with per-package dependencies work if their `node_modules` are installed. PRs that change dependencies are skipped.
- Git submodules aren't copied into workspaces.

## Develop

```bash
npm install
npm test          # unit tests + an end-to-end run on a fixture repo with fake agents
```

MIT
