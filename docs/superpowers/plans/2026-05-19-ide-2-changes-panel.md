# IDE-2 — Changed-files panel (WITH me) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Changes" bottom-panel tab to the WITH me cockpit that lists every file changed in the project working tree vs `HEAD` with per-file `+adds`/`−dels` counts, where clicking a row opens that file in the editor's existing diff view; the list polls while the tab is active.

**Architecture:** A new read-only `ide_changes_summary` MCP command (`git diff HEAD --numstat` ⊕ `git status --porcelain`, merged by path) feeds a new `BottomPanelChanges` component wired into `CockpitWithMe`. Clicking a row reuses the already-built `IdeEditorPane` diff view via an additive, backward-compatible `mode:'diff'` field on `externalOpenRequest`.

**Tech Stack:** Node ESM backend (`src/ide`, `src/tools`, `src/commands`, `src/mcp`), `node:test`; React + TypeScript UI (`ui/src/components`), `node --test` `.mjs` helper tests compiled via project `tsc`.

**Source spec:** `docs/superpowers/specs/2026-05-19-ide-2-changes-panel-design.md`

---

## Design deviations discovered during planning (read first)

1. **No React test harness exists.** `ui/` has no testing-library/jsdom/vitest/jest — every `ui/test/*.mjs` test compiles a *pure helper module* with `tsc` and imports it (see `ui/test/ideDiagnostics.test.mjs`). Therefore: all testable changed-files logic lives in the pure `ui/src/components/ideChanges.ts` (unit-tested), and the React components (`BottomPanelChanges`, `BottomPanel`, `CockpitWithMe`, `IdeEditorPane`) are correctness-gated by the `ui` typecheck/build step — the IDE-1 precedent. Spec §8's "BottomPanelChanges render + callbacks" tests are realized as `ideChanges.ts` helper tests + typecheck.
2. **`ui/src/types/index.ts:225` also needs widening.** Spec §5.3 said only `BottomPanel.tsx`'s `BottomPanelTab` needs `'changes'`. In fact `ui/src/types/index.ts` line 225 inlines the union (`bottomPanelTab: 'terminal' | 'problems' | 'output' | 'validations'`) and must also gain `'changes'`. `App.tsx`, `CockpitScreenV2.tsx`, `useTweaks.ts` only pass the value through / default to `'terminal'`; a widened union is assignable, so they stay **byte-unchanged** (spec §7 intent holds).
3. **`test/localMcpToolDefinitions.test.js` has an exact tool-name allowlist** (`assert.deepEqual(names, [...])`, sorted). Adding the tool requires inserting `'ide_changes_summary'` alphabetically (between `'ide_apply_patch'` and `'ide_checkpoint_task'`). Covered in Task 2.

---

## File Structure

**Create:**
- `src/ide/ideChangesSummary.js` — pure-ish backend: resolve source root, run the two git commands (injectable `runGit`), parse + merge → `{ source, files, error? }`. One responsibility: produce the change-set summary.
- `test/ideChangesSummary.test.js` — unit tests, injected fake `runGit`, no real repo.
- `test/localToolFacade.ideChangesSummary.test.js` — facade routing test against a real temp git repo.
- `ui/src/components/ideChanges.ts` — UI types + pure helpers (`statusGlyph`, `formatChangeCounts`, `summarizeChanges`).
- `ui/test/ideChanges.test.mjs` — helper unit tests (tsc-compile-and-import pattern).
- `ui/src/components/cockpit/BottomPanelChanges.tsx` — presentational list (mirrors `BottomPanelProblems.tsx`).

**Modify:**
- `src/commands/command-contract.js` — add `IDE_CHANGES_SUMMARY` to `COMMANDS` (NOT to `MUTATING_COMMANDS`).
- `src/mcp/localToolDefinitions.js` — add the read-only tool definition.
- `src/tools/localToolFacade.js` — import `getIdeChangesSummary`, add dispatch `case` + `#ideChangesSummary` (additive only; controller-verified clean commit).
- `test/localMcpToolDefinitions.test.js` — insert `'ide_changes_summary'` in the sorted names allowlist.
- `scripts/test-suites.txt` — append the two new backend suites + the new UI suite, single line.
- `ui/src/components/cockpit/BottomPanel.tsx` — widen `BottomPanelTab`, add Changes tab + `changesSlot`/`changeCount`.
- `ui/src/types/index.ts` — widen the inlined `bottomPanelTab` union (line 225).
- `ui/src/components/cockpit/CockpitWithMe.tsx` — changes state, `runChangesSummary`, poll-while-active effect, `handleOpenChange`, `externalOpenRequest` type gains `mode?`, wire `BottomPanel` props.
- `ui/src/components/IdeEditorPane.tsx` — additive `mode?: 'diff'` on `externalOpenRequest`/`pendingExternalOpen`, `openFile(path, mode?)`, refactor `loadDiff` → `loadDiffForPath`.

**Byte-unchanged invariant (spec §7):** `ui/src/App.tsx`, the FOR me⇄WITH me persona pill, `developerMode`, `ui/src/components/cockpit/CockpitScreenV2.tsx`, `ui/src/hooks/useTweaks.ts`, `CockpitForMe`, and all FOR me code MUST NOT change. Proven in Task 8.

**Commit convention (every commit):** run from `/c/Project-TOAD`; stage explicit `toad-local/`-prefixed paths only (**never `git add -A`**); `git -c commit.gpgsign=false commit`; trailer line:
`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
Commit directly to `main`.

---

## Task 1: Backend `getIdeChangesSummary` module

**Files:**
- Create: `src/ide/ideChangesSummary.js`
- Test: `test/ideChangesSummary.test.js`

Reference patterns: `src/task/diffComputer.js` (injectable `runGit = defaultRunGit` from `../git/runGit.js`, returns `{exitCode,stdout,stderr}`), `src/ide/ideFileTools.js` `resolveIdeSourceRoot({projectCwd,taskBoard,teamId,source})` → `{ source, rootPath, rootLabel }`, `src/ide/ideGitTools.js` (`toPosixPath`).

- [ ] **Step 1: Write the failing test**

Create `test/ideChangesSummary.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { getIdeChangesSummary } from '../src/ide/ideChangesSummary.js';

