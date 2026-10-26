import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPrompt, resolveAgent, runAgent, setPromptDir, type AgentSpec } from "./agents.js";
import { pool, tail } from "./exec.js";
import type { Config, RunResult, Store, Task } from "./store.js";
import { captureDiff, createWorkspace, installTests, removeWorkspace, runTests } from "./workspace.js";

export interface RunOptions {
  agents: string[];
  tasks: Task[];
  concurrency: number;
  timeoutMin: number;
  yolo: boolean;
  keep: boolean;
  resumeRunId?: string;
}

export function newRunId(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
}

export async function runBenchmark(repoRoot: string, store: Store, config: Config, o: RunOptions, log: (s: string) => void): Promise<string> {
  const specs = o.agents.map((a) => resolveAgent(a, config.agents));
  const runId = o.resumeRunId ?? newRunId();
  const runDir = store.runDir(runId);
  mkdirSync(join(runDir, "logs"), { recursive: true });
  setPromptDir(join(runDir, "logs"));

  const done = new Set(store.readResults(runId).map((r) => `${r.taskId}|${r.agent}`));
  if (!o.resumeRunId) {
    store.writeRunMeta({
      runId,
      repo: repoRoot.split("/").pop() ?? repoRoot,
      startedAt: new Date().toISOString(),
      agents: o.agents,
      taskIds: o.tasks.map((t) => t.id),
      yolo: o.yolo,
    });
  }

  const jobs = o.tasks.flatMap((t) => specs.map((s) => ({ task: t, spec: s }))).filter((j) => !done.has(`${j.task.id}|${j.spec.label}`));
  log(`Run ${runId}: ${o.tasks.length} task(s) × ${specs.length} agent(s) = ${jobs.length} job(s), ${o.concurrency} at a time.`);

  let finished = 0;
  await pool(jobs, o.concurrency, async ({ task, spec }) => {
    const r = await runOne(repoRoot, store, config, task, spec, o, runDir);
    store.appendResult(runId, r);
    finished++;
    const mark = r.passed ? "✓" : "✗";
    const cost = r.costUsd !== undefined ? ` $${r.costUsd.toFixed(2)}` : "";
    log(`  [${finished}/${jobs.length}] ${mark} ${spec.label.padEnd(14)} ${task.id.padEnd(16)} ${r.status} ${(r.agentMs / 1000).toFixed(0)}s${cost}`);
  });
  return runId;
}

async function runOne(repoRoot: string, store: Store, config: Config, task: Task, spec: AgentSpec, o: RunOptions, runDir: string): Promise<RunResult> {
  const slug = `${task.id}__${spec.label.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  const ws = join(tmpdir(), "benchmyrepo", "runs", `${slug}-${process.pid}`);
  const logPath = join(runDir, "logs", `${slug}.log`);
  const base = { taskId: task.id, agent: spec.label, agentMs: 0, testMs: 0, linesChanged: 0 };
  const finish = (r: Omit<RunResult, "finishedAt">): RunResult => ({ ...r, finishedAt: new Date().toISOString() });
  try {
    await createWorkspace(repoRoot, task.base, ws, config);
    const prompt = buildPrompt(task.instruction);
    const { result, usage } = await runAgent(spec, prompt, ws, { yolo: o.yolo, timeoutMs: o.timeoutMin * 60_000 });
    const meta = { agentMs: result.durationMs, costUsd: usage.costUsd, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, model: usage.model };
    const diff = await captureDiff(ws);
    writeFileSync(join(runDir, "logs", `${slug}.patch`), diff.patch);
    let logText = `$ ${spec.bin} …\nexit ${result.code}${result.timedOut ? " (timeout)" : ""}\n\n--- stdout ---\n${tail(result.stdout, 20000)}\n--- stderr ---\n${tail(result.stderr, 8000)}\n`;

    if (result.timedOut) return finish({ ...base, ...meta, linesChanged: diff.lines, passed: false, status: "timeout", note: `agent exceeded ${o.timeoutMin} min` });
    if (result.code === 127) {
      writeFileSync(logPath, logText);
      return finish({ ...base, ...meta, passed: false, status: "agent_error", note: `could not start ${spec.bin}` });
    }
    if (diff.lines === 0) {
      writeFileSync(logPath, logText);
      return finish({ ...base, ...meta, passed: false, status: result.code === 0 ? "no_changes" : "agent_error", note: usage.error ?? tail(result.stderr, 200) });
    }

    await installTests(ws, task, readFileSync(store.testsPatchPath(task.id), "utf8"));
    const t = await runTests(ws, config, task);
    logText += `\n--- tests (exit ${t.code}${t.timedOut ? ", timeout" : ""}) ---\n${tail(t.stdout + t.stderr, 12000)}\n`;
    writeFileSync(logPath, logText);
    const passed = t.code === 0 && !t.timedOut;
    return finish({ ...base, ...meta, linesChanged: diff.lines, testMs: t.durationMs, passed, status: passed ? "passed" : "failed" });
  } catch (e) {
    writeFileSync(logPath, String((e as Error).stack ?? e));
    return finish({ ...base, passed: false, status: "infra_error", note: String((e as Error).message ?? e).slice(0, 300) });
  } finally {
    if (!o.keep) removeWorkspace(ws);
  }
}
