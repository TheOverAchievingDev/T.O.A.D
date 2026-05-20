# IDE-1 — JS/TS + ESLint/tsc Diagnostics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** JS/TS files get ESLint + `tsc` diagnostics (Problems panel + Monaco squiggles), `eslint --fix`, and Prettier-if-present format, through the existing 4 `ide_*` commands, with polyglot projects getting both toolchains.

**Architecture:** Extract the language-agnostic diagnostics infra into shared modules, add a JS/TS runner mirroring the Python runner, put a language-router between the facade and the runners (file scope → by extension; project scope → every detected toolchain, merged). No protocol/command-name change. WITH me only; FOR me byte-unchanged.

**Tech Stack:** Node.js ESM, `node:test`, ESLint/tsc/Prettier (project-local binaries), React+TS UI (`tsc -b`), repo gate `scripts/test-suites.txt`, commit directly to `main`.

---

## Spec

Source: `docs/superpowers/specs/2026-05-18-ide-1-jsts-diagnostics-design.md`. Read it. Hard constraints:

- **FOR me untouched:** do not modify `CockpitForMe.tsx`, the persona pill, `developerMode`, `CockpitScreenV2`, `useTweaks`.
- **`localToolFacade.js` is the entanglement-hazard file** (a foreign uncommitted usage-panel workstream lives in it: `geminiUsageProbe`/`probeGeminiUsage`/`#getCachedCodexQuota`/`#getCachedGeminiQuota`; plus foreign uncommitted `App.tsx` providerQuota hunk → 2 `SummaryStatus.quota` tsc errors; untracked `src/providers/geminiUsageProbe.js`; `ui/src/components/PlanUsagePanel.tsx`). NEVER `git add -A`. Stage only IDE-1 files. The full gate FAILS on the dirty tree because of this foreign WIP — verify the gate against the **committed** state (Task 8 procedure). Leave the foreign WIP uncommitted and untouched.
- **Verify, don't assume:** behavior-preserving extractions are guarded by the existing GREEN Python suites; run them.

## File Structure

- Create `src/ide/diagnosticNormalize.js` — `normalizeDiagnostic`, `normalizeDiagnosticPath`, `positiveIntegerOrDefault`, `toPosixPath` (moved verbatim from `pythonDiagnosticParsers.js`). One responsibility: the language-agnostic diagnostic object/path normalizer.
- Create `src/ide/diagnosticsToolRunner.js` — `runTool`, `summarizeToolResult`, `compareDiagnostics`, `isOutsideRoot`, `resolveDiagnosticFileTarget(rootPath, relativePath, commandName, allowedExtensions)` (generalized from python's `resolvePythonFileTarget`). One responsibility: spawn/timeout/availability + path-target safety.
- Modify `src/ide/python/pythonDiagnosticParsers.js` — import the 4 helpers from `diagnosticNormalize.js`; delete the local copies. Behavior identical.
- Modify `src/ide/python/pythonDiagnosticsRunner.js` — import `runTool`/`summarizeToolResult`/`compareDiagnostics`/`isOutsideRoot` + `resolveDiagnosticFileTarget` from `diagnosticsToolRunner.js`; delete local copies; `resolvePythonFileTarget` becomes a thin wrapper over the generic resolver with `['.py']`. Behavior identical.
- Create `src/ide/js/jsDiagnosticParsers.js` — `parseEslintJsonDiagnostics`, `parseTscDiagnostics` (reuse `normalizeDiagnostic`/`normalizeDiagnosticPath`).
- Create `src/ide/js/jsDiagnosticsRunner.js` — `runJsDiagnostics`/`formatJsFile`/`fixJsFile`/`fixJsProject`, signatures+return shapes identical to the Python runner.
- Create `src/ide/diagnosticsRouter.js` — `routeDiagnostics`/`routeFormatFile`/`routeFixFile`/`routeFixProject`.
- Modify `src/tools/localToolFacade.js` — 4 `#ide*` methods call the router; add `jsIdeTools` injection (keep `pythonIdeTools`, back-compat).
- Modify `ui/src/components/ideDiagnostics.ts` — add `isDiagnosablePath`, `languageForDiagnostics`.
- Modify `ui/src/components/IdeEditorPane.tsx` — toolbar gate `isPythonPath` → `isDiagnosablePath` (import swap only).
- Modify `scripts/test-suites.txt` — wire 5 new suites single-line.
- Tests: `test/ideDiagnosticsToolRunner.test.js`, `test/jsDiagnosticParsers.test.js`, `test/jsDiagnosticsRunner.test.js`, `test/diagnosticsRouter.test.js`, `test/localToolFacade.ideJsDiagnostics.test.js`, `ui/test/ideDiagnostics.jsts.test.mjs`.

**Plan-level refinements of the spec (intentional, consistent with spec intent):**
1. Spec §4 named only `diagnosticsToolRunner.js`; the plan adds a focused sibling `diagnosticNormalize.js` for the parser-shared normalizer (DRY; `jsDiagnosticParsers` must not duplicate it).
2. Spec §4 said "un-gate `CockpitWithMe.tsx`": verified it is **already un-gated** (it calls `ide_diagnostics_run` unconditionally on tree load at `CockpitWithMe.tsx:294-297`; the `runPythonDiagnostics` identifier is cosmetic, out of scope to rename). So **no `CockpitWithMe.tsx` change** — the UI change is only the `IdeEditorPane.tsx` toolbar gate + the `ideDiagnostics.ts` helper. Format/Fix buttons stay shown for any diagnosable editable file; missing eslint/tsc/Prettier surfaces the actionable backend message in the existing error area exactly as Ruff-missing does today (no chicken/egg pre-flight).

---

## Task 1: Extract `diagnosticNormalize.js` (behavior-preserving)

**Files:**
- Create: `src/ide/diagnosticNormalize.js`
- Modify: `src/ide/python/pythonDiagnosticParsers.js`
- Regression guard (existing, must stay green): `test/idePythonDiagnosticParsers.test.js`

- [ ] **Step 1: Create `src/ide/diagnosticNormalize.js`** with the helpers moved verbatim from `pythonDiagnosticParsers.js`:

```js
import path from 'node:path';

export function normalizeDiagnosticPath(filePath, { rootPath } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return '';
  }
  const normalizedRoot = typeof rootPath === 'string' && rootPath.length > 0
    ? path.resolve(rootPath)
    : null;
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : (normalizedRoot ? path.resolve(normalizedRoot, filePath) : path.normalize(filePath));
  const relativePath = normalizedRoot
    ? path.relative(normalizedRoot, absolutePath)
    : filePath;
  return toPosixPath(relativePath || path.basename(absolutePath));
}

export function normalizeDiagnostic(diagnostic) {
  const line = positiveIntegerOrDefault(diagnostic.line, 1);
  const column = positiveIntegerOrDefault(diagnostic.column, 1);
  const endLine = positiveIntegerOrDefault(diagnostic.endLine, line);
  const endColumn = positiveIntegerOrDefault(diagnostic.endColumn, column + 1);
  return {
    source: diagnostic.source,
    code: diagnostic.code || null,
    severity: diagnostic.severity || 'warning',
    message: diagnostic.message || 'Diagnostic',
    path: diagnostic.path,
    line,
    column,
    endLine,
    endColumn: endLine === line ? Math.max(endColumn, column + 1) : endColumn,
    fixable: Boolean(diagnostic.fixable),
  };
}

export function positiveIntegerOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}
```

- [ ] **Step 2: Refactor `pythonDiagnosticParsers.js`** — replace its top `import path from 'node:path';` and its local `normalizeDiagnosticPath`/`normalizeDiagnostic`/`positiveIntegerOrDefault`/`toPosixPath` definitions with:

```js
import {
  normalizeDiagnostic,
  normalizeDiagnosticPath,
  toPosixPath,
} from '../diagnosticNormalize.js';
```

Delete the now-duplicated function bodies (`normalizeDiagnosticPath`, `normalizeDiagnostic`, `positiveIntegerOrDefault`, `toPosixPath`). Keep `parseRuffJsonDiagnostics`, `parseMypyDiagnostics`, `severityForRuffCode`, `severityForMypyLevel` (they now call the imported helpers). `severityForRuffCode`/`severityForMypyLevel` and the `parse*` exports keep their bodies. `path` is no longer used directly in this file after the move — remove the `import path` line (it lives in `diagnosticNormalize.js` now). Re-export `normalizeDiagnosticPath` so existing importers keep working: add `export { normalizeDiagnosticPath } from '../diagnosticNormalize.js';` (the existing test imports `normalizeDiagnosticPath` from this module — it MUST remain exported here).

- [ ] **Step 3: Run the regression guard**

Run: `node --no-warnings --test test/idePythonDiagnosticParsers.test.js`
Expected: `# fail 0` (same pass count as before — behavior identical; this suite imports `normalizeDiagnosticPath`/`parseMypyDiagnostics`/`parseRuffJsonDiagnostics` from `pythonDiagnosticParsers.js` and must stay green).

- [ ] **Step 4: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/ide/diagnosticNormalize.js toad-local/src/ide/python/pythonDiagnosticParsers.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "refactor(ide): extract language-agnostic diagnostic normalizer (IDE-1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Extract `diagnosticsToolRunner.js` + generic file-target resolver

**Files:**
- Create: `src/ide/diagnosticsToolRunner.js`
- Modify: `src/ide/python/pythonDiagnosticsRunner.js`
- Test: `test/ideDiagnosticsToolRunner.test.js` (new — covers the generic resolver)
- Regression guard: `test/idePythonDiagnosticParsers.test.js`, `test/localToolFacade.idePythonDiagnostics.test.js`

- [ ] **Step 1: Write the failing resolver test** — create `test/ideDiagnosticsToolRunner.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveDiagnosticFileTarget } from '../src/ide/diagnosticsToolRunner.js';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'toad-dtr-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const x = 1;\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('resolveDiagnosticFileTarget accepts an allowed extension and returns posix relative target', () => {
  const f = fixture();
  try {
    const t = resolveDiagnosticFileTarget(f.dir, 'src/a.ts', 'ide_fix_file', ['.ts', '.tsx']);
    assert.equal(t.relativePath, 'src/a.ts');
    assert.equal(t.commandTarget, 'src/a.ts');
  } finally { f.cleanup(); }
});

test('resolveDiagnosticFileTarget rejects a disallowed extension', () => {
  const f = fixture();
  try {
    assert.throws(
      () => resolveDiagnosticFileTarget(f.dir, 'src/a.ts', 'ide_fix_file', ['.py']),
      /ide_fix_file: unsupported file type/,
    );
  } finally { f.cleanup(); }
});

test('resolveDiagnosticFileTarget rejects path traversal / absolute', () => {
  const f = fixture();
  try {
    assert.throws(() => resolveDiagnosticFileTarget(f.dir, '../evil.ts', 'ide_fix_file', ['.ts']),
      /ide_fix_file: path outside source root/);
    assert.throws(() => resolveDiagnosticFileTarget(f.dir, 'C:/abs.ts', 'ide_fix_file', ['.ts']),
      /ide_fix_file: path outside source root/);
  } finally { f.cleanup(); }
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `node --no-warnings --test test/ideDiagnosticsToolRunner.test.js`
Expected: FAIL — `diagnosticsToolRunner.js` does not exist.

- [ ] **Step 3: Create `src/ide/diagnosticsToolRunner.js`** — move `runTool`, `summarizeToolResult`, `compareDiagnostics`, `isOutsideRoot` verbatim out of `pythonDiagnosticsRunner.js`, and add the generalized resolver (the python `resolvePythonFileTarget` body with the hardcoded `.py` check replaced by an `allowedExtensions` param):

```js
import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';

export function compareDiagnostics(a, b) {
  return a.path.localeCompare(b.path)
    || a.line - b.line
    || a.column - b.column
    || a.source.localeCompare(b.source);
}

export function isOutsideRoot(relativePath) {
  return relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath);
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

export function resolveDiagnosticFileTarget(rootPath, relativePath, commandName, allowedExtensions) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || path.isAbsolute(relativePath)) {
    throw new Error(`${commandName}: path outside source root`);
  }
  const absolutePath = path.resolve(rootPath, relativePath);
  const relativeToRoot = path.relative(rootPath, absolutePath);
  if (isOutsideRoot(relativeToRoot)) {
    throw new Error(`${commandName}: path outside source root`);
  }
  const lower = relativeToRoot.toLowerCase();
  if (!allowedExtensions.some((ext) => lower.endsWith(ext))) {
    throw new Error(`${commandName}: unsupported file type`);
  }
  let stats; let realRootPath; let realTargetPath;
  try {
    stats = statSync(absolutePath);
    realRootPath = realpathSync(rootPath);
    realTargetPath = realpathSync(absolutePath);
  } catch (error) {
    throw new Error(`${commandName}: ${error?.message || 'filesystem error'}`);
  }
  if (isOutsideRoot(path.relative(realRootPath, realTargetPath))) {
    throw new Error(`${commandName}: path outside source root`);
  }
  if (!stats.isFile()) {
    throw new Error(`${commandName}: not a file`);
  }
  return {
    absolutePath: realTargetPath,
    relativePath: toPosixPath(relativeToRoot),
    commandTarget: toPosixPath(relativeToRoot),
  };
}