// Fake runGit: returns canned {exitCode,stdout,stderr} per git subcommand.
function fakeRunGit(map) {
  return (args) => {
    const key = args.join(' ');
    if (key in map) return map[key];
    return { exitCode: 0, stdout: '', stderr: '' };
  };
}

const baseArgs = {
  projectCwd: '/tmp/fake-project',
  taskBoard: null,
  teamId: 'team-a',
  source: { kind: 'project' },
};

test('getIdeChangesSummary merges numstat counts with porcelain status', () => {
  const runGit = fakeRunGit({
    'diff HEAD --numstat': {
      exitCode: 0,
      stdout: '12\t3\tsrc/foo.ts\n1\t18\tsrc/bar.js\n0\t9\tsrc/gone.ts\n',
      stderr: '',
    },
    'status --porcelain': {
      exitCode: 0,
      stdout: ' M src/foo.ts\n M src/bar.js\n D src/gone.ts\n?? notes.md\n',
      stderr: '',
    },
  });
  const result = getIdeChangesSummary({ ...baseArgs, runGit });
  assert.equal(result.error, undefined);
  const byPath = Object.fromEntries(result.files.map((f) => [f.relativePath, f]));

  assert.deepEqual(byPath['src/foo.ts'], {
    relativePath: 'src/foo.ts', status: 'M', additions: 12, deletions: 3, binary: false,
  });
  assert.deepEqual(byPath['src/bar.js'], {
    relativePath: 'src/bar.js', status: 'M', additions: 1, deletions: 18, binary: false,
  });
  assert.deepEqual(byPath['src/gone.ts'], {
    relativePath: 'src/gone.ts', status: 'D', additions: 0, deletions: 9, binary: false,
  });
  // Untracked: present in porcelain only → status '?', null counts.
  assert.deepEqual(byPath['notes.md'], {
    relativePath: 'notes.md', status: '?', additions: null, deletions: null, binary: false,
  });
});

test('getIdeChangesSummary flags binary files (numstat "-\\t-")', () => {
  const runGit = fakeRunGit({
    'diff HEAD --numstat': { exitCode: 0, stdout: '-\t-\tassets/logo.png\n', stderr: '' },
    'status --porcelain': { exitCode: 0, stdout: ' M assets/logo.png\n', stderr: '' },
  });
  const result = getIdeChangesSummary({ ...baseArgs, runGit });
  assert.deepEqual(result.files[0], {
    relativePath: 'assets/logo.png', status: 'M', additions: null, deletions: null, binary: true,
  });
});

test('getIdeChangesSummary surfaces renamed file as the new path with status R', () => {
  const runGit = fakeRunGit({
    'diff HEAD --numstat': { exitCode: 0, stdout: '5\t2\tsrc/new-name.ts\n', stderr: '' },
    'status --porcelain': { exitCode: 0, stdout: 'R  src/old-name.ts -> src/new-name.ts\n', stderr: '' },
  });
  const result = getIdeChangesSummary({ ...baseArgs, runGit });
  assert.deepEqual(result.files[0], {
    relativePath: 'src/new-name.ts', status: 'R', additions: 5, deletions: 2, binary: false,
  });
});

test('getIdeChangesSummary returns empty files when nothing changed', () => {
  const runGit = fakeRunGit({
    'diff HEAD --numstat': { exitCode: 0, stdout: '', stderr: '' },
    'status --porcelain': { exitCode: 0, stdout: '', stderr: '' },
  });
  const result = getIdeChangesSummary({ ...baseArgs, runGit });
  assert.deepEqual(result.files, []);
  assert.equal(result.error, undefined);
});

test('getIdeChangesSummary returns graceful error on git failure (non-git dir)', () => {
  const runGit = fakeRunGit({
    'diff HEAD --numstat': {
      exitCode: 128, stdout: '', stderr: 'fatal: not a git repository',
    },
  });
  const result = getIdeChangesSummary({ ...baseArgs, runGit });
  assert.deepEqual(result.files, []);
  assert.match(result.error, /not a git repository/);
});

