import { spawn } from "node:child_process";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  /** Run through /bin/sh instead of exec'ing `cmd` directly. */
  shell?: boolean;
  /** Keep at most this many bytes of stdout/stderr (tail). */
  maxBuffer?: number;
}

const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024;

export function exec(cmd: string, args: string[] = [], opts: ExecOptions = {}): Promise<ExecResult> {
  const started = Date.now();
  const maxBuffer = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: opts.shell ?? false,
      stdio: ["pipe", "pipe", "pipe"],
      // Own process group so a timeout can kill the whole tree (agents spawn children).
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const cap = (s: string) => (s.length > maxBuffer ? s.slice(s.length - maxBuffer) : s);
    child.stdout.on("data", (d) => (stdout = cap(stdout + d)));
    child.stderr.on("data", (d) => (stderr = cap(stderr + d)));
    child.stdin.on("error", () => {});
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, opts.timeoutMs);
    }
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: stderr + String(err), timedOut, durationMs: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: code ?? (signal ? 128 : 1),
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
  });
}

function killTree(pid: number | undefined) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Run a command and throw with its stderr if it fails. */
export async function must(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const r = await exec(cmd, args, opts);
  if (r.code !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${r.code}): ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  }
  return r.stdout;
}

export async function which(bin: string): Promise<string | null> {
  const r = await exec("sh", ["-c", `command -v ${shellQuote(bin)}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./:=@%+]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export function tail(s: string, n = 4000): string {
  return s.length > n ? "…" + s.slice(s.length - n) : s;
}