export function summarizeToolResult(result) {
  return {
    tool: result.tool,
    available: result.available,
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    message: result.message,
  };
}

// runTool moved verbatim from pythonDiagnosticsRunner.js (spawn shell:false,
// timeout, availability via injected `isUnavailable` predicate).
export function runTool({ tool, command, args, cwd, timeoutMs, spawn, findingsExitCodes, isUnavailable }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let stdout = ''; let stderr = ''; let settled = false; let timedOut = false; let child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ tool, command, args, cwd, stdout, stderr, durationMs: Date.now() - startedAt, ...result });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child?.kill?.('SIGTERM'); } catch {}
      finish({ available: true, exitCode: null, timedOut: true, ok: false, message: `${tool} timed out after ${timeoutMs}ms` });
    }, timeoutMs);
    try {
      child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    } catch (error) {
      finish({ available: false, exitCode: null, timedOut: false, ok: false, message: `${tool} unavailable: ${error?.message || 'spawn failed'}` });
      return;
    }
    child.stdout?.on('data', (c) => { stdout += c.toString(); });
    child.stderr?.on('data', (c) => { stderr += c.toString(); });
    child.on('error', (error) => {
      finish({ available: false, exitCode: null, timedOut, ok: false, message: `${tool} unavailable: ${error?.message || 'spawn failed'}` });
    });
    child.on('close', (exitCode) => {
      const available = !(typeof isUnavailable === 'function' && isUnavailable({ stderr, exitCode }));
      const ok = available && findingsExitCodes.has(exitCode);
      finish({ available, exitCode, timedOut, ok, message: available ? (ok ? `${tool} ran` : `${tool} exited ${exitCode}`) : `${tool} unavailable` });
    });
  });
}
```

(NOTE: the Python runner's original `runTool` computed `available` via a Python-module-missing regex and a Ruff/Mypy-specific `toolMessage`. The generalized `runTool` takes an `isUnavailable({stderr,exitCode})` predicate and a simple message; the Python runner keeps its richer `toolMessage`/count by wrapping the generic result — see Step 4. This preserves Python output: Step 5 regression suites prove it.)

- [ ] **Step 4: Refactor `pythonDiagnosticsRunner.js`** to import the shared pieces and keep Python behavior identical:
  - Replace local `runTool`/`summarizeToolResult`/`compareDiagnostics`/`isOutsideRoot`/`toPosixPath` definitions with `import { runTool, summarizeToolResult, compareDiagnostics, isOutsideRoot, toPosixPath, resolveDiagnosticFileTarget } from '../diagnosticsToolRunner.js';`
  - Replace `resolvePythonFileTarget(rootPath, relativePath, commandName)` body with: `return resolveDiagnosticFileTarget(rootPath, relativePath, commandName, ['.py']);` (keep the function name + its 3-arg callers unchanged).
  - At each `runTool({...})` call, pass `isUnavailable: ({ stderr }) => isPythonModuleMissing(stderr, tool)` and keep the existing `summarizeToolResult` usage. Keep `toolMessage`/`safeJsonCount`/`isPythonModuleMissing` local (Python-specific). Re-derive `message` for Python results by keeping the existing `summarizeToolResult(result)` call sites and replacing `result.message` construction with the existing `toolMessage(...)` where it was already used (the runner already wraps via `summarizeToolResult` and `toolMessage`; preserve those call sites exactly).
  - `compareDiagnostics` / `toPosixPath` / `isOutsideRoot` now come from the import; delete local copies.

- [ ] **Step 5: Run the new test + the Python regression guards**

```powershell
node --no-warnings --test test/ideDiagnosticsToolRunner.test.js
node --no-warnings --test test/idePythonDiagnosticParsers.test.js test/localToolFacade.idePythonDiagnostics.test.js
```
Expected: all `# fail 0`. (The Python suites are the behavior-preservation proof for the extraction. If any Python test changed output, the extraction altered behavior — fix the wrapper, do not edit the Python tests.)