test('getIdeChangesSummary returns graceful error when source resolution throws', () => {
  const result = getIdeChangesSummary({
    projectCwd: undefined, taskBoard: null, teamId: 'team-a',
    source: { kind: 'project' }, runGit: fakeRunGit({}),
  });
  assert.deepEqual(result.files, []);
  assert.ok(typeof result.error === 'string' && result.error.length > 0);
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --no-warnings --test test/ideChangesSummary.test.js`
Expected: FAIL — `Cannot find module '../src/ide/ideChangesSummary.js'`.

- [ ] **Step 3: Implement the module**

Create `src/ide/ideChangesSummary.js`:

```js
import path from 'node:path';
import { runGit as defaultRunGit } from '../git/runGit.js';
import { resolveIdeSourceRoot } from './ideFileTools.js';

function toPosixPath(filePath) {
  return String(filePath).split(path.sep).join('/').replace(/\\/g, '/');
}

// Parse `git diff HEAD --numstat`: lines are "<add>\t<del>\t<path>".
// Binary files emit "-\t-\t<path>" (counts unknown → null, binary:true).
function parseNumstat(stdout) {
  const map = new Map();
  for (const rawLine of String(stdout).split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const addRaw = parts[0];
    const delRaw = parts[1];
    const filePath = toPosixPath(parts.slice(2).join('\t').trim());
    if (!filePath) continue;
    const binary = addRaw === '-' && delRaw === '-';
    map.set(filePath, {
      additions: binary ? null : Number.parseInt(addRaw, 10),
      deletions: binary ? null : Number.parseInt(delRaw, 10),
      binary,
    });
  }
  return map;
}

// Parse one `git status --porcelain` v1 line: "XY PATH".
// Untracked "?? PATH" → status '?'. Rename "R  old -> new" → new path.
function parsePorcelainLine(rawLine) {
  const line = rawLine.replace(/\r$/, '');
  if (line.length < 4) return null;
  const xy = line.slice(0, 2);
  let rest = line.slice(3);
  let status;
  if (xy === '??') {
    status = '?';
  } else {
    const trimmed = xy.trim();
    status = trimmed.charAt(0) || 'M';
  }
  const arrowIdx = rest.indexOf(' -> ');
  if (arrowIdx !== -1) rest = rest.slice(arrowIdx + 4);
  const relativePath = toPosixPath(rest.trim());
  if (!relativePath) return null;
  return { status, relativePath };
}

/**
 * Working-tree change set vs HEAD for the resolved IDE source root.
 * Best-effort: source-resolution or git failure returns
 * { source, files: [], error } rather than throwing (mirrors getIdeStatus).
 *
 * Returns { source, files: IdeChangeEntry[], error? } where
 * IdeChangeEntry = { relativePath, status, additions, deletions, binary }.
 */
export function getIdeChangesSummary({
  projectCwd, taskBoard, teamId, source, runGit = defaultRunGit,
} = {}) {
  let root;
  try {
    root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  } catch (error) {
    return {
      source: source ?? null,
      files: [],
      error: error && error.message ? error.message : String(error),
    };
  }

  const numstatResult = runGit(['diff', 'HEAD', '--numstat'], { cwd: root.rootPath });
  if (numstatResult.exitCode !== 0) {
    return {
      source: root.source,
      files: [],
      error: numstatResult.stderr || 'git diff --numstat failed',
    };
  }
  const numstat = parseNumstat(numstatResult.stdout);

  const statusResult = runGit(['status', '--porcelain'], { cwd: root.rootPath });
  if (statusResult.exitCode !== 0) {
    return {
      source: root.source,
      files: [],
      error: statusResult.stderr || 'git status --porcelain failed',
    };
  }

  const files = [];
  for (const rawLine of String(statusResult.stdout).split('\n')) {
    if (!rawLine) continue;
    const parsed = parsePorcelainLine(rawLine);
    if (!parsed) continue;
    const stat = numstat.get(parsed.relativePath);
    files.push({
      relativePath: parsed.relativePath,
      status: parsed.status,
      additions: stat ? stat.additions : null,
      deletions: stat ? stat.deletions : null,
      binary: stat ? stat.binary : false,
    });
  }
  return { source: root.source, files };
}
```

Note: ASCII paths assumed; git `core.quotePath` dequoting is intentionally not implemented (same fidelity level as the existing `getIdeStatus`; spec §9 YAGNI).

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --no-warnings --test test/ideChangesSummary.test.js`
Expected: PASS — all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/src/ide/ideChangesSummary.js toad-local/test/ideChangesSummary.test.js && git -c commit.gpgsign=false commit -m "$(printf 'feat(ide): getIdeChangesSummary — working-tree change set vs HEAD with +/- counts (IDE-2)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: Command contract, tool definition, facade wiring

**Files:**
- Modify: `src/commands/command-contract.js` (add to `COMMANDS` near the other `IDE_*`; do NOT add to `MUTATING_COMMANDS`)
- Modify: `src/mcp/localToolDefinitions.js` (new `makeTool` after the `IDE_GET_DIFF` block)
- Modify: `src/tools/localToolFacade.js` (import + dispatch `case` + `#ideChangesSummary`)
- Modify: `test/localMcpToolDefinitions.test.js` (insert name in sorted allowlist)
- Test: `test/localToolFacade.ideChangesSummary.test.js` (new — real temp git repo)

- [ ] **Step 1: Write the failing facade test**

Create `test/localToolFacade.ideChangesSummary.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { LocalToolFacade } from '../src/tools/localToolFacade.js';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { InMemoryTaskBoard } from '../src/task/inMemoryTaskBoard.js';
import { COMMANDS } from '../src/commands/command-contract.js';

function makeGitProject(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'toad-ide-changes-'));
  execSync('git init', { cwd: root });
  execSync('git config core.autocrlf false', { cwd: root });
  execSync('git config user.name "Test User"', { cwd: root });
  execSync('git config user.email "test@example.com"', { cwd: root });
  writeFileSync(path.join(root, 'keep.txt'), 'line1\nline2\nline3\n');
  writeFileSync(path.join(root, 'gone.txt'), 'delete me\n');
  execSync('git add keep.txt gone.txt', { cwd: root });
  execSync('git commit -m "base"', { cwd: root });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeFacade(projectCwd) {
  return new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    projectCwd,
  });
}

test('LocalToolFacade ide_changes_summary reports modified, deleted, untracked files', async (t) => {
  const projectCwd = makeGitProject(t);
  writeFileSync(path.join(projectCwd, 'keep.txt'), 'line1\nCHANGED\nline3\nline4\n');
  unlinkSync(path.join(projectCwd, 'gone.txt'));
  writeFileSync(path.join(projectCwd, 'fresh.txt'), 'brand new\n');

  const facade = makeFacade(projectCwd);
  const result = await facade.execute({
    commandName: COMMANDS.IDE_CHANGES_SUMMARY,
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { source: { kind: 'project' } },
  });

  const byPath = Object.fromEntries(result.files.map((f) => [f.relativePath, f]));

  assert.equal(byPath['keep.txt'].status, 'M');
  assert.ok(byPath['keep.txt'].additions >= 1);
  assert.ok(byPath['keep.txt'].deletions >= 1);
  assert.equal(byPath['keep.txt'].binary, false);

  assert.equal(byPath['gone.txt'].status, 'D');

  assert.equal(byPath['fresh.txt'].status, '?');
  assert.equal(byPath['fresh.txt'].additions, null);
  assert.equal(byPath['fresh.txt'].deletions, null);
});

test('LocalToolFacade ide_changes_summary is read-only and repeatable', async (t) => {
  const projectCwd = makeGitProject(t);
  writeFileSync(path.join(projectCwd, 'keep.txt'), 'line1\nX\nline3\n');
  const facade = makeFacade(projectCwd);
  const call = () => facade.execute({
    commandName: COMMANDS.IDE_CHANGES_SUMMARY,
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { source: { kind: 'project' } },
  });
  const first = await call();
  const second = await call();
  assert.deepEqual(first.files, second.files);
  // No idempotencyKey required (read-only): the calls above prove it.
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `node --no-warnings --test test/localToolFacade.ideChangesSummary.test.js`
Expected: FAIL — `COMMANDS.IDE_CHANGES_SUMMARY` is `undefined` / unknown command rejected by the facade.

- [ ] **Step 3: Add the command constant**

In `src/commands/command-contract.js`, inside the `COMMANDS` object, immediately after the `IDE_GET_DIFF: 'ide_get_diff',` line (currently line ~27) add:

```js
  IDE_CHANGES_SUMMARY: 'ide_changes_summary',
```

Do **not** add it to `MUTATING_COMMANDS` — it is read-only (like `IDE_GET_STATUS`/`IDE_GET_DIFF`, which are also absent from that list).

- [ ] **Step 4: Add the tool definition**

In `src/mcp/localToolDefinitions.js`, immediately after the `makeTool({ name: COMMANDS.IDE_GET_DIFF, ... })` block (the one ending `}),` around line 325) and before the `COMMANDS.IDE_SEARCH_FILES` block, insert:

```js
  makeTool({
    name: COMMANDS.IDE_CHANGES_SUMMARY,
    title: 'IDE Changes Summary',
    description: 'Read-only. Returns the working-tree change set vs HEAD with per-file added/deleted line counts for the selected project root or task worktree.',
    required: [],
    properties: {
      source: IDE_SOURCE_SCHEMA,
    },
  }),
