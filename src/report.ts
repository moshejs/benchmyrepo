import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunMeta, RunResult, Task } from "./store.js";

export interface AgentStats {
  agent: string;
  model?: string;
  solved: number;
  attempted: number;
  rate: number;
  costUsd?: number;
  costPerSolve?: number;
  medianMs: number;
  tokens?: number;
}

export function computeStats(results: RunResult[]): AgentStats[] {
  const by = new Map<string, RunResult[]>();
  for (const r of results) by.set(r.agent, [...(by.get(r.agent) ?? []), r]);
  const stats = [...by.entries()].map(([agent, rs]) => {
    const solved = rs.filter((r) => r.passed).length;
    const costs = rs.map((r) => r.costUsd).filter((c): c is number => c !== undefined);
    const costUsd = costs.length ? costs.reduce((a, b) => a + b, 0) : undefined;
    const toks = rs.map((r) => (r.inputTokens ?? 0) + (r.outputTokens ?? 0)).reduce((a, b) => a + b, 0);
    const times = rs.map((r) => r.agentMs).sort((a, b) => a - b);
    const models = rs.map((r) => r.model).filter(Boolean) as string[];
    return {
      agent,
      model: mode(models),
      solved,
      attempted: rs.length,
      rate: rs.length ? solved / rs.length : 0,
      costUsd,
      costPerSolve: costUsd !== undefined && solved ? costUsd / solved : undefined,
      medianMs: times.length ? times[Math.floor(times.length / 2)] : 0,
      tokens: toks || undefined,
    };
  });
  return stats.sort((a, b) => b.rate - a.rate || (a.costUsd ?? Infinity) - (b.costUsd ?? Infinity) || a.medianMs - b.medianMs);
}

function mode(xs: string[]): string | undefined {
  const c = new Map<string, number>();
  for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1);
  return [...c.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export const pct = (r: number) => `${Math.round(r * 100)}%`;
const money = (n?: number) => (n === undefined ? "—" : n < 0.01 && n > 0 ? "<$0.01" : `$${n.toFixed(2)}`);
const dur = (ms: number) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60_000).toFixed(1)}m`);
const kTok = (n?: number) => (n === undefined ? "—" : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`);
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function terminalTable(stats: AgentStats[]): string {
  const rows = [["#", "agent", "solved", "rate", "cost", "$/solve", "median"]];
  stats.forEach((s, i) =>
    rows.push([String(i + 1), s.agent, `${s.solved}/${s.attempted}`, pct(s.rate), money(s.costUsd), money(s.costPerSolve), dur(s.medianMs)]),
  );
  const w = rows[0].map((_, c) => Math.max(...rows.map((r) => r[c].length)));
  return rows.map((r) => r.map((cell, c) => cell.padEnd(w[c])).join("  ")).join("\n");
}

export interface ReportFiles {
  html: string;
  card: string;
  badge: string;
  markdown: string;
}

export function writeReport(runDir: string, meta: RunMeta, tasks: Task[], results: RunResult[]): ReportFiles {
  const stats = computeStats(results);
  const files = {
    html: join(runDir, "report.html"),
    card: join(runDir, "leaderboard.svg"),
    badge: join(runDir, "badge.svg"),
    markdown: join(runDir, "summary.md"),
  };
  writeFileSync(files.html, renderHtml(meta, tasks, results, stats));
  writeFileSync(files.card, renderCard(meta, stats, tasks.length));
  writeFileSync(files.badge, renderBadge(stats[0]));
  writeFileSync(files.markdown, renderMarkdown(meta, stats));
  return files;
}

function renderMarkdown(meta: RunMeta, stats: AgentStats[]): string {
  const lines = [
    `## repobench: ${meta.repo}`,
    "",
    `Coding agents on this repo's own merged PRs, graded by the PRs' real tests. Run ${meta.runId}.`,
    "",
    "| # | Agent | Solved | Rate | Cost | Median time |",
    "|---|---|---|---|---|---|",
    ...stats.map((s, i) => `| ${i + 1} | ${s.agent}${s.model ? ` (${s.model})` : ""} | ${s.solved}/${s.attempted} | **${pct(s.rate)}** | ${money(s.costUsd)} | ${dur(s.medianMs)} |`),
    "",
  ];
  return lines.join("\n");
}

export function renderBadge(top?: AgentStats): string {
  const left = "repobench";
  const right = top ? `${top.agent} ${pct(top.rate)}` : "no runs";
  const cw = (s: string) => Math.round(s.length * 6.6 + 12);
  const lw = cw(left);
  const rw = cw(right);
  const color = !top ? "#9f9f9f" : top.rate >= 0.6 ? "#2e8540" : top.rate >= 0.3 ? "#b07d10" : "#c4402f";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + rw}" height="20" role="img" aria-label="${esc(left)}: ${esc(right)}">
