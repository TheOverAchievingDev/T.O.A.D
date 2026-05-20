# Python IDE Diagnostics Implementation Plan

> IDE-0 (2026-05-18): verified layers committed. Completion reflects actual code, not aspiration.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the WITH-me editor from a file viewer into the first useful IDE slice for Python projects by adding Ruff/Mypy diagnostics, Problems panel navigation, Monaco squiggles, and Ruff-powered format/fix actions.

**Architecture:** Add Python diagnostic runners behind local IDE tool commands, keep command authorization consistent with existing IDE file tools, then wire structured diagnostics into Cockpit state, the bottom Problems tab, and `IdeEditorPane` Monaco markers/actions.

**Tech Stack:** Node.js local tool facade, existing TOAD command contracts and role authority, React/TypeScript UI, Monaco editor, Ruff CLI, Mypy CLI, built-in `node:test`/MJS UI tests.

---

## File Map

Backend additions:
- `src/ide/python/pythonDiagnosticParsers.js`
- `src/ide/python/pythonDiagnosticsRunner.js`
- `test/idePythonDiagnosticParsers.test.js`
- `test/localToolFacade.idePythonDiagnostics.test.js`

Backend modifications:
- `src/commands/command-contract.js`
- `src/security/roleAuthority.js`
- `src/tools/localToolFacade.js`
- `src/mcp/localToolDefinitions.js`
- Existing command/security/tool-definition tests as needed.

UI additions:
- `ui/src/components/ideDiagnostics.ts`
- `ui/src/components/cockpit/BottomPanelProblems.tsx`
- `ui/test/ideDiagnostics.test.mjs`

UI modifications:
- `ui/src/components/cockpit/CockpitWithMe.tsx`
- `ui/src/components/cockpit/BottomPanel.tsx` only if tab labels/counts need a small extension.
- `ui/src/components/IdeEditorPane.tsx`
- `ui/src/styles/cockpit.css`

---

## Data Contracts

Backend diagnostic shape:

```js
{
  source: "ruff" | "mypy",
  code: "F401",
  severity: "error" | "warning" | "info",
  message: "Imported but unused",
  path: "src/app.py",
  line: 12,
  column: 4,
  endLine: 12,
  endColumn: 18,
  fixable: true
}
```

Diagnostics command result:

```js
{
  diagnostics: [],
  toolResults: [
    {
      tool: "ruff",
      available: true,
      exitCode: 1,
      timedOut: false,
      durationMs: 314,
      message: "3 diagnostics"
    }
  ],
  generatedAt: "2026-05-18T00:00:00.000Z"
}
```

Format/fix command result:

```js
{
  changed: true,
  file: {
    path: "src/app.py",
    content: "...",
    encoding: "utf8",
    kind: "text",
    size: 1234,
    mtimeMs: 1710000000000
  },
  diagnostics: [],
  toolResults: []
}
```

---

## Implementation Tasks

### 1. Backend Parser Tests First

- [x] Add `test/idePythonDiagnosticParsers.test.js`.
- [x] Cover Ruff JSON diagnostics:
  - [x] Single diagnostic with filename, location, end location, code, message.
  - [x] Fixable diagnostic where Ruff returns a `fix` object.
  - [x] Empty JSON array.
  - [x] Malformed JSON returns empty diagnostics and does not throw.
- [x] Cover Mypy output:
  - [x] `src/app.py:12:4: error: Message here  [code]`.
  - [x] `src/app.py:12: note: Message here`.
  - [x] Windows absolute paths stay mapped to project-relative paths when they are inside the source root.
  - [x] Non-matching lines are ignored.

Expected parser exports:

```js
export function parseRuffJsonDiagnostics(stdout, { rootPath }) {}
export function parseMypyDiagnostics(stdout, { rootPath }) {}
export function normalizeDiagnosticPath(filePath, { rootPath }) {}
```

Run:

```powershell
node --test test/idePythonDiagnosticParsers.test.js
```

### 2. Implement Python Diagnostic Parsers

- [x] Create `src/ide/python/pythonDiagnosticParsers.js`.
- [x] Implement path normalization with `path.resolve`, `path.relative`, and POSIX-style separators in returned diagnostic paths.
- [x] Map Ruff output:
  - [x] `filename` -> normalized `path`
  - [x] `location.row/column` -> `line/column`
  - [x] `end_location.row/column` -> `endLine/endColumn`
  - [x] `code`, `message`
  - [x] `fix` truthiness -> `fixable`
  - [x] severity defaults to `warning`, with syntax/runtime-blocking parse errors as `error` when Ruff exposes them.
