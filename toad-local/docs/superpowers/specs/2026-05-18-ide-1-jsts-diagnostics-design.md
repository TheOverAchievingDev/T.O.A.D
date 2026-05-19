# IDE-1 — JS/TS + ESLint/tsc Diagnostics for the WITH me IDE — Design

**Status:** Approved (brainstorm 2026-05-18). Second sub-project of the
"Make WITH me a real IDE" program (after IDE-0, shipped `4aee8d72`).

**Program context:** Symphony has two flavors — **FOR me** (vibe coder;
`CockpitForMe`) and **WITH me** (dev; `CockpitWithMe`, the in-app IDE).
All IDE work is WITH me only; FOR me / the `FOR me-WITH me` persona pill
/ `developerMode` / `CockpitScreenV2` / `useTweaks` / `CockpitForMe`
stay byte-unchanged. IDE-0 landed the durable WITH me IDE with
**Python-only** diagnostics (Ruff/Mypy). The codebase users actually
edit is frequently JS/TS, where today there is no lint/type-check/
auto-fix. IDE-1 closes that. IDE-2 (per-file changed-lines panel)
remains a later cycle.

## 1. Goal

Extend the existing diagnostics pipeline so JavaScript/TypeScript files
get ESLint + `tsc` diagnostics (Problems panel + Monaco squiggles),
ESLint `--fix`, and Prettier-if-present formatting — through the
**same** `ide_diagnostics_run` / `ide_format_file` / `ide_fix_file` /
`ide_fix_project` commands, with no protocol change. A polyglot project
(e.g. both Python and JS/TS) gets both toolchains' diagnostics.

## 2. Ground truth (current seam)

- Backend dispatch (`src/tools/localToolFacade.js`
  `#ideDiagnosticsRun`/`#ideFormatFile`/`#ideFixFile`/`#ideFixProject`)
  is **Python-hardwired**: it calls `runPythonDiagnostics` /
  `formatPythonFile` / `fixPythonFile` / `fixPythonProject` (or an
  injected `pythonIdeTools`). No language-routing layer exists yet.
- `src/ide/python/pythonDiagnosticsRunner.js` runs Ruff
  (`python -m ruff check --output-format json`) + Mypy
  (`python -m mypy`), returns the generic shape
  `{ source, rootLabel, diagnostics[], toolResults[], generatedAt }`
  (file-action shape `{ changed, file, diagnostics, toolResults,
  generatedAt }`). Its `runTool` (spawn `shell:false`, timeouts,
  availability detection), `summarizeToolResult`, `compareDiagnostics`,
  `isOutsideRoot`, `toPosixPath`, and path-target resolution are
  **language-agnostic**; the Ruff/Mypy command composition and
  `No module named X` detection are Python-specific.
- The `IdeDiagnostic` data shape, `BottomPanelProblems`, and the
  Monaco-marker conversion in `IdeEditorPane.tsx` are
  **source-agnostic** (they already render arbitrary `source`/severity).
  `ui/src/components/ideDiagnostics.ts` exposes `isPythonPath`;
  `CockpitWithMe.tsx` runs diagnostics gated on a Python project; the
  `IdeEditorPane.tsx` format/fix toolbar is gated on `isPythonPath`.

## 3. Architecture (Approach A — language-router seam)

A thin **`src/ide/diagnosticsRouter.js`** sits between the facade and
the per-language runners. Language-agnostic infra is **extracted** from
`pythonDiagnosticsRunner.js` into a shared
**`src/ide/diagnosticsToolRunner.js`** imported by both runners
(behavior-preserving for Python; guarded by the existing green Python
suites). The 4 `ide_*` command names are unchanged.

**Detection (in the router):**
- File scope (`relativePath` given or `scope:'file'`): by extension.
  `.py` → python. `.js .jsx .ts .tsx .cjs .mjs .cts .mts` → jsts. Any
  other extension → empty result (`diagnostics:[]`, a `toolResults`
  note "no diagnostics provider for <ext>") — **not** an error.
