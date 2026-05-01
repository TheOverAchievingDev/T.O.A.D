# UI Approval Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display pending approvals in the dashboard and let the operator approve or deny them.

**Architecture:** Add a read-only `approval_list` facade/MCP command backed by `LocalReadModel.listApprovals()`. Update the dashboard to fetch approvals through `/api/call`, render a pending approval panel, and call the existing mutating `approval_respond` tool for decisions.

**Tech Stack:** Node.js ESM, `node:test`, Vite React, existing local API bridge.

---

### Task 1: Approval List Command

**Files:**
- Modify: `src/commands/command-contract.js`
- Modify: `src/tools/localToolFacade.js`
- Modify: `src/mcp/localToolDefinitions.js`
- Modify: `test/localToolFacade.test.js`
- Modify: `test/localMcpToolDefinitions.test.js`

- [x] **Step 1: Write failing tests**

Add tests proving `approval_list` is exposed as a read-only MCP tool and `LocalToolFacade` returns approvals from `readModel.listApprovals({ teamId })`.

- [x] **Step 2: Verify tests fail**

Run:

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
```

Expected: FAIL because `approval_list` is not yet a command.

- [x] **Step 3: Implement command**

Add `COMMANDS.APPROVAL_LIST`, define a read-only MCP tool, and route `LocalToolFacade.#approvalList()` to the read model.

- [x] **Step 4: Verify targeted backend tests pass**

Run:

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
```

Expected: PASS.

### Task 2: Dashboard Approval Panel

**Files:**
- Modify: `ui/src/components/Dashboard.jsx`

- [x] **Step 1: Add dashboard approval data flow**

Fetch `approval_list` alongside health, runtimes, and tasks. Store approvals in component state and derive pending approvals.

- [x] **Step 2: Add approval resolution controls**

Render pending approvals with tool/prompt/input metadata and Approve/Deny buttons. Use `approval_respond` with stable idempotency keys like `ui-approval-${approvalId}-approved`.

- [x] **Step 3: Verify UI checks**

Run:

```powershell
cd ui
npm.cmd run lint
npm.cmd run build
```

Expected: PASS.

### Task 3: Regression And Docs

**Files:**
- Modify: `HANDOFF-NEXT-AGENT.md`
- Modify: `TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
- Modify: `docs/superpowers/plans/2026-04-30-ui-approval-resolution.md`

- [x] **Step 1: Run full regression**

Run:

```powershell
npm.cmd test
```

Expected: PASS.

- [x] **Step 2: Update docs**

Record the approval-resolution dashboard slice, current verification, and next UI gap.

- [x] **Step 3: Mark checklist complete**

Update this plan after verification.
