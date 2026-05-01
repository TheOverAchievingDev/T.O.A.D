# Runtime Approval Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert Claude runtime permission/control requests into durable TOAD approval records.

**Architecture:** `ClaudeStreamJsonAdapter` normalizes CLI `control_request` events into internal `approval_request` runtime events. `RuntimeEventIngestor` validates runtime identity and persists those events through the shared approval broker. `LocalToadRuntime` wires the existing approval broker into the ingestor so the read model can surface pending approvals.

**Tech Stack:** Node.js ESM, `node:test`, existing runtime adapter, event ingestor, and approval broker APIs.

---

### Task 1: Normalize Claude Control Requests

**Files:**
- Modify: `src/runtime/ClaudeStreamJsonAdapter.js`
- Modify: `test/claudeStreamJsonAdapter.test.js`

- [x] **Step 1: Write the failing adapter test**

Add a test that writes this stream-json line to fake stdout:

```js
{
  type: 'control_request',
  request_id: 'approval-1',
  request: {
    subtype: 'can_use_tool',
    tool_name: 'Write',
    input: { file_path: 'README.md' },
  },
  session_id: 'session-1',
}
```

Assert the next adapter event is:

```js
{
  type: 'approval_request',
  approvalId: 'approval-1',
  toolName: 'Write',
  input: { file_path: 'README.md' },
  prompt: 'Approve Write',
  runtimeId: 'claude-lead-1',
  teamId: 'team-a',
  agentId: 'lead',
  sessionId: 'session-1',
}
```

- [x] **Step 2: Run adapter test to verify it fails**

Run: `node test/claudeStreamJsonAdapter.test.js`

Expected: FAIL because `control_request` currently normalizes as `runtime_event`.

- [x] **Step 3: Implement adapter normalization**

Add a `control_request` branch in `normalizeStreamJsonEvent()` before the fallback. Only `request.subtype === 'can_use_tool'` becomes `approval_request`; other control requests stay audit-only `runtime_event`.

- [x] **Step 4: Run adapter test**

Run: `node test/claudeStreamJsonAdapter.test.js`

Expected: PASS.

### Task 2: Persist Approval Requests

**Files:**
- Modify: `src/runtime/RuntimeEventIngestor.js`
- Modify: `src/app/LocalToadRuntime.js`
- Modify: `test/runtimeEventIngestor.test.js`
- Modify: `test/localToadRuntime.test.js`

- [x] **Step 1: Write the failing ingestor test**

Add an in-memory approval broker test double with `requestApproval()` and `listApprovals()`. Ingest an `approval_request` event and assert the broker receives:

```js
{
  approvalId: 'approval-1',
  teamId: 'team-a',
  agentId: 'lead',
  runtimeId: 'runtime-lead-1',
  prompt: 'Approve Write',
  metadata: {
    sessionId: 'session-1',
    runtimeEventType: 'approval_request',
    toolName: 'Write',
    input: { file_path: 'README.md' },
  },
}
```

- [x] **Step 2: Run ingestor test to verify it fails**

Run: `node test/runtimeEventIngestor.test.js`

Expected: FAIL because `RuntimeEventIngestor` has no approval broker dependency or `approval_request` handler.

- [x] **Step 3: Implement ingestor support**

Add optional `approvalBroker` constructor dependency. For `approval_request`, validate runtime identity, call `approvalBroker.requestApproval()`, and return `{ event, message: null, tool: null, approval }`. If no broker exists, leave it audit-only.

- [x] **Step 4: Wire LocalToadRuntime**

Pass the existing `approvalBroker` into the `RuntimeEventIngestor` constructed by `LocalToadRuntime`.

- [x] **Step 5: Run targeted tests**

Run:

```powershell
node test/runtimeEventIngestor.test.js
node --no-warnings test/localToadRuntime.test.js
```

Expected: PASS.

### Task 3: Documentation and Regression

**Files:**
- Modify: `TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
- Modify: `docs/superpowers/plans/2026-04-30-runtime-approval-ingestion.md`

- [x] **Step 1: Update reverse-engineering rebuild plan**

Mark runtime approval ingestion as implemented locally and note that non-tool control requests remain audit-only.

- [x] **Step 2: Run full regression suite**

Run: `npm.cmd test`

Expected: PASS.

- [x] **Step 3: Mark this checklist complete**

Update each completed checkbox in this plan after the corresponding verification command has run.