- Project scope: run python if the root has `pyproject.toml` or any
  `*.py`; run jsts if the root has `package.json`. Run every detected
  toolchain and **merge** `diagnostics[]` + `toolResults[]` (sorted via
  the shared `compareDiagnostics`). No toolchain detected → empty
  result (mirrors the Python slice's "no python project → empty").

## 4. Components

- **`src/ide/diagnosticsToolRunner.js` (new):** extracted shared
  `runTool`, `summarizeToolResult`, `compareDiagnostics`,
  `isOutsideRoot`, `toPosixPath`, and the generic file-target
  resolver (parameterized by an allowed-extension set + command name).
  `pythonDiagnosticsRunner.js` is refactored to import these; its
  public API and behavior are unchanged.
- **`src/ide/js/jsDiagnosticParsers.js` (new):** pure
  `parseEslintJsonDiagnostics(stdout, { rootPath })`,
  `parseTscDiagnostics(stdout, { rootPath })`,
  `normalizeDiagnosticPath(filePath, { rootPath })`. ESLint JSON →
  one diagnostic per message: `source:'eslint'`, `severity` (2→error,
  1→warning), `line/column/endLine/endColumn`, `code` = `ruleId`,
  `message`, `fixable` = message has a `fix` object. tsc stdout lines
  `path(line,col): error TSxxxx: message` → `source:'tsc'`,
  `severity` from `error`/`warning`, `code` = `TSxxxx`. Diagnostics
  whose path resolves outside the root are dropped. Pure, total,
  never throws on malformed input (→ `[]`).
- **`src/ide/js/jsDiagnosticsRunner.js` (new):** `runJsDiagnostics`,
  `formatJsFile`, `fixJsFile`, `fixJsProject` — **identical
  signatures and return shapes** to the Python runner
  (`{ projectCwd, taskBoard, teamId, source, relativePath, scope,
  spawn }`). Tool resolution prefers the project-local binary
  (`node_modules/.bin/eslint`, `…/tsc`, `…/prettier`; `.cmd` on
  Windows) — mirrors the Python venv-first `resolvePythonCommand`
  pattern. Missing binary → a tool result with `available:false` and
  message "ESLint is not installed in this project. Install the
  project's dev dependencies, then retry." (analogously tsc/Prettier).
  - `runJsDiagnostics`: `eslint --format json <target>` (target =
    file path for file scope, `.` for project) + `tsc --noEmit
    --pretty false` (`-p tsconfig.json` when a tsconfig exists at the
    root; for file scope, run project `tsc` then filter parsed
    diagnostics to the target file — single-file isolated type-check
    is unreliable). ESLint exit 0/1 = ran (1 = lint findings); exit ≥2
    or unparseable + stderr = tool error. tsc nonzero with parseable
    output = findings; unparseable + stderr = tool error.
  - `fixJsFile`/`fixJsProject`: `eslint --fix <target|.>` then re-run
    `runJsDiagnostics` for that file/project and `readIdeFile` the
    file (mirrors `fixPythonFile`).
  - `formatJsFile`: if project-local Prettier present →
    `prettier --write <file>` then `readIdeFile`; else return
    `{ changed:false, file:null, diagnostics:[], toolResults:[{ tool:
    'prettier', available:false, message:'Prettier is not installed;
    Format is unavailable for JS/TS in this project.' }],
    generatedAt }` (no throw).
  - Timeouts reuse the shared constants (diagnostics 30s, file action
    15s, project fix 60s). All spawns `shell:false`, `windowsHide`.
    File-target safety reuses the shared resolver with the JS/TS
    extension allowlist (other extensions → `unsupported file type`).
- **`src/ide/diagnosticsRouter.js` (new):** `routeDiagnostics`,
  `routeFormatFile`, `routeFixFile`, `routeFixProject`. Implements §3
  detection and merge. For format/fix on a single file, the language
  is the file's extension; an unsupported extension yields the
  language's clear unsupported result, not a throw (path traversal
  still throws via the shared resolver).
- **`src/tools/localToolFacade.js`:** the 4 `#ide*` methods call the
  router instead of `runPythonDiagnostics` etc. The `pythonIdeTools`
  constructor injection generalizes to an optional `ideDiagnostics`
  test seam `{ python?, js? }` (back-compatible: absent → real
  runners; existing `pythonIdeTools` callers keep working via a
  compatibility shim or are updated in-plan). **Hygiene constraint:**
  this file carries the foreign usage-panel workstream's uncommitted
  WIP (see `ide-program` memory). IDE-1 edits stay hunk-isolated; the
  gate is verified against the **committed** state; the foreign WIP is
  never staged.
- **UI:** `ui/src/components/ideDiagnostics.ts` keeps `isPythonPath`,
  adds `isDiagnosablePath(path)` + `languageForDiagnostics(path)`.
  `CockpitWithMe.tsx`: the diagnostics-run trigger is un-gated from
  Python so it fires whenever the project has any supported toolchain
  (the router decides which); state/prop names unchanged. The
  `IdeEditorPane.tsx` toolbar gate `isPythonPath` →
  `isDiagnosablePath`; Format shows only when the active file's
  language has an available formatter (derived from the returned
  `toolResults` availability). `BottomPanelProblems` + Monaco markers
  are unchanged (already source-agnostic; `eslint`/`tsc` flow through).
  The marker owner string stays `symphony-python-diagnostics`
  (renaming is cosmetic and out of scope).

## 5. Data flow

