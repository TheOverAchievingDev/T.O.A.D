# SP2 — Unified `getContextUsage` (Notion A) — Design

> Multi-provider-runtime program slice **SP2**. Predecessors: SP1a (Codex
> Stage 2), SP1b (Gemini + grounding), SP1c (OpenCode + grounding), A4
> (first-turn MCP probe) — all shipped to `origin/main`. SP2 fills the
> three named-deferred context-usage slots (Codex/Gemini/OpenCode) so the
> unified `getContextUsage(agentId) → {used,total,percentage,...}` works
> for every provider, and adds per-provider compaction thresholds.
>
> **This is Notion A only** (per-turn context-window occupancy for
> compaction/optimization). **Notion B** (plan spend / 5h / weekly /
> daily quotas for the providers screen) is a separate workstream owned
> by someone else; SP2 does NOT touch its files
> (`PlanUsagePanel.tsx`, `App.tsx providerQuota`, the working-tree-only
> `LocalToadRuntime.js` foreign import, the untracked
> `geminiUsageProbe.js`). Left exactly as found.

**Date:** 2026-05-19
**Status:** Approved (brainstorm)

---

## 1. Goal

Make the existing unified accessor
`getContextUsage(agentId, {teamId, runtimeRegistry, eventLog, settings})`
return **precise** `{used, total, percentage, model, provider,
lastUpdatedAt, stale, source: 'precise'}` for Codex, Gemini, and
OpenCode runtimes — not the current `degraded` shape. Wire per-provider
compaction thresholds so `CompactionTrigger.shouldCompact` fires at the
correct percentage for each provider.

## 2. Scope decisions (locked in brainstorming)

| Decision | Choice | Rationale |
|---|---|---|
| **Which "usage"** | Notion A — per-turn context-window occupancy | Matches memory's literal SP2 wording (`getContextUsage→{used,total,percentage}`); seam already exists as named-deferred slots; zero collision with the foreign Notion-B usage-panel workstream. |
| **Slicing** | Single slice for all three providers (Codex + Gemini + OpenCode) | The shape is already unified at the normalizer boundary (`usage.input_tokens`/`output_tokens` across all four); per-provider extractor is small (~10–25 lines); one regression-chain update completes the per-provider story. |
| **Compaction thresholds** | Bundled into SP2 | Once precise % is reported, threshold map is a small marginal scope and completes the per-provider story. |
| **UI surface** | None | Existing `Statusbar` and `CompactionTrigger` consume `getContextUsage` and will automatically light up for the new providers. No App.tsx / persona / WITH-me / FOR-me edits. |
| **Approach** | Extractor registry (per-provider extractor file + thin dispatcher in `computeContextUsage`) | Mirrors the IDE-1 `diagnosticsRouter` pattern; each extractor independently unit-testable with synthetic events; adding a future provider = one file + one registry entry. |

Out of scope (explicitly deferred): plan-quota / Notion-B work; any UI;
the foreign usage-panel workstream cleanup; `geminiUsageProbe.js`
finishing or removal; `multi_provider_runtime_program.md` A4-status
memory edit (flagged as a follow-up, not in SP2's commits).

## 3. Key prior finding (drives the design)

The SP1 stream-line normalizers (`normalizeCodexExecLine`,
`normalizeGeminiStreamLine`, `normalizeOpencodeStreamLine`) **already
emit a unified `payload.raw.usage` shape** with `input_tokens` and
`output_tokens` from each provider's native format. Specifically (verified
in `test/{codex,gemini,opencode}/normalize*.test.js`):

- **Claude:** native shape — `payload.raw.usage = {input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}` on `turn_completed`/`result`.
- **Codex:** normalized — `payload.raw.usage = {input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens}` on `turn_completed`.
- **Gemini:** normalized — `payload.raw.usage = {input_tokens, output_tokens}` on `turn_completed`/`result`; no cache fields surfaced.
- **OpenCode:** normalized — `payload.raw.usage = {input_tokens, output_tokens, cached_input_tokens?}` on `turn_completed` (native `tokens.input/output` + `cache.read/write` aliased).

