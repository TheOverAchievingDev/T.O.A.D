# IDE Phase 2 Slice A — Monaco Reading Surface Design

**Status:** approved 2026-05-05  
**Author:** Kayden + Codex  
**North-star reference:** `2026-05-04-symphony-ide-north-star.md`

---

## 1. Problem

Symphony AI is moving from an orchestration dashboard toward an agentic IDE. The orchestrator already creates teams, tasks, reviews, drift findings, worktrees, and audit trails, but the UI has no first-class code reading surface. Operators must leave Symphony to inspect project files or task worktrees.

Slice A establishes the smallest useful IDE foundation: a read-only code browser that can inspect the selected team's project root and any created task worktrees.

## 2. Scope

In scope:

- Add a full-screen `Code` entry to the main sidebar.
- Render a file tree for the selected source.
- Default source: selected team's project root.
- Optional source: a created task worktree, selected from a dropdown when available.
- Open files in a locally bundled Monaco editor.
- Enforce read-only mode in Monaco.
- Fetch tree and file contents through `LocalToolFacade` / MCP-style tools, not direct static file routes.
- Provide a manual Refresh button.
- Reject path traversal, unreadable roots, large files, and binary files.
- Skip noisy directories such as `.git`, `node_modules`, `dist`, `build`, and `.toad` work internals unless explicitly needed later.

Out of scope:

- Editing and saving files.
- Diffs, keep/revert, hunk controls, checkpoints.
- File watchers or live tree updates.
- Multi-tab editor behavior.
- Search across files.
- Markdown preview.
- Agent overlays, inline drift markers, diagnostics, terminals, or debug panels.
- `ide_session_*` lifecycle tools. Slice A is stateless read-only browsing; sessions begin in the editing/diff slices.

## 3. Decisions

| Question | Decision | Reason |
|---|---|---|
| Slice A scope | Bare read-only reading surface | Gives the IDE pivot a stable first vertical slice without pulling in edit/diff risk. |
| UI placement | Full-screen `Code` sidebar entry | Isolated enough to validate Monaco and file loading without refactoring Workspace. |
| Worktree source | Both project root and task worktree toggle | Project root is useful immediately; task worktrees support agent inspection. |
| Tree loading | Static one-shot read with manual refresh | Avoids watcher complexity until editing/diffs need live updates. |
| File delivery | Facade-backed tools | Preserves the existing authority boundary and future-proofs risk/audit gates. |
| Monaco delivery | Local bundle via `monaco-editor` and Vite workers | Keeps Symphony local-first and offline-capable. |
| Read-only enforcement | Monaco `readOnly: true` and no save command | Makes the UX honest and prevents accidental edit expectations. |

## 4. Backend Design

Add two read-only commands to `COMMANDS`, `LocalToolFacade`, role authority, and MCP definitions:

- `ide_tree_list`
- `ide_read_file`

Both commands are read-only and callable by `human` and `lead`. Developer/reviewer/tester access can be allowed later if agent-side IDE tools need it, but Slice A is for the operator UI.

### 4.1 Source Resolution

The UI passes:

```ts
type IdeSource =
  | { kind: 'project' }
  | { kind: 'task_worktree'; taskId: string };
```

The backend resolves:

- `project`: the active `projectCwd`.
- `task_worktree`: `taskBoard.getTask({ teamId, taskId }).worktree.path`, only when `worktree.status === 'created'`.

If the root cannot be resolved, the command returns a structured error instead of falling back silently.

### 4.2 Path Safety

All file paths are relative to the resolved root. Backend must:

- Normalize the requested relative path.
- Reject absolute paths.
- Reject `..` traversal.
- Resolve the final path and verify it remains inside the root.
- Return clear errors for missing files, directories passed to `ide_read_file`, unsupported binary content, and oversized files.

### 4.3 `ide_tree_list`

Input:

```ts
{
  teamId: string;
  source: IdeSource;
  maxEntries?: number;
}
```

Output:

```ts
{
  source: IdeSource;
  rootLabel: string;
  entries: Array<{
    path: string;
    name: string;
    kind: 'file' | 'directory';
    sizeBytes?: number;
  }>;
  truncated: boolean;
}
```

