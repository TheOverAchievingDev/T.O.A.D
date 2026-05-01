# UI Runtime Detail Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a right-side dashboard drawer that shows focused runtime details, events, tool calls, and API retry health.

**Architecture:** Add one read-only `runtime_events` local command backed by `LocalReadModel.listRuntimeAudit()`. The React dashboard keeps selected runtime state, opens a detail drawer from runtime rows, and fetches runtime-scoped detail through `/api/call`.

**Tech Stack:** Node.js ESM, `node:test`, Vite React, lucide-react, existing local API bridge.

---

### Task 1: Runtime Events Read Command

**Files:**
- Modify: `src/commands/command-contract.js`
- Modify: `src/mcp/localToolDefinitions.js`
- Modify: `src/tools/localToolFacade.js`
- Modify: `test/localToolFacade.test.js`
- Modify: `test/localMcpToolDefinitions.test.js`

- [x] **Step 1: Write failing tests**

Add tests proving `runtime_events` is exposed as a read-only MCP tool and `LocalToolFacade` returns audit events from `readModel.listRuntimeAudit({ teamId, runtimeId })`.

- [x] **Step 2: Verify tests fail**

Run:

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
```

Expected: FAIL because `runtime_events` is not yet a command.

- [x] **Step 3: Implement command**

Add `COMMANDS.RUNTIME_EVENTS`, define a read-only MCP tool with optional `runtimeId`, and route `LocalToolFacade.#runtimeEvents()` to the read model.

- [x] **Step 4: Verify targeted backend tests pass**

Run:

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
```

Expected: PASS.

### Task 2: Dashboard Runtime Detail Drawer

**Files:**
- Modify: `ui/src/components/Dashboard.jsx`

- [x] **Step 1: Add drawer state and detail fetch**

Track `selectedRuntimeId`, `runtimeEvents`, `runtimeTools`, and `runtimeHealth`. Fetch `runtime_events`, `tool_activity`, and `health_status` when a runtime is selected.

- [x] **Step 2: Add runtime Details controls**

Add a Details button to runtime cards and close the drawer if the selected runtime disappears from the runtime list.

- [x] **Step 3: Render the drawer**

Render a right-side drawer with runtime identity/status, health summary, recent events, and recent tool calls. Keep section empty states compact.

- [x] **Step 4: Verify UI checks**

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
- Modify: `docs/superpowers/plans/2026-04-30-ui-runtime-detail-drawer.md`

- [x] **Step 1: Run full regression**

Run:

```powershell
npm.cmd test
```

Expected: PASS.

- [x] **Step 2: Update docs**

Record the runtime detail drawer slice, command surface, verification, and next UI gap.

- [x] **Step 3: Mark checklist complete**

Update this plan after verification.
