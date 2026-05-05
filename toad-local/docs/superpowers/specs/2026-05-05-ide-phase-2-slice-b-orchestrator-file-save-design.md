# IDE Phase 2 Slice B - Orchestrator File Save Design

**Status:** approved 2026-05-05  
**Builds on:** `2026-05-05-ide-phase-2-slice-a-monaco-reading-surface-design.md`

## Problem

Slice A made the Code screen useful for reading files, but the editor is still passive. Operators need to make small corrections to project files or task worktrees without leaving TOAD, while preserving the core rule from the IDE north star:

> IDE can show and edit. Symphony decides state. Git proves changes.

Direct browser filesystem writes would violate that boundary. Slice B adds file saving through the same `LocalToolFacade` command path used by read operations.

## Scope

In scope:

- Add one backend command: `ide_write_file`.
- Allow `human` and `lead` actors to save UTF-8 text files under the project root or a created task worktree.
- Keep path resolution, symlink escape prevention, size caps, and binary-content rejection on the backend.
- Add optimistic concurrency via `expectedSha256` so stale editor buffers cannot silently overwrite newer disk contents.
- Write files atomically using a temp file in the target directory followed by rename.
- Return the same file payload shape as `ide_read_file`, including updated `sha256`, `sizeBytes`, and `languageHint`.
- Make Monaco editable in the Code screen, track dirty state, and expose Save/Revert controls.
- Refresh the tree after save so file sizes and newly-created file entries stay accurate.

Out of scope:

- Creating new files from an empty path picker.
- Deleting, renaming, or moving files.
- Git commits, task status transitions, review requests, or validation runs.
- Hunk-level diff, keep/revert controls, or checkpoints.
- Agent-side write access. Slice B remains an operator IDE surface.

## Backend Design

`src/ide/ideFileTools.js` adds:

```js
writeIdeFile({
  projectCwd,
  taskBoard,
  teamId,
  source,
  relativePath,
  content,
  expectedSha256,
  maxBytes,
})
```

The helper reuses the same source resolution and inside-root path checks as `readIdeFile`. Existing files must resolve inside the root after symlink resolution. Missing files may be created only when their parent directory already resolves inside the root. This keeps Slice B useful for simple new files while avoiding implicit directory creation.

Optimistic concurrency:

- If the file exists and `expectedSha256` is supplied, the backend hashes current disk bytes before writing.
- If the hashes differ, the command rejects with `ide_write_file: file changed on disk`.
- If the file does not exist and `expectedSha256` is supplied, the command rejects.

Content rules:

- `content` must be a string.
- UTF-8 byte size must be at or below the cap, defaulting to 1 MiB.
- Content containing NUL bytes is rejected as binary.

Write rules:

- Refuse directories and non-regular files.
- Write to `.<basename>.toad-tmp-<pid>-<timestamp>` in the same directory.
- Rename the temp file over the target.
- Remove the temp file on failure when possible.
- Return a fresh read-style payload after the write.

## Command Surface

Add `IDE_WRITE_FILE: 'ide_write_file'` to `COMMANDS` and `MUTATING_COMMANDS`.

MCP schema:

```ts
{
  source?: IdeSource;
  relativePath: string;
  content: string;
  expectedSha256?: string;
}
```

Role authority stays implicit: `lead` and `human` wildcard access can call it; developer/reviewer/tester/architect cannot unless a later agent-tool slice explicitly grants it.

## Frontend Design

`CodeScreen` becomes an editor, not just a viewer:

- Header eyebrow changes from `Read-only IDE` to `IDE`.
- Monaco `readOnly` becomes `false`.
- File state keeps both `file.content` and an editable `draftContent`.
- Dirty state is `draftContent !== file.content`.
- Save button is enabled only when a file is selected, dirty, and not currently saving.
- Revert button restores `draftContent` from the last saved/read file.
- When selecting another file while dirty, the UI confirms before discarding unsaved changes.
- Source changes and refresh also confirm before discarding unsaved changes.
- Successful save updates `file`, `draftContent`, size, hash, dirty state, and tree.
- Stale save errors are shown in the editor pane; the user can Refresh/Revert to reload disk content.

## Data Contracts

`ide_read_file` gains a backward-compatible `sha256` field:

```ts
{
  source: IdeSource;
  relativePath: string;
  content: string;
  encoding: 'utf8';
  sizeBytes: number;
  sha256: string;
  languageHint?: string;
}
```

`ide_write_file` returns the same shape.

## Acceptance Criteria

- `ide_read_file` returns `sha256`.
- `ide_write_file` writes an existing UTF-8 file through `LocalToolFacade`.
- `ide_write_file` creates a missing file when the parent directory exists.
- `ide_write_file` rejects traversal, absolute paths, directory targets, binary content, oversized content, and stale `expectedSha256`.
- MCP exposes `ide_write_file` as a mutating tool requiring `idempotencyKey`.
- Role authority denies `ide_write_file` to developer/reviewer/tester/architect.
- Code screen supports editing, Save, Revert, dirty state, and stale-save errors.
- Backend tests, UI typecheck, UI build, and an HTTP smoke pass.

## Deferred

- New file UX with folder picker and directory creation.
- Save audit events separate from the side-effect log.
- Git-backed checkpoints before save.
- Task diff view and hunk-level revert.
- Agent write tools.
