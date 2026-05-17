# Span-Summary Monitor (P3b-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the dormant P3b-1 span-summarizer engine into a live background process via a periodic `SummaryMonitor` wired into `dev-api-server.mjs` — the first and only production caller.

**Architecture:** A new `SummaryMonitor` class (`src/runtime/spanSummary/summaryMonitor.js`) that 1:1 mirrors `src/drift/driftMonitor.js` (private `#timer`, idempotent `start()`/`stop()`, `tickOnce()` over live teams with per-team error isolation) plus an `inFlight` skip-guard and a `getStatus()` in-memory honest-degraded accessor. All IO is constructor-injected; it NEVER throws out of the timer. One additive composition block in `scripts/dev-api-server.mjs` (inside the existing `if (driftDb)`) constructs it over real runtime/P3a collaborators and `start()`s it; `shutdown()` `stop()`s it.

**Tech Stack:** Node.js ESM, `node:test` + `node:assert/strict`, the ratified `scripts/test-suites.txt` canonical chain (`package.json` `scripts.test` = `node scripts/run-test-suites.mjs`).

**Spec:** `docs/superpowers/specs/2026-05-17-span-summary-monitor-design.md` (committed `556e21e`).

**Commit model:** ONE atomic commit. Tasks 1–5 accumulate UNCOMMITTED. Task 6 wires + runs full gates + whole-impl review + the single commit + post-commit verify. Exactly 5 files: `src/runtime/spanSummary/summaryMonitor.js`, `test/spanSummary.summaryMonitor.test.js`, `test/spanSummary.summaryMonitor.e2e.test.js`, `scripts/dev-api-server.mjs`, `scripts/test-suites.txt`.

**Session conventions:** Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed paths, `git -c commit.gpgsign=false`, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. All test commands run from `C:\Project-TOAD\toad-local` (PowerShell: `cd C:\Project-TOAD\toad-local; node --test ...`; or `node -C` style via `cd /c/Project-TOAD/toad-local && ...` in bash).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/runtime/spanSummary/summaryMonitor.js` | **Create.** The `SummaryMonitor` class — periodic driver, per-team isolation, inFlight guard, `getStatus()`. Only this class; no IO of its own. |
| `test/spanSummary.summaryMonitor.test.js` | **Create.** TDD unit suite — injected fakes, no real timers/CLI/db, `tickOnce()` called directly (one short-interval test for start/stop). |
| `test/spanSummary.summaryMonitor.e2e.test.js` | **Create.** Anti-inert e2e — real `LocalToadRuntime` + real P3a + real `summarizePendingSpans` + real `SummaryRateLimiter` + a FAKE `runImpl` (no real CLI) driving a real `SummaryMonitor.tickOnce()`. |
| `scripts/dev-api-server.mjs` | **Modify (ONLY allowed production edit).** 4 added imports + one additive composition block inside the existing `if (driftDb)` + one `summaryMonitor.stop()` line in `shutdown()`. Nothing else mutates. |
| `scripts/test-suites.txt` | **Modify.** Append the 2 new suites after the existing P3b-1 suites (150 → 152). |

**Grounded reference (do NOT modify — mirror only):** `src/drift/driftMonitor.js` (the precedent), `src/runtime/spanSummary/summarizePendingSpans.js` + `runSpanSummary.js` + `summaryRateLimiter.js` + `index.js` (P3b-1, consumed unchanged), `test/spanSummary.summarizer.e2e.test.js` (the §8d P2b e2e harness template).

---

## Task 1: `SummaryMonitor` constructor, fields, `getStatus()` skeleton

**Files:**
- Create: `src/runtime/spanSummary/summaryMonitor.js`
- Create: `test/spanSummary.summaryMonitor.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/spanSummary.summaryMonitor.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryMonitor } from '../src/runtime/spanSummary/summaryMonitor.js';

const noop = () => {};
const okSummarize = async () => ({ summarized: [], degraded: [], skippedRateLimited: 0 });

test('ctor throws TypeError when summarize is not a function', () => {
  assert.throws(
    () => new SummaryMonitor({ listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic' }),
    /SummaryMonitor: summarize\(\) required/,
  );
});

test('ctor throws TypeError when listLiveTeams is not a function', () => {
  assert.throws(
    () => new SummaryMonitor({ summarize: okSummarize, resolveLeadProviderId: () => 'anthropic' }),
    /SummaryMonitor: listLiveTeams\(\) required/,
  );
});

test('ctor throws TypeError when resolveLeadProviderId is not a function', () => {
  assert.throws(
    () => new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [] }),
    /SummaryMonitor: resolveLeadProviderId\(\) required/,
  );
});

test('getStatus() returns the initial idle snapshot before any tick', () => {
  const m = new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic' });
  assert.deepEqual(m.getStatus(), {
    state: 'idle',
    lastRunAt: null,
    lastDurationMs: 0,
    teamsPolled: 0,
    summarizedCount: 0,
    degradedCount: 0,
    skippedRateLimited: 0,
    lastReasons: [],
  });
});

