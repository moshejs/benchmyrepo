// Classifying the files a PR touched: tests, dependency manifests, docs, source.

const TEST_PATTERNS = [
  /(^|\/)(__tests__|tests?|spec|specs)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)test_[^/]*\.py$/,
  /_test\.py$/,
  /(^|\/)conftest\.py$/,
  /_test\.go$/,
  /_spec\.rb$/,
  /(^|\/)__snapshots__\//,
];

const MANIFEST_NAMES = new Set([
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "poetry.lock",
  "uv.lock",
  "Pipfile",
  "Pipfile.lock",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "Gemfile",
  "Gemfile.lock",
]);

const DOC_PATTERN = /\.(md|mdx|rst|txt|adoc)$|(^|\/)(docs?|\.github|\.changeset)\/|(^|\/)(CHANGELOG|LICENSE|AUTHORS)[^/]*$/i;

export function isTestFile(path: string): boolean {
  return TEST_PATTERNS.some((re) => re.test(path));
}

export function isManifest(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  return MANIFEST_NAMES.has(base) || /^requirements[^/]*\.txt$/.test(base);
}

export function isDoc(path: string): boolean {
  return DOC_PATTERN.test(path);
}

export interface FileChange {
  status: string; // A, M, D, R…
  path: string;
}

export interface Split {
  tests: FileChange[];
  source: FileChange[];
  manifests: FileChange[];
  docs: FileChange[];
}

export function splitChanges(changes: FileChange[]): Split {
  const s: Split = { tests: [], source: [], manifests: [], docs: [] };
  for (const c of changes) {
    if (isManifest(c.path)) s.manifests.push(c);
    else if (isTestFile(c.path)) s.tests.push(c);
    else if (isDoc(c.path)) s.docs.push(c);
    else s.source.push(c);
  }
  return s;
}

/** Parse `git diff --name-status -M` output. Renames become a delete + add. */
export function parseNameStatus(out: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0][0];
    if ((status === "R" || status === "C") && parts.length >= 3) {
      if (status === "R") changes.push({ status: "D", path: parts[1] });
      changes.push({ status: "A", path: parts[2] });
    } else {
      changes.push({ status, path: parts[1] });
    }
  }
  return changes;
}
