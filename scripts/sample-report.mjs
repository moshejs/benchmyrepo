// Writes a report from made-up results so the layout can be checked with several agents.
// Usage: node scripts/sample-report.mjs <outDir>
import { mkdirSync } from "node:fs";
import { writeReport } from "../dist/src/report.js";

const out = process.argv[2] ?? "sample-report";
mkdirSync(out, { recursive: true });
const agents = [
  ["claude:opus", 0.74, 0.62, "claude-opus-5-5"],
  ["codex", 0.66, 0.41, "gpt-6.1"],
  ["claude:sonnet", 0.6, 0.21, "claude-sonnet-5-5"],
  ["gemini", 0.48, 0.18, "gemini-3-pro"],
  ["cursor-agent", 0.42, undefined, undefined],
];
const titles = [
  "Fix race in websocket reconnect backoff",
  "Support ESM config files in the CLI loader",
  "Handle empty arrays in groupBy",
  "Respect NO_COLOR in the logger",
  "Parse ISO week dates in formatDate",
  "Don't drop query params when redirecting to login",
  "Make retry() honour AbortSignal",
  "Escape backticks in generated SQL comments",
  "Fix off-by-one in pagination cursor",
  "Accept trailing slash in route matcher",
  "Cache-bust font URLs on deploy",
  "Clamp negative durations in progress bar",
];
let seed = 7;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const tasks = titles.map((title, i) => ({
  id: `pr-${1200 - i * 17}`,
  source: "github",
  title,
  instruction: "",
  url: `https://github.com/example/app/pull/${1200 - i * 17}`,
  commit: "x",
  base: "y",
  mergedAt: new Date(Date.UTC(2026, 9, 20 - i * 3)).toISOString(),
  testFiles: [],
  testFilesAtBase: [],
  sourceFiles: [],
  goldLines: 8 + Math.round(rand() * 120),
  validatedAt: "",
}));
const results = tasks.flatMap((t) =>
  agents.map(([agent, p, cost, model]) => {
    const passed = rand() < p;
    return {
      taskId: t.id,
      agent,
      passed,
      status: passed ? "passed" : rand() < 0.8 ? "failed" : "timeout",
      agentMs: 40000 + rand() * 300000,
      testMs: 4000,
      costUsd: cost === undefined ? undefined : cost * (0.5 + rand()),
      inputTokens: 150000 + rand() * 400000,
      outputTokens: 4000 + rand() * 20000,
      model,
      linesChanged: 10 + Math.round(rand() * 80),
      finishedAt: "",
    };
  }),
);
const meta = { runId: "sample-data", repo: "example-app", startedAt: "", agents: agents.map((a) => a[0]), taskIds: tasks.map((t) => t.id), yolo: true };
const files = writeReport(out, meta, tasks, results);
console.log(files.html);
