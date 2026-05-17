# Span-Summary Transport (P3c-1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the span-summary subsystem reachable by the future P3c-2 cockpit UI by adding two read/status commands (`span_summary_list`, `span_summary_status`) to the `/api/call` → `toolFacade` command surface, the role-authority allowlist entries, and one additive `dev-api-server.mjs` line late-injecting the P3b-2 `SummaryMonitor` onto the toolFacade.

**Architecture:** Mirror the established command-surface precedent exactly: a `COMMANDS` entry + a `case` in `localToolFacade.execute()`'s switch + a guarded private handler + a `COMMON_READ_TOOLS` allowlist entry, plus the `driftEngine`-style late injection. Backend-only; one atomic commit; zero `ui/` files.

**Tech Stack:** Node.js ESM, `node:test`, the ratified `scripts/test-suites.txt` chain (`package.json` `scripts.test` = `node scripts/run-test-suites.mjs`).

**Spec:** `docs/superpowers/specs/2026-05-17-span-summary-transport-design.md` (committed `5f1c1d5`).

**Commit model:** ONE atomic commit (Task 6). Tasks 1–5 accumulate UNCOMMITTED. Exact files: `src/commands/command-contract.js`, `src/tools/localToolFacade.js`, `src/security/roleAuthority.js`, `scripts/dev-api-server.mjs`, `test/spanSummaryTransport.test.js`, `test/roleAuthority.test.js`, `scripts/test-suites.txt`.

**Session conventions:** Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed paths, `git -c commit.gpgsign=false`, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. All commands run from `C:\Project-TOAD\toad-local` (`cd /c/Project-TOAD/toad-local && …`).

---

## File Structure

| File | Change |
|---|---|
| `src/commands/command-contract.js` | **Modify.** Add 2 entries to the `COMMANDS` map (NOT to `MUTATING_COMMANDS` → `commandRequiresIdempotency` stays false). |
| `src/security/roleAuthority.js` | **Modify.** Append 2 names to the frozen `COMMON_READ_TOOLS` array. |
| `src/tools/localToolFacade.js` | **Modify.** Module const `SPAN_SUMMARY_UNAVAILABLE`; instance field `this.summaryMonitor = null`; 2 `case`s; 2 guarded private handlers. |
| `scripts/dev-api-server.mjs` | **Modify.** ONE additive line late-injecting `summaryMonitor` onto `runtime.toolFacade` (mirrors the `driftEngine` injection). |
| `test/spanSummaryTransport.test.js` | **Create.** TDD suite: command-contract entries + the two handlers driven through the real `facade.execute()` seam. |
| `test/roleAuthority.test.js` | **Modify.** Add assertions that both commands are role-authorized like `approval_list`. |
| `scripts/test-suites.txt` | **Modify.** Append the one new suite (`roleAuthority.test.js` is already wired). |

