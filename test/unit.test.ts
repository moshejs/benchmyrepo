import { test } from "node:test";
import assert from "node:assert/strict";
import { isManifest, isTestFile, parseNameStatus, splitChanges } from "../src/files.js";
import { composeInstruction } from "../src/mine.js";
import { computeStats, renderBadge } from "../src/report.js";
import { newRunId } from "../src/run.js";
import { testCommandFor } from "../src/workspace.js";
import type { RunResult, Task } from "../src/store.js";

test("classifies test files across ecosystems", () => {
  for (const p of ["src/__tests__/a.ts", "a.test.tsx", "lib/b.spec.mjs", "tests/test_x.py", "pkg/x_test.go", "conftest.py", "spec/a_spec.rb"]) {
    assert.ok(isTestFile(p), p);
  }
  for (const p of ["src/testing.ts", "contest.py", "src/latest.js"]) assert.ok(!isTestFile(p), p);
});

test("detects dependency manifests", () => {
  assert.ok(isManifest("package.json"));
  assert.ok(isManifest("apps/web/pnpm-lock.yaml"));
  assert.ok(isManifest("requirements-dev.txt"));
  assert.ok(!isManifest("src/package.ts"));
});

test("splits a PR's changes and expands renames", () => {
  const changes = parseNameStatus("M\tsrc/a.ts\nA\tsrc/a.test.ts\nR100\told.md\tdocs/new.md\nM\tpackage.json\n");
  const s = splitChanges(changes);
  assert.deepEqual(s.source.map((c) => c.path), ["src/a.ts"]);
  assert.deepEqual(s.tests.map((c) => c.path), ["src/a.test.ts"]);
  assert.equal(s.manifests.length, 1);
  assert.equal(s.docs.length, 2);
});

test("instructions drop HTML comments, sign-offs and pasted diffs", () => {
  const out = composeInstruction(
    { title: "Fix thing", body: "<!-- template -->Do X.\n\n```diff\n- a\n+ b\n```\nSigned-off-by: me <m@x>" },
    [{ number: 7, title: "Thing broken", body: "Steps…" }],
  );
  assert.match(out, /^# Fix thing/);
  assert.match(out, /Do X\./);
  assert.doesNotMatch(out, /template|Signed-off|\+ b/);
  assert.match(out, /Related issue #7: Thing broken/);
});

test("test command substitution quotes files and derives Go packages", () => {
  const task = { testFiles: ["a b/x_test.go", "pkg/y_test.go", "__snapshots__/s.snap"] } as Task;
  const cfg = { testCommand: "go test {pkgs} # {files}", linkDirs: [], testEnv: {}, testTimeoutSec: 1 };
  assert.equal(testCommandFor(cfg, task), "go test './a b' ./pkg # 'a b/x_test.go' pkg/y_test.go");
});

test("stats rank by solve rate, then cost", () => {
  const r = (agent: string, passed: boolean, costUsd?: number): RunResult => ({
    taskId: "t",
    agent,
    passed,
    status: passed ? "passed" : "failed",
    agentMs: 1000,
    testMs: 1,
    costUsd,
    linesChanged: 1,
    finishedAt: "",
  });
  const s = computeStats([r("a", true, 2), r("a", false, 2), r("b", true, 1), r("b", false, 1), r("c", true), r("c", true)]);
  assert.deepEqual(s.map((x) => x.agent), ["c", "b", "a"]);
  assert.equal(s[0].rate, 1);
  assert.equal(s[1].costPerSolve, 2);
});

test("badge shows the leader and escapes text", () => {
  const svg = renderBadge({ agent: "claude<x>", solved: 7, attempted: 10, rate: 0.7, medianMs: 0 });
  assert.match(svg, /claude&lt;x&gt; 70%/);
  assert.match(svg, /#2e8540/);
});

test("run ids sort chronologically", () => {
  assert.equal(newRunId(new Date("2026-10-25T09:08:07.123Z")), "2026-10-25_09-08-07");
});
