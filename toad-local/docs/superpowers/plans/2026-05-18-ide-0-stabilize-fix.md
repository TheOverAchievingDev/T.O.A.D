# IDE-0 — Stabilize & Fix the WITH me IDE — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the WITH me IDE durable and project-aware: fix the titlebar project-switch so the WITH me file tree/editor follow the active project, then commit the verified-but-uncommitted WITH me IDE work and wire its suites into the root gate.

**Architecture:** One behavior fix extracted into a small injected-deps helper (`projectSwitchAction.ts`) so it is unit-testable the repo's standard way (tsc-compile + `node:test` `.mjs`), with `App.tsx`'s `onSelectProject` reduced to a one-line call. Then a verify→scoped-commit→gate-wire sequence that lands the already-green IDE layers without sweeping unrelated workstreams.

**Tech Stack:** React + TypeScript UI (Vite, `tsc -b`), Node.js ESM backend, `node:test`, repo root test gate `scripts/test-suites.txt`, git (commit directly to `main`).

---

## Spec

Source spec: `docs/superpowers/specs/2026-05-18-ide-0-stabilize-fix-design.md`. Read it. Non-negotiable constraints from it:

- **FOR me is untouched.** Do not modify `CockpitForMe.tsx`, the `FOR me / WITH me` persona pill, `developerMode`, `CockpitScreenV2`, `useTweaks`, or any default/tweak.
- **No UI rewrite.** The only UI source change is `App.tsx`'s `onSelectProject` body + one new non-UI helper file + its test.
- **Commit hygiene.** Only the IDE file-set. Never `git add -A`. Never stage `ui/src/components/PlanUsagePanel.tsx`, `src/providers/geminiUsageProbe.js`, `capture-gemini-*.js`, `Reference material/`, `code_audit.md`, `upstream-reference/`, `website-publish/`. Verify each tracked-modified file's diff is IDE work before staging; hunk-stage anything mixed.
- **Verify, do not assume.** Mark a plan checkbox `[x]` only when the referenced code + green test actually exist; otherwise leave `[ ]` with a one-line deferred note.

---

## File Structure

- Create `ui/src/components/projectSwitchAction.ts` — pure, injected-deps async function `switchToRegisteredProjectByPath(deps, targetPath)` that performs the proven switch sequence (resolve by path → `switchToProjectPath` → `setActive` → `refreshAfterProjectSwitch`). One responsibility: the titlebar quick-switch action, testable without React.
- Create `ui/test/projectSwitchAction.test.mjs` — tsc-compile + `node:test` coverage for the helper (mirrors `ui/test/projectSwitching.test.mjs` / `ui/test/ideFilePresentation.test.mjs`).
- Modify `ui/src/App.tsx` — `onSelectProject` prop body only: replace the `setActive`-only handler with a call into the helper. No other line changes.
- Modify `scripts/test-suites.txt` — append the 4 backend IDE suites + 4 UI IDE suites to the single-line `&&` chain (no newline before `&&`).
- Commit (no edits) the verified IDE file-set: `src/ide/fileClassification.js`, `src/ide/python/*`, `src/ide/ideFileTools.js`, `src/commands/command-contract.js`, `src/tools/localToolFacade.js`, `src/mcp/localToolDefinitions.js`, `src/app/LocalToadRuntime.js` (IDE hunks only), `test/ideFileClassification.test.js`, `test/ideFileTools.compatibility.test.js`, `test/idePythonDiagnosticParsers.test.js`, `test/localToolFacade.idePythonDiagnostics.test.js`, `test/localMcpToolDefinitions.test.js`, `test/roleAuthority.test.js`, `ui/src/components/ideSource.ts`, `ui/src/components/codeTreeNavigator.ts`, `ui/src/components/ideFilePresentation.ts`, `ui/src/components/ideDiagnostics.ts`, `ui/src/components/cockpit/BottomPanelProblems.tsx`, `ui/src/components/cockpit/cockpitTreeActor.ts`, `ui/src/styles/app-shell.css`, `ui/src/styles/cockpit.css`, `ui/test/ideFilePresentation.test.mjs`, `ui/test/ideDiagnostics.test.mjs`, `ui/test/cockpitTreeActor.test.mjs`, the 2 IDE plans + 2 IDE specs.

---

## Task 1: Failing test for the project-switch helper (RED)

**Files:**
- Test: `ui/test/projectSwitchAction.test.mjs` (create)

- [ ] **Step 1: Write the failing test**