This means the per-provider extractors are small: they differ only in
**which event qualifies as a "result frame"** and **which cache fields
to sum**. Field-name handling is already provider-agnostic.

## 4. Architecture

```
runtime event-log (provider-agnostic) → eventLog.listEvents({runtimeId})
                                              │
                                getContextUsage(agentId,{teamId,...})
                                              │ IMPLEMENTED registry — now allows
                                              │ claude/anthropic/codex/gemini/opencode
                                              ▼
                                computeContextUsage({events,now,stalenessMs,providerId})
                                              │ thin dispatcher
                                              ▼
                                extractorRegistry[providerId].extractLatestUsage(events)
                                              │  →  { used, model, lastUpdatedAt, inFlight }
                                              ▼
                                staleness + window math (existing, unchanged)
                                              │
                                              ▼
                              { used, total, percentage, model, provider,
                                lastUpdatedAt, stale, source: 'precise' | 'unknown' }
                                              │
                            ┌─────────────────┴─────────────────┐
                            ▼                                   ▼
                  existing Statusbar/cockpit         CompactionTrigger.shouldCompact
                  (no UI work needed)                 reads providerThresholds[providerId]
```

## 5. File structure

### 5.1 Create

- **`src/runtime/contextUsage/extractors/claudeExtractor.js`** — codifies
  the existing inline Claude logic into the registry shape. No behavior
  change. Exports `extractLatestUsage(events)`.
- **`src/runtime/contextUsage/extractors/codexExtractor.js`** — Codex
  gating + cache summation.
- **`src/runtime/contextUsage/extractors/geminiExtractor.js`** — Gemini
  gating; no cache fields (silent 0).
- **`src/runtime/contextUsage/extractors/opencodeExtractor.js`** —
  OpenCode gating + (optional) cached_input_tokens summation.
- **`src/runtime/contextUsage/extractorRegistry.js`** — single-source
  `Map`/object keyed by `providerId`; exports `getExtractor(providerId)`
  returning the matching extractor or `null` for unknown.
- **`src/runtime/compactionTrigger/providerThresholds.js`** — per-provider
  threshold map + `DEFAULT_THRESHOLD`.
- **Per-module tests** in `test/`:
  `claudeExtractor.test.js`, `codexExtractor.test.js`,
  `geminiExtractor.test.js`, `opencodeExtractor.test.js`,
  `extractorRegistry.test.js`,
  `providerThresholds.test.js`,
  and an updated `contextUsage.getContextUsage.test.js` rewrite plus
  `shouldCompact.test.js` augmentation.

### 5.2 Modify

- **`src/runtime/contextUsage/computeContextUsage.js`** — replace the
  inline Claude extraction (lines 31–66 today) with
  `const extractor = getExtractor(providerId); if (!extractor) return degraded();`
  followed by `const x = extractor.extractLatestUsage(events); ...` then
  the existing staleness/`resolveContextWindow`/percentage math. The
  result shape and `source: 'precise' | 'unknown'` semantics are
  preserved.
- **`src/runtime/contextUsage/getContextUsage.js`** — `IMPLEMENTED` is
  now derived from `extractorRegistry`'s keys (single source); the gate
  becomes `if (!getExtractor(providerId)) return degraded(providerId);`.
- **`src/runtime/compactionTrigger/shouldCompact.js`** — replace any
  hardcoded threshold with
  `(PROVIDER_COMPACTION_THRESHOLDS[usage.provider] ?? DEFAULT_THRESHOLD).trigger`.
  Claude's existing values stay byte-equivalent (0.85/0.65), so the
  Claude path is unchanged.
- **`scripts/test-suites.txt`** — append the new suites single-line.

### 5.3 Untouched (invariant)

`localToolFacade.js`, all MCP definitions, all UI files (Statusbar,
cockpit, App.tsx, persona, FOR-me, WITH-me), all foreign WIP files
(`PlanUsagePanel.tsx`, `geminiUsageProbe.js`, the working-tree-only
`LocalToadRuntime.js` foreign import). Verified in the finishing gate.

## 6. Extractor interface