```

- [ ] **Step 5: Wire the facade**

In `src/tools/localToolFacade.js`:

(a) Add the import alongside the existing IDE git-tools import. Find the line importing `getIdeDiff`/`getIdeStatus` from `'../ide/ideGitTools.js'` and add a sibling import line right after it:

```js
import { getIdeChangesSummary } from '../ide/ideChangesSummary.js';
```

(b) In the dispatch `switch`, immediately after the `case COMMANDS.IDE_GET_DIFF:` arm (currently lines 334-335) add:

```js
      case COMMANDS.IDE_CHANGES_SUMMARY:
        return this.#ideChangesSummary(actor, args);
```

(c) Immediately after the `#ideGetDiff(actor, args) { ... }` method (ends ~line 649) add:

```js
  #ideChangesSummary(actor, args) {
    return getIdeChangesSummary({
      projectCwd: this.projectCwd,
      taskBoard: this.taskBoard,
      teamId: actor.teamId,
      source: args.source,
    });
  }
```

This change is **purely additive** (one import, one `case`, one private method). It does not touch the constructor destructuring or any usage-panel code.

- [ ] **Step 6: Update the tool-name allowlist test**

In `test/localMcpToolDefinitions.test.js`, the sorted `assert.deepEqual(names, [...])` array — insert a new line between `'ide_apply_patch',` and `'ide_checkpoint_task',` (alphabetical position: `ide_ch**a**nges` < `ide_ch**e**ckpoint`):

```js
    'ide_apply_patch',
    'ide_changes_summary',
    'ide_checkpoint_task',
```

- [ ] **Step 7: Run the tests, verify they pass**

Run:
```
node --no-warnings --test test/localToolFacade.ideChangesSummary.test.js && node test/localMcpToolDefinitions.test.js && node --no-warnings test/localToolFacade.test.js
```
Expected: PASS — facade test green; tool-definitions test green (names list matches); the broad `localToolFacade.test.js` still green (no regression).

- [ ] **Step 8: Wire the two new backend suites into the regression chain**

`scripts/test-suites.txt` is **one single line** of `&&`-chained commands (no newline before any `&&`). Append, at the very end of that one line, before EOF:

```
 && node --no-warnings --test test/ideChangesSummary.test.js && node --no-warnings --test test/localToolFacade.ideChangesSummary.test.js
```

(Edit the existing single line; do not introduce a newline.)

- [ ] **Step 9: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/src/commands/command-contract.js toad-local/src/mcp/localToolDefinitions.js toad-local/src/tools/localToolFacade.js toad-local/test/localMcpToolDefinitions.test.js toad-local/test/localToolFacade.ideChangesSummary.test.js toad-local/scripts/test-suites.txt && git -c commit.gpgsign=false commit -m "$(printf 'feat(ide): ide_changes_summary read-only command + facade wiring (IDE-2)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

> **Controller verification (entanglement hazard):** before this commit, the controller MUST `git show HEAD:toad-local/src/tools/localToolFacade.js | grep -nE "geminiUsageProbe|getCachedCodexQuota|getCachedGeminiQuota|providerQuota"` on the *staged* content → expect ZERO matches (the IDE-2 facade edit must not sweep in the foreign usage-panel WIP). If any match, unstage and re-stage only the IDE-2 hunks.

---

## Task 3: UI helper module `ideChanges.ts` + tests

**Files:**
- Create: `ui/src/components/ideChanges.ts`
- Test: `ui/test/ideChanges.test.mjs`

Reference pattern for the test harness: `ui/test/ideDiagnostics.test.mjs` (compiles the `.ts` with the project `tsc`, imports the emitted `.js`).

- [ ] **Step 1: Write the failing test**