Create `ui/test/projectSwitchAction.test.mjs` (compile pattern copied from `ui/test/ideFilePresentation.test.mjs`; recorder-style mocks, `node:test` only):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function compileHelper() {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'toad-project-switch-'));
  const source = path.resolve('ui/src/components/projectSwitchAction.ts');
  const tsc = path.resolve('ui/node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [
    tsc,
    source,
    '--target', 'ES2022',
    '--module', 'ES2022',
    '--moduleResolution', 'Bundler',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    await rm(outDir, { recursive: true, force: true });
    throw new Error(result.stderr || result.stdout || 'tsc failed');
  }
  return { outDir, mod: await import(pathToFileURL(path.join(outDir, 'projectSwitchAction.js')).href) };
}

function makeDeps(overrides = {}) {
  const calls = { switchToProjectPath: [], setActive: [], refresh: 0, errors: [] };
  const deps = {
    projects: [{ id: 'p_1', path: 'C:/a' }, { id: 'p_2', path: 'C:/b' }],
    switchToProjectPath: async (p) => { calls.switchToProjectPath.push(p); return { path: p, name: 'b' }; },
    setActive: (id) => { calls.setActive.push(id); },
    refreshAfterProjectSwitch: () => { calls.refresh += 1; },
    onError: (e) => { calls.errors.push(e); },
    ...overrides,
  };
  return { deps, calls };
}

