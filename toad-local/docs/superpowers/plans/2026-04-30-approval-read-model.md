# Approval Read Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Project approval requests and responses through `LocalReadModel`.

**Architecture:** Add optional `approvalBroker` injection to `LocalReadModel`. Expose `listApprovals({ teamId })`, include approvals in `getTeamOverview()`, and wire `LocalToadRuntime` to pass its approval broker into the read model.

**Tech Stack:** Node.js ESM, `node:test`, existing approval broker API.

---

### Task 1: Approval Projection

**Files:**
- Modify: `src/read/LocalReadModel.js`
- Modify: `src/app/LocalToadRuntime.js`
- Modify: `test/localReadModel.test.js`

- [x] **Step 1: Write failing tests**

Add tests proving `LocalReadModel.listApprovals({ teamId })` returns approvals from the broker and `getTeamOverview({ teamId })` includes approval counts and pending approvals.

- [x] **Step 2: Run targeted test to verify it fails**

Run: `node test/localReadModel.test.js`

Expected: FAIL because `listApprovals()` does not exist and overview counts do not include approvals.

- [x] **Step 3: Implement projection**

Add `approvalBroker` constructor dependency, implement `listApprovals()`, and update `getTeamOverview()`.

- [x] **Step 4: Run targeted test**

Run: `node test/localReadModel.test.js`

Expected: PASS.

- [x] **Step 5: Run full regression suite**

Run: `npm.cmd test`

Expected: PASS.
