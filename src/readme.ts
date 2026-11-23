// Keeps a leaderboard block in a README up to date: the share card as an SVG file next
// to it, plus a short table, between two marker lines. Rewriting the block from the same
// run gives byte-identical files, so a workflow can commit only when something changed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { computeStats, dur, money, pct, rankOf, renderCard } from "./report.js";
import type { RunMeta, RunResult } from "./store.js";

export const START = "<!-- benchmyrepo:start -->";
export const END = "<!-- benchmyrepo:end -->";

export class MarkerError extends Error {}

const ERRORED: RunResult["status"][] = ["agent_error", "infra_error"];

/**
 * Agents whose every attempt ended in an agent or setup error: a missing CLI, a bad key,
 * an exhausted quota. Their 0% would be a statement about the setup, not the agent, so
 * the card must not show it.
 */
export function unusableAgents(results: RunResult[]): string[] {
  const by = new Map<string, RunResult[]>();
  for (const r of results) by.set(r.agent, [...(by.get(r.agent) ?? []), r]);
  return [...by.entries()].filter(([, rs]) => rs.every((r) => ERRORED.includes(r.status))).map(([a]) => a);
}

/** Read a run from a directory holding meta.json and results.jsonl (a .benchmyrepo run, or a recorded copy). */
export function readRunDir(dir: string): { meta: RunMeta; results: RunResult[] } {
  const metaPath = join(dir, "meta.json");
  const resultsPath = join(dir, "results.jsonl");
  if (!existsSync(metaPath) || !existsSync(resultsPath)) throw new Error(`${dir} needs meta.json and results.jsonl`);
  const meta = JSON.parse(readFileSync(metaPath, "utf8")) as RunMeta;
  const results = readFileSync(resultsPath, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as RunResult);
  return { meta, results };
}

const mdCell = (s: string) => s.replace(/[|\\<>[\]`*_]/g, (c) => `\\${c}`);

/** The markdown that goes between the markers. `cardHref` is the card's path relative to the README. */
export function renderBlock(meta: RunMeta, results: RunResult[], cardHref: string): string {
  const stats = computeStats(results);
  const n = new Set(results.map((r) => r.taskId)).size;
  const errored = results.filter((r) => ERRORED.includes(r.status)).length;
  const timedOut = results.filter((r) => r.status === "timeout").length;
  const versions = [
    ...(meta.tool ? [`benchmyrepo ${meta.tool}`] : []),
    ...Object.entries(meta.agentVersions ?? {}).map(([bin, v]) => `\`${bin}\` ${v.replace(/`/g, "")}`),
  ];
  const started = meta.startedAt ? `, started ${meta.startedAt.slice(0, 16).replace("T", " ")} UTC` : "";
  const notes = [
    `One run on ${n} merged PR${n === 1 ? "" : "s"} from this repo${started} (run \`${meta.runId}\`).`,
    "Each agent got the PR's description and a copy of the code from before the PR, and was graded by the tests that shipped with the PR.",
    meta.yolo ? "Agents could run shell commands." : "Agents could edit files but not run commands.",
    errored || timedOut
      ? `${[errored ? `${errored} attempt${errored === 1 ? "" : "s"} ended in an agent or setup error` : "", timedOut ? `${timedOut} timed out` : ""].filter(Boolean).join(" and ")}; they count as unsolved.`
      : "",
    "Cost is what each agent CLI reports, not a bill.",
    `${n} task${n === 1 ? " is" : "s is"} a small sample: compare the raw counts, and don't read a difference of a task or two as a ranking.`,
    versions.length ? `Versions: ${versions.join(", ")}.` : "",
  ].filter(Boolean);
  return [
    "<!-- Written by benchmyrepo. Everything between the benchmyrepo markers is replaced on the next run. -->",
    `[![benchmyrepo leaderboard for ${mdCell(meta.repo)}](${cardHref})](https://github.com/moshejs/benchmyrepo)`,
    "",
    "| # | Agent | Solved | Rate | Reported cost | Median agent time |",
    "|---|---|---|---|---|---|",
    ...stats.map(
      (s, i) =>
        `| ${rankOf(stats, i)} | ${mdCell(s.agent)}${s.model ? ` (${mdCell(s.model)})` : ""} | ${s.solved}/${s.attempted} | ${pct(s.rate)} | ${money(s.costUsd)} | ${dur(s.medianMs)} |`,
    ),
    "",
    notes.join(" "),
  ].join("\n");
}