test('getStatus() returns a fresh copy that cannot poison internal state', () => {
  const m = new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic' });
  const s1 = m.getStatus();
  s1.state = 'HACKED';
  s1.lastReasons.push('HACKED');
  assert.equal(m.getStatus().state, 'idle');
  assert.deepEqual(m.getStatus().lastReasons, []);
});

test('ctor accepts a custom intervalMs and defaults to 5 minutes', () => {
  const a = new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic' });
  assert.equal(a.intervalMs, 5 * 60 * 1000);
  const b = new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic', intervalMs: 1234 });
  assert.equal(b.intervalMs, 1234);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.summaryMonitor.test.js`
Expected: FAIL — `Cannot find module '../src/runtime/spanSummary/summaryMonitor.js'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/runtime/spanSummary/summaryMonitor.js`:

```js
// The span-summary trigger/lifecycle (Readability Layer-2 P3b-2). The
// FIRST production caller of the P3b-1 engine. A 1:1 mirror of
// src/drift/driftMonitor.js (a periodic setInterval driver over live
// teams with per-team error isolation) PLUS an inFlight skip-guard and
// a getStatus() in-memory honest-degraded accessor. All IO is
// constructor-injected; tickOnce NEVER throws out of the timer.

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export class SummaryMonitor {
  #timer = null;
  #inFlight = false;
  #status = {
    state: 'idle',
    lastRunAt: null,
    lastDurationMs: 0,
    teamsPolled: 0,
    summarizedCount: 0,
    degradedCount: 0,
    skippedRateLimited: 0,
    lastReasons: [],
  };

  constructor({
    summarize,
    listLiveTeams,
    resolveLeadProviderId,
    intervalMs = DEFAULT_INTERVAL_MS,
    logger = console,
  } = {}) {
    if (typeof summarize !== 'function') {
      throw new TypeError('SummaryMonitor: summarize() required');
    }
    if (typeof listLiveTeams !== 'function') {
      throw new TypeError('SummaryMonitor: listLiveTeams() required');
    }
    if (typeof resolveLeadProviderId !== 'function') {
      throw new TypeError('SummaryMonitor: resolveLeadProviderId() required');
    }
    this.summarize = summarize;
    this.listLiveTeams = listLiveTeams;
    this.resolveLeadProviderId = resolveLeadProviderId;
    this.intervalMs = intervalMs;
    this.logger = logger || console;
  }

  getStatus() {
    const s = this.#status;
    return {
      state: this.#inFlight ? 'summarizing' : s.state,
      lastRunAt: s.lastRunAt,
      lastDurationMs: s.lastDurationMs,
      teamsPolled: s.teamsPolled,
      summarizedCount: s.summarizedCount,
      degradedCount: s.degradedCount,
      skippedRateLimited: s.skippedRateLimited,
      lastReasons: [...s.lastReasons],
    };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.summaryMonitor.test.js`
Expected: PASS — 6/6.

---

## Task 2: `start()` / `stop()` lifecycle (idempotent, `unref`, interval)

**Files:**
- Modify: `src/runtime/spanSummary/summaryMonitor.js`
- Modify: `test/spanSummary.summaryMonitor.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/spanSummary.summaryMonitor.test.js`:

```js
test('start() is idempotent (double-start creates one timer) and unrefs the timer', () => {
  const realSetInterval = global.setInterval;
  const created = [];
  global.setInterval = (fn, ms) => {
    const t = realSetInterval(fn, ms);
    t.__unrefCalled = false;
    const origUnref = t.unref.bind(t);
    t.unref = () => { t.__unrefCalled = true; return origUnref(); };
    created.push(t);
    return t;
  };
  try {
    const m = new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic', intervalMs: 10_000 });
    m.start();
    m.start(); // idempotent — must NOT create a second timer
    assert.equal(created.length, 1, 'exactly one setInterval');
    assert.equal(created[0].__unrefCalled, true, 'timer.unref() was called');
    m.stop();
  } finally {
    global.setInterval = realSetInterval;
  }
});

test('stop() clears the timer, is idempotent, and is safe before start()', () => {
  const m = new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic', intervalMs: 10_000 });
  m.stop();          // safe before start()
  m.start();
  m.stop();
  m.stop();          // idempotent
  assert.ok(true);   // no throw == pass
});

test('start()/stop() drives ticks at the configured interval', async () => {
  let calls = 0;
  const m = new SummaryMonitor({
    summarize: async () => { calls++; return { summarized: [], degraded: [], skippedRateLimited: 0 }; },
    listLiveTeams: () => ['team-a'],
    resolveLeadProviderId: () => 'anthropic',
    intervalMs: 20,
  });
  m.start();
  await new Promise((r) => setTimeout(r, 70));
  m.stop();
  assert.ok(calls >= 2 && calls <= 5, `expected 2-5 ticks, got ${calls}`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.summaryMonitor.test.js`
Expected: FAIL — `m.start is not a function` / `m.stop is not a function` (and the interval test fails because no ticks fire).

- [ ] **Step 3: Write the minimal implementation**

In `src/runtime/spanSummary/summaryMonitor.js`, add `start()` and `stop()` methods immediately after the constructor (before `getStatus()`). They are byte-equivalent in shape to `DriftMonitor.start`/`stop` (`src/drift/driftMonitor.js` lines 48–61):

```js
  start() {
    if (this.#timer) return;
    this.#timer = setInterval(() => {
      this.tickOnce().catch((err) => this.logger.warn('[summary] tick failed:', err));
    }, this.intervalMs);
    if (typeof this.#timer.unref === 'function') this.#timer.unref();
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
```

(`this.tickOnce()` does not exist yet — that is fine: the interval test only asserts the *callback* fired `summarize`; `tickOnce` arrives in Task 3. To keep this task green in isolation, add a minimal placeholder `async tickOnce() { const teams = await Promise.resolve(this.listLiveTeams()); if (Array.isArray(teams)) for (const t of teams) await this.summarize({ teamId: t, leadProviderId: this.resolveLeadProviderId(t) }); }` — it is fully replaced in Task 3.)

So also add, after `stop()`:

```js
  async tickOnce() {
    const teams = await Promise.resolve(this.listLiveTeams());
    if (Array.isArray(teams)) {
      for (const teamId of teams) {
        await this.summarize({ teamId, leadProviderId: this.resolveLeadProviderId(teamId) });
      }
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.summaryMonitor.test.js`
Expected: PASS — 9/9.

---

## Task 3: `tickOnce()` core — live-teams, per-team summarize, accumulation, settled-state machine

**Files:**
- Modify: `src/runtime/spanSummary/summaryMonitor.js`
- Modify: `test/spanSummary.summaryMonitor.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/spanSummary.summaryMonitor.test.js`:

```js
test('tickOnce() with no live teams → status idle, summarize never called', async () => {
  let called = 0;
  const m = new SummaryMonitor({
    summarize: async () => { called++; return { summarized: [], degraded: [], skippedRateLimited: 0 }; },
    listLiveTeams: () => [],
    resolveLeadProviderId: () => 'anthropic',
  });
  await m.tickOnce();
  assert.equal(called, 0);
  const s = m.getStatus();
  assert.equal(s.state, 'idle');
  assert.equal(s.teamsPolled, 0);
  assert.equal(typeof s.lastRunAt, 'number');
  assert.equal(typeof s.lastDurationMs, 'number');
});

test('tickOnce() one team → resolveLeadProviderId + summarize({teamId,leadProviderId}) + status reflects report', async () => {
  const seen = [];
  const m = new SummaryMonitor({
    summarize: async (a) => { seen.push(a); return { summarized: [{ spanId: 's1', model: 'm', cli: 'c' }], degraded: [], skippedRateLimited: 0 }; },
    listLiveTeams: () => ['team-a'],
    resolveLeadProviderId: (t) => (t === 'team-a' ? 'codex' : 'x'),
  });
  await m.tickOnce();
  assert.deepEqual(seen, [{ teamId: 'team-a', leadProviderId: 'codex' }]);
  const s = m.getStatus();
  assert.equal(s.state, 'idle');
  assert.equal(s.teamsPolled, 1);
  assert.equal(s.summarizedCount, 1);
  assert.equal(s.degradedCount, 0);
});

test('tickOnce() multi-team accumulates counts + dedups degraded reasons across teams', async () => {
  const m = new SummaryMonitor({
    summarize: async ({ teamId }) => (teamId === 'team-a'
      ? { summarized: [{ spanId: 'a1' }], degraded: [{ spanId: 'a2', reason: 'timeout' }], skippedRateLimited: 0 }
      : { summarized: [], degraded: [{ spanId: 'b1', reason: 'timeout' }, { spanId: 'b2', reason: 'spawn_failed' }], skippedRateLimited: 0 }),
    listLiveTeams: () => ['team-a', 'team-b'],
    resolveLeadProviderId: () => 'anthropic',
  });
  await m.tickOnce();
  const s = m.getStatus();
  assert.equal(s.teamsPolled, 2);
  assert.equal(s.summarizedCount, 1);
  assert.equal(s.degradedCount, 3);
  assert.equal(s.state, 'degraded');
  assert.deepEqual([...s.lastReasons].sort(), ['spawn_failed', 'timeout']);
});

test('tickOnce() state machine: rate-limited only when skipped>0 AND summarized==0', async () => {
  const rl = new SummaryMonitor({
    summarize: async () => ({ summarized: [], degraded: [], skippedRateLimited: 4 }),
    listLiveTeams: () => ['t'], resolveLeadProviderId: () => 'anthropic',
  });
  await rl.tickOnce();
  assert.equal(rl.getStatus().state, 'rate-limited');
  assert.equal(rl.getStatus().skippedRateLimited, 4);

  const idle = new SummaryMonitor({
    summarize: async () => ({ summarized: [{ spanId: 's' }], degraded: [], skippedRateLimited: 4 }),
    listLiveTeams: () => ['t'], resolveLeadProviderId: () => 'anthropic',
  });
  await idle.tickOnce();
  assert.equal(idle.getStatus().state, 'idle', 'progress beats throttle: summarized>0 → idle');
});

test('tickOnce() state machine: degraded outranks rate-limited', async () => {
  const m = new SummaryMonitor({
    summarize: async () => ({ summarized: [], degraded: [{ spanId: 'x', reason: 'persist_failed' }], skippedRateLimited: 9 }),
    listLiveTeams: () => ['t'], resolveLeadProviderId: () => 'anthropic',
  });
  await m.tickOnce();
  assert.equal(m.getStatus().state, 'degraded');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.summaryMonitor.test.js`
Expected: FAIL — the new tests fail because the Task-2 placeholder `tickOnce()` does not accumulate counts or write `#status` (e.g. `s.teamsPolled` is `0`, `s.state` stays `idle` when it should be `degraded`).

- [ ] **Step 3: Write the implementation**

Replace the entire placeholder `async tickOnce() { … }` in `src/runtime/spanSummary/summaryMonitor.js` with the real implementation (this is the final shape minus the inFlight guard, which Task 4 adds):

```js
  async tickOnce() {
    this.#inFlight = true;
    const startedAt = Date.now();
    let teamsPolled = 0;
    let summarizedCount = 0;
    let degradedCount = 0;
    let skippedRateLimited = 0;
    const reasons = new Set();
    try {
      const teams = await Promise.resolve(this.listLiveTeams());
      if (Array.isArray(teams) && teams.length > 0) {
        teamsPolled = teams.length;
        await Promise.all(teams.map(async (teamId) => {
          try {
            const leadProviderId = this.resolveLeadProviderId(teamId);
            const r = await this.summarize({ teamId, leadProviderId });
            if (r && typeof r === 'object') {
              if (Array.isArray(r.summarized)) summarizedCount += r.summarized.length;
              if (Array.isArray(r.degraded)) {
                degradedCount += r.degraded.length;
                for (const d of r.degraded) {
                  if (d && typeof d.reason === 'string') reasons.add(d.reason);
                }
              }
              if (Number.isFinite(r.skippedRateLimited)) {
                skippedRateLimited += r.skippedRateLimited;
              }
            }
          } catch (err) {
            this.logger.warn(`[summary] team=${teamId} failed:`, err);
          }
        }));
      }
    } catch (err) {
      this.logger.warn('[summary] tick error:', err);
    } finally {
      let state;
      if (degradedCount > 0) state = 'degraded';
      else if (skippedRateLimited > 0 && summarizedCount === 0) state = 'rate-limited';
      else state = 'idle';
      this.#status = {
        state,
        lastRunAt: startedAt,
        lastDurationMs: Date.now() - startedAt,
        teamsPolled,
        summarizedCount,
        degradedCount,
        skippedRateLimited,
        lastReasons: Array.from(reasons),
      };
      this.#inFlight = false;
    }
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.summaryMonitor.test.js`
Expected: PASS — 14/14 (the Task-2 interval test still passes — the callback still fires `tickOnce`).

---

## Task 4: `inFlight` skip-guard + never-throw totality

**Files:**
- Modify: `src/runtime/spanSummary/summaryMonitor.js`
- Modify: `test/spanSummary.summaryMonitor.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `test/spanSummary.summaryMonitor.test.js`:

```js
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('inFlight guard: a second tickOnce() while the first is pending is skipped + logged', async () => {
  const gate = deferred();
  let calls = 0;
  const warns = [];
  const m = new SummaryMonitor({
    summarize: async () => { calls++; await gate.promise; return { summarized: [], degraded: [], skippedRateLimited: 0 }; },
    listLiveTeams: () => ['team-a'],
    resolveLeadProviderId: () => 'anthropic',
    logger: { warn: (...a) => warns.push(a.join(' ')) },
  });
  const first = m.tickOnce();           // enters, summarize pending on the gate
  await Promise.resolve();              // let the first tick reach `await gate.promise`
  await m.tickOnce();                   // second call: must be skipped immediately
  assert.equal(calls, 1, 'summarize called exactly once (second tick skipped)');
  assert.ok(warns.some((w) => /tick skipped: previous in flight/.test(w)));
  gate.resolve();
  await first;
});

test('inFlight cleared in finally even when a team throws — a later tick proceeds', async () => {
  let calls = 0;
  const m = new SummaryMonitor({
    summarize: async () => { calls++; throw new Error('boom'); },
    listLiveTeams: () => ['team-a'],
    resolveLeadProviderId: () => 'anthropic',
    logger: { warn() {} },
  });
  await m.tickOnce();                   // team throws, swallowed; #inFlight cleared in finally
  await m.tickOnce();                   // proves the flag did not leak
  assert.equal(calls, 2);
  assert.equal(m.getStatus().state, 'idle'); // no degraded report (throw != degraded[])
});

test('per-team isolation: one team throwing does not stop the others; tickOnce never throws', async () => {
  const m = new SummaryMonitor({
    summarize: async ({ teamId }) => {
      if (teamId === 'bad') throw new Error('bad team');
      return { summarized: [{ spanId: `${teamId}-1` }], degraded: [], skippedRateLimited: 0 };
    },
    listLiveTeams: () => ['good-1', 'bad', 'good-2'],
    resolveLeadProviderId: () => 'anthropic',
    logger: { warn() {} },
  });
  await assert.doesNotReject(() => m.tickOnce());
  const s = m.getStatus();
  assert.equal(s.teamsPolled, 3);
  assert.equal(s.summarizedCount, 2, 'both good teams summarized despite the bad one');
});

test('tickOnce never throws when listLiveTeams throws', async () => {
  const m = new SummaryMonitor({
    summarize: async () => ({ summarized: [], degraded: [], skippedRateLimited: 0 }),
    listLiveTeams: () => { throw new Error('registry down'); },
    resolveLeadProviderId: () => 'anthropic',
    logger: { warn() {} },
  });
  await assert.doesNotReject(() => m.tickOnce());
  assert.equal(m.getStatus().state, 'idle');
  assert.equal(m.getStatus().teamsPolled, 0);
});

test('tickOnce never throws when resolveLeadProviderId throws (isolated per team)', async () => {
  let summarizeCalls = 0;
  const m = new SummaryMonitor({
    summarize: async () => { summarizeCalls++; return { summarized: [], degraded: [], skippedRateLimited: 0 }; },
    listLiveTeams: () => ['team-a'],
    resolveLeadProviderId: () => { throw new Error('teamConfig miss'); },
    logger: { warn() {} },
  });
  await assert.doesNotReject(() => m.tickOnce());
  assert.equal(summarizeCalls, 0, 'summarize not reached when resolveLeadProviderId throws');
  assert.equal(m.getStatus().state, 'idle');
});

test('getStatus() overlays "summarizing" while a tick is in flight', async () => {
  const gate = deferred();
  const m = new SummaryMonitor({
    summarize: async () => { await gate.promise; return { summarized: [{ spanId: 's' }], degraded: [], skippedRateLimited: 0 }; },
    listLiveTeams: () => ['team-a'],
    resolveLeadProviderId: () => 'anthropic',
  });
  const p = m.tickOnce();
  await Promise.resolve();
  assert.equal(m.getStatus().state, 'summarizing', 'inFlight overlay');
  gate.resolve();
  await p;
  assert.equal(m.getStatus().state, 'idle', 'settled classification after the tick');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.summaryMonitor.test.js`
Expected: FAIL — the inFlight-guard test fails (`calls` is `2`, not `1`, because the second `tickOnce()` is not yet skipped). The other totality tests already pass from Task 3's try/catch/finally — that is expected and acceptable (they lock in the behavior); only the guard test must be RED before Step 3.

- [ ] **Step 3: Write the minimal implementation**

In `src/runtime/spanSummary/summaryMonitor.js`, add the guard as the very first statement of `tickOnce()`, before `this.#inFlight = true;`:

```js
  async tickOnce() {
    if (this.#inFlight) {
      this.logger.warn('[summary] tick skipped: previous in flight');
      return;
    }
    this.#inFlight = true;
    const startedAt = Date.now();
    // ... rest unchanged from Task 3 ...
```

(No other change. The full final file is: comment header, `DEFAULT_INTERVAL_MS`, the `SummaryMonitor` class with `#timer`/`#inFlight`/`#status` fields, constructor with the 3 `TypeError` guards, `start()`, `stop()`, `tickOnce()` with the inFlight guard + try/catch/finally, `getStatus()` with the `#inFlight ? 'summarizing'` overlay.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.summaryMonitor.test.js`
Expected: PASS — 20/20.

---

## Task 5: Anti-inert e2e — real `LocalToadRuntime` + real P3a + fake `runImpl`

**Files:**
- Create: `test/spanSummary.summaryMonitor.e2e.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/spanSummary.summaryMonitor.e2e.test.js` (mirrors `test/spanSummary.summarizer.e2e.test.js`'s §8d-ratified P2b ingestion path, wrapped in a real `SummaryMonitor`):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';
import { summarizePendingSpans, SummaryRateLimiter } from '../src/runtime/spanSummary/index.js';
import { SummaryMonitor } from '../src/runtime/spanSummary/summaryMonitor.js';

test('SummaryMonitor composes a REAL LocalToadRuntime + real P3a + a FAKE runImpl: persist→excluded→idempotent (no real CLI)', async () => {
  const rt = new LocalToadRuntime();

  // §8d-ratified P2b path: tool_use for an UNREGISTERED runtime persists
  // the narration before the identity check throws; tolerate only that.
  try {
    await rt.eventIngestor.ingest({
      type: 'tool_use', runtimeId: 'rt-p3b2', teamId: 'team-p3b2', agentId: 'lead',
      toolName: 'Read', input: { file_path: '/x/a.js' },
      createdAt: '2026-05-16T00:00:00.000Z', raw: {},
    });
  } catch (err) {
    assert.match(String((err && err.message) || err), /unknown runtime identity/);
  }
  // turn_completed (kind:system) closes the span; no identity check, no throw.
  await rt.eventIngestor.ingest({
    type: 'turn_completed', runtimeId: 'rt-p3b2', teamId: 'team-p3b2', agentId: 'lead',
    createdAt: '2026-05-16T00:00:05.000Z', raw: {},
  });

  assert.equal(rt.listSpansAwaitingSummary({ teamId: 'team-p3b2' }).length, 1, 'one closed span awaiting');

  let runCalls = 0;
  const limiter = new SummaryRateLimiter({ maxPerHour: 20, now: Date.now });
  const monitor = new SummaryMonitor({
    listLiveTeams: () => ['team-p3b2'],
    resolveLeadProviderId: () => 'anthropic',
    summarize: ({ teamId, leadProviderId }) => summarizePendingSpans({
      teamId,
      leadProviderId,
      listAwaiting: (a) => rt.listSpansAwaitingSummary(a),
      appendSummary: (s) => rt.spanSummaryStore.appendSummary(s),
      runImpl: async () => { runCalls++; return { ok: true, summaryText: 'the agent read a.js' }; },
      limiter,
      settings: {},
    }),
  });

  await monitor.tickOnce();

  assert.equal(runCalls, 1, 'the (fake) runner was invoked for the one span');
  const sums = rt.listSpanSummaries({ teamId: 'team-p3b2' });
  assert.equal(sums.length, 1);
  assert.equal(sums[0].summaryText, 'the agent read a.js');
  assert.equal(sums[0].cli, 'gemini');                 // anthropic lead → gemini route
  assert.equal(sums[0].model, 'gemini-2.5-flash');
  assert.deepEqual(rt.listSpansAwaitingSummary({ teamId: 'team-p3b2' }), [], 'span no longer awaiting');

  let st = monitor.getStatus();
  assert.equal(st.summarizedCount, 1);
  assert.equal(st.degradedCount, 0);
  assert.equal(st.state, 'idle');
  assert.equal(st.teamsPolled, 1);

  // Idempotent second tick: nothing awaiting, no duplicate, fake runImpl must not fire.
  await monitor.tickOnce();
  assert.equal(rt.listSpanSummaries({ teamId: 'team-p3b2' }).length, 1, 'no duplicate summary');
  st = monitor.getStatus();
  assert.equal(st.summarizedCount, 0, 'second tick summarized nothing new');
  assert.equal(st.state, 'idle');
});
```

- [ ] **Step 2: Run the test to verify it fails (then passes)**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/spanSummary.summaryMonitor.e2e.test.js`
Expected: PASS immediately — every collaborator (`LocalToadRuntime`, P3a, `summarizePendingSpans`, `SummaryRateLimiter`, `SummaryMonitor`) already exists after Tasks 1–4. This is an **integration/composition** test, not a unit under TDD: it has no new production code to drive. If it FAILS, that is a real defect in the Task 1–4 implementation or its composition — STOP and fix the implementation (do not weaken the test).

---

## Task 6: Wire `dev-api-server.mjs` + `test-suites.txt`, full gates, whole-impl review, the single commit, post-commit verify

**Files:**
- Modify: `scripts/dev-api-server.mjs`
- Modify: `scripts/test-suites.txt`

- [ ] **Step 1: Add the 4 imports to `scripts/dev-api-server.mjs`**

Immediately after the existing import line `import { sweepZombies } from '../src/runtime/spawnLedger.js';` (currently line 14), add:

```js
import { SummaryMonitor } from '../src/runtime/spanSummary/summaryMonitor.js';
import { summarizePendingSpans } from '../src/runtime/spanSummary/summarizePendingSpans.js';
import { runSpanSummary } from '../src/runtime/spanSummary/runSpanSummary.js';
import { SummaryRateLimiter } from '../src/runtime/spanSummary/summaryRateLimiter.js';
```

- [ ] **Step 2: Add the composition block inside the existing `if (driftDb)`**

In `scripts/dev-api-server.mjs`, find the end of the drift-monitor wiring inside `if (driftDb) { … }` — specifically the `else { … }` / closing of the `if (typeof runtime.taskBoard?.subscribe === 'function')` block, just before the block-closing `} else {` that logs `'[drift] no SQLite handle available…'`. Declare the monitor variable alongside `driftMonitor`: change the existing `let driftMonitor = null;` line (currently line 60) region by adding, right after it:

```js
let summaryMonitor = null;
```

Then, inside `if (driftDb) {`, AFTER the entire drift `taskBoard.subscribe` `if/else` and BEFORE the `} else {` that handles no-sqlite, insert this block (it reuses the `all` snapshot already read at ~line 71 for drift — do NOT call `readEffective()` again):

```js
  // §-span-summary wiring (Readability Layer-2 P3b-2). First production
  // caller of the P3b-1 engine. Mirrors the drift-monitor block above:
  // periodic SummaryMonitor over live teams, honest degradation, the
  // engine internals untouched. `all` is the settings snapshot already
  // read above for drift (no second readEffective()).
  const sumCfg = (all && typeof all === 'object' && all.summarizer) || {};
  const sumIntervalMs =
    Number.isFinite(sumCfg.intervalMs) && sumCfg.intervalMs > 0
      ? sumCfg.intervalMs
      : undefined; // undefined → SummaryMonitor's 5-min default
  const summaryLimiter = new SummaryRateLimiter({
    maxPerHour:
      Number.isFinite(sumCfg.maxPerHour) && sumCfg.maxPerHour > 0
        ? sumCfg.maxPerHour
        : 20,
  });
  summaryMonitor = new SummaryMonitor({
    intervalMs: sumIntervalMs,
    listLiveTeams: () => {
      const runtimes = runtime.runtimeRegistry?.listRuntimes?.() ?? [];
      const liveTeams = new Set(
        runtimes
          .filter((r) => r && (r.status === 'running' || r.status === 'live' || r.status === 'starting'))
          .map((r) => r.teamId)
          .filter((tid) => typeof tid === 'string' && tid.length > 0)
      );
      return Array.from(liveTeams);
    },
    resolveLeadProviderId: (teamId) =>
      runtime.teamConfigRegistry?.get?.(teamId)?.lead?.providerId ?? 'anthropic',
    summarize: ({ teamId, leadProviderId }) =>
      summarizePendingSpans({
        teamId,
        leadProviderId,
        listAwaiting: (a) => runtime.listSpansAwaitingSummary(a),
        appendSummary: (s) => runtime.spanSummaryStore.appendSummary(s),
        runImpl: runSpanSummary,
        limiter: summaryLimiter,
        settings: all,
        cwd: projectCwd || undefined,
        isolateHome: false,
      }),
  });
  summaryMonitor.start();
```

- [ ] **Step 3: Add the `stop()` to `shutdown()`**

In `scripts/dev-api-server.mjs`, in the `async function shutdown()` (currently ~lines 212–218), add the summary stop directly after the `driftMonitor` stop and BEFORE `await runtime.close();`:

```js
async function shutdown() {
  if (driftMonitor && typeof driftMonitor.stop === 'function') {
    driftMonitor.stop();
  }
  if (summaryMonitor && typeof summaryMonitor.stop === 'function') {
    summaryMonitor.stop();
  }
  await runtime.close();
  process.exit(0);
}
```

- [ ] **Step 4: Verify the server module still loads (syntax/wiring smoke)**

Run: `cd /c/Project-TOAD/toad-local && node --check scripts/dev-api-server.mjs`
Expected: exit 0, no output (syntax valid). Do NOT run the server itself.

- [ ] **Step 5: Wire both suites into `scripts/test-suites.txt`**

`scripts/test-suites.txt` is a single line; the chain currently ends with `… && node --no-warnings --test test/spanSummary.summarizer.e2e.test.js` (no trailing newline). Append (same `node --no-warnings --test` prefix the other `spanSummary` suites use), preserving the no-trailing-newline:

```
 && node --no-warnings --test test/spanSummary.summaryMonitor.test.js && node --no-warnings --test test/spanSummary.summaryMonitor.e2e.test.js
```

Validation:
Run: `cd /c/Project-TOAD/toad-local && node -e "const fs=require('fs');const c=fs.readFileSync('scripts/test-suites.txt','utf8');const n=(c.match(/node .*?--test test\//g)||[]).length;console.log('suites='+n);console.log('mon='+/test\/spanSummary\.summaryMonitor\.test\.js/.test(c));console.log('e2e='+/test\/spanSummary\.summaryMonitor\.e2e\.test\.js/.test(c));console.log('scriptsTest='+JSON.parse(fs.readFileSync('package.json','utf8')).scripts.test);"`
Expected: `suites=152`, `mon=true`, `e2e=true`, `scriptsTest=node scripts/run-test-suites.mjs`.

- [ ] **Step 6: Run the FULL root suite via the ratified runner**

Run: `cd /c/Project-TOAD/toad-local && node scripts/run-test-suites.mjs`
Expected: the runner runs the entire chain fail-fast; final summary `# pass 1551`, `# fail 0` (post-P3b-1 baseline 1533 + the new P3b-2 suites; the controller reconciles the exact delta in Step 8 — do not hard-trust this number, reconcile it). The two new suite titles must appear in this runner's own output. No `not ok`. No `Command line is too long`.

- [ ] **Step 7: Dispatch the mandatory whole-implementation subagent review**

Dispatch a fresh code-reviewer subagent over the entire P3b-2 surface (the 5 files + the spec). It must verify: `SummaryMonitor` never throws out of the timer; the inFlight guard truly serializes; the §5 single-source state model exactly (inFlight overlay precedence, frozen-per-tick classification, returned-copy-cannot-poison); `dev-api-server.mjs` changed ONLY by the additive block + 4 imports + the one `shutdown()` line (drift block / runtime construction / zombie sweep / SIGINT-SIGTERM / logging byte-identical); the e2e genuinely composes real `LocalToadRuntime` + real P3a + a FAKE `runImpl` (no real CLI); no out-of-scope change; both suites genuinely execute with substantive assertions. Resolve any Critical/Important via a fix-loop before Step 8.

- [ ] **Step 8: Commit (the single atomic commit)**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/spanSummary/summaryMonitor.js toad-local/test/spanSummary.summaryMonitor.test.js toad-local/test/spanSummary.summaryMonitor.e2e.test.js toad-local/scripts/dev-api-server.mjs toad-local/scripts/test-suites.txt

git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "feat(spans): periodic SummaryMonitor wires the summarizer engine live (Readability Layer-2 P3b-2)

SummaryMonitor: a 1:1 DriftMonitor mirror (private #timer, idempotent
start()/stop(), tickOnce() over live teams with per-team error
isolation) PLUS an inFlight skip-guard and a getStatus() in-memory
honest-degraded accessor (single-source state: getStatus() overlays
'summarizing' from live #inFlight; degraded/rate-limited/idle frozen
per-tick; returned copy cannot poison internal state). NEVER throws
out of the timer.

dev-api-server.mjs: the FIRST production caller of the P3b-1 engine —
one additive composition block inside the existing if (driftDb)
(reusing the drift settings snapshot) + 4 imports + one stop() line in
shutdown(). No engine internals, P3a, P2b, P2a, P1, drift, runtime, or
UI behavior changed.

Anti-inert e2e: real LocalToadRuntime + real P3a + real
summarizePendingSpans + real SummaryRateLimiter + a FAKE runImpl (no
real CLI) driving a real SummaryMonitor.tickOnce() — genuine
composition, idempotent. 2 suites wired into the ratified
scripts/test-suites.txt chain. Full root fail 0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 9: Post-commit verification**

```bash
git -C /c/Project-TOAD show --stat HEAD            # EXACTLY 5 files, no stray
git -C /c/Project-TOAD diff --stat 556e21e HEAD -- toad-local/src/drift toad-local/src/runtime/sqliteNarrationStore.js toad-local/src/runtime/eventNarration toad-local/src/runtime/spanDetection toad-local/src/runtime/timelineComposition toad-local/src/runtime/RuntimeEventIngestor.js toad-local/src/runtime/sqliteSpanSummaryStore.js toad-local/src/runtime/spanSummary/decideSpansToSummarize.js toad-local/src/runtime/spanSummary/summarizerSystemPrompt.js toad-local/src/runtime/spanSummary/buildSummaryPrompt.js toad-local/src/runtime/spanSummary/extractSummaryText.js toad-local/src/runtime/spanSummary/resolveSummaryRoute.js toad-local/src/runtime/spanSummary/summaryRateLimiter.js toad-local/src/runtime/spanSummary/runSpanSummary.js toad-local/src/runtime/spanSummary/summarizePendingSpans.js toad-local/src/runtime/spanSummary/index.js toad-local/src/app/LocalToadRuntime.js toad-local/src/read/LocalReadModel.js toad-local/ui    # EXPECT EMPTY
git -C /c/Project-TOAD diff 556e21e HEAD -- toad-local/scripts/dev-api-server.mjs   # ONLY additions: the 4 imports + `let summaryMonitor = null;` hoist + the additive composition block + the shutdown() stop lines. ZERO modifications to existing logic — drift block / runtime construction / zombie sweep / SIGINT-SIGTERM / logging byte-identical
git -C /c/Project-TOAD log --oneline -2            # HEAD = P3b-2 commit; HEAD~1 = 556e21e (spec)
```
Expected: HEAD stat exactly the 5 files; the out-of-scope `diff --stat` EMPTY; the `dev-api-server.mjs` diff is only the additive surface; controller independently re-runs `node scripts/run-test-suites.mjs`, greps BOTH P3b-2 titles in its OWN output, and reconciles the exact pass-delta vs the post-P3b-1 **1533** baseline (the two suites add their assertion count; never trust the pasted number). Mark P3b-2 complete.

---

## Self-Review

**1. Spec coverage:**
- §3 grounded pins → Task 3/4 (`DriftMonitor` mirror, totality), Task 6 (dev-api-server lifecycle, SettingsStore `all` reuse, P3a contract, lead-provider). ✓
- §5 `SummaryMonitor` (ctor guards, `start/stop/tickOnce/getStatus`, single-source state) → Tasks 1–4. ✓
- §6 wiring block (4 imports, additive block, `shutdown()` line, grounded fixed choices) → Task 6 Steps 1–3. ✓
- §8 honest degradation/totality → Task 4 tests. ✓
- §9 unit + anti-inert e2e + suite wiring + exact pass reconciliation → Tasks 1–6. ✓
- §10 controller surfaces (never-throw, inFlight serialization, state model, dev-api-server-only diff, e2e genuine composition, un-wired-test trap, whole-impl review) → Task 6 Steps 6–9. ✓
- §11 one atomic commit, 5 files, post-commit verify → Task 6 Steps 8–9. ✓

**2. Placeholder scan:** No `TBD`/`TODO`/"handle edge cases"/"similar to". Every code step shows complete code; every run step shows the exact command + expected output. The Task-2 transitional `tickOnce` placeholder is explicitly fully replaced in Task 3 Step 3 (its full final body is shown). ✓

**3. Type consistency:** `summarize({teamId,leadProviderId})` report `{summarized[],degraded[],skippedRateLimited}`; `getStatus()` shape `{state,lastRunAt,lastDurationMs,teamsPolled,summarizedCount,degradedCount,skippedRateLimited,lastReasons}` — identical across Tasks 1, 3, 4, 5 tests and the §5 spec. `#timer`/`#inFlight`/`#status` private fields consistent. `intervalMs` default `5*60*1000` consistent (Task 1 test + impl + spec). Suite filenames `test/spanSummary.summaryMonitor.test.js` / `test/spanSummary.summaryMonitor.e2e.test.js` consistent across Tasks 1/5/6 and the commit `git add`. ✓

No gaps found.
