# Review Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose task review lifecycle commands through the local command facade and MCP tool layer.

**Architecture:** `LocalToolFacade` maps `review_request` and `review_decide` onto existing task events (`task.review_requested`, `task.review_decided`). MCP metadata exposes both as mutating idempotent tools.

**Tech Stack:** Node.js ESM, `node:test`, existing task event projection.

---

### Task 1: Review Request And Decision Commands

**Files:**
- Modify: `src/tools/localToolFacade.js`
- Modify: `src/mcp/localToolDefinitions.js`
- Modify: `test/localToolFacade.test.js`
- Modify: `test/localMcpToolDefinitions.test.js`

- [x] **Step 1: Write failing tests**

Add tests proving `review_request` sets `reviewState` to `review`, `review_decide` with `approved` sets review state to `approved`, and `review_decide` with `changes_requested` sets review state to `needs_fix` and task status to `pending`. Add MCP schema tests proving both tools require `idempotencyKey`.

- [x] **Step 2: Run targeted tests to verify they fail**

Run: `node test/localToolFacade.test.js && node test/localMcpToolDefinitions.test.js`

Expected: FAIL because review commands are unsupported and not exposed through MCP.

- [x] **Step 3: Implement minimal code**

Add facade handlers for `COMMANDS.REVIEW_REQUEST` and `COMMANDS.REVIEW_DECIDE`. Add MCP definitions with required `taskId`, and `decision` for `review_decide`.

- [x] **Step 4: Run targeted tests**

Run: `node test/localToolFacade.test.js && node test/localMcpToolDefinitions.test.js`

Expected: PASS.

- [x] **Step 5: Run full regression suite**

Run: `npm.cmd test`

Expected: PASS.
