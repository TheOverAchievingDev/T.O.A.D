# SP2 — Unified getContextUsage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `getContextUsage(agentId)` return `source:'precise'` for Codex, Gemini, and OpenCode runtimes (currently `source:'unknown'/degraded`) by filling the three named-deferred extractor slots, and wire a per-provider compaction-threshold map so `CompactionTrigger` fires at the right `%` per provider.

**Architecture:** A small per-provider extractor registry under `src/runtime/contextUsage/extractors/` (mirrors the IDE-1 `diagnosticsRouter` pattern). `computeContextUsage` becomes a thin dispatcher that picks the extractor by `providerId`; staleness/window math stays intact. `CompactionTrigger` gains per-provider threshold resolution via a new `providerThresholds.js` map. The SP1 normalizers already unified the `payload.raw.usage.{input_tokens,output_tokens}` shape across all four providers — extractors differ only in result-frame gate and cache-field summation.

**Tech Stack:** Node ESM (`src/runtime/contextUsage/`, `src/runtime/compactionTrigger/`); `node:test`; no UI, no MCP, no facade.

**Source spec:** `docs/superpowers/specs/2026-05-19-sp2-context-usage-design.md`

---

## Design deviations discovered during planning (read first)

1. **Pre-existing percentage-units bug in `shouldCompact`.** `computeContextUsage.js:71` returns `percentage = Math.round((used/total)*1000)/10` — one-decimal **percent** (e.g. `70.0` for 70%). `shouldCompact` compares it against `threshold` (validated by `resolveThresholdFromSettings` as a **fraction** 0–1). The CompactionTrigger tests inject fake fractions (`percentage: 0.82`) and therefore never catch the mismatch; in production `70.0 >= 0.70` is always true → proactive compaction fires at any non-trivial usage. NO UI consumer reads `.percentage` (verified) — the bug surface is confined to `shouldCompact`. SP2 multiplies this bug across 3 new providers, so the plan fixes it at the boundary in **Task 1**: normalize inside `shouldCompact` (`pct > 1 ? pct/100 : pct`) — defensive, tolerates both unit conventions, leaves existing tests passing unchanged, and stops the misfire in production.

2. **`getThreshold` callback gains a `providerId` argument.** `CompactionTrigger.onTurnCompleted` currently calls `await this.getThreshold()` (no args). Per-provider thresholds require it to call `await this.getThreshold(usage.provider)`. The default `getThreshold` provided by the runtime wiring becomes a small adapter over `resolveThresholdFromSettings(settingsStore, providerId)`. Existing callers that pass a fixed-value `getThreshold` (the test injections) continue to work because the new callback signature ignores the extra arg if not used.

3. **`resolveThresholdFromSettings` becomes provider-aware.** Today it hardcodes `eff.compaction.claude.threshold`. After SP2 it reads `eff.compaction[providerId]?.threshold`, falling back to `PROVIDER_COMPACTION_THRESHOLDS[providerId]?.trigger`, then to `DEFAULT_THRESHOLD.trigger`. Claude users with the existing `compaction.claude.threshold` settings entry continue to work unchanged.

---

## File Structure

**Create (10 files):**
- `src/runtime/contextUsage/extractors/claudeExtractor.js` — codifies existing inline Claude extraction.
- `src/runtime/contextUsage/extractors/codexExtractor.js` — Codex gating + cache + reasoning summation.
- `src/runtime/contextUsage/extractors/geminiExtractor.js` — Gemini gating; no cache.
- `src/runtime/contextUsage/extractors/opencodeExtractor.js` — OpenCode gating + cache.
- `src/runtime/contextUsage/extractorRegistry.js` — `getExtractor(providerId)` + `PROVIDER_KEYS`.
- `src/runtime/compactionTrigger/providerThresholds.js` — `PROVIDER_COMPACTION_THRESHOLDS` + `DEFAULT_THRESHOLD` + `getProviderThreshold`.
- `test/claudeExtractor.test.js`
- `test/codexExtractor.test.js`
- `test/geminiExtractor.test.js`
- `test/opencodeExtractor.test.js`
- `test/extractorRegistry.test.js`
- `test/providerThresholds.test.js`

**Modify:**
- `src/runtime/contextUsage/computeContextUsage.js` — inline Claude extraction → dispatch via registry.
- `src/runtime/contextUsage/getContextUsage.js` — `IMPLEMENTED` derived from `PROVIDER_KEYS`.
- `src/runtime/compactionTrigger/shouldCompact.js` — boundary unit-normalize `percentage`.
- `src/runtime/compactionTrigger/CompactionTrigger.js` — `resolveThresholdFromSettings(store, providerId)`; `getThreshold(providerId)` callback signature; `onTurnCompleted` passes `usage.provider`.
- `test/contextUsage.getContextUsage.test.js` — narrow empty-slot guard + add per-provider precise tests.
- `test/compactionTrigger.shouldCompact.test.js` — add percent-form-input test.
- `test/compactionTrigger.test.js` — update the codex/`provider:'codex'` test to assert the new per-provider threshold path (still degraded → no fire, same outcome, but exercise the threaded providerId).
- `scripts/test-suites.txt` — append the 6 new suites single-line.

**Byte-unchanged invariant:** the spec §12 list — `App.tsx`, persona, `developerMode`, `CockpitScreenV2`, `useTweaks`, `CockpitForMe`, `CockpitWithMe`, all Statusbar/UI files; all foreign Notion-B WIP files (`PlanUsagePanel.tsx`, untracked `geminiUsageProbe.js`, the working-tree-only foreign `LocalToadRuntime.js` import). Verified in Task 9.

**Commit convention (every commit):** from `/c/Project-TOAD`; stage explicit `toad-local/`-prefixed paths only (**never `git add -A`**); `git -c commit.gpgsign=false commit`; trailer:
`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`
Commit directly to `main`.

---

## Task 1: Pre-existing bug fix — unit-normalize `percentage` in `shouldCompact`

**Files:**
- Modify: `src/runtime/compactionTrigger/shouldCompact.js`
- Test: `test/compactionTrigger.shouldCompact.test.js`

- [ ] **Step 1: Write the failing test**

Append to `test/compactionTrigger.shouldCompact.test.js` (before the final test, after the existing imports):

```js
test('percent-form input (computeContextUsage returns 0.0–100.0): correctly compared against fraction threshold', () => {
  // computeContextUsage emits one-decimal PERCENT (e.g. 70.0 for 70%);
  // resolveThresholdFromSettings emits FRACTION (e.g. 0.70). shouldCompact
  // must tolerate both forms so the existing tests (fraction) and
  // production (percent) both decide correctly.
  // 70.0 percent vs 0.70 fraction → SAME logical value → THRESHOLD_CROSSED.
  assert.deepEqual(
    shouldCompact({ usage: { percentage: 70.0, stale: false, source: 'claude' }, threshold: 0.70, state: { gateArmed: false, lastFireAt: 0, retriesRemaining: 0, cooldownMs: 120_000 }, now: 1_000_000 }),
    { trigger: true, reason: REASONS.THRESHOLD_CROSSED },
  );
  // 50.0 percent vs 0.70 fraction → BELOW.
  assert.deepEqual(
    shouldCompact({ usage: { percentage: 50.0, stale: false, source: 'claude' }, threshold: 0.70, state: { gateArmed: false, lastFireAt: 0, retriesRemaining: 0, cooldownMs: 120_000 }, now: 1_000_000 }),
    { trigger: false, reason: REASONS.BELOW_THRESHOLD },
  );
  // 1.0 percent (low usage) vs 0.70 fraction → BELOW (was incorrectly firing before the fix).
  assert.deepEqual(
    shouldCompact({ usage: { percentage: 1.0, stale: false, source: 'claude' }, threshold: 0.70, state: { gateArmed: false, lastFireAt: 0, retriesRemaining: 0, cooldownMs: 120_000 }, now: 1_000_000 }),
    { trigger: false, reason: REASONS.BELOW_THRESHOLD },
  );
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.shouldCompact.test.js`
Expected: FAIL — the `1.0` percent case will incorrectly fire (`THRESHOLD_CROSSED`) because `1.0 >= 0.70` under today's bug; the `50.0` case will also incorrectly fire.