- [ ] **Step 6: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/ide/diagnosticsToolRunner.js toad-local/src/ide/python/pythonDiagnosticsRunner.js toad-local/test/ideDiagnosticsToolRunner.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "refactor(ide): extract shared diagnostics tool-runner + generic file-target resolver (IDE-1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `jsDiagnosticParsers.js` (TDD)

**Files:**
- Create: `src/ide/js/jsDiagnosticParsers.js`
- Test: `test/jsDiagnosticParsers.test.js`

- [ ] **Step 1: Write the failing test** — create `test/jsDiagnosticParsers.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseEslintJsonDiagnostics, parseTscDiagnostics } from '../src/ide/js/jsDiagnosticParsers.js';

test('parseEslintJsonDiagnostics maps ESLint JSON, severity + fixable', () => {
  const rootPath = path.resolve('C:/project');
  const stdout = JSON.stringify([
    {
      filePath: path.join(rootPath, 'src', 'a.ts'),
      messages: [
        { ruleId: 'no-unused-vars', severity: 2, message: "'x' is defined but never used.", line: 3, column: 7, endLine: 3, endColumn: 8 },
        { ruleId: 'semi', severity: 1, message: 'Missing semicolon.', line: 4, column: 10, endLine: 4, endColumn: 11, fix: { range: [1, 2], text: ';' } },
      ],
    },
  ]);
  assert.deepEqual(parseEslintJsonDiagnostics(stdout, { rootPath }), [
    { source: 'eslint', code: 'no-unused-vars', severity: 'error', message: "'x' is defined but never used.", path: 'src/a.ts', line: 3, column: 7, endLine: 3, endColumn: 8, fixable: false },
    { source: 'eslint', code: 'semi', severity: 'warning', message: 'Missing semicolon.', path: 'src/a.ts', line: 4, column: 10, endLine: 4, endColumn: 11, fixable: true },
  ]);
});

test('parseEslintJsonDiagnostics: empty / malformed → []', () => {
  assert.deepEqual(parseEslintJsonDiagnostics('', { rootPath: process.cwd() }), []);
  assert.deepEqual(parseEslintJsonDiagnostics('not json', { rootPath: process.cwd() }), []);
  assert.deepEqual(parseEslintJsonDiagnostics('{}', { rootPath: process.cwd() }), []);
});

test('parseTscDiagnostics maps tsc stdout incl. TS code, drops non-matching + out-of-root', () => {
  const rootPath = path.resolve('C:/project');
  const stdout = [
    `${path.join(rootPath, 'src', 'a.ts')}(5,3): error TS2322: Type 'number' is not assignable to type 'string'.`,
    `${path.join(rootPath, 'src', 'b.tsx')}(1,1): warning TS6133: 'React' is declared but never used.`,
    'Found 2 errors.',
    `${path.resolve('C:/other')}(9,9): error TS1005: ';' expected.`,
  ].join('\n');
  assert.deepEqual(parseTscDiagnostics(stdout, { rootPath }), [
    { source: 'tsc', code: 'TS2322', severity: 'error', message: "Type 'number' is not assignable to type 'string'.", path: 'src/a.ts', line: 5, column: 3, endLine: 5, endColumn: 4, fixable: false },
    { source: 'tsc', code: 'TS6133', severity: 'warning', message: "'React' is declared but never used.", path: 'src/b.tsx', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: false },
  ]);
});

test('parseTscDiagnostics: empty / no matches → []', () => {
  assert.deepEqual(parseTscDiagnostics('', { rootPath: process.cwd() }), []);
  assert.deepEqual(parseTscDiagnostics('Found 0 errors.', { rootPath: process.cwd() }), []);
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `node --no-warnings --test test/jsDiagnosticParsers.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/ide/js/jsDiagnosticParsers.js`**:

```js
import { normalizeDiagnostic, normalizeDiagnosticPath } from '../diagnosticNormalize.js';

export function parseEslintJsonDiagnostics(stdout, { rootPath } = {}) {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) return [];
  let files;
  try { files = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(files)) return [];
  const out = [];
  for (const file of files) {
    const diagnosticPath = normalizeDiagnosticPath(file?.filePath, { rootPath });
    if (!diagnosticPath) continue;
    for (const m of Array.isArray(file?.messages) ? file.messages : []) {
      out.push(normalizeDiagnostic({
        source: 'eslint',
        code: typeof m?.ruleId === 'string' ? m.ruleId : null,
        severity: m?.severity === 2 ? 'error' : 'warning',
        message: typeof m?.message === 'string' ? m.message : 'ESLint diagnostic',
        path: diagnosticPath,
        line: m?.line,
        column: m?.column,
        endLine: m?.endLine,
        endColumn: m?.endColumn,
        fixable: Boolean(m?.fix),
      }));
    }
  }
  return out;
}

const TSC_LINE = /^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/;