**Grounded facts (verified against shipped code):**
- `command-contract.js`: `COMMANDS = Object.freeze({ … GITHUB_CREATE_REPOSITORY: 'github_create_repository', });` ends at line 96 then `});` at 97. `MUTATING_COMMANDS` (99–153) does NOT include read/list commands; `commandRequiresIdempotency(c) = MUTATING_COMMANDS.includes(c)`.
- `roleAuthority.js`: `COMMON_READ_TOOLS = Object.freeze([ 'task_list', … 'plugin_resource_list', ])` lines 18–50; spread into `architect/developer/reviewer/tester`; `lead`/`human` are `'*'`. `assertRoleCanCallTool({role,toolName})` throws `role authority: <role> cannot call <tool>` if not allowed; missing role → `human` (wildcard).
- `localToolFacade.js`: `execute(command)` (line 206): `commandName=requireString(...)`; idempotency gate; `actor=normalizeActor(command.actor)` (211); `assertRoleCanCallTool({role:actor.role,toolName:commandName})` (213); `args = command.args && typeof command.args==='object' ? command.args : {}` (218); `switch(commandName){ case COMMANDS.X: return this.#handler(actor,args); }`; `default:` at 423. `#approvalList(actor)` (1159): `if (!this.readModel || typeof this.readModel.listApprovals !== 'function') { return { approvals: [] }; } return { approvals: this.readModel.listApprovals({ teamId: actor.teamId }) };`. `this.driftEngine = driftEngine && typeof driftEngine.runDrift==='function' ? driftEngine : null;` (187) — instance-field default-null precedent. `import { COMMANDS, commandRequiresIdempotency } from '../commands/command-contract.js';` (line 4).
- `dev-api-server.mjs`: line 107 (inside `if (runtime.toolFacade)` inside `if (driftDb)`): `runtime.toolFacade.driftEngine = driftEngine;`. `summaryMonitor = new SummaryMonitor({...})` ~176; `summaryMonitor.start();` ~203 (same `if (driftDb)` block).
- P3b-2 `summaryMonitor.getStatus()` → `{state,lastRunAt,lastDurationMs,teamsPolled,summarizedCount,degradedCount,skippedRateLimited,lastReasons}`. P3a `readModel.listSpanSummaries({teamId,runtimeId})` → rows `{spanId,teamId,runtimeId,agentId,sessionId,summaryText,model,cli,spanStartedAt,spanEndedAt,rowCount,tokens,createdAt}` (consumed verbatim; unchanged).
- Test harness (`test/localToolFacade.test.js`): `new LocalToolFacade({ broker, taskBoard, runtimeRegistry, approvalBroker, readModel })`; `facade.execute({ commandName: COMMANDS.X, actor: { teamId, agentId }, args })`. `test/roleAuthority.test.js`: `import { ROLE_TOOLS, KNOWN_ROLES, assertRoleCanCallTool } from '../src/security/roleAuthority.js'; test(...)`.
- `scripts/test-suites.txt`: `&`-joined chain; `node test/roleAuthority.test.js` already wired; `node --no-warnings test/localToolFacade.test.js` already wired; recent spanSummary suites use `node --no-warnings --test test/X.test.js`. Backend root baseline post-P3b-2/post-flow = **1554 pass / 0 fail** (the flow redesign was UI-only — `ui/test/*.mjs`, NOT in this chain — so the backend chain is unchanged).

---

## Task 1: `command-contract.js` entries + the contract test (TDD)

**Files:**
- Modify: `src/commands/command-contract.js`
- Create: `test/spanSummaryTransport.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/spanSummaryTransport.test.js` with EXACTLY:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, commandRequiresIdempotency } from '../src/commands/command-contract.js';

