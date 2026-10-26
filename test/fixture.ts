// Builds a tiny Python repo whose history contains good and bad benchmark candidates.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { must } from "../src/exec.js";

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

export async function makeFixture(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "benchmyrepo-fixture-"));
  const w = (p: string, s: string) => {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), s);
  };
  const commit = async (msg: string, date: string) => {
    await must("git", ["add", "-A"], { cwd: dir });
    await must("git", ["commit", "-q", "-m", msg], { cwd: dir, env: { ...ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
  };
  await must("git", ["init", "-q", "-b", "main"], { cwd: dir });

  w("pyproject.toml", '[project]\nname = "calc"\nversion = "0.0.1"\n');
  w("calc.py", "def add(a, b):\n    return a + b\n\n\ndef divide(a, b):\n    return a / b\n");
  w("tests/test_calc.py", "from calc import add\n\n\ndef test_add():\n    assert add(2, 3) == 5\n");
  await commit("Initial calculator", "2026-01-01T10:00:00Z");

  // Valid: new function + new test.
  w("calc.py", "def add(a, b):\n    return a + b\n\n\ndef subtract(a, b):\n    return a - b\n\n\ndef divide(a, b):\n    return a / b\n");
  w("tests/test_subtract.py", "from calc import subtract\n\n\ndef test_subtract():\n    assert subtract(5, 3) == 2\n    assert subtract(0, 4) == -4\n");
  await commit("Add subtract()\n\nWe need a subtract(a, b) function in calc.py that returns a - b.", "2026-02-01T10:00:00Z");

  // Docs only: rejected.
  w("README.md", "# calc\n");
  await commit("Add README", "2026-02-02T10:00:00Z");

  // Valid: behaviour change on an existing test file.
  w(
    "calc.py",
    "def add(a, b):\n    return a + b\n\n\ndef subtract(a, b):\n    return a - b\n\n\ndef divide(a, b):\n    if b == 0:\n        raise ValueError(\"cannot divide by zero\")\n    return a / b\n",
  );
  w(
    "tests/test_calc.py",
    "import pytest\n\nfrom calc import add, divide\n\n\ndef test_add():\n    assert add(2, 3) == 5\n\n\ndef test_divide_by_zero():\n    with pytest.raises(ValueError):\n        divide(1, 0)\n",
  );
  await commit("divide() should raise ValueError on zero\n\nRight now divide(1, 0) raises ZeroDivisionError. It should raise ValueError instead.", "2026-03-01T10:00:00Z");

  // Source change whose tests already pass: rejected.
  w(
    "calc.py",
    "def add(a, b):\n    \"\"\"Sum.\"\"\"\n    return a + b\n\n\ndef subtract(a, b):\n    return a - b\n\n\ndef divide(a, b):\n    if b == 0:\n        raise ValueError(\"cannot divide by zero\")\n    return a / b\n",
  );
  w("tests/test_subtract.py", "from calc import subtract\n\n\ndef test_subtract():\n    assert subtract(5, 3) == 2\n    assert subtract(0, 4) == -4\n    assert subtract(1, 1) == 0\n");
  await commit("Docstring + extra assert", "2026-04-01T10:00:00Z");

  // Dependency change: rejected.
  w("pyproject.toml", '[project]\nname = "calc"\nversion = "0.0.2"\ndependencies = []\n');
  w("calc.py", "def add(a, b):\n    \"\"\"Sum.\"\"\"\n    return a + b\n\n\ndef subtract(a, b):\n    return a - b\n\n\ndef divide(a, b):\n    if b == 0:\n        raise ValueError(\"nope\")\n    return a / b\n");
  w("tests/test_calc.py", "import pytest\n\nfrom calc import add, divide\n\n\ndef test_add():\n    assert add(2, 3) == 5\n\n\ndef test_divide_by_zero():\n    with pytest.raises(ValueError, match=\"nope\"):\n        divide(1, 0)\n");
  await commit("Bump version and message", "2026-05-01T10:00:00Z");

  return dir;
}

/**
 * A fake agent: solves the subtract task correctly, gets divide wrong
 * (raises the wrong exception), so a run has one pass and one fail.
 */
export function writeFakeAgent(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "fake_agent.py");
  writeFileSync(
    p,
    `import sys, pathlib
prompt = pathlib.Path(sys.argv[1]).read_text()
src = pathlib.Path("calc.py")
code = src.read_text()
if "subtract" in prompt and "def subtract" not in code:
    code += "\\n\\ndef subtract(a, b):\\n    return a - b\\n"
elif "divide" in prompt:
    code = code.replace("    return a / b", "    if b == 0:\\n        raise TypeError('zero')\\n    return a / b")
src.write_text(code)
`,
  );
  return p;
}