export function parseTscDiagnostics(stdout, { rootPath } = {}) {
  if (typeof stdout !== 'string' || stdout.length === 0) return [];
  const out = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const match = TSC_LINE.exec(raw);
    if (!match) continue;
    const [, filePath, line, column, level, code, message] = match;
    const diagnosticPath = normalizeDiagnosticPath(filePath, { rootPath });
    if (!diagnosticPath || diagnosticPath.startsWith('../') || diagnosticPath.startsWith('..\\')) continue;
    out.push(normalizeDiagnostic({
      source: 'tsc',
      code,
      severity: level === 'warning' ? 'warning' : 'error',
      message,
      path: diagnosticPath,
      line: Number.parseInt(line, 10),
      column: Number.parseInt(column, 10),
      endLine: Number.parseInt(line, 10),
      endColumn: Number.parseInt(column, 10) + 1,
      fixable: false,
    }));
  }
  return out;
}
```

- [ ] **Step 4: Run it — verify pass**

Run: `node --no-warnings --test test/jsDiagnosticParsers.test.js`
Expected: `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/ide/js/jsDiagnosticParsers.js toad-local/test/jsDiagnosticParsers.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(ide): ESLint-JSON + tsc diagnostic parsers (IDE-1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `jsDiagnosticsRunner.js` (TDD, injected spawn)

**Files:**
- Create: `src/ide/js/jsDiagnosticsRunner.js`
- Test: `test/jsDiagnosticsRunner.test.js`

- [ ] **Step 1: Write the failing test** — create `test/jsDiagnosticsRunner.test.js`. Use a fake `spawn` returning an `EventEmitter` with `stdout`/`stderr` emitters (mirror `test/localToolFacade.idePythonDiagnostics.test.js`'s fake-spawn style). Cover: ESLint findings parsed; tsc errors parsed; missing eslint binary (no `node_modules/.bin/eslint`) → tool result `available:false` with /Install the project's dev dependencies/ message and no throw; `formatJsFile` with no project Prettier → `{ changed:false, toolResults:[{tool:'prettier',available:false}] }` no throw; `fixJsFile` runs `eslint --fix` then re-diagnoses and rereads the file; non-`.ts/.js` path → throws `/unsupported file type/`; path traversal → throws `/path outside source root/`.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runJsDiagnostics, formatJsFile, fixJsFile } from '../src/ide/js/jsDiagnosticsRunner.js';

function fakeSpawn(plan) {
  // plan: (command,args) => { stdout, stderr, code }
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      const r = plan(command, args) || { stdout: '', stderr: '', code: 0 };
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      if (r.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
}

function jsProject(withEslintBin = true) {
  const dir = mkdtempSync(path.join(tmpdir(), 'toad-jsrun-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const x=1\n');
  if (withEslintBin) {
    mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint'), '');
    writeFileSync(path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), '');
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('runJsDiagnostics parses ESLint + tsc when binaries present', async () => {
  const p = jsProject(true);
  try {
    const spawn = fakeSpawn((cmd) => cmd.includes('eslint')
      ? { stdout: JSON.stringify([{ filePath: path.join(p.dir, 'src/a.ts'), messages: [{ ruleId: 'semi', severity: 2, message: 'Missing semicolon.', line: 1, column: 14, endLine: 1, endColumn: 15 }] }]), code: 1 }
      : { stdout: `${path.join(p.dir, 'src/a.ts')}(1,1): error TS1005: ';' expected.\n`, code: 2 });
    const r = await runJsDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, scope: 'project', spawn });
    const sources = r.diagnostics.map((d) => d.source).sort();
    assert.deepEqual([...new Set(sources)], ['eslint', 'tsc']);
    assert.equal(r.toolResults.length, 2);
  } finally { p.cleanup(); }
});

test('runJsDiagnostics: missing eslint binary → available:false actionable message, no throw', async () => {
  const p = jsProject(false);
  try {
    const spawn = fakeSpawn(() => ({ stdout: '', code: 0 }));
    const r = await runJsDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, scope: 'project', spawn });
    const eslint = r.toolResults.find((t) => t.tool === 'eslint');
    assert.equal(eslint.available, false);
    assert.match(eslint.message, /Install the project's dev dependencies/i);
  } finally { p.cleanup(); }
});

test('formatJsFile: no project Prettier → unsupported result, no throw', async () => {
  const p = jsProject(true);
  try {
    const r = await formatJsFile({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'src/a.ts', spawn: fakeSpawn(() => ({ code: 0 })) });
    assert.equal(r.changed, false);
    const prettier = r.toolResults.find((t) => t.tool === 'prettier');
    assert.equal(prettier.available, false);
  } finally { p.cleanup(); }
});

test('fixJsFile rejects non-JS/TS + path traversal', async () => {
  const p = jsProject(true);
  try {
    await assert.rejects(fixJsFile({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'README.md', spawn: fakeSpawn(() => ({})) }), /unsupported file type/);
    await assert.rejects(fixJsFile({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: '../x.ts', spawn: fakeSpawn(() => ({})) }), /path outside source root/);
  } finally { p.cleanup(); }
});
```

- [ ] **Step 2: Run it — verify it fails**

Run: `node --no-warnings --test test/jsDiagnosticsRunner.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `src/ide/js/jsDiagnosticsRunner.js`** mirroring `pythonDiagnosticsRunner.js`'s structure, using the shared runner + parsers:

```js
import { spawn as defaultSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { readIdeFile, resolveIdeSourceRoot } from '../ideFileTools.js';
import {
  runTool, summarizeToolResult, compareDiagnostics, resolveDiagnosticFileTarget,
} from '../diagnosticsToolRunner.js';
import { parseEslintJsonDiagnostics, parseTscDiagnostics } from './jsDiagnosticParsers.js';

const JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs', '.cts', '.mts'];
const DIAGNOSTICS_TIMEOUT_MS = 30_000;
const FILE_ACTION_TIMEOUT_MS = 15_000;
const PROJECT_FIX_TIMEOUT_MS = 60_000;

function localBin(rootPath, name) {
  const binDir = path.join(rootPath, 'node_modules', '.bin');
  const win = path.join(binDir, `${name}.cmd`);
  if (process.platform === 'win32' && existsSync(win)) return win;
  const unix = path.join(binDir, name);
  return existsSync(unix) ? unix : null;
}

function missingResult(tool) {
  return {
    tool, available: false, exitCode: null, timedOut: false, durationMs: 0,
    message: `${tool} is not installed in this project. Install the project's dev dependencies, then retry.`,
  };
}

export async function runJsDiagnostics({ projectCwd, taskBoard, teamId, source = { kind: 'project' }, relativePath, scope = 'project', spawn = defaultSpawn } = {}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const fileScoped = scope === 'file' || Boolean(relativePath);
  const target = fileScoped
    ? resolveDiagnosticFileTarget(root.rootPath, relativePath, 'ide_diagnostics_run', JS_EXTS).commandTarget
    : '.';
  const [eslint, tsc] = await Promise.all([
    runEslint(root.rootPath, target, spawn),
    runTsc(root.rootPath, fileScoped ? target : null, spawn),
  ]);
  return {
    source: root.source,
    rootLabel: root.rootLabel,
    diagnostics: [...eslint.diagnostics, ...tsc.diagnostics].sort(compareDiagnostics),
    toolResults: [eslint.toolResult, tsc.toolResult],
    generatedAt: new Date().toISOString(),
  };
}

async function runEslint(rootPath, target, spawn) {
  const bin = localBin(rootPath, 'eslint');
  if (!bin) return { diagnostics: [], toolResult: missingResult('eslint') };
  const result = await runTool({
    tool: 'eslint', command: bin, args: ['--format', 'json', target], cwd: rootPath,
    timeoutMs: DIAGNOSTICS_TIMEOUT_MS, spawn, findingsExitCodes: new Set([0, 1]),
    isUnavailable: ({ exitCode }) => exitCode !== 0 && exitCode !== 1,
  });
  return {
    diagnostics: result.available ? parseEslintJsonDiagnostics(result.stdout, { rootPath }) : [],
    toolResult: summarizeToolResult(result),
  };
}

async function runTsc(rootPath, fileTarget, spawn) {
  const bin = localBin(rootPath, 'tsc');
  if (!bin) return { diagnostics: [], toolResult: missingResult('tsc') };
  const hasTsconfig = existsSync(path.join(rootPath, 'tsconfig.json'));
  const args = ['--noEmit', '--pretty', 'false', ...(hasTsconfig ? ['-p', 'tsconfig.json'] : [])];
  const result = await runTool({
    tool: 'tsc', command: bin, args, cwd: rootPath,
    timeoutMs: DIAGNOSTICS_TIMEOUT_MS, spawn, findingsExitCodes: new Set([0, 1, 2]),
    isUnavailable: () => false,
  });
  let diagnostics = result.available ? parseTscDiagnostics(result.stdout, { rootPath }) : [];
  if (fileTarget) diagnostics = diagnostics.filter((d) => d.path === fileTarget);
  return { diagnostics, toolResult: summarizeToolResult(result) };
}

