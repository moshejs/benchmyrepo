import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "./store.js";

export interface Detected {
  language: "js" | "python" | "go" | "rust" | "unknown";
  config: Config;
  why: string;
}

export function detect(repoRoot: string): Detected {
  const linkDirs = findLinkDirs(repoRoot);
  const base = { linkDirs, testEnv: {} as Record<string, string>, testTimeoutSec: 600 };

  const pkgPath = join(repoRoot, "package.json");
  if (existsSync(pkgPath)) {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.vitest) return js("npx vitest run {files}", "vitest in package.json");
    if (deps.jest) return js("npx jest {files}", "jest in package.json");
    if (deps.mocha) return js("npx mocha {files}", "mocha in package.json");
    if (pkg.scripts?.test && !/no test specified/.test(pkg.scripts.test)) return js("npm test -- {files}", "scripts.test in package.json");
    return js("node --test {files}", "package.json without a test runner; using node --test");
  }

  if (["pyproject.toml", "setup.py", "setup.cfg", "pytest.ini", "tox.ini"].some((f) => existsSync(join(repoRoot, f)))) {
    const venvPy = [".venv/bin/python", "venv/bin/python"].map((p) => join(repoRoot, p)).find(existsSync);
    const py = venvPy ?? "python3";
    return {
      language: "python",
      config: {
        ...base,
        testCommand: `${py} -m pytest -q -p no:cacheprovider {files}`,
        // Prefer the workspace's code over an editable install pointing at your checkout.
        testEnv: { PYTHONPATH: "{ws}/src:{ws}" },
      },
      why: venvPy ? `Python project, using ${relative(repoRoot, venvPy)}` : "Python project, using python3 on PATH",
    };
  }

  if (existsSync(join(repoRoot, "go.mod"))) {
    return { language: "go", config: { ...base, testCommand: "go test {pkgs}" }, why: "go.mod" };
  }
  if (existsSync(join(repoRoot, "Cargo.toml"))) {
    return { language: "rust", config: { ...base, testCommand: "cargo test" }, why: "Cargo.toml" };
  }
  return {
    language: "unknown",
    config: { ...base, testCommand: "" },
    why: "could not detect a test runner; pass --test-cmd",
  };

  function js(testCommand: string, why: string): Detected {
    return { language: "js", config: { ...base, testCommand }, why };
  }
}

/** node_modules (root and workspace packages, depth <= 3) and Python venvs. */
export function findLinkDirs(repoRoot: string): string[] {
  const found: string[] = [];
  for (const v of [".venv", "venv"]) if (isDir(join(repoRoot, v))) found.push(v);
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === ".git" || name === ".benchmyrepo" || name === ".venv" || name === "venv") continue;
      const full = join(dir, name);
      if (!isDir(full)) continue;
      if (name === "node_modules") found.push(relative(repoRoot, full));
      else if (depth < 3 && !name.startsWith(".")) walk(full, depth + 1);
    }
  };
  walk(repoRoot, 0);
  return found;
}

function isDir(p: string) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
