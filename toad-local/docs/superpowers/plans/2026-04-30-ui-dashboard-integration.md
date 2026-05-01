# UI Dashboard Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a browser UI for observing the local TOAD runtime, live runtime events, task state, and health projection.

**Architecture:** `ApiServer` exposes a zero-dependency HTTP bridge: `/events` streams `RuntimeEventBus` events over SSE and `/api/call` routes JSON requests into `LocalToolFacade`. `LocalToadRuntime` owns the API server and event bus wiring. The `ui/` Vite React dashboard consumes SSE with `useToadEvents` and calls read-only facade tools with `useToadApi`.

**Tech Stack:** Node.js built-in `http`, React, Vite, lucide-react, ESLint.

---

### Task 1: HTTP API And Event Bridge

**Files:**
- Create/modify: `src/transport/apiServer.js`
- Modify: `src/app/LocalToadRuntime.js`
- Test: `test/apiServer.test.js`

- [x] **Step 1: Implement SSE transport**

`ApiServer` accepts an event bus, exposes `GET /events`, keeps connected SSE clients in memory, and broadcasts `runtime_event` payloads.

- [x] **Step 2: Implement facade call endpoint**

`POST /api/call` accepts `{ actor, method, args, idempotencyKey? }`, routes to `toolFacade.execute()`, and returns JSON `{ result }` or `{ error }`.

- [x] **Step 3: Wire runtime**

`LocalToadRuntime` constructs `RuntimeEventBus`, `ApiServer`, and passes the event bus into `RuntimeEventIngestor`.

- [x] **Step 4: Verify API tests**

Run: `node test/apiServer.test.js`

Expected: PASS.

### Task 2: React Dashboard

**Files:**
- Create/modify: `ui/`
- Create/modify: `ui/src/components/Dashboard.jsx`
- Create/modify: `ui/src/hooks/useToadApi.js`
- Create/modify: `ui/src/hooks/useToadEvents.js`

- [x] **Step 1: Scaffold Vite React UI**

Create a Vite React app under `toad-local/ui`.

- [x] **Step 2: Build TOAD API hooks**

`useToadEvents` subscribes to `http://127.0.0.1:3001/events`. `useToadApi` posts facade calls to `http://127.0.0.1:3001/api/call`.

- [x] **Step 3: Build dashboard view**

Display runtime count, event count, pending tasks, API retry health, runtime list, and live event stream.

- [x] **Step 4: Verify UI build**

Run: `npm.cmd run build` from `ui/`.

Expected: PASS.

### Task 3: Documentation And Lint Follow-Up

**Files:**
- Modify: `HANDOFF-NEXT-AGENT.md`
- Modify: `TOAD-STAGED-REVERSE-ENGINEERING-AND-REBUILD-PLAN.md`
- Modify: `toad-local/README.md`
- Modify: `ui/src/App.jsx`
- Modify: `ui/src/components/Dashboard.jsx`

- [x] **Step 1: Update docs**

Document the API/UI bridge, current commands, verification commands, and next UI iteration.

- [x] **Step 2: Fix UI lint issues**

Remove unused imports/state, stabilize dashboard refresh callbacks, avoid synchronous state refresh from effects, and avoid `Date.now()` during render.

- [x] **Step 3: Verify final state**

Run:

```powershell
cd C:\Project-TOAD\toad-local
npm.cmd test
cd ui
npm.cmd run lint
npm.cmd run build
```

Expected: PASS.