export async function formatJsFile({ projectCwd, taskBoard, teamId, source = { kind: 'project' }, relativePath, spawn = defaultSpawn } = {}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const target = resolveDiagnosticFileTarget(root.rootPath, relativePath, 'ide_format_file', JS_EXTS);
  const bin = localBin(root.rootPath, 'prettier');
  if (!bin) {
    return { changed: false, file: null, diagnostics: [], toolResults: [missingResult('prettier')], generatedAt: new Date().toISOString() };
  }
  const toolResult = await runTool({
    tool: 'prettier', command: bin, args: ['--write', target.commandTarget], cwd: root.rootPath,
    timeoutMs: FILE_ACTION_TIMEOUT_MS, spawn, findingsExitCodes: new Set([0]), isUnavailable: () => false,
  });
  if (!toolResult.available || !toolResult.ok) throw new Error(`ide_format_file: ${toolResult.message}`);
  const file = readIdeFile({ projectCwd, taskBoard, teamId, source, relativePath: target.relativePath });
  return { changed: true, file, diagnostics: [], toolResults: [summarizeToolResult(toolResult)], generatedAt: new Date().toISOString() };
}

async function eslintFix(rootPath, target, spawn) {
  const bin = localBin(rootPath, 'eslint');
  if (!bin) return missingResult('eslint');
  const r = await runTool({
    tool: 'eslint', command: bin, args: ['--fix', target], cwd: rootPath,
    timeoutMs: FILE_ACTION_TIMEOUT_MS, spawn, findingsExitCodes: new Set([0, 1]),
    isUnavailable: ({ exitCode }) => exitCode !== 0 && exitCode !== 1,
  });
  if (!r.available) throw new Error(`ide_fix: ${r.message}`);
  return summarizeToolResult(r);
}

export async function fixJsFile({ projectCwd, taskBoard, teamId, source = { kind: 'project' }, relativePath, spawn = defaultSpawn } = {}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const target = resolveDiagnosticFileTarget(root.rootPath, relativePath, 'ide_fix_file', JS_EXTS);
  const toolResult = await eslintFix(root.rootPath, target.commandTarget, spawn);
  const diags = await runJsDiagnostics({ projectCwd, taskBoard, teamId, source, relativePath: target.relativePath, scope: 'file', spawn });
  const file = readIdeFile({ projectCwd, taskBoard, teamId, source, relativePath: target.relativePath });
  return { changed: true, file, diagnostics: diags.diagnostics, toolResults: [toolResult, ...diags.toolResults], generatedAt: new Date().toISOString() };
}

export async function fixJsProject({ projectCwd, taskBoard, teamId, source = { kind: 'project' }, spawn = defaultSpawn } = {}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const toolResult = await eslintFix(root.rootPath, '.', spawn);
  const diags = await runJsDiagnostics({ projectCwd, taskBoard, teamId, source, scope: 'project', spawn });
  return { changed: true, diagnostics: diags.diagnostics, toolResults: [toolResult, ...diags.toolResults], generatedAt: new Date().toISOString() };
}
```

- [ ] **Step 4: Run it — verify pass**

Run: `node --no-warnings --test test/jsDiagnosticsRunner.test.js`
Expected: `# fail 0`. (If the generic `runTool` message strings differ from assertions, align the test to the actual `summarizeToolResult` output — do not weaken the missing-binary assertion.)

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/ide/js/jsDiagnosticsRunner.js toad-local/test/jsDiagnosticsRunner.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(ide): JS/TS diagnostics runner — ESLint+tsc, eslint --fix, Prettier-if-present (IDE-1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `diagnosticsRouter.js` (TDD)

**Files:**
- Create: `src/ide/diagnosticsRouter.js`
- Test: `test/diagnosticsRouter.test.js`

- [ ] **Step 1: Write the failing test** — `test/diagnosticsRouter.test.js`: inject fake python/js impls; assert `.ts`/`.py` file scope route to js/python; project scope with only `package.json` → js only; with `pyproject.toml` + `package.json` → both, diagnostics merged + sorted via the shared comparator; unknown ext file scope → empty `{diagnostics:[],toolResults:[]}` no throw; `routeFormatFile`/`routeFixFile` route by extension.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { routeDiagnostics, routeFixFile } from '../src/ide/diagnosticsRouter.js';

function proj(markers) {
  const dir = mkdtempSync(path.join(tmpdir(), 'toad-router-'));
  if (markers.includes('js')) writeFileSync(path.join(dir, 'package.json'), '{}');
  if (markers.includes('py')) writeFileSync(path.join(dir, 'pyproject.toml'), '[tool]\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const impls = {
  python: { runPythonDiagnostics: async () => ({ diagnostics: [{ source: 'ruff', path: 'a.py', line: 1, column: 1, severity: 'warning', code: null, message: 'm', endLine: 1, endColumn: 2, fixable: false }], toolResults: [{ tool: 'ruff' }], generatedAt: 't' }), fixPythonFile: async () => ({ changed: true, source: 'python' }) },
  js: { runJsDiagnostics: async () => ({ diagnostics: [{ source: 'eslint', path: 'a.ts', line: 1, column: 1, severity: 'error', code: null, message: 'm', endLine: 1, endColumn: 2, fixable: false }], toolResults: [{ tool: 'eslint' }], generatedAt: 't' }), fixJsFile: async () => ({ changed: true, source: 'js' }) },
};

test('file scope routes by extension', async () => {
  const p = proj(['js', 'py']);
  try {
    const ts = await routeDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'a.ts', scope: 'file' }, impls);
    assert.deepEqual(ts.diagnostics.map((d) => d.source), ['eslint']);
    const py = await routeDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'a.py', scope: 'file' }, impls);
    assert.deepEqual(py.diagnostics.map((d) => d.source), ['ruff']);
  } finally { p.cleanup(); }
});

test('project scope runs every detected toolchain, merged', async () => {
  const p = proj(['js', 'py']);
  try {
    const r = await routeDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, scope: 'project' }, impls);
    assert.deepEqual([...new Set(r.diagnostics.map((d) => d.source))].sort(), ['eslint', 'ruff']);
    assert.equal(r.toolResults.length, 2);
  } finally { p.cleanup(); }
});

test('project scope js-only project → js only', async () => {
  const p = proj(['js']);
  try {
    const r = await routeDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, scope: 'project' }, impls);
    assert.deepEqual([...new Set(r.diagnostics.map((d) => d.source))], ['eslint']);
  } finally { p.cleanup(); }
});

test('unknown extension file scope → empty, no throw', async () => {
  const p = proj(['js']);
  try {
    const r = await routeDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'a.md', scope: 'file' }, impls);
    assert.deepEqual(r.diagnostics, []);
  } finally { p.cleanup(); }
});

test('routeFixFile routes by extension', async () => {
  const p = proj(['js', 'py']);
  try {
    assert.equal((await routeFixFile({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'a.ts' }, impls)).source, 'js');
    assert.equal((await routeFixFile({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'a.py' }, impls)).source, 'python');
  } finally { p.cleanup(); }
});
```

- [ ] **Step 2: Run — verify fail.** `node --no-warnings --test test/diagnosticsRouter.test.js` → FAIL (module missing).

- [ ] **Step 3: Create `src/ide/diagnosticsRouter.js`**:

```js
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveIdeSourceRoot } from './ideFileTools.js';
import { compareDiagnostics } from './diagnosticsToolRunner.js';
import * as pythonRunner from './python/pythonDiagnosticsRunner.js';
import * as jsRunner from './js/jsDiagnosticsRunner.js';

const PY_EXTS = ['.py'];
const JS_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.cjs', '.mjs', '.cts', '.mts'];

function languageForExt(relativePath) {
  const lower = String(relativePath || '').toLowerCase();
  if (PY_EXTS.some((e) => lower.endsWith(e))) return 'python';
  if (JS_EXTS.some((e) => lower.endsWith(e))) return 'jsts';
  return null;
}

function detectProjectLanguages(rootPath) {
  const langs = [];
  let hasPy = existsSync(path.join(rootPath, 'pyproject.toml'));
  if (!hasPy) {
    try { hasPy = readdirSync(rootPath).some((n) => n.toLowerCase().endsWith('.py')); } catch {}
  }
  if (hasPy) langs.push('python');
  if (existsSync(path.join(rootPath, 'package.json'))) langs.push('jsts');
  return langs;
}

