# Claude Tool Result Return Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send executed tool-call results back to Claude-style stream-json runtimes.

**Architecture:** Extend `ClaudeStreamJsonAdapter` with `sendToolResult()` that writes newline-delimited stream-json tool-result payloads to stdin. Extend `RuntimeEventIngestor` with an optional runtime adapter lookup so allowlisted tool-use events can execute through `toolFacade` and then return either a success or error result to the originating runtime.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, existing Claude stream-json adapter, existing runtime event ingestor.

---

## File Structure

- Modify `C:\Project-TOAD\toad-local\src\runtime\ClaudeStreamJsonAdapter.js`
  - Add `sendToolResult()` and share stdin write validation with `sendTurn()`.
- Modify `C:\Project-TOAD\toad-local\test\claudeStreamJsonAdapter.test.js`
  - Add tool-result serialization and non-writable stdin coverage.
- Modify `C:\Project-TOAD\toad-local\src\runtime\RuntimeEventIngestor.js`
  - Add optional `adapters` map and call `sendToolResult()` after dispatched tools.
- Modify `C:\Project-TOAD\toad-local\test\runtimeEventIngestor.test.js`
  - Add success and error tool-result return coverage.
- Modify `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
  - Records tool-result return coverage.

---

### Task 1: Claude Tool Result Serialization

**Files:**
- Modify: `C:\Project-TOAD\toad-local\test\claudeStreamJsonAdapter.test.js`
- Modify: `C:\Project-TOAD\toad-local\src\runtime\ClaudeStreamJsonAdapter.js`

- [x] **Step 1: Add failing adapter tests**

Add tests proving:
- `sendToolResult({ toolUseId, result })` writes a stream-json user message with `tool_result` content.
- `sendToolResult()` rejects when stdin is not writable.

- [x] **Step 2: Run adapter test to verify failure**

Run:

```powershell
node test/claudeStreamJsonAdapter.test.js
```

Expected: failure because `sendToolResult()` does not exist.

- [x] **Step 3: Implement `sendToolResult()`**

Write newline-delimited JSON:

```js
{
  type: 'user',
  message: {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: JSON.stringify(result ?? null)
      }
    ]
  }
}
```

Return `{ accepted: true, responseState: 'tool_result_returned', receipt: { written: true, runtimeId, toolUseId } }`.

- [x] **Step 4: Run adapter tests**

Run:

```powershell
node test/claudeStreamJsonAdapter.test.js
```

Expected: adapter tests pass.

---

### Task 2: Ingestor Tool Result Return

**Files:**
- Modify: `C:\Project-TOAD\toad-local\test\runtimeEventIngestor.test.js`
- Modify: `C:\Project-TOAD\toad-local\src\runtime\RuntimeEventIngestor.js`

- [x] **Step 1: Add failing ingestor tests**

Add tests proving:
- after a successful allowlisted tool dispatch, the ingestor calls `adapter.sendToolResult()` with the tool-use id and command result.
- if `toolFacade.execute()` throws, the ingestor still calls `adapter.sendToolResult()` with an error payload and returns the thrown error information without losing the audit event.

- [x] **Step 2: Run ingestor test to verify failure**

Run:

```powershell
node test/runtimeEventIngestor.test.js
```

Expected: failure because the ingestor does not know about adapters or tool-result return.

- [x] **Step 3: Implement adapter lookup and result return**

Modify constructor to accept `adapters = new Map()`. After tool dispatch, if an adapter exists for `event.runtimeId` and has `sendToolResult()`, call it with:

```js
{
  toolUseId: event.toolUseId,
  result: toolResult,
  error: null
}
```

On tool execution error, call with:

```js
{
  toolUseId: event.toolUseId,
  result: null,
  error: error.message
}
```

Return `{ event, message: null, tool, toolResult }` for success and `{ event, message: null, tool: null, toolError, toolResult }` for failure.

- [x] **Step 4: Run ingestor tests**

Run:

```powershell
node test/runtimeEventIngestor.test.js
```

Expected: ingestor tests pass.

---

### Task 3: Plan Checkpoint And Verification

**Files:**
- Modify: `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`

- [x] **Step 1: Update staged plan verification text**

Append:

```markdown
Tool-result return tests cover Claude stream-json tool-result serialization, non-writable stdin failure, successful tool-result return after dispatch, and error-result return when tool execution throws.
```

- [x] **Step 2: Run final verification**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass.

Because this workspace has no `.git` metadata and the user asked to keep work local, skip commits and report changed files.

---

## Self-Review Notes

- This assumes Claude accepts stream-json `tool_result` inside a user message; if real CLI behavior differs, only this adapter method should change.
- Unsupported tools remain audit-only and do not receive tool results because no tool execution happened.
- Durable tool-result audit rows can be added later if the runtime event log needs separate result events.
