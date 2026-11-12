// Regressions found by the first real run (pallets/click, 2026-11-12). See docs/first-run.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnv, resolveAgent } from "../src/agents.js";
import { must } from "../src/exec.js";
import { isRunnableTest } from "../src/files.js";
import { formatFunnel, isBranchSync } from "../src/mine.js";
import { captureDiff, createWorkspace, installTests } from "../src/workspace.js";
import { rankOf, renderBadge, renderCard, terminalTable, writeReport } from "../src/report.js";
import type { RunResult, Task } from "../src/store.js";

test("helpers, fixtures and type-check files next to tests are not handed to the runner", () => {
  for (const p of ["tests/test_options.py", "tests/test_types/test_Path.py", "pkg/a_test.py", "src/a.test.ts", "test/app.router.js", "test/acceptance/auth.js", "__tests__/x.tsx", "x_test.go"]) {
    assert.ok(isRunnableTest(p), p);
  }
  // click's tests/typing/*.py are mypy inputs; pytest collected them when passed explicitly.
  for (const p of ["tests/typing/typing_path.py", "tests/conftest.py", "tests/helpers.py", "test/support/env.js", "test/fixtures/a.js", "src/__snapshots__/a.test.ts.snap", "pkg/testdata/x.go"]) {
    assert.ok(!isRunnableTest(p), p);
  }
});

test("branch-sync PRs are not tasks", () => {
  assert.ok(isBranchSync({ title: "Merge stable into main", headRef: "stable" }));
  assert.ok(isBranchSync({ title: "Stable", headRef: "stable" }));
  assert.ok(isBranchSync({ title: "Release 8.3", headRef: "8.3.x" }));
  assert.ok(isBranchSync({ title: "Merge branch 'main' into feature", headRef: undefined }));
  assert.ok(!isBranchSync({ title: "Fix short help abbreviation", headRef: "fix-short-help-abbreviation" }));
  assert.ok(!isBranchSync({ title: "Merge sort: handle empty lists", headRef: "merge-sort" }));
});

test("agents don't inherit the session variables of an agent that launched benchmyrepo", () => {
  const env = agentEnv({
    PATH: "/bin",
    HOME: "/h",
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    CLAUDE_CODE_SESSION_ID: "x",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_EFFORT: "medium",
    CLAUDE_AGENT_SDK_VERSION: "1",
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_API_KEY: "k",
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: "9",
  });
  assert.deepEqual(Object.keys(env).sort(), ["ANTHROPIC_API_KEY", "CI", "CLAUDE_CODE_MAX_OUTPUT_TOKENS", "CLAUDE_CODE_USE_BEDROCK", "HOME", "NO_COLOR", "PATH"]);
});

test("claude runs without the user's personal settings and with the requested model", () => {
  const args = resolveAgent("claude:haiku").args("do it", { yolo: false });
  assert.deepEqual(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2), ["--setting-sources", "project,local"]);
  assert.ok(args.includes("--no-session-persistence"));
  assert.deepEqual(args.slice(-2), ["--model", "haiku"]);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
});

test("funnel line accounts for every candidate", () => {
  assert.equal(
    formatFunnel({ scanned: 32, known: 0, examined: 26, eligible: 14, validated: 10, notExamined: 6 }, "PRs"),
    "32 PRs scanned → 26 examined → 14 changed source + tests → 10 validated → 6 not examined (--tasks reached)",
  );
});

test("an agent that commits its work is still graded on it", async () => {
  const repo = mkdtempSync(join(tmpdir(), "bmr-commit-"));
  const ws = repo + "-ws";
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  try {
    await must("git", ["init", "-q", "-b", "main"], { cwd: repo });
    writeFileSync(join(repo, "a.py"), "x = 1\n");
    writeFileSync(join(repo, "test_a.py"), "def test_a():\n    pass\n");
    await must("git", ["add", "-A"], { cwd: repo });
    await must("git", ["commit", "-qm", "base"], { cwd: repo, env });
    await createWorkspace(repo, "HEAD", ws, { testCommand: "true", linkDirs: [], testEnv: {}, testTimeoutSec: 10 });

    // The agent edits source and a test file, then commits, as some user hooks tell it to.
    writeFileSync(join(ws, "a.py"), "x = 2\n");
    writeFileSync(join(ws, "test_a.py"), "def test_a():\n    assert True  # agent edit\n");
    await must("git", ["commit", "-qam", "agent"], { cwd: ws, env });

    const diff = await captureDiff(ws);
    assert.match(diff.patch, /\+x = 2/);
    assert.ok(diff.lines >= 2);

    // The hidden test patch applies on top of the base version of the test file, not the agent's.
    const task = { testFiles: ["test_a.py"], testFilesAtBase: ["test_a.py"] } as Task;
    const testsPatch = "--- a/test_a.py\n+++ b/test_a.py\n@@ -1,2 +1,2 @@\n def test_a():\n-    pass\n+    assert 1\n";
    await installTests(ws, task, testsPatch);
    assert.equal(readFileSync(join(ws, "test_a.py"), "utf8"), "def test_a():\n    assert 1\n");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
  }
});

test("the card counts the run's tasks, not every task on disk", () => {
  const dir = mkdtempSync(join(tmpdir(), "bmr-card-"));
  try {
    const task = (id: string) => ({ id, title: id, mergedAt: "2026-11-01T00:00:00Z", goldLines: 1 }) as Task;
    const r = (taskId: string, agent: string, passed: boolean): RunResult => ({ taskId, agent, passed, status: passed ? "passed" : "failed", agentMs: 1, testMs: 1, linesChanged: 1, finishedAt: "" });
    const meta = { runId: "r", repo: "x", startedAt: "2026-11-12T10:00:00Z", agents: ["a"], taskIds: ["t1", "t2"], yolo: false, tool: "0.1.0", agentVersions: { claude: "2.1.310 (Claude Code)" } };
    const files = writeReport(dir, meta, [task("t1"), task("t2"), task("t3"), task("t4")], [r("t1", "a", true), r("t2", "a", false)]);
    assert.match(readFileSync(files.card, "utf8"), /BENCHMYREPO · 2 REAL PRS/);
    assert.match(readFileSync(files.html, "utf8"), /benchmyrepo 0\.1\.0, <code>claude<\/code> 2\.1\.310 \(Claude Code\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tie is shown as a tie on the card, the badge and the table", () => {
  const st = (agent: string, solved: number, costUsd: number) => ({ agent, solved, attempted: 8, rate: solved / 8, costUsd, medianMs: 1 });
  const stats = [st("claude:sonnet", 2, 0.89), st("claude:opus", 2, 2.94), st("claude:haiku", 0, 0.1)];
  assert.deepEqual(stats.map((_, i) => rankOf(stats, i)), [1, 1, 3]);
  assert.match(renderBadge(stats), /claude:sonnet, claude:opus 25%/);
  const card = renderCard({ runId: "r", repo: "click", startedAt: "", agents: [], taskIds: [], yolo: false }, stats, 8);
  assert.equal(card.match(/class="bar lead"/g)?.length, 2);
  assert.equal(card.match(/class="rank">1</g)?.length, 2);
  assert.match(terminalTable(stats), /^1 +claude:opus/m);
  // Nobody solved anything: no leader is highlighted.
  const none = [st("a", 0, 1), st("b", 0, 2)];
  assert.equal(renderCard({ runId: "r", repo: "x", startedAt: "", agents: [], taskIds: [], yolo: false }, none, 8).match(/bar lead/g), null);
});
