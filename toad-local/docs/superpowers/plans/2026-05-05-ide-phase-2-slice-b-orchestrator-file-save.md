# IDE Phase 2 Slice B Orchestrator File Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe, orchestrator-mediated file saving to the Code screen.

**Architecture:** Backend writes go through `LocalToolFacade` and reuse the Slice A source/path safety helpers. The UI only holds draft editor state and calls `ide_write_file`; it never writes directly to disk.

**Tech Stack:** Node ESM backend, synchronous filesystem helpers, SHA-256 hashing, React 18 + TypeScript, Monaco editor.

---

## File Structure

- Modify `src/ide/ideFileTools.js`: add SHA-256 output and `writeIdeFile`.
- Modify `src/commands/command-contract.js`: add `IDE_WRITE_FILE` as mutating command.
- Modify `src/tools/localToolFacade.js`: dispatch `ide_write_file`.
- Modify `src/mcp/localToolDefinitions.js`: expose MCP schema.
- Modify `test/ideFileTools.test.js`: helper-level read hash and write tests.
- Modify `test/localToolFacade.test.js`: facade tests for write command.
- Modify `test/localMcpToolDefinitions.test.js`: MCP schema/idempotency tests.
- Modify `test/roleAuthority.test.js`: operator-only write authority test.
- Modify `ui/src/components/CodeScreen.tsx`: editable Monaco, Save/Revert, dirty guard.
- Modify `ui/src/styles/app-shell.css`: filebar save/revert layout and dirty marker.

---

### Task 1: Backend Write Helper

**Files:**
- Modify: `src/ide/ideFileTools.js`
- Test: `test/ideFileTools.test.js`

- [ ] **Step 1: Write failing tests**

Add tests covering:

- `readIdeFile` returns SHA-256.
- `writeIdeFile` updates an existing file and returns updated content/hash.
- `writeIdeFile` creates a missing file when the parent exists.
- `writeIdeFile` rejects stale `expectedSha256`.
- `writeIdeFile` rejects traversal/absolute paths.
- `writeIdeFile` rejects binary content and oversized content.
- `writeIdeFile` rejects directory targets.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --no-warnings test/ideFileTools.test.js
```

Expected: fails because `writeIdeFile` is not exported and `sha256` is missing.

- [ ] **Step 3: Implement helper**

In `src/ide/ideFileTools.js`:

- Import `renameSync`, `unlinkSync`, and `writeFileSync` from `node:fs`.
- Import `createHash` from `node:crypto`.
- Add `sha256: sha256(bytes)` to `readIdeFile`.
- Split path resolution into read-existing and write-target helpers.
- Add `writeIdeFile` with string content validation, size cap, binary NUL rejection, stale hash check, temp write, rename, and fresh return payload.

- [ ] **Step 4: Verify GREEN**

Run:

```powershell
node --no-warnings test/ideFileTools.test.js
```

Expected: all helper tests pass.

- [ ] **Step 5: Commit**

```powershell
git add src/ide/ideFileTools.js test/ideFileTools.test.js
git commit -m "feat(ide): add safe file write helper"
```

---

### Task 2: Backend Command, MCP, and Authority Wiring

**Files:**
- Modify: `src/commands/command-contract.js`
- Modify: `src/tools/localToolFacade.js`
- Modify: `src/mcp/localToolDefinitions.js`
- Test: `test/localToolFacade.test.js`
- Test: `test/localMcpToolDefinitions.test.js`
- Test: `test/roleAuthority.test.js`

- [ ] **Step 1: Write failing tests**

Add facade tests that:

- Call `ide_write_file` through `LocalToolFacade`.
- Verify it writes content under `projectCwd`.
- Verify it works for a created task worktree.

Add MCP tests that:

- `ide_write_file` exists.
- It requires `idempotencyKey`.
- It requires `relativePath` and `content`.

Add role authority tests that:

- `human` and `lead` can call `ide_write_file`.
- `developer`, `reviewer`, `tester`, and `architect` cannot.

- [ ] **Step 2: Verify RED**

Run:

```powershell
node --no-warnings test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
node test/roleAuthority.test.js
```

Expected: failures for missing command/tool wiring.

- [ ] **Step 3: Wire command**

- Add `IDE_WRITE_FILE: 'ide_write_file'`.
- Add it to `MUTATING_COMMANDS`.
- Import `writeIdeFile` in `LocalToolFacade`.
- Dispatch to `#ideWriteFile(actor, args)`.
- Require `relativePath` and `content` strings.
- Pass optional `expectedSha256` only when it is a string.

