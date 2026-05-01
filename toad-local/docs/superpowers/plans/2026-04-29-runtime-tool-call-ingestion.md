# Runtime Tool Call Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Normalize Claude `tool_use` stream-json parts and dispatch trusted runtime tool calls through the existing local command facade.

**Architecture:** `ClaudeStreamJsonAdapter` will emit separate `tool_use` events for assistant message content parts with `type: "tool_use"`. `RuntimeEventIngestor` remains the durable ingestion point: it audits every event, promotes assistant text to broker messages, and optionally dispatches allowlisted `tool_use` events through an injected `toolFacade`.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, existing Claude adapter tests, existing `RuntimeEventIngestor`, existing `LocalToolFacade`.

---

## File Structure

- Modify `C:\Project-TOAD\toad-local\src\runtime\ClaudeStreamJsonAdapter.js`
  - Emit one normalized `tool_use` event per Claude stream-json tool-use content part.
- Modify `C:\Project-TOAD\toad-local\test\claudeStreamJsonAdapter.test.js`
  - Add tool-use normalization coverage.
- Modify `C:\Project-TOAD\toad-local\src\runtime\RuntimeEventIngestor.js`
  - Add optional `toolFacade` dispatch for allowlisted `tool_use` events.
- Modify `C:\Project-TOAD\toad-local\test\runtimeEventIngestor.test.js`
  - Add tool-use dispatch, idempotency, and unsupported-tool audit-only coverage.
- Modify `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
  - Records the tool-call ingestion coverage.

---

### Task 1: Claude Tool-Use Normalization

**Files:**
- Modify: `C:\Project-TOAD\toad-local\test\claudeStreamJsonAdapter.test.js`
- Modify: `C:\Project-TOAD\toad-local\src\runtime\ClaudeStreamJsonAdapter.js`

- [x] **Step 1: Add failing adapter test**

Append a test proving an assistant stream-json message with a `tool_use` content part yields a normalized `tool_use` event with `toolName`, `toolUseId`, and `input`.

- [x] **Step 2: Run adapter test to verify failure**

Run:

```powershell
node test/claudeStreamJsonAdapter.test.js
```

Expected: failure because the adapter does not emit a separate `tool_use` event.

- [x] **Step 3: Implement tool-use event emission**

Modify the event iterable so `normalizeStreamJsonLine()` can return multiple events. For assistant events, emit `assistant_text` when text exists and also emit one `tool_use` event for each tool-use content part.

- [x] **Step 4: Run adapter tests**

Run:

```powershell
node test/claudeStreamJsonAdapter.test.js
```

Expected: adapter tests pass.

---

### Task 2: Runtime Tool Dispatch

**Files:**
- Modify: `C:\Project-TOAD\toad-local\test\runtimeEventIngestor.test.js`
- Modify: `C:\Project-TOAD\toad-local\src\runtime\RuntimeEventIngestor.js`

- [x] **Step 1: Add failing ingestor tests**

Add tests proving:
- `tool_use` event for `message_send` is audited and dispatched through `toolFacade.execute()`.
- repeated same `tool_use` event uses the same command idempotency key.
- unsupported `tool_use` events are audit-only and not dispatched.

- [x] **Step 2: Run ingestor test to verify failure**

Run:

```powershell
node test/runtimeEventIngestor.test.js
```

Expected: failure because `RuntimeEventIngestor` ignores `tool_use`.

- [x] **Step 3: Implement allowlisted dispatch**

Modify constructor to accept `toolFacade = null` and `allowedToolNames = ['message_send', 'task_create', 'task_update', 'task_comment']`. For `tool_use` events whose `toolName` is allowed and a facade exists, call:

```js
toolFacade.execute({
  commandName: event.toolName,
  idempotencyKey: `runtime-tool:${eventHash}`,
  actor: { teamId: event.teamId, agentId: event.agentId },
  args: event.input || {},
});
```

Return the command result as `tool`.

- [x] **Step 4: Run ingestor tests**

Run:

```powershell
node test/runtimeEventIngestor.test.js
```

Expected: ingestor tests pass.

---

### Task 3: Package Verification And Plan Checkpoint

**Files:**
- Modify: `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`

- [x] **Step 1: Update staged plan verification text**

Append:

```markdown
Runtime tool-call ingestion tests cover Claude tool-use normalization, allowlisted tool dispatch through the local command facade, command idempotency keys, and unsupported tool audit-only behavior.
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

- This slice does not implement tool-result responses back to Claude stdin yet; that requires a runtime-specific result writer.
- Dispatch is allowlist-based to avoid executing unknown runtime-emitted tools.
- Tool calls remain audited even when unsupported or no `toolFacade` is configured.