- [ ] **Step 3: Implement the boundary normalization**

In `src/runtime/compactionTrigger/shouldCompact.js`, find the line:
```js
  // #2 — strict: a missing/non-finite percentage is no signal, not 0.
  const pct = num(u.percentage);
  if (pct === null) {
    return { trigger: false, reason: REASONS.NO_SIGNAL };
  }
```
and immediately AFTER `if (pct === null) { ... }`, BEFORE the `const st = state || {};` line, insert:
```js
  // Defensive unit-normalization: computeContextUsage returns percentage
  // as one-decimal PERCENT (e.g. 70.0); resolveThresholdFromSettings and
  // legacy tests use FRACTION (0.70). Accept both — a value > 1 must be
  // a percent (no provider reports >100% occupancy). This stops the
  // pre-SP2 misfire where 70.0 % >= 0.70 fraction was always true.
  const pctFrac = pct > 1 ? pct / 100 : pct;
```
Then replace BOTH occurrences below (#6 fresh-cross and any other usage of `pct >=` in this file — there's exactly one `if (pct >= threshold)` at the `#6` line) with `pctFrac`:
```js
  // #6 — fresh cross.
  if (pctFrac >= threshold) {
    return { trigger: true, reason: REASONS.THRESHOLD_CROSSED };
  }
```
Leave all other uses of `pct` (the null-check) alone.

- [ ] **Step 4: Run tests, verify pass + all pre-existing tests still pass**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.shouldCompact.test.js test/compactionTrigger.purity.test.js test/compactionTrigger.test.js`
Expected: ALL pass (the existing fraction-form tests work unchanged: `0.70 > 1` is false → `pctFrac = 0.70`, comparison identical; the new percent-form test passes).

- [ ] **Step 5: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/src/runtime/compactionTrigger/shouldCompact.js toad-local/test/compactionTrigger.shouldCompact.test.js && git -c commit.gpgsign=false commit -m "$(printf 'fix(compaction): shouldCompact tolerates both percent and fraction percentage forms (SP2 prework)\n\nComputeContextUsage returns one-decimal percent; resolveThresholdFromSettings + tests use fraction. The boundary normalization makes the comparison correct under both conventions, stopping the pre-SP2 misfire where any non-trivial percent value crossed any fraction threshold.\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: Claude extractor (codify existing logic, no behavior change)

**Files:**
- Create: `src/runtime/contextUsage/extractors/claudeExtractor.js`
- Test: `test/claudeExtractor.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/claudeExtractor.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLatestUsage } from '../src/runtime/contextUsage/extractors/claudeExtractor.js';

function ev(createdAt, eventType, raw) {
  return { eventType, createdAt, payload: { raw } };
}
function frame(usage, model = 'claude-sonnet-4-20250514') {
  return { type: 'result', subtype: 'success', model, usage };
}
const T0 = '2026-05-16T00:00:00.000Z';
const T1 = '2026-05-16T00:00:30.000Z';

test('extracts latest result frame; sums input/output + cache_read + cache_creation', () => {
  const events = [
    ev(T0, 'turn_completed', frame({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 })),
    ev(T1, 'turn_completed', frame({ input_tokens: 120, output_tokens: 60, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 })),
  ];
  const r = extractLatestUsage(events);
  assert.equal(r.used, 120 + 60 + 3000 + 0); // 3180
  assert.equal(r.model, 'claude-sonnet-4-20250514');
  assert.equal(r.lastUpdatedAt, T1);
  assert.equal(r.inFlight, false);
});

test('missing cache fields → silently 0', () => {
  const r = extractLatestUsage([ev(T0, 'turn_completed', frame({ input_tokens: 100, output_tokens: 50 }))]);
  assert.equal(r.used, 150);
});

test('non-numeric input or output → null (degraded)', () => {
  for (const bad of [
    { output_tokens: 50 },
    { input_tokens: 100 },
    { input_tokens: 'x', output_tokens: 50 },
  ]) {
    const r = extractLatestUsage([ev(T0, 'turn_completed', frame(bad))]);
    assert.equal(r, null, `bad usage=${JSON.stringify(bad)}`);
  }
});

test('no qualifying event (no turn_completed with type:result) → null', () => {
  assert.equal(extractLatestUsage([ev(T0, 'assistant_text', { type: 'assistant' })]), null);
  assert.equal(extractLatestUsage([]), null);
});

