# Python IDE Diagnostics Design

## Goal

Turn the current file tree plus Monaco editor into an active IDE surface for Python projects by adding Ruff and Mypy diagnostics, Problems panel rendering, Monaco squiggles, and Ruff-powered format/fix actions.

This slice targets the active project `C:\Users\Nova_\Downloads\First_Run`, which is Python-first and already declares Ruff, Mypy, and Pytest in `pyproject.toml`. The implementation should be generic enough that TypeScript, ESLint, Prettier, or language-server providers can plug in later, but only Python/Ruff/Mypy ships in this slice.

## User Outcomes

- Opening or saving a Python file can surface syntax, lint, and type problems without leaving the editor.
- The Problems tab lists diagnostics grouped by file and source.
- Clicking a problem opens the file and moves the editor to the reported line and column.
- Monaco shows red/yellow squiggles for Ruff and Mypy findings.
- The user can run:
  - `Run Problems` for the project.
  - `Format Document` for the active Python file via Ruff.
  - `Fix File` for safe Ruff fixes.
  - `Fix Project` for safe Ruff fixes after confirmation.
- Unsupported/missing tooling produces actionable UI messages instead of silent failure or indefinite loading.

## Scope

In scope:

- Backend diagnostics command for project-level Python diagnostics.
- Backend Ruff format/fix commands.
- Structured diagnostic result shape shared with the UI.
- Ruff JSON parsing.
- Mypy stdout parsing.
- Monaco markers for active/open files.
- Problems tab content for WITH-me.
- Manual refresh and post-save diagnostic refresh.
- Tests for parser behavior, tool command composition, role authority, facade dispatch, and UI presentation helpers.

Out of scope:

- Full LSP server lifecycle.
- Autocomplete, hover docs, go-to-definition, rename symbol, references.
- JavaScript/TypeScript diagnostics.
- Running tests automatically.
- Applying AI-generated patches.
- Binary or notebook diagnostics.
- Real-time on-every-keystroke diagnostics. This slice uses explicit/manual, on-open, and on-save refreshes.

## Backend Design

### Command Surface

Add these commands:

- `ide_diagnostics_run`
- `ide_format_file`
- `ide_fix_file`
- `ide_fix_project`

`ide_diagnostics_run` is read-only. The format/fix commands mutate files and require idempotency keys.

All commands accept the existing IDE source shape:

```ts
type IdeSource =
  | { kind: 'project' }
  | { kind: 'task_worktree'; taskId: string };
```

### Diagnostics API

Request:

```json
{
  "source": { "kind": "project" },
  "relativePath": "src/pulsetune/__main__.py",
  "scope": "file"
}
```

`relativePath` is optional. `scope` defaults to `project`.

Response:

```json
{
  "source": { "kind": "project" },
  "rootLabel": "Project root",
  "scope": "project",
  "toolResults": [
    {
      "tool": "ruff",
      "available": true,
      "exitCode": 1,
      "command": "python -m ruff check --output-format=json .",
      "durationMs": 243,
      "error": null
    },
    {
      "tool": "mypy",
      "available": true,
      "exitCode": 1,
      "command": "python -m mypy src",
      "durationMs": 419,
      "error": null
    }
  ],
  "diagnostics": [
    {
      "id": "ruff:src/pulsetune/__main__.py:12:5:F401",
      "source": "ruff",
      "severity": "warning",
      "relativePath": "src/pulsetune/__main__.py",
      "line": 12,
      "column": 5,
      "endLine": 12,
      "endColumn": 11,
      "code": "F401",
      "message": "`os` imported but unused",
      "fixable": true,
      "url": null
    }
  ]
}
```

Severity values:

- `error`
- `warning`
- `info`

Ruff maps most diagnostics to `warning`, syntax/parser failures to `error` when Ruff marks them as such. Mypy diagnostics map to `error`.

### Tool Detection

Use Python module execution first:

- Ruff check: `python -m ruff check --output-format=json .`
- Ruff format file: `python -m ruff format <file>`
- Ruff fix file: `python -m ruff check --fix <file>`
- Ruff fix project: `python -m ruff check --fix .`
- Mypy: `python -m mypy src`

On Windows, this avoids relying on `.venv\Scripts` being on PATH. The command runner should use `spawn` with `cwd` set to the resolved IDE root. Never run through a shell.

If `python -m ruff` or `python -m mypy` exits because the module is missing, return `available:false` and an actionable message such as:

`Ruff is not installed in this Python environment. Install the project's dev dependencies, then retry.`

Tool execution timeouts:

- Diagnostics: 30 seconds per tool.
- Format/fix file: 15 seconds.
- Fix project: 60 seconds.

Timed-out tools return a tool result with `error:"timed_out"` and do not crash the whole diagnostics response.

### Parsing

Create parser modules:

- `src/ide/python/parseRuffDiagnostics.js`
- `src/ide/python/parseMypyDiagnostics.js`

Ruff parser consumes JSON output from `--output-format=json`.

Mypy parser handles standard parseable lines:

```text
src/pulsetune/__main__.py:12:5: error: Name "x" is not defined  [name-defined]
src/pulsetune/__main__.py:22: note: Revealed type is "builtins.str"
```

Mypy `error:` maps to `error`; `note:` maps to `info`.

Diagnostics with paths outside the source root are ignored.

### Format and Fix Results

Format/fix commands return:

```json
{
  "source": { "kind": "project" },
  "relativePath": "src/pulsetune/__main__.py",
  "changed": true,
  "exitCode": 0,
  "stdout": "...",
  "stderr": "...",
  "file": {
    "kind": "text",
    "relativePath": "src/pulsetune/__main__.py",
    "content": "...",
    "sha256": "..."
  },
  "diagnostics": { "...": "same shape as ide_diagnostics_run" }
}
```

