# UI Cross-Team Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dashboard cross-team chat panel that lists cross-team conversations and sends messages through `cross_team_send`.

**Architecture:** Add a `LocalReadModel.listCrossTeamMessages()` projection, expose it through a read-only `cross_team_messages` MCP/facade command, and render a dashboard panel that groups messages by conversation id. Sending reuses the existing mutating `cross_team_send` command with stable UI idempotency keys.

**Tech Stack:** Node.js ESM, `node:test`, Vite React, lucide-react, existing local API bridge.

---

### Task 1: Cross-Team Message Projection

**Files:**
- Modify: `src/read/LocalReadModel.js`
- Modify: `test/localReadModel.test.js`

- [x] **Step 1: Write failing projection test**

Add a test proving `listCrossTeamMessages({ teamId })` returns only cross-team rows, strips the prefix, and reports inbound/outbound direction.

- [x] **Step 2: Verify projection test fails**

Run:

```powershell
node test/localReadModel.test.js
```

Expected: FAIL because `listCrossTeamMessages()` is not implemented.

- [x] **Step 3: Implement projection**

Add `listCrossTeamMessages()` using `parseCrossTeamPrefix()`, `stripCrossTeamPrefix()`, `CROSS_TEAM_SOURCE`, and `CROSS_TEAM_SENT_SOURCE`.

- [x] **Step 4: Verify projection test passes**

Run:

```powershell
node test/localReadModel.test.js
```

Expected: PASS.

### Task 2: Cross-Team Messages Command

**Files:**
- Modify: `src/commands/command-contract.js`
- Modify: `src/mcp/localToolDefinitions.js`
- Modify: `src/tools/localToolFacade.js`
- Modify: `test/localToolFacade.test.js`
- Modify: `test/localMcpToolDefinitions.test.js`

- [x] **Step 1: Write failing command tests**

Add tests proving `cross_team_messages` is exposed as read-only and `LocalToolFacade` calls `readModel.listCrossTeamMessages({ teamId, limit })`.

- [x] **Step 2: Verify command tests fail**

Run:

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
```

Expected: FAIL because `cross_team_messages` is not yet a command.

- [x] **Step 3: Implement command**

Add command contract entry, MCP tool definition, and facade handler.

- [x] **Step 4: Verify targeted command tests pass**

Run:

```powershell
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
```

Expected: PASS.

### Task 3: Dashboard Cross-Team Panel

**Files:**
- Modify: `ui/src/components/Dashboard.jsx`

- [x] **Step 1: Add cross-team state and fetch**

Fetch `cross_team_messages` with the main dashboard data and store it in component state.

- [x] **Step 2: Render conversations and thread**

Group messages by conversation id, render a conversation list and selected thread.

- [x] **Step 3: Add compose form**

Add target team, target agent, conversation id, and text inputs. Submit through `cross_team_send` with a stable idempotency key.

- [x] **Step 4: Verify UI checks**

Run:

```powershell
cd ui
npm.cmd run lint
npm.cmd run build
```

Expected: PASS.

### Task 4: Regression And Docs

**Files:**
- Modify: `HANDOFF-NEXT-AGENT.md`
- Modify: `TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
- Modify: `docs/superpowers/plans/2026-04-30-ui-cross-team-chat.md`

- [x] **Step 1: Run full regression**

Run:

```powershell
npm.cmd test
```

Expected: PASS.

- [x] **Step 2: Update docs**

Record the cross-team chat slice, current command surface, verification, and next UI/API gap.

- [x] **Step 3: Mark checklist complete**

Update this plan after verification.
