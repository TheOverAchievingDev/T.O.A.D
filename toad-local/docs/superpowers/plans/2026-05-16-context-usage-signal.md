# Sub-project B — Provider-aware context-window usage signal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the wrong, monotonic-growth Claude usage meter with a correct, provider-agnostic `getContextUsage(agentId)` that reports true context-window occupancy from the latest turn, with Codex/Gemini named-deferred slots.

**Architecture:** A new `src/runtime/contextUsage/` module owns a pure occupancy computer (latest `result.usage` snapshot, NOT Σ over turns), a single-source `MODEL_CONTEXT_WINDOW` map, and the `agentId→snapshot` resolver with empty-slot-safe deferred Codex/Gemini branches. `localToolFacade`'s `runtime_list` emits a per-runtime `contextUsage` object computed from runtime-event-log data it already loads; the UI mapper (`useToadData.ts`) and `RuntimeDrawer.tsx` are repointed to it in lockstep; lifetime `tokensIn/tokensOut/costUsd` are retained as spend telemetry. One atomic commit, §5-ordered.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, `SqliteRuntimeEventLog`/`SqliteRuntimeRegistry` (real temp-db harness), `SettingsStore`. UI: React/TS (`tsc -b`/`vite build`). Repo root `/c/Project-TOAD`; project `toad-local/`; commit to `main` via `git -C /c/Project-TOAD …`, `toad-local/`-prefixed paths, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.

**Authoritative spec:** `docs/superpowers/specs/2026-05-16-context-usage-signal-design.md` (`f7a023a`).

**Suite baseline:** root `npm test` `fail 0` (~1317); UI `tsc -b`/`vite build` green (post `6db5ce9`).

**Out of scope:** C (compaction triggers), D (routing), E (Gemini adapter); Codex/Gemini *implementation* (deferred slots only); redesigning lifetime spend telemetry.

---

## Grounded facts (the plan is built on these — verified in code)