function pick(impls, lang) {
  if (lang === 'python') {
    return {
      diagnostics: impls?.python?.runPythonDiagnostics ?? pythonRunner.runPythonDiagnostics,
      format: impls?.python?.formatPythonFile ?? pythonRunner.formatPythonFile,
      fixFile: impls?.python?.fixPythonFile ?? pythonRunner.fixPythonFile,
      fixProject: impls?.python?.fixPythonProject ?? pythonRunner.fixPythonProject,
    };
  }
  return {
    diagnostics: impls?.js?.runJsDiagnostics ?? jsRunner.runJsDiagnostics,
    format: impls?.js?.formatJsFile ?? jsRunner.formatJsFile,
    fixFile: impls?.js?.fixJsFile ?? jsRunner.fixJsFile,
    fixProject: impls?.js?.fixJsProject ?? jsRunner.fixJsProject,
  };
}

function emptyResult() {
  return { diagnostics: [], toolResults: [], generatedAt: new Date().toISOString() };
}

export async function routeDiagnostics(params, impls) {
  const { relativePath, scope } = params;
  const fileScoped = scope === 'file' || Boolean(relativePath);
  if (fileScoped) {
    const lang = languageForExt(relativePath);
    if (!lang) return { ...emptyResult(), toolResults: [{ tool: 'router', available: true, exitCode: 0, timedOut: false, durationMs: 0, message: `no diagnostics provider for ${path.extname(String(relativePath || ''))}` }] };
    return pick(impls, lang).diagnostics(params);
  }
  const root = resolveIdeSourceRoot({ projectCwd: params.projectCwd, taskBoard: params.taskBoard, teamId: params.teamId, source: params.source });
  const langs = detectProjectLanguages(root.rootPath);
  if (langs.length === 0) return emptyResult();
  const results = await Promise.all(langs.map((l) => pick(impls, l).diagnostics(params)));
  return {
    source: results[0]?.source,
    rootLabel: results[0]?.rootLabel,
    diagnostics: results.flatMap((r) => r.diagnostics ?? []).sort(compareDiagnostics),
    toolResults: results.flatMap((r) => r.toolResults ?? []),
    generatedAt: new Date().toISOString(),
  };
}

export function routeFormatFile(params, impls) {
  const lang = languageForExt(params.relativePath);
  if (!lang) throw new Error('ide_format_file: unsupported file type');
  return pick(impls, lang).format(params);
}

export function routeFixFile(params, impls) {
  const lang = languageForExt(params.relativePath);
  if (!lang) throw new Error('ide_fix_file: unsupported file type');
  return pick(impls, lang).fixFile(params);
}

export async function routeFixProject(params, impls) {
  const root = resolveIdeSourceRoot({ projectCwd: params.projectCwd, taskBoard: params.taskBoard, teamId: params.teamId, source: params.source });
  const langs = detectProjectLanguages(root.rootPath);
  if (langs.length === 0) return { changed: false, ...emptyResult() };
  const results = await Promise.all(langs.map((l) => pick(impls, l).fixProject(params)));
  return {
    changed: results.some((r) => r.changed),
    diagnostics: results.flatMap((r) => r.diagnostics ?? []).sort(compareDiagnostics),
    toolResults: results.flatMap((r) => r.toolResults ?? []),
    generatedAt: new Date().toISOString(),
  };
}
```

- [ ] **Step 4: Run — verify pass.** `node --no-warnings --test test/diagnosticsRouter.test.js` → `# fail 0`.

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD add toad-local/src/ide/diagnosticsRouter.js toad-local/test/diagnosticsRouter.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(ide): language-router (extension + polyglot project detection) for diagnostics (IDE-1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Facade wiring (TDD + Python regression)

**Files:**
- Modify: `src/tools/localToolFacade.js` (the 4 `#ide*` methods + the `pythonIdeTools` injection)
- Test: `test/localToolFacade.ideJsDiagnostics.test.js` (new)
- Regression guard: `test/localToolFacade.idePythonDiagnostics.test.js` (existing, MUST stay green)

**Hygiene:** `localToolFacade.js` carries foreign usage-panel WIP. `git -C C:/Project-TOAD diff -- toad-local/src/tools/localToolFacade.js` before staging; stage with `git add -p` if any foreign hunk is present; never stage the foreign `probeGeminiUsage`/`getCachedCodexQuota` code.

- [ ] **Step 1: Write the failing test** — `test/localToolFacade.ideJsDiagnostics.test.js`, mirroring `test/localToolFacade.idePythonDiagnostics.test.js`'s `makeFacade` helper but injecting `jsIdeTools`. Assert: `IDE_DIAGNOSTICS_RUN` with a `.ts` `relativePath` (or a `package.json`-only project, scope project) routes to the injected `jsIdeTools.runJsDiagnostics`; `IDE_FIX_FILE` with `.ts` → `jsIdeTools.fixJsFile`; a polyglot fixture (both `pyproject.toml` + `package.json`) project scope returns both `eslint` and `ruff` sources.

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalToolFacade } from '../src/tools/localToolFacade.js';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { InMemoryTaskBoard } from '../src/task/inMemoryTaskBoard.js';
import { COMMANDS } from '../src/commands/command-contract.js';

function makeFacade(projectCwd, jsIdeTools, pythonIdeTools) {
  return new LocalToolFacade({ broker: new InMemoryBroker(), taskBoard: new InMemoryTaskBoard(), projectCwd, jsIdeTools, pythonIdeTools });
}
function proj(markers) {
  const dir = mkdtempSync(path.join(tmpdir(), 'toad-facjs-'));
  if (markers.includes('js')) writeFileSync(path.join(dir, 'package.json'), '{}');
  if (markers.includes('py')) writeFileSync(path.join(dir, 'pyproject.toml'), '[tool]\n');
  return dir;
}