The first slice can return a flat sorted list with path separators, or a nested tree if that is simpler for the UI. The external contract should stay path-based so UI structure can change without backend churn.

Default ignored directories:

- `.git`
- `node_modules`
- `dist`
- `build`
- `.vite`
- `coverage`
- `.toad/mcp-configs`

The backend should cap entries, defaulting around 2,000 entries, and set `truncated: true` when capped.

### 4.4 `ide_read_file`

Input:

```ts
{
  teamId: string;
  source: IdeSource;
  relativePath: string;
}
```

Output:

```ts
{
  source: IdeSource;
  relativePath: string;
  content: string;
  encoding: 'utf8';
  sizeBytes: number;
  languageHint?: string;
}
```

File reads should cap around 1 MB for Slice A. Binary detection can be pragmatic: reject buffers with NUL bytes or failed UTF-8 decoding. Later slices can add an explicit binary preview path.

## 5. Frontend Design

Add `CodeScreen.tsx` and route it through the existing app/sidebar state.

Layout:

- Header row:
  - title: `Code`
  - source selector: Project / task worktree
  - manual Refresh button
- Left pane:
  - compact file tree/list
  - selected file highlight
  - loading/error/empty states
- Right pane:
  - read-only Monaco editor
  - filename/path header
  - empty state when no file selected

The source selector shows:

- `Project root` always.
- One entry per task with `worktree.status === 'created'`, labelled by task id and subject when available.

When source changes:

- Clear selected file.
- Fetch tree for the new source.
- Preserve no editor tabs in Slice A.

When Refresh is clicked:

- Re-fetch the current source tree.
- If the previously selected file still exists, re-read it.
- If it no longer exists, clear the editor and show an empty state.

## 6. Monaco Integration

Install `monaco-editor` as a UI dependency and configure Vite workers locally. Do not use CDN loading.

Monaco options:

```ts
{
  readOnly: true,
  minimap: { enabled: false },
  automaticLayout: true,
  scrollBeyondLastLine: false,
}
```

Language detection:

- Use a simple extension-to-language map in UI for now.
- Backend may return `languageHint`; UI can override if present.

Tauri note:

- If Monaco fails in Tauri due to CSP, adjust `src-tauri/tauri.conf.json` narrowly for Monaco's local worker/runtime needs. Do not open broad remote origins.

## 7. Error Handling

Backend errors should be explicit and user-readable:

- `ide_tree_list: no projectCwd configured`
- `ide_tree_list: task worktree not found`
- `ide_read_file: path escapes source root`
- `ide_read_file: file is too large`
- `ide_read_file: binary files are not supported in Slice A`

UI should display:

- Tree fetch failure in the left pane.
- File read failure in the editor pane.
- Empty project/worktree state when no readable files are found.

## 8. Testing

Backend:

- `ide_tree_list` returns files under project root.
- `ide_tree_list` skips ignored directories.
- `ide_tree_list` caps entries and reports `truncated`.
- `ide_read_file` reads UTF-8 text.
- `ide_read_file` rejects path traversal.
- `ide_read_file` rejects binary files.
- `ide_read_file` rejects oversized files.
- Task worktree source resolves from task projection.
- MCP definitions expose both commands.
- Role authority treats both as read-only.

Frontend:

- `npm run typecheck`
- `npm run build`
- Component-level smoke where practical: source selector and file selection state.

Manual browser check:

- Open `Code`.
- Confirm project tree loads.
- Open a text file and verify Monaco renders it read-only.
- Switch to a task worktree when one exists.
- Refresh after creating/removing a file and verify expected state.

## 9. Acceptance Criteria

- Operator can open the `Code` view from the sidebar.
- Project root tree loads without direct filesystem access from React.
- Operator can select and read a file in Monaco.
- Monaco is read-only.
- Operator can switch to a created task worktree and inspect its files.
- Manual Refresh updates the current source.
- UI typecheck and production build pass.
- Backend test suite passes.

## 10. Deferred Slices

- Slice B: editable files with orchestrator-mediated save.
- Slice C: task diff viewer and keep/revert controls.
- Slice D: multi-tab editor and file search.
- Slice E: markdown preview and Foundry/spec editing.
- Slice F: agent activity overlay, drift gutter markers, diagnostics, and terminal/debug surfaces.
