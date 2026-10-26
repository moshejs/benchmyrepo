// Turning merged PRs (or first-parent commits) into validated benchmark tasks.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, must, pool, tail } from "./exec.js";
import { parseNameStatus, splitChanges } from "./files.js";
import type { Config, Store, Task } from "./store.js";
import { applyPatch, createWorkspace, installTests, removeWorkspace, runTests } from "./workspace.js";

export interface Candidate {
  id: string;
  source: "github" | "git";
  title: string;
  body: string;
  url?: string;
  commit: string;
  mergedAt: string;
  issueNumbers: number[];
}

export interface MineOptions {
  source: "github" | "git";
  limit: number;
  since?: string;
  maxGoldLines: number;
}

export async function listCandidates(repoRoot: string, opts: MineOptions): Promise<Candidate[]> {
  const list = opts.source === "github" ? await githubCandidates(repoRoot, opts.limit) : await gitCandidates(repoRoot, opts.limit);
  return opts.since ? list.filter((c) => c.mergedAt >= opts.since!) : list;
}

async function githubCandidates(repoRoot: string, limit: number): Promise<Candidate[]> {
  const fields = "number,title,body,mergeCommit,mergedAt,url";
  let r = await exec("gh", ["pr", "list", "--state", "merged", "--limit", String(limit), "--json", `${fields},closingIssuesReferences`], { cwd: repoRoot });
  if (r.code !== 0 && /closingIssuesReferences/.test(r.stderr)) {
    r = await exec("gh", ["pr", "list", "--state", "merged", "--limit", String(limit), "--json", fields], { cwd: repoRoot });
  }
  if (r.code !== 0) throw new Error(`gh pr list failed: ${r.stderr.trim()}\nTip: use --source git to mine local commits instead.`);
  const prs = JSON.parse(r.stdout) as Array<{
    number: number;
    title: string;
    body: string;
    mergeCommit: { oid: string } | null;
    mergedAt: string;
    url: string;
    closingIssuesReferences?: Array<{ number: number }>;
  }>;
  return prs
    .filter((p) => p.mergeCommit?.oid)
    .map((p) => ({
      id: `pr-${p.number}`,
      source: "github" as const,
      title: p.title,
      body: p.body ?? "",
      url: p.url,
      commit: p.mergeCommit!.oid,
      mergedAt: p.mergedAt,
      issueNumbers: (p.closingIssuesReferences ?? []).map((i) => i.number),
    }));
}

async function gitCandidates(repoRoot: string, limit: number): Promise<Candidate[]> {
  const out = await must("git", ["log", "--first-parent", "-n", String(limit), "--format=%H%x1f%s%x1f%b%x1f%cI%x1e", "HEAD"], { cwd: repoRoot });
  const list: Candidate[] = [];
  for (const rec of out.split("\x1e")) {
    const [sha, subject, body, date] = rec.replace(/^\n/, "").split("\x1f");
    if (!sha || !date) continue;
    let title = subject;
    let rest = body.trim();
    // GitHub merge commits: the PR title is the first body line.
    if (/^Merge (pull request|branch)/.test(subject) && rest) {
      const lines = rest.split("\n");
      title = lines[0];
      rest = lines.slice(1).join("\n").trim();
    }
    list.push({
      id: `commit-${sha.slice(0, 8)}`,
      source: "git",
      title,
      body: rest,
      commit: sha,
      mergedAt: date.trim(),
      issueNumbers: [],
    });
  }
  return list;
}

export type Built = { task: Task; testsPatch: string; goldPatch: string } | { rejected: string };

export async function buildTask(repoRoot: string, c: Candidate, opts: MineOptions): Promise<Built> {
  if ((await exec("git", ["cat-file", "-e", `${c.commit}^{commit}`], { cwd: repoRoot })).code !== 0) {
    await exec("git", ["fetch", "-q", "origin", c.commit], { cwd: repoRoot });
    if ((await exec("git", ["cat-file", "-e", `${c.commit}^{commit}`], { cwd: repoRoot })).code !== 0) {
      return { rejected: "merge commit not available locally (try git fetch)" };
    }
  }
  const baseR = await exec("git", ["rev-parse", `${c.commit}^1`], { cwd: repoRoot });
  if (baseR.code !== 0) return { rejected: "root commit" };
  const base = baseR.stdout.trim();

  const changes = parseNameStatus(await must("git", ["diff", "--name-status", "-M", base, c.commit], { cwd: repoRoot }));
  const split = splitChanges(changes);
  const runnable = split.tests.filter((t) => t.status !== "D");
  if (!runnable.length) return { rejected: "no test changes" };
  if (!split.source.length) return { rejected: "no source changes" };
  if (split.manifests.length) return { rejected: `changes dependencies (${split.manifests.map((m) => m.path).join(", ")})` };

  const testPaths = [...new Set(split.tests.map((t) => t.path))];
  const goldPaths = [...new Set([...split.source, ...split.docs].map((t) => t.path))];
  const testsPatch = await must("git", ["diff", "--binary", base, c.commit, "--", ...testPaths], { cwd: repoRoot });
  const goldPatch = await must("git", ["diff", "--binary", base, c.commit, "--", ...goldPaths], { cwd: repoRoot });
  const numstat = await must("git", ["diff", "--numstat", base, c.commit, "--", ...split.source.map((s) => s.path)], { cwd: repoRoot });
  const goldLines = numstat
    .split("\n")
    .map((l) => l.split("\t"))
    .reduce((n, [a, d]) => n + (a && a !== "-" ? Number(a) + Number(d) : 0), 0);
  if (goldLines > opts.maxGoldLines) return { rejected: `fix too large (${goldLines} lines)` };

  const issues = c.source === "github" ? await fetchIssues(repoRoot, c.issueNumbers) : [];
  const atBase = split.tests.filter((t) => t.status !== "A").map((t) => t.path);

  return {
    task: {
      id: c.id,
      source: c.source,
      title: c.title,
      instruction: composeInstruction(c, issues),
      url: c.url,
      commit: c.commit,
      base,
      mergedAt: c.mergedAt,
      testFiles: [...new Set(runnable.map((t) => t.path))],
      testFilesAtBase: [...new Set(atBase)],
      sourceFiles: split.source.map((s) => s.path),
      goldLines,
      validatedAt: "",
    },
    testsPatch,
    goldPatch,
  };
}

