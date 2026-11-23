// Helpers for the GitHub Action (action.yml). Not part of the CLI.
//
//   node dist/src/action.js check   --agents claude:sonnet,codex --state <file>
//   node dist/src/action.js guard   --agents claude:sonnet --tasks 5 --max-attempts 20
//   node dist/src/action.js install --agents claude:sonnet --versions '{"claude":"2.1.330"}'
//   node dist/src/action.js save    --versions '{"claude":"2.1.330"}' --state <file>
//   node dist/src/action.js verify  --run-dir .benchmyrepo/runs/<runId>
//
// Outputs go to $GITHUB_OUTPUT when it is set, otherwise to stdout as key=value lines.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { readRunDir, unusableAgents } from "./readme.js";

/**
 * Agents whose releases can be detected without credentials: each is published to npm by
 * its vendor, and the registry serves the version behind the `latest` dist-tag at
 * GET https://registry.npmjs.org/<package>/latest (npm registry API, "GET /{package}/{version}").
 * cursor-agent isn't here: Cursor installs it with a shell script, and the npm package
 * named `cursor-agent` belongs to someone else.
 */
export const NPM_PACKAGES: Record<string, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  gemini: "@google/gemini-cli",
};

export type Versions = Record<string, string>;

const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.+-]+)?$/;

export function agentBases(agents: string): string[] {
  return [...new Set(agents.split(",").map((a) => a.trim().split(":")[0]).filter(Boolean))];
}

export function tracked(bases: string[]): { tracked: string[]; untracked: string[] } {
  return { tracked: bases.filter((b) => NPM_PACKAGES[b]), untracked: bases.filter((b) => !NPM_PACKAGES[b]) };
}

type Fetch = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export async function latestVersions(bases: string[], fetchImpl: Fetch = fetch as unknown as Fetch, registry = "https://registry.npmjs.org"): Promise<Versions> {
  const out: Versions = {};
  for (const b of tracked(bases).tracked) {
    const pkg = NPM_PACKAGES[b];
    const url = `${registry}/${pkg.replace("/", "%2f")}/latest`;
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const v = ((await res.json()) as { version?: unknown }).version;
    if (typeof v !== "string" || !VERSION_RE.test(v)) throw new Error(`${url}: no usable "version" in the response`);
    out[b] = v;
  }
  return out;
}

export function parseVersions(s: string | undefined): Versions {
  if (!s || !s.trim()) return {};
  const v = JSON.parse(s);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("versions must be a JSON object");
  for (const [k, x] of Object.entries(v)) {
    if (!NPM_PACKAGES[k]) throw new Error(`versions: unknown agent "${k}"`);
    if (typeof x !== "string" || !VERSION_RE.test(x)) throw new Error(`versions: "${k}" has an invalid version`);
  }
  return v as Versions;
}

export function readState(path: string): Versions {
  return existsSync(path) ? parseVersions(readFileSync(path, "utf8")) : {};
}

/** Agents whose latest release differs from the version the README's card was made with. */
export function changedAgents(latest: Versions, seen: Versions): string[] {
  return Object.keys(latest).filter((k) => latest[k] !== seen[k]);
}

export const stableJson = (v: Versions) => JSON.stringify(Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))));

/** npm install specs for the requested agents, pinned to `versions` where given. */
export function installSpecs(bases: string[], versions: Versions): string[] {
  return tracked(bases).tracked.map((b) => `${NPM_PACKAGES[b]}@${versions[b] ?? "latest"}`);
}

function output(values: Record<string, string>) {
  const lines = Object.entries(values).map(([k, v]) => {
    if (/[\r\n]/.test(v)) throw new Error(`output ${k} must be one line`);
    return `${k}=${v}`;
  });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, lines.join("\n") + "\n");
  else process.stdout.write(lines.join("\n") + "\n");
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      agents: { type: "string", default: "" },
      state: { type: "string" },
      versions: { type: "string" },
      tasks: { type: "string" },
      "max-attempts": { type: "string" },
      "run-dir": { type: "string" },
    },
  });
  const bases = agentBases(values.agents!);
  switch (cmd) {
    case "check": {
      if (!bases.length) throw new Error("--agents is required");
      if (!values.state) throw new Error("--state is required");
      const { untracked } = tracked(bases);
      const latest = await latestVersions(bases);
      const seen = readState(values.state);
      const changed = changedAgents(latest, seen);
      for (const b of Object.keys(latest)) process.stderr.write(`${b}: latest ${latest[b]}, card made with ${seen[b] ?? "nothing yet"}\n`);
      if (untracked.length) process.stderr.write(`no release check for ${untracked.join(", ")}: these rerun only when the workflow is started by hand\n`);
      output({ changed: String(changed.length > 0), "changed-agents": changed.join(","), versions: stableJson(latest), untracked: untracked.join(",") });
      return 0;
    }
    case "guard": {
      const tasks = Number(values.tasks);
      const max = Number(values["max-attempts"]);
      const agents = values.agents!.split(",").map((a) => a.trim()).filter(Boolean);
      if (!agents.length) throw new Error("set the agents input, e.g. agents: claude:sonnet");
      if (!Number.isInteger(tasks) || tasks < 1) throw new Error("tasks must be a positive whole number");
      if (!Number.isInteger(max) || max < 1) throw new Error("max-attempts must be a positive whole number");
      const attempts = tasks * agents.length;
      if (attempts > max) throw new Error(`${tasks} tasks × ${agents.length} agents = ${attempts} attempts, over max-attempts (${max}). Lower tasks or raise max-attempts.`);
      process.stderr.write(`at most ${attempts} agent attempts (${tasks} tasks × ${agents.length} agents)\n`);
      return 0;
    }
    case "install": {
      // Printed for steps.sh, not an action output.
      process.stdout.write(installSpecs(bases, parseVersions(values.versions)).join(" ") + "\n");
      return 0;
    }
    case "save": {
      if (!values.state) throw new Error("--state is required");
      const v = parseVersions(values.versions);
      if (!Object.keys(v).length) return 0;
      const next = JSON.stringify(JSON.parse(stableJson({ ...readState(values.state), ...v })), null, 2) + "\n";
      if (!existsSync(values.state) || readFileSync(values.state, "utf8") !== next) {
        mkdirSync(dirname(values.state), { recursive: true });
        writeFileSync(values.state, next);
      }
      return 0;
    }
    case "verify": {
      if (!values["run-dir"]) throw new Error("--run-dir is required");
      const { results } = readRunDir(values["run-dir"]);
      if (!results.length) throw new Error("the run has no results");
      const bad = unusableAgents(results);
      if (bad.length) throw new Error(`every attempt by ${bad.join(", ")} ended in an agent or setup error; check the agent is installed and its key or token is set`);
      return 0;
    }
    default:
      process.stderr.write("usage: action.js check|guard|install|save|verify …\n");
      return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`benchmyrepo action: ${err?.message ?? err}\n`);
      process.exit(1);
    },
  );
}