test('inFlight: a newer non-result event exists after the latest result frame', () => {
  const events = [
    ev(T0, 'turn_completed', frame({ input_tokens: 100, output_tokens: 50 })),
    ev(T1, 'assistant_text', { type: 'assistant' }),
  ];
  const r = extractLatestUsage(events);
  assert.equal(r.inFlight, true);
  assert.equal(r.lastUpdatedAt, T0);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/claudeExtractor.test.js`
Expected: FAIL — `Cannot find module '../src/runtime/contextUsage/extractors/claudeExtractor.js'`.

- [ ] **Step 3: Implement**

Create `src/runtime/contextUsage/extractors/claudeExtractor.js`:

```js
// Claude / Anthropic context-usage extractor. Codifies the original
// inline logic from computeContextUsage.js. Returns
// { used, model, lastUpdatedAt, inFlight } or null when no result
// frame exists or token counts are unusable.

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function extractLatestUsage(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  let resultEvt = null;
  let lastEventAt = null;
  for (const e of events) {
    if (e && typeof e.createdAt === 'string') {
      if (lastEventAt === null || e.createdAt > lastEventAt) lastEventAt = e.createdAt;
    }
    const raw = e && e.payload && e.payload.raw;
    if (e && e.eventType === 'turn_completed' && raw && raw.type === 'result'
        && typeof e.createdAt === 'string') {
      if (!resultEvt || e.createdAt >= resultEvt.createdAt) resultEvt = e;
    }
  }
  if (!resultEvt) return null;

  const raw = resultEvt.payload.raw;
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null;
  const u = raw.usage && typeof raw.usage === 'object' ? raw.usage : {};
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null || output === null) return null;
  const cacheRead = num(u.cache_read_input_tokens) ?? 0;
  const cacheCreate = num(u.cache_creation_input_tokens) ?? 0;
  const used = input + output + cacheRead + cacheCreate;
  const inFlight = lastEventAt !== null && lastEventAt > resultEvt.createdAt;
  return { used, model, lastUpdatedAt: resultEvt.createdAt, inFlight };
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/claudeExtractor.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/src/runtime/contextUsage/extractors/claudeExtractor.js toad-local/test/claudeExtractor.test.js && git -c commit.gpgsign=false commit -m "$(printf 'feat(sp2): claudeExtractor — codify inline Claude logic into registry shape (no behavior change)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: Extractor registry + wire computeContextUsage / getContextUsage to it

**Files:**
- Create: `src/runtime/contextUsage/extractorRegistry.js`
- Test: `test/extractorRegistry.test.js`
- Modify: `src/runtime/contextUsage/computeContextUsage.js`
- Modify: `src/runtime/contextUsage/getContextUsage.js`

Goal: route `computeContextUsage` through `getExtractor(providerId).extractLatestUsage(events)`; ALL existing tests (including `contextUsage.compute.test.js`'s 7 Claude tests and `contextUsage.getContextUsage.test.js`'s degraded-codex/gemini tests) MUST continue to pass — Codex/Gemini are still unknown until Tasks 4-6 register them.

- [ ] **Step 1: Write the failing registry test**

Create `test/extractorRegistry.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { getExtractor, PROVIDER_KEYS } from '../src/runtime/contextUsage/extractorRegistry.js';

test('Claude/Anthropic aliases resolve to the Claude extractor', () => {
  const a = getExtractor('claude');
  const b = getExtractor('anthropic');
  assert.ok(a && typeof a.extractLatestUsage === 'function');
  assert.equal(a, b, 'claude and anthropic share one extractor');
});

test('unknown provider → null', () => {
  assert.equal(getExtractor('openai'), null);
  assert.equal(getExtractor(''), null);
  assert.equal(getExtractor(undefined), null);
});

test('PROVIDER_KEYS includes the implemented providers and is frozen', () => {
  for (const k of ['claude', 'anthropic']) {
    assert.ok(PROVIDER_KEYS.includes(k), `missing key ${k}`);
  }
  assert.throws(() => { PROVIDER_KEYS.push('foo'); }, /Cannot|read.?only|extensible/i);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/extractorRegistry.test.js`
Expected: FAIL — `Cannot find module '../src/runtime/contextUsage/extractorRegistry.js'`.

- [ ] **Step 3: Implement the registry (Claude-only for now; Tasks 4-6 add the rest)**

Create `src/runtime/contextUsage/extractorRegistry.js`:

```js
import * as claudeExtractor from './extractors/claudeExtractor.js';

const REGISTRY = Object.freeze({
  claude:    claudeExtractor,
  anthropic: claudeExtractor,
  // codex/gemini/opencode added by SP2 Tasks 4-6.
});

export const PROVIDER_KEYS = Object.freeze(Object.keys(REGISTRY));

export function getExtractor(providerId) {
  if (typeof providerId !== 'string' || providerId.length === 0) return null;
  return REGISTRY[providerId] || null;
}
```

- [ ] **Step 4: Run registry test, verify PASS**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/extractorRegistry.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Modify computeContextUsage.js to dispatch via the registry**

In `src/runtime/contextUsage/computeContextUsage.js`, replace the file's contents entirely with:

```js
import { resolveContextWindow } from './modelContextWindow.js';
import { getExtractor } from './extractorRegistry.js';

/**
 * Pure: a single runtime's event-log rows → the context-usage snapshot.
 * "used" is the LATEST result-frame occupancy, never a Σ over turns
 * (design §2 Bug 1). `stale` is idle-not-in-flight (design §3): a turn
 * is "in flight" when any event is newer than the last result frame.
 * Per-provider extraction is delegated to the extractor registry.
 *
 * @param {object} a
 * @param {Array}  a.events       runtime-event-log rows ({eventType,createdAt,payload:{raw}})
 * @param {number} a.now          Date.now()-style ms
 * @param {number} a.stalenessMs  idle window before stale (default 60000)
 * @param {string} a.providerId   the runtime's provider
 */
export function computeContextUsage({ events, now, stalenessMs = 60_000, providerId = 'unknown' } = {}) {
  const degraded = (model = null) => ({
    used: null, total: null, percentage: null,
    model, provider: providerId,
    lastUpdatedAt: null, stale: true, source: 'unknown',
  });

  const extractor = getExtractor(providerId);
  if (!extractor) return degraded();
  if (!Array.isArray(events) || events.length === 0) return degraded();

  const x = extractor.extractLatestUsage(events);
  if (!x) return degraded();

  const { used, model, lastUpdatedAt, inFlight } = x;
  const idleMs = now - Date.parse(lastUpdatedAt);
  const stale = !inFlight && Number.isFinite(idleMs) && idleMs > stalenessMs;
  const total = resolveContextWindow(model);
  if (total === null) {
    return { used, total: null, percentage: null, model, provider: providerId, lastUpdatedAt, stale, source: 'unknown' };
  }
  const percentage = Math.round((used / total) * 1000) / 10;
  return { used, total, percentage, model, provider: providerId, lastUpdatedAt, stale, source: 'precise' };
}
```

- [ ] **Step 6: Modify getContextUsage.js to derive IMPLEMENTED from registry keys**

In `src/runtime/contextUsage/getContextUsage.js`, replace:
```js
const DEFAULT_STALENESS_MS = 60_000;
// Providers with a real B implementation. Codex/Gemini are NAMED-
// DEFERRED slots (design §4): the interface stays agnostic and
// empty-slot-safe (degraded shape, never throws) until a parser lands.
const IMPLEMENTED = new Set(['claude', 'anthropic']);
```
with:
```js
import { PROVIDER_KEYS } from './extractorRegistry.js';

const DEFAULT_STALENESS_MS = 60_000;
// IMPLEMENTED is the single-source registry-keys set. Genuinely-unknown
// providers (anything not in the registry) return degraded.
const IMPLEMENTED = new Set(PROVIDER_KEYS);
```
Add the import at the top of the file (alongside the existing `import { computeContextUsage }`). Leave the rest of the file unchanged.

- [ ] **Step 7: Run ALL contextUsage suites + the regression guard**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/contextUsage.compute.test.js test/contextUsage.getContextUsage.test.js test/contextUsage.modelWindow.test.js test/contextUsage.facade.test.js test/contextUsage.regressionGuard.test.js test/claudeExtractor.test.js test/extractorRegistry.test.js`
Expected: ALL pass. Claude path is byte-equivalent (same fields, same math); codex/gemini still degrade (registry has no codex/gemini entries yet → `getExtractor` returns null → degraded shape).

- [ ] **Step 8: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/src/runtime/contextUsage/extractorRegistry.js toad-local/src/runtime/contextUsage/computeContextUsage.js toad-local/src/runtime/contextUsage/getContextUsage.js toad-local/test/extractorRegistry.test.js && git -c commit.gpgsign=false commit -m "$(printf 'feat(sp2): extractor registry + dispatcher in computeContextUsage (Claude only registered)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: Codex extractor

**Files:**
- Create: `src/runtime/contextUsage/extractors/codexExtractor.js`
- Test: `test/codexExtractor.test.js`
- Modify: `src/runtime/contextUsage/extractorRegistry.js`

Reference: `test/codex/normalizeCodexExecLine.test.js:78` confirms Codex's normalized `usage` shape: `{ input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }`. Codex's `turn_completed` carries this in `payload.raw.usage`; `raw.type` is NOT `'result'` (that's Claude's identifier).

- [ ] **Step 1: Write the failing test**

Create `test/codexExtractor.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLatestUsage } from '../src/runtime/contextUsage/extractors/codexExtractor.js';

function ev(createdAt, eventType, raw) {
  return { eventType, createdAt, payload: { raw } };
}
const T0 = '2026-05-16T00:00:00.000Z';
const T1 = '2026-05-16T00:00:30.000Z';

test('Codex turn_completed: input + output + cached + reasoning', () => {
  const events = [
    ev(T0, 'turn_completed', { usage: { input_tokens: 57114, cached_input_tokens: 30848, output_tokens: 568, reasoning_output_tokens: 377 }, model: 'gpt-5-codex' }),
  ];
  const r = extractLatestUsage(events);
  assert.equal(r.used, 57114 + 568 + 30848 + 377); // 88907
  assert.equal(r.model, 'gpt-5-codex');
  assert.equal(r.lastUpdatedAt, T0);
  assert.equal(r.inFlight, false);
});

test('missing cached/reasoning → silently 0', () => {
  const r = extractLatestUsage([ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50 }, model: 'gpt-5-codex' })]);
  assert.equal(r.used, 150);
});