test('unknown path: returns false and performs no switch side effects', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    const { deps, calls } = makeDeps();
    const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/does-not-exist');
    assert.equal(ok, false);
    assert.deepEqual(calls.switchToProjectPath, []);
    assert.deepEqual(calls.setActive, []);
    assert.equal(calls.refresh, 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('known path + successful switch: respawns sidecar, then setActive, then refresh', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    const { deps, calls } = makeDeps();
    const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/b');
    assert.equal(ok, true);
    assert.deepEqual(calls.switchToProjectPath, ['C:/b']);
    assert.deepEqual(calls.setActive, ['p_2']);
    assert.equal(calls.refresh, 1);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('switchToProjectPath returns null: no setActive, no refresh, returns false', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    const { deps, calls } = makeDeps({ switchToProjectPath: async () => null });
    const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/b');
    assert.equal(ok, false);
    assert.deepEqual(calls.setActive, []);
    assert.equal(calls.refresh, 0);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('switchToProjectPath throws: onError called, returns false, no setActive/refresh', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    const boom = new Error('switch_project failed');
    const { deps, calls } = makeDeps({ switchToProjectPath: async () => { throw boom; } });
    const ok = await mod.switchToRegisteredProjectByPath(deps, 'C:/b');
    assert.equal(ok, false);
    assert.deepEqual(calls.setActive, []);
    assert.equal(calls.refresh, 0);
    assert.deepEqual(calls.errors, [boom]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test ui/test/projectSwitchAction.test.mjs`

Expected: FAIL — `tsc failed` / module not found because `ui/src/components/projectSwitchAction.ts` does not exist yet.

---

## Task 2: Implement the helper, wire `App.tsx`, commit (GREEN)

**Files:**
- Create: `ui/src/components/projectSwitchAction.ts`
- Modify: `ui/src/App.tsx` (the `onSelectProject` prop on `<Titlebar>`, currently at the `projects={...}` / `onSelectProject={...}` block)
- Test: `ui/test/projectSwitchAction.test.mjs`

- [ ] **Step 1: Create the helper**

Create `ui/src/components/projectSwitchAction.ts`:

```ts
/**
 * IDE-0: the titlebar project-dropdown quick-switch action.
 *
 * Mirrors App.tsx's already-correct `openRegisteredProject` switch
 * sequence (resolve project → respawn the backend sidecar via
 * `switchToProjectPath` → mark active → refresh team-scoped state) so
 * the WITH me file tree/editor follow the active project. It
 * deliberately does NOT navigate the screen — a titlebar quick-switch
 * should not move the user off whatever screen they are on.
 *
 * Pure + injected-deps so it is unit-testable without React (the
 * repo's standard `ui/src/components/*.ts` + `ui/test/*.test.mjs`
 * pattern).
 */

export interface ProjectSwitchDeps {
  /** The registry's projects (only id + path are used here). */
  projects: ReadonlyArray<{ id: string; path: string }>;
  /** integrations/tauri.ts switchToProjectPath — respawns the sidecar. */
  switchToProjectPath: (targetPath: string) => Promise<unknown | null>;
  /** useProjects().setActive. */
  setActive: (id: string) => void;
  /** App.tsx's refreshAfterProjectSwitch (clear-then-repopulate). */
  refreshAfterProjectSwitch: () => void;
  /** Optional error sink (App.tsx logs via console.error). */
  onError?: (err: unknown) => void;
}

/**
 * Returns true when the active project actually changed (sidecar
 * respawned + state refreshed), false for unknown path / aborted
 * switch / error.
 */
export async function switchToRegisteredProjectByPath(
  deps: ProjectSwitchDeps,
  targetPath: string,
): Promise<boolean> {
  const found = deps.projects.find((p) => p.path === targetPath);
  if (!found) return false;
  try {
    const switched = await deps.switchToProjectPath(targetPath);
    if (!switched) return false;
    deps.setActive(found.id);
    deps.refreshAfterProjectSwitch();
    return true;
  } catch (err) {
    deps.onError?.(err);
    return false;
  }
}
```

- [ ] **Step 2: Run the helper test to verify it passes**

Run: `node --test ui/test/projectSwitchAction.test.mjs`

Expected: PASS — `# pass 4`, `# fail 0`.

- [ ] **Step 3: Wire `App.tsx`'s `onSelectProject` to the helper**

In `ui/src/App.tsx`, add this import alongside the other `@/components/...` imports (near the top import block, e.g. after the `useProjects` import line):

```ts
import { switchToRegisteredProjectByPath } from '@/components/projectSwitchAction';
```

Then replace exactly this existing block (it appears once, on the `<Titlebar>` element):

```tsx
        projects={projectRegistry.projects.map((p) => ({ name: p.name, path: p.path }))}
        onSelectProject={(path) => {
          const found = projectRegistry.projects.find((p) => p.path === path);
          if (found) projectRegistry.setActive(found.id);
        }}
```

with:

```tsx
        projects={projectRegistry.projects.map((p) => ({ name: p.name, path: p.path }))}
        onSelectProject={(path) => {
          void switchToRegisteredProjectByPath(
            {
              projects: projectRegistry.projects,
              switchToProjectPath,
              setActive: projectRegistry.setActive,
              refreshAfterProjectSwitch,
              // eslint-disable-next-line no-console
              onError: (err) => console.error('switch_project failed:', err),
            },
            path,
          );
        }}
```

(`switchToProjectPath` is already imported in `App.tsx`; `refreshAfterProjectSwitch` and `projectRegistry` are already in scope. No other line changes.)

- [ ] **Step 4: UI typecheck**

Run (from `ui/`): `npm run typecheck`

Expected: exits 0. If the only error is the pre-existing `SummaryStatus.quota` issue, record it verbatim and proceed — do NOT edit unrelated quota code.

- [ ] **Step 5: Inspect `App.tsx` for a mixed diff, then hunk-stage**

Run: `git -C C:/Project-TOAD diff -- toad-local/ui/src/App.tsx`

If the diff contains ONLY the import line + the `onSelectProject` change: `git -C C:/Project-TOAD add toad-local/ui/src/App.tsx`.
If it ALSO contains pre-existing unrelated lines from another workstream: stage only IDE-0's hunks with `git -C C:/Project-TOAD add -p toad-local/ui/src/App.tsx` (accept the import + onSelectProject hunks, skip the rest). Record what was skipped.

- [ ] **Step 6: Commit**

```bash
git -C /c/Project-TOAD add toad-local/ui/src/components/projectSwitchAction.ts toad-local/ui/test/projectSwitchAction.test.mjs
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "fix(ide): titlebar project switch respawns the sidecar so the WITH me file tree follows the active project (IDE-0)

onSelectProject only called projectRegistry.setActive — the backend
sidecar kept serving the boot-pinned projectCwd, so the WITH me file
tree never changed. Route it through the proven switchToProjectPath +
refreshAfterProjectSwitch sequence via a unit-tested injected-deps
helper. FOR me / persona pill / developerMode / CockpitScreenV2 / tweaks
untouched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

(`App.tsx` was already staged in Step 5; it is included in this commit.)

---

## Task 3: Verify the uncommitted IDE work (no commit)

**Files:** none modified. Produces the truth that drives Tasks 4–5.

- [ ] **Step 1: Run the 4 backend IDE suites**

Run:

```powershell
node --no-warnings --test test/ideFileClassification.test.js test/ideFileTools.compatibility.test.js test/idePythonDiagnosticParsers.test.js test/localToolFacade.idePythonDiagnostics.test.js
```

Expected: `# fail 0`. Record the pass counts.

- [ ] **Step 2: Run the IDE-affected existing backend suites**

Run:

```powershell
node --no-warnings --test test/localMcpToolDefinitions.test.js test/roleAuthority.test.js
```

Expected: `# fail 0`.

- [ ] **Step 3: Run the UI IDE helper suites**

Run:

```powershell
node --test ui/test/ideFilePresentation.test.mjs ui/test/ideDiagnostics.test.mjs ui/test/cockpitTreeActor.test.mjs
```

Expected: `# fail 0`.

- [ ] **Step 4: UI typecheck + build**

Run (from `ui/`):

```powershell
npm run typecheck
npm run build
```

Expected: both exit 0 (Vite "large chunk" warnings are acceptable when build exits 0). If `typecheck` fails ONLY on the pre-existing `SummaryStatus.quota` error, record it verbatim and continue; that is not an IDE-0 regression and must not be silently edited.

- [ ] **Step 5: Per-plan completion triage**

For `docs/superpowers/plans/2026-05-18-ide-file-compatibility.md` and `…-python-ide-diagnostics.md`, for each task: confirm the referenced files exist and contain the referenced symbols (read them), and the task's referenced test is green. Build a checklist of which tasks are genuinely complete vs not. Do not edit the plan files yet — that happens in Task 5. If a task is NOT complete, note it as "(deferred — not blocking; IDE-0 ships the verified layers)"; do NOT implement missing feature work (that is IDE-1/IDE-2 / a separate finish of those plans, and is out of IDE-0 scope).

- [ ] **Step 6: BLOCK check**

If any suite in Steps 1–3 fails, or `npm run build` fails for an IDE reason, STOP and report BLOCKED with the failing output — do not commit broken work. (Spec §1 recorded these suites green on 2026-05-18; a failure means the tree changed and needs triage before landing.)

> **RESOLVED 2026-05-18 (spec §10):** Task 3 blocked as designed —
> `npm run build` is red because `main` already shipped
> `CockpitWithMe.tsx` (python-diag T9) without the matching
> `IdeEditorPane.tsx` (file-compat T4 + python-diag T10), and the
> uncommitted `ideSource.ts` union adds 12 more `tsc` errors. Backend
> + helper suites all green. User decision: finish `IdeEditorPane.tsx`
> and ship build-green → **Task 3B** below, before the scoped commits.

---

## Task 3B: Complete `IdeEditorPane.tsx` integration (build-green gate)

**Files:**
- Modify: `ui/src/components/IdeEditorPane.tsx`
- Reference (read, do not edit): `ui/src/components/ideFilePresentation.ts`, `ui/src/components/ideDiagnostics.ts`, `ui/src/components/ideSource.ts`, `ui/src/components/cockpit/CockpitWithMe.tsx`, and the two source plans' detailed specs: `docs/superpowers/plans/2026-05-18-ide-file-compatibility.md` (Task 4 Steps 3–4) and `docs/superpowers/plans/2026-05-18-python-ide-diagnostics.md` (Task 10).
- Styles: already present — `app-shell.css` (`.code-unsupported-file`, `.code-unsupported-card`) and `cockpit.css` — do **not** add styles.

This is a large-existing-file React/Monaco integration; there is no React-render harness, so the objective red→green gate is the TypeScript build. The pure logic it consumes (`isEditableIdeFile`/`languageForFile`/`unsupportedReason` in `ideFilePresentation.ts`; `toMonacoMarkerData`/`diagnosticsForPath`/`countDiagnosticsBySeverity`/`groupDiagnosticsByFile`/`isPythonPath` in `ideDiagnostics.ts`) already exists and is unit-tested green — do not reimplement it; import and wire it.

- [ ] **Step 1: Capture the RED build state**

Run from `ui/`: `npm run typecheck 2>&1`

Record the full error list. Expected ≈14 errors: 12 in `IdeEditorPane.tsx` (`.content` ×~10, `.sha256` ×1, plus the `CockpitWithMe.tsx`→`IdeEditorPane` `diagnostics`-prop `TS2322`), and the 2 pre-existing unrelated `App.tsx:1255-1256 SummaryStatus.quota` errors (a non-IDE usage workstream — NOT yours, do not touch). This is the failing state.

- [ ] **Step 2: file-compat Task 4 — narrow the `IdeFileResult` union**

Read `ui/src/components/IdeEditorPane.tsx` and `ui/src/components/ideFilePresentation.ts`. Apply file-compat plan Task 4 Steps 3–4 exactly:

- Add import: `import { isEditableIdeFile, languageForFile, unsupportedReason } from './ideFilePresentation';`
- Replace dirty/`content`/`sha256` accesses so they only touch the editable branch: `const activeTabEditable = isEditableIdeFile(activeTab?.file);` and gate `isDirty`/`isAnyDirty`/`saveFile`/`revertFile` on `isEditableIdeFile(...)` (a non-editable tab can never be dirty/saved/reverted). Every `IdeFileResult` `.content`/`.sha256` read must be inside an `isEditableIdeFile()`-narrowed branch.
- Editor `language=` uses `languageForFile(activeTab.file.relativePath, activeTab.file.languageHint)` (keep `'diff'` for diff mode).
- Render the unsupported-file panel (class `code-unsupported-file` / `code-unsupported-card`, fields: name, path, size, category, `unsupportedReason(file)`) when `activeTab.file && !isEditableIdeFile(activeTab.file)`; render the existing Monaco/Markdown block only when editable. Disable Save/Revert/edit-only buttons for non-editable tabs.

- [ ] **Step 3: python-diag Task 10 — diagnostics props + Monaco markers + actions**

Read `ui/src/components/ideDiagnostics.ts` and the props `CockpitWithMe.tsx` passes to `<IdeEditorPane>` (`diagnostics`, `diagnosticNavigationTarget`, `onRunDiagnosticsRequest`, `onDiagnosticsResult`). Apply python-diag plan Task 10 exactly:

- Add to `interface IdeEditorPaneProps` (optional props, matching how `CockpitWithMe` calls them): `diagnostics?: IdeDiagnostic[]`; `diagnosticNavigationTarget?: { path: string; line: number; column: number; requestId: number } | null`; `onRunDiagnosticsRequest?: (path?: string) => Promise<IdeDiagnosticsResult | null>`; `onDiagnosticsResult?: (result: IdeDiagnosticsResult | null | undefined) => void`. Import the types from `./ideDiagnostics`.
- Apply Monaco markers for the active tab using marker owner string exactly `symphony-python-diagnostics` via `monaco.editor.setModelMarkers`, converting diagnostics with the existing `ideDiagnostics` helper (`toMonacoMarkerData` or equivalent). Update markers when diagnostics / active tab / saved content change; clear them on tab close, file change, and unmount.
- Add Python-only file-toolbar buttons (visible when `isPythonPath(activeTab.path)` and the tab is editable): Run diagnostics, Format, Fix — wired to `onRunDiagnosticsRequest` and the existing save/format/fix call sites `CockpitWithMe` already provides; disable while saving/running.
- Apply `diagnosticNavigationTarget`: when it changes and matches the active model, `editor.setPosition({lineNumber,column})` + `editor.revealPositionInCenter(...)`.
- Markdown preview behavior unchanged. Do not change any non-IDE logic.

- [ ] **Step 4: GREEN — typecheck**

Run from `ui/`: `npm run typecheck`

Expected: the ONLY remaining errors are the 2 pre-existing `App.tsx:1255-1256 SummaryStatus.quota` (unrelated non-IDE usage workstream — leave verbatim, do not edit). Zero `IdeEditorPane.tsx` errors, zero `CockpitWithMe.tsx` prop errors. If any IDE error remains, fix it in `IdeEditorPane.tsx` only and re-run.

- [ ] **Step 5: GREEN — build + IDE suites unaffected**

Run from `ui/`: `npm run build` → expect exit 0 (Vite large-chunk warnings OK).
Run from repo root: `node --test ui/test/ideFilePresentation.test.mjs ui/test/ideDiagnostics.test.mjs ui/test/cockpitTreeActor.test.mjs ui/test/projectSwitchAction.test.mjs` → expect `# fail 0` (proving the helper layer + Task 1-2 still green).

- [ ] **Step 6: Self-review the diff**

`git -C C:/Project-TOAD diff -- toad-local/ui/src/components/IdeEditorPane.tsx`. Confirm: only `IdeEditorPane.tsx` changed; no FOR me / persona / `CockpitScreenV2` / `useTweaks` / `CockpitForMe` touched; no style files added; no non-IDE logic altered; the pre-existing `SummaryStatus.quota` App.tsx hunk NOT touched. Do NOT commit yet — `IdeEditorPane.tsx` is staged & committed in Task 5 with the rest of the UI IDE file-set.

---

## Task 4: Scoped commit — backend IDE layers

**Files (commit, no edits):** `src/ide/fileClassification.js`, `src/ide/python/` (all files within), `src/ide/ideFileTools.js`, `src/commands/command-contract.js`, `src/tools/localToolFacade.js`, `src/mcp/localToolDefinitions.js`, `src/app/LocalToadRuntime.js` (IDE hunks only), `test/ideFileClassification.test.js`, `test/ideFileTools.compatibility.test.js`, `test/idePythonDiagnosticParsers.test.js`, `test/localToolFacade.idePythonDiagnostics.test.js`, `test/localMcpToolDefinitions.test.js`, `test/roleAuthority.test.js`.

- [ ] **Step 1: Inspect each tracked-modified backend file's diff**

Run:

```powershell
git -C C:/Project-TOAD diff -- toad-local/src/ide/ideFileTools.js toad-local/src/commands/command-contract.js toad-local/src/tools/localToolFacade.js toad-local/src/mcp/localToolDefinitions.js toad-local/src/app/LocalToadRuntime.js toad-local/test/localMcpToolDefinitions.test.js toad-local/test/roleAuthority.test.js
```

Confirm every hunk is IDE work (file classification, `ide_*` commands/tool defs, IDE diagnostics dispatch/wiring, IDE tool-def counts, IDE command authority). `src/security/roleAuthority.js` is NOT modified (git status shows only its test changed) — do not stage it; nothing to add there.

- [ ] **Step 2: Stage the unambiguous IDE backend files**

```bash
git -C /c/Project-TOAD add \
  toad-local/src/ide/fileClassification.js \
  toad-local/src/ide/python \
  toad-local/src/ide/ideFileTools.js \
  toad-local/src/commands/command-contract.js \
  toad-local/src/tools/localToolFacade.js \
  toad-local/src/mcp/localToolDefinitions.js \
  toad-local/test/ideFileClassification.test.js \
  toad-local/test/ideFileTools.compatibility.test.js \
  toad-local/test/idePythonDiagnosticParsers.test.js \
  toad-local/test/localToolFacade.idePythonDiagnostics.test.js \
  toad-local/test/localMcpToolDefinitions.test.js \
  toad-local/test/roleAuthority.test.js
```

- [ ] **Step 3: Stage `LocalToadRuntime.js` IDE hunks only**

`src/app/LocalToadRuntime.js` is a core file other workstreams also touch. From the Step 1 diff: if its ~5 changed lines are all IDE wiring (passing `projectCwd`/`taskBoard` into the new IDE commands), `git -C C:/Project-TOAD add toad-local/src/app/LocalToadRuntime.js`. If any hunk is non-IDE, `git -C C:/Project-TOAD add -p toad-local/src/app/LocalToadRuntime.js` and accept only IDE hunks. Record the decision.

- [ ] **Step 4: Confirm nothing out-of-scope is staged**

Run: `git -C C:/Project-TOAD status --porcelain`

Assert NONE of these are staged: `toad-local/ui/src/components/PlanUsagePanel.tsx`, `toad-local/src/providers/geminiUsageProbe.js`, `toad-local/capture-gemini-*.js`, `Reference material/`, `code_audit.md`, `upstream-reference/`, `website-publish/`. If any is staged, `git -C C:/Project-TOAD restore --staged <path>`.

- [ ] **Step 5: Commit**

```bash
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(ide): land verified backend IDE file-compat + Python diagnostics (IDE-0 stabilize)

File classification (broad language/binary/oversized metadata) + Ruff/
Mypy diagnostics/format/fix command surface + tool defs + authority.
All suites green (ideFileClassification, ideFileTools.compatibility,
idePythonDiagnosticParsers, localToolFacade.idePythonDiagnostics,
localMcpToolDefinitions, roleAuthority). Previously implemented but
uncommitted; this makes it durable. No FOR me / persona / runtime
adapter code touched.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Scoped commit — UI IDE layer, plan/spec docs, gate wiring

**Files:**
- Modify: `scripts/test-suites.txt`
- Modify (checkboxes only, truthfully): `docs/superpowers/plans/2026-05-18-ide-file-compatibility.md`, `docs/superpowers/plans/2026-05-18-python-ide-diagnostics.md`
- Commit (no edits): `ui/src/components/ideSource.ts`, `ui/src/components/codeTreeNavigator.ts`, `ui/src/components/ideFilePresentation.ts`, `ui/src/components/ideDiagnostics.ts`, `ui/src/components/cockpit/BottomPanelProblems.tsx`, `ui/src/components/cockpit/cockpitTreeActor.ts`, `ui/src/styles/app-shell.css`, `ui/src/styles/cockpit.css`, `ui/test/ideFilePresentation.test.mjs`, `ui/test/ideDiagnostics.test.mjs`, `ui/test/cockpitTreeActor.test.mjs`, the 2 IDE specs.

- [ ] **Step 1: Wire the IDE suites into the root gate**

`scripts/test-suites.txt` is ONE line. It currently ends with the token `node --no-warnings --test test/bundle/a4ProbeE2e.test.js`. Append (single line, a leading ` && `, NO newline before `&&`). Replace exactly:

```
 && node --no-warnings --test test/bundle/a4ProbeE2e.test.js
```

with:

```
 && node --no-warnings --test test/bundle/a4ProbeE2e.test.js && node --no-warnings --test test/ideFileClassification.test.js && node --no-warnings --test test/ideFileTools.compatibility.test.js && node --no-warnings --test test/idePythonDiagnosticParsers.test.js && node --no-warnings --test test/localToolFacade.idePythonDiagnostics.test.js && node --test ui/test/ideFilePresentation.test.mjs && node --test ui/test/ideDiagnostics.test.mjs && node --test ui/test/cockpitTreeActor.test.mjs && node --test ui/test/projectSwitchAction.test.mjs
```

(Confirm the file is still exactly one line afterward: `(Get-Content scripts/test-suites.txt | Measure-Object -Line).Lines` is `1`.)

- [ ] **Step 2: Mark plan checkboxes truthfully**

Using the Task 3 Step 5 triage, in each of the two IDE plan files set `- [ ]` → `- [x]` ONLY for tasks verified complete. For any task not complete, leave `- [ ]` and append on that line: ` (deferred — not blocking; IDE-0 ships the verified layers, finish tracked separately)`. Add a one-line banner under each plan's header: `> IDE-0 (2026-05-18): verified layers committed. Completion state per task reflects actual code, not aspiration.`

- [ ] **Step 3: Inspect the tracked-modified UI files' diffs**

Run:

```powershell
git -C C:/Project-TOAD diff -- toad-local/ui/src/components/ideSource.ts toad-local/ui/src/components/codeTreeNavigator.ts toad-local/ui/src/components/IdeEditorPane.tsx toad-local/ui/src/styles/app-shell.css toad-local/ui/src/styles/cockpit.css
```

Confirm every hunk is IDE work (IDE file/tree types, tree-node metadata carry, the Task-3B `IdeEditorPane.tsx` union-narrow + diagnostics/markers/toolbar integration, unsupported-panel/badge styles, Problems-panel styles). `CockpitWithMe.tsx` and `IdeFileTree.tsx` are NOT in `git status` (already on `main`, unmodified) — do not stage them. `IdeEditorPane.tsx` IS now modified (Task 3B) and **must** be staged here.

- [ ] **Step 4: Stage the UI IDE file-set + docs**

```bash
git -C /c/Project-TOAD add \
  toad-local/ui/src/components/ideSource.ts \
  toad-local/ui/src/components/codeTreeNavigator.ts \
  toad-local/ui/src/components/ideFilePresentation.ts \
  toad-local/ui/src/components/ideDiagnostics.ts \
  toad-local/ui/src/components/IdeEditorPane.tsx \
  toad-local/ui/src/components/cockpit/BottomPanelProblems.tsx \
  toad-local/ui/src/components/cockpit/cockpitTreeActor.ts \
  toad-local/ui/src/styles/app-shell.css \
  toad-local/ui/src/styles/cockpit.css \
  toad-local/ui/test/ideFilePresentation.test.mjs \
  toad-local/ui/test/ideDiagnostics.test.mjs \
  toad-local/ui/test/cockpitTreeActor.test.mjs \
  toad-local/scripts/test-suites.txt \
  toad-local/docs/superpowers/plans/2026-05-18-ide-file-compatibility.md \
  toad-local/docs/superpowers/plans/2026-05-18-python-ide-diagnostics.md \
  toad-local/docs/superpowers/specs/2026-05-18-ide-file-compatibility-design.md \
  toad-local/docs/superpowers/specs/2026-05-18-python-ide-diagnostics-design.md
```

- [ ] **Step 5: Confirm nothing out-of-scope is staged**

Run: `git -C C:/Project-TOAD status --porcelain`

Assert `toad-local/ui/src/components/PlanUsagePanel.tsx`, `toad-local/src/providers/geminiUsageProbe.js`, `toad-local/capture-gemini-*.js`, `Reference material/`, `code_audit.md`, `upstream-reference/`, `website-publish/` are NOT staged. `git -C C:/Project-TOAD restore --staged <path>` any that are.

- [ ] **Step 6: Commit**

```bash
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(ide): land verified WITH me IDE UI + wire IDE suites into the root gate (IDE-0)

IDE file/tree types, tree-node metadata, file-presentation +
diagnostics helpers, Problems panel, cockpit tree actor, IDE styles —
all suites green (ideFilePresentation, ideDiagnostics, cockpitTreeActor,
projectSwitchAction). 8 IDE suites wired into scripts/test-suites.txt.
IDE plan checkboxes reflect actual completion. FOR me / persona pill /
developerMode / CockpitScreenV2 / useTweaks byte-unchanged.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full verification gate + out-of-scope proof

**Files:** none modified.

- [ ] **Step 1: Run the full root gate**

Run: `bash -c "$(cat scripts/test-suites.txt)"`

Expected: exit code 0, every suite `# fail 0`, and the 8 new IDE suites observed running in the output. If any suite fails, STOP and report BLOCKED with the failing suite + output.

- [ ] **Step 2: UI typecheck (committed-state-green gate) — non-destructive**

`npm run typecheck` is `tsc -b --noEmit`; `npm run build` is `tsc -b && vite build`. The working tree carries a FOREIGN uncommitted, unstaged `App.tsx` `providerQuota` hunk (a separate usage workstream, NOT staged/committed by IDE-0) that yields exactly 2 errors: `App.tsx(1255,..)` / `App.tsx(1256,..)` `TS2339 Property 'quota' does not exist on type 'SummaryStatus'`.

Do this — **no destructive git commands** (never `git checkout -- App.tsx`, never stash/apply App.tsx; another workstream's uncommitted hunk must survive untouched):

1. Run from `ui/`: `npm run typecheck` and capture the full error list.
2. Assert the list is EXACTLY the 2 `App.tsx:1255/1256 SummaryStatus.quota` errors and nothing else — zero `IdeEditorPane.tsx`, zero `CockpitWithMe.tsx`, zero any other IDE error. Any other/IDE error = IDE-0 regression → BLOCK and fix in the offending IDE file.
3. Confirm those 2 errors are the foreign hunk, not IDE-0: `git -C C:/Project-TOAD diff -- toad-local/ui/src/App.tsx` — verify lines ~1251–1260 (`providerQuota` / `summaryStatus?.quota`) are an UNSTAGED hunk and that `git -C C:/Project-TOAD log -1 --format=%H -- toad-local/ui/src/App.tsx` is the committed Task-2 commit (i.e. IDE-0's committed App.tsx does NOT contain `quota`). Record this as the proof: "IDE-0's committed state has 0 tsc errors; the only working-tree errors belong to the foreign uncommitted providerQuota hunk which IDE-0 deliberately does not commit."
4. (Optional, only if a fully-clean build artifact is explicitly wanted: `git -C C:/Project-TOAD worktree add C:/Project-TOAD/.ide0-verify HEAD`, `npm ci` + `npm run build` inside its `ui/`, expect exit 0, then `git -C C:/Project-TOAD worktree remove --force C:/Project-TOAD/.ide0-verify`. Heavy; skip unless asked — step 3 is sufficient proof.)

`npm run build` in the dirty working tree exiting non-zero solely because of the foreign hunk is expected and is NOT an IDE-0 regression; step 3 is the authoritative evidence.

- [ ] **Step 3: Prove FOR me / persona / routing untouched**

Run:

```powershell
git -C C:/Project-TOAD diff a8b6a668 HEAD -- toad-local/ui/src/components/cockpit/CockpitForMe.tsx toad-local/ui/src/components/cockpit/CockpitScreenV2.tsx toad-local/ui/src/components/Titlebar.tsx toad-local/ui/src/hooks/useTweaks.ts
```

Expected: EMPTY for `CockpitForMe.tsx`, `CockpitScreenV2.tsx`, `useTweaks.ts`. (`Titlebar.tsx` is also expected empty — IDE-0 changed only `App.tsx`'s handler, not the pill.) Any non-empty diff here is a scope violation → revert it.

- [ ] **Step 4: Prove out-of-scope WIP still uncommitted**

Run: `git -C C:/Project-TOAD status --porcelain`

Expected: `toad-local/ui/src/components/PlanUsagePanel.tsx`, `toad-local/src/providers/geminiUsageProbe.js`, `toad-local/capture-gemini-*.js`, `Reference material/`, `code_audit.md`, `upstream-reference/`, `website-publish/` are still present as unstaged `M`/`??` (left exactly as found, not committed).

- [ ] **Step 5: Manual smoke (report, do not block)**

Document for the user to verify in the running desktop app:
- WITH me: pick a different project from the titlebar dropdown → file tree + open editor switch to the new project.
- FOR me: visually/behaviorally identical to before.
- PROBLEMS: populates for a Python project, OR shows the actionable "Ruff/Mypy not installed — install dev dependencies" message (not a stuck spinner / scary fetch error).

- [ ] **Step 6: Finish**

Use `superpowers:finishing-a-development-branch`. This repo commits directly to `main` (project convention); there is no feature branch/PR. Confirm `git -C C:/Project-TOAD log --oneline -4` shows the 3 IDE-0 commits + the spec commit, and report completion + the Step 5 smoke checklist to the user.

---

## Self-Review

**Spec coverage:** Spec §3.1 B (project-switch fix) → Tasks 1–2. Spec §3.1 C (verify + commit + gate wiring) → Tasks 3–5. Spec §4 commit hygiene (only IDE file-set, no `git add -A`, exclude PlanUsagePanel/geminiUsageProbe, hunk-stage App.tsx + LocalToadRuntime) → Task 2 Step 5, Task 4 Steps 1/3/4, Task 5 Steps 3/5. Spec §8 (App-level switch test, root gate green, UI typecheck/build, out-of-scope diff empty, manual smoke) → Task 1, Task 6 Steps 1–5. Spec §3.2 (FOR me/persona/routing untouched) → Task 6 Step 3. Spec §2 (no new tweak/default) → enforced by the file-set; never edits `useTweaks`/`CockpitScreenV2`. No gaps.

**Placeholder scan:** No TBD/TODO. Every code step has full code. Every command has expected output. The only conditional steps (App.tsx / LocalToadRuntime hunk-staging, plan-checkbox truthfulness) are explicit decision procedures with recorded outcomes, not "handle edge cases" placeholders.

**Type consistency:** `switchToRegisteredProjectByPath(deps, targetPath)` and `ProjectSwitchDeps` (`projects`, `switchToProjectPath`, `setActive`, `refreshAfterProjectSwitch`, `onError`) are identical across Task 1 (test), Task 2 (impl + App wiring). Test mock keys match the interface. Suite filenames in Task 5 Step 1 match Task 1's created file and the Task 3/4 suite names. Gate-append token matches the verified current tail of `scripts/test-suites.txt`.
