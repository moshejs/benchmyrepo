import { parseArgs } from "node:util";
import { exec, must, which } from "./exec.js";
import { BUILTIN_AGENTS, installedAgents } from "./agents.js";
import { detect } from "./detect.js";
import { mineAndValidate } from "./mine.js";
import { runBenchmark } from "./run.js";
import { computeStats, terminalTable, writeReport } from "./report.js";
import { Store } from "./store.js";

const HELP = `repobench: benchmark coding agents on your own repo's merged PRs

Usage:
  repobench init     [--source github|git] [--tasks 20] [--scan 200] [--since 2026-01-01]
                     [--test-cmd "npx vitest run {files}"] [--concurrency 4]
  repobench tasks
  repobench run      [--agents claude,codex] [--tasks 10] [--concurrency 2]
                     [--timeout 20] [--yolo] [--keep] [--resume <runId>]
  repobench report   [runId] [--open]
  repobench doctor

init    finds merged PRs that changed source + tests, and keeps the ones whose tests
        fail before the fix and pass after it, on your machine.
run     gives each agent the PR description in a clean copy of the repo at the
        pre-PR commit, then grades it with the PR's own tests.
report  writes report.html, leaderboard.svg and badge.svg for a run (latest by default).

Agents: ${BUILTIN_AGENTS.join(", ")}. Pick a model with agent:model, e.g. claude:opus.
--yolo  lets agents run any command without asking (claude bypassPermissions,
        codex without sandbox, gemini --yolo, cursor-agent --force). Off by default.
`;

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  if (cmd === "-v" || cmd === "--version") {
    const { createRequire } = await import("node:module");
    process.stdout.write(createRequire(import.meta.url)("../../package.json").version + "\n");
    return 0;
  }
  const root = await repoRoot();
  const store = new Store(root);
  switch (cmd) {
    case "init":
      return init(root, store, rest);
    case "tasks":
      return tasks(store);
    case "run":
      return run(root, store, rest);
    case "report":
      return report(store, rest);
    case "doctor":
      return doctor(root, store);
    default:
      process.stderr.write(`unknown command "${cmd}"\n\n${HELP}`);
      return 2;
  }
}

async function repoRoot(): Promise<string> {
  const r = await exec("git", ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) throw new Error("run this inside a git repository");
  return r.stdout.trim();
}

const log = (s: string) => process.stdout.write(s + "\n");

async function init(root: string, store: Store, argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string" },
      tasks: { type: "string", default: "20" },
      scan: { type: "string", default: "200" },
      since: { type: "string" },
      "test-cmd": { type: "string" },
      concurrency: { type: "string", default: "4" },
      "max-lines": { type: "string", default: "400" },
    },
  });
  store.ensure();
  let config = store.readConfig();
  if (!config || values["test-cmd"]) {
    const d = detect(root);
    config = { ...d.config, ...(config ?? {}), ...(values["test-cmd"] ? { testCommand: values["test-cmd"] } : {}) };
    if (!config.testCommand) throw new Error(`${d.why}`);
    log(`Test command: ${config.testCommand}  (${values["test-cmd"] ? "from --test-cmd" : d.why})`);
    if (config.linkDirs.length) log(`Reusing from your checkout: ${config.linkDirs.join(", ")}`);
    store.writeConfig(config);
  } else {
    log(`Test command: ${config.testCommand}  (from .repobench/config.json)`);
  }

  const source = (values.source as "github" | "git" | undefined) ?? ((await hasGithub(root)) ? "github" : "git");
  log(`Mining ${source === "github" ? "merged PRs with gh" : "first-parent commits with git"}…`);
  const { added, rejected } = await mineAndValidate(
    root,
    store,
    config,
    {
      source,
      limit: Number(values.scan),
      since: values.since,
      maxGoldLines: Number(values["max-lines"]),
      concurrency: Number(values.concurrency),
      want: Number(values.tasks),
    },
    log,
  );
  const total = store.listTasks().length;
  log("");
  log(`Added ${added.length} task(s); ${total} total in .repobench/tasks.`);
  const skipped = Object.entries(rejected).sort((a, b) => b[1] - a[1]);
  if (skipped.length) log(`Skipped: ${skipped.map(([k, v]) => `${v} ${k}`).join(", ")}`);
  if (!total) {
    log("No usable tasks. Try --scan 500, --source git, or check the test command with --test-cmd.");
    return 1;
  }
  const have = await installedAgents();
  log(`\nNext: npx repobench run --agents ${have.length ? have.join(",") : "claude"} --tasks ${Math.min(total, 10)}`);
  return 0;
}

