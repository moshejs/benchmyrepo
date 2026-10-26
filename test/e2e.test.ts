// End to end on a fixture repo: mine → validate → run fake agents → report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { detect } from "../src/detect.js";
import { mineAndValidate } from "../src/mine.js";
import { runBenchmark } from "../src/run.js";
import { writeReport } from "../src/report.js";
import { Store } from "../src/store.js";
import { exec } from "../src/exec.js";
import { makeFixture, writeFakeAgent } from "./fixture.js";

const hasPytest = (await exec("python3", ["-m", "pytest", "--version"])).code === 0;

test("mines, validates, runs and reports on a fixture repo", { skip: !hasPytest && "pytest not installed", timeout: 120_000 }, async () => {
  const repo = await makeFixture();
  try {
    const store = new Store(repo);
    store.ensure();
    const d = detect(repo);
    assert.equal(d.language, "python");
    const config = { ...d.config, agents: { fake: `python3 ${writeFakeAgent(repo + "-agent")} {prompt_file}`, noop: "true" } };
    store.writeConfig(config);

    const quiet = () => {};
    const { added, rejected } = await mineAndValidate(repo, store, config, { source: "git", limit: 50, maxGoldLines: 400, concurrency: 2, want: 10 }, quiet);
    assert.deepEqual(added.map((t) => t.title).sort(), ["Add subtract()", "divide() should raise ValueError on zero"]);
    assert.equal(rejected["no test changes"], 1, "README commit");
    assert.equal(rejected["tests already pass without the fix"], 1, "docstring commit");
    assert.equal(rejected["changes dependencies"], 1, "pyproject bump");
    assert.equal(rejected["root commit"], 1);

    // Agents must not be able to see the fix in git history.
    const divide = store.listTasks().find((t) => t.title.startsWith("divide"))!;
    assert.deepEqual(divide.testFilesAtBase, ["tests/test_calc.py"]);
    assert.match(divide.instruction, /should raise ValueError/);

    // Re-running init is idempotent.
    const again = await mineAndValidate(repo, store, config, { source: "git", limit: 50, maxGoldLines: 400, concurrency: 2, want: 10 }, quiet);
    assert.equal(again.added.length, 0);

    const runId = await runBenchmark(repo, store, config, { agents: ["fake", "noop"], tasks: store.listTasks(), concurrency: 2, timeoutMin: 1, yolo: false, keep: false }, quiet);
    const results = store.readResults(runId);
    const get = (agent: string, title: string) => results.find((r) => r.agent === agent && store.listTasks().find((t) => t.id === r.taskId)!.title.startsWith(title))!;
    assert.equal(get("fake", "Add subtract").status, "passed");
    assert.equal(get("fake", "divide").status, "failed");
    assert.equal(get("noop", "Add subtract").status, "no_changes");
    assert.ok(existsSync(join(store.runDir(runId), "logs")));

    const files = writeReport(store.runDir(runId), store.readRunMeta(runId), store.listTasks(), results);
    const html = readFileSync(files.html, "utf8");
    assert.match(html, /<em>fake<\/em> solves 50%/);
    assert.match(readFileSync(files.badge, "utf8"), /fake 50%/);
    assert.match(readFileSync(files.card, "utf8"), /Which agent fixes/);

    // The user's checkout is untouched apart from the git-excluded .repobench dir.
    const status = await exec("git", ["status", "--porcelain"], { cwd: repo });
    assert.equal(status.stdout.trim(), "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(repo + "-agent", { recursive: true, force: true });
  }
});
