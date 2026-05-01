# SQLite Approval Broker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make approval requests and responses durable in SQLite.

**Architecture:** Add `SqliteApprovalBroker` with the same public API as `InMemoryApprovalBroker`: `requestApproval()`, `respondApproval()`, `getApproval()`, and `listApprovals()`. Store request metadata and response decisions in `approval_requests`, preserving idempotent responses through a `response_idempotency_key` column.

**Tech Stack:** Node.js ESM, `node:test`, `node:sqlite`, existing `openToadDatabase()` schema bootstrap.

---

### Task 1: Durable Approval Broker

**Files:**
- Create: `src/approval/sqliteApprovalBroker.js`
- Create: `test/sqliteApprovalBroker.test.js`
- Modify: `src/storage/schema.sql`
- Modify: `src/app/LocalToadRuntime.js`
- Modify: `package.json`

- [x] **Step 1: Write failing tests**

Add tests proving SQLite approvals persist request/response rows, list by team, and preserve response idempotency by `idempotencyKey`.

- [x] **Step 2: Run targeted test to verify it fails**

Run: `node --no-warnings test/sqliteApprovalBroker.test.js`

Expected: FAIL because `src/approval/sqliteApprovalBroker.js` does not exist.

- [x] **Step 3: Implement schema and broker**

Add response columns to `approval_requests` and create `SqliteApprovalBroker` that maps DB rows to the same object shape as `InMemoryApprovalBroker`.

- [x] **Step 4: Run targeted test**

Run: `node --no-warnings test/sqliteApprovalBroker.test.js`

Expected: PASS.

- [x] **Step 5: Run full regression suite**

Run: `npm.cmd test`

Expected: PASS.