Create `ui/test/ideChanges.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function compileHelper() {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'toad-ide-changes-'));
  const uiRoot = path.basename(process.cwd()).toLowerCase() === 'ui'
    ? process.cwd()
    : path.resolve('ui');
  const source = path.join(uiRoot, 'src/components/ideChanges.ts');
  const tsc = path.join(uiRoot, 'node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [
    tsc, source,
    '--target', 'ES2022', '--module', 'ES2022',
    '--moduleResolution', 'Bundler', '--outDir', outDir, '--skipLibCheck',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    await rm(outDir, { recursive: true, force: true });
    throw new Error(result.stderr || result.stdout || 'tsc failed');
  }
  return { outDir, mod: await import(pathToFileURL(path.join(outDir, 'ideChanges.js')).href) };
}

test('ideChanges helpers: glyph, count formatting, summary', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    assert.equal(mod.statusGlyph('M'), 'M');
    assert.equal(mod.statusGlyph('?'), '?');
    assert.equal(mod.statusGlyph('Z'), 'Z'); // unknown → first char

    assert.equal(
      mod.formatChangeCounts({ relativePath: 'a', status: 'M', additions: 12, deletions: 3, binary: false }),
      '+12 −3', // "+12 −3" with U+2212 minus
    );
    assert.equal(
      mod.formatChangeCounts({ relativePath: 'a', status: '?', additions: null, deletions: null, binary: false }),
      '—', // em dash
    );
    assert.equal(
      mod.formatChangeCounts({ relativePath: 'a', status: 'M', additions: null, deletions: null, binary: true }),
      'bin',
    );

    assert.equal(mod.summarizeChanges([{ relativePath: 'a' }, { relativePath: 'b' }]), 2);
    assert.equal(mod.summarizeChanges([]), 0);
    assert.equal(mod.summarizeChanges(undefined), 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run (from repo root `C:\Project-TOAD\toad-local`): `node --test ui/test/ideChanges.test.mjs`
Expected: FAIL — `tsc` cannot find `ui/src/components/ideChanges.ts`.

- [ ] **Step 3: Implement the helper module**

Create `ui/src/components/ideChanges.ts`:

```ts
export type IdeChangeStatus = 'M' | 'A' | 'D' | 'R' | '?' | string;