```js
// extractors/<provider>Extractor.js
export function extractLatestUsage(events) {
  // events: provider-agnostic event-log rows (e.g. {eventType, createdAt, payload:{raw}})
  // Returns { used, model, lastUpdatedAt, inFlight }, or null if no
  // usable result frame yet (caller maps to degraded).
}
```

`extractLatestUsage` returns just the *raw extraction result*; the
caller (`computeContextUsage`) applies the existing staleness window
and `resolveContextWindow(model)` math. This keeps extractors small,
pure, and easy to test.

## 7. Per-provider extraction rules

### 7.1 Claude (`claudeExtractor.js`)
- **Gate:** `e.eventType === 'turn_completed' && e.payload.raw.type === 'result'` — the latest such event.
- **Cache summation:** `cache_read_input_tokens + cache_creation_input_tokens` (silent 0 when absent).
- **Used:** `input_tokens + output_tokens + cacheRead + cacheCreate`.
- **Model:** `raw.model` (string, non-empty).
- **inFlight:** `lastEventAt > resultEvt.createdAt`.

### 7.2 Codex (`codexExtractor.js`)
- **Gate:** `e.eventType === 'turn_completed'` with `e.payload.raw.usage` present (Codex normalizes the `token_count` event into the unified `usage` shape on `turn_completed`).
- **Cache summation:** `cached_input_tokens` (silent 0 when absent).
- **Used:** `input_tokens + output_tokens + cached_input_tokens + (reasoning_output_tokens ?? 0)`.
  *(`reasoning_output_tokens` is Codex's reasoning-tier accounting; it's
  part of context consumption and must be summed — verified in
  `test/codex/normalizeCodexExecLine.test.js:78` fixture.)*
- **Model:** `raw.model` if present, else null (degrade gracefully).
- **inFlight:** as above.

### 7.3 Gemini (`geminiExtractor.js`)
- **Gate:** `e.eventType === 'turn_completed'` with `e.payload.raw.usage` present (Gemini normalizes its `result.stats` into the unified `usage` shape).
- **Cache summation:** **none** — Gemini's `result.stats` does not surface cache fields (silent 0).
- **Used:** `input_tokens + output_tokens`.
- **Model:** `raw.model` if present, else null.
- **inFlight:** as above.