- **Claude stream-json**: `ClaudeStreamJsonAdapter` normalizes `result/success`→`turn_completed`, `result/error`→`turn_failed`, plus `assistant_text`/`tool_use`/`compact_boundary`/`api_retry`. **There is no `turn_started` event.** Every normalized event keeps `raw: parsed` (the original frame). The `result` frame carries `usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`).
- **Event log**: `SqliteRuntimeEventLog.listEvents({ runtimeId|teamId })` → events `created_at ASC`; `#rowToEvent` exposes `{ eventId, runtimeId, teamId, agentId, eventType, sessionId, createdAt, payload }`, `payload = JSON.parse(payload_json)`; the stream-json frame is `payload.raw` (facade already reads `e.payload?.raw`, `raw.type==='result'`, `raw.usage`).
- **Registry**: `SqliteRuntimeRegistry.listRuntimes({teamId})` rows include `runtimeId`, `agentId`, `providerId`, `status`, `startedAt`. (Used to resolve an agent's current runtime.)
- **Facade**: constructor injects `runtimeRegistry`, `eventLog`, `settingsStore`. `runtime_list` handler (~L1104) + enrichment (~L2013–2110) already loops `eventLog.listEvents({teamId})`, builds `tokensByRuntime` (cumulative `+= input_tokens/output_tokens` — the Bug-1 sum), `modelByRuntime` (latest model per runtime), and returns `runtimes` enriched with `tokensIn/tokensOut/costUsd/model`.
- **UI path**: `ui/src/hooks/useToadData.ts` L379-380 passes `tokensIn/tokensOut` through; **L504-505 is the epicenter**: `tokens: (runtime?.tokensIn ?? 0) + (runtime?.tokensOut ?? 0), tokenLimit: 200_000`. `AgentCard.tsx`/`cockpit/Inspector.tsx`/`CockpitFlowCanvas.tsx` render `agent.tokens`/`agent.tokenLimit` (fixed transitively once the mapper is fixed). `RuntimeDrawer.tsx` L217/347/361 has its **own** separate `200_000`.
- **Settings**: `SettingsStore.readEffective()` → merged sections object; `settings.runtime` is a freeform section; consumers apply their own default (drift pattern: `settings.drift ?? DEFAULT`). No schema change.
- **PROJECT.md**: `### 8c.` at L283, `## 9.` at L298 — the two new invariants go between (a new `### 8d.`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/runtime/contextUsage/modelContextWindow.js` *(create)* | `MODEL_CONTEXT_WINDOW` single-source map + `resolveContextWindow(model)→number\|null` |
| `src/runtime/contextUsage/computeContextUsage.js` *(create)* | Pure: runtime's events → `{used,total,percentage,model,provider,lastUpdatedAt,stale,source}` |
| `src/runtime/contextUsage/getContextUsage.js` *(create)* | `getContextUsage(agentId, deps)` — resolve runtime, pull events, compute; Codex/Gemini deferred slots; empty-slot-safe |
| `src/runtime/contextUsage/index.js` *(create)* | Re-exports the public surface |
| `test/contextUsage.modelWindow.test.js` *(create)* | Map + resolver tests |
| `test/contextUsage.compute.test.js` *(create)* | Occupancy formula, Bug-1 regression, missing-field, source enum, staleness incl. in-flight |
| `test/contextUsage.getContextUsage.test.js` *(create)* | agentId resolution + deferred-slot/empty-slot safety |
| `test/contextUsage.facade.test.js` *(create)* | `runtime_list` emits correct per-runtime `contextUsage`; lifetime spend retained |
| `test/contextUsage.regressionGuard.test.js` *(create)* | Structural grep: no hardcoded context-window literal in `src/`/`ui/src/` |
| `src/tools/localToolFacade.js` *(modify)* | `runtime_list`: add per-runtime `contextUsage`; `tokensIn/Out/costUsd` reframed as spend-only |
| `ui/src/hooks/useToadData.ts` *(modify)* | Map `tokens`/`tokenLimit` from `runtime.contextUsage`; pass `contextUsage` through |
| `ui/src/components/RuntimeDrawer.tsx` *(modify)* | Drop own `200_000`; read `contextUsage.total` |
| `PROJECT.md` *(modify)* | New `### 8d.` — two banked invariants |
| `package.json` *(modify)* | Wire the 5 new test files into the canonical `npm test` chain |

**Commit policy:** Tasks 1–7 are additive TDD increments that **do NOT commit** (accumulate uncommitted). **Task 8** runs all gates and makes the **single atomic commit** in the §5-pinned order. (Same structure as the L3 Slice-A/B plans.)

---

## Task 1: `MODEL_CONTEXT_WINDOW` map + resolver

**Files:** Create `src/runtime/contextUsage/modelContextWindow.js`, `test/contextUsage.modelWindow.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/contextUsage.modelWindow.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CONTEXT_WINDOW, resolveContextWindow } from '../src/runtime/contextUsage/modelContextWindow.js';

test('known Claude models resolve to their window', () => {
  assert.equal(resolveContextWindow('claude-sonnet-4-20250514'), 200_000);
  assert.equal(resolveContextWindow('claude-3-5-haiku-20241022'), 200_000);
  assert.equal(resolveContextWindow('claude-opus-4-1m'), 1_000_000);
});
test('prefix match: a versioned model id resolves via its family prefix', () => {
  assert.equal(resolveContextWindow('claude-sonnet-4-5-20990101'), 200_000);
});
test('unknown / empty / non-string model → null (honest, never guess a denominator)', () => {
  assert.equal(resolveContextWindow('gpt-some-future'), null);
  assert.equal(resolveContextWindow(''), null);
  assert.equal(resolveContextWindow(null), null);
  assert.equal(resolveContextWindow(undefined), null);
});
test('MODEL_CONTEXT_WINDOW is frozen (single source of truth, not mutable)', () => {
  assert.throws(() => { MODEL_CONTEXT_WINDOW['x'] = 1; }, TypeError);
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/contextUsage.modelWindow.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/runtime/contextUsage/modelContextWindow.js`:

```javascript
/**
 * Single source of truth for a model's context-window size (the
 * denominator for context-usage %). Keyed by family prefix so a
 * versioned id (claude-sonnet-4-5-YYYYMMDD) resolves without a new
 * entry per date. Unknown → null: the caller reports source:'unknown'
 * and a null percentage rather than guessing (design §2 Bug 2 / §3).
 *
 * Adding a model is a one-line change here and ONLY here — never
 * hardcode a window elsewhere (a structural regression guard test
 * enforces this; design §6).
 */
export const MODEL_CONTEXT_WINDOW = Object.freeze({
  // family prefix → tokens
  'claude-sonnet': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-opus-4-1m': 1_000_000,
  'claude-opus': 200_000,
});

export function resolveContextWindow(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  // Longest-prefix match so 'claude-opus-4-1m' beats 'claude-opus'.
  let best = null;
  let bestLen = -1;
  for (const prefix of Object.keys(MODEL_CONTEXT_WINDOW)) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = MODEL_CONTEXT_WINDOW[prefix];
      bestLen = prefix.length;
    }
  }
  return best;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/contextUsage.modelWindow.test.js`
Expected: PASS (4/4).

---

## Task 2: Pure occupancy computer

**Files:** Create `src/runtime/contextUsage/computeContextUsage.js`, `test/contextUsage.compute.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/contextUsage.compute.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeContextUsage } from '../src/runtime/contextUsage/computeContextUsage.js';

// Helper: a normalized runtime-event-log row (matches #rowToEvent shape).
function ev(createdAt, eventType, raw) {
  return { eventType, createdAt, payload: { raw } };
}
function resultFrame(usage, model = 'claude-sonnet-4-20250514') {
  return { type: 'result', subtype: 'success', model, usage };
}
const T0 = '2026-05-16T00:00:00.000Z';
const T1 = '2026-05-16T00:00:30.000Z';
const T2 = '2026-05-16T00:10:00.000Z';
const NOW = Date.parse('2026-05-16T00:00:40.000Z'); // 10s after T1

test('used = latest result snapshot incl. cache fields + output (NOT Σ over turns)', () => {
  const events = [
    ev(T0, 'turn_completed', resultFrame({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 })),
    ev(T1, 'turn_completed', resultFrame({ input_tokens: 120, output_tokens: 60, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 })),
  ];
  const r = computeContextUsage({ events, now: NOW, stalenessMs: 60_000, providerId: 'claude' });
  // ONLY the latest turn: 120 + 3000 + 0 + 60 = 3180  (NOT 100+50+1000+200+120+60+3000)
  assert.equal(r.used, 3180);
  assert.equal(r.total, 200_000);
  assert.equal(r.percentage, Math.round((3180 / 200_000) * 1000) / 10);
  assert.equal(r.model, 'claude-sonnet-4-20250514');
  assert.equal(r.provider, 'claude');
  assert.equal(r.source, 'precise');
  assert.equal(r.lastUpdatedAt, T1);
  assert.equal(r.stale, false);
});

// Bug 1 regression guard: legacy tokensIn/tokensOut cumulative sum grew
// monotonically with session length regardless of real occupancy.
// Assert the occupancy formula does NOT exhibit that pattern.
test('Bug 1 regression guard: occupancy does NOT grow with turn count', () => {
  const small = [ev(T0, 'turn_completed', resultFrame({ input_tokens: 100, output_tokens: 50 }))];
  const manyTurns = [];
  for (let i = 0; i < 50; i += 1) {
    manyTurns.push(ev(`2026-05-16T00:${String(i).padStart(2, '0')}:00.000Z`, 'turn_completed',
      resultFrame({ input_tokens: 100, output_tokens: 50 })));
  }
  const a = computeContextUsage({ events: small, now: NOW, stalenessMs: 60_000, providerId: 'claude' });
  const b = computeContextUsage({ events: manyTurns, now: Date.parse('2026-05-16T01:00:00.000Z'), stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(a.used, 150);
  assert.equal(b.used, 150, '50 identical turns must NOT inflate occupancy — that was Bug 1');
});

test('missing cache fields → silently 0 (legitimate for non-cached requests)', () => {
  const events = [ev(T0, 'turn_completed', resultFrame({ input_tokens: 100, output_tokens: 50 }))];
  const r = computeContextUsage({ events, now: NOW, stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(r.used, 150);
  assert.equal(r.source, 'precise');
});
test('missing/non-numeric input_tokens OR output_tokens → source:unknown, used/percentage null', () => {
  for (const bad of [
    { output_tokens: 50, cache_read_input_tokens: 10 },                 // input missing
    { input_tokens: 100, cache_read_input_tokens: 10 },                 // output missing
    { input_tokens: 'x', output_tokens: 50 },                           // input non-numeric
  ]) {
    const r = computeContextUsage({ events: [ev(T0, 'turn_completed', resultFrame(bad))], now: NOW, stalenessMs: 60_000, providerId: 'claude' });
    assert.equal(r.used, null);
    assert.equal(r.percentage, null);
    assert.equal(r.source, 'unknown');
  }
});
test('no result frame yet → degraded (used/total/percentage null, source unknown)', () => {
  const r = computeContextUsage({ events: [ev(T0, 'assistant_text', { type: 'assistant' })], now: NOW, stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(r.used, null);
  assert.equal(r.total, null);
  assert.equal(r.percentage, null);
  assert.equal(r.source, 'unknown');
});
test('unknown model → total/percentage null, source unknown (never guess denominator)', () => {
  const events = [ev(T0, 'turn_completed', resultFrame({ input_tokens: 100, output_tokens: 50 }, 'gpt-future-x'))];
  const r = computeContextUsage({ events, now: NOW, stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(r.used, 150);          // occupancy still known
  assert.equal(r.total, null);
  assert.equal(r.percentage, null);
  assert.equal(r.source, 'unknown');  // can't express % honestly
});
test('stale = true only when idle beyond window with NO newer activity', () => {
  const events = [ev(T0, 'turn_completed', resultFrame({ input_tokens: 100, output_tokens: 50 }))];
  // now is 10 min after the only (T0) result, > 60s window, no newer events
  const r = computeContextUsage({ events, now: Date.parse(T2), stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(r.stale, true);
  assert.equal(r.used, 150, 'value still the last known snapshot even when stale');
});

// §3 in-flight pin, locked in code. No turn_started event exists;
// "in flight" = activity newer than the last result frame.
test('in-flight turn (events newer than last result frame) → stale:false even past window', () => {
  const events = [
    ev(T0, 'turn_completed', resultFrame({ input_tokens: 100, output_tokens: 50 })),
    ev(T2, 'tool_use', { type: 'assistant' }), // activity AFTER the last result, no newer result yet
  ];
  // now is just after T2, far past the 60s window relative to T0
  const r = computeContextUsage({ events, now: Date.parse(T2) + 1000, stalenessMs: 60_000, providerId: 'claude' });
  assert.equal(r.stale, false, 'a turn is in flight (newer activity than last result) — not stale');
  assert.equal(r.used, 150, 'value is the previous completed snapshot until the in-flight turn completes');
  assert.equal(r.lastUpdatedAt, T0);
});
test('non-array / empty events → degraded, never throws', () => {
  for (const e of [null, undefined, [], 'x', 5]) {
    const r = computeContextUsage({ events: e, now: NOW, stalenessMs: 60_000, providerId: 'claude' });
    assert.equal(r.source, 'unknown');
    assert.equal(r.used, null);
  }
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/contextUsage.compute.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/runtime/contextUsage/computeContextUsage.js`:

```javascript
import { resolveContextWindow } from './modelContextWindow.js';

const TERMINAL = new Set(['turn_completed', 'turn_failed']);

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * Pure: a single runtime's event-log rows → the context-usage snapshot.
 * "used" is the LATEST result-frame occupancy, never a Σ over turns
 * (design §2 Bug 1). `stale` is idle-not-in-flight (design §3): a turn
 * is "in flight" when any event is newer than the last result frame
 * (there is no turn_started event — this is the real signal).
 *
 * @param {object} a
 * @param {Array}  a.events       runtime-event-log rows ({eventType,createdAt,payload:{raw}})
 * @param {number} a.now          Date.now()-style ms
 * @param {number} a.stalenessMs  idle window before stale (default 60000)
 * @param {string} a.providerId   the runtime's provider ('claude' here)
 */
export function computeContextUsage({ events, now, stalenessMs = 60_000, providerId = 'unknown' } = {}) {
  const degraded = (model = null) => ({
    used: null, total: null, percentage: null,
    model, provider: providerId,
    lastUpdatedAt: null, stale: true, source: 'unknown',
  });
  if (!Array.isArray(events) || events.length === 0) return degraded();

  // Latest result frame (events arrive created_at ASC; scan from end).
  let resultEvt = null;
  let lastEventAt = null;
  for (const e of events) {
    if (e && typeof e.createdAt === 'string') {
      if (lastEventAt === null || e.createdAt > lastEventAt) lastEventAt = e.createdAt;
    }
    const raw = e && e.payload && e.payload.raw;
    if (e && e.eventType === 'turn_completed' && raw && raw.type === 'result') {
      if (!resultEvt || (typeof e.createdAt === 'string' && e.createdAt >= resultEvt.createdAt)) {
        resultEvt = e;
      }
    }
  }
  if (!resultEvt) return degraded();

  const raw = resultEvt.payload.raw;
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null;
  const u = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  // Cache fields are optional (non-cached requests have none) → silent 0.
  const cacheRead = num(u.cache_read_input_tokens) ?? 0;
  const cacheCreate = num(u.cache_creation_input_tokens) ?? 0;

  const lastUpdatedAt = resultEvt.createdAt;
  // In flight iff any event is newer than the last result frame.
  const inFlight = lastEventAt !== null && lastEventAt > lastUpdatedAt;
  const idleMs = now - Date.parse(lastUpdatedAt);
  const stale = !inFlight && Number.isFinite(idleMs) && idleMs > stalenessMs;

  // input/output mandatory; missing/non-numeric → untrustworthy snapshot.
  if (input === null || output === null) {
    return { used: null, total: null, percentage: null, model, provider: providerId, lastUpdatedAt, stale, source: 'unknown' };
  }
  const used = input + cacheRead + cacheCreate + output;
  const total = resolveContextWindow(model);
  if (total === null) {
    return { used, total: null, percentage: null, model, provider: providerId, lastUpdatedAt, stale, source: 'unknown' };
  }
  const percentage = Math.round((used / total) * 1000) / 10;
  return { used, total, percentage, model, provider: providerId, lastUpdatedAt, stale, source: 'precise' };
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/contextUsage.compute.test.js`
Expected: PASS (all cases, incl. the Bug-1 regression guard and the in-flight scenario).

---

## Task 3: `getContextUsage(agentId)` resolver + deferred slots

**Files:** Create `src/runtime/contextUsage/getContextUsage.js`, `src/runtime/contextUsage/index.js`, `test/contextUsage.getContextUsage.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/contextUsage.getContextUsage.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { getContextUsage } from '../src/runtime/contextUsage/index.js';

function fakeRegistry(rows) {
  return { listRuntimes: () => rows };
}
function fakeEventLog(byRuntime) {
  return { listEvents: ({ runtimeId }) => byRuntime[runtimeId] || [] };
}
function rf(createdAt, usage, model = 'claude-sonnet-4-20250514') {
  return { eventType: 'turn_completed', createdAt, payload: { raw: { type: 'result', subtype: 'success', model, usage } } };
}

test('resolves the agent\'s current runtime and computes precise usage', () => {
  const reg = fakeRegistry([
    { runtimeId: 'rt-old', agentId: 'dev', providerId: 'claude', status: 'stopped', startedAt: '2026-05-16T00:00:00Z' },
    { runtimeId: 'rt-now', agentId: 'dev', providerId: 'claude', status: 'running', startedAt: '2026-05-16T01:00:00Z' },
  ]);
  const log = fakeEventLog({ 'rt-now': [rf('2026-05-16T01:05:00.000Z', { input_tokens: 100, output_tokens: 50 })] });
  const r = getContextUsage('dev', { runtimeRegistry: reg, eventLog: log, settings: { runtime: { contextStaleness: 60_000 } }, now: Date.parse('2026-05-16T01:05:10Z') });
  assert.equal(r.used, 150);
  assert.equal(r.provider, 'claude');
  assert.equal(r.source, 'precise');
});
test('no runtime for agent → degraded shape, never throws', () => {
  const r = getContextUsage('ghost', { runtimeRegistry: fakeRegistry([]), eventLog: fakeEventLog({}), settings: {}, now: Date.now() });
  assert.equal(r.used, null); assert.equal(r.total, null); assert.equal(r.percentage, null);
  assert.equal(r.stale, true); assert.equal(r.source, 'unknown');
});
test('empty-slot safety: codex/gemini provider → degraded shape, never throws (deferred slots)', () => {
  for (const providerId of ['codex', 'gemini', 'openai', 'anything']) {
    const reg = fakeRegistry([{ runtimeId: 'rt', agentId: 'a', providerId, status: 'running', startedAt: '2026-05-16T00:00:00Z' }]);
    const r = getContextUsage('a', { runtimeRegistry: reg, eventLog: fakeEventLog({ rt: [] }), settings: {}, now: Date.now() });
    assert.equal(r.provider, providerId);
    assert.equal(r.source, 'unknown');
    assert.equal(r.used, null);
    assert.equal(r.stale, true);
  }
});
test('staleness window read from settings.runtime.contextStaleness, default 60000', () => {
  const reg = fakeRegistry([{ runtimeId: 'rt', agentId: 'a', providerId: 'claude', status: 'running', startedAt: '2026-05-16T00:00:00Z' }]);
  const log = fakeEventLog({ rt: [rf('2026-05-16T00:00:00.000Z', { input_tokens: 1, output_tokens: 1 })] });
  // 90s later: stale under default 60s, fresh under a configured 120s
  const def = getContextUsage('a', { runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.parse('2026-05-16T00:01:30Z') });
  assert.equal(def.stale, true);
  const cfg = getContextUsage('a', { runtimeRegistry: reg, eventLog: log, settings: { runtime: { contextStaleness: 120_000 } }, now: Date.parse('2026-05-16T00:01:30Z') });
  assert.equal(cfg.stale, false);
});
test('missing deps → degraded, never throws', () => {
  assert.equal(getContextUsage('a', {}).source, 'unknown');
  assert.equal(getContextUsage(null, { runtimeRegistry: fakeRegistry([]) }).source, 'unknown');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/contextUsage.getContextUsage.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/runtime/contextUsage/getContextUsage.js`:

```javascript
import { computeContextUsage } from './computeContextUsage.js';

const DEFAULT_STALENESS_MS = 60_000;
// Providers with a real B implementation. Codex/Gemini are NAMED-
// DEFERRED slots (design §4): the interface stays agnostic and
// empty-slot-safe (degraded shape, never throws) until a parser lands.
const IMPLEMENTED = new Set(['claude', 'anthropic']);

function degraded(provider, model = null) {
  return { used: null, total: null, percentage: null, model, provider: provider || 'unknown', lastUpdatedAt: null, stale: true, source: 'unknown' };
}

/**
 * Provider-agnostic context-usage accessor. Resolves the agent's
 * current runtime via the registry, pulls its events, and computes
 * the latest-snapshot occupancy. ALWAYS returns the correctly-shaped
 * object — never throws, never an invalid shape — regardless of
 * provider or missing deps (design §4 empty-slot safety).
 */
export function getContextUsage(agentId, { runtimeRegistry, eventLog, settings, now } = {}) {
  try {
    if (typeof agentId !== 'string' || agentId.length === 0) return degraded();
    if (!runtimeRegistry || typeof runtimeRegistry.listRuntimes !== 'function') return degraded();
    const rows = runtimeRegistry.listRuntimes({}) || [];
    const mine = rows.filter((r) => r && r.agentId === agentId);
    if (mine.length === 0) return degraded();
    // Current runtime: prefer a non-stopped one, else the latest started.
    mine.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    const current = mine.find((r) => r.status && r.status !== 'stopped') || mine[0];
    const providerId = current.providerId || 'unknown';
    if (!IMPLEMENTED.has(providerId)) return degraded(providerId);
    if (!eventLog || typeof eventLog.listEvents !== 'function') return degraded(providerId);
    const events = eventLog.listEvents({ runtimeId: current.runtimeId }) || [];
    const stalenessMs = Number.isFinite(settings?.runtime?.contextStaleness)
      ? settings.runtime.contextStaleness
      : DEFAULT_STALENESS_MS;
    return computeContextUsage({ events, now: typeof now === 'number' ? now : Date.now(), stalenessMs, providerId });
  } catch {
    return degraded();
  }
}
```

Create `src/runtime/contextUsage/index.js`:

```javascript
export { getContextUsage } from './getContextUsage.js';
export { computeContextUsage } from './computeContextUsage.js';
export { MODEL_CONTEXT_WINDOW, resolveContextWindow } from './modelContextWindow.js';
```

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/contextUsage.getContextUsage.test.js`
Expected: PASS (all, incl. empty-slot safety + settings staleness).

> **Controller ratification (T3 code-quality review) — SUPERSEDES the
> Task-3 code/tests above. Two fixes; spec §1 ratified note is
> authoritative.**
>
> **Fix C1 (Critical): `teamId` is a required scoping input.** `agentId`
> is a bare team-scoped role (`'lead'`/`'worker-N'`; membership key is
> `PRIMARY KEY (team_id, agent_id)`); `listRuntimes({})` spans all
> teams → cross-team collision. The resolver MUST scope by `teamId`.
> Replace `getContextUsage`'s body so the signature is
> `getContextUsage(agentId, { teamId, runtimeRegistry, eventLog,
> settings, now } = {})` and resolution is team-scoped, degrading
> honestly (never cross-team-guess) on a missing/empty `teamId`:
>
> ```javascript
> export function getContextUsage(agentId, { teamId, runtimeRegistry, eventLog, settings, now } = {}) {
>   try {
>     if (typeof agentId !== 'string' || agentId.length === 0) return degraded();
>     if (typeof teamId !== 'string' || teamId.length === 0) return degraded();
>     if (!runtimeRegistry || typeof runtimeRegistry.listRuntimes !== 'function') return degraded();
>     const rows = runtimeRegistry.listRuntimes({ teamId }) || [];
>     const mine = rows.filter((r) => r && r.agentId === agentId);
>     if (mine.length === 0) return degraded();
>     // Current runtime: prefer a non-stopped one, else the latest started.
>     // Plain string compare on ISO-8601 (Fix I1 — not locale-sensitive
>     // localeCompare; ISO timestamps order correctly by code point).
>     mine.sort((a, b) => {
>       const sb = String(b.startedAt || '');
>       const sa = String(a.startedAt || '');
>       return sb < sa ? -1 : sb > sa ? 1 : 0;
>     });
>     const current = mine.find((r) => r.status && r.status !== 'stopped') || mine[0];
>     const providerId = current.providerId || 'unknown';
>     if (!IMPLEMENTED.has(providerId)) return degraded(providerId);
>     if (!eventLog || typeof eventLog.listEvents !== 'function') return degraded(providerId);
>     const events = eventLog.listEvents({ runtimeId: current.runtimeId }) || [];
>     const stalenessMs = Number.isFinite(settings?.runtime?.contextStaleness)
>       ? settings.runtime.contextStaleness
>       : DEFAULT_STALENESS_MS;
>     return computeContextUsage({ events, now: typeof now === 'number' ? now : Date.now(), stalenessMs, providerId });
>   } catch {
>     return degraded();
>   }
> }
> ```
> (`degraded`, `DEFAULT_STALENESS_MS`, `IMPLEMENTED`, the import, and
> `index.js` are unchanged from the Step-3 code above.)
>
> **Fix I1 (Important): plain-string ISO comparator** — folded into the
> sort above (no `localeCompare`; ISO-8601 is code-point ordered, so a
> documented `< / >` comparison is correct and locale-independent).
>
> **Test updates (Step-1 file):** every existing test that calls
> `getContextUsage('…', { runtimeRegistry, … })` now also passes
> `teamId: 'team-a'` in the deps (the fakeRegistry rows already carry
> no teamId — the fake `listRuntimes` ignores its arg, so adding
> `teamId` keeps them green while exercising the new contract). Update
> the "missing deps" test to also assert
> `getContextUsage('a', { teamId: 't' }).source === 'unknown'` and add:
>
> ```javascript
> test('REQUIRED teamId: missing/empty teamId → degraded (never cross-team-guess)', () => {
>   const reg = fakeRegistry([{ runtimeId: 'rt', agentId: 'lead', teamId: 'A', providerId: 'claude', status: 'running', startedAt: '2026-05-16T00:00:00Z' }]);
>   const log = fakeEventLog({ rt: [rf('2026-05-16T00:00:01Z', { input_tokens: 1, output_tokens: 1 })] });
>   assert.equal(getContextUsage('lead', { runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.now() }).source, 'unknown', 'no teamId → degraded');
>   assert.equal(getContextUsage('lead', { teamId: '', runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.now() }).source, 'unknown', 'empty teamId → degraded');
> });
> test('cross-team agentId collision: scoping by teamId picks the RIGHT team’s runtime', () => {
>   // A real registry would filter by teamId; emulate that in the fake.
>   const rowsByTeam = {
>     A: [{ runtimeId: 'rtA', agentId: 'lead', teamId: 'A', providerId: 'claude', status: 'running', startedAt: '2026-05-16T00:00:00Z' }],
>     B: [{ runtimeId: 'rtB', agentId: 'lead', teamId: 'B', providerId: 'claude', status: 'running', startedAt: '2026-05-16T02:00:00Z' }],
>   };
>   const reg = { listRuntimes: ({ teamId }) => rowsByTeam[teamId] || [] };
>   const log = fakeEventLog({
>     rtA: [rf('2026-05-16T00:00:01Z', { input_tokens: 100, output_tokens: 0 })],
>     rtB: [rf('2026-05-16T02:00:01Z', { input_tokens: 999, output_tokens: 0 })],
>   });
>   const a = getContextUsage('lead', { teamId: 'A', runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.parse('2026-05-16T00:00:05Z') });
>   const b = getContextUsage('lead', { teamId: 'B', runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.parse('2026-05-16T02:00:05Z') });
>   assert.equal(a.used, 100, 'team A lead resolves team A runtime');
>   assert.equal(b.used, 999, 'team B lead resolves team B runtime — no cross-team bleed');
> });
> ```
> The existing fakeRegistry/fakeEventLog helpers stay; the
> cross-team test uses a teamId-scoping fake (mirrors the real
> `listRuntimes({teamId})`). All other Step-1 tests keep their
> assertions, just add `teamId: 'team-a'` to their deps object.

---

## Task 4: Facade `runtime_list` emits per-runtime `contextUsage`

**Files:** Modify `src/tools/localToolFacade.js`; create `test/contextUsage.facade.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/contextUsage.facade.test.js` (mirror the existing facade test harness — locate `test/apiServer.test.js`/`test/localToolFacade.test.js` for how `LocalToolFacade` is constructed with `runtimeRegistry`/`eventLog`; use the same construction). The test asserts: a runtime whose event log has two `result` turns gets `contextUsage.used` = the **latest** turn's occupancy (NOT the sum), `contextUsage.total` = the model window, and the row still carries lifetime `tokensIn`/`tokensOut` (spend retained).

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalToolFacade } from '../src/tools/localToolFacade.js';
// Build the minimal facade the runtime_list path needs. Mirror the
// construction used in test/localToolFacade.test.js (runtimeRegistry +
// eventLog fakes), then call the runtime_list tool as the operator.

test('runtime_list: contextUsage.used is the latest-turn occupancy, not Σ; spend retained', async () => {
  const runtimeRegistry = {
    listRuntimes: () => [{ runtimeId: 'rt1', agentId: 'dev', teamId: 'team-a', providerId: 'claude', status: 'running', startedAt: '2026-05-16T00:00:00.000Z' }],
    getRuntime: () => null,
  };
  const R = (createdAt, usage) => ({ runtimeId: 'rt1', teamId: 'team-a', agentId: 'dev', eventType: 'turn_completed', createdAt, payload: { raw: { type: 'result', subtype: 'success', model: 'claude-sonnet-4-20250514', usage, total_cost_usd: 0.01 } } });
  const eventLog = {
    listEvents: () => [
      R('2026-05-16T00:00:10.000Z', { input_tokens: 100, output_tokens: 50 }),
      R('2026-05-16T00:00:20.000Z', { input_tokens: 120, output_tokens: 60, cache_read_input_tokens: 5000 }),
    ],
  };
  const facade = new LocalToolFacade({ broker: { /* minimal */ }, taskBoard: { listTasks: () => [] }, runtimeRegistry, eventLog, settingsStore: { readEffective: async () => ({}) } });
  const actor = { teamId: 'team-a', agentId: 'op', role: 'human' };
  const out = await facade.callTool(actor, 'runtime_list', {});
  const rt = out.runtimes.find((r) => r.runtimeId === 'rt1');
  assert.ok(rt.contextUsage, 'runtime row carries contextUsage');
  assert.equal(rt.contextUsage.used, 120 + 5000 + 0 + 60); // latest turn only
  assert.equal(rt.contextUsage.total, 200_000);
  assert.equal(rt.contextUsage.source, 'precise');
  // Lifetime spend retained (NOT the occupancy signal): both turns summed.
  assert.equal(rt.tokensIn, 220);
  assert.equal(rt.tokensOut, 110);
  assert.ok(typeof rt.costUsd === 'number');
});
```

> Implementation note: adapt the `LocalToolFacade` construction + `callTool`/`runtime_list` invocation to the real harness in `test/localToolFacade.test.js` / `test/apiServer.test.js` (constructor arg names, how the operator actor is shaped, how the tool is dispatched). Keep the assertions exactly as above; adapt only the plumbing.

- [ ] **Step 2: Run — verify fail**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/contextUsage.facade.test.js`
Expected: FAIL — `rt.contextUsage` is undefined (facade does not emit it yet).

- [ ] **Step 3: Implement**

In `src/tools/localToolFacade.js`, add the import near the other runtime imports:

```javascript
import { computeContextUsage } from '../runtime/contextUsage/index.js';
```

In the `runtime_list` enrichment (the `enriched = runtimes.map((r) => { … })` block, ~L2085), add a per-runtime `contextUsage` derived from the events already loaded for that runtime. The enrichment loop currently iterates a flat `events` list for `team-a`; build a per-runtime event bucket alongside the existing `tokensByRuntime`/`modelByRuntime` maps:

```javascript
    // Per-runtime event list (for the corrected context-usage signal).
    // The cumulative tokensByRuntime below is RETAINED but is SPEND
    // telemetry only — NOT context-window occupancy (design §2/§5).
    const eventsByRuntime = new Map();
    for (const e of events) {
      if (typeof e.runtimeId !== 'string' || e.runtimeId.length === 0) continue;
      let arr = eventsByRuntime.get(e.runtimeId);
      if (!arr) { arr = []; eventsByRuntime.set(e.runtimeId, arr); }
      arr.push(e);
    }
```

Resolve the staleness setting once (the facade has `this.settingsStore`):

```javascript
    let stalenessMs = 60_000;
    try {
      const eff = this.settingsStore && typeof this.settingsStore.readEffective === 'function'
        ? await this.settingsStore.readEffective() : null;
      if (eff && Number.isFinite(eff?.runtime?.contextStaleness)) stalenessMs = eff.runtime.contextStaleness;
    } catch { /* default 60s */ }
    const nowMs = Date.now();
```

In the `enriched` map, add `contextUsage`:

```javascript
      contextUsage: computeContextUsage({
        events: eventsByRuntime.get(r.runtimeId) || [],
        now: nowMs,
        stalenessMs,
        providerId: r.providerId || 'claude',
      }),
```

Keep `tokensIn`/`tokensOut`/`costUsd` exactly as-is (now explicitly spend-only). Do NOT remove them. Add a one-line comment at the `tokensByRuntime` accumulation site: `// SPEND telemetry only — context occupancy is contextUsage (design §2 Bug 1).`

- [ ] **Step 4: Run — verify pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/contextUsage.facade.test.js`
Expected: PASS.

---

## Task 5: UI lockstep — repoint the mapper + RuntimeDrawer

**Files:** Modify `ui/src/hooks/useToadData.ts`, `ui/src/components/RuntimeDrawer.tsx`

- [ ] **Step 1: Repoint the mapper (the epicenter)**

In `ui/src/hooks/useToadData.ts`:
- L379-380 area: also pass the new field through — add `contextUsage: raw.contextUsage ?? null,` next to `tokensIn`/`tokensOut` (extend the runtime row type ~L126 with `contextUsage?: { used: number|null; total: number|null; percentage: number|null; model: string|null; provider: string; lastUpdatedAt: string|null; stale: boolean; source: 'precise'|'coarse'|'unknown' } | null;`).
- L504-505: replace the hardcoded mapping

```typescript
      tokens: (runtime?.tokensIn ?? 0) + (runtime?.tokensOut ?? 0),
      tokenLimit: 200_000,
```

with the corrected single source (occupancy from the signal; spend stays separate):

```typescript
      tokens: runtime?.contextUsage?.used ?? 0,
      tokenLimit: runtime?.contextUsage?.total ?? 0,
      contextStale: runtime?.contextUsage?.stale ?? true,
      contextSource: runtime?.contextUsage?.source ?? 'unknown',
```

(Extend the `agent` shape type accordingly. `tokenLimit: 0` is the honest "unknown denominator" — existing consumers already guard `tokenLimit > 0`, e.g. `Inspector.tsx:248`; verify the others degrade sanely with 0 rather than dividing by it.)

- [ ] **Step 2: Drop RuntimeDrawer's own hardcode**

In `ui/src/components/RuntimeDrawer.tsx`, replace the three `200_000` sites (L217 `budgetPct = (totalContextTokens / 200_000) * 100`, L347 `/ 200k` label, L361 width `(item.tokens / 200_000) * 100`) so the denominator is the per-runtime `contextUsage.total` (fall back to a "—"/hidden meter when `total` is null/0, never a hardcoded constant). Wire `RuntimeDrawer` to the same `contextUsage` the mapper now exposes (read it from the runtime row it already renders). The label becomes dynamic (e.g. `/ ${(total/1000)|0}k` or "context unknown" when null).

- [ ] **Step 3: Verify the transitive consumers + typecheck/build**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run typecheck 2>&1 | grep -E "error TS" || echo "CLEAN"`
Expected: `CLEAN` (zero `error TS`). `AgentCard.tsx`/`cockpit/Inspector.tsx`/`CockpitFlowCanvas.tsx` consume `agent.tokens`/`agent.tokenLimit` from the mapper — they are corrected transitively; the typecheck proves no type break from the shape extension.
Run: `cd /c/Project-TOAD/toad-local/ui && npm run build 2>&1 | tail -3`
Expected: `✓ built` (vite build succeeds).

---

## Task 6: Structural regression guard + wire tests into the suite

**Files:** Create `test/contextUsage.regressionGuard.test.js`; modify `package.json`

- [ ] **Step 1: Write the guard test**

Create `test/contextUsage.regressionGuard.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Structural regression guard (design §6): once the context-window
// denominator is single-sourced in MODEL_CONTEXT_WINDOW, NO other
// src/ or ui/src/ file may hardcode a context-window literal. This
// makes the split-denominator divergence (Bug 2) structurally hard to
// reintroduce — same discipline as the lockstep tests.
test('no hardcoded context-window literal outside the single-source map', () => {
  // ripgrep for 200000 / 200_000 / 1000000 / 1_000_000 as standalone
  // numeric literals in src + ui/src, excluding the canonical map file
  // and test files.
  let hits = '';
  try {
    hits = execSync(
      `git -C /c/Project-TOAD grep -nE "200[_]?000|1[_]?000[_]?000" -- ` +
      `toad-local/src toad-local/ui/src ` +
      `":(exclude)toad-local/src/runtime/contextUsage/modelContextWindow.js"`,
      { encoding: 'utf8' }
    );
  } catch (e) {
    // git grep exits 1 when no matches — that's the pass case.
    hits = e.status === 1 ? '' : (e.stdout || '');
  }
  assert.equal(hits.trim(), '',
    `hardcoded context-window literal(s) found — route through MODEL_CONTEXT_WINDOW:\n${hits}`);
});
```

> If a legitimate unrelated `1_000_000`/`200_000` exists elsewhere (e.g. an unrelated timeout), tighten the regex to the context/token usage sites or add a precise `:(exclude)` for that file with a comment — but do NOT loosen it to the point it stops guarding the denominator. Verify by running it and inspecting any hit.

- [ ] **Step 2: Run — verify it PASSES post-migration**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/contextUsage.regressionGuard.test.js`
Expected: PASS (Tasks 4–5 removed the `200_000` hardcodes; the only window literals now live in `modelContextWindow.js`, which is excluded). If it FAILS, a hardcode remains — fix the source, not the test.

- [ ] **Step 3: Wire all 5 new test files into `package.json`**

In `toad-local/package.json`'s `test` script chain, add adjacent to the other `test/` entries:
`&& node --no-warnings --test test/contextUsage.modelWindow.test.js && node --no-warnings --test test/contextUsage.compute.test.js && node --no-warnings --test test/contextUsage.getContextUsage.test.js && node --no-warnings --test test/contextUsage.facade.test.js && node --no-warnings --test test/contextUsage.regressionGuard.test.js`
(Verify each path exists; this prevents the un-wired-test false-green trap.)

---

## Task 7: PROJECT.md — bank the two invariants

**Files:** Modify `PROJECT.md`

- [ ] **Step 1: Insert §8d** between `### 8c.` (ends before `## 9.` at ~L298) and `## 9. Provider architecture`:

```markdown
### 8d. Grounding-first & settings-namespace — INVARIANTS

**Ground brainstorm rounds against current code before answering**
whenever the topic touches an existing surface. Captured design prose
(appendices, deferred notes) is the *plan*, not *current state*;
reality moves. Repeatedly material (Slice-B contracts/evidence
reality; Sub-project-B's Claude-only-runtime reality + the
existing-meter wrongness). Every Appendix-A sub-project (and similar)
opens with a grounding pass against the code, not the doc.

**Settings namespace is governed by what the setting controls, not by
chronological proximity to prior settings.** `settings.drift.*` =
drift-monitor behavior; `settings.runtime.*` = runtime-supervisor
behavior (context staleness; the future C/D/E compaction / rotation /
routing knobs). Co-location of work in one sub-project never justifies
cross-namespacing a setting. (Origin: a reviewer-pinned
`settings.drift.contextStaleness` was caught in spec review as a
category error and corrected to `settings.runtime.contextStaleness`.)
```

- [ ] **Step 2: Sanity-check**

Run: `cd /c/Project-TOAD/toad-local && grep -n "8d\. Grounding-first\|## 9\. Provider" PROJECT.md`
Expected: §8d immediately precedes §9.

---

## Task 8: Gates + the single atomic commit (§5-ordered)

**Files:** none new — verification + the one commit.

- [ ] **Step 1: Full root suite green**

Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -E "^# (fail|pass)" | awk '{a[$2]+=$3} END {for (k in a) print k, a[k]}'`
Expected: `fail 0`; `pass` ≥ baseline + the new contextUsage tests. If any pre-existing test regressed, fix the code (never weaken a test).

- [ ] **Step 2: UI gates green**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run typecheck 2>&1 | grep -E "error TS" || echo CLEAN` → `CLEAN`.
Run: `cd /c/Project-TOAD/toad-local/ui && npm run build 2>&1 | tail -3` → `✓ built`.

- [ ] **Step 3: Dogfood — occupancy is latest-snapshot, not Σ (the Bug-1 proof)**

Run:

```bash
cd /c/Project-TOAD/toad-local && node --input-type=module -e '
import { computeContextUsage } from "./src/runtime/contextUsage/index.js";
const R=(t,u)=>({eventType:"turn_completed",createdAt:t,payload:{raw:{type:"result",subtype:"success",model:"claude-sonnet-4-20250514",usage:u}}});
const many=[]; for(let i=0;i<40;i++) many.push(R(`2026-05-16T00:${String(i).padStart(2,"0")}:00.000Z`,{input_tokens:500,output_tokens:200,cache_read_input_tokens:8000}));
const r=computeContextUsage({events:many,now:Date.parse("2026-05-16T00:39:30.000Z"),stalenessMs:60000,providerId:"claude"});
console.log("used:",r.used,"(expect 8700 — ONE turn, NOT 40x)","total:",r.total,"pct:",r.percentage,"source:",r.source,"stale:",r.stale);
'
```

Expected exactly: `used: 8700 (expect 8700 — ONE turn, NOT 40x) total: 200000 pct: 4.4 source: precise stale: false`. If `used` scales with turn count, Bug 1 is not fixed — stop, do not commit.

- [ ] **Step 4: The single atomic commit (§5 internal order is already satisfied by task order: signal created (T1–4) → UI repointed (T5) → guards/PROJECT.md (T6–7); nothing committed until now)**

```bash
git -C /c/Project-TOAD add -A toad-local/src/runtime/contextUsage toad-local/test/contextUsage.modelWindow.test.js toad-local/test/contextUsage.compute.test.js toad-local/test/contextUsage.getContextUsage.test.js toad-local/test/contextUsage.facade.test.js toad-local/test/contextUsage.regressionGuard.test.js toad-local/src/tools/localToolFacade.js toad-local/ui/src/hooks/useToadData.ts toad-local/ui/src/components/RuntimeDrawer.tsx toad-local/PROJECT.md toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
feat(runtime): provider-aware context-window usage signal (Appendix A · B)

Replaces the wrong, monotonic-growth Claude meter with a correct
provider-agnostic getContextUsage(agentId)→{used,total,percentage,
model,provider,lastUpdatedAt,stale,source}. used = the LATEST
result.usage snapshot (input + cache_read + cache_creation + output),
NOT Σ over turns (Bug 1); total = the running model's window via the
single-source MODEL_CONTEXT_WINDOW map, null on unknown (Bug 2).
Missing/non-numeric input|output → source:'unknown'; cache fields
optional→0. stale = idle-not-in-flight (in-flight = activity newer
than the last result frame; no turn_started event exists). source
sealed enum precise|coarse|unknown ('coarse' reserved for the Gemini
deferred slot, never emitted by Claude). settings.runtime
.contextStaleness default 60s. Codex/Gemini are named-deferred,
empty-slot-safe (degraded shape, never throws).

Replace-not-parallel: facade runtime_list emits per-runtime
contextUsage; useToadData + RuntimeDrawer repointed in lockstep
(hardcoded 200_000 removed); tokensIn/tokensOut/costUsd retained as
spend telemetry. Structural grep guard rejects future hardcoded
window literals. PROJECT.md §8d banks grounding-first +
settings-namespace invariants. Dogfooded: 40 identical turns →
used stays one-turn (Bug-1 disproved). Root suite + UI tsc/build
green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git -C /c/Project-TOAD log --oneline -3
```

- [ ] **Step 5: Post-commit verify**

`git -C /c/Project-TOAD show --stat HEAD` — exactly the listed files, no stray. `git -C /c/Project-TOAD status --porcelain` — clean (only unrelated untracked dirs). HEAD~1 is `f7a023a` lineage.

---

## Self-Review (plan author)

**1. Spec coverage:** §1 measurable criterion → Task 4 (facade emits per-runtime signal) + Task 8 dogfood. §2 Bug 1 formula → Task 2 (+ regression guard) + Task 8 dogfood. §2 Bug 2 denominator → Task 1 + Task 5 (+ Task 6 grep guard). §2 missing/non-numeric → Task 2. §2 spend-retained → Task 4. §3 push/pull+staleness+`stale` in-flight pin → Task 2 (explicit in-flight test) + Task 3 (settings window). §3 sealed `source` enum → Tasks 2/3 (`'coarse'` reserved, never emitted). §3 `settings.runtime.contextStaleness` 60s → Task 3. §4 Claude-only + Codex/Gemini named-deferred + empty-slot safety → Task 3. §4 three-CLI-roles clarification → captured in spec; no code. §5 replace-not-parallel + module home + atomic-commit ordering → Tasks 4/5 + Task 8 (task order = the §5 order). §6 tests + structural guard + comment convention → Tasks 2 (Bug-1 guard w/ named comment) + 6 (grep guard) ; gates → Task 8. §8 two banked invariants → Task 7. Non-goals respected (no C/D/E; deferred slots only).

**2. Placeholder scan:** none — every code step has literal code. The two "adapt to the real harness" notes (Task 4 facade construction; Task 5 transitive-consumer check) are explicitly bounded (named the file to mirror, assertions fixed, only plumbing adapts) — not TBDs.

**3. Type consistency:** `computeContextUsage({events,now,stalenessMs,providerId})` and its return `{used,total,percentage,model,provider,lastUpdatedAt,stale,source}` identical across Tasks 2/3/4 and the UI type extension (Task 5). `getContextUsage(agentId,{runtimeRegistry,eventLog,settings,now})` consistent Task 3 ↔ tests. `resolveContextWindow(model)` Task 1 ↔ Task 2 consumer. `MODEL_CONTEXT_WINDOW` frozen, single-source, referenced by Task 6's exclude path. `source` sealed `'precise'|'coarse'|'unknown'` consistent everywhere; `'coarse'` never emitted by the Claude path (Tasks 2/3). `settings.runtime.contextStaleness` consistent Task 3 impl ↔ Task 3 test ↔ Task 4 facade read ↔ Task 7 PROJECT.md.