- [x] Map Mypy output:
  - [x] `error` -> `error`
  - [x] `note` -> `info`
  - [x] `warning` -> `warning`
  - [x] Optional trailing `[code]` -> diagnostic `code`.
- [x] Keep parser functions pure and side-effect free.

### 3. Backend Runner Tests

- [x] Add `test/localToolFacade.idePythonDiagnostics.test.js`.
- [x] Use injected `spawn`/runner dependency or a temporary fixture project to avoid requiring system Ruff/Mypy for unit tests.
- [x] Assert `ide_diagnostics_run` returns structured diagnostics for Ruff and Mypy.
- [x] Assert missing tools produce `available:false` tool results instead of failing the whole command.
- [x] Assert format/fix commands reject paths outside the project root.
- [x] Assert non-Python file format/fix requests return a clear unsupported-file response.

Run:

```powershell
node --test test/localToolFacade.idePythonDiagnostics.test.js
```

### 4. Implement Python Diagnostics Runner

- [x] Create `src/ide/python/pythonDiagnosticsRunner.js`.
- [x] Use `child_process.spawn` with `shell:false`.
- [x] Resolve project root from the same `source` contract used by existing IDE file tools.
- [x] Add safe project-relative path validation for file-scoped actions.
- [x] Implement `runPythonDiagnostics({ source, relativePath, scope })`:
  - [x] `ruff check --output-format json <target>`
  - [x] `python -m mypy src` when `src` exists, otherwise project root.
  - [x] Return partial results if one tool is missing or times out.
  - [x] Use 30s timeout per tool.
- [x] Implement `formatPythonFile({ source, relativePath })`:
  - [x] `ruff format <file>`
  - [x] 15s timeout.
  - [x] Return refreshed file content through existing file-read helper or equivalent safe read.
- [x] Implement `fixPythonFile({ source, relativePath })`:
  - [x] `ruff check --fix <file>`
  - [x] 15s timeout.
  - [x] Return refreshed file content plus fresh diagnostics for the file.
- [x] Implement `fixPythonProject({ source })`:
  - [x] `ruff check --fix .`
  - [x] 60s timeout.
  - [x] Return fresh project diagnostics.
- [x] Treat Ruff exit code `0` and `1` as command-successful for diagnostics because `1` means findings.
- [x] Treat Mypy exit code `0` and `1` as command-successful for diagnostics because `1` means findings.

### 5. Command Contracts And Authorization

- [x] Add command constants in `src/commands/command-contract.js`:
  - [x] `IDE_DIAGNOSTICS_RUN`
  - [x] `IDE_FORMAT_FILE`
  - [x] `IDE_FIX_FILE`
  - [x] `IDE_FIX_PROJECT`
- [x] Classify `IDE_DIAGNOSTICS_RUN` as read-only.
- [x] Classify format/fix commands as mutating.
- [x] Update `src/security/roleAuthority.js` to allow the human/operator path used by Cockpit while keeping agent roles from directly mutating files through these tools unless the existing policy already grants that role.
- [x] Extend role authority tests so the new IDE commands match the existing IDE file-tool security posture.

Run:

```powershell
node --test test/roleAuthority.test.js
```

### 6. MCP Tool Definitions And Local Facade

- [x] Add tool definitions in `src/mcp/localToolDefinitions.js`:
  - [x] `ide_diagnostics_run`
  - [x] `ide_format_file`
  - [x] `ide_fix_file`
  - [x] `ide_fix_project`
- [x] Reuse `IDE_SOURCE_SCHEMA`.
- [x] Schemas:
  - [x] Diagnostics: `{ source, relativePath?, scope?: "project" | "file" }`
  - [x] Format/fix file: `{ source, relativePath }`
  - [x] Fix project: `{ source }`
- [x] Update `src/tools/localToolFacade.js`:
  - [x] Import runner functions.
  - [x] Add switch cases for the four commands.
  - [x] Add private methods that pass `args` through the runner.
  - [x] Preserve existing audit/taskBoard behavior.
- [x] Update local tool definition tests for counts/names/read-only/mutating lists.

Run:

```powershell
node --test test/localMcpToolDefinitions.test.js test/localToolFacade.idePythonDiagnostics.test.js
```

### 7. UI Diagnostics Helpers

- [x] Add `ui/src/components/ideDiagnostics.ts`.
- [x] Export types matching the backend contract.
- [x] Export helpers:
  - [x] `isPythonPath(path: string): boolean`
  - [x] `diagnosticKey(diagnostic): string`
  - [x] `diagnosticsForPath(diagnostics, path): IdeDiagnostic[]`
  - [x] `countDiagnosticsBySeverity(diagnostics)`
  - [x] `toMonacoMarker(diagnostic, monaco)`