### 7.4 OpenCode (`opencodeExtractor.js`)
- **Gate:** `e.eventType === 'turn_completed'` with `e.payload.raw.usage` present (OpenCode's `step_finish.part.tokens` aliased through normalization).
- **Cache summation:** `cached_input_tokens` (silent 0 when absent — OpenCode's `tokens.cache.read` aliased through).
- **Used:** `input_tokens + output_tokens + cached_input_tokens`.
- **Model:** `raw.model` if present, else null.
- **inFlight:** as above.

> Each extractor returns `null` when no qualifying event exists or when
> `input_tokens`/`output_tokens` is non-numeric (the caller maps `null`
> → degraded shape with the correct `provider` field).

## 8. Registry

`src/runtime/contextUsage/extractorRegistry.js`:

```js
import * as claudeExtractor from './extractors/claudeExtractor.js';
import * as codexExtractor from './extractors/codexExtractor.js';
import * as geminiExtractor from './extractors/geminiExtractor.js';
import * as opencodeExtractor from './extractors/opencodeExtractor.js';

const REGISTRY = Object.freeze({
  claude:    claudeExtractor,
  anthropic: claudeExtractor,
  codex:     codexExtractor,
  gemini:    geminiExtractor,
  opencode:  opencodeExtractor,
});

export const PROVIDER_KEYS = Object.freeze(Object.keys(REGISTRY));

export function getExtractor(providerId) {
  if (typeof providerId !== 'string') return null;
  return REGISTRY[providerId] || null;
}
```

`getContextUsage.IMPLEMENTED` becomes
`new Set(PROVIDER_KEYS)` (single source of truth).

## 9. Compaction thresholds

`src/runtime/compactionTrigger/providerThresholds.js`:

```js
export const PROVIDER_COMPACTION_THRESHOLDS = Object.freeze({
  claude:    { auto: 0.85, trigger: 0.65 },
  anthropic: { auto: 0.85, trigger: 0.65 },
  codex:     { trigger: 0.70 },
  gemini:    { trigger: 0.60 },
  opencode:  { trigger: 0.70 }, // conservative — mirror Codex until upstream documents
});

export const DEFAULT_THRESHOLD = Object.freeze({ trigger: 0.70 });

export function getProviderThreshold(providerId) {
  return PROVIDER_COMPACTION_THRESHOLDS[providerId] || DEFAULT_THRESHOLD;
}
```

`shouldCompact(usage)` reads
`getProviderThreshold(usage.provider).trigger`. Claude's existing values
are byte-equivalent to today's — no behavior change for the Claude path
(regression-guarded by the existing Claude compaction tests).

## 10. Empty-slot guard rewrite (the structural witness)

Existing test in `test/contextUsage.getContextUsage.test.js` line 31:

```js
test('empty-slot safety: codex/gemini provider → degraded shape, never throws (deferred slots)', () => {
  for (const providerId of ['codex', 'gemini', 'openai', 'anything']) { ... }
});
```

becomes:

```js
test('empty-slot safety: genuinely-unknown provider → degraded shape, never throws', () => {
  for (const providerId of ['openai', 'anything']) { ... assert provider, source==='unknown' ... }
});
```

Plus three NEW tests asserting precise return for codex/gemini/opencode
given synthetic `turn_completed` events with known token payloads.

This preserves the seam invariant (genuinely-unknown providers still
degrade) while replacing the now-implemented providers' assertions with
precise ones.

## 11. Testing

**Per-extractor unit tests** (one suite per provider): synthetic
events with known token payloads → assert
`{used, model, lastUpdatedAt, inFlight}`. Cover: missing usage,
non-numeric tokens, cache fields absent/present, in-flight vs settled,
multiple result frames (latest wins), unrelated events ignored.

**Registry test:** `getExtractor` returns the matching extractor for
known keys, `null` for unknown; `PROVIDER_KEYS` matches expectation.

**Threshold tests:** `getProviderThreshold` returns expected per-provider
values; unknown → `DEFAULT_THRESHOLD`; the frozen-ness is preserved.

**shouldCompact tests:** for each provider, threshold fires at the
documented percentage; unchanged Claude behavior locked.

**Integration:** `contextUsage.getContextUsage.test.js` updated as in §10
— narrowed guard + three new per-provider precise tests + an
end-to-end test that builds a synthetic event log for each provider,
calls `getContextUsage(agentId)`, asserts
`source: 'precise'` and a sensible percentage.

**Regression-chain wiring:** all new `.test.js` files appended
**single-line** to `scripts/test-suites.txt` (the IDE-2 procedure — one
line, no newline before `&&`).

## 12. Scope guard (hard constraint)

- **No UI files touched.** Existing Statusbar / cockpit / settings
  consumers light up automatically.
- **No localToolFacade / MCP-definition changes** (SP2 is purely
  internal to `src/runtime/`).
- **FOR me, persona pill, `developerMode`, `CockpitScreenV2`,
  `useTweaks`, `CockpitForMe`, `CockpitWithMe`, `App.tsx`** — byte-unchanged.
- **All Notion-B foreign WIP** (`PlanUsagePanel.tsx`, `App.tsx
  providerQuota`, working-tree-only `LocalToadRuntime.js` foreign import,
  untracked `geminiUsageProbe.js`) — **untouched**; SP2 commits will not
  reference any of these files. The finishing gate will prove this.
- **Backward compatibility:** Claude path through every modified file
  remains byte-equivalent (same threshold, same extraction math after
  the Claude extractor codification, same staleness semantics).

## 13. Non-goals / YAGNI

- No Notion-B work (plan quotas / `/status` parsing / providers-screen
  rendering / interactive pty probes). That is a separate workstream.
- No new MCP commands; no facade work.
- No usage *persistence* (the event log already persists; SP2 only
  *reads* it).
- No usage *broadcast* events / subscription surface.
- No automatic compaction *invocation* changes (`CompactionTrigger`'s
  behavior beyond the threshold-source change is untouched).
- No model-capability map (SP4); no role→provider tiering (SP3).
- No `multi_provider_runtime_program.md` memory edit in SP2's commits
  (A4-stale note flagged as a separate follow-up).