- [ ] **Step 4: Add MCP definition**

Add a mutating MCP tool with:

- Required: `idempotencyKey`, `relativePath`, `content`.
- Properties: `source`, `relativePath`, `content`, `expectedSha256`.

- [ ] **Step 5: Verify GREEN**

Run:

```powershell
node --no-warnings test/ideFileTools.test.js
node --no-warnings test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
node test/roleAuthority.test.js
```

Expected: all pass.

- [ ] **Step 6: Commit**

```powershell
git add src/commands/command-contract.js src/tools/localToolFacade.js src/mcp/localToolDefinitions.js test/localToolFacade.test.js test/localMcpToolDefinitions.test.js test/roleAuthority.test.js
git commit -m "feat(ide): expose file save command"
```

---

### Task 3: Editable Code Screen

**Files:**
- Modify: `ui/src/components/CodeScreen.tsx`
- Modify: `ui/src/styles/app-shell.css`

- [ ] **Step 1: Update file result type**

Add `sha256: string` to `IdeFileResult`.

- [ ] **Step 2: Add draft state**

Add state:

```ts
const [draftContent, setDraftContent] = useState('');
const [savingFile, setSavingFile] = useState(false);
const [saveError, setSaveError] = useState<string | null>(null);
```

Compute:

```ts
const isDirty = file !== null && draftContent !== file.content;
```

- [ ] **Step 3: Guard dirty navigation**

Before opening another file, changing source, or refreshing without reopening the current file, call:

```ts
if (isDirty && !window.confirm('Discard unsaved changes?')) return;
```

- [ ] **Step 4: Save and revert**

Add `saveFile()` calling:

```ts
callTool<IdeFileResult>({
  actor: toolActor,
  method: 'ide_write_file',
  args: {
    source,
    relativePath: file.relativePath,
    content: draftContent,
    expectedSha256: file.sha256,
  },
  idempotencyKey: `ide-save-${Date.now()}-${Math.random().toString(36).slice(2)}`,
})
```

On success, update `file`, `draftContent`, clear errors, and refresh the tree while keeping the saved file open.

Add `revertFile()` that restores `draftContent` from `file.content`.

- [ ] **Step 5: Make Monaco editable**

Pass `value={draftContent}`, `onChange={(value) => setDraftContent(value ?? '')}`, and `readOnly: false`.

Add Save/Revert buttons to the filebar and a dirty indicator.

- [ ] **Step 6: Verify UI**

Run:

```powershell
cd ui
npm run typecheck
npm run build
```

Expected: both pass.

- [ ] **Step 7: Commit**

```powershell
git add ui/src/components/CodeScreen.tsx ui/src/styles/app-shell.css
git commit -m "feat(ui): save files from code view"
```

---

### Task 4: Final Verification

**Files:**
- No planned source changes.

- [ ] **Step 1: Full backend tests**

Run:

```powershell
npm test
```

Expected: pass. Usage-probe warnings are acceptable if tests exit 0.

- [ ] **Step 2: UI checks**

Run:

```powershell
cd ui
npm run typecheck
npm run build
```

Expected: pass. Monaco chunk-size warnings are acceptable if build exits 0.

- [ ] **Step 3: HTTP smoke**

Start the dev API on an alternate port and call `ide_write_file` against a temporary file under the project root. Then read it back through `ide_read_file`.

Expected:

- Write returns HTTP 200.
- Read returns the saved content and a SHA-256 string.

- [ ] **Step 4: Final status**

Run:

```powershell
git status --short
```

Expected: clean in the isolated worktree.
