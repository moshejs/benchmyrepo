// On-disk layout, all inside the user's repo under .repobench/ (git-excluded):
//   config.json            detected test command etc.
//   tasks/<id>/task.json   one validated task
//   tasks/<id>/tests.patch the PR's test changes (hidden from agents)
//   tasks/<id>/gold.patch  the PR's source changes (the reference answer)
//   runs/<runId>/results.json, report.html, leaderboard.svg, badge.svg
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

export interface Config {
  /** Shell command; `{files}` is replaced with the task's test files. */
  testCommand: string;
  /** Directories symlinked from your checkout into each workspace (node_modules, .venv…). */
  linkDirs: string[];
  /** Extra env for test runs, e.g. PYTHONPATH tweaks. `{ws}` is the workspace path. */
  testEnv: Record<string, string>;
  /** Per-test-run timeout in seconds. */
  testTimeoutSec: number;
  /** Custom agents: name -> shell command; `{prompt_file}` is replaced with the prompt path. */
  agents?: Record<string, string>;
}

export interface Task {
  id: string;
  source: "github" | "git";
  title: string;
  instruction: string;
  url?: string;
  commit: string;
  base: string;
  mergedAt: string;
  /** Test files the PR added or modified; these are what gets run. */
  testFiles: string[];
  /** Test files the PR touched that already existed at base (modified or deleted). */
  testFilesAtBase: string[];
  sourceFiles: string[];
  goldLines: number;
  validatedAt: string;
}

export interface RunResult {
  taskId: string;
  agent: string;
  passed: boolean;
  status: "passed" | "failed" | "agent_error" | "timeout" | "no_changes" | "infra_error";
  agentMs: number;
  testMs: number;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  linesChanged: number;
  note?: string;
  finishedAt: string;
}

export interface RunMeta {
  runId: string;
  repo: string;
  startedAt: string;
  agents: string[];
  taskIds: string[];
  yolo: boolean;
}

export class Store {
  readonly dir: string;
  constructor(readonly repoRoot: string) {
    this.dir = join(repoRoot, ".repobench");
  }

  ensure() {
    mkdirSync(join(this.dir, "tasks"), { recursive: true });
    mkdirSync(join(this.dir, "runs"), { recursive: true });
    // Keep .repobench out of the user's `git status` without touching their .gitignore.
    const exclude = join(this.repoRoot, ".git", "info", "exclude");
    if (existsSync(join(this.repoRoot, ".git", "info")) || existsSync(join(this.repoRoot, ".git"))) {
      try {
        mkdirSync(join(this.repoRoot, ".git", "info"), { recursive: true });
        const cur = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
        if (!cur.split("\n").includes(".repobench/")) appendFileSync(exclude, `${cur.endsWith("\n") || !cur ? "" : "\n"}.repobench/\n`);
      } catch {
        /* .git may be a file (worktree); not fatal */
      }
    }
  }

  readConfig(): Config | null {
    const p = join(this.dir, "config.json");
    return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as Config) : null;
  }

  writeConfig(c: Config) {
    this.ensure();
    writeFileSync(join(this.dir, "config.json"), JSON.stringify(c, null, 2) + "\n");
  }

  taskDir(id: string) {
    return join(this.dir, "tasks", id);
  }

  saveTask(t: Task, testsPatch: string, goldPatch: string) {
    const d = this.taskDir(t.id);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "task.json"), JSON.stringify(t, null, 2) + "\n");
    writeFileSync(join(d, "tests.patch"), testsPatch);
    writeFileSync(join(d, "gold.patch"), goldPatch);
  }

  listTasks(): Task[] {
    const root = join(this.dir, "tasks");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((id) => existsSync(join(root, id, "task.json")))
      .map((id) => JSON.parse(readFileSync(join(root, id, "task.json"), "utf8")) as Task)
      .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  }

  hasTask(id: string) {
    return existsSync(join(this.taskDir(id), "task.json"));
  }

  testsPatchPath(id: string) {
    return join(this.taskDir(id), "tests.patch");
  }

  goldPatchPath(id: string) {
    return join(this.taskDir(id), "gold.patch");
  }

  /** Record of candidates already rejected, so re-running init doesn't re-validate them. */
  readRejected(): Record<string, string> {
    const p = join(this.dir, "rejected.json");
    return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : {};
  }

  writeRejected(r: Record<string, string>) {
    writeFileSync(join(this.dir, "rejected.json"), JSON.stringify(r, null, 2) + "\n");
  }

  runDir(runId: string) {
    return join(this.dir, "runs", runId);
  }

  listRuns(): string[] {
    const root = join(this.dir, "runs");
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((r) => existsSync(join(root, r, "meta.json")))
      .sort();
  }

  writeRunMeta(m: RunMeta) {
    mkdirSync(this.runDir(m.runId), { recursive: true });
    writeFileSync(join(this.runDir(m.runId), "meta.json"), JSON.stringify(m, null, 2) + "\n");
  }

  readRunMeta(runId: string): RunMeta {
    return JSON.parse(readFileSync(join(this.runDir(runId), "meta.json"), "utf8"));
  }

  appendResult(runId: string, r: RunResult) {
    appendFileSync(join(this.runDir(runId), "results.jsonl"), JSON.stringify(r) + "\n");
  }

  readResults(runId: string): RunResult[] {
    const p = join(this.runDir(runId), "results.jsonl");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as RunResult);
  }
}