async function fetchIssues(repoRoot: string, nums: number[]) {
  const out: Array<{ number: number; title: string; body: string }> = [];
  for (const n of nums.slice(0, 3)) {
    const r = await exec("gh", ["issue", "view", String(n), "--json", "number,title,body"], { cwd: repoRoot });
    if (r.code === 0) out.push(JSON.parse(r.stdout));
  }
  return out;
}

export function composeInstruction(c: Pick<Candidate, "title" | "body">, issues: Array<{ number: number; title: string; body: string }>): string {
  const clean = (s: string) =>
    s
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^(Co-authored-by|Signed-off-by):.*$/gim, "")
      // Drop pasted diffs: they'd hand the agent the answer.
      .replace(/```diff[\s\S]*?```/g, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const parts = [`# ${c.title.trim()}`];
  const body = clean(c.body);
  if (body) parts.push(body.slice(0, 6000));
  for (const i of issues) {
    parts.push(`## Related issue #${i.number}: ${i.title}\n\n${clean(i.body ?? "").slice(0, 4000)}`);
  }
  return parts.join("\n\n");
}

export interface ValidateResult {
  ok: boolean;
  reason?: string;
  log?: string;
}

/** A task is valid if its tests fail before the fix and pass with the original fix, in your environment. */
export async function validateTask(repoRoot: string, config: Config, task: Task, testsPatch: string, goldPatch: string): Promise<ValidateResult> {
  const dir = join(tmpdir(), "repobench", "validate", `${task.id}-${process.pid}`);
  try {
    await createWorkspace(repoRoot, task.base, dir, config);
    await installTests(dir, task, testsPatch);
    const before = await runTests(dir, config, task);
    if (before.timedOut) return { ok: false, reason: "tests time out" };
    if (before.code === 0) return { ok: false, reason: "tests already pass without the fix" };
    await applyPatch(dir, goldPatch);
    const after = await runTests(dir, config, task);
    if (after.timedOut) return { ok: false, reason: "tests time out with the fix" };
    if (after.code !== 0) {
      return { ok: false, reason: "tests fail even with the original fix (environment?)", log: tail(after.stdout + after.stderr, 1500) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String((e as Error).message ?? e).slice(0, 300) };
  } finally {
    removeWorkspace(dir);
  }
}

export interface InitProgress {
  (msg: string): void;
}

export async function mineAndValidate(
  repoRoot: string,
  store: Store,
  config: Config,
  opts: MineOptions & { concurrency: number; want: number },
  log: InitProgress,
): Promise<{ added: Task[]; rejected: Record<string, number> }> {
  const candidates = await listCandidates(repoRoot, opts);
  log(`Found ${candidates.length} merged ${opts.source === "github" ? "PRs" : "commits"} to check.`);
  const rejectedStore = store.readRejected();
  const counts: Record<string, number> = {};
  const added: Task[] = [];
  const existing = store.listTasks().length;
  const todo = candidates.filter((c) => !store.hasTask(c.id) && !rejectedStore[`${c.id}@${c.commit}`]);

  await pool(todo, opts.concurrency, async (c) => {
    if (existing + added.length >= opts.want) return;
    const built = await buildTask(repoRoot, c, opts);
    if ("rejected" in built) {
      counts[built.rejected.replace(/ \(.*\)$/, "")] = (counts[built.rejected.replace(/ \(.*\)$/, "")] ?? 0) + 1;
      rejectedStore[`${c.id}@${c.commit}`] = built.rejected;
      return;
    }
    log(`  checking ${c.id}: ${c.title.slice(0, 70)}`);
    const v = await validateTask(repoRoot, config, built.task, built.testsPatch, built.goldPatch);
    if (!v.ok) {
      counts[v.reason!] = (counts[v.reason!] ?? 0) + 1;
      rejectedStore[`${c.id}@${c.commit}`] = v.reason!;
      log(`    ✗ ${c.id}: ${v.reason}`);
      return;
    }
    if (existing + added.length >= opts.want) return;
    built.task.validatedAt = new Date().toISOString();
    store.saveTask(built.task, built.testsPatch, built.goldPatch);
    added.push(built.task);
    log(`    ✓ task ${c.id} (${built.task.testFiles.length} test file(s), ${built.task.goldLines}-line fix)`);
  });
  store.writeRejected(rejectedStore);
  return { added, rejected: counts };
}