test('latest turn_completed wins', () => {
  const events = [
    ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50 }, model: 'gpt-5-codex' }),
    ev(T1, 'turn_completed', { usage: { input_tokens: 200, output_tokens: 80 }, model: 'gpt-5-codex' }),
  ];
  assert.equal(extractLatestUsage(events).used, 280);
});

test('missing or non-numeric input/output → null', () => {
  for (const bad of [
    { output_tokens: 50 },
    { input_tokens: 100 },
    { input_tokens: 'x', output_tokens: 50 },
    {}, // no usage fields
  ]) {
    assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { usage: bad })]), null, `bad=${JSON.stringify(bad)}`);
  }
});

test('no usage object at all → null', () => {
  assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { model: 'gpt-5-codex' })]), null);
});

test('no qualifying event → null', () => {
  assert.equal(extractLatestUsage([ev(T0, 'assistant_text', { type: 'assistant' })]), null);
  assert.equal(extractLatestUsage([]), null);
});

test('inFlight: newer non-result event after the last turn_completed', () => {
  const events = [
    ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50 }, model: 'gpt-5-codex' }),
    ev(T1, 'assistant_text', { type: 'assistant' }),
  ];
  assert.equal(extractLatestUsage(events).inFlight, true);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/codexExtractor.test.js`
Expected: FAIL — `Cannot find module '../src/runtime/contextUsage/extractors/codexExtractor.js'`.

- [ ] **Step 3: Implement**

Create `src/runtime/contextUsage/extractors/codexExtractor.js`:

```js
// Codex context-usage extractor. Codex's normalizer emits
// turn_completed with payload.raw.usage =
// { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens }.
// `reasoning_output_tokens` is Codex's reasoning-tier accounting and
// IS part of context occupancy — sum it.

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function extractLatestUsage(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  let resultEvt = null;
  let lastEventAt = null;
  for (const e of events) {
    if (e && typeof e.createdAt === 'string') {
      if (lastEventAt === null || e.createdAt > lastEventAt) lastEventAt = e.createdAt;
    }
    const raw = e && e.payload && e.payload.raw;
    if (e && e.eventType === 'turn_completed' && raw && raw.usage && typeof raw.usage === 'object'
        && typeof e.createdAt === 'string') {
      if (!resultEvt || e.createdAt >= resultEvt.createdAt) resultEvt = e;
    }
  }
  if (!resultEvt) return null;

  const raw = resultEvt.payload.raw;
  const u = raw.usage;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null || output === null) return null;
  const cached = num(u.cached_input_tokens) ?? 0;
  const reasoning = num(u.reasoning_output_tokens) ?? 0;
  const used = input + output + cached + reasoning;
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null;
  const inFlight = lastEventAt !== null && lastEventAt > resultEvt.createdAt;
  return { used, model, lastUpdatedAt: resultEvt.createdAt, inFlight };
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/codexExtractor.test.js`
Expected: PASS — 7 tests.

- [ ] **Step 5: Register codex in the registry**

In `src/runtime/contextUsage/extractorRegistry.js`, add the import alongside the existing claudeExtractor import:
```js
import * as codexExtractor from './extractors/codexExtractor.js';
```
And add to the REGISTRY object (after `anthropic`):
```js
  codex:     codexExtractor,
```

- [ ] **Step 6: Re-run registry + getContextUsage tests; expect ONE breakage (the empty-slot guard) — but defer fixing it to Task 8**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/extractorRegistry.test.js test/contextUsage.getContextUsage.test.js`
Expected: `extractorRegistry.test.js` PASSES (codex extractor now resolves). `contextUsage.getContextUsage.test.js` MAY now have a failure in the existing test `'empty-slot safety: codex/gemini provider → degraded shape, never throws (deferred slots)'` — for `providerId: 'codex'` it no longer degrades because the registry has it now BUT the eventLog injected is empty → `extractLatestUsage([]) === null` → `computeContextUsage` returns degraded → test still passes for now. If it does fail, **STOP and report DONE_WITH_CONCERNS** — do not modify that test in this task (Task 8 owns the guard rewrite, in one place).

Realistically: the existing test injects a `fakeRegistry` with one runtime but never injects any events, so `events.length === 0` → degraded → existing test still asserts `provider === providerId`, no breakage. Tasks 5/6 are analogous.

- [ ] **Step 7: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/src/runtime/contextUsage/extractors/codexExtractor.js toad-local/src/runtime/contextUsage/extractorRegistry.js toad-local/test/codexExtractor.test.js && git -c commit.gpgsign=false commit -m "$(printf 'feat(sp2): codexExtractor + register codex (input+output+cached+reasoning)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: Gemini extractor

**Files:**
- Create: `src/runtime/contextUsage/extractors/geminiExtractor.js`
- Test: `test/geminiExtractor.test.js`
- Modify: `src/runtime/contextUsage/extractorRegistry.js`

Reference: `test/gemini/normalizeGeminiStreamLine.test.js:59-65` confirms Gemini's normalized `usage` shape: `{ input_tokens, output_tokens }` (no cache fields surfaced). Gemini's `turn_completed` carries this in `payload.raw.usage`; `raw.type === 'result'` per the SP1b grounding event vocab.

- [ ] **Step 1: Write the failing test**

Create `test/geminiExtractor.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLatestUsage } from '../src/runtime/contextUsage/extractors/geminiExtractor.js';

function ev(createdAt, eventType, raw) {
  return { eventType, createdAt, payload: { raw } };
}
const T0 = '2026-05-16T00:00:00.000Z';
const T1 = '2026-05-16T00:00:30.000Z';

test('Gemini turn_completed/result: input + output (no cache fields)', () => {
  const r = extractLatestUsage([
    ev(T0, 'turn_completed', { type: 'result', usage: { input_tokens: 1500, output_tokens: 300 }, model: 'gemini-2.5-pro' }),
  ]);
  assert.equal(r.used, 1800);
  assert.equal(r.model, 'gemini-2.5-pro');
  assert.equal(r.lastUpdatedAt, T0);
  assert.equal(r.inFlight, false);
});

test('any present cache-like field is IGNORED (Gemini does not surface them)', () => {
  // Defensive: even if a future Gemini version emits cache_*, this
  // extractor's contract is input+output only (silent 0 for cache).
  const r = extractLatestUsage([
    ev(T0, 'turn_completed', { type: 'result', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 9999 }, model: 'gemini-2.5-pro' }),
  ]);
  assert.equal(r.used, 150);
});

test('latest event wins', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { type: 'result', usage: { input_tokens: 100, output_tokens: 50 }, model: 'gemini-2.5-pro' }),
    ev(T1, 'turn_completed', { type: 'result', usage: { input_tokens: 200, output_tokens: 80 }, model: 'gemini-2.5-pro' }),
  ]).used, 280);
});

test('missing/non-numeric tokens → null', () => {
  for (const bad of [
    { output_tokens: 50 },
    { input_tokens: 100 },
    { input_tokens: 'x', output_tokens: 50 },
  ]) {
    assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { type: 'result', usage: bad })]), null);
  }
});

test('no usage → null', () => {
  assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { type: 'result' })]), null);
  assert.equal(extractLatestUsage([]), null);
});

test('inFlight: newer non-result event after last result', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { type: 'result', usage: { input_tokens: 100, output_tokens: 50 } }),
    ev(T1, 'assistant_text', { type: 'assistant' }),
  ]).inFlight, true);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/geminiExtractor.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/runtime/contextUsage/extractors/geminiExtractor.js`:

