# IDE File Compatibility Design

Date: 2026-05-18

## Goal

Make Symphony's file explorer and editor behave more like the practical core of Cursor or VS Code: most project files should be visible, common text/code formats should open with the right editor language, and unsupported files should show a clear state instead of failing like a broken editor.

This pass does not need image previews. Image and richer binary previews are deferred.

## Current Behavior

The IDE path is split across:

- Backend file tools in `src/ide/ideFileTools.js`
- Shared source shape in `ui/src/components/ideSource.ts`
- Explorer rendering in `ui/src/components/IdeFileTree.tsx`
- Editor tabs and Monaco integration in `ui/src/components/IdeEditorPane.tsx`
- Call sites in `CodeScreen` and `CockpitWithMe`

Today the backend only exposes a small language map and rejects binary or large files through `ide_read_file`. The UI can edit common text files and preview Markdown, but unsupported files surface as generic read errors. The explorer also treats file rows generically.

## Scope

### In Scope

- Add a shared file-classification layer for project files.
- Broaden text/code extension support.
- Return metadata that lets the UI distinguish editable text, read-only text, binary, and oversized files.
- Keep binary files visible in the explorer.
- Open unsupported files into a friendly metadata panel instead of an error-only panel.
- Keep existing save behavior restricted to safe UTF-8 text files.
- Preserve the existing project-root and task-worktree source model.

### Out of Scope

- Image previews.
- PDF previews.
- Audio/video viewers.
- Archive browsing.
- Notebook execution.
- VS Code extension compatibility.
- Editing binary or non-UTF-8 files.

## File Classification

Add a small shared classification module on the backend, with a mirrored or generated frontend mapping if needed. Classification should be based on extension/name first, then file content when the file is read.

Suggested categories:

- `text`: editable UTF-8 text/code/config files.
- `readonly_text`: UTF-8 text that is too large or not safe to edit in this UI.
- `binary`: binary or unknown binary content.
- `unsupported`: known non-text file classes such as archives, fonts, PDFs, media, and images.

Each tree entry should be able to carry optional metadata:

- `languageHint`
- `category`
- `editable`
- `previewable`
- `binary`
- `reason`

The UI should still tolerate older backend responses where these fields are absent.

## Language Coverage

Broaden Monaco language hints for common project files:

- Web: JS, JSX, TS, TSX, CSS, SCSS, Less, HTML, Vue, Svelte.
- Data/config: JSON, JSONC, YAML, TOML, XML, INI, `.env`, lockfiles where useful.
- Backend: Python, Go, Rust, Java, Kotlin, C, C++, C#, PHP, Ruby, Swift, SQL.
- Shell/devops: Shell, PowerShell, Dockerfile, Compose files, Makefile.
- Docs: Markdown, MDX, plaintext.

Unknown UTF-8 files should still open as `plaintext`.

## Read Behavior

`ide_read_file` should return one of two honest shapes:

1. Editable text content:
   - Existing content fields remain compatible.
   - Add classification metadata.

2. Unsupported metadata:
   - No text content required.
   - Include `relativePath`, `sizeBytes`, `category`, `editable:false`, and a readable `reason`.

Do not throw for normal unsupported-file cases. Reserve errors for real failures: path traversal, missing file, directory read, filesystem errors.

Large text files should not crash or freeze the UI. A first pass can keep the existing size cap for editable content and return an oversized metadata state for files above that cap.

## Write Behavior

`ide_write_file` remains text-only.

Rules:

- Require string content.
- Reject binary content.
- Keep expected hash checks.
- Preserve existing atomic temp-file write.
- Return the same read result shape after save.

The UI should disable Save/Revert for non-editable tabs.

## Explorer Behavior

The file tree should continue to show all normal files under the project root, including unsupported file classes. It should:

- Use richer file metadata when available.
- Keep directory-first sorting.
- Show size as it does today.
- Optionally show a simple class marker or title tooltip for binary/unsupported/readonly files.

No visual preview work is required in this pass.

## Editor Behavior

When opening a file:

- Editable text opens in Monaco.
- Markdown keeps the existing Code/Preview/Split toggle.
- Unsupported/binary/oversized files open a tab with a clear metadata panel.
- File read failures still show error state.

The unsupported panel should explain what the app can and cannot do, for example:

- file name
- size
- type/category
- why it is not editable

This panel prevents unsupported files from looking like broken loads.

## Testing

Backend tests:

- Classification maps common names/extensions to expected language/category.
- UTF-8 unknown extension opens as plaintext.
- Binary content returns unsupported metadata rather than an ordinary text result.
- Oversized text returns a non-editable oversized state.
- Path safety behavior remains unchanged.
- Text writes still reject binary content and stale hashes.

Frontend tests:

- Language resolver maps broad file types.
- Non-editable file metadata disables edit/save affordances.
- Unsupported state renders a clear panel.
- Existing markdown controls still render for Markdown text files.

Manual verification:

- Open a generated fixture tree with representative files.
- Confirm the explorer lists text, unsupported, and large files.
- Confirm editable files render in Monaco with reasonable language hints.
- Confirm unsupported files do not produce scary read-error UI.

## Implementation Order

1. Add backend file classification helper and tests.
2. Extend tree and read result metadata while preserving existing response fields.
3. Update frontend types and language resolution helper.
4. Add unsupported-file tab state in `IdeEditorPane`.
5. Add focused frontend tests.
6. Run root and UI verification.

## Open Decisions

- Image previews are explicitly deferred.
- Large text files should be non-editable in v1 rather than virtualized.
- Binary file download/open-in-external-app behavior is deferred unless the Tauri shell already exposes a safe existing primitive.
