# Sub-project C — Proactive compaction triggers (design)

> **Appendix A lineage.** Appendix A of `2026-05-15-l3-reform-design.md`
> (the deferred per-provider compaction/memory/rate-limit discipline)
> was decomposed into independent sub-projects:
> **A** memory-file materialization · **B** context-window usage signal
> (shipped) · **C** proactive compaction triggers (this doc — needs B) ·
> **D** rate-limit-aware routing · **E** `GeminiFoundryAdapter`.
> Agreed sequence: **B → C → A**; **D and E deferred**. This spec is
> **C only**. Each sub-project gets its own spec → plan → implementation
> cycle.
>
> **Grounding-first discipline (§8d).** This design was derived by
> reading the current code (B's shipped `getContextUsage`, the existing
> reactive `CompactionHandler`, the `RuntimeEventIngestor` dispatch, the
> adapter send rail), NOT Appendix A's prose. The appendix is the
> intent; the code is current state. Surfaced facts the appendix
> predated: the runtime/supervisor layer is **Claude-only** today (Codex
> is a Foundry *planner* only; Gemini is unwired), and the *reactive*
> half of compaction (post-compaction reinjection) **already exists** and
> is unchanged by C.

**Out of scope (non-goals):** Codex/Gemini trigger *behavior* (the
config shape carries a provider-keyed seam, but no inert Codex/Gemini
code path is built — they are not runtime team-agents yet; that is D/E
territory); task-boundary triggers (this slice is usage-%-only by
decision); any change to `CompactionHandler` / the post-compaction
reinjection path (untouched); Sub-project D (rate-limit-aware routing);
Sub-project E (`GeminiFoundryAdapter`); the post-C readability
summarizer (next in sequence — its banked decision in
`notes/deferred-decisions.md` stays intact); any UI rendering change
(C ships an event/data + side-effect contract only).

---

## 1. Goal & success criterion

A long-running Claude agent today sails toward the CLI's **own**
auto-compaction at ~85% context — which fires **too late** (it compacts
mid-flow, after quality has already degraded). Sub-project C proactively
sends `/compact` at a configurable **sweet-spot threshold (default 70%)
while the agent is idle**, so compaction happens early and cleanly,
*before* the late-auto-compaction cliff. The existing reactive
`CompactionHandler` then performs post-compaction identity/rule
reinjection exactly as it does today (unchanged).

**Success criterion:** for a Claude runtime whose context crosses the
threshold, exactly one `/compact` is delivered over the existing stdin
rail at the next idle point; it is not re-sent while in flight; if the
compaction is confirmed (`compact_boundary`) the trigger re-arms; if it
is never confirmed, a bounded retry runs and then an explicit
"compaction not taking" state is surfaced (never silently looped, never
acted on an untrustworthy signal). Non-Claude runtimes and stale/unknown
signals never trigger. Root `npm test` `fail 0` with the new suites
wired into the canonical chain; UI `tsc -b`/`vite build` green.

---

## 2. Why this is the action layer on B (not a re-derivation)

Sub-project B shipped the provider-agnostic accessor:

```
getContextUsage(agentId, { teamId, runtimeRegistry, eventLog, settings, now })
  → { used, total, percentage, model, provider, lastUpdatedAt, stale, source }
```

B's design explicitly computes next-turn occupancy — *"precisely the
quantity C's compaction trigger needs"* — and B's non-goals explicitly
exclude *"compaction / notification / threshold action (C)."* C
therefore **consumes** B's signal and **owns only the decision + the
trigger action**. C never re-derives token sizing; if B reports
`stale`/`source:'unknown'`, C does not act (honest-degradation — the
same discipline as Sub-project B's stale meter and the Sub-project
auth-preflight "never proceed on a state we cannot substantiate"
ruling).

---

## 3. Architecture (Option 1 — pure decision core + thin wiring handler)

