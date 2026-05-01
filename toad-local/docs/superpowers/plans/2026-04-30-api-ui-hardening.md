# API/UI Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the local dashboard API bridge and make dashboard API URLs configurable without changing local defaults.

**Architecture:** `ApiServer` validates generic `/api/call` envelope shape and rejects oversized bodies before facade execution. The UI reads one Vite base URL and derives the API and SSE endpoints from it.

**Tech Stack:** Node.js ESM, built-in `http`, `node:test`, Vite React.

---

### Task 1: API Request Validation

**Files:**
- Modify: `test/apiServer.test.js`
- Modify: `src/transport/apiServer.js`

- [x] **Step 1: Write failing validation tests**

Add tests proving malformed JSON and invalid payload shape return `400` and do not call the facade.

- [x] **Step 2: Verify validation tests fail**

Run:

```powershell
node test/apiServer.test.js
```

Expected: FAIL because malformed payloads currently return `500` or reach the facade.

- [x] **Step 3: Implement validation**

Add payload validation helpers inside `ApiServer` and return JSON `400` before command execution.

- [x] **Step 4: Verify validation tests pass**

Run:

```powershell
node test/apiServer.test.js
```

Expected: PASS.

### Task 2: API Body Limit

**Files:**
- Modify: `test/apiServer.test.js`
- Modify: `src/transport/apiServer.js`

- [x] **Step 1: Write failing body-limit test**

Construct `new ApiServer({ maxBodyBytes: 16 })`, post a larger JSON body, and assert HTTP `413`.

- [x] **Step 2: Verify body-limit test fails**

Run:

```powershell
node test/apiServer.test.js
```

Expected: FAIL because body size is not currently limited.

- [x] **Step 3: Implement body limit**

Track received byte count in `/api/call`; if it exceeds `maxBodyBytes`, respond once with `413`.

- [x] **Step 4: Verify body-limit test passes**

Run:

```powershell
node test/apiServer.test.js
```

Expected: PASS.

### Task 3: Configurable UI URLs

**Files:**
- Create: `ui/src/config/toadApi.js`
- Modify: `ui/src/hooks/useToadApi.js`
- Modify: `ui/src/hooks/useToadEvents.js`
- Modify: `README.md`

- [x] **Step 1: Add UI config module**

Create `toadApi.js` exporting `TOAD_API_BASE_URL`, `TOAD_API_CALL_URL`, and `TOAD_EVENTS_URL`.

- [x] **Step 2: Wire hooks**

Replace hard-coded hook URLs with the exported config constants.

- [x] **Step 3: Document env var**

Document `VITE_TOAD_API_BASE_URL` in the local dashboard README section.

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
- Modify: `docs/superpowers/plans/2026-04-30-api-ui-hardening.md`

- [x] **Step 1: Run full regression**

Run:

```powershell
npm.cmd test
```

Expected: PASS.

- [x] **Step 2: Update docs**

Record the hardening slice, current verification, and next gap.

- [x] **Step 3: Mark checklist complete**

Update this plan after verification.
