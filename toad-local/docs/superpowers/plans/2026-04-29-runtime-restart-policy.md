# Runtime Restart Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded opt-in restart behavior for runtimes that exit unexpectedly.

**Architecture:** `RuntimeSupervisor.launchAgent()` accepts `restartPolicy: { maxRestarts }`. Unexpected child exits relaunch the same runtime record until the restart count reaches the limit; explicit stops still stop immediately and never restart.

**Tech Stack:** Node.js ESM, `node:test`, existing `RuntimeSupervisor`.

---

### Task 1: Bounded Restart Policy

**Files:**
- Modify: `src/runtime/RuntimeSupervisor.js`
- Modify: `test/runtimeSupervisor.test.js`

- [x] **Step 1: Write failing tests**

Add tests proving a runtime restarts once when `restartPolicy.maxRestarts` is `1`, remains registered after the first unexpected exit, then becomes `exited` after the second unexpected exit. Also prove `stopAgent()` does not restart.

- [x] **Step 2: Run targeted tests to verify they fail**

Run: `node test/runtimeSupervisor.test.js`

Expected: FAIL because restart policy is not implemented.

- [x] **Step 3: Implement restart policy**

Store restart policy and restart count in runtime records. Extract a helper to spawn and attach a child. In `#markExited()`, when the exit was unexpected and restart count is below `maxRestarts`, relaunch the same command and refresh registry/directory state.

- [x] **Step 4: Run targeted tests**

Run: `node test/runtimeSupervisor.test.js`

Expected: PASS.

- [x] **Step 5: Run full regression suite**

Run: `npm.cmd test`

Expected: PASS.
