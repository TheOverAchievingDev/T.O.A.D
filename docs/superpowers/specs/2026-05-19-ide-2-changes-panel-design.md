# IDE-2 — Changed-files panel (WITH me) — Design

> Program slice 3 of the "Make WITH me a real IDE" program. Predecessors:
> IDE-0 (stabilize + project-aware WITH me IDE, shipped origin/main `4aee8d72`),
> IDE-1 (JS/TS + ESLint/tsc diagnostics, shipped origin/main `985fd244`).
> **WITH me ONLY. FOR me must remain byte-unchanged. This is not a UI rewrite.**

**Date:** 2026-05-19
**Status:** Approved (brainstorm)

---

## 1. Goal

Surface, in the WITH me cockpit, the set of files changed in the project
working tree versus `HEAD` — with per-file `+additions` / `−deletions`
line counts — and let the operator click a file to review its diff. This
is the "watch the team build" affordance: while a team of CLI agents edits
the project root, the operator sees what changed and inspects it without
leaving the cockpit.

## 2. Scope decisions (locked during brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| **Change source** | Project working tree vs `HEAD` (tracked diff + untracked from status) | Smallest coherent slice; the WITH me cockpit already operates exclusively on `{kind:'project'}`; `ide_get_diff`/`ide_get_status` already target this exact root. **No per-task / per-agent attribution.** |
| **Placement** | New "Changes" bottom-panel tab (beside Terminal/Problems/Output/Validations) | Idiomatic — mirrors the Problems→click→open-in-editor pattern, reuses `BottomPanel` infra. |
| **Click action** | Open straight into the editor's diff view | The panel exists to review changes; zero extra clicks. |
| **Refresh model** | Poll every ~4s **only while the Changes tab is the active bottom-panel tab**, plus a manual Refresh button | Stays live during agent runs (the real WITH me scenario) at a bounded cost; zero work when hidden/closed. |

Out of scope (explicitly deferred, not this slice): per-task/per-agent
attribution, a left-rail Source-Control view, git-decoration badges on the
file tree, staging/commit actions, an auto-follow toggle.

## 3. Architecture & data flow

```
CockpitWithMe
  - poll setInterval (only while showBottomPanel && bottomPanelTab==='changes')
  - manual Refresh button in the panel
  └─ callTool ide_changes_summary { source:{kind:'project'} }
       └─ facade #ideChangesSummary → getIdeChangesSummary()
            ├─ git diff HEAD --numstat   (adds/dels per tracked file; "-\t-" = binary)
            └─ git status --porcelain    (authoritative file+status list, incl. untracked)
       merge by path → files:[{relativePath,status,additions,deletions,binary}]
  └─ BottomPanelChanges list
       └─ row click → externalOpenRequest { sourceKey:'project', path, mode:'diff' }
            └─ IdeEditorPane opens/selects tab + enters its EXISTING diff view
               (loadDiff() / ide_get_diff — already built in IDE-0)
```

The diff *view* is not built here — IdeEditorPane already has a working
`editorMode:'diff'` that loads `ide_get_diff` and renders hunks (with
hunk-revert). IDE-2 adds the *change-set summary* and *routes clicks into*
that existing view.

## 4. Backend

### 4.1 `src/ide/ideChangesSummary.js` (new)

```
getIdeChangesSummary({ projectCwd, taskBoard, teamId, source, runGit }) ->
  { source, files: IdeChangeEntry[] }                       // success
  { source, files: [], error: string }                      // graceful failure
```

`IdeChangeEntry = { relativePath, status, additions, deletions, binary }`

- `relativePath`: POSIX-normalized, repo-root-relative.
- `status`: single letter — `M` modified, `A` added, `D` deleted,
  `R` renamed, `?` untracked. Derived from `git status --porcelain`
  (first non-space of the XY code; `??` → `?`).
- `additions` / `deletions`: integers from `git diff HEAD --numstat`;
  `null` when not available (untracked, binary).
- `binary`: `true` when numstat emits `-\t-\t<path>`; counts are `null`.

Behavior:

- Resolve the root via `resolveIdeSourceRoot({ projectCwd, taskBoard,
  teamId, source })` — identical resolution to the other IDE git tools
  (`ideGitTools.js`), so WITH me's `{kind:'project'}` → `projectCwd`.