test('command-contract: span-summary commands exist and are not idempotency-gated', () => {
  assert.equal(COMMANDS.SPAN_SUMMARY_LIST, 'span_summary_list');
  assert.equal(COMMANDS.SPAN_SUMMARY_STATUS, 'span_summary_status');
  assert.equal(commandRequiresIdempotency('span_summary_list'), false);
  assert.equal(commandRequiresIdempotency('span_summary_status'), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummaryTransport.test.js`
Expected: FAIL — `COMMANDS.SPAN_SUMMARY_LIST` is `undefined` (≠ `'span_summary_list'`). Confirm this is the failure reason (entries missing), not a syntax/import error.

- [ ] **Step 3: Add the two entries**

In `src/commands/command-contract.js`, inside the `COMMANDS = Object.freeze({ … })` object, immediately AFTER the line `  GITHUB_CREATE_REPOSITORY: 'github_create_repository',` and BEFORE the closing `});`, add:

```js
  SPAN_SUMMARY_LIST: 'span_summary_list',
  SPAN_SUMMARY_STATUS: 'span_summary_status',
```

Do NOT add them to `MUTATING_COMMANDS` (they are reads — `commandRequiresIdempotency` must stay false, mirroring `task_list`/`approval_list`).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummaryTransport.test.js`
Expected: PASS — `# pass 1`, `# fail 0`.

---

## Task 2: `roleAuthority.js` allowlist entries + roleAuthority test (TDD)

**Files:**
- Modify: `src/security/roleAuthority.js`
- Modify: `test/roleAuthority.test.js`

- [ ] **Step 1: Write the failing test**

APPEND to `test/roleAuthority.test.js` (keep all existing tests; reuse its existing imports — `assertRoleCanCallTool` is already imported there) EXACTLY:

```js
test('span-summary read commands are role-authorized like other COMMON_READ tools', () => {
  for (const role of ['architect', 'developer', 'reviewer', 'tester', 'lead', 'human']) {
    assertRoleCanCallTool({ role, toolName: 'span_summary_list' });
    assertRoleCanCallTool({ role, toolName: 'span_summary_status' });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node test/roleAuthority.test.js`
Expected: FAIL — `assertRoleCanCallTool({ role: 'architect', toolName: 'span_summary_list' })` throws `role authority: architect cannot call span_summary_list` (the non-wildcard roles don't yet allow it). Confirm that is the failure.

- [ ] **Step 3: Append the two allowlist entries**

In `src/security/roleAuthority.js`, inside `const COMMON_READ_TOOLS = Object.freeze([ … ])`, immediately AFTER the line `  'plugin_resource_list',` and BEFORE the closing `]);`, add:

```js
  'span_summary_list',
  'span_summary_status',
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /c/Project-TOAD/toad-local && node test/roleAuthority.test.js`
Expected: PASS — all roleAuthority tests pass (`# fail 0`), including the new one and every pre-existing assertion.

---

## Task 3: `localToolFacade.js` const + field + cases + handlers + facade tests (TDD — EPICENTER)

**Files:**
- Modify: `src/tools/localToolFacade.js`
- Modify: `test/spanSummaryTransport.test.js`

- [ ] **Step 1: Write the failing tests**

APPEND to `test/spanSummaryTransport.test.js` (keep the Task-1 contract test) EXACTLY:

```js
import { LocalToolFacade } from '../src/tools/localToolFacade.js';

function makeFacade(extra = {}) {
  // Minimal deps: the span-summary commands only touch readModel +
  // (late-injected) summaryMonitor + roleAuthority. Other commands are
  // not exercised here.
  return new LocalToolFacade({
    broker: { listMessages: () => [], sendMessage: () => {} },
    taskBoard: { listTasks: () => [] },
    runtimeRegistry: null,
    approvalBroker: null,
    ...extra,
  });
}

const ACTOR = { teamId: 'team-a', agentId: 'lead' };

test('span_summary_list: injected readModel → {summaries} scoped to actor.teamId', () => {
  const calls = [];
  const facade = makeFacade({
    readModel: {
      listSpanSummaries: (q) => { calls.push(q); return [{ spanId: 's1', summaryText: 'did a thing' }]; },
    },
  });
  const r = facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: ACTOR, args: {} });
  assert.deepEqual(r, { summaries: [{ spanId: 's1', summaryText: 'did a thing' }] });
  assert.deepEqual(calls, [{ teamId: 'team-a', runtimeId: null }]);
});

test('span_summary_list: args.runtimeId string is forwarded; non-string → null', () => {
  const calls = [];
  const facade = makeFacade({
    readModel: { listSpanSummaries: (q) => { calls.push(q); return []; } },
  });
  facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: ACTOR, args: { runtimeId: 'rt-9' } });
  facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: ACTOR, args: { runtimeId: 123 } });
  assert.deepEqual(calls, [
    { teamId: 'team-a', runtimeId: 'rt-9' },
    { teamId: 'team-a', runtimeId: null },
  ]);
});

test('span_summary_list: missing readModel → {summaries:[]} (never throws)', () => {
  const facade = makeFacade(); // no readModel
  const r = facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: ACTOR, args: {} });
  assert.deepEqual(r, { summaries: [] });
});

test('span_summary_list: actor with missing/empty teamId → {summaries:[]} (never reaches readModel)', () => {
  let reached = false;
  const facade = makeFacade({
    readModel: { listSpanSummaries: () => { reached = true; return [{ spanId: 'x' }]; } },
  });
  const r1 = facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: { agentId: 'lead' }, args: {} });
  const r2 = facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: { teamId: '', agentId: 'lead' }, args: {} });
  assert.deepEqual(r1, { summaries: [] });
  assert.deepEqual(r2, { summaries: [] });
  assert.equal(reached, false);
});

test('span_summary_status: injected summaryMonitor → getStatus() verbatim', () => {
  const status = {
    state: 'degraded', lastRunAt: 123, lastDurationMs: 9, teamsPolled: 2,
    summarizedCount: 1, degradedCount: 1, skippedRateLimited: 0, lastReasons: ['timeout'],
  };
  const facade = makeFacade();
  facade.summaryMonitor = { getStatus: () => status }; // late-injected, like dev-api-server
  const r = facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_STATUS, actor: ACTOR, args: {} });
  assert.deepEqual(r, status);
});

test('span_summary_status: no summaryMonitor → frozen honest unavailable object (never throws)', () => {
  const facade = makeFacade(); // summaryMonitor stays null
  const r = facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_STATUS, actor: ACTOR, args: {} });
  assert.deepEqual(r, {
    state: 'unavailable', lastRunAt: null, lastDurationMs: 0,
    teamsPolled: 0, summarizedCount: 0, degradedCount: 0,
    skippedRateLimited: 0, lastReasons: [],
  });
  assert.ok(Object.isFrozen(r), 'unavailable status must be frozen (mutation-proof shared const)');
});

test('span_summary_status: ignores args, never throws', () => {
  const facade = makeFacade();
  assert.doesNotThrow(() =>
    facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_STATUS, actor: ACTOR, args: { junk: true } }));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummaryTransport.test.js`
Expected: FAIL — the new cases throw (the `switch` has no `SPAN_SUMMARY_*` case → falls to `default:` which throws an unknown-command error). The Task-1 contract test still passes. Confirm the failures are "unknown command"/no-handler (the right reason).

- [ ] **Step 3: Add the const, the instance field, the cases, and the handlers**

3a. In `src/tools/localToolFacade.js`, add a module-level const immediately AFTER the import block (after the last top-of-file `import … ;` line, before the `export class LocalToolFacade`):

```js
// P3c-1 span-summary transport: the honest "monitor not running" status
// returned by span_summary_status when no SummaryMonitor is injected
// (tests, no-project mode, monitor not constructed). Same shape as the
// P3b-2 getStatus() object; frozen so the shared const cannot be mutated
// by a consumer. NEVER papered over as a faked 'idle'.
const SPAN_SUMMARY_UNAVAILABLE = Object.freeze({
  state: 'unavailable',
  lastRunAt: null,
  lastDurationMs: 0,
  teamsPolled: 0,
  summarizedCount: 0,
  degradedCount: 0,
  skippedRateLimited: 0,
  lastReasons: [],
});
```

3b. In the constructor, immediately AFTER the line `this.driftEngine = driftEngine && typeof driftEngine.runDrift === 'function' ? driftEngine : null;`, add:

```js
    // Not a constructor param — an instance field defaulting null, late
    // injected by dev-api-server.mjs exactly as driftEngine is. Keeps the
    // constructor signature unchanged.
    this.summaryMonitor = null;
```

3c. In `execute()`'s `switch`, immediately AFTER the line `      case COMMANDS.HEALTH_STATUS:\n        return this.#healthStatus(actor, args);`, add:

```js
      case COMMANDS.SPAN_SUMMARY_LIST:
        return this.#spanSummaryList(actor, args);
      case COMMANDS.SPAN_SUMMARY_STATUS:
        return this.#spanSummaryStatus();
```

3d. Immediately AFTER the `#approvalList(actor) { … }` method (the one returning `{ approvals }`), add the two private handlers:

```js
  #spanSummaryList(actor, args) {
    // Mirrors #approvalList's guard/envelope. The actor.teamId guard is
    // intentionally stricter than #approvalList (which would let a
    // teamless actor reach readModel and throw on requireString): a
    // poll-safe read the cockpit hits must genuinely never throw.
    if (
      !this.readModel ||
      typeof this.readModel.listSpanSummaries !== 'function' ||
      !actor ||
      typeof actor.teamId !== 'string' ||
      actor.teamId.length === 0
    ) {
      return { summaries: [] };
    }
    return {
      summaries: this.readModel.listSpanSummaries({
        teamId: actor.teamId,
        runtimeId: args && typeof args.runtimeId === 'string' ? args.runtimeId : null,
      }),
    };
  }

  #spanSummaryStatus() {
    // The P3b-2 SummaryMonitor is late-injected onto this.summaryMonitor
    // by dev-api-server.mjs. Verbatim getStatus() when present; the frozen
    // honest 'unavailable' object otherwise. Never throws; no args.
    return this.summaryMonitor && typeof this.summaryMonitor.getStatus === 'function'
      ? this.summaryMonitor.getStatus()
      : SPAN_SUMMARY_UNAVAILABLE;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummaryTransport.test.js`
Expected: PASS — all 8 tests (`# pass 8`, `# fail 0`): 1 contract + 4 list + 3 status.

- [ ] **Step 5: Regression-check the facade suite**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings test/localToolFacade.test.js`
Expected: PASS unchanged (the additive const/field/cases/handlers don't alter any existing command path).

---

## Task 4: `dev-api-server.mjs` one-line late injection

**Files:**
- Modify: `scripts/dev-api-server.mjs`

- [ ] **Step 1: Add the single additive line**

In `scripts/dev-api-server.mjs`, immediately AFTER the line `  summaryMonitor.start();` (inside the existing `if (driftDb) { … }` block; the P3b-2 summary block), add exactly:

```js
  if (runtime.toolFacade) runtime.toolFacade.summaryMonitor = summaryMonitor;
```

This byte-mirrors the existing `driftEngine` injection (`if (runtime.toolFacade) { runtime.toolFacade.driftEngine = driftEngine; }`). Make NO other change to the file.

- [ ] **Step 2: Verify the module still parses (no boot)**

Run: `cd /c/Project-TOAD/toad-local && node --check scripts/dev-api-server.mjs`
Expected: exit 0, no output. Do NOT run the server.

- [ ] **Step 3: Controller-verify the change is exactly one additive line**

Run: `git -C /c/Project-TOAD diff -- toad-local/scripts/dev-api-server.mjs`
Expected: a single added line `+  if (runtime.toolFacade) runtime.toolFacade.summaryMonitor = summaryMonitor;` immediately after `summaryMonitor.start();`, ZERO deletions, nothing else changed (drift block, runtime construction, SIGINT/SIGTERM, the P3b-2 summary block all byte-identical). `git -C /c/Project-TOAD diff --stat -- toad-local/scripts/dev-api-server.mjs` shows `1 +`/`0 -` (one insertion).

---

## Task 5: Wire the new suite + full-root reconcile

**Files:**
- Modify: `scripts/test-suites.txt`

- [ ] **Step 1: Append the new suite to the chain**

`scripts/test-suites.txt` is a single ` && `-joined line with NO trailing newline. `test/roleAuthority.test.js` and `test/localToolFacade.test.js` are ALREADY in the chain (do NOT re-add them — Task 2's roleAuthority additions ride the existing entry). Append ONLY the new suite, preserving no-trailing-newline, using the `--test` form the recent spanSummary suites use:

```
 && node --no-warnings --test test/spanSummaryTransport.test.js
```

Validate:
Run: `cd /c/Project-TOAD/toad-local && node -e "const fs=require('fs');const c=fs.readFileSync('scripts/test-suites.txt','utf8');console.log('transport='+/test\/spanSummaryTransport\.test\.js/.test(c));console.log('roleAuthOnce='+((c.match(/test\/roleAuthority\.test\.js/g)||[]).length));console.log('scriptsTest='+JSON.parse(fs.readFileSync('package.json','utf8')).scripts.test);"`
Expected: `transport=true`, `roleAuthOnce=1` (still exactly one — not duplicated), `scriptsTest=node scripts/run-test-suites.mjs`.

- [ ] **Step 2: Controller re-runs the FULL root suite via the ratified runner**

Run: `cd /c/Project-TOAD/toad-local && node scripts/run-test-suites.mjs`
Expected: runner exit 0; aggregate `# fail 0`; no `not ok`; no `Command line is too long`. Sum all per-suite `# pass`. Reconcile: post-P3b-2/post-flow backend baseline = **1554**; the delta = (the 8 `spanSummaryTransport.test.js` tests) + (the 1 new `roleAuthority.test.js` test) = **+9** → expect total **1563**. Both new suite titles (`spanSummaryTransport`, the new roleAuthority test) appear in the runner's own output. The controller computes the sum independently — never trust a pasted number.

---

## Task 6: Whole-impl review + the single atomic commit + post-commit verify

**Files:** none changed (review + commit + verify).

- [ ] **Step 1: Mandatory whole-implementation subagent review**

Dispatch a fresh reviewer over the entire P3c-1 surface (the 4 production edits + the 2 test files + the suite wiring + the spec). Verify: command-contract entries + idempotency-false; roleAuthority allowlist entries (+ existing assertions green); the two facade handlers' totality (list guarded incl. teamless-actor never-throws, status verbatim-pass-through + frozen-unavailable + never-throws + Object.isFrozen); `this.summaryMonitor` is an instance field default-null (no constructor-signature change); the dev-api line is the ONLY production change to that file and additive (byte-mirrors the driftEngine injection); reachable through the real `execute()` seam (not inert); NO `ui/` change; NO change to `summaryMonitor.js`/`getStatus` internals, `readModel.listSpanSummaries`/P3a, `src/drift`, P1/P2a/P2b. Resolve any Critical/Important via a fix-loop before Step 2.

- [ ] **Step 2: Commit-hygiene gate (controller-verified)**

```bash
git -C /c/Project-TOAD add toad-local/src/commands/command-contract.js toad-local/src/tools/localToolFacade.js toad-local/src/security/roleAuthority.js toad-local/scripts/dev-api-server.mjs toad-local/test/spanSummaryTransport.test.js toad-local/test/roleAuthority.test.js toad-local/scripts/test-suites.txt
git -C /c/Project-TOAD diff --cached --name-only
```
Expected: EXACTLY those 7 paths. Confirm NONE of: any `toad-local/ui/**`, `toad-local/ui/src-tauri/**`, `toad-local/.mockup-symphony-flow/**`, or any unrelated Sub-project-C/backend file is staged.

- [ ] **Step 3: Commit**

```bash
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(spans): span-summary transport — list + status commands (Readability Layer-2 P3c-1)

Add span_summary_list (→ readModel.listSpanSummaries, guarded, mirrors
approval_list; an intentionally stricter actor.teamId guard so a
teamless poll never throws) and span_summary_status (→ the late-injected
SummaryMonitor.getStatus() verbatim, else a frozen honest
state:'unavailable' object — never throws) to the /api/call toolFacade
command surface. Both appended to COMMON_READ_TOOLS. One additive
dev-api-server line late-injects summaryMonitor onto runtime.toolFacade
(byte-mirrors the driftEngine injection). Backend-only; zero ui/
contention. Dormant-but-non-inert: dispatchable through the real
execute() seam, no UI caller yet (P3c-2). Full root fail 0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 4: Post-commit verify**

```bash
git -C /c/Project-TOAD show --stat HEAD | tail -n 10        # EXACTLY 7 files
git -C /c/Project-TOAD diff --stat 5f1c1d5 HEAD -- toad-local/ui toad-local/src/drift toad-local/src/runtime/spanSummary/summaryMonitor.js toad-local/src/runtime/spanSummary/runSpanSummary.js toad-local/src/runtime/spanSummary/summarizePendingSpans.js toad-local/src/runtime/spanSummary/decideSpansToSummarize.js toad-local/src/runtime/sqliteSpanSummaryStore.js toad-local/src/read/LocalReadModel.js toad-local/src/runtime/eventNarration toad-local/src/runtime/timelineComposition toad-local/src/runtime/spanDetection toad-local/src/runtime/RuntimeEventIngestor.js   # EXPECT EMPTY
git -C /c/Project-TOAD diff 5f1c1d5 HEAD -- toad-local/scripts/dev-api-server.mjs   # ONLY the one additive injection line; 0 deletions
git -C /c/Project-TOAD log --oneline -2                      # HEAD = P3c-1; HEAD~1 = 5f1c1d5 (spec)
```
Expected: HEAD stat exactly the 7 files; the out-of-scope `diff --stat` EMPTY (no `ui/`, no P3b-2 monitor internals, no P3a/readModel, no drift, no P1/P2a/P2b mutation); the `dev-api-server.mjs` diff is only the single additive line; log chain correct. Controller independently re-runs `node scripts/run-test-suites.mjs` and re-reconciles the +9 → 1563 delta before declaring P3c-1 complete.

---

## Self-Review

**1. Spec coverage:**
- §3/§4 `span_summary_list` (guarded, `actor.teamId` strict, `{summaries}`, P3a rows verbatim, `args.runtimeId`) → Task 3 handler + tests. ✓
- §3/§4 `span_summary_status` (verbatim getStatus, frozen `SPAN_SUMMARY_UNAVAILABLE`, never throws, no args) → Task 3 const+handler+tests. ✓
- §3/§4 command-contract entries + idempotency-false → Task 1. ✓
- §3/§4 `COMMON_READ_TOOLS` allowlist → Task 2. ✓
- §3/§4 the one additive dev-api injection mirroring `driftEngine` → Task 4. ✓
- §5 dormant-but-non-inert (real `execute()` seam, no UI caller) → Task 3 tests drive `execute()`; Task 6 review confirms. ✓
- §6 testing (all listed cases) + `scripts.test` unchanged + 1554 reconcile → Tasks 1–3 (TDD), Task 5 (reconcile +9→1563). ✓
- §7 ONE atomic commit + commit-hygiene gate + out-of-scope EMPTY → Task 6. ✓
- §8 §8d pins (approval_list shape, idempotency exclusion, COMMON_READ_TOOLS, dev-api site, P3a row contract) → grounded in File Structure + Tasks 1–4. ✓

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to". Every code step has complete copy-paste content; every run step has the exact command + expected output.

**3. Type consistency:** `COMMANDS.SPAN_SUMMARY_LIST`/`SPAN_SUMMARY_STATUS` identical across Task 1 (contract), Task 3 (switch + tests). Handler envelopes `{ summaries: … }` / verbatim status object / frozen `SPAN_SUMMARY_UNAVAILABLE` identical across Task 3 impl + tests + the spec. `this.summaryMonitor` (field) ↔ `facade.summaryMonitor` (test injection) ↔ `runtime.toolFacade.summaryMonitor` (dev-api Task 4) consistent. Suite filename `test/spanSummaryTransport.test.js` consistent across Tasks 1, 3, 5, 6.

No gaps found.
