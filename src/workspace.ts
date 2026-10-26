// A workspace is a fresh directory holding the repo exactly as it was at a task's base
// commit, with its own one-commit git history. Agents can't `git log` their way to the
// real fix, and nothing they do touches your checkout.
import { existsSync, mkdirSync, rmSync, symlinkSync, appendFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { exec, must, shellQuote, type ExecResult } from "./exec.js";
import type { Config, Task } from "./store.js";

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "repobench",
  GIT_AUTHOR_EMAIL: "repobench@localhost",
  GIT_COMMITTER_NAME: "repobench",
  GIT_COMMITTER_EMAIL: "repobench@localhost",
};

export async function createWorkspace(repoRoot: string, sha: string, dir: string, config: Config): Promise<void> {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  await must("sh", ["-c", `git -C ${shellQuote(repoRoot)} archive --format=tar ${sha} | tar -x -C ${shellQuote(dir)}`]);
  await must("git", ["init", "-q", "-b", "main"], { cwd: dir });
  await must("git", ["add", "-A"], { cwd: dir });
  await must("git", ["commit", "-q", "--no-verify", "--allow-empty", "-m", "base"], { cwd: dir, env: GIT_ENV });

  const excludes: string[] = [];
  for (const rel of config.linkDirs) {
    const src = join(repoRoot, rel);
    const dst = join(dir, rel);
    if (!existsSync(src) || existsSync(dst)) continue;
    mkdirSync(dirname(dst), { recursive: true });
    symlinkSync(src, dst, "dir");
    excludes.push(`/${rel}`);
  }
  if (excludes.length) appendFileSync(join(dir, ".git", "info", "exclude"), excludes.join("\n") + "\n");
}

export function removeWorkspace(dir: string) {
  rmSync(dir, { recursive: true, force: true });
}

/** Everything the agent changed, as a patch against the base commit. */
export async function captureDiff(dir: string): Promise<{ patch: string; lines: number }> {
  await must("git", ["add", "-A"], { cwd: dir });
  const patch = await must("git", ["diff", "--cached", "--binary", "HEAD"], { cwd: dir });
  const stat = await must("git", ["diff", "--cached", "--numstat", "HEAD"], { cwd: dir });
  let lines = 0;
  for (const l of stat.split("\n")) {
    const [a, d] = l.split("\t");
    if (a && a !== "-") lines += Number(a) + Number(d);
  }
  return { patch, lines };
}

/**
 * Put the PR's test files in place: reset any edits to them, then apply the hidden
 * test patch on top of whatever the agent did to the source.
 */
export async function installTests(dir: string, task: Task, testsPatch: string): Promise<void> {
  for (const f of task.testFilesAtBase) {
    await must("git", ["checkout", "HEAD", "--", f], { cwd: dir });
  }
  for (const f of task.testFiles) {
    if (!task.testFilesAtBase.includes(f) && existsSync(join(dir, f))) unlinkSync(join(dir, f));
  }
  const r = await exec("git", ["apply", "--whitespace=nowarn", "-"], { cwd: dir, input: testsPatch });
  if (r.code !== 0) throw new Error(`could not apply test patch: ${r.stderr.trim()}`);
}

export async function applyPatch(dir: string, patch: string): Promise<void> {
  if (!patch.trim()) return;
  const r = await exec("git", ["apply", "--whitespace=nowarn", "-"], { cwd: dir, input: patch });
  if (r.code !== 0) throw new Error(`could not apply patch: ${r.stderr.trim()}`);
}

export function testCommandFor(config: Config, task: Task): string {
  const files = task.testFiles.filter((f) => !/__snapshots__/.test(f));
  const pkgs = [...new Set(files.map((f) => "./" + (dirname(f) === "." ? "" : dirname(f))))];
  return config.testCommand
    .replaceAll("{files}", files.map(shellQuote).join(" "))
    .replaceAll("{pkgs}", pkgs.map(shellQuote).join(" "));
}

export async function runTests(dir: string, config: Config, task: Task): Promise<ExecResult> {
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1" };
  for (const [k, v] of Object.entries(config.testEnv)) {
    const val = v.replaceAll("{ws}", dir);
    env[k] = env[k] ? `${val}:${env[k]}` : val;
  }
  return exec(testCommandFor(config, task), [], {
    cwd: dir,
    env,
    shell: true,
    timeoutMs: config.testTimeoutSec * 1000,
  });
}