- [x] Add `ui/test/ideDiagnostics.test.mjs`.
- [x] Cover filtering, severity counts, marker range defaults, and Windows/POSIX path normalization.

Run:

```powershell
cd ui
node --test test/ideDiagnostics.test.mjs
```

### 8. Problems Panel

- [x] Add `ui/src/components/cockpit/BottomPanelProblems.tsx`.
- [x] Props:

```ts
type BottomPanelProblemsProps = {
  diagnostics: IdeDiagnostic[];
  running?: boolean;
  error?: string | null;
  onOpenDiagnostic?: (diagnostic: IdeDiagnostic) => void;
  onRunDiagnostics?: () => void;
};
```

- [x] Render grouped file sections with severity icons, line/column, source/code, and message.
- [x] Empty state should say no diagnostics from the active project.
- [x] Running state should be visible but should not replace existing diagnostics.
- [x] Clicking a diagnostic calls `onOpenDiagnostic`.
- [x] Add styles in `ui/src/styles/cockpit.css`.

### 9. Cockpit State And Tool Calls

- [x] Update `ui/src/components/cockpit/CockpitWithMe.tsx`.
- [x] Add diagnostics state:
  - [x] `pythonDiagnostics`
  - [x] `pythonDiagnosticsRunning`
  - [x] `pythonDiagnosticsError`
  - [x] `diagnosticNavigationTarget`
- [x] Add `runPythonDiagnostics({ relativePath?, scope })` using `callTool("ide_diagnostics_run", ...)`.
- [x] Trigger project diagnostics after the file tree loads for a valid project root.
- [x] Pass `problemCount` and `problemsSlot` to `BottomPanel`.
- [x] On problem click, open the file in the editor and navigate to the diagnostic line/column.
- [x] Add callbacks passed to `IdeEditorPane`:
  - [x] Run diagnostics for active file/project.
  - [x] Format current Python file.
  - [x] Fix current Python file.
  - [x] Refresh diagnostics after format/fix/save.

### 10. Editor Markers And Actions

- [x] Update `ui/src/components/IdeEditorPane.tsx`.
- [x] Add props for diagnostics and action callbacks.
- [x] Apply Monaco markers for the active tab with marker owner `symphony-python-diagnostics`.
- [x] Clear markers on tab close, file change, and unmount.
- [x] Add file-toolbar buttons for Python files:
  - [x] Run diagnostics
  - [x] Format with Ruff
  - [x] Fix with Ruff
- [x] Disable format/fix while file is saving or the action is running.
- [x] After format/fix callback returns file content, update the active tab draft and saved content consistently.
- [x] Apply diagnostic navigation target with `setPosition` and `revealPositionInCenter`.
- [x] Keep markdown preview behavior unchanged.

### 11. Verification

- [x] Run backend parser/facade/security/tool-definition tests:

```powershell
node --test test/idePythonDiagnosticParsers.test.js test/localToolFacade.idePythonDiagnostics.test.js test/roleAuthority.test.js test/localMcpToolDefinitions.test.js
```

- [x] Run UI helper tests:

```powershell
cd ui
node --test test/ideDiagnostics.test.mjs
```

- [x] Run UI typecheck:

```powershell
cd ui
npm run typecheck
```

- [x] If UI typecheck still fails only on the pre-existing `SummaryStatus.quota` issue, report that separately and do not silently edit unrelated quota code. (automated typecheck/build green via IDE-0; manual smoke tracked in IDE-0 Task 6)
- [ ] Manually verify in the running app:
  - [ ] File tree still loads the full project.
  - [ ] Opening a Python file shows diagnostics squiggles after diagnostics run.
  - [ ] Problems tab lists Ruff/Mypy findings.
  - [ ] Clicking a problem opens and focuses the file/line.
  - [ ] Format and fix actions update the editor content.
  - [ ] Missing Ruff/Mypy produces a visible tool availability message instead of a failed fetch or stuck loading state.

---

## Notes

- Keep this slice Python-only. Do not start JavaScript/TypeScript, LSP, autocomplete, or image previews in this pass.
- Do not shell out through a string command. Use `spawn(command, args, { cwd, shell: false })`.
- Do not block the UI on diagnostics. Keep stale diagnostics visible while a refresh is running.
- Do not commit automatically in the shared dirty workspace unless the user explicitly asks for a commit.
