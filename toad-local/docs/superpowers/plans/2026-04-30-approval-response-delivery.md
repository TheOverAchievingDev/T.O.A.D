# Approval Response Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Send approved/denied approval responses back to the live Claude runtime that requested them.

**Architecture:** `ClaudeStreamJsonAdapter.approve()` writes Claude `control_response` JSON to stdin. `LocalToolFacade` continues to own `approval_respond`, but now optionally receives runtime adapters and forwards a broker response to the requesting runtime when the approval record has a `runtimeId`. `LocalToadRuntime` wires the shared adapter map into the facade.

**Tech Stack:** Node.js ESM, `node:test`, existing adapter and approval broker APIs.

---

### Task 1: Claude Adapter Response Writer

**Files:**
- Modify: `src/runtime/ClaudeStreamJsonAdapter.js`
- Modify: `test/claudeStreamJsonAdapter.test.js`

- [x] **Step 1: Write failing adapter tests**

Add tests for:

```js
await adapter.approve({
  approvalId: 'approval-1',
  decision: 'approved',
});
```

Expected stdin payload:

```js
{
  type: 'control_response',
  response: {
    subtype: 'success',
    request_id: 'approval-1',
    response: { behavior: 'allow', updatedInput: {} },
  },
}
```

Add a denied test expecting `{ behavior: 'deny', message: 'No writes.' }`.

- [x] **Step 2: Run adapter tests to verify failure**

Run: `node test/claudeStreamJsonAdapter.test.js`

Expected: FAIL because `ClaudeStreamJsonAdapter.approve()` is not implemented.

- [x] **Step 3: Implement `approve()`**

Write a `control_response` JSON line to stdin. Map `approved` to `allow`; map `denied` to `deny`.

- [x] **Step 4: Run adapter tests**

Run: `node test/claudeStreamJsonAdapter.test.js`

Expected: PASS.

### Task 2: Approval Tool Dispatch

**Files:**
- Modify: `src/tools/localToolFacade.js`
- Modify: `src/app/LocalToadRuntime.js`
- Modify: `test/localToolFacade.test.js`
- Modify: `test/localToadRuntime.test.js`

- [x] **Step 1: Write failing facade/orchestrator tests**

Add a facade test proving `approval_respond` forwards to an adapter when the approval broker returns an approval with `runtimeId`. Add an orchestrator test that launches a fake Claude runtime, ingests an `approval_request`, calls `approval_respond`, and asserts a `control_response` line is written to child stdin.

- [x] **Step 2: Run tests to verify failure**

Run:

```powershell
node test/localToolFacade.test.js
node --no-warnings test/localToadRuntime.test.js
```

Expected: FAIL because adapters are not wired into `LocalToolFacade`.

- [x] **Step 3: Implement dispatch**

Inject optional `adapters` into `LocalToolFacade`. After `approvalBroker.respondApproval()`, look up `approval.runtimeId`, call `adapter.approve()` when present, and include `runtimeResponse` in the returned structured result.

- [x] **Step 4: Wire `LocalToadRuntime`**

Pass the shared `adapters` map into `LocalToolFacade`.

- [x] **Step 5: Run targeted tests**

Run:

```powershell
node test/localToolFacade.test.js
node --no-warnings test/localToadRuntime.test.js
```

Expected: PASS.

### Task 3: Documentation and Regression

**Files:**
- Modify: `TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
- Modify: `docs/superpowers/plans/2026-04-30-approval-response-delivery.md`

- [x] **Step 1: Update rebuild plan**

Record that local approval responses now write Claude `control_response` payloads to live runtimes.

- [x] **Step 2: Run full regression suite**

Run: `npm.cmd test`

Expected: PASS.

- [x] **Step 3: Mark this checklist complete**

Update this plan’s completed checkboxes after verification.
