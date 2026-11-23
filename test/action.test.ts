// The GitHub Action's pieces: the README block, the release check and the CI guards.
// Runs on the recorded run in test/fixtures/recorded-run (made-up results), so no agent is called.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { END, MarkerError, START, readRunDir, renderBlock, replaceBlock, unusableAgents, updateReadme } from "../src/readme.js";
import { agentBases, changedAgents, installSpecs, latestVersions, main as actionMain, parseVersions, tracked } from "../src/action.js";
import { testEnv } from "../src/workspace.js";
import type { RunResult } from "../src/store.js";

const RECORDED = fileURLToPath(new URL("../../test/fixtures/recorded-run", import.meta.url));

const tmp = () => mkdtempSync(join(tmpdir(), "bmr-action-"));

test("the block goes between the markers and nothing else changes", () => {
  const readme = `# app\n\nIntro.\n\n${START}\nold stuff\n${END}\n\n## Install\n`;
  const { text, changed } = replaceBlock(readme, "NEW\nBLOCK\n");
  assert.ok(changed);
  assert.equal(text, `# app\n\nIntro.\n\n${START}\nNEW\nBLOCK\n${END}\n\n## Install\n`);
});

test("replacing with the same block is a no-op", () => {
  const first = replaceBlock(`a\n${START}\n${END}\nb\n`, "card").text;
  const again = replaceBlock(first, "card");
  assert.equal(again.changed, false);
  assert.equal(again.text, first);
});

test("missing markers fail with the lines to add, instead of guessing a spot", () => {
  assert.throws(() => replaceBlock("# app\n", "x"), (e: Error) => e instanceof MarkerError && e.message.includes(START) && e.message.includes(END));
});

test("malformed markers are refused", () => {
  const cases = [
    `${START}\nonly a start\n`,
    `only an end\n${END}\n`,
    `${END}\nbackwards\n${START}\n`,
    `${START}\n${START}\n${END}\n`,
    `${START}\n${END}\n${START}\n${END}\n`,
  ];
  for (const c of cases) assert.throws(() => replaceBlock(c, "x"), MarkerError, JSON.stringify(c));
});

test("markers shown inside a code fence are documentation, not the slot", () => {
  const docs = "Add these lines:\n\n```markdown\n" + `${START}\n${END}\n` + "```\n";
  assert.throws(() => replaceBlock(docs, "x"), MarkerError);
  const { text } = replaceBlock(docs + `\n${START}\n${END}\n`, "card");
  assert.ok(text.startsWith(docs), "the fenced example is untouched");
  assert.ok(text.endsWith(`${START}\ncard\n${END}\n`));
});

test("markers may be indented and the file's CRLF line endings are kept", () => {
  const { text } = replaceBlock(`a\r\n  ${START}\r\n${END}  \r\nb\r\n`, "one\ntwo");
  assert.equal(text, `a\r\n${START}\r\none\r\ntwo\r\n${END}\r\nb\r\n`);
});

