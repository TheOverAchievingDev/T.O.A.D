# Proactive Compaction Triggers (Sub-project C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Proactively send `/compact` to a Claude agent at a configurable context-usage threshold (default 70%, at idle) so compaction happens before the CLI's too-late ~85% auto-compaction.

**Architecture:** A pure `shouldCompact()` decision core (sealed `REASONS`, ordered decision table, all IO injected — the `claudeAuthPreflight`/`eventNarration` discipline) consumed by a thin `CompactionTrigger` wiring handler that is a sibling to the existing reactive `CompactionHandler` (which is untouched). The handler hangs off the `RuntimeEventIngestor` compaction-lifecycle dispatch (`turn_completed`/`compact_boundary`/`turn_failed`), reads Sub-project B's shipped `getContextUsage`, and sends `/compact` via the existing `adapter.sendTurn` rail, surfacing every action through `sideEffectLog` + the existing `runtime_event` bus.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, existing `RuntimeEventIngestor`/`LocalToadRuntime`/`SettingsStore`/`RuntimeEventBus`/`sideEffectLog` seams. No new dependencies.

---

## Grounded facts (verified in code 2026-05-16 — the plan is built on these; §8d)

- **B is shipped, no live caller yet.** `getContextUsage(agentId, { teamId, runtimeRegistry, eventLog, settings, now }) → { used, total, percentage, model, provider, lastUpdatedAt, stale, source }` (`src/runtime/contextUsage/getContextUsage.js`). `IMPLEMENTED = new Set(['claude','anthropic'])`; **any non-Claude provider, missing deps, or no events → `degraded()` = `{ used:null,total:null,percentage:null, model, provider, lastUpdatedAt:null, stale:true, source:'unknown' }`**. **Consequence (grounding win):** the Claude-only gate the spec (§3.3/§6 #1) wanted **falls out of B's contract** — a non-Claude runtime yields `source:'unknown'`, which the decision core's branch #1 already no-fires on. C therefore needs **no separate provider-detection code**; it just consumes B and trusts B's degraded contract. (Spec §3.3 "non-Claude returns immediately" is realized via B's degraded shape, not a bespoke detector — a simplification, recorded so a reviewer does not "add the missing detector".)
- **The compaction-lifecycle dispatch seam.** `src/runtime/RuntimeEventIngestor.js`:
  - `#dispatchCompactionLifecycle(event)` (≈L200-210): `compact_boundary → compactionHandler.onCompactBoundary(event)`; `turn_completed → void compactionHandler.onTurnCompleted(event)`; `turn_failed → compactionHandler.onTurnFailed(event)`.
  - It is called from `ingest()` for every non-`tool_use`/non-`approval_request`/non-`assistant_text` event with the **normalized** event (≈L73-76).
  - Constructor (≈L13-25) accepts `compactionHandler = null`, `eventBus = null`, `sideEffectLog = null`, `runtimeRegistry = null` and stores them on `this`.
  - Normalized event shape carries `{ type, runtimeId, teamId, agentId, sessionId, createdAt }`.
- **`LocalToadRuntime` construction order (`src/app/LocalToadRuntime.js`):**
  - `this.compactionHandler = new CompactionHandler({ adapters, taskBoard: this.taskBoard, sideEffectLog: this.sideEffectLog });` (≈L270)
  - `this.eventBus = new RuntimeEventBus();` (≈L271) — **eventBus is created AFTER L270; `CompactionTrigger` (which needs eventBus) MUST be constructed after this line.**
  - `this.settingsStore = new SettingsStore({ projectCwd });` (≈L218); `this.runtimeRegistry` (≈L126), `this.eventLog`, `this.sideEffectLog`, `adapters` all available.
  - `new RuntimeEventIngestor({ … runtimeRegistry: this.runtimeRegistry, compactionHandler: this.compactionHandler, eventBus: this.eventBus, sideEffectLog: this.sideEffectLog … })` (≈L297-305).
- **Send rail (mirror `CompactionHandler` ≈L60-75):** `const adapter = this.adapters?.get?.(event.runtimeId); if (!adapter || typeof adapter.sendTurn !== 'function') return;` then `await adapter.sendTurn({ message: { messageId, text, metadata } })`.
- **`sideEffectLog` API (`src/delivery/sideEffectLog.js`):** `markPending({ deliveryId, idempotencyKey, kind, runtimeId })`, `markDelivered(idempotencyKey)`, `markFailed(idempotencyKey)`.
- **Observable channel:** `eventBus.emit('runtime_event', { type, …fields, createdAt: new Date().toISOString() })` — the exact pattern `LocalToadRuntime` already uses (≈L352-372) and the cockpit consumes via SSE. **Reuse this; introduce no new bus** (spec §6).
- **`SettingsStore` (`src/settings/settingsStore.js`):** `readEffective()` is **async**, returns merged namespaced top-level sections (`{ general, providers, github, workspace, risk, mcp, notifications, advanced, … unknown sections preserved }`). There is **no `compaction` section today** — C introduces it. Pure core stays sync (takes a plain `threshold` number); the async settings read lives in an **injected `getThreshold()`** in the wiring layer (testable, no real fs in tests).
- **Test-harness precedent to mirror:** `test/compactionHandler.test.js` — `createMockAdapter()` (records `turns[]`, `sendTurn` resolves `{accepted:true,…}`), `createMockSideEffectLog()` (Map of records w/ `markPending/markDelivered/markFailed/get`), `node:test` `describe/it/beforeEach`, `assert/strict`. Do **not** invent a different harness.
- **Sealed-enum precedent:** `TOKEN_STATUS`/`NARRATION_KINDS` — `Object.freeze` + a throwing-mutator IIFE; a frozen-throw test asserts mutation throws under Node ≥20.
- **Purity-guard precedent:** `test/eventNarration.purity.test.js` — reads the module source and asserts it imports no `node:`/`fs`/`path`/`os`/`child_process` and never touches `process`.

## File Structure

| File | Responsibility |
|---|---|
| `src/runtime/compactionTrigger/shouldCompact.js` *(create, Commit 1)* | Pure decision core + sealed `REASONS`. Zero imports. `shouldCompact({usage,threshold,state,now}) → {trigger,reason}`. |
| `src/runtime/compactionTrigger/index.js` *(create C1; extend C2)* | Re-export surface. C1: only `{ shouldCompact, REASONS }`. C2: add `{ CompactionTrigger }`. (ESM-incremental-index trap: never `export … from` a file that does not exist yet.) |
| `src/runtime/compactionTrigger/CompactionTrigger.js` *(create, Commit 2)* | Thin wiring handler: per-runtime state, reads B, calls the pure core, sends `/compact`, surfaces side-effect + observable, boundary-gate + bounded retry. Sibling to `CompactionHandler` (no shared state). |
| `src/runtime/RuntimeEventIngestor.js` *(modify, Commit 2)* | Add `compactionTrigger = null` ctor param; route it in `#dispatchCompactionLifecycle` alongside `compactionHandler`. |
| `src/app/LocalToadRuntime.js` *(modify, Commit 2)* | Construct `this.compactionTrigger` after `this.eventBus`; pass into the ingestor. |
| `test/compactionTrigger.shouldCompact.test.js` *(create, Commit 1)* | Decision-table unit tests, every ordered branch. |
| `test/compactionTrigger.purity.test.js` *(create, Commit 1)* | `REASONS` frozen-throw + module-import-purity guard. |
| `test/compactionTrigger.test.js` *(create, Commit 2)* | Wiring handler w/ injected fakes (fire/gate/retry/giveup/stale/non-claude/cleanup). |
| `test/runtimeEventIngestor.compactionTrigger.test.js` *(create, Commit 2)* | Proves the ingestor actually routes `turn_completed`/`compact_boundary`/`turn_failed` to `compactionTrigger` (anti-inert-wiring). |
| `test/localToadRuntime.compactionTrigger.test.js` *(create, Commit 2)* | Proves `LocalToadRuntime` constructs `CompactionTrigger` (after `eventBus`) and passes it into the ingestor (anti-inert-construction). |
| `package.json` *(modify, Commit 1 & Commit 2)* | Append the new suites to `scripts.test` (the un-wired-test false-green trap). |

**Commit policy:** **Commit 1 = Tasks 1–3** (pure core + its 2 test suites wired + gated). **Commit 2 = Tasks 4–10** (wiring handler + ingestor + LocalToadRuntime + its 2 test suites wired + gated + whole-impl review). Tasks within a commit accumulate **uncommitted**; the only commits are Task 3 (Commit 1) and Task 10 (Commit 2). Commit to `main` per session convention: `git -C /c/Project-TOAD`, `toad-local/`-prefixed paths, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

---

## Task 1: Sealed `REASONS` + `shouldCompact` skeleton + purity guard

**Files:**
- Create: `src/runtime/compactionTrigger/shouldCompact.js`
- Create: `test/compactionTrigger.purity.test.js`

- [ ] **Step 1: Write the failing purity + frozen-throw test**

Create `test/compactionTrigger.purity.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { REASONS } from '../src/runtime/compactionTrigger/shouldCompact.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'runtime', 'compactionTrigger');

test('shouldCompact.js imports no node:* / fs / path / os / child_process and never touches process', () => {
  const src = readFileSync(join(dir, 'shouldCompact.js'), 'utf8');
  assert.ok(!/from\s+['"]node:/.test(src), 'imports a node: builtin');
  assert.ok(!/from\s+['"](fs|path|os|child_process)['"]/.test(src), 'imports a node core module');
  assert.ok(!/\bprocess\.(env|cwd|platform)\b/.test(src), 'touches process');
});

test('REASONS is sealed — mutation throws (Node >=20 frozen semantics)', () => {
  assert.throws(() => { REASONS.NEW_ONE = 'x'; }, TypeError);
  assert.throws(() => { REASONS.BELOW_THRESHOLD = 'mutated'; }, TypeError);
});

test('REASONS has exactly the seven sealed members', () => {
  assert.deepEqual(
    [...Object.keys(REASONS)].sort(),
    ['BELOW_THRESHOLD', 'GATED_IN_FLIGHT', 'GIVING_UP_SURFACED', 'NO_SIGNAL', 'RETRY', 'SIGNAL_UNTRUSTWORTHY', 'THRESHOLD_CROSSED'].sort(),
  );
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.purity.test.js`
Expected: FAIL — `Cannot find module '.../shouldCompact.js'`.

- [ ] **Step 3: Implement the skeleton**

Create `src/runtime/compactionTrigger/shouldCompact.js`:

```javascript
// Pure decision core (design §3.2). NO imports, NO IO — the wiring
// layer (CompactionTrigger) supplies usage/threshold/state and owns the
// adapter rail, side-effect log, observable bus, and the per-runtime
// boundary-gate. Mirrors the claudeAuthPreflight / eventNarration
// pure-core discipline (decision-table + purity + frozen-throw tested).

export const REASONS = (() => {
  const o = {
    SIGNAL_UNTRUSTWORTHY: 'signal-untrustworthy',
    NO_SIGNAL: 'no-signal',
    GATED_IN_FLIGHT: 'gated-in-flight',
    RETRY: 'retry',
    GIVING_UP_SURFACED: 'giving-up-surfaced',
    THRESHOLD_CROSSED: 'threshold-crossed',
    BELOW_THRESHOLD: 'below-threshold',
  };
  return Object.freeze(o);
})();

// Strict numeric guard — same discipline as B's computeContextUsage:
// never coerces ("0.7" → null, NaN → null).
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {object} a
 * @param {{percentage:?number, stale?:boolean, source?:string}} a.usage  B's getContextUsage result
 * @param {number} a.threshold  fraction in (0,1], e.g. 0.70
 * @param {{gateArmed:boolean, lastFireAt:number, retriesRemaining:number, cooldownMs:number}} a.state  per-runtime trigger state
 * @param {number} a.now  epoch ms
 * @returns {{trigger:boolean, reason:string}}  reason ∈ REASONS
 */
export function shouldCompact(/* a */) {
  // Filled in Task 2.
  return { trigger: false, reason: REASONS.BELOW_THRESHOLD };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.purity.test.js`
Expected: PASS (3/3). If the frozen-throw test fails, the IIFE must `Object.freeze` the object (do not weaken the test).

---

## Task 2: `shouldCompact` decision table

**Files:**
- Modify: `src/runtime/compactionTrigger/shouldCompact.js`
- Create: `test/compactionTrigger.shouldCompact.test.js`

- [ ] **Step 1: Write the failing decision-table test**

Create `test/compactionTrigger.shouldCompact.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldCompact, REASONS } from '../src/runtime/compactionTrigger/shouldCompact.js';

const NOW = 1_000_000;
const COOLDOWN = 120_000;
// A fresh, un-armed runtime state.
const idle = () => ({ gateArmed: false, lastFireAt: 0, retriesRemaining: 0, cooldownMs: COOLDOWN });
// An armed state that fired `firedAgo` ms ago with `retries` budget left.
const armed = (firedAgo, retries) => ({ gateArmed: true, lastFireAt: NOW - firedAgo, retriesRemaining: retries, cooldownMs: COOLDOWN });

test('#1 stale signal → no fire (honest-degradation)', () => {
  const r = shouldCompact({ usage: { percentage: 0.99, stale: true, source: 'claude' }, threshold: 0.7, state: idle(), now: NOW });
  assert.deepEqual(r, { trigger: false, reason: REASONS.SIGNAL_UNTRUSTWORTHY });
});

test('#1 source:unknown (covers non-Claude via B degraded contract) → no fire', () => {
  const r = shouldCompact({ usage: { percentage: 0.99, stale: false, source: 'unknown' }, threshold: 0.7, state: idle(), now: NOW });
  assert.deepEqual(r, { trigger: false, reason: REASONS.SIGNAL_UNTRUSTWORTHY });
});

test('#2 missing/non-finite percentage → no fire (strict, no coercion)', () => {
  for (const p of [null, undefined, NaN, '0.9']) {
    const r = shouldCompact({ usage: { percentage: p, stale: false, source: 'claude' }, threshold: 0.7, state: idle(), now: NOW });
    assert.deepEqual(r, { trigger: false, reason: REASONS.NO_SIGNAL }, `percentage=${String(p)}`);
  }
});

test('#3 gated and within cooldown → no fire', () => {
  const r = shouldCompact({ usage: { percentage: 0.99, stale: false, source: 'claude' }, threshold: 0.7, state: armed(10_000, 2), now: NOW });
  assert.deepEqual(r, { trigger: false, reason: REASONS.GATED_IN_FLIGHT });
});

test('#4 gated, cooldown elapsed, retries remaining → retry fire', () => {
  const r = shouldCompact({ usage: { percentage: 0.99, stale: false, source: 'claude' }, threshold: 0.7, state: armed(COOLDOWN + 1, 2), now: NOW });
  assert.deepEqual(r, { trigger: true, reason: REASONS.RETRY });
});

test('#5 gated, cooldown elapsed, retries exhausted → give-up (surfaced)', () => {
  const r = shouldCompact({ usage: { percentage: 0.99, stale: false, source: 'claude' }, threshold: 0.7, state: armed(COOLDOWN + 1, 0), now: NOW });
  assert.deepEqual(r, { trigger: false, reason: REASONS.GIVING_UP_SURFACED });
});

test('#6 not gated, at/over threshold → threshold-crossed fire', () => {
  assert.deepEqual(
    shouldCompact({ usage: { percentage: 0.70, stale: false, source: 'claude' }, threshold: 0.7, state: idle(), now: NOW }),
    { trigger: true, reason: REASONS.THRESHOLD_CROSSED },
  );
  assert.deepEqual(
    shouldCompact({ usage: { percentage: 0.85, stale: false, source: 'anthropic' }, threshold: 0.7, state: idle(), now: NOW }),
    { trigger: true, reason: REASONS.THRESHOLD_CROSSED },
  );
});

test('#7 not gated, below threshold → no fire', () => {
  const r = shouldCompact({ usage: { percentage: 0.69, stale: false, source: 'claude' }, threshold: 0.7, state: idle(), now: NOW });
  assert.deepEqual(r, { trigger: false, reason: REASONS.BELOW_THRESHOLD });
});

test('branch order: stale wins over an otherwise-fireable threshold cross', () => {
  const r = shouldCompact({ usage: { percentage: 0.99, stale: true, source: 'claude' }, threshold: 0.7, state: idle(), now: NOW });
  assert.equal(r.reason, REASONS.SIGNAL_UNTRUSTWORTHY);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.shouldCompact.test.js`
Expected: FAIL (skeleton always returns BELOW_THRESHOLD).

- [ ] **Step 3: Implement the decision table**

Replace the `shouldCompact` body in `src/runtime/compactionTrigger/shouldCompact.js`:

```javascript
export function shouldCompact({ usage, threshold, state, now } = {}) {
  const u = usage || {};
  // #1 — never act on a signal we cannot substantiate. `source:'unknown'`
  // is ALSO how B reports a non-Claude/degraded runtime, so this single
  // branch subsumes the spec's "non-Claude → no fire" (grounding note).
  if (u.stale === true || u.source === 'unknown') {
    return { trigger: false, reason: REASONS.SIGNAL_UNTRUSTWORTHY };
  }
  // #2 — strict: a missing/non-finite percentage is no signal, not 0.
  const pct = num(u.percentage);
  if (pct === null) {
    return { trigger: false, reason: REASONS.NO_SIGNAL };
  }
  const st = state || {};
  if (st.gateArmed === true) {
    const cooledFor = now - st.lastFireAt;
    // #3 — a /compact is in flight and the cooldown has not elapsed.
    if (cooledFor < st.cooldownMs) {
      return { trigger: false, reason: REASONS.GATED_IN_FLIGHT };
    }
    // #4 — cooldown elapsed with no compact_boundary, budget remains.
    if (st.retriesRemaining > 0) {
      return { trigger: true, reason: REASONS.RETRY };
    }
    // #5 — budget exhausted: give up (wiring surfaces this once).
    return { trigger: false, reason: REASONS.GIVING_UP_SURFACED };
  }
  // #6 — fresh cross.
  if (pct >= threshold) {
    return { trigger: true, reason: REASONS.THRESHOLD_CROSSED };
  }
  // #7
  return { trigger: false, reason: REASONS.BELOW_THRESHOLD };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.shouldCompact.test.js`
Expected: PASS (all cases). Re-run `test/compactionTrigger.purity.test.js` — still PASS.

---

## Task 3: `index.js` re-export + wire Commit-1 suites + **Commit 1**

**Files:**
- Create: `src/runtime/compactionTrigger/index.js`
- Modify: `package.json`

- [ ] **Step 1: Create the index (only what exists in Commit 1)**

Create `src/runtime/compactionTrigger/index.js`:

```javascript
// Commit 1 surface only. CompactionTrigger is added to this re-export
// in Commit 2 (Task 9). An ESM `export … from './CompactionTrigger.js'`
// for a not-yet-created module is a load-time error — do NOT add it now.
export { shouldCompact, REASONS } from './shouldCompact.js';
```

- [ ] **Step 2: Add an index smoke test line**

Append to `test/compactionTrigger.purity.test.js`:

```javascript
import { shouldCompact as sc2, REASONS as R2 } from '../src/runtime/compactionTrigger/index.js';
test('index.js re-exports shouldCompact + REASONS', () => {
  assert.equal(typeof sc2, 'function');
  assert.equal(R2.THRESHOLD_CROSSED, 'threshold-crossed');
});
```

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.purity.test.js`
Expected: PASS.

- [ ] **Step 3: Wire the two Commit-1 suites into `scripts.test`**

In `package.json`, append to the end of the `scripts.test` string (before the closing `"`):

```
 && node --no-warnings --test test/compactionTrigger.shouldCompact.test.js && node --no-warnings --test test/compactionTrigger.purity.test.js
```

Validate JSON: `cd /c/Project-TOAD/toad-local && node -e "const t=require('./package.json').scripts.test; console.log('JSON OK', t.includes('compactionTrigger.shouldCompact'), t.includes('compactionTrigger.purity'))"`
Expected: `JSON OK true true`.

- [ ] **Step 4: Full root suite — fail 0, new suites executed**

Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -E "^# (pass|fail)" | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0`. Then confirm the new suites actually ran (un-wired-test trap):
Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -cE "branch order: stale wins|REASONS is sealed"`
Expected: ≥ `2`.

- [ ] **Step 5: Commit 1**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/compactionTrigger/shouldCompact.js toad-local/src/runtime/compactionTrigger/index.js toad-local/test/compactionTrigger.shouldCompact.test.js toad-local/test/compactionTrigger.purity.test.js toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
feat(compaction): pure shouldCompact decision core (Sub-project C, Layer A)

Sealed REASONS (frozen-throw) + ordered 7-branch decision table for
proactive Claude compaction: honest-degradation on stale/source:unknown
(the latter ALSO subsumes non-Claude via B's degraded contract — no
bespoke provider detector), strict no-coercion percentage guard,
boundary-gate (in-flight suppression + bounded retry + give-up) before
a fresh threshold cross. Zero imports (purity-guarded); decision-table
+ frozen-throw tested; suites wired into the npm chain. Root fail 0.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `CompactionTrigger` — threshold-cross fire (happy path)

**Files:**
- Create: `src/runtime/compactionTrigger/CompactionTrigger.js`
- Create: `test/compactionTrigger.test.js`

- [ ] **Step 1: Write the failing wiring test**

Create `test/compactionTrigger.test.js`:

```javascript
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CompactionTrigger } from '../src/runtime/compactionTrigger/CompactionTrigger.js';

const RUNTIME_ID = 'rt-1', TEAM_ID = 'team-a', AGENT_ID = 'lead';

function mockAdapter() {
  const turns = [];
  return { turns, sendTurn(i) { turns.push(i); return Promise.resolve({ accepted: true }); } };
}
function mockSideEffectLog() {
  const records = new Map();
  return {
    records,
    markPending({ idempotencyKey, kind, runtimeId, deliveryId }) {
      if (!records.has(idempotencyKey)) records.set(idempotencyKey, { idempotencyKey, kind, runtimeId, deliveryId, status: 'pending' });
    },
    markDelivered(k) { const r = records.get(k); if (r) r.status = 'delivered'; },
    markFailed(k) { const r = records.get(k); if (r) r.status = 'failed'; },
  };
}
function mockBus() {
  const events = [];
  return { events, emit(channel, payload) { events.push({ channel, payload }); } };
}
const evt = (type, over = {}) => ({ type, runtimeId: RUNTIME_ID, teamId: TEAM_ID, agentId: AGENT_ID, createdAt: '2026-05-16T00:00:00.000Z', ...over });

describe('CompactionTrigger — threshold-cross fire', () => {
  let adapters, adapter, sideEffectLog, eventBus, getContextUsage, getThreshold, trig;
  beforeEach(() => {
    adapter = mockAdapter();
    adapters = new Map([[RUNTIME_ID, adapter]]);
    sideEffectLog = mockSideEffectLog();
    eventBus = mockBus();
    getContextUsage = () => ({ percentage: 0.82, stale: false, source: 'claude', provider: 'claude' });
    getThreshold = async () => 0.70;
    trig = new CompactionTrigger({
      adapters, sideEffectLog, eventBus,
      getContextUsage, getThreshold,
      now: () => 1_000_000,
    });
  });

  it('sends exactly one /compact at idle when over threshold, logs side-effect, emits observable', async () => {
    await trig.onTurnCompleted(evt('turn_completed'));
    assert.equal(adapter.turns.length, 1, 'one /compact');
    assert.equal(adapter.turns[0].message.text, '/compact');
    assert.equal(adapter.turns[0].message.metadata.source, 'compaction_trigger');
    const recs = [...sideEffectLog.records.values()];
    assert.equal(recs.length, 1);
    assert.equal(recs[0].kind, 'compaction_trigger');
    assert.equal(recs[0].status, 'delivered');
    const fired = eventBus.events.filter((e) => e.channel === 'runtime_event' && e.payload.type === 'compaction_triggered');
    assert.equal(fired.length, 1);
    assert.equal(fired[0].payload.runtimeId, RUNTIME_ID);
  });

  it('does not fire a second /compact while gated (in-flight)', async () => {
    await trig.onTurnCompleted(evt('turn_completed'));
    await trig.onTurnCompleted(evt('turn_completed'));
    assert.equal(adapter.turns.length, 1, 'still one — gated');
  });

  it('does not fire when below threshold', async () => {
    getContextUsage = () => ({ percentage: 0.40, stale: false, source: 'claude' });
    trig = new CompactionTrigger({ adapters, sideEffectLog, eventBus, getContextUsage, getThreshold, now: () => 1_000_000 });
    await trig.onTurnCompleted(evt('turn_completed'));
    assert.equal(adapter.turns.length, 0);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.test.js`
Expected: FAIL — `Cannot find module '.../CompactionTrigger.js'`.

- [ ] **Step 3: Implement the handler (fire path only; gate fields present)**

Create `src/runtime/compactionTrigger/CompactionTrigger.js`:

```javascript
import { shouldCompact, REASONS } from './shouldCompact.js';

const DEFAULT_THRESHOLD = 0.70;
const DEFAULT_COOLDOWN_MS = 120_000;   // grounded default; injectable — run-and-tighten per executor Notes
const DEFAULT_RETRY_BUDGET = 2;        // 1 initial + ≤2 retries = ≤3 attempts

/**
 * Proactive compaction trigger — the wiring sibling of CompactionHandler
 * (which is untouched and owns POST-compaction reinjection). All IO is
 * injected for hermetic tests. Reads B's getContextUsage, asks the pure
 * shouldCompact() core, and on `trigger` sends `/compact` over the same
 * adapter.sendTurn rail CompactionHandler uses, surfacing via
 * sideEffectLog + the existing runtime_event bus.
 */
export class CompactionTrigger {
  /** @type {Map<string,{gateArmed:boolean,lastFireAt:number,retriesRemaining:number,cooldownMs:number,surfacedGiveUp:boolean}>} */
  #perRuntime = new Map();

  constructor({
    adapters,
    sideEffectLog = null,
    eventBus = null,
    getContextUsage,
    getThreshold = null,
    cooldownMs = DEFAULT_COOLDOWN_MS,
    retryBudget = DEFAULT_RETRY_BUDGET,
    now = () => Date.now(),
  }) {
    this.adapters = adapters;
    this.sideEffectLog = sideEffectLog;
    this.eventBus = eventBus;
    this.getContextUsage = getContextUsage;
    this.getThreshold = getThreshold;
    this.cooldownMs = cooldownMs;
    this.retryBudget = retryBudget;
    this.now = now;
  }

  #state(runtimeId) {
    let s = this.#perRuntime.get(runtimeId);
    if (!s) {
      s = { gateArmed: false, lastFireAt: 0, retriesRemaining: 0, cooldownMs: this.cooldownMs, surfacedGiveUp: false };
      this.#perRuntime.set(runtimeId, s);
    }
    return s;
  }

  isGated(runtimeId) {
    return this.#perRuntime.get(runtimeId)?.gateArmed === true;
  }

  async onTurnCompleted(event) {
    if (!event || !event.runtimeId) return;
    const state = this.#state(event.runtimeId);
    const usage = this.getContextUsage(event.agentId, { teamId: event.teamId });
    const threshold = this.getThreshold ? await this.getThreshold() : DEFAULT_THRESHOLD;
    const verdict = shouldCompact({ usage, threshold, state, now: this.now() });

    if (verdict.reason === REASONS.GIVING_UP_SURFACED && !state.surfacedGiveUp) {
      state.surfacedGiveUp = true;
      this.#emit('compaction_not_taking', event, { threshold });
      return;
    }
    if (!verdict.trigger) return;

    const isRetry = verdict.reason === REASONS.RETRY;
    await this.#fireCompact(event, usage, threshold, isRetry);
  }

  async #fireCompact(event, usage, threshold, isRetry) {
    const adapter = this.adapters?.get?.(event.runtimeId);
    if (!adapter || typeof adapter.sendTurn !== 'function') return;
    const state = this.#state(event.runtimeId);
    const idempotencyKey = `compaction-trigger:${event.runtimeId}:${this.now()}`;

    if (this.sideEffectLog) {
      this.sideEffectLog.markPending({ deliveryId: idempotencyKey, idempotencyKey, kind: 'compaction_trigger', runtimeId: event.runtimeId });
    }
    try {
      await adapter.sendTurn({
        message: {
          messageId: `compact-trigger-${event.runtimeId}-${this.now()}`,
          text: '/compact',
          metadata: { source: 'compaction_trigger', type: 'proactive_compaction' },
        },
      });
      if (this.sideEffectLog) this.sideEffectLog.markDelivered(idempotencyKey);
      // Arm / re-arm the gate.
      state.gateArmed = true;
      state.lastFireAt = this.now();
      if (isRetry) state.retriesRemaining = Math.max(0, state.retriesRemaining - 1);
      else state.retriesRemaining = this.retryBudget;
      this.#emit('compaction_triggered', event, {
        percentage: usage.percentage, threshold, retry: isRetry,
      });
    } catch {
      if (this.sideEffectLog) this.sideEffectLog.markFailed(idempotencyKey);
      // Still arm the gate: a failed send must not hot-loop next turn.
      state.gateArmed = true;
      state.lastFireAt = this.now();
      if (isRetry) state.retriesRemaining = Math.max(0, state.retriesRemaining - 1);
      else state.retriesRemaining = this.retryBudget;
    }
  }

  #emit(type, event, extra) {
    if (!this.eventBus || typeof this.eventBus.emit !== 'function') return;
    this.eventBus.emit('runtime_event', {
      type,
      runtimeId: event.runtimeId,
      teamId: event.teamId,
      agentId: event.agentId,
      ...extra,
      createdAt: new Date().toISOString(),
    });
  }

  // onCompactBoundary / onTurnFailed — Task 5 / Task 6.
  onCompactBoundary() {}
  onTurnFailed() {}
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.test.js`
Expected: PASS (3/3 in this describe block).

---

## Task 5: Boundary-gate clear + bounded retry + give-up surface

**Files:**
- Modify: `src/runtime/compactionTrigger/CompactionTrigger.js`
- Modify: `test/compactionTrigger.test.js`

- [ ] **Step 1: Write the failing tests** — append to `test/compactionTrigger.test.js`:

```javascript
describe('CompactionTrigger — gate / retry / give-up', () => {
  let adapters, adapter, sideEffectLog, eventBus, clock, trig;
  beforeEach(() => {
    adapter = mockAdapter();
    adapters = new Map([[RUNTIME_ID, adapter]]);
    sideEffectLog = mockSideEffectLog();
    eventBus = mockBus();
    clock = { t: 1_000_000 };
    trig = new CompactionTrigger({
      adapters, sideEffectLog, eventBus,
      getContextUsage: () => ({ percentage: 0.95, stale: false, source: 'claude' }),
      getThreshold: async () => 0.70,
      cooldownMs: 100, retryBudget: 2,
      now: () => clock.t,
    });
  });

  it('compact_boundary clears the gate so a later cross can fire again', async () => {
    await trig.onTurnCompleted(evt('turn_completed'));      // fire #1
    assert.equal(adapter.turns.length, 1);
    assert.equal(trig.isGated(RUNTIME_ID), true);
    trig.onCompactBoundary(evt('compact_boundary'));
    assert.equal(trig.isGated(RUNTIME_ID), false);
    clock.t += 1;
    await trig.onTurnCompleted(evt('turn_completed'));      // fresh cross fires again
    assert.equal(adapter.turns.length, 2);
  });

  it('bounded retry then exactly one surfaced give-up then silence', async () => {
    await trig.onTurnCompleted(evt('turn_completed'));      // initial fire (budget=2)
    clock.t += 101;
    await trig.onTurnCompleted(evt('turn_completed'));      // retry 1 (budget→1)
    clock.t += 101;
    await trig.onTurnCompleted(evt('turn_completed'));      // retry 2 (budget→0)
    assert.equal(adapter.turns.length, 3, '1 initial + 2 retries = 3');
    clock.t += 101;
    await trig.onTurnCompleted(evt('turn_completed'));      // give-up: no send, one surface
    assert.equal(adapter.turns.length, 3, 'no 4th send');
    const giveUps = eventBus.events.filter((e) => e.payload.type === 'compaction_not_taking');
    assert.equal(giveUps.length, 1);
    clock.t += 101;
    await trig.onTurnCompleted(evt('turn_completed'));      // still silent, no duplicate surface
    assert.equal(eventBus.events.filter((e) => e.payload.type === 'compaction_not_taking').length, 1);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.test.js`
Expected: FAIL — `onCompactBoundary` is a no-op so the gate never clears (test 1 fails at the re-fire).

- [ ] **Step 3: Implement boundary clear**

Replace the `onCompactBoundary()` stub in `src/runtime/compactionTrigger/CompactionTrigger.js`:

```javascript
  onCompactBoundary(event) {
    if (!event || !event.runtimeId) return;
    const s = this.#perRuntime.get(event.runtimeId);
    if (!s) return;
    // Confirmed: the /compact took. Disarm + reset the episode.
    s.gateArmed = false;
    s.lastFireAt = 0;
    s.retriesRemaining = 0;
    s.surfacedGiveUp = false;
  }
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.test.js`
Expected: PASS (both new tests + the Task-4 block). The retry/give-up test already passes because Task-4's `onTurnCompleted` routes `REASONS.RETRY` → fire and `REASONS.GIVING_UP_SURFACED` → one-time surface; if it fails, fix the handler, never the test.

---

## Task 6: `onTurnFailed` cleanup + stale / non-Claude no-fire

**Files:**
- Modify: `src/runtime/compactionTrigger/CompactionTrigger.js`
- Modify: `test/compactionTrigger.test.js`

- [ ] **Step 1: Write the failing tests** — append to `test/compactionTrigger.test.js`:

```javascript
describe('CompactionTrigger — cleanup + honest-degradation', () => {
  let adapters, adapter, trig;
  beforeEach(() => {
    adapter = mockAdapter();
    adapters = new Map([[RUNTIME_ID, adapter]]);
  });

  it('stale signal never sends', async () => {
    trig = new CompactionTrigger({ adapters, getContextUsage: () => ({ percentage: 0.99, stale: true, source: 'claude' }), getThreshold: async () => 0.7, now: () => 1 });
    await trig.onTurnCompleted(evt('turn_completed'));
    assert.equal(adapter.turns.length, 0);
  });

  it('non-Claude (B degraded source:unknown) never sends', async () => {
    trig = new CompactionTrigger({ adapters, getContextUsage: () => ({ percentage: 0.99, stale: false, source: 'unknown', provider: 'codex' }), getThreshold: async () => 0.7, now: () => 1 });
    await trig.onTurnCompleted(evt('turn_completed'));
    assert.equal(adapter.turns.length, 0);
  });

  it('onTurnFailed drops per-runtime state (no leak / re-arm)', async () => {
    trig = new CompactionTrigger({ adapters, getContextUsage: () => ({ percentage: 0.99, stale: false, source: 'claude' }), getThreshold: async () => 0.7, cooldownMs: 100, now: () => 1 });
    await trig.onTurnCompleted(evt('turn_completed'));
    assert.equal(trig.isGated(RUNTIME_ID), true);
    trig.onTurnFailed(evt('turn_failed'));
    assert.equal(trig.isGated(RUNTIME_ID), false, 'state dropped');
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.test.js`
Expected: FAIL — `onTurnFailed` is a no-op so the gated state survives (the cleanup test fails). (The stale / non-Claude tests already pass via the pure core — keep them; they pin the honest-degradation contract.)

- [ ] **Step 3: Implement cleanup**

Replace the `onTurnFailed()` stub in `src/runtime/compactionTrigger/CompactionTrigger.js`:

```javascript
  onTurnFailed(event) {
    if (!event || !event.runtimeId) return;
    this.#perRuntime.delete(event.runtimeId);
  }
```

Add a runtime-end cleanup method (used by the wiring in Task 9 if a runtime stops):

```javascript
  forget(runtimeId) {
    this.#perRuntime.delete(runtimeId);
  }
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.test.js`
Expected: PASS (all describe blocks).

---

## Task 7: Default async `getThreshold` from `SettingsStore`

**Files:**
- Modify: `src/runtime/compactionTrigger/CompactionTrigger.js`
- Modify: `test/compactionTrigger.test.js`

> Grounded: `SettingsStore.readEffective()` is **async** and section-based; there is no `compaction` section today — C introduces `{ compaction: { claude: { threshold: <0..1> } } }`. The pure core stays sync (plain number); this async read is the injected wiring IO.

- [ ] **Step 1: Write the failing test** — append to `test/compactionTrigger.test.js`:

```javascript
import { resolveThresholdFromSettings } from '../src/runtime/compactionTrigger/CompactionTrigger.js';

describe('resolveThresholdFromSettings', () => {
  it('returns project compaction.claude.threshold when set', async () => {
    const store = { readEffective: async () => ({ compaction: { claude: { threshold: 0.6 } } }) };
    assert.equal(await resolveThresholdFromSettings(store), 0.6);
  });
  it('falls back to 0.70 when section/key absent or non-finite or store missing', async () => {
    assert.equal(await resolveThresholdFromSettings({ readEffective: async () => ({}) }), 0.70);
    assert.equal(await resolveThresholdFromSettings({ readEffective: async () => ({ compaction: { claude: { threshold: 'x' } } }) }), 0.70);
    assert.equal(await resolveThresholdFromSettings(null), 0.70);
    assert.equal(await resolveThresholdFromSettings({ readEffective: async () => { throw new Error('io'); } }), 0.70);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.test.js`
Expected: FAIL — `resolveThresholdFromSettings` is not exported.

- [ ] **Step 3: Implement** — add to `src/runtime/compactionTrigger/CompactionTrigger.js` (top-level export, below the constants):

```javascript
/**
 * Resolve the Claude compaction threshold from SettingsStore. New
 * `compaction` section: { compaction: { claude: { threshold: <0..1> } } }.
 * Always returns a finite fraction; defaults to 0.70 on any
 * miss/non-finite/IO error (never throws — honest default).
 */
export async function resolveThresholdFromSettings(settingsStore) {
  try {
    if (!settingsStore || typeof settingsStore.readEffective !== 'function') return DEFAULT_THRESHOLD;
    const eff = await settingsStore.readEffective();
    const t = eff && eff.compaction && eff.compaction.claude ? eff.compaction.claude.threshold : undefined;
    return typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= 1 ? t : DEFAULT_THRESHOLD;
  } catch {
    return DEFAULT_THRESHOLD;
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.test.js`
Expected: PASS (all blocks).

---

## Task 8: Wire `CompactionTrigger` into `RuntimeEventIngestor` dispatch

**Files:**
- Modify: `src/runtime/RuntimeEventIngestor.js`
- Create: `test/runtimeEventIngestor.compactionTrigger.test.js`

- [ ] **Step 1: Write the failing dispatch test**

Create `test/runtimeEventIngestor.compactionTrigger.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeEventIngestor } from '../src/runtime/RuntimeEventIngestor.js';

function calls() {
  const c = { boundary: 0, completed: 0, failed: 0 };
  return {
    c,
    onCompactBoundary() { c.boundary += 1; },
    onTurnCompleted() { c.completed += 1; return Promise.resolve(); },
    onTurnFailed() { c.failed += 1; },
  };
}
const broker = { appendMessage: () => ({ message: { id: 'm' } }) };
const baseEvent = (type) => ({ type, runtimeId: 'rt-1', teamId: 't', agentId: 'a', createdAt: '2026-05-16T00:00:00.000Z' });

test('ingestor routes turn_completed/compact_boundary/turn_failed to compactionTrigger', async () => {
  const trig = calls();
  const ing = new RuntimeEventIngestor({ broker, compactionTrigger: trig });
  await ing.ingest(baseEvent('turn_completed'));
  await ing.ingest(baseEvent('compact_boundary'));
  await ing.ingest(baseEvent('turn_failed'));
  assert.deepEqual(trig.c, { boundary: 1, completed: 1, failed: 1 });
});

test('compactionTrigger is optional — absent does not break ingest', async () => {
  const ing = new RuntimeEventIngestor({ broker });
  await ing.ingest(baseEvent('turn_completed'));   // must not throw
  assert.ok(true);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/runtimeEventIngestor.compactionTrigger.test.js`
Expected: FAIL — `compactionTrigger` is neither a constructor param nor dispatched (counts stay 0).

- [ ] **Step 3: Implement the ingestor wiring**

In `src/runtime/RuntimeEventIngestor.js` constructor destructuring (the block containing `compactionHandler = null,`), add directly below it:

```javascript
    compactionTrigger = null,
```

In the constructor body (next to `this.compactionHandler = compactionHandler;`) add:

```javascript
    this.compactionTrigger = compactionTrigger;
```

Replace `#dispatchCompactionLifecycle(event)` with (additive — `compactionHandler` behavior unchanged):

```javascript
  #dispatchCompactionLifecycle(event) {
    if (event.type === 'compact_boundary') {
      if (this.compactionHandler) this.compactionHandler.onCompactBoundary(event);
      if (this.compactionTrigger) this.compactionTrigger.onCompactBoundary(event);
    } else if (event.type === 'turn_completed') {
      if (this.compactionHandler) void this.compactionHandler.onTurnCompleted(event);
      if (this.compactionTrigger) void this.compactionTrigger.onTurnCompleted(event);
    } else if (event.type === 'turn_failed') {
      if (this.compactionHandler) this.compactionHandler.onTurnFailed(event);
      if (this.compactionTrigger) this.compactionTrigger.onTurnFailed(event);
    }
  }
```

> Note: the original early-returned `if (!this.compactionHandler) return;`. The rewrite drops that guard so a configured `compactionTrigger` is dispatched even when no `compactionHandler` is set; each call is individually null-guarded. `void` keeps `onTurnCompleted` fire-and-forget exactly as before.

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/runtimeEventIngestor.compactionTrigger.test.js`
Expected: PASS (2/2).

- [ ] **Step 5: Existing ingestor suite stays green**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/runtimeEventIngestor.test.js 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`. Fix code on regression, never weaken a test.

---

## Task 9: Construct `CompactionTrigger` in `LocalToadRuntime`

**Files:**
- Modify: `src/app/LocalToadRuntime.js`

- [ ] **Step 1: Write the failing construction test**

Create `test/localToadRuntime.compactionTrigger.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';

test('LocalToadRuntime constructs a CompactionTrigger and passes it to the ingestor', () => {
  const rt = new LocalToadRuntime();
  assert.ok(rt.compactionTrigger, 'compactionTrigger present');
  assert.equal(typeof rt.compactionTrigger.onTurnCompleted, 'function');
  assert.equal(typeof rt.compactionTrigger.onCompactBoundary, 'function');
  // Wired into the ingestor (same instance).
  assert.equal(rt.eventIngestor?.compactionTrigger, rt.compactionTrigger);
});
```

> If `rt.eventIngestor` is not a public field, assert only the first three lines and add a comment; do not invent a getter. Confirm the actual field name the ingestor is stored under in `LocalToadRuntime` at implementation time (grounded: `new RuntimeEventIngestor({...})` is assigned ≈L297 — read the exact `this.<name> =`).

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.compactionTrigger.test.js`
Expected: FAIL — `rt.compactionTrigger` is undefined.

- [ ] **Step 3: Implement the construction + wiring**

In `src/app/LocalToadRuntime.js`, add the import near the other runtime imports (next to `import { CompactionHandler } from '../runtime/CompactionHandler.js';`):

```javascript
import { CompactionTrigger, resolveThresholdFromSettings } from '../runtime/compactionTrigger/index.js';
import { getContextUsage } from '../runtime/contextUsage/index.js';
```

Extend `src/runtime/compactionTrigger/index.js` to its final form:

```javascript
export { shouldCompact, REASONS } from './shouldCompact.js';
export { CompactionTrigger, resolveThresholdFromSettings } from './CompactionTrigger.js';
```

Immediately **after** `this.eventBus = new RuntimeEventBus();` (≈L271 — eventBus must exist first) and **before** the `new RuntimeEventIngestor({...})` block, insert:

```javascript
    this.compactionTrigger = new CompactionTrigger({
      adapters,
      sideEffectLog: this.sideEffectLog,
      eventBus: this.eventBus,
      getContextUsage: (agentId, opts) => getContextUsage(agentId, {
        ...opts,
        runtimeRegistry: this.runtimeRegistry,
        eventLog: this.eventLog,
      }),
      getThreshold: () => resolveThresholdFromSettings(this.settingsStore),
    });
```

In the `new RuntimeEventIngestor({ ... })` argument object (the block with `compactionHandler: this.compactionHandler,`), add directly below that line:

```javascript
        compactionTrigger: this.compactionTrigger,
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.compactionTrigger.test.js`
Expected: PASS. (If the ingestor field-name assertion fails, correct the test's field name to the grounded actual name — do not weaken the construction assertions.)

- [ ] **Step 5: Existing LocalToadRuntime suite stays green**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/localToadRuntime.test.js 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`. The addition is purely additive (a new collaborator + one ingestor arg); a regression means a real wiring bug — fix code, not the test.

---

## Task 10: Wire Commit-2 suites + full gates + **Commit 2**

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Wire the three Commit-2 suites into `scripts.test`**

In `package.json`, append to the end of the `scripts.test` string (before the closing `"`):

```
 && node --no-warnings --test test/compactionTrigger.test.js && node --no-warnings --test test/runtimeEventIngestor.compactionTrigger.test.js && node --no-warnings --test test/localToadRuntime.compactionTrigger.test.js
```

Validate JSON: `cd /c/Project-TOAD/toad-local && node -e "const t=require('./package.json').scripts.test; console.log(['compactionTrigger.test','runtimeEventIngestor.compactionTrigger','localToadRuntime.compactionTrigger'].every(s=>t.includes(s)))"`
Expected: `true`.

- [ ] **Step 2: Full root suite — fail 0, all five new suites executed**

Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -E "^# (pass|fail)" | awk '{a[$2]+=$3} END{for(k in a)print k,a[k]}'`
Expected: `fail 0`.

Confirm every new suite actually executed (un-wired-test false-green trap):
Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -cE "branch order: stale wins|REASONS is sealed|threshold-cross fire|routes turn_completed/compact_boundary|constructs a CompactionTrigger"`
Expected: ≥ `5`.

- [ ] **Step 3: UI gate**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run typecheck 2>&1 | grep -E "error TS" || echo CLEAN` → `CLEAN`
Run: `cd /c/Project-TOAD/toad-local/ui && npm run build 2>&1 | tail -2` → ends `✓ built`.
(UI is not modified by this plan — this gate proves the event/data-contract addition broke nothing downstream.)

- [ ] **Step 4: Whole-implementation review (pre-commit gate)**

Review the entire Commit-2 surface as one unit (the gate that caught the auth Critical): seam-contract coherence (`getContextUsage` shape ↔ pure core ↔ wiring ↔ adapter rail), no inert wiring (the ingestor actually dispatches `compactionTrigger`; `LocalToadRuntime` actually constructs it after `eventBus`), no lying/tautological tests, the new suites genuinely execute under `npm test`, additive-only to `RuntimeEventIngestor`/`LocalToadRuntime` (existing suites green), index.js exports only modules that exist. Resolve any finding before committing.

- [ ] **Step 5: Commit 2**

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/compactionTrigger/CompactionTrigger.js toad-local/src/runtime/compactionTrigger/index.js toad-local/src/runtime/RuntimeEventIngestor.js toad-local/src/app/LocalToadRuntime.js toad-local/test/compactionTrigger.test.js toad-local/test/runtimeEventIngestor.compactionTrigger.test.js toad-local/test/localToadRuntime.compactionTrigger.test.js toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
feat(compaction): proactive Claude /compact trigger wiring (Sub-project C, Layer B)

CompactionTrigger — the wiring sibling of the untouched reactive
CompactionHandler. On the RuntimeEventIngestor compaction-lifecycle
dispatch it reads B's getContextUsage, asks the pure shouldCompact()
core, and at idle sends /compact over the existing adapter.sendTurn
rail when a Claude agent crosses the (per-project, default 0.70)
threshold — before the CLI's too-late ~85% auto-compaction. Boundary-
gated + bounded retry (≤3 attempts) with one explicit surfaced
"compaction not taking"; honest-degradation on stale/non-Claude
(B's degraded source:unknown). Side-effect + runtime_event surfaced;
no new bus; no CompactionHandler/reinjection change. Root fail 0;
UI tsc/build green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -3
```

- [ ] **Step 6: Post-commit verify**

`git -C /c/Project-TOAD show --stat HEAD` — exactly the eight listed files, no stray. `git -C /c/Project-TOAD status --porcelain` — clean of all plan/feature files (only pre-existing unrelated untracked dirs remain). HEAD~1 = Commit 1.

---

## Notes for the executor (grounded pins — do not pre-invent; confirm against code)

- **Claude detection is free.** Do **not** add a provider/`isClaudeCommand`-style detector. B's `getContextUsage` returns `source:'unknown'` for any non-Claude/degraded runtime; the pure core branch #1 no-fires on that. (Spec §3.3/§6 #1 satisfied via B's contract — recorded so a reviewer does not "restore the missing detector".)
- **`COMPACT_COOLDOWN_MS` (default 120_000) / `RETRY_BUDGET` (2):** run-and-tighten against the real `compact_boundary` latency during implementation (mirroring the auth `RELAUNCH_GUARD_MS` discipline); the constants are injectable so tests pin behavior independent of the literals.
- **`LocalToadRuntime` ingestor field name (Task 9 Step 1/4):** the test asserts `rt.eventIngestor?.compactionTrigger === rt.compactionTrigger`. Confirm the actual `this.<name> = new RuntimeEventIngestor(...)` field (≈L297) and use it; if the ingestor is not retained on `this`, drop that one assertion (keep the three `rt.compactionTrigger` assertions) — do not invent a getter.
- **Settings key:** `{ compaction: { claude: { threshold } } }` is a NEW top-level `SettingsStore` section; nothing writes it yet (read-only consumption here — a writer/UI is out of scope, D/E-adjacent).
- **§8d:** if any grounded fact above is wrong at implementation time, STOP and surface it (controller pre-emptive ratification), exactly as in the auth + readability cycles — do not code around a wrong plan.