- Use an **injectable `runGit`** defaulting to `src/git/runGit.js`'s
  `runGit` (the `src/task/diffComputer.js` pattern) so the parser is
  unit-testable with a fake git and never needs a real repo in tests.
- Run `git diff HEAD --numstat` (no patch — cheap even on large repos)
  for tracked add/delete counts.
- Run `git status --porcelain` for the authoritative path+status set.
  This is the source of truth for *which* files appear (untracked files
  are absent from `--numstat` but present here; deleted files appear in
  both).
- **Merge by path:** every porcelain entry becomes a row; counts are
  filled from the numstat map when present, else `null`. (numstat-only
  paths without a porcelain entry are not expected for a working-tree
  `diff HEAD`, but if encountered are included with status `M`.)
- Rename handling: porcelain `R` rows surface the **new** path with
  status `R`; numstat counts are best-effort (attached if the new path
  matches a numstat entry, else `null`). No `-M`/`-z` rename parsing —
  kept deliberately simple for this slice.
- **Graceful failure:** a non-git directory or any git non-zero exit
  returns `{ files: [], error }` (mirrors `getIdeStatus`'s tolerance) so
  the panel renders a friendly state and never throws.

### 4.2 Facade + MCP wiring

- `COMMANDS.IDE_CHANGES_SUMMARY = 'ide_changes_summary'`.
- A read-only tool definition in `localToolDefinitions.js`: title
  "IDE Changes Summary", description noting read-only, args `{ source }`
  only (whole working-tree summary — **no** `relativePath`).
- `localToolFacade.js`: one additive `case COMMANDS.IDE_CHANGES_SUMMARY`
  → `#ideChangesSummary(actor, args)` delegating to
  `getIdeChangesSummary({ projectCwd, taskBoard, teamId: actor.teamId,
  source: args.source })`. Additive only.

> **Entanglement hazard (carry-over from IDE-0/IDE-1):** `localToolFacade.js`
> is interleaved with the foreign uncommitted "usage-panel" workstream.
> The IDE-2 change here is purely additive (one `case` + one private
> method), but the controller MUST independently verify the committed
> `localToolFacade.js` contains zero foreign refs, and the finishing gate
> runs against the **committed** state (swap-in `git show HEAD:` →
> run → restore foreign WIP) exactly as in IDE-1.

## 5. UI

### 5.1 `ui/src/components/ideChanges.ts` (new)

- `export interface IdeChangeEntry { relativePath; status; additions: number|null; deletions: number|null; binary: boolean }`
- `export interface IdeChangesResult { source: ...; files: IdeChangeEntry[]; error?: string }`
- `formatChangeCounts(entry): string` — `"+12 −3"`, `"—"` for
  untracked/binary/null.
- `summarizeChanges(files): number` — count for the tab badge (number of
  changed files).

### 5.2 `ui/src/components/cockpit/BottomPanelChanges.tsx` (new)

Mirrors `BottomPanelProblems.tsx` structurally:

- Props: `files: IdeChangeEntry[]`, `running: boolean`,
  `error: string | null`, `onOpenChange(relativePath: string)`,
  `onRefresh()`.
- Renders a Refresh button (header), and one row per file: status glyph
  (M/A/D/R/?), path (basename emphasized, dir muted), right-aligned
  `+adds`/`−dels` (green/red) or `—`.
- Empty state ("No changes vs HEAD."), running spinner, error line
  (non-destructive — see §6).
- Row click → `onOpenChange(relativePath)`.

### 5.3 `ui/src/components/cockpit/BottomPanel.tsx` (modify)

- Widen `export type BottomPanelTab` to include `'changes'`.
- Add `{ id:'changes', label:'Changes', count: changeCount }` to the
  `tabs` array (placed after Problems).
- Add `changesSlot?: ReactNode` + `changeCount?: number` props; render
  `changesSlot` (with an empty-state fallback) in `renderTabBody`'s
  `case 'changes'`.

> **App.tsx invariant:** `App.tsx` references the *exported*
> `BottomPanelTab` type for the `bottomPanelTab` tweak and passes it
> through opaquely. Widening the union is transparent — **no `App.tsx`
> edit**. Verified during planning; the finishing gate proves `App.tsx`
> byte-unchanged.

### 5.4 `ui/src/components/cockpit/CockpitWithMe.tsx` (modify)

- New state: `changes: IdeChangeEntry[]`, `changesRunning: boolean`,
  `changesError: string | null`.
- `runChangesSummary()` callback: `callTool<IdeChangesResult>` →
  `ide_changes_summary` with `editorSource`; on success replace list +
  clear error; on failure set error but **keep the previous list**.
- Poll effect: `setInterval(runChangesSummary, 4000)` created **only
  when `showBottomPanel && bottomPanelTab === 'changes'`**; cleared on
  tab change / panel close / unmount. Also run once immediately when the
  tab becomes active, and on project switch (reuse the existing
  `activeProjectId` dependency pattern).
- Wire `<BottomPanelChanges …>` as `changesSlot` and
  `summarizeChanges(changes)` as `changeCount` into `<BottomPanel>`.
- `handleOpenChange(relativePath)` — like `handleOpenFile` but the
  `externalOpenRequest` carries `mode:'diff'` (see §6).

## 6. Open-in-diff wiring (the single shared-file touch)

`externalOpenRequest` today is
`{ sourceKey: string; path: string; requestId: number }`. Add an
**optional** `mode?: 'diff'`:

- **Absent (all existing callers — file-tree click `handleOpenFile`,
  diagnostic open `handleOpenDiagnostic`):** behavior byte-identical to
  today (open/select tab in code mode). These call sites are **not
  modified**.
- **`mode:'diff'` (only the new Changes-panel click):** `IdeEditorPane`,
  after opening/selecting the tab, enters its existing diff view by
  invoking the already-present `loadDiff()` path
  (`editorMode:'diff'` + `ide_get_diff`).

This is additive and default-preserving. The Code screen also consumes
`IdeEditorPane` but never sends `mode`, so it is unaffected.

Error model for the panel: a poll failure sets `changesError` but does
**not** clear the last successful `changes` list (no flicker to empty on
a transient git hiccup mid-agent-run). The error line is informational;
manual Refresh retries.

## 7. Scope guard (hard constraint)

WITH me only. `BottomPanel`, `BottomPanelChanges`, `CockpitWithMe` are
WITH-me-only. The `IdeEditorPane` change is an optional-field,
default-preserving extension. **FOR me, the FOR me⇄WITH me persona pill,
`developerMode`, `CockpitScreenV2`, `useTweaks`, `CockpitForMe`, and
`App.tsx` MUST remain byte-unchanged.** The finishing-a-development-branch
gate proves this (git diff scope-proof + UI typecheck), exactly as for
IDE-0 and IDE-1.

## 8. Testing

**Backend (injected fake `runGit`, no real repo):**

- numstat parse: normal adds/dels; `-\t-\t` → `binary:true`, counts
  `null`; multiple files.
- porcelain merge: untracked `??`→`?` with `null` counts; added `A`;
  deleted `D`; modified `M`; rename `R` surfaces new path.
- no changes → `{ files: [] }`.
- git non-zero / non-git dir → `{ files: [], error }` (no throw).
- facade routes `ide_changes_summary` → `getIdeChangesSummary`,
  read-only (no mutation, no idempotency key required).

**UI:**

- `ideChanges.ts`: `formatChangeCounts` ( `+/−`, `—` cases ),
  `summarizeChanges` count.
- `BottomPanelChanges`: renders rows + counts; empty / running / error
  states; `onOpenChange` and `onRefresh` fire.
- `BottomPanel`: tab list includes `'changes'`; switching to it renders
  `changesSlot`; count badge shows.
- `CockpitWithMe` (light): the poll interval is created only when
  `showBottomPanel && bottomPanelTab==='changes'` and torn down
  otherwise; a poll failure preserves the prior list.

**Regression chain:** new backend + UI suites appended **single-line** to
`scripts/test-suites.txt` (the IDE-1 procedure — one line, no newline
before `&&`).

## 9. Non-goals / YAGNI

- No per-task or per-agent attribution.
- No staging, commit, discard, or revert from the panel (hunk-revert
  already exists in the diff view; not extended here).
- No file-tree git decorations, no left-rail Source-Control view.
- No auto-follow toggle / persisted panel preference.
- No `-M`/`-z` rename parsing beyond surfacing the porcelain `R` row.
- No binary-file line counting.