```js
// Gemini context-usage extractor. Gemini's SP1b normalizer emits
// turn_completed with payload.raw = { type:'result', usage:{input_tokens,output_tokens}, ... }.
// No cache fields surface through Gemini's result.stats — input+output only.

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function extractLatestUsage(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  let resultEvt = null;
  let lastEventAt = null;
  for (const e of events) {
    if (e && typeof e.createdAt === 'string') {
      if (lastEventAt === null || e.createdAt > lastEventAt) lastEventAt = e.createdAt;
    }
    const raw = e && e.payload && e.payload.raw;
    if (e && e.eventType === 'turn_completed' && raw && raw.type === 'result'
        && raw.usage && typeof raw.usage === 'object'
        && typeof e.createdAt === 'string') {
      if (!resultEvt || e.createdAt >= resultEvt.createdAt) resultEvt = e;
    }
  }
  if (!resultEvt) return null;

  const raw = resultEvt.payload.raw;
  const u = raw.usage;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null || output === null) return null;
  const used = input + output; // no cache fields for Gemini
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null;
  const inFlight = lastEventAt !== null && lastEventAt > resultEvt.createdAt;
  return { used, model, lastUpdatedAt: resultEvt.createdAt, inFlight };
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/geminiExtractor.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Register gemini**

In `src/runtime/contextUsage/extractorRegistry.js`, add:
```js
import * as geminiExtractor from './extractors/geminiExtractor.js';
```
and in REGISTRY (after `codex`):
```js
  gemini:    geminiExtractor,
```

- [ ] **Step 6: Re-run contextUsage suites (no expected breakage)**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/geminiExtractor.test.js test/extractorRegistry.test.js test/contextUsage.getContextUsage.test.js`
Expected: ALL pass (same reasoning as Task 4 Step 6 — the existing empty-slot test never injects events, so degraded shape still returned).

- [ ] **Step 7: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/src/runtime/contextUsage/extractors/geminiExtractor.js toad-local/src/runtime/contextUsage/extractorRegistry.js toad-local/test/geminiExtractor.test.js && git -c commit.gpgsign=false commit -m "$(printf 'feat(sp2): geminiExtractor + register gemini (input+output, no cache)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: OpenCode extractor

**Files:**
- Create: `src/runtime/contextUsage/extractors/opencodeExtractor.js`
- Test: `test/opencodeExtractor.test.js`
- Modify: `src/runtime/contextUsage/extractorRegistry.js`

Reference: `test/opencode/normalizeOpencodeStreamLine.test.js:51-62` confirms OpenCode's `step_finish.part.tokens = { input, output, total, reasoning, cache: { write, read } }` is aliased into normalized `payload.raw.usage = { input_tokens, output_tokens, cached_input_tokens? }` on `turn_completed`. Cache field may or may not be aliased — extractor treats absent as silent 0.

- [ ] **Step 1: Write the failing test**

Create `test/opencodeExtractor.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractLatestUsage } from '../src/runtime/contextUsage/extractors/opencodeExtractor.js';

function ev(createdAt, eventType, raw) {
  return { eventType, createdAt, payload: { raw } };
}
const T0 = '2026-05-16T00:00:00.000Z';
const T1 = '2026-05-16T00:00:30.000Z';

test('OpenCode turn_completed: input + output + cached (when present)', () => {
  const r = extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { input_tokens: 5, output_tokens: 2, cached_input_tokens: 3 }, model: 'qwen-coder' }),
  ]);
  assert.equal(r.used, 5 + 2 + 3);
  assert.equal(r.model, 'qwen-coder');
});

test('missing cached → silently 0', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50 }, model: 'qwen-coder' }),
  ]).used, 150);
});

test('latest event wins', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { input_tokens: 100, output_tokens: 50 } }),
    ev(T1, 'turn_completed', { usage: { input_tokens: 200, output_tokens: 80 } }),
  ]).used, 280);
});

test('missing/non-numeric tokens → null', () => {
  for (const bad of [
    { output_tokens: 50 },
    { input_tokens: 100 },
    { input_tokens: 'x', output_tokens: 50 },
  ]) {
    assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { usage: bad })]), null);
  }
});

test('no usage / no events → null', () => {
  assert.equal(extractLatestUsage([ev(T0, 'turn_completed', { model: 'qwen-coder' })]), null);
  assert.equal(extractLatestUsage([]), null);
});

test('inFlight detection', () => {
  assert.equal(extractLatestUsage([
    ev(T0, 'turn_completed', { usage: { input_tokens: 5, output_tokens: 2 } }),
    ev(T1, 'assistant_text', { type: 'assistant' }),
  ]).inFlight, true);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/opencodeExtractor.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/runtime/contextUsage/extractors/opencodeExtractor.js`:

```js
// OpenCode context-usage extractor. The SP1c normalizer aliases
// native step_finish.part.tokens.{input,output,cache.read} into
// payload.raw.usage.{input_tokens, output_tokens, cached_input_tokens?}
// on turn_completed.

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function extractLatestUsage(events) {
  if (!Array.isArray(events) || events.length === 0) return null;
  let resultEvt = null;
  let lastEventAt = null;
  for (const e of events) {
    if (e && typeof e.createdAt === 'string') {
      if (lastEventAt === null || e.createdAt > lastEventAt) lastEventAt = e.createdAt;
    }
    const raw = e && e.payload && e.payload.raw;
    if (e && e.eventType === 'turn_completed' && raw && raw.usage && typeof raw.usage === 'object'
        && typeof e.createdAt === 'string') {
      if (!resultEvt || e.createdAt >= resultEvt.createdAt) resultEvt = e;
    }
  }
  if (!resultEvt) return null;

  const raw = resultEvt.payload.raw;
  const u = raw.usage;
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  if (input === null || output === null) return null;
  const cached = num(u.cached_input_tokens) ?? 0;
  const used = input + output + cached;
  const model = typeof raw.model === 'string' && raw.model.length > 0 ? raw.model : null;
  const inFlight = lastEventAt !== null && lastEventAt > resultEvt.createdAt;
  return { used, model, lastUpdatedAt: resultEvt.createdAt, inFlight };
}
```