Chosen over (2) folding into `CompactionHandler` (conflates
decide-to-compact with repair-after-compaction, entangles a pure
decision with IO, hard to unit-test) and (3) a periodic poller (can
fire mid-turn; re-derives idle that events already provide; extra timer
infra). Option 1 is the proven pure-core-+-injected-IO-+-wiring pattern
of `claudeAuthPreflight` / `eventNarration`: maximally testable,
controller-verifiable, honest-degradation-native, zero new infra.

New module: `src/runtime/compactionTrigger/`
- `shouldCompact.js` — the pure decision core + sealed `REASONS`.
- `index.js` — re-export surface (only what exists at each plan task —
  the ESM-incremental-index trap is pre-empted in the plan).
- `CompactionTrigger.js` — the thin wiring handler (sibling to
  `CompactionHandler`; no shared state, only the shared event stream).

### 3.1 Data flow (all reuses existing seams)

```
RuntimeEventIngestor dispatch (the block that already routes
compactionHandler.onCompactBoundary / onTurnCompleted / onTurnFailed)
   │
   ├─ turn_completed ─► CompactionTrigger.onTurnCompleted(event)
   │     1. Claude runtime? else return  (provider-keyed config; NO inert
   │        Codex/Gemini path — exact Claude-detection seam grounded at
   │        plan-time from the runtime record, not pre-invented)
   │     2. usage = getContextUsage(agentId, { teamId, runtimeRegistry,
   │              eventLog, settings, now })                    ← B (shipped)
   │     3. state = #perRuntime.get(runtimeId)
   │     4. verdict = shouldCompact({ usage, threshold, state, now })  ← PURE
   │     5. verdict.trigger →
   │          adapter = adapters.get(event.runtimeId)
   │          adapter.sendTurn({ message: { messageId, text: '/compact',
   │              metadata: { source: 'compaction_trigger' } } }) ← same rail
   │              CompactionHandler uses for reinjection
   │          sideEffectLog.markPending → markDelivered/markFailed (idem key)
   │          arm boundary-gate (state mutate)
   │
   └─ compact_boundary ─► CompactionTrigger.onCompactBoundary(event):
   │        clear gate, reset retry budget/surface flag (= "it worked")
   └─ turn_failed / runtime end ─► drop #perRuntime entry (no leak)
```

`CompactionTrigger` is constructed in `LocalToadRuntime` next to
`compactionHandler` and passed into `RuntimeEventIngestor` the same way
`compactionHandler` is. **Coordination with the reactive handler is by
disjoint responsibility, not shared state:** `CompactionTrigger` decides
*when to ask for compaction*; `CompactionHandler` (unchanged) repairs
identity/rules *after* the resulting `compact_boundary`. They observe
the same events independently; C never reinjects, the handler never
triggers.

### 3.2 The pure decision core

```
shouldCompact({ usage, threshold, state, now }) → { trigger: boolean, reason }
```

`reason ∈ REASONS` — a frozen sealed enum (throwing mutators, the
`TOKEN_STATUS` / `NARRATION_KINDS` pattern). The core never spawns,
reads fs, or touches `process` (purity-guarded by test).

**Ordered decision table:**