test('ide_diagnostics_run routes a JS project to the JS runner', async (t) => {
  const dir = proj(['js']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const facade = makeFacade(dir, { runJsDiagnostics: async () => ({ diagnostics: [{ source: 'eslint', code: null, severity: 'error', message: 'm', path: 'a.ts', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: false }], toolResults: [{ tool: 'eslint', available: true, exitCode: 1, timedOut: false, durationMs: 1, message: '1' }], generatedAt: 't' }) });
  const r = await facade.execute({ commandName: COMMANDS.IDE_DIAGNOSTICS_RUN, actor: { teamId: 'team-a', agentId: 'operator', role: 'human' }, args: { source: { kind: 'project' }, scope: 'project' } });
  assert.equal(r.diagnostics[0].source, 'eslint');
});

test('polyglot project scope returns both sources', async (t) => {
  const dir = proj(['js', 'py']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const facade = makeFacade(dir,
    { runJsDiagnostics: async () => ({ diagnostics: [{ source: 'eslint', code: null, severity: 'error', message: 'm', path: 'a.ts', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: false }], toolResults: [{ tool: 'eslint', available: true, exitCode: 1, timedOut: false, durationMs: 1, message: '1' }], generatedAt: 't' }) },
    { runPythonDiagnostics: async () => ({ diagnostics: [{ source: 'ruff', code: null, severity: 'warning', message: 'm', path: 'a.py', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: false }], toolResults: [{ tool: 'ruff', available: true, exitCode: 1, timedOut: false, durationMs: 1, message: '1' }], generatedAt: 't' }) });
  const r = await facade.execute({ commandName: COMMANDS.IDE_DIAGNOSTICS_RUN, actor: { teamId: 'team-a', agentId: 'operator', role: 'human' }, args: { source: { kind: 'project' }, scope: 'project' } });
  assert.deepEqual([...new Set(r.diagnostics.map((d) => d.source))].sort(), ['eslint', 'ruff']);
});
```

- [ ] **Step 2: Run — verify fail.** `node --no-warnings --test test/localToolFacade.ideJsDiagnostics.test.js` → FAIL (facade still Python-hardwired; no `jsIdeTools`; router not used).

- [ ] **Step 3: Modify `localToolFacade.js`.**
  - Add import near the python runner import: `import * as diagnosticsRouter from '../ide/diagnosticsRouter.js';`
  - Add a `jsIdeTools` constructor param + field, mirroring `pythonIdeTools` (line ~224): in the destructured constructor params add `jsIdeTools = null`, and after the `this.pythonIdeTools = …` line add:
    ```js
    this.jsIdeTools = jsIdeTools && typeof jsIdeTools === 'object' ? jsIdeTools : null;
    ```
  - Replace the 4 `#ide*` method bodies (lines 598-648) so they build an `impls` object and call the router (keeping `args` plumbing identical):
    ```js
    #ideImpls() {
      return { python: this.pythonIdeTools || undefined, js: this.jsIdeTools || undefined };
    }

    #ideDiagnosticsRun(actor, args) {
      return diagnosticsRouter.routeDiagnostics({
        projectCwd: this.projectCwd, taskBoard: this.taskBoard, teamId: actor.teamId,
        source: args.source,
        relativePath: typeof args.relativePath === 'string' ? args.relativePath : undefined,
        scope: typeof args.scope === 'string' ? args.scope : undefined,
      }, this.#ideImpls());
    }

    #ideFormatFile(actor, args) {
      return diagnosticsRouter.routeFormatFile({
        projectCwd: this.projectCwd, taskBoard: this.taskBoard, teamId: actor.teamId,
        source: args.source, relativePath: requireString(args.relativePath, 'args.relativePath'),
      }, this.#ideImpls());
    }

    #ideFixFile(actor, args) {
      return diagnosticsRouter.routeFixFile({
        projectCwd: this.projectCwd, taskBoard: this.taskBoard, teamId: actor.teamId,
        source: args.source, relativePath: requireString(args.relativePath, 'args.relativePath'),
      }, this.#ideImpls());
    }

    #ideFixProject(actor, args) {
      return diagnosticsRouter.routeFixProject({
        projectCwd: this.projectCwd, taskBoard: this.taskBoard, teamId: actor.teamId,
        source: args.source,
      }, this.#ideImpls());
    }
    ```
  - Remove the now-unused direct imports `fixPythonFile, fixPythonProject, formatPythonFile, runPythonDiagnostics` from the `pythonDiagnosticsRunner.js` import (the router imports them itself). Keep `readIdeFile`/`writeIdeFile`/`listIdeTree` imports.

- [ ] **Step 4: Run the new test + the Python regression guard**

```powershell
node --no-warnings --test test/localToolFacade.ideJsDiagnostics.test.js test/localToolFacade.idePythonDiagnostics.test.js
```
Expected: both `# fail 0`. The existing Python facade test injects `pythonIdeTools` and uses a `src/app.py` project fixture → router detects python (`.py` present) → routes to the injected `runPythonDiagnostics`. If that test's fixture lacks `pyproject.toml` AND has no `*.py` at the project root (e.g. only `src/app.py`), the router's `detectProjectLanguages` must still find python: it scans the root dir for `*.py` only (not recursive). **If the Python regression test fails because its fixture's `.py` is nested under `src/`**, broaden `detectProjectLanguages` python detection to also accept `existsSync(path.join(rootPath,'src'))` with any `*.py` under it OR a `requirements.txt`/`setup.py`/`setup.cfg`; re-run until BOTH suites are green. Do not modify the existing Python test.

- [ ] **Step 5: Hygiene-staged commit**

```bash
git -C C:/Project-TOAD diff -- toad-local/src/tools/localToolFacade.js   # inspect: only IDE-1 hunks?
# if only IDE-1 hunks: add whole; else: git -C C:/Project-TOAD add -p toad-local/src/tools/localToolFacade.js (IDE-1 hunks only)
git -C /c/Project-TOAD add toad-local/test/localToolFacade.ideJsDiagnostics.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(ide): route ide_* commands through the language-router; JS/TS + polyglot (IDE-1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
Then `git -C C:/Project-TOAD show HEAD:toad-local/src/tools/localToolFacade.js | grep -c "geminiUsageProbe\|probeGeminiUsage\|getCachedCodexQuota"` → MUST be 0 (no foreign WIP swept in). If non-zero, BLOCK and report.

---

## Task 7: UI un-gate (TDD helper + typecheck)

**Files:**
- Modify: `ui/src/components/ideDiagnostics.ts` (add `isDiagnosablePath`, `languageForDiagnostics`)
- Modify: `ui/src/components/IdeEditorPane.tsx` (toolbar gate import swap only)
- Test: `ui/test/ideDiagnostics.jsts.test.mjs` (new)

- [ ] **Step 1: Write the failing test** — `ui/test/ideDiagnostics.jsts.test.mjs` (tsc-compile pattern, copy `compileHelper` from `ui/test/ideDiagnostics.test.mjs`; compile `ui/src/components/ideDiagnostics.ts`):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

let outDir; let mod;
test.before(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'toad-idejsts-'));
  const tsc = path.resolve('ui/node_modules/typescript/bin/tsc');
  const r = spawnSync(process.execPath, [tsc, path.resolve('ui/src/components/ideDiagnostics.ts'), '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler', '--outDir', outDir, '--skipLibCheck'], { encoding: 'utf8' });
  if (r.status !== 0) { await rm(outDir, { recursive: true, force: true }); throw new Error(r.stderr || r.stdout); }
  mod = await import(pathToFileURL(path.join(outDir, 'ideDiagnostics.js')).href);
});
test.after(async () => { await rm(outDir, { recursive: true, force: true }); });

test('isDiagnosablePath: true for py + js/ts variants, false for others', () => {
  for (const p of ['a.py', 'a.js', 'a.jsx', 'a.ts', 'a.tsx', 'a.cjs', 'a.mjs', 'a.cts', 'a.mts', 'src/x.TS'])
    assert.equal(mod.isDiagnosablePath(p), true, p);
  for (const p of ['a.md', 'a.png', 'a.json', 'a'])
    assert.equal(mod.isDiagnosablePath(p), false, p);
});

test('languageForDiagnostics maps extension', () => {
  assert.equal(mod.languageForDiagnostics('a.py'), 'python');
  assert.equal(mod.languageForDiagnostics('a.tsx'), 'jsts');
  assert.equal(mod.languageForDiagnostics('a.md'), null);
});

test('toMonacoMarkerData maps eslint + tsc sources', () => {
  const sev = { Error: 8, Warning: 4, Info: 2 };
  assert.equal(mod.toMonacoMarkerData({ source: 'eslint', code: 'semi', severity: 'warning', message: 'm', path: 'a.ts', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: true }, sev).severity, 4);
  assert.equal(mod.toMonacoMarkerData({ source: 'tsc', code: 'TS2322', severity: 'error', message: 'm', path: 'a.ts', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: false }, sev).severity, 8);
});
```

- [ ] **Step 2: Run — verify fail.** `node --test ui/test/ideDiagnostics.jsts.test.mjs` → FAIL (`isDiagnosablePath`/`languageForDiagnostics` undefined).

- [ ] **Step 3: Add to `ui/src/components/ideDiagnostics.ts`** (after `isPythonPath`):

```ts
const JS_TS_RE = /\.(jsx?|tsx?|cjs|mjs|cts|mts)$/i;

export function isDiagnosablePath(filePath: string): boolean {
  const p = normalizeDiagnosticPath(filePath).toLowerCase();
  return p.endsWith('.py') || JS_TS_RE.test(p);
}

export function languageForDiagnostics(filePath: string): 'python' | 'jsts' | null {
  const p = normalizeDiagnosticPath(filePath).toLowerCase();
  if (p.endsWith('.py')) return 'python';
  if (JS_TS_RE.test(p)) return 'jsts';
  return null;
}
```

- [ ] **Step 4: Run — verify pass.** `node --test ui/test/ideDiagnostics.jsts.test.mjs` → `# fail 0`.

- [ ] **Step 5: Swap the IdeEditorPane toolbar gate.** In `ui/src/components/IdeEditorPane.tsx`: change the import (line ~18) from `isPythonPath,` to `isDiagnosablePath,` (within the existing `./ideDiagnostics` import group), and change the toolbar gate (line ~566) `{isPythonPath(activeTab.path) && activeTabEditable && (` → `{isDiagnosablePath(activeTab.path) && activeTabEditable && (`. Change NOTHING else (the Run/Format/Fix buttons + `runActivePythonAction` stay — they call the now-language-routed `ide_*` commands; the identifier name is cosmetic, out of scope). Verify `isPythonPath` has no other use in this file (`grep -n isPythonPath ui/src/components/IdeEditorPane.tsx` → only the import + the one gate, both now swapped); if `isPythonPath` is used elsewhere, keep it imported too.

- [ ] **Step 6: UI typecheck**

Run (from `ui/`): `npm run typecheck`
Expected: ONLY the 2 pre-existing foreign `src/App.tsx(1255/1256) SummaryStatus.quota` errors; zero `ideDiagnostics`/`IdeEditorPane` errors. (Do not touch App.tsx.)

- [ ] **Step 7: Commit**

```bash
git -C /c/Project-TOAD add toad-local/ui/src/components/ideDiagnostics.ts toad-local/ui/src/components/IdeEditorPane.tsx toad-local/ui/test/ideDiagnostics.jsts.test.mjs
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(ide): un-gate the editor diagnostics toolbar for JS/TS (isDiagnosablePath) (IDE-1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Gate wiring + full verification + finish

**Files:**
- Modify: `scripts/test-suites.txt`

- [ ] **Step 1: Wire the 5 new backend/UI suites** into `scripts/test-suites.txt` (ONE line; it currently ends `… && node --test ui/test/projectSwitchAction.test.mjs`). Append, single-line, no newline before any `&&`:

```
 && node --no-warnings --test test/ideDiagnosticsToolRunner.test.js && node --no-warnings --test test/jsDiagnosticParsers.test.js && node --no-warnings --test test/jsDiagnosticsRunner.test.js && node --no-warnings --test test/diagnosticsRouter.test.js && node --no-warnings --test test/localToolFacade.ideJsDiagnostics.test.js && node --test ui/test/ideDiagnostics.jsts.test.mjs
```
Confirm one line: `git show :toad-local/scripts/test-suites.txt | awk 'END{print NR}'` → 1.

- [ ] **Step 2: Full root gate against the COMMITTED state** (the dirty tree fails on the foreign usage-panel WIP — per `ide-program` memory):

```bash
cd /c/Project-TOAD/toad-local
cp src/tools/localToolFacade.js /tmp/ltf-wip.bak
git show HEAD:toad-local/src/tools/localToolFacade.js > src/tools/localToolFacade.js
bash -c "$(cat scripts/test-suites.txt)"; echo "GATE_EXIT=$?"
cp /tmp/ltf-wip.bak src/tools/localToolFacade.js && rm /tmp/ltf-wip.bak
```
Expected: `GATE_EXIT=0`, every suite `# fail 0`, the 5 new IDE-1 suites observed. After restore, `git status --porcelain` shows ` M toad-local/src/tools/localToolFacade.js` + `?? toad-local/src/providers/geminiUsageProbe.js` (foreign WIP intact); no `/tmp/ltf-wip.bak`. If gate ≠ 0 for an IDE-1 reason → BLOCK with the failing suite.

- [ ] **Step 3: UI typecheck/build.** From `ui/`: `npm run typecheck` → only the 2 foreign `App.tsx` quota errors. (`npm run build` will exit non-zero solely on those — expected, not IDE-1.) Confirm zero IDE-1 file errors.

- [ ] **Step 4: Scope proof — FOR me / persona / routing byte-unchanged.** `BASE=$(git rev-parse 07da2355)`; for `CockpitForMe.tsx`, `CockpitScreenV2.tsx`, `Titlebar.tsx`, `useTweaks.ts`, `CockpitWithMe.tsx`: `git -C C:/Project-TOAD diff --stat $BASE HEAD -- toad-local/ui/src/components/cockpit/CockpitForMe.tsx toad-local/ui/src/components/cockpit/CockpitScreenV2.tsx toad-local/ui/src/components/Titlebar.tsx toad-local/ui/src/hooks/useTweaks.ts toad-local/ui/src/components/cockpit/CockpitWithMe.tsx` → EMPTY. Any non-empty → scope violation, revert.

- [ ] **Step 5: Foreign WIP preserved.** `git -C C:/Project-TOAD status --porcelain` shows `toad-local/src/tools/localToolFacade.js` (M, foreign hunks), `toad-local/ui/src/App.tsx` (M), `toad-local/ui/src/components/PlanUsagePanel.tsx` (M), `toad-local/src/providers/geminiUsageProbe.js` (??) — all uncommitted, untouched. None of these in any IDE-1 commit (`git log --oneline <base>..HEAD` shows only the 6 IDE-1 commits + this docs commit).

- [ ] **Step 6: Commit gate wiring**

```bash
git -C /c/Project-TOAD add toad-local/scripts/test-suites.txt
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "test(ide): wire IDE-1 JS/TS diagnostics suites into the root gate (IDE-1)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 7: Finish.** Dispatch the final whole-impl reviewer for the IDE-1 commit range; then `superpowers:finishing-a-development-branch` (repo commits directly to `main`; no feature branch/PR). Report completion + a manual-smoke checklist: in WITH me open a `.ts`/`.tsx` file in a JS/TS project → squiggles + Problems populate from eslint/tsc (or actionable "install dev deps" message); Run/Fix/Format toolbar appears on JS/TS files; a polyglot project shows both ruff/mypy and eslint/tsc; FOR me unchanged.

---

## Self-Review

**Spec coverage:** §3 router/detection → Task 5 + Task 6 Step 4 (polyglot/python detection nuance). §4 `diagnosticsToolRunner.js` → Task 2; `jsDiagnosticParsers.js` → Task 3; `jsDiagnosticsRunner.js` → Task 4; router → Task 5; facade seam (`jsIdeTools`, back-compat `pythonIdeTools`) → Task 6; UI `isDiagnosablePath`/`languageForDiagnostics` + IdeEditorPane gate → Task 7; CockpitWithMe "un-gate" → documented no-op (verified already un-gated). §5 data flow → Tasks 5–7. §6 error handling → Task 4 (missing binary/prettier/exit codes) + parser malformed→[] (Task 3). §7 testing (parsers/router/runner/facade/UI + extraction regression guards + committed-state gate) → Tasks 1–8. §8 scope (no LSP/keystroke/Biome; FOR me byte-unchanged) → Task 8 Step 4 proof + scope boundary respected (no such code added). §9 residuals (file-scope tsc project-coupled; marker-owner unchanged) → reflected (tsc runs project-wide, filtered; no marker rename). No gaps.

**Placeholder scan:** Every code step has full code; every run step has an exact command + expected result. The two conditional branches (Task 2 Step 4 Python `runTool` message preservation; Task 6 Step 4 python-detection-fixture nuance) are explicit decision procedures with a concrete fallback + a "regression suite must stay green" gate — not vague placeholders.

**Type consistency:** diagnostic object shape `{source,code,severity,message,path,line,column,endLine,endColumn,fixable}` is identical across `diagnosticNormalize.js` (Task 1), js parsers (Task 3), runner (Task 4), router merge (Task 5), facade test (Task 6). `resolveDiagnosticFileTarget(rootPath, relativePath, commandName, allowedExtensions)` signature identical in Task 2 (def + test) and Task 4 (callers). Runner fn names `runJsDiagnostics`/`formatJsFile`/`fixJsFile`/`fixJsProject` consistent across Tasks 4/5/6. Router fns `routeDiagnostics`/`routeFormatFile`/`routeFixFile`/`routeFixProject` consistent Tasks 5/6. UI `isDiagnosablePath`/`languageForDiagnostics` consistent Task 7 test + impl + IdeEditorPane. `jsIdeTools` injection name consistent Task 6 impl + test.