- [ ] **Step 4: Run, verify PASS**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/opencodeExtractor.test.js`
Expected: PASS — 6 tests.

- [ ] **Step 5: Register opencode**

In `src/runtime/contextUsage/extractorRegistry.js`, add:
```js
import * as opencodeExtractor from './extractors/opencodeExtractor.js';
```
and in REGISTRY (after `gemini`):
```js
  opencode:  opencodeExtractor,
```

- [ ] **Step 6: Re-run**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/opencodeExtractor.test.js test/extractorRegistry.test.js test/contextUsage.getContextUsage.test.js test/contextUsage.compute.test.js`
Expected: ALL pass.

- [ ] **Step 7: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/src/runtime/contextUsage/extractors/opencodeExtractor.js toad-local/src/runtime/contextUsage/extractorRegistry.js toad-local/test/opencodeExtractor.test.js && git -c commit.gpgsign=false commit -m "$(printf 'feat(sp2): opencodeExtractor + register opencode (input+output+cached)\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7: Provider compaction-threshold map + CompactionTrigger wiring

**Files:**
- Create: `src/runtime/compactionTrigger/providerThresholds.js`
- Test: `test/providerThresholds.test.js`
- Modify: `src/runtime/compactionTrigger/CompactionTrigger.js`

- [ ] **Step 1: Write the failing test**

Create `test/providerThresholds.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_COMPACTION_THRESHOLDS,
  DEFAULT_THRESHOLD,
  getProviderThreshold,
} from '../src/runtime/compactionTrigger/providerThresholds.js';

test('per-provider thresholds match memory-grounded values', () => {
  assert.equal(PROVIDER_COMPACTION_THRESHOLDS.claude.trigger, 0.65);
  assert.equal(PROVIDER_COMPACTION_THRESHOLDS.anthropic.trigger, 0.65);
  assert.equal(PROVIDER_COMPACTION_THRESHOLDS.codex.trigger, 0.70);
  assert.equal(PROVIDER_COMPACTION_THRESHOLDS.gemini.trigger, 0.60);
  assert.equal(PROVIDER_COMPACTION_THRESHOLDS.opencode.trigger, 0.70);
});

test('frozen — cannot mutate', () => {
  assert.throws(() => { PROVIDER_COMPACTION_THRESHOLDS.claude = {}; }, /Cannot|read.?only/i);
  assert.throws(() => { DEFAULT_THRESHOLD.trigger = 0.5; }, /Cannot|read.?only/i);
});

test('getProviderThreshold(known) → provider entry', () => {
  assert.equal(getProviderThreshold('claude').trigger, 0.65);
  assert.equal(getProviderThreshold('opencode').trigger, 0.70);
});

test('getProviderThreshold(unknown) → DEFAULT_THRESHOLD', () => {
  assert.equal(getProviderThreshold('openai'), DEFAULT_THRESHOLD);
  assert.equal(getProviderThreshold(''), DEFAULT_THRESHOLD);
  assert.equal(getProviderThreshold(undefined), DEFAULT_THRESHOLD);
});
```

- [ ] **Step 2: Run, verify FAIL**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/providerThresholds.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the threshold map**

Create `src/runtime/compactionTrigger/providerThresholds.js`:

```js
// Per-provider compaction thresholds. Sources:
//  - claude/anthropic: existing project default (DEFAULT_THRESHOLD in
//    CompactionTrigger.js was 0.70 historically, but the memory-grounded
//    Claude trigger is 0.65 — auto-compact at ~85% is the Claude CLI's
//    OWN internal behavior, not ours).
//  - codex: 0.70 (Codex CLI's own /compact tier kicks in around 70%
//    grounded behavior).
//  - gemini: 0.60 (chatCompression.contextPercentageThreshold default).
//  - opencode: 0.70 (conservative; mirror codex until upstream documents).

export const PROVIDER_COMPACTION_THRESHOLDS = Object.freeze({
  claude:    Object.freeze({ trigger: 0.65 }),
  anthropic: Object.freeze({ trigger: 0.65 }),
  codex:     Object.freeze({ trigger: 0.70 }),
  gemini:    Object.freeze({ trigger: 0.60 }),
  opencode:  Object.freeze({ trigger: 0.70 }),
});

export const DEFAULT_THRESHOLD = Object.freeze({ trigger: 0.70 });

export function getProviderThreshold(providerId) {
  if (typeof providerId !== 'string' || providerId.length === 0) return DEFAULT_THRESHOLD;
  return PROVIDER_COMPACTION_THRESHOLDS[providerId] || DEFAULT_THRESHOLD;
}
```

> **Threshold-change note:** Claude's `trigger` moves from the pre-SP2
> wired value of `0.70` (in `resolveThresholdFromSettings.DEFAULT_THRESHOLD`
> at `CompactionTrigger.js:5`) to `0.65` (memory-grounded). Users who set
> `compaction.claude.threshold` in their settings file override this
> verbatim (Step 4 preserves that). The behavior change is intentional —
> aligns with the memory's documented Claude trigger of ~65%.

- [ ] **Step 4: Run, verify PASS**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/providerThresholds.test.js`
Expected: PASS — 4 tests.

- [ ] **Step 5: Wire CompactionTrigger to use per-provider thresholds**

In `src/runtime/compactionTrigger/CompactionTrigger.js`:

(a) Add import at the top (after the existing `import { shouldCompact, REASONS } from './shouldCompact.js';`):
```js
import { getProviderThreshold, DEFAULT_THRESHOLD as PROVIDER_DEFAULT_THRESHOLD } from './providerThresholds.js';
```

(b) Replace the top-level `const DEFAULT_THRESHOLD = 0.70;` line (line 3) with:
```js
const DEFAULT_THRESHOLD = PROVIDER_DEFAULT_THRESHOLD.trigger;
```

(c) Replace `resolveThresholdFromSettings` entirely:
```js
/**
 * Resolve the per-provider compaction threshold from SettingsStore.
 * `compaction` section: { compaction: { <providerId>: { threshold: <0..1> } } }.
 * Falls back to providerThresholds.js per-provider default, then to
 * DEFAULT_THRESHOLD. Always returns a finite fraction; never throws.
 */