export interface IdeChangeEntry {
  relativePath: string;
  status: IdeChangeStatus;
  additions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface IdeChangesResult {
  source?: unknown;
  files: IdeChangeEntry[];
  error?: string;
}

export function statusGlyph(status: IdeChangeStatus): string {
  switch (status) {
    case 'M': return 'M';
    case 'A': return 'A';
    case 'D': return 'D';
    case 'R': return 'R';
    case '?': return '?';
    default: return status ? String(status).charAt(0) : '•';
  }
}

export function formatChangeCounts(entry: IdeChangeEntry): string {
  if (entry.binary) return 'bin';
  if (entry.additions === null && entry.deletions === null) return '—';
  const add = entry.additions ?? 0;
  const del = entry.deletions ?? 0;
  return `+${add} −${del}`;
}

export function summarizeChanges(files: IdeChangeEntry[] | undefined | null): number {
  return Array.isArray(files) ? files.length : 0;
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `node --test ui/test/ideChanges.test.mjs`
Expected: PASS.

- [ ] **Step 5: Wire the UI suite into the regression chain**

Append to the single line of `scripts/test-suites.txt`, at the very end:

```
 && node --test ui/test/ideChanges.test.mjs
```

- [ ] **Step 6: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/ui/src/components/ideChanges.ts toad-local/ui/test/ideChanges.test.mjs toad-local/scripts/test-suites.txt && git -c commit.gpgsign=false commit -m "$(printf 'feat(ide): ideChanges UI helpers (statusGlyph/formatChangeCounts/summarizeChanges) (IDE-2)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: `BottomPanelChanges` component

**Files:**
- Create: `ui/src/components/cockpit/BottomPanelChanges.tsx`

No React unit harness exists (see Deviation 1); correctness is gated by the `ui` typecheck in Task 8 plus the Task 3 helper tests. Mirror `ui/src/components/cockpit/BottomPanelProblems.tsx` structurally (header with Refresh, list of rows, empty/running/error states, `Icon`).

- [ ] **Step 1: Implement the component**

Create `ui/src/components/cockpit/BottomPanelChanges.tsx`:

```tsx
import { Icon } from '../Icon';
import {
  formatChangeCounts,
  statusGlyph,
  type IdeChangeEntry,
} from '../ideChanges';

export interface BottomPanelChangesProps {
  files: IdeChangeEntry[];
  running?: boolean;
  error?: string | null;
  onOpenChange?: (relativePath: string) => void;
  onRefresh?: () => void;
}

export function BottomPanelChanges({
  files,
  running = false,
  error = null,
  onOpenChange,
  onRefresh,
}: BottomPanelChangesProps) {
  return (
    <div className="bp-changes">
      <div className="bp-problems-head">
        <div className="bp-problems-summary">
          <span className="bp-changes-count">{files.length} changed</span>
          {running && <span className="bp-problems-running">Running</span>}
        </div>
        {onRefresh && (
          <div className="bp-problems-actions">
            <button type="button" className="btn btn-xs" onClick={onRefresh} disabled={running}>
              <Icon name="refresh" size={12} />
              Refresh
            </button>
          </div>
        )}
      </div>

      {error && <div className="bp-problems-error">{error}</div>}

      {files.length === 0 ? (
        <div className="bp-output-empty">
          <div>No changes vs HEAD.</div>
        </div>
      ) : (
        <div className="bp-changes-list">
          {files.map((entry) => (
            <button
              key={entry.relativePath}
              type="button"
              className="bp-change-row"
              onClick={() => onOpenChange?.(entry.relativePath)}
              title={entry.relativePath}
            >
              <span
                className={`bp-change-status status-${entry.status === '?' ? 'untracked' : entry.status.toLowerCase()}`}
                aria-label={`status ${entry.status}`}
              >
                {statusGlyph(entry.status)}
              </span>
              <span className="bp-change-path mono">{entry.relativePath}</span>
              <span className="bp-change-counts mono">{formatChangeCounts(entry)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck the component in isolation**

Run: `cd ui && npx tsc --noEmit --jsx react-jsx --skipLibCheck --moduleResolution Bundler --module ES2022 --target ES2022 src/components/cockpit/BottomPanelChanges.tsx`
Expected: no errors that reference `BottomPanelChanges.tsx` or `ideChanges.ts`. (Standalone-file tsc may emit module-resolution noise for `react`/`./Icon`; the authoritative check is the project build in Task 8. The goal here is to catch syntax/type errors in the new file.)

- [ ] **Step 3: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/ui/src/components/cockpit/BottomPanelChanges.tsx && git -c commit.gpgsign=false commit -m "$(printf 'feat(ide): BottomPanelChanges presentational list (IDE-2)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: `BottomPanel` Changes tab + tweak-type widening

**Files:**
- Modify: `ui/src/components/cockpit/BottomPanel.tsx`
- Modify: `ui/src/types/index.ts:225`

- [ ] **Step 1: Widen `BottomPanelTab` and add the tab**

In `ui/src/components/cockpit/BottomPanel.tsx`:

(a) Line 32 — replace:
```ts
export type BottomPanelTab = 'terminal' | 'problems' | 'output' | 'validations';
```
with:
```ts
export type BottomPanelTab = 'terminal' | 'problems' | 'output' | 'changes' | 'validations';
```

(b) In `BottomPanelProps` (after the `outputCount?: number;` line) add:
```ts
  changeCount?: number;
```

(c) In `BottomPanelProps` tab-content slots (after `outputSlot?: ReactNode;`) add:
```ts
  changesSlot?: ReactNode;
```

(d) In the function signature destructuring (after `outputSlot,`) add `changesSlot,` and (after `outputCount,`) add `changeCount,`.

(e) In the `tabs` array, insert a Changes entry after the `problems` entry:
```ts
    { id: 'problems', label: 'Problems', count: problemCount },
    { id: 'changes', label: 'Changes', count: changeCount },
    { id: 'output', label: 'Output', count: outputCount },
```

(f) In `renderTabBody`'s `switch (activeTab)`, add a `changes` case after the `problems` case:
```ts
      case 'changes':
        return changesSlot ?? <EmptyState label="Changes" hint="No working-tree changes vs HEAD." />;
```

- [ ] **Step 2: Widen the inlined tweak union**

In `ui/src/types/index.ts` line 225, replace:
```ts
  bottomPanelTab: 'terminal' | 'problems' | 'output' | 'validations';
```
with:
```ts
  bottomPanelTab: 'terminal' | 'problems' | 'output' | 'changes' | 'validations';
```

(No other file needs editing: `App.tsx`, `CockpitScreenV2.tsx`, `useTweaks.ts` only pass the value through or default to `'terminal'`; a widened union is assignable. They stay byte-unchanged.)

- [ ] **Step 3: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: the ONLY errors are the two **pre-existing foreign** `App.tsx` `SummaryStatus.quota` errors (the uncommitted usage-panel WIP, not ours). ZERO errors referencing `BottomPanel.tsx` or `types/index.ts`. If `BottomPanel.tsx`/`types/index.ts` produce errors, fix them before committing.

- [ ] **Step 4: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/ui/src/components/cockpit/BottomPanel.tsx toad-local/ui/src/types/index.ts && git -c commit.gpgsign=false commit -m "$(printf 'feat(ide): BottomPanel Changes tab + bottomPanelTab union widened (IDE-2)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: `CockpitWithMe` wiring (state, poll, click→diff)

**Files:**
- Modify: `ui/src/components/cockpit/CockpitWithMe.tsx`

Existing relevant anchors: imports block (lines 1-29), `externalOpenRequest` state (lines 135-137), `editorSource` memo (line 267), `handleOpenDiagnostic` (lines 325-338), `<BottomPanel ...>` JSX (lines 549-568), `errorMessage` helper (lines 640-642).

- [ ] **Step 1: Import the helpers**

After the existing `ideDiagnostics` import block (ends line 29) add:
```ts
import { BottomPanelChanges } from './BottomPanelChanges';
import { summarizeChanges, type IdeChangeEntry, type IdeChangesResult } from '../ideChanges';
```

- [ ] **Step 2: Widen the `externalOpenRequest` state type**

Replace the `externalOpenRequest` state declaration (lines ~135-137):
```ts
  const [externalOpenRequest, setExternalOpenRequest] = useState<
    { sourceKey: string; path: string; requestId: number } | null
  >(null);
```
with:
```ts
  const [externalOpenRequest, setExternalOpenRequest] = useState<
    { sourceKey: string; path: string; requestId: number; mode?: 'diff' } | null
  >(null);
```

- [ ] **Step 3: Add changes state + loader + poll + click handler**

Immediately after the `editorSource` memo (line ~267, `const editorSource: IdeSource = useMemo(() => ({ kind: 'project' }), []);`) add:

```ts
  const [changes, setChanges] = useState<IdeChangeEntry[]>([]);
  const [changesRunning, setChangesRunning] = useState(false);
  const [changesError, setChangesError] = useState<string | null>(null);

  const runChangesSummary = useCallback(async () => {
    if (!treeActor.teamId) return;
    setChangesRunning(true);
    try {
      const result = await callTool<IdeChangesResult>({
        actor: treeActor,
        method: 'ide_changes_summary',
        args: { source: editorSource },
      });
      setChanges(result.files ?? []);
      setChangesError(result.error ?? null);
    } catch (err) {
      // Keep the last good list on a transient failure (spec §6).
      setChangesError(errorMessage(err));
    } finally {
      setChangesRunning(false);
    }
  }, [editorSource, treeActor]);

  // Poll only while the Changes tab is the active bottom-panel tab —
  // zero work when the panel is closed or another tab is active.
  useEffect(() => {
    if (!showBottomPanel || bottomPanelTab !== 'changes') return;
    void runChangesSummary();
    const intervalId = window.setInterval(() => {
      void runChangesSummary();
    }, 4000);
    return () => window.clearInterval(intervalId);
  }, [showBottomPanel, bottomPanelTab, runChangesSummary, activeProjectId]);

  const handleOpenChange = useCallback((relativePath: string) => {
    setActivePath(relativePath);
    setOpenRequestCounter((c) => {
      const next = c + 1;
      setExternalOpenRequest({
        sourceKey: 'project',
        path: relativePath,
        requestId: next,
        mode: 'diff',
      });
      return next;
    });
  }, []);
```

- [ ] **Step 4: Pass props into `BottomPanel`**

In the `<BottomPanel ... >` JSX (around line 549), add `changeCount` next to `outputCount` and a `changesSlot` next to `problemsSlot`:

```tsx
            problemCount={problemCount}
            outputCount={Object.values(agentStreams).reduce((n, arr) => n + arr.length, 0)}
            changeCount={summarizeChanges(changes)}
            problemsSlot={(
```
and, after the closing `/>` of `problemsSlot`'s `<BottomPanelProblems .../>` block, add:
```tsx
            changesSlot={(
              <BottomPanelChanges
                files={changes}
                running={changesRunning}
                error={changesError}
                onOpenChange={handleOpenChange}
                onRefresh={() => void runChangesSummary()}
              />
            )}
```

- [ ] **Step 5: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: only the two pre-existing foreign `App.tsx` `SummaryStatus.quota` errors; ZERO errors referencing `CockpitWithMe.tsx`.

- [ ] **Step 6: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/ui/src/components/cockpit/CockpitWithMe.tsx && git -c commit.gpgsign=false commit -m "$(printf 'feat(ide): CockpitWithMe Changes panel — poll-while-active + click-to-diff (IDE-2)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7: `IdeEditorPane` — additive `mode:'diff'` open path

**Files:**
- Modify: `ui/src/components/IdeEditorPane.tsx`

Anchors: prop type (line 66), props destructure (line 102), `openFile` (lines 136-170), `externalOpenRequest` effect (lines 172-184), `pendingExternalOpen` effect (lines 186-191), `loadDiff` (lines 389-401).

- [ ] **Step 1: Widen the `externalOpenRequest` prop type**

Line 66 — replace:
```ts
  externalOpenRequest: { sourceKey: string; path: string; requestId: number } | null;
```
with:
```ts
  externalOpenRequest: { sourceKey: string; path: string; requestId: number; mode?: 'diff' } | null;
```

- [ ] **Step 2: Refactor `loadDiff` into a path-scoped helper (DRY, no `activeTabPath` race)**

Replace the whole `loadDiff` function (lines 389-401) with:
```ts
  async function loadDiffForPath(relativePath: string) {
    if (!actor.teamId || !relativePath) return;
    try {
      const result = await callTool<{ diff: string }>({
        actor,
        method: 'ide_get_diff',
        args: { source, relativePath },
      });
      setTabs(prev => prev.map(t => t.path === relativePath ? { ...t, diffContent: result.diff || 'No changes.', editorMode: 'diff' } : t));
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === relativePath ? { ...t, fileError: errorMessage(err) } : t));
    }
  }

  async function loadDiff() {
    if (!activeTabPath) return;
    await loadDiffForPath(activeTabPath);
  }
```
(All existing `loadDiff()` call sites — the "View Diff" toggle — keep working unchanged.)

- [ ] **Step 3: Thread `mode` through `openFile`**

Change the `openFile` signature (line 136) and both exit branches:

```ts
  async function openFile(relativePath: string, mode?: 'diff') {
    if (!actor.teamId) return;

    // Switch to tab if already open
    if (tabs.some(t => t.path === relativePath)) {
      setActiveTabPath(relativePath);
      if (mode === 'diff') await loadDiffForPath(relativePath);
      return;
    }
```
…and at the end of the new-tab branch, after the `try { ... } catch { ... }` that reads the file (the block ending at line ~169, right before the closing `}` of `openFile`), add:
```ts
    if (mode === 'diff') await loadDiffForPath(relativePath);
  }
```
(So the function reads the file into a fresh tab, then — if a diff was requested — loads the diff for that exact path. `loadDiffForPath` targets the tab by `path`, independent of `activeTabPath`, so there is no ordering race.)

- [ ] **Step 4: Pass `mode` from the external-open effects**

`externalOpenRequest` effect (line ~182) — replace `void openFile(externalOpenRequest.path);` with:
```ts
    void openFile(externalOpenRequest.path, externalOpenRequest.mode);
```
The source-mismatch branch (line ~179) — replace the `setPendingExternalOpen({...})` call with one that carries `mode`:
```ts
      setPendingExternalOpen({ sourceKey: externalOpenRequest.sourceKey, path: externalOpenRequest.path, mode: externalOpenRequest.mode });
```
`pendingExternalOpen` effect (line ~188) — replace `void openFile(pendingExternalOpen.path);` with:
```ts
    void openFile(pendingExternalOpen.path, pendingExternalOpen.mode);
```

- [ ] **Step 5: Widen the `pendingExternalOpen` state type**

Find the `pendingExternalOpen` `useState` declaration (search `setPendingExternalOpen` / `const [pendingExternalOpen`). Its type is `{ sourceKey: string; path: string } | null`. Replace with:
```ts
  const [pendingExternalOpen, setPendingExternalOpen] = useState<
    { sourceKey: string; path: string; mode?: 'diff' } | null
  >(null);
```
(Match the existing initializer; only the generic type argument gains `mode?: 'diff'`.)

- [ ] **Step 6: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: only the two pre-existing foreign `App.tsx` `SummaryStatus.quota` errors; ZERO errors referencing `IdeEditorPane.tsx`. All existing `IdeEditorPane` callers omit `mode` (the Code screen, the file-tree click, diagnostics open) and compile unchanged.

- [ ] **Step 7: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/ui/src/components/IdeEditorPane.tsx && git -c commit.gpgsign=false commit -m "$(printf 'feat(ide): IdeEditorPane optional mode:diff external-open path (IDE-2)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 8: Whole-implementation verification & scope-proof

**Files:** none (verification only).

- [ ] **Step 1: Full backend regression chain against the COMMITTED tree**

The working tree carries the foreign uncommitted usage-panel WIP, which makes the dirty-tree gate fail on unrelated code. Run the gate against committed state using the IDE-1 swap/restore procedure:

```bash
cd /c/Project-TOAD/toad-local
cp src/tools/localToolFacade.js /tmp/localToolFacade.foreignwip.bak
git show HEAD:toad-local/src/tools/localToolFacade.js > src/tools/localToolFacade.js
bash -c "$(cat scripts/test-suites.txt)"; echo "GATE_EXIT=$?"
cp /tmp/localToolFacade.foreignwip.bak src/tools/localToolFacade.js
```
Expected: `GATE_EXIT=0`; the new `ideChangesSummary`, `localToolFacade.ideChangesSummary`, and `ideChanges` suites all run and pass; zero failures.

- [ ] **Step 2: UI typecheck**

Run: `cd ui && npm run typecheck`
Expected: the ONLY errors are the two known pre-existing foreign `App.tsx` `SummaryStatus.quota` errors. ZERO errors in any IDE-2 file (`ideChanges.ts`, `BottomPanelChanges.tsx`, `BottomPanel.tsx`, `types/index.ts`, `CockpitWithMe.tsx`, `IdeEditorPane.tsx`).

- [ ] **Step 3: Scope-proof — required files byte-unchanged**

```bash
cd /c/Project-TOAD/toad-local
git diff --stat HEAD~7..HEAD -- \
  ui/src/App.tsx \
  ui/src/components/cockpit/CockpitScreenV2.tsx \
  ui/src/hooks/useTweaks.ts \
  ui/src/components/cockpit/CockpitForMe.tsx
```
Expected: **empty output** (none of these files appear in the IDE-2 commit range). If any appears, the change is out of scope — revert that hunk.

- [ ] **Step 4: Confirm the only "extra" shared file touched is `ui/src/types/index.ts`**

```bash
git diff --name-only HEAD~7..HEAD -- toad-local/ui/src | sort
```
Expected exactly: `ideChanges.ts`, `cockpit/BottomPanelChanges.tsx`, `cockpit/BottomPanel.tsx`, `cockpit/CockpitWithMe.tsx`, `IdeEditorPane.tsx`, `types/index.ts`, `test/ideChanges.test.mjs` (paths relative as git prints them). No FOR me / persona / `CockpitScreenV2` / `useTweaks` / `App.tsx`.

- [ ] **Step 5: Final whole-implementation code review**

Per superpowers:subagent-driven-development, dispatch the final code-reviewer over `HEAD~7..HEAD` (the seven IDE-2 commits). Confirm: read-only command correctness, numstat/porcelain merge edge cases, the `externalOpenRequest.mode` backward-compat, no foreign WIP in any commit, byte-unchanged invariant. Address Critical/Important before proceeding to finishing-a-development-branch.

- [ ] **Step 6: Hand off to finishing-a-development-branch**

All tasks complete and reviewed → invoke superpowers:finishing-a-development-branch (gate already green against committed state from Step 1; scope-proof from Steps 3-4). Then update `MEMORY.md` / `ide_program.md` with the IDE-2 DONE entry.

---

## Self-Review

**1. Spec coverage:**
- Spec §2 change source (working tree vs HEAD, no attribution) → Task 1 (`git diff HEAD --numstat` ⊕ `git status --porcelain`).
- Spec §2 placement (Changes bottom-panel tab) → Task 5.
- Spec §2 click → diff view → Task 6 (`handleOpenChange` `mode:'diff'`) + Task 7 (`IdeEditorPane` honors it).
- Spec §2 refresh (poll while tab active + manual Refresh) → Task 6 poll effect + Task 4 Refresh button.
- Spec §4.1 module (injectable runGit, graceful failure, untracked `?`/null, binary, rename) → Task 1 tests + impl.
- Spec §4.2 facade + MCP wiring + entanglement controller-verify → Task 2 (+ Step 7 grep guard).
- Spec §5.1 `ideChanges.ts` → Task 3. §5.2 `BottomPanelChanges` → Task 4. §5.3 `BottomPanel` → Task 5. §5.4 `CockpitWithMe` → Task 6.
- Spec §6 open-in-diff additive + error-keeps-last-list → Task 7 + Task 6 Step 3 catch comment.
- Spec §7 scope guard → Task 8 Steps 3-4. Spec §8 testing + single-line suites → Tasks 1/2/3 + Task 8 Step 1. Spec §9 YAGNI honored (no attribution/staging/badges/toggle; quoted-path dequoting explicitly deferred in Task 1).

**2. Placeholder scan:** No TBD/TODO; every code step has complete code; every command has expected output. Deviations (no React harness; `types/index.ts`; tool-name allowlist) documented up front and handled in concrete steps.

**3. Type consistency:** `IdeChangeEntry`/`IdeChangesResult` defined in Task 3, consumed identically in Tasks 4/6. Backend entry shape `{relativePath,status,additions,deletions,binary}` identical across Task 1 impl/tests and Task 2 facade test. `mode?: 'diff'` identical across Task 6 (`externalOpenRequest` state), Task 7 (prop + `pendingExternalOpen` + `openFile` param). `BottomPanelTab` widened with `'changes'` consistently in Task 5 (BottomPanel.tsx) and the inlined union (types/index.ts); `summarizeChanges`/`statusGlyph`/`formatChangeCounts` names match between Task 3 definition and Task 4/6 use.
