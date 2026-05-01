# Approval Respond Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a minimal local approval broker and expose `approval_respond` through the local command facade and MCP tool layer.

**Architecture:** `InMemoryApprovalBroker` stores approval requests and idempotent responses. `LocalToolFacade` accepts an optional approval broker and implements `approval_respond` as a mutating command. MCP metadata exposes the tool with `approvalId`, `decision`, and optional `reason`.

**Tech Stack:** Node.js ESM, `node:test`, existing command facade and MCP metadata modules.

---

### Task 1: Approval Broker And Command

**Files:**
- Create: `src/approval/inMemoryApprovalBroker.js`
- Create: `test/approvalBroker.test.js`
- Modify: `src/tools/localToolFacade.js`
- Modify: `src/mcp/localToolDefinitions.js`
- Modify: `src/app/LocalToadRuntime.js`
- Modify: `test/localToolFacade.test.js`
- Modify: `test/localMcpToolDefinitions.test.js`
- Modify: `package.json`

- [x] **Step 1: Write failing tests**

Add tests proving approvals can be requested/responded idempotently, `approval_respond` updates an approval through `LocalToolFacade`, and MCP definitions expose mutating `approval_respond` with required `idempotencyKey`.

- [x] **Step 2: Run targeted tests to verify they fail**

Run: `node test/approvalBroker.test.js && node test/localToolFacade.test.js && node test/localMcpToolDefinitions.test.js`

Expected: FAIL because the approval broker module and command implementation do not exist.

- [x] **Step 3: Implement minimal code**

Implement `InMemoryApprovalBroker` with `requestApproval()`, `respondApproval()`, `getApproval()`, and `listApprovals()`. Wire it into `LocalToolFacade`, `LocalToadRuntime`, and MCP tool definitions.

- [x] **Step 4: Run targeted tests**

Run: `node test/approvalBroker.test.js && node test/localToolFacade.test.js && node test/localMcpToolDefinitions.test.js`

Expected: PASS.

- [x] **Step 5: Run full regression suite**

Run: `npm.cmd test`

Expected: PASS.