| # | Condition | Result |
|---|-----------|--------|
| 1 | `usage.stale === true` OR `usage.source === 'unknown'` | `{trigger:false, reason:'signal-untrustworthy'}` — honest-degradation: never act on a signal we cannot substantiate |
| 2 | `usage.percentage` missing / not finite | `{trigger:false, reason:'no-signal'}` — strict `num()`, no coercion (B's helper discipline) |
| 3 | gate armed AND within `COMPACT_COOLDOWN_MS` of `lastFireAt` | `{trigger:false, reason:'gated-in-flight'}` |
| 4 | gate armed AND cooldown elapsed AND `retriesRemaining > 0` | `{trigger:true, reason:'retry'}` (wiring decrements budget) |
| 5 | gate armed AND cooldown elapsed AND `retriesRemaining === 0` | `{trigger:false, reason:'giving-up-surfaced'}` (wiring emits the one-time surface) |
| 6 | `usage.percentage >= threshold` | `{trigger:true, reason:'threshold-crossed'}` |
| 7 | else | `{trigger:false, reason:'below-threshold'}` |

Branch order is load-bearing: untrustworthy/no-signal short-circuit
*before* any gate or threshold logic; the gate (in-flight suppression +
bounded retry) is evaluated *before* a fresh threshold cross so an
armed runtime cannot double-fire.

### 3.3 State, failure policy & surfacing

- **Per-runtime state:** `#perRuntime: Map<runtimeId, { gateArmed:boolean,
  lastFireAt:number, retriesRemaining:number, surfacedGiveUp:boolean }>`
  — same Map lifecycle/cleanup shape as `CompactionHandler.#pending`;
  the entry is dropped on `turn_failed` / runtime end so it cannot leak.
- **Boundary-gated + bounded retry (the chosen failure policy):**
  - First fire (`threshold-crossed`): `gateArmed=true`,
    `lastFireAt=now`, `retriesRemaining=RETRY_BUDGET` (default **2**).
    Counting is explicit to forestall an off-by-one: `RETRY_BUDGET=2`
    ⇒ **1 initial fire + up to 2 retries = at most 3 `/compact`
    attempts** for one armed episode before give-up.
  - While gated: every `turn_completed` is suppressed
    (`gated-in-flight`) until **either** a `compact_boundary` for that
    runtime arrives (→ gate cleared, state reset = confirmed) **or**
    `COMPACT_COOLDOWN_MS` elapses with no boundary (→ one `retry` fire,
    `retriesRemaining--`).
  - Budget exhausted, still no boundary: emit **one** explicit
    "compaction not taking — raw context continues" surface, set
    `surfacedGiveUp=true`, then stay silent for that runtime until a
    `compact_boundary` or runtime end re-arms it.
- **Surfacing (never silent — honest-degradation):** every fire and the
  give-up write `sideEffectLog` (idempotency-keyed, the
  `CompactionHandler` markPending→markDelivered/markFailed pattern) AND
  an observable runtime/system event, so the operator can see
  *"compaction requested at NN%"* and *"compaction not taking."* **No
  mandated UI change** — event/data + side-effect contract only (the
  auth + eventNarration discipline); the cockpit renders from the
  existing surfaces.
- **Claude-only gating:** provider-keyed config
  `{ claude: { compactionThreshold: 0.70 } }`; a non-Claude runtime
  returns immediately with **no inert Codex/Gemini code path** (config
  shape only, so D/E slot in later with no schema change — the auth
  `isClaudeCommand` discipline). The exact Claude-runtime detection seam
  is resolved at plan-time by grounding the runtime/registry record, not
  pre-invented.
- **Threshold override:** default `0.70`; per-project override via
  `SettingsStore` (the `settings` argument `getContextUsage` already
  threads — B's spec anticipated the C/D/E settings surface). `0.70` is
  mid the l3-reform 65–70% Claude sweet spot and safely below the 85%
  too-late auto-compaction.
- **Idle guarantee:** the trigger evaluates only on `turn_completed`
  (the agent is idle), so `/compact` always lands cleanly between turns,
  never mid-response.

---

## 4. Testing

- **TDD throughout.**
- **Pure core (`shouldCompact`):** decision-table unit tests for every
  ordered branch (#1–#7): `stale`/`source:'unknown'` → no-fire;
  missing/non-finite percentage → no-fire; gated-in-flight → no-fire;
  cooldown-elapsed + budget → `retry` fire; budget exhausted →
  `giving-up-surfaced`; `>= threshold` → `threshold-crossed`; below →
  no-fire. **`REASONS` sealed** frozen-throw test. **Purity guard**: the
  module imports no `node:`/`fs`/`path`/`os`/`child_process` and never
  touches `process` (the `eventNarration` purity discipline).
- **Wiring handler (`CompactionTrigger`):** injected fakes only — fake
  `getContextUsage`, fake adapter recording `sendTurn` calls (**no real
  spawn**), fake `sideEffectLog`, synthetic events; mirror the
  `compactionHandler.test.js` harness (do not invent). Explicit
  assertions: threshold-cross → exactly one `sendTurn` carrying
  `/compact` + gate armed + side-effect logged; second `turn_completed`
  while gated → **no** second send; `compact_boundary` → gate cleared
  (next cross can fire again); cooldown-elapsed no-boundary → bounded
  retry then exactly one surfaced give-up then silence;
  `stale`/`source:'unknown'` → **never** sends; **non-Claude runtime →
  never sends** (the inert/over-gate epicenter — an explicit test, as in
  the auth work); `turn_failed`/runtime-end → state entry dropped.
- **Gates:** new test files wired into the canonical `npm test` chain
  (the un-wired-test false-green trap — explicitly verified by grepping
  the new suites' titles in the full-run output, the auth-work
  discipline); root `npm test` `fail 0`; UI `tsc -b`/`vite build` green
  (C is event/data-contract only — this proves nothing downstream
  broke). A **whole-implementation review before the commit** (the gate
  that caught the auth Critical).

---

## 5. Surfacing (honest-degradation — never silent)

- **Trigger fired:** a side-effect log entry + an observable
  runtime/system event (`source:'compaction_trigger'`) records
  *"compaction requested at NN%"* — the operator can see C acted; the
  next `getContextUsage` poll already shows the lowered occupancy via B.
- **Compaction not taking:** after the bounded retry with no
  `compact_boundary`, a single explicit *"compaction not taking — raw
  context continues"* surface (side-effect + observable). C then stays
  silent for that runtime (no infinite loop) until a boundary or runtime
  end. The operator is never left with a silent stuck state.
- This is the Sub-project-B honest-degradation lineage: report the true
  state (acted / degraded / untrustworthy-signal), never paper over it.

---

## 6. Pinned / open (resolved at plan-time by grounding, not pre-invented)

- **Claude-runtime detection seam:** the precise field used to decide
  "this runtime is Claude" (runtime/registry record vs launch command)
  is grounded against the actual `RuntimeEventIngestor`/event +
  `runtimeRegistry` shapes at plan-time, mirroring how the auth work
  grounded `isClaudeCommand` — never invented.
- **`COMPACT_COOLDOWN_MS` and `RETRY_BUDGET` literals:** defaults
  `COMPACT_COOLDOWN_MS` (order of a few minutes — long enough for the
  CLI to emit `compact_boundary`) and `RETRY_BUDGET = 2`; tuned against
  the real `compact_boundary` latency surface during implementation
  (run-and-tighten, like the auth `RELAUNCH_GUARD_MS`), not pre-fixed.
- **Observable event channel:** the exact event type/shape for the
  observable surface is grounded against the existing
  runtime/side-effect event surface at plan-time (reuse the channel the
  cockpit already consumes; introduce no new bus).
- **Settings key shape:** `{ claude: { compactionThreshold } }` under
  the existing `SettingsStore` project settings; exact key path
  confirmed against `SettingsStore` + B's `settings` consumption at
  plan-time.

---

## 7. Scope summary

**In:** Claude proactive usage-%-threshold compaction trigger at idle;
pure `shouldCompact` core + sealed `REASONS`; thin `CompactionTrigger`
wiring handler; boundary-gated bounded-retry failure policy;
honest-degradation on stale/unknown signal; side-effect + observable
surfacing; per-project threshold override; provider-keyed config seam.

**Out (explicit / banked):** Codex/Gemini trigger behavior (seam only);
task-boundary triggers; any change to `CompactionHandler`/reinjection;
Sub-project D (routing); Sub-project E (`GeminiFoundryAdapter`); the
post-C summarizer (banked decision intact); any UI rendering change.