export async function resolveThresholdFromSettings(settingsStore, providerId) {
  try {
    if (settingsStore && typeof settingsStore.readEffective === 'function') {
      const eff = await settingsStore.readEffective();
      const t = eff && eff.compaction && eff.compaction[providerId]
        ? eff.compaction[providerId].threshold : undefined;
      if (typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= 1) return t;
    }
  } catch { /* swallow */ }
  return getProviderThreshold(providerId).trigger;
}
```

(d) In `onTurnCompleted` (around line 69-84), change the threshold lookup to thread `usage.provider`:
```js
  async onTurnCompleted(event) {
    if (!event || !event.runtimeId) return;
    const state = this.#state(event.runtimeId);
    const usage = this.getContextUsage(event.agentId, { teamId: event.teamId });
    const threshold = this.getThreshold ? await this.getThreshold(usage.provider) : getProviderThreshold(usage.provider).trigger;
    const verdict = shouldCompact({ usage, threshold, state, now: this.now() });
    // ... rest unchanged
```
(Only those two lines change: the threshold lookup. Leave the verdict-handling/firing logic untouched.)

- [ ] **Step 6: Re-run existing compaction tests**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/compactionTrigger.test.js test/compactionTrigger.shouldCompact.test.js test/compactionTrigger.purity.test.js test/runtimeEventIngestor.compactionTrigger.test.js test/localToadRuntime.compactionTrigger.test.js`
Expected: ALL pass. The existing tests inject `getThreshold = async () => 0.70` (no provider arg), which now receives one but ignores it — works unchanged. The existing test at line 133 of `compactionTrigger.test.js` (`provider:'codex'` with `source:'unknown'`) still asserts no-fire because shouldCompact's `source:'unknown'` branch fires first.

If any existing test fails because it now sees a different threshold (e.g., a test that injected `resolveThresholdFromSettings` indirectly), STOP and report which one — but per the wiring above, no internal change to existing tests' contracts should occur.

- [ ] **Step 7: Wire suites + commit**

Append to `scripts/test-suites.txt` (single line, end of file):
```
 && node --no-warnings --test test/providerThresholds.test.js
```
Verify still one line: `cd /c/Project-TOAD/toad-local && node -e "console.log('lines:', require('fs').readFileSync('scripts/test-suites.txt','utf8').split(String.fromCharCode(10)).filter(Boolean).length)"` → expect `lines: 1`.

```bash
cd /c/Project-TOAD && git add toad-local/src/runtime/compactionTrigger/providerThresholds.js toad-local/src/runtime/compactionTrigger/CompactionTrigger.js toad-local/test/providerThresholds.test.js toad-local/scripts/test-suites.txt && git -c commit.gpgsign=false commit -m "$(printf 'feat(sp2): per-provider compaction thresholds + provider-aware resolveThresholdFromSettings\n\nClaude trigger now 0.65 (memory-grounded; was 0.70 default). Codex/Gemini/OpenCode trigger 0.70/0.60/0.70 respectively. Settings file shape unchanged (per-provider key path).\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 8: Empty-slot guard rewrite + per-provider integration tests

**Files:**
- Modify: `test/contextUsage.getContextUsage.test.js`
- Modify: `scripts/test-suites.txt` (append the 4 new extractor suites)

- [ ] **Step 1: Write the new per-provider precise tests + narrow the existing guard**

Read the file first to find the existing test at line 31:
```js
test('empty-slot safety: codex/gemini provider → degraded shape, never throws (deferred slots)', () => {
  for (const providerId of ['codex', 'gemini', 'openai', 'anything']) { ... }
});
```

Replace this single test with the following block:

```js
test('empty-slot safety: genuinely-unknown provider → degraded shape, never throws', () => {
  // Narrowed from ['codex','gemini','openai','anything'] — codex/gemini/
  // opencode are now implemented (SP2). The guard locks the seam invariant
  // for any future genuinely-unknown provider.
  for (const providerId of ['openai', 'anything']) {
    const reg = fakeRegistry([{ runtimeId: 'rt', agentId: 'a', providerId, status: 'running', startedAt: '2026-05-16T00:00:00Z' }]);
    const r = getContextUsage('a', { teamId: 'T', runtimeRegistry: reg, eventLog: fakeEventLog({}), settings: {}, now: Date.now() });
    assert.equal(r.provider, providerId);
    assert.equal(r.source, 'unknown');
    assert.equal(r.used, null);
    assert.equal(r.total, null);
    assert.equal(r.percentage, null);
  }
});

test('codex precise: events with usage → source:precise, used = sum of fields', () => {
  const reg = fakeRegistry([{ runtimeId: 'rt-c', agentId: 'a', providerId: 'codex', status: 'running', startedAt: '2026-05-16T00:00:00Z' }]);
  const log = fakeEventLog({
    'rt-c': [{ eventType: 'turn_completed', createdAt: '2026-05-16T00:00:10Z', payload: { raw: { usage: { input_tokens: 100, output_tokens: 50, cached_input_tokens: 20, reasoning_output_tokens: 10 }, model: 'gpt-5-codex' } } }],
  });
  const r = getContextUsage('a', { teamId: 'T', runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.parse('2026-05-16T00:00:20Z') });
  assert.equal(r.provider, 'codex');
  assert.equal(r.source, 'precise');
  assert.equal(r.used, 180);
  assert.equal(r.model, 'gpt-5-codex');
});

test('gemini precise: events with usage → source:precise, used = input+output (no cache)', () => {
  const reg = fakeRegistry([{ runtimeId: 'rt-g', agentId: 'a', providerId: 'gemini', status: 'running', startedAt: '2026-05-16T00:00:00Z' }]);
  const log = fakeEventLog({
    'rt-g': [{ eventType: 'turn_completed', createdAt: '2026-05-16T00:00:10Z', payload: { raw: { type: 'result', usage: { input_tokens: 1000, output_tokens: 200 }, model: 'gemini-2.5-pro' } } }],
  });
  const r = getContextUsage('a', { teamId: 'T', runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.parse('2026-05-16T00:00:20Z') });
  assert.equal(r.provider, 'gemini');
  assert.equal(r.source, 'precise');
  assert.equal(r.used, 1200);
  assert.equal(r.model, 'gemini-2.5-pro');
});

test('opencode precise: events with usage → source:precise, used = input+output+cached', () => {
  const reg = fakeRegistry([{ runtimeId: 'rt-o', agentId: 'a', providerId: 'opencode', status: 'running', startedAt: '2026-05-16T00:00:00Z' }]);
  const log = fakeEventLog({
    'rt-o': [{ eventType: 'turn_completed', createdAt: '2026-05-16T00:00:10Z', payload: { raw: { usage: { input_tokens: 5, output_tokens: 2, cached_input_tokens: 3 }, model: 'qwen-coder' } } }],
  });
  const r = getContextUsage('a', { teamId: 'T', runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.parse('2026-05-16T00:00:20Z') });
  assert.equal(r.provider, 'opencode');
  assert.equal(r.source, 'precise');
  assert.equal(r.used, 10);
  assert.equal(r.model, 'qwen-coder');
});
```

> If the existing test file does not already have a `fakeEventLog`
> helper, define one near the top of the test file (alongside the
> existing `fakeRegistry`):
> ```js
> function fakeEventLog(byRuntime) {
>   return { listEvents: ({ runtimeId }) => byRuntime[runtimeId] || [] };
> }
> ```
> (Read the file before editing to confirm the helper's actual name —
> it may already exist as `makeLog` or similar; reuse the existing
> helper if so.)

- [ ] **Step 2: Run, verify PASS (all extractors now active)**

Run: `cd /c/Project-TOAD/toad-local && node --no-warnings --test test/contextUsage.getContextUsage.test.js`
Expected: PASS — narrowed guard test + 3 new per-provider precise tests + all pre-existing tests.

- [ ] **Step 3: Wire the 4 new extractor suites into the regression chain**

Append to `scripts/test-suites.txt` (single line, end of file):
```
 && node --no-warnings --test test/claudeExtractor.test.js && node --no-warnings --test test/codexExtractor.test.js && node --no-warnings --test test/geminiExtractor.test.js && node --no-warnings --test test/opencodeExtractor.test.js && node --no-warnings --test test/extractorRegistry.test.js
```
Verify still one line: `cd /c/Project-TOAD/toad-local && node -e "console.log('lines:', require('fs').readFileSync('scripts/test-suites.txt','utf8').split(String.fromCharCode(10)).filter(Boolean).length)"` → expect `lines: 1`.

- [ ] **Step 4: Commit**

```bash
cd /c/Project-TOAD && git add toad-local/test/contextUsage.getContextUsage.test.js toad-local/scripts/test-suites.txt && git -c commit.gpgsign=false commit -m "$(printf 'test(sp2): empty-slot guard narrowed + per-provider precise integration tests; suites wired\n\nCo-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>')"
```

---

## Task 9: Whole-implementation verification & scope-proof

**Files:** none (verification only).

- [ ] **Step 1: Full backend regression chain against the COMMITTED tree**

The working tree carries the foreign Notion-B WIP (untracked `geminiUsageProbe.js`, modified `LocalToadRuntime.js` with foreign import, modified `PlanUsagePanel.tsx` / `App.tsx`). Run the gate against committed state — the IDE-2 procedure:

```bash
cd /c/Project-TOAD/toad-local
cp src/tools/localToolFacade.js /tmp/ltf.foreignwip.bak 2>/dev/null || true
git show HEAD:toad-local/src/tools/localToolFacade.js > src/tools/localToolFacade.js
bash -c "$(cat scripts/test-suites.txt)"; echo "GATE_EXIT=$?"
cp /tmp/ltf.foreignwip.bak src/tools/localToolFacade.js 2>/dev/null || git checkout HEAD -- src/tools/localToolFacade.js
```
Expected: `GATE_EXIT=0`. The 6 new SP2 suites all run green (4 extractor + 1 registry + 1 providerThresholds), plus `contextUsage.getContextUsage.test.js` with its new per-provider tests, plus `compactionTrigger.shouldCompact.test.js` with the new percent-form test. Total suite count grows by 6 vs HEAD before SP2.

> NOTE: SP2 does NOT touch `LocalToadRuntime.js` (that file's working-tree foreign import remains untouched as the standing Notion-B WIP). The `git checkout HEAD -- src/tools/localToolFacade.js` fallback above is belt-and-suspenders — IDE-2 verified the facade is currently clean (== HEAD), so the cp/restore is also fine.

- [ ] **Step 2: Scope-proof — required files byte-unchanged**

```bash
cd /c/Project-TOAD/toad-local
git diff --stat <SP2_BASE_SHA>..HEAD -- \
  ui/src/App.tsx \
  ui/src/components/cockpit/CockpitScreenV2.tsx \
  ui/src/hooks/useTweaks.ts \
  ui/src/components/cockpit/CockpitForMe.tsx \
  ui/src/components/cockpit/CockpitWithMe.tsx \
  ui/src/components/Statusbar.tsx \
  ui/src/components/PlanUsagePanel.tsx \
  src/app/LocalToadRuntime.js \
  src/tools/localToolFacade.js
```
(Where `<SP2_BASE_SHA>` is the commit immediately before Task 1's commit — i.e., the spec commit's HEAD: `ba11a0e6`.)

Expected: **empty output**. If anything appears, revert that hunk — SP2 must stay backend-internal.

Additionally confirm no Notion-B foreign-WIP file was touched:
```bash
git diff --name-only <SP2_BASE_SHA>..HEAD -- toad-local/ui toad-local/src/providers
```
Expected: empty (Statusbar/UI/providers/all-of-ui not touched).

- [ ] **Step 3: Confirm the IDE-2-era foreign-WIP files remain not-ours**

```bash
git status --porcelain | grep -E "geminiUsageProbe\.js|PlanUsagePanel\.tsx|LocalToadRuntime\.js|App\.tsx" | sort
```
Expected: SAME working-tree state as at SP2 start — `?? toad-local/src/providers/geminiUsageProbe.js`, `M toad-local/src/app/LocalToadRuntime.js`, `M toad-local/ui/src/App.tsx`, `M toad-local/ui/src/components/PlanUsagePanel.tsx`. Untouched by SP2.

- [ ] **Step 4: UI typecheck (sanity)**

Run: `cd /c/Project-TOAD/toad-local/ui && npm run typecheck`
Expected: same two pre-existing foreign `App.tsx` `SummaryStatus.quota` errors and ZERO others. (SP2 doesn't touch UI — there should be no change in typecheck output vs. session start.)

- [ ] **Step 5: Final whole-implementation code review**

Per subagent-driven-development, dispatch the final code-reviewer over the SP2 commit range `<SP2_BASE_SHA>..HEAD` (8 commits). Verify: extractor correctness across the 4 providers (Codex's `reasoning_output_tokens` summation, Gemini's no-cache rule, OpenCode's optional cached field, Claude path byte-equivalent), registry single-source for `IMPLEMENTED`, the `shouldCompact` unit-normalization fix is correct under both unit conventions, per-provider threshold map values match memory, settings-file shape preserved, no UI / Notion-B / foreign-WIP collateral. Address Critical/Important before proceeding.

- [ ] **Step 6: Hand off to finishing-a-development-branch**

All tasks complete and reviewed → invoke superpowers:finishing-a-development-branch. Then update memory:
- `multi_provider_runtime_program.md` — mark SP2 DONE with the commit range; correct the stale "REMAINING: A4" line (A4 already shipped).
- `MEMORY.md` — update the multi-provider-runtime index line to record SP2 shipped.

---

## Self-Review

**1. Spec coverage:**
- §1 goal (precise `getContextUsage` for all 3 + per-provider thresholds) → Tasks 2-7.
- §2 decisions (Notion A, single slice, bundled thresholds, no UI, extractor registry) → reflected in all tasks; no UI work present.
- §3 normalizer-unified shape → exploited in Tasks 4-6 extractors.
- §4 architecture → exact dataflow encoded in Task 3 (computeContextUsage refactor).
- §5 file structure → Tasks 2-8 cover every Create/Modify.
- §6 extractor interface (`extractLatestUsage(events) → {used,model,lastUpdatedAt,inFlight} | null`) → consistent across Tasks 2/4/5/6 implementations.
- §7 per-provider rules → Tasks 2 (Claude — sums cache_read+cache_creation), 4 (Codex — cached+reasoning), 5 (Gemini — no cache), 6 (OpenCode — cached optional).
- §8 registry → Task 3 creates it; Tasks 4/5/6 register each provider.
- §9 thresholds → Task 7 (map + getProviderThreshold + CompactionTrigger wiring).
- §10 empty-slot rewrite → Task 8.
- §11 testing → every Task has its TDD test step + Tasks 7/8 wire to the regression chain.
- §12 scope guard → Task 9 Steps 2-3 prove it.
- §13 non-goals → none of the listed non-goals are touched.

**2. Placeholder scan:** No TBD/TODO/vague phrases. Every code step has complete code; every command has expected output; deviations documented up front and handled in concrete steps. One contingency reference: Task 8 Step 1 says "if the helper already exists as `makeLog` or similar; reuse the existing helper if so" — this is a sanctioned look-before-leap directive (the test file is large and uses a project-specific helper name), not a placeholder.

**3. Type consistency:** Extractor interface (`extractLatestUsage(events) → {used:number, model:string|null, lastUpdatedAt:string, inFlight:boolean} | null`) is identical across Tasks 2/4/5/6 and the consumer in Task 3. `getProviderThreshold(providerId) → {trigger:number}` consistent across Task 7 implementation and CompactionTrigger consumer. `PROVIDER_KEYS` (`Object.keys(REGISTRY)`) consistent between Task 3 registry and `IMPLEMENTED = new Set(PROVIDER_KEYS)` in `getContextUsage.js`. `usage.provider` (the field already returned by `computeContextUsage`) is consistent between the dispatcher (sets it on the result) and `CompactionTrigger.onTurnCompleted` (reads it for the threshold lookup).
