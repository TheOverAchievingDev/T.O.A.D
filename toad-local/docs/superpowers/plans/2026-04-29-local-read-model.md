# Local Read Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local read-model API for chat, tasks, runtime process state, runtime audit rows, and a compact team overview.

**Architecture:** Add `listMessages()` to both broker implementations so projections do not depend on inbox-specific filtering. Add a focused `LocalReadModel` that composes existing broker, task board, runtime registry, and runtime event log APIs without owning durable state itself.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, existing in-memory and SQLite broker/task/runtime classes.

---

## File Structure

- Modify `C:\Project-TOAD\toad-local\src\broker\inMemoryBroker.js`
  - Add `listMessages({ teamId, conversationId, limit })`.
- Modify `C:\Project-TOAD\toad-local\src\broker\sqliteBroker.js`
  - Add the same `listMessages()` API.
- Modify `C:\Project-TOAD\toad-local\test\broker.test.js`
  - Add in-memory `listMessages()` ordering/filtering coverage.
- Modify `C:\Project-TOAD\toad-local\test\sqliteBroker.test.js`
  - Add SQLite `listMessages()` persistence coverage.
- Create `C:\Project-TOAD\toad-local\src\read\LocalReadModel.js`
  - Projects team chat, task board, runtime processes, runtime audit, and overview counts.
- Create `C:\Project-TOAD\toad-local\test\localReadModel.test.js`
  - Tests the composed read model.
- Modify `C:\Project-TOAD\toad-local\package.json`
  - Adds the read-model test to `npm test`.
- Modify `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
  - Records the read-model scaffold and verification coverage.

---

### Task 1: Broker Message Listing

**Files:**
- Modify: `C:\Project-TOAD\toad-local\test\broker.test.js`
- Modify: `C:\Project-TOAD\toad-local\test\sqliteBroker.test.js`
- Modify: `C:\Project-TOAD\toad-local\src\broker\inMemoryBroker.js`
- Modify: `C:\Project-TOAD\toad-local\src\broker\sqliteBroker.js`

- [x] **Step 1: Add failing in-memory broker test**

Add a test proving `listMessages({ teamId })` returns only the requested team, sorted by `createdAt`, and supports `limit`.

- [x] **Step 2: Run broker test to verify failure**

Run:

```powershell
node test/broker.test.js
```

Expected: failure because `listMessages()` does not exist.

- [x] **Step 3: Implement in-memory `listMessages()`**

Filter by `teamId` and optional `conversationId`, sort by `createdAt`, then apply optional numeric `limit`.

- [x] **Step 4: Add failing SQLite broker test**

Add equivalent `listMessages()` coverage to `sqliteBroker.test.js`.

- [x] **Step 5: Run SQLite broker test to verify failure**

Run:

```powershell
node --no-warnings test/sqliteBroker.test.js
```

Expected: failure because `SqliteBroker.listMessages()` does not exist.

- [x] **Step 6: Implement SQLite `listMessages()`**

Query `messages` ordered by `created_at ASC, message_id ASC`, filtered by `team_id` and optional `conversation_id`, with optional `LIMIT`.

- [x] **Step 7: Run broker tests**

Run:

```powershell
node test/broker.test.js
node --no-warnings test/sqliteBroker.test.js
```

Expected: broker tests pass.

---

### Task 2: Local Read Model Projections

**Files:**
- Create: `C:\Project-TOAD\toad-local\src\read\LocalReadModel.js`
- Create: `C:\Project-TOAD\toad-local\test\localReadModel.test.js`

- [x] **Step 1: Add failing read-model tests**

Create tests proving:
- `listTeamChat({ teamId })` maps broker messages to chat rows.
- `listRuntimeAudit({ teamId })` maps runtime events to audit rows.
- `getTeamOverview({ teamId })` returns counts for messages, tasks, runtimes, and runtime events.

- [x] **Step 2: Run read-model test to verify failure**

Run:

```powershell
node test/localReadModel.test.js
```

Expected: failure because `LocalReadModel.js` does not exist.

- [x] **Step 3: Implement `LocalReadModel`**

Constructor accepts `{ broker, taskBoard = null, runtimeRegistry = null, eventLog = null }`. Implement:
- `listTeamChat({ teamId, limit })`
- `listTaskBoard({ teamId })`
- `listRuntimeProcesses({ teamId })`
- `listRuntimeAudit({ teamId, runtimeId })`
- `getTeamOverview({ teamId })`

- [x] **Step 4: Run read-model tests**

Run:

```powershell
node test/localReadModel.test.js
```

Expected: read-model tests pass.

---

### Task 3: Package And Staged Plan Checkpoint

**Files:**
- Modify: `C:\Project-TOAD\toad-local\package.json`
- Modify: `C:\Project-TOAD\TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`

- [x] **Step 1: Add read-model test to package script**

Modify `package.json` test script to include:

```json
"... && node test/localReadModel.test.js ..."
```

- [x] **Step 2: Update staged plan scaffold**

Under `Local scaffold:` add:

```markdown
- `toad-local/src/read/LocalReadModel.js`
- `toad-local/test/localReadModel.test.js`
```

Under `Current verification:`, append:

```markdown
Local read-model tests cover broker message listing, team chat projection, task/process/audit projection, and team overview counts.
```

- [x] **Step 3: Run final verification**

Run:

```powershell
npm.cmd test
```

Expected: all tests pass.

Because this workspace has no `.git` metadata and the user asked to keep work local, skip commits and report changed files.

---

## Self-Review Notes

- This is a query/projection layer only; it does not cache or mutate durable state.
- `listMessages()` is intentionally generic because chat views are projections over messages, not inbox files.
- More UI-specific grouping can be added later without changing storage APIs.