<title>${esc(left)}: ${esc(right)}</title>
<linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
<clipPath id="r"><rect width="${lw + rw}" height="20" rx="3" fill="#fff"/></clipPath>
<g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#2b2f36"/><rect x="${lw}" width="${rw}" height="20" fill="${color}"/><rect width="${lw + rw}" height="20" fill="url(#s)"/></g>
<g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
<text x="${lw / 2}" y="14">${esc(left)}</text><text x="${lw + rw / 2}" y="14">${esc(right)}</text></g>
</svg>
`;
}

export function renderCard(meta: RunMeta, stats: AgentStats[], taskCount: number): string {
  const W = 800;
  const rowH = 46;
  const top = 108;
  const H = top + Math.max(1, stats.length) * rowH + 44;
  const barX = 250;
  const barW = 330;
  const rows = stats
    .map((s, i) => {
      const y = top + i * rowH;
      const w = Math.max(2, Math.round(barW * s.rate));
      return `<g transform="translate(0 ${y})">
  <text x="40" y="22" class="rank">${i + 1}</text>
  <text x="70" y="22" class="name">${esc(s.agent)}</text>
  ${s.model ? `<text x="70" y="38" class="sub">${esc(s.model)}</text>` : ""}
  <rect x="${barX}" y="8" width="${barW}" height="20" rx="4" class="track"/>
  <rect x="${barX}" y="8" width="${w}" height="20" rx="4" class="${i === 0 ? "bar lead" : "bar"}"/>
  <text x="${barX + barW + 16}" y="24" class="pct">${pct(s.rate)}</text>
  <text x="${W - 40}" y="24" class="meta" text-anchor="end">${s.solved}/${s.attempted} · ${money(s.costUsd)}</text>
</g>`;
    })
    .join("\n");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="repobench leaderboard for ${esc(meta.repo)}">
<style>
  .bg{fill:#fbfaf7} .fg{fill:#16181d} .muted{fill:#6b6f76} .track{fill:#ebe8e1} .bar{fill:#8a8f98} .lead{fill:#d9531e}
  text{font-family:ui-sans-serif,-apple-system,"Segoe UI",Inter,Helvetica,Arial,sans-serif;fill:#16181d}
  .title{font-size:26px;font-weight:700} .kicker{font-size:13px;fill:#6b6f76;letter-spacing:.06em}
  .rank{font-size:15px;fill:#6b6f76;font-variant-numeric:tabular-nums} .name{font-size:17px;font-weight:600}
  .sub{font-size:11px;fill:#6b6f76} .pct{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}
  .meta{font-size:13px;fill:#6b6f76;font-variant-numeric:tabular-nums} .foot{font-size:12px;fill:#6b6f76}
  @media (prefers-color-scheme: dark){
    .bg{fill:#14161a} text{fill:#eceae4} .kicker,.rank,.sub,.meta,.foot{fill:#9a9ea6} .track{fill:#262a31} .bar{fill:#5d636d} .lead{fill:#f0703a}
  }
</style>
<rect class="bg" width="${W}" height="${H}" rx="14"/>
<text x="40" y="44" class="kicker">REPOBENCH · ${taskCount} REAL PRS · GRADED BY THEIR OWN TESTS</text>
<text x="40" y="80" class="title">Which agent fixes ${esc(meta.repo)}?</text>
${rows}
<text x="40" y="${H - 20}" class="foot">npx repobench · run ${esc(meta.runId)}</text>
</svg>
`;
}

function headline(stats: AgentStats[], repo: string): string {
  if (!stats.length) return `No results yet for ${esc(repo)}`;
  const tied = stats.filter((s) => s.rate === stats[0].rate);
  const names = tied.map((s) => `<em>${esc(s.agent)}</em>`);
  if (tied.length === 1) return `${names[0]} solves ${pct(stats[0].rate)} of ${esc(repo)}'s real PRs`;
  const list = names.length === 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list} tie at ${pct(stats[0].rate)} on ${esc(repo)}'s real PRs`;
}