interface Line {
  start: number;
  /** Offset just past the line's text, before its newline. */
  end: number;
  text: string;
}

function lines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    const raw = text.slice(start, end);
    out.push({ start, end: raw.endsWith("\r") ? end - 1 : end, text: raw.replace(/\r$/, "") });
    if (nl === -1) break;
    start = nl + 1;
  }
  return out;
}

/** Marker lines outside fenced code blocks, so a README that documents the markers isn't rewritten there. */
function findMarkers(text: string): { starts: Line[]; ends: Line[] } {
  const starts: Line[] = [];
  const ends: Line[] = [];
  let fence: string | null = null;
  for (const l of lines(text)) {
    const t = l.text.trim();
    const f = /^(`{3,}|~{3,})/.exec(t)?.[1];
    if (f) {
      if (!fence) fence = f;
      else if (f[0] === fence[0] && f.length >= fence.length && t === f) fence = null;
      continue;
    }
    if (fence) continue;
    if (t === START) starts.push(l);
    else if (t === END) ends.push(l);
  }
  return { starts, ends };
}

/**
 * Replace what's between the marker lines with `block`. Throws MarkerError when the
 * markers are missing, duplicated or out of order; never guesses where the block goes.
 * Keeps the file's line endings (CRLF if the file uses them).
 */
export function replaceBlock(text: string, block: string): { text: string; changed: boolean } {
  const { starts, ends } = findMarkers(text);
  if (!starts.length && !ends.length) {
    throw new MarkerError(`no benchmyrepo markers found. Add these two lines where the leaderboard should go:\n${START}\n${END}`);
  }
  if (starts.length !== 1 || ends.length !== 1) {
    throw new MarkerError(`expected one "${START}" line and one "${END}" line, found ${starts.length} and ${ends.length}`);
  }
  const [s] = starts;
  const [e] = ends;
  if (e.start < s.start) throw new MarkerError(`"${END}" comes before "${START}"`);
  const nl = text.includes("\r\n") ? "\r\n" : "\n";
  const body = block.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n").join(nl);
  const next = text.slice(0, s.start) + START + nl + body + nl + END + text.slice(e.end);
  return { text: next, changed: next !== text };
}

export interface ReadmeUpdate {
  readmeChanged: boolean;
  cardChanged: boolean;
  cardPath: string;
}

/** Write the card file and the README block for one run. Files are only written when their content changes. */
export function updateReadme(o: { meta: RunMeta; results: RunResult[]; readmePath: string; cardPath: string; allowErrors?: boolean }): ReadmeUpdate {
  if (!o.results.length) throw new Error("the run has no results");
  const bad = unusableAgents(o.results);
  if (bad.length && !o.allowErrors) {
    throw new Error(`every attempt by ${bad.join(", ")} ended in an agent or setup error (check the CLI is installed and signed in); not publishing a card that would show it at 0%`);
  }
  if (!existsSync(o.readmePath)) throw new Error(`${o.readmePath} not found`);
  const readme = readFileSync(o.readmePath, "utf8");
  const href = relative(dirname(o.readmePath), o.cardPath).split(sep).join("/");
  const { text, changed } = replaceBlock(readme, renderBlock(o.meta, o.results, href));

  const card = renderCard(o.meta, computeStats(o.results), new Set(o.results.map((r) => r.taskId)).size);
  const cardChanged = !existsSync(o.cardPath) || readFileSync(o.cardPath, "utf8") !== card;
  if (cardChanged) {
    mkdirSync(dirname(o.cardPath), { recursive: true });
    writeFileSync(o.cardPath, card);
  }
  if (changed) writeFileSync(o.readmePath, text);
  return { readmeChanged: changed, cardChanged, cardPath: o.cardPath };
}