After any successful file format/fix, backend rereads the file through `readIdeFile` and reruns diagnostics for that file.

`ide_fix_project` returns changed status and diagnostics, but does not return every changed file content. The UI refreshes the tree and diagnostics after completion.

## Frontend Design

### State Ownership

`CockpitWithMe` owns project diagnostics for the Problems tab. `IdeEditorPane` remains responsible for open tabs and Monaco rendering.

Add a small diagnostics model in UI:

- `IdeDiagnostic`
- `IdeDiagnosticsResult`
- helper functions for grouping, severity counts, and Monaco marker conversion.

### Problems Panel

Create `BottomPanelProblems.tsx`.

Features:

- Shows total error/warning/info counts.
- Groups by relative path.
- Each row shows severity, source, code, line/column, and message.
- Clicking a row calls `onOpenDiagnostic(diagnostic)`.
- Includes refresh button.
- Empty state: `No problems found.`
- Tool errors appear as a compact alert row above diagnostics.

Click behavior:

- Opens the diagnostic file through the existing editor external open request.
- Stores a pending cursor target `{ path, line, column, requestId }`.
- `IdeEditorPane` receives the target and reveals/selects the range after the editor model mounts.

### Monaco Markers

`IdeEditorPane` receives diagnostics for open files and applies Monaco markers per model.

Marker owner:

`symphony-python-diagnostics`

Mapping:

- `error` -> `monaco.MarkerSeverity.Error`
- `warning` -> `monaco.MarkerSeverity.Warning`
- `info` -> `monaco.MarkerSeverity.Info`

Markers are updated when:

- diagnostics result changes,
- active/open tabs change,
- file content is saved,
- format/fix returns new diagnostics.

### Editor Actions

Add compact actions to the file bar for editable Python files:

- Problems refresh icon.
- Format document.
- Fix file.

Use icons where available. Buttons disable while action is running. Errors show in the existing save/error area or a small filebar alert.

For non-Python files, these controls are hidden in this first slice.

### Refresh Triggers

- On WITH-me mount: run project diagnostics once if the project has Python config.
- On opening a `.py` file: run file-scoped diagnostics.
- On save of a `.py` file: run file-scoped diagnostics after save succeeds.
- Manual refresh in Problems tab: run project diagnostics.
- Format/fix file: run file-scoped diagnostics after command completes.
- Fix project: run project diagnostics after command completes.

Avoid running diagnostics on each keystroke in this slice.

## Data Flow

1. `CockpitWithMe` mounts and calls `ide_diagnostics_run`.
2. Backend resolves IDE source root and runs Ruff/Mypy.
3. Backend normalizes diagnostics and returns structured data.
4. `CockpitWithMe` stores diagnostics and passes:
   - grouped diagnostics to `BottomPanelProblems`,
   - raw diagnostics to `IdeEditorPane`.
5. `IdeEditorPane` converts diagnostics to Monaco markers for open files.
6. User clicks a problem.
7. `CockpitWithMe` sends open request and cursor target to `IdeEditorPane`.
8. Editor opens file, reveals line/column, and markers render.

## Error Handling

- Missing Python: diagnostics result includes a tool error; UI shows it in Problems.
- Missing Ruff/Mypy module: tool result shows `available:false`; UI offers install guidance.
- Timeout: tool result shows timed out; diagnostics from the other tool still render.
- Invalid JSON from Ruff: return a parser error tool result, not a thrown 500.
- Path traversal in format/fix: reuse existing IDE path validation and throw.
- Non-editable files: format/fix controls hidden.
- Project with no `pyproject.toml` and no `.py` files: return empty diagnostics with no tool execution.

## Security and Safety

- Use `spawn` without shell.
- Resolve all diagnostic paths under the IDE root.
- Format/fix file only accepts safe relative paths.
- Fix project requires idempotency and explicit UI confirmation.
- Preserve existing role-authority model: UI operator calls as `human`; agent roles do not gain IDE tool access.

## Testing

Backend tests:

- Ruff JSON parser handles file, range, fixable, code, message.
- Mypy parser handles errors, notes, column/no-column cases, and error codes.
- Diagnostics runner returns empty result for no Python project.
- Diagnostics runner degrades when Ruff/Mypy are missing.
- Tool command composition uses `python -m` and no shell.
- Format/fix validates paths and returns reread file content.
- Role authority allows human/lead and denies agent roles for mutating IDE tools.
- LocalToolFacade dispatches new commands.

UI tests:

- Problems grouping/count helpers.
- Diagnostic to Monaco marker conversion.
- Python action visibility for `.py` vs non-Python files.
- Click diagnostic produces an open request and cursor target.
- Missing-tool result renders alert copy.

Manual verification:

- Open `src/pulsetune/__main__.py`.
- Introduce a Ruff violation, run Problems, verify warning in Problems and marker in editor.
- Use Fix File, verify content changes and warning disappears.
- Introduce a Mypy type error, run Problems, verify error in Problems and marker in editor.
- Save file, verify diagnostics refresh.

## Implementation Order

1. Parser and diagnostics model tests.
2. Backend command surface and facade wiring.
3. Runner implementation with tool degradation.
4. UI diagnostics types and helpers.
5. Problems panel slot in WITH-me.
6. Monaco marker integration.
7. Format/fix file actions.
8. Fix project action with confirmation.
9. Focused tests and UI build verification.

## Open Decisions

None for this slice. The slice deliberately chooses Python/Ruff/Mypy only, no LSP, no autocomplete, and no on-keystroke diagnostics.
