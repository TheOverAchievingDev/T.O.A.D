# Agent Status Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose runtime/agent status through the local command facade and MCP tool metadata.

**Architecture:** `LocalToolFacade` gets an optional `runtimeRegistry` dependency. The `agent_status` command returns either all runtimes for the actor team or a single runtime by `runtimeId`; MCP metadata exposes the command as a read-only tool.

**Tech Stack:** Node.js ESM, `node:test`, existing runtime registry projection.

---

### Task 1: Agent Status Command And Tool

**Files:**
- Modify: `src/tools/localToolFacade.js`
- Modify: `src/mcp/localToolDefinitions.js`
- Modify: `src/app/LocalToadRuntime.js`
- Modify: `test/localToolFacade.test.js`
- Modify: `test/localMcpToolDefinitions.test.js`

- [x] **Step 1: Write failing tests**

Add tests proving `LocalToolFacade.execute({ commandName: 'agent_status' })` lists runtimes from `runtimeRegistry`, `agent_status` with `runtimeId` returns one runtime, and MCP tool definitions include read-only `agent_status` without `idempotencyKey`.

- [x] **Step 2: Run targeted tests to verify they fail**

Run: `node test/localToolFacade.test.js && node test/localMcpToolDefinitions.test.js`

Expected: FAIL because `agent_status` is not implemented and not exposed.

- [x] **Step 3: Implement minimal code**

Update `LocalToolFacade` to accept `runtimeRegistry = null` and handle `COMMANDS.AGENT_STATUS`. Update `LocalToadRuntime` to pass its registry. Add a read-only MCP tool definition with optional `runtimeId`.

- [x] **Step 4: Run targeted tests**

Run: `node test/localToolFacade.test.js && node test/localMcpToolDefinitions.test.js`

Expected: PASS.

- [x] **Step 5: Run full regression suite**

Run: `npm.cmd test`

Expected: PASS.