async function hasGithub(root: string) {
  if (!(await which("gh"))) return false;
  const r = await exec("gh", ["repo", "view", "--json", "name"], { cwd: root });
  return r.code === 0;
}

function tasks(store: Store): number {
  const ts = store.listTasks();
  if (!ts.length) {
    log("No tasks yet. Run: npx repobench init");
    return 1;
  }
  for (const t of ts) log(`${t.id.padEnd(18)} ${t.mergedAt.slice(0, 10)}  ${String(t.goldLines).padStart(4)} lines  ${t.title.slice(0, 80)}`);
  log(`\n${ts.length} task(s)`);
  return 0;
}

async function run(root: string, store: Store, argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      agents: { type: "string" },
      tasks: { type: "string", default: "10" },
      concurrency: { type: "string", default: "2" },
      timeout: { type: "string", default: "20" },
      yolo: { type: "boolean", default: false },
      keep: { type: "boolean", default: false },
      resume: { type: "string" },
      only: { type: "string" },
    },
  });
  const config = store.readConfig();
  if (!config) throw new Error("no config yet. Run: npx repobench init");
  let all = store.listTasks();
  if (!all.length) throw new Error("no tasks yet. Run: npx repobench init");

  let agents: string[];
  let picked = all;
  if (values.resume) {
    const meta = store.readRunMeta(values.resume);
    agents = meta.agents;
    picked = all.filter((t) => meta.taskIds.includes(t.id));
  } else {
    agents = values.agents ? values.agents.split(",").map((s) => s.trim()).filter(Boolean) : await installedAgents();
    if (!agents.length) throw new Error(`no agent CLIs found on PATH (looked for ${BUILTIN_AGENTS.join(", ")}); pass --agents`);
    if (values.only) {
      const ids = values.only.split(",");
      picked = all.filter((t) => ids.includes(t.id));
    } else {
      picked = all.slice(0, Number(values.tasks));
    }
  }
  if (!values.yolo) log("Agents run with edit permissions only (no shell). Add --yolo to let them run commands like tests.");

  const runId = await runBenchmark(
    root,
    store,
    config,
    {
      agents,
      tasks: picked,
      concurrency: Number(values.concurrency),
      timeoutMin: Number(values.timeout),
      yolo: values.yolo!,
      keep: values.keep!,
      resumeRunId: values.resume,
    },
    log,
  );
  return report(store, [runId]);
}

async function report(store: Store, argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { open: { type: "boolean", default: false } } });
  const runId = positionals[0] ?? store.listRuns().at(-1);
  if (!runId) throw new Error("no runs yet. Run: npx repobench run");
  const meta = store.readRunMeta(runId);
  const results = store.readResults(runId);
  const files = writeReport(store.runDir(runId), meta, store.listTasks(), results);
  log("");
  log(terminalTable(computeStats(results)));
  log("");
  log(`Report:      ${files.html}`);
  log(`Share card:  ${files.card}`);
  log(`README badge: ${files.badge}`);
  if (values.open) await exec(process.platform === "darwin" ? "open" : "xdg-open", [files.html]);
  return 0;
}

async function doctor(root: string, store: Store): Promise<number> {
  log(`repo:      ${root}`);
  log(`git:       ${(await must("git", ["--version"])).trim()}`);
  log(`gh:        ${(await which("gh")) ? ((await hasGithub(root)) ? "ok, repo found on GitHub" : "installed, repo not on GitHub (will use --source git)") : "not installed (will use --source git)"}`);
  for (const a of BUILTIN_AGENTS) log(`${(a + ":").padEnd(11)}${(await which(a)) ?? "not found"}`);
  const c = store.readConfig() ?? detect(root).config;
  log(`tests:     ${c.testCommand || "not detected"}`);
  log(`tasks:     ${store.listTasks().length}`);
  return 0;
}
