// Adapters for the coding-agent CLIs people already have installed, run headless.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exec, shellQuote, which, type ExecResult } from "./exec.js";

export interface AgentUsage {
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  model?: string;
  error?: string;
}

export interface AgentSpec {
  /** Display name, e.g. "claude" or "claude:opus". */
  label: string;
  bin: string;
  args(prompt: string, o: { model?: string; yolo: boolean }): string[];
  parse(r: ExecResult): AgentUsage;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const BUILTIN: Record<string, Omit<AgentSpec, "label">> = {
  claude: {
    bin: "claude",
    args: (prompt, o) => [
      "-p",
      prompt,
      "--output-format",
      "json",
      "--permission-mode",
      o.yolo ? "bypassPermissions" : "acceptEdits",
      ...(o.model ? ["--model", o.model] : []),
    ],
    parse(r) {
      const j = lastJson(r.stdout);
      if (!j) return {};
      const u = j.usage ?? {};
      const models = j.modelUsage ? Object.keys(j.modelUsage) : [];
      return {
        costUsd: num(j.total_cost_usd) ?? num(j.cost_usd),
        inputTokens: sum(u.input_tokens, u.cache_read_input_tokens, u.cache_creation_input_tokens),
        outputTokens: num(u.output_tokens),
        model: models.sort((a, b) => (j.modelUsage[b]?.costUSD ?? 0) - (j.modelUsage[a]?.costUSD ?? 0))[0],
        error: j.is_error ? String(j.result ?? j.subtype ?? "error").slice(0, 300) : undefined,
      };
    },
  },
  codex: {
    bin: "codex",
    // --full-auto: sandboxed to the workspace, commands allowed. --yolo drops the sandbox.
    args: (prompt, o) => [
      "exec",
      o.yolo ? "--dangerously-bypass-approvals-and-sandbox" : "--full-auto",
      "--json",
      "--skip-git-repo-check",
      ...(o.model ? ["-m", o.model] : []),
      prompt,
    ],
    parse(r) {
      let input = 0;
      let output = 0;
      let model: string | undefined;
      for (const j of jsonLines(r.stdout)) {
        const u = j.usage ?? j.msg?.info?.total_token_usage;
        if (j.type === "turn.completed" && u) {
          input += num(u.input_tokens) ?? 0;
          output += num(u.output_tokens) ?? 0;
        }
        model ??= j.model ?? j.msg?.model;
      }
      return { inputTokens: input || undefined, outputTokens: output || undefined, model };
    },
  },
  gemini: {
    bin: "gemini",
    args: (prompt, o) => [
      "-p",
      prompt,
      "--output-format",
      "json",
      ...(o.yolo ? ["--yolo"] : ["--approval-mode", "auto_edit"]),
      ...(o.model ? ["-m", o.model] : []),
    ],
    parse(r) {
      const j = lastJson(r.stdout);
      const models = j?.stats?.models ?? {};
      let input = 0;
      let output = 0;
      for (const m of Object.values<any>(models)) {
        input += num(m?.tokens?.prompt) ?? 0;
        output += num(m?.tokens?.candidates) ?? 0;
      }
      return { inputTokens: input || undefined, outputTokens: output || undefined, model: Object.keys(models)[0] };
    },
  },
  "cursor-agent": {
    bin: "cursor-agent",
    args: (prompt, o) => ["-p", prompt, "--output-format", "json", ...(o.yolo ? ["--force"] : []), ...(o.model ? ["--model", o.model] : [])],
    parse(r) {
      const j = lastJson(r.stdout);
      return { error: j?.is_error ? String(j.result ?? "error").slice(0, 300) : undefined };
    },
  },
};

export const BUILTIN_AGENTS = Object.keys(BUILTIN);

/** "claude", "claude:opus", "codex:gpt-5.5", or a custom agent name from config. */
export function resolveAgent(label: string, custom: Record<string, string> = {}): AgentSpec {
  if (custom[label]) {
    const template = custom[label];
    return {
      label,
      bin: "sh",
      args: (prompt) => ["-c", template.replaceAll("{prompt_file}", shellQuote(writePromptFile(prompt)))],
      parse: () => ({}),
    };
  }
  const [name, ...rest] = label.split(":");
  const model = rest.join(":") || undefined;
  const b = BUILTIN[name];
  if (!b) throw new Error(`unknown agent "${name}". Built in: ${BUILTIN_AGENTS.join(", ")}; or add one under "agents" in .benchmyrepo/config.json`);
  return { label, bin: b.bin, args: (p, o) => b.args(p, { ...o, model: o.model ?? model }), parse: b.parse };
}

let promptDir: string | undefined;
export function setPromptDir(d: string) {
  promptDir = d;
}
function writePromptFile(prompt: string): string {
  const p = join(promptDir ?? process.cwd(), `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.md`);
  writeFileSync(p, prompt);
  return p;
}

export async function installedAgents(): Promise<string[]> {
  const out: string[] = [];
  for (const [name, b] of Object.entries(BUILTIN)) if (await which(b.bin)) out.push(name);
  return out;
}

export function buildPrompt(instruction: string): string {
  return [
    "You are working in a software repository checked out in the current directory.",
    "Make the code change described below. Work autonomously: don't ask questions, don't wait for confirmation.",
    "Hidden tests will check your change, so you don't need to write tests, but you may run existing ones.",
    "Edit files in place and don't create git commits.",
    "",
    "<task>",
    instruction,
    "</task>",
  ].join("\n");
}

export async function runAgent(spec: AgentSpec, prompt: string, cwd: string, o: { yolo: boolean; timeoutMs: number }) {
  const r = await exec(spec.bin, spec.args(prompt, { yolo: o.yolo }), {
    cwd,
    timeoutMs: o.timeoutMs,
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
  });
  let usage: AgentUsage = {};
  try {
    usage = spec.parse(r);
  } catch {
    /* unparseable output still counts as a run */
  }
  return { result: r, usage };
}

function lastJson(s: string): any {
  const t = s.trim();
  try {
    return JSON.parse(t);
  } catch {
    const lines = jsonLines(t);
    return lines[lines.length - 1];
  }
}

function jsonLines(s: string): any[] {
  const out: any[] = [];
  for (const l of s.split("\n")) {
    const t = l.trim();
    if (!t.startsWith("{")) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* not JSON */
    }
  }
  return out;
}

function sum(...xs: unknown[]): number | undefined {
  const ns = xs.map(num).filter((x): x is number => x !== undefined);
  return ns.length ? ns.reduce((a, b) => a + b, 0) : undefined;
}