`ide_diagnostics_run` → facade `#ideDiagnosticsRun` →
`routeDiagnostics({source, relativePath, scope})` → detect language(s)
→ `runJsDiagnostics` (ESLint + tsc) and/or `runPythonDiagnostics`
(Ruff + Mypy) → merged `{ diagnostics[], toolResults[], generatedAt }`
→ `CockpitWithMe` → `BottomPanelProblems` + `IdeEditorPane` Monaco
markers. Format/fix follow the existing `ide_format_file` /
`ide_fix_file` / `ide_fix_project` paths, routed by file extension.

## 6. Error handling

- Missing `eslint`/`tsc`/`prettier` → tool result `available:false` +
  actionable install message rendered in the Problems panel (exact
  mirror of Ruff/Mypy-missing). The other tool's diagnostics still
  render.
- Timeout → `timedOut` tool result; sibling tool unaffected.
- ESLint exit 0/1 = findings/ok; exit ≥2 or config crash → tool-error
  row, never a thrown 500. tsc nonzero with parseable diagnostics =
  findings; unparseable + stderr = tool-error row.
- Path traversal in file format/fix → throw (reuse the shared
  inside-root validation).
- Non-JS/TS file routed to JS format/fix → clear
  `unsupported file type` result.
- Malformed ESLint JSON / unexpected tsc text → parser returns `[]`
  and a tool-error result; no crash.

## 7. Testing strategy

TDD, subagent-driven, two-stage review per task, controller-verified.

- **Pure parsers** (deepest): `parseEslintJsonDiagnostics`
  (multi-file, fixable vs not, severity map, empty `[]`, malformed →
  `[]`), `parseTscDiagnostics` (error/warning, `TSxxxx` code,
  no-column lines, Windows + POSIX absolute paths normalized to
  project-relative, non-matching lines ignored), path normalization,
  out-of-root drop.
- **Router**: extension → language; project polyglot detection (both
  python + jsts present → both run, merged); unknown extension / no
  toolchain → empty, no throw.
- **JS runner** (injected `spawn`, no real binaries): ESLint findings;
  tsc errors; missing eslint/tsc → `available:false` actionable
  message; Prettier-missing → `formatJsFile` returns the unsupported
  result (no throw); `fixJsFile` re-runs diagnostics + rereads file;
  file-target safety rejects non-JS/TS + path traversal.
- **Shared-extraction regression guard**: the existing green Python
  suites (`idePythonDiagnosticParsers`,
  `localToolFacade.idePythonDiagnostics`) must stay green after the
  `diagnosticsToolRunner.js` extraction — Python behavior unchanged.
- **Facade dispatch**: `ide_diagnostics_run` with a `.ts` target hits
  the JS runner; with a `.py` target hits the Python runner; project
  scope on a polyglot fixture returns both sources. Role authority is
  unchanged (the 4 commands are already operator-only — no
  `roleAuthority` change; assert via the existing test).
- **UI helpers**: `isDiagnosablePath`/`languageForDiagnostics`;
  `eslint`/`tsc` → Monaco marker severity mapping; Format-button
  visibility keys off formatter availability.
- New suites wired single-line into `scripts/test-suites.txt` (no
  newline before `&&`). Controller re-runs the full root gate
  **against the committed state** (the dirty tree fails on the foreign
  usage-panel WIP — swap in `git show HEAD:` localToolFacade.js, run,
  restore the WIP from backup; per `ide-program` memory). UI
  `npm run typecheck`/`build`: only the known foreign
  `App.tsx:1255-1256 SummaryStatus.quota` errors remain (not IDE,
  not committed).

## 8. Scope boundary

**In:** ESLint + tsc diagnostics; ESLint `--fix`; Prettier-if-present
format; for `.js .jsx .ts .tsx .cjs .mjs .cts .mts`; polyglot-merged
project diagnostics; the language-router + shared-runner extraction;
the minimal UI un-gating. **Out:** LSP / language servers;
autocomplete / hover / go-to-def / rename; on-keystroke diagnostics
(keep explicit / on-open / on-save / manual, as the Python slice);
Biome or other linters/formatters; monorepo-workspace traversal beyond
the project root; auto-applying fixes without the existing Fix action;
any command-name/protocol change; marker-owner rename; FOR me /
persona pill / `developerMode` / `CockpitScreenV2` / `useTweaks` /
`CockpitForMe` (byte-unchanged); the foreign usage-panel workstream.

## 9. Honest residuals

- Single-file `tsc` type-checking is inherently project-coupled; file
  scope runs project `tsc` and filters to the target — a large project
  makes file-scope tsc as slow as project tsc (acceptable; documented;
  ESLint file scope stays fast).
- ESLint flat vs legacy config is auto-detected by the project's own
  ESLint binary; IDE-1 does not manage ESLint config. Projects with a
  broken ESLint/tsc config surface the tool-error row (honest), not a
  fabricated clean result.
- Marker owner string remains `symphony-python-diagnostics` despite now
  carrying eslint/tsc markers — purely cosmetic, renamed only if a
  later slice touches it.