test("README and card are written once, then left alone for the same run", () => {
  const dir = tmp();
  try {
    const readmePath = join(dir, "README.md");
    const cardPath = join(dir, ".github", "benchmyrepo", "leaderboard.svg");
    writeFileSync(readmePath, `# example-app\n\n${START}\n${END}\n`);
    const run = readRunDir(RECORDED);
    const first = updateReadme({ ...run, readmePath, cardPath, allowErrors: false });
    assert.deepEqual([first.readmeChanged, first.cardChanged], [true, true]);
    const readme = readFileSync(readmePath, "utf8");
    const card = readFileSync(cardPath, "utf8");
    assert.match(readme, /\[!\[benchmyrepo leaderboard for example-app\]\(\.github\/benchmyrepo\/leaderboard\.svg\)\]/);
    assert.match(card, /4 REAL PRS/);

    const second = updateReadme({ ...run, readmePath, cardPath });
    assert.deepEqual([second.readmeChanged, second.cardChanged], [false, false]);
    assert.equal(readFileSync(readmePath, "utf8"), readme);
    assert.equal(readFileSync(cardPath, "utf8"), card);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the block states the sample, the errors and the versions, and claims no winner", () => {
  const { meta, results } = readRunDir(RECORDED);
  const block = renderBlock(meta, results, "card.svg");
  assert.match(block, /\| 1 \| claude:sonnet \(claude-sonnet-5-5\) \| 2\/4 \| 50% \| \$0\.67 \|/);
  assert.match(block, /\| 2 \| claude:haiku \(claude-haiku-5-5\) \| 1\/4 \| 25% \|/);
  assert.match(block, /One run on 4 merged PRs from this repo, started 2026-11-20 06:00 UTC/);
  assert.match(block, /1 attempt ended in an agent or setup error and 1 timed out; they count as unsolved\./);
  assert.match(block, /Cost is what each agent CLI reports, not a bill\./);
  assert.match(block, /4 tasks is a small sample/);
  assert.match(block, /Agents could edit files but not run commands\./);
  assert.match(block, /Versions: benchmyrepo 0\.1\.0, `claude` 2\.1\.330 \(Claude Code\)\./);
  assert.doesNotMatch(block, /\b(best|winner|wins)\b/i);
});

test("agent names can't break the table", () => {
  const r: RunResult = { taskId: "t", agent: "my|agent<x>", passed: true, status: "passed", agentMs: 1, testMs: 1, linesChanged: 1, finishedAt: "" };
  const block = renderBlock({ runId: "r", repo: "x", startedAt: "", agents: [], taskIds: [], yolo: false }, [r], "c.svg");
  assert.match(block, /\| my\\\|agent\\<x\\> \|/);
});

test("an agent that only errored blocks the card, and nothing is written", () => {
  const dir = tmp();
  try {
    const readmePath = join(dir, "README.md");
    const cardPath = join(dir, "card.svg");
    const before = `${START}\n${END}\n`;
    writeFileSync(readmePath, before);
    const { meta, results } = readRunDir(RECORDED);
    const broken = [...results.filter((r) => r.agent !== "claude:haiku"), ...results.filter((r) => r.agent === "claude:haiku").map((r) => ({ ...r, passed: false, status: "agent_error" as const }))];
    assert.deepEqual(unusableAgents(broken), ["claude:haiku"]);
    assert.throws(() => updateReadme({ meta, results: broken, readmePath, cardPath }), /claude:haiku/);
    assert.equal(readFileSync(readmePath, "utf8"), before);
    assert.equal(existsSync(cardPath), false);
    assert.deepEqual(unusableAgents(results), [], "one error among real attempts is fine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a README without markers fails before the card is written", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "README.md"), "# no markers\n");
    const run = readRunDir(RECORDED);
    assert.throws(() => updateReadme({ ...run, readmePath: join(dir, "README.md"), cardPath: join(dir, "card.svg") }), MarkerError);
    assert.equal(existsSync(join(dir, "card.svg")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release checks cover the npm-published agents only", () => {
  assert.deepEqual(agentBases("claude:sonnet, claude:opus,codex,cursor-agent,aider"), ["claude", "codex", "cursor-agent", "aider"]);
  assert.deepEqual(tracked(["claude", "codex", "gemini", "cursor-agent", "aider"]), { tracked: ["claude", "codex", "gemini"], untracked: ["cursor-agent", "aider"] });
});

test("latest versions come from the registry's latest tag", async () => {
  const urls: string[] = [];
  const fake = async (url: string) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => ({ version: url.includes("codex") ? "0.171.0" : "2.1.330" }) };
  };
  const v = await latestVersions(["claude", "codex", "cursor-agent"], fake);
  assert.deepEqual(v, { claude: "2.1.330", codex: "0.171.0" });
  assert.deepEqual(urls, ["https://registry.npmjs.org/@anthropic-ai%2fclaude-code/latest", "https://registry.npmjs.org/@openai%2fcodex/latest"]);

  await assert.rejects(latestVersions(["claude"], async () => ({ ok: false, status: 503, json: async () => ({}) })), /HTTP 503/);
  await assert.rejects(latestVersions(["claude"], async () => ({ ok: true, status: 200, json: async () => ({ version: "1.0.0 && curl x" }) })), /no usable "version"/);
});

test("a release the card wasn't made with triggers a run", () => {
  assert.deepEqual(changedAgents({ claude: "2.1.330", codex: "0.171.0" }, { claude: "2.1.330", codex: "0.170.0" }), ["codex"]);
  assert.deepEqual(changedAgents({ claude: "2.1.330" }, {}), ["claude"]);
  assert.deepEqual(changedAgents({ claude: "2.1.330" }, { claude: "2.1.330" }), []);
});

test("versions passed between jobs are validated before they reach npm install", () => {
  assert.deepEqual(installSpecs(["claude", "codex", "cursor-agent"], parseVersions('{"claude":"2.1.330"}')), ["@anthropic-ai/claude-code@2.1.330", "@openai/codex@latest"]);
  assert.throws(() => parseVersions('{"claude":"2.1.330 --registry=http://evil"}'), /invalid version/);
  assert.throws(() => parseVersions('{"left-pad":"1.0.0"}'), /unknown agent/);
  assert.throws(() => parseVersions("[]"), /JSON object/);
  assert.deepEqual(parseVersions(""), {});
});

test("the attempt guard refuses runs over max-attempts", async () => {
  await assert.rejects(actionMain(["guard", "--agents", "claude:sonnet,claude:opus,codex", "--tasks", "10", "--max-attempts", "20"]), /30 attempts, over max-attempts \(20\)/);
  assert.equal(await actionMain(["guard", "--agents", "claude:sonnet", "--tasks", "5", "--max-attempts", "20"]), 0);
  await assert.rejects(actionMain(["guard", "--agents", "", "--tasks", "5", "--max-attempts", "20"]), /set the agents input/);
  await assert.rejects(actionMain(["guard", "--agents", "claude", "--tasks", "2.5", "--max-attempts", "20"]), /positive whole number/);
});

test("the versions state file is stable, so an unchanged release leaves no diff", async () => {
  const dir = tmp();
  try {
    const state = join(dir, "agent-versions.json");
    await actionMain(["save", "--versions", '{"codex":"0.171.0","claude":"2.1.330"}', "--state", state]);
    const first = readFileSync(state, "utf8");
    assert.equal(first, '{\n  "claude": "2.1.330",\n  "codex": "0.171.0"\n}\n');
    await actionMain(["save", "--versions", '{"claude":"2.1.330","codex":"0.171.0"}', "--state", state]);
    assert.equal(readFileSync(state, "utf8"), first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tests never see the agents' credentials", () => {
  const env = testEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "a", CLAUDE_CODE_OAUTH_TOKEN: "b", CODEX_API_KEY: "c", OPENAI_API_KEY: "d", GEMINI_API_KEY: "e", PYTHONPATH: "x" });
  assert.deepEqual(Object.keys(env).sort(), ["CI", "FORCE_COLOR", "NO_COLOR", "PATH", "PYTHONPATH"]);
});