export function renderHtml(meta: RunMeta, tasks: Task[], results: RunResult[], stats: AgentStats[]): string {
  const agents = stats.map((s) => s.agent);
  const byKey = new Map(results.map((r) => [`${r.taskId}|${r.agent}`, r]));
  const runTasks = tasks.filter((t) => results.some((r) => r.taskId === t.id));
  const statusLabel: Record<RunResult["status"], string> = {
    passed: "Passed",
    failed: "Tests failed",
    agent_error: "Agent error",
    timeout: "Timed out",
    no_changes: "No changes",
    infra_error: "Setup error",
  };

  const leaderRows = stats
    .map(
      (s, i) => `<tr${i === 0 ? ' class="lead"' : ""}>
  <td class="rank">${i + 1}</td>
  <td><div class="agent">${esc(s.agent)}</div>${s.model ? `<div class="model">${esc(s.model)}</div>` : ""}</td>
  <td class="barcell"><div class="bar"><span style="width:${(s.rate * 100).toFixed(1)}%"></span></div></td>
  <td class="num big">${pct(s.rate)}</td>
  <td class="num">${s.solved}/${s.attempted}</td>
  <td class="num hide-sm">${money(s.costUsd)}</td>
  <td class="num hide-sm">${money(s.costPerSolve)}</td>
  <td class="num hide-sm">${dur(s.medianMs)}</td>
  <td class="num hide-sm">${kTok(s.tokens)}</td>
</tr>`,
    )
    .join("\n");

  const matrixRows = runTasks
    .map((t) => {
      const cells = agents
        .map((a) => {
          const r = byKey.get(`${t.id}|${a}`);
          if (!r) return `<td class="cell none" title="not run">·</td>`;
          const tip = `${a}: ${statusLabel[r.status]} · ${dur(r.agentMs)}${r.costUsd !== undefined ? ` · ${money(r.costUsd)}` : ""}${r.linesChanged ? ` · ${r.linesChanged} lines` : ""}${r.note ? ` · ${r.note}` : ""}`;
          return `<td class="cell ${r.passed ? "pass" : "fail"}" title="${esc(tip)}"><span aria-label="${esc(statusLabel[r.status])}">${r.passed ? "✓" : "✗"}</span></td>`;
        })
        .join("");
      const solvedBy = agents.filter((a) => byKey.get(`${t.id}|${a}`)?.passed).length;
      const title = t.url ? `<a href="${esc(t.url)}">${esc(t.title)}</a>` : esc(t.title);
      return `<tr><th scope="row"><div class="tid">${esc(t.id)} · ${t.mergedAt.slice(0, 10)} · ${t.goldLines} lines</div><div class="ttitle">${title}</div></th>${cells}<td class="num solvedby">${solvedBy}/${agents.length}</td></tr>`;
    })
    .join("\n");

  const total = results.length;
  const costAll = results.reduce((n, r) => n + (r.costUsd ?? 0), 0);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>repobench · ${esc(meta.repo)}</title>
<style>
:root{
  --bg:#fbfaf7; --surface:#ffffff; --ink:#16181d; --muted:#6b6f76; --line:#e7e3da; --track:#efece5;
  --accent:#d9531e; --bar:#8a8f98; --pass:#1f7a45; --pass-bg:#e5f3ea; --fail:#b2392a; --fail-bg:#f9e7e3;
  color-scheme: light;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#121417; --surface:#191c20; --ink:#eceae4; --muted:#9a9ea6; --line:#2a2e35; --track:#262a31;
    --accent:#f0703a; --bar:#5d636d; --pass:#5fcf8c; --pass-bg:#173323; --fail:#f08a7a; --fail-bg:#3a1d19;
    color-scheme: dark;
  }
}
:root[data-theme="dark"]{
  --bg:#121417; --surface:#191c20; --ink:#eceae4; --muted:#9a9ea6; --line:#2a2e35; --track:#262a31;
  --accent:#f0703a; --bar:#5d636d; --pass:#5fcf8c; --pass-bg:#173323; --fail:#f08a7a; --fail-bg:#3a1d19;
  color-scheme: dark;
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink)}
body{font:15px/1.5 ui-sans-serif,-apple-system,"Segoe UI",Inter,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:1080px;margin:0 auto;padding:48px 24px 64px}
.kicker{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}
h1{font-size:clamp(28px,4.4vw,44px);line-height:1.08;margin:0 0 14px;letter-spacing:-.02em;text-wrap:balance}
h1 em{font-style:normal;color:var(--accent)}
.lede{color:var(--muted);max-width:62ch;margin:0 0 32px}
.facts{display:flex;flex-wrap:wrap;gap:8px 28px;margin:0 0 36px;padding:0;list-style:none;font-size:14px;color:var(--muted)}
.facts b{color:var(--ink);font-variant-numeric:tabular-nums}
h2{font-size:18px;margin:48px 0 12px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;overflow:hidden}
table{border-collapse:collapse;width:100%}
.leader td{padding:14px 12px;border-top:1px solid var(--line);vertical-align:middle}
.leader tr:first-child td{border-top:0}
.leader thead th{font-size:12px;font-weight:500;color:var(--muted);text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
.leader thead th.num{text-align:right}
.rank{width:36px;color:var(--muted);font-variant-numeric:tabular-nums}
.agent{font-weight:600}
.model{font-size:12px;color:var(--muted)}
.barcell{width:34%}
.bar{height:10px;border-radius:99px;background:var(--track);overflow:hidden}
.bar span{display:block;height:100%;background:var(--bar);border-radius:99px}
.lead .bar span{background:var(--accent)}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.big{font-size:20px;font-weight:700}
.matrix-wrap{overflow-x:auto}
.matrix{min-width:max-content}
.matrix th,.matrix td{border-top:1px solid var(--line);padding:10px 12px}
.matrix thead th{border-top:0;font-size:12px;font-weight:500;color:var(--muted);text-align:center;white-space:nowrap}
.matrix thead th:first-child{text-align:left}
.matrix th[scope=row]{text-align:left;font-weight:400;max-width:420px;min-width:220px}
.tid{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
.ttitle a{color:inherit;text-decoration-color:var(--line);text-underline-offset:3px}
.ttitle a:hover{text-decoration-color:var(--ink)}
.cell{text-align:center;font-weight:700;min-width:64px}
.cell.pass span{display:inline-block;min-width:28px;border-radius:6px;padding:2px 0;color:var(--pass);background:var(--pass-bg)}
.cell.fail span{display:inline-block;min-width:28px;border-radius:6px;padding:2px 0;color:var(--fail);background:var(--fail-bg)}
.cell.none{color:var(--muted)}
.solvedby{color:var(--muted)}
.how{color:var(--muted);font-size:14px;max-width:70ch}
.how li{margin:4px 0}
footer{margin-top:48px;font-size:13px;color:var(--muted)}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--track);padding:1px 5px;border-radius:4px}
@media (max-width:640px){
  main{padding:32px 16px 48px}
  .hide-sm{display:none}
  .barcell{width:30%}
  .leader td{padding:12px 8px}
}
</style>
</head>
<body>
<main>
  <p class="kicker">repobench · ${esc(meta.runId)}</p>
  <h1>${headline(stats, meta.repo)}</h1>
  <p class="lede">Each task is a merged PR from this repo. The agent starts from the code as it was before the PR, gets only the PR's description, and is graded by the tests that shipped with the PR. Nothing here was written by an LLM judge.</p>
  <ul class="facts">
    <li><b>${runTasks.length}</b> tasks</li>
    <li><b>${agents.length}</b> agents</li>
    <li><b>${total}</b> attempts</li>
    <li><b>${money(costAll || undefined)}</b> reported cost</li>
    ${meta.yolo ? "<li>agents ran with full permissions</li>" : ""}
  </ul>

  <section class="card" aria-label="Leaderboard">
    <table class="leader">
      <thead><tr><th>#</th><th>Agent</th><th></th><th class="num">Rate</th><th class="num">Solved</th><th class="num hide-sm">Cost</th><th class="num hide-sm">$/solve</th><th class="num hide-sm">Median</th><th class="num hide-sm">Tokens</th></tr></thead>
      <tbody>
${leaderRows}
      </tbody>
    </table>
  </section>

  <h2>Task by task</h2>
  <section class="card matrix-wrap" aria-label="Results per task">
    <table class="matrix">
      <thead><tr><th>Task</th>${agents.map((a) => `<th>${esc(a)}</th>`).join("")}<th>Solved by</th></tr></thead>
      <tbody>
${matrixRows}
      </tbody>
    </table>
  </section>

  <h2>How this was measured</h2>
  <ul class="how">
    <li>Tasks come from merged PRs that changed both source and tests and didn't change dependencies.</li>
    <li>A task counts only if its tests fail before the fix and pass with the original fix on this machine.</li>
    <li>Agents work in a throwaway copy with no git history, so they can't look up the real fix.</li>
    <li>After the agent finishes, the PR's test files are restored to their merged versions and run.</li>
    <li>Cost is what each agent CLI reports; subscription plans may not report it.</li>
  </ul>
  <footer>Generated by <code>npx repobench</code>. Logs and patches for every attempt are in <code>.repobench/runs/${esc(meta.runId)}/logs</code>.</footer>
</main>
</body>
</html>
`;
}
