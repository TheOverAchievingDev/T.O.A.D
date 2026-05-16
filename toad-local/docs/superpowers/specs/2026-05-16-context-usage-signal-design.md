# Sub-project B — Provider-aware context-window usage signal (design)

> **Appendix A lineage.** Appendix A of `2026-05-15-l3-reform-design.md`
> (the deferred per-provider compaction/memory/rate-limit discipline)
> was decomposed into independent sub-projects:
> **A** memory-file materialization · **B** context-window usage signal
> (this doc) · **C** proactive compaction triggers (needs B) ·
> **D** rate-limit-aware routing · **E** `GeminiFoundryAdapter`.
> Agreed sequence: **B → C → A**; **D and E deferred** (D needs
> quota visibility that doesn't exist; E is the unbuilt F.2.5+ Gemini
> runtime). This spec is **B only**. Each sub-project gets its own
> spec → plan → implementation cycle.
>
> **Grounding-first discipline (banked — §8 below).** This design was
> derived by reading current code, NOT Appendix A's prose. That
> surfaced two facts the appendix predated: (1) the runtime/supervisor
> layer is **Claude-only** today (Codex is a Foundry *planner* only;
> Gemini is unwired); (2) the existing Cockpit usage meter is not just
> imprecise — it is **wrong and trends the wrong way over session
> length**. The appendix is the plan; the code is current state.

## 1. Goal & success criterion

A single provider-agnostic accessor:

```
getContextUsage(agentId) →
  { used, total, percentage, model, provider,
    lastUpdatedAt, stale, source }
```

**Success criterion (measurable, demoable, testable):** for every
running runtime team agent, the supervisor exposes a `{used, total,
percentage}` that reflects **actual context-window occupancy**,
refreshed on every **completed turn**, queryable programmatically and
rendered consistently in the UI from this one source.

**"Completed turn" is pinned:** the agent finished responding (the
runtime emitted `turn_completed` / a stream-json `result` frame) —
**not** message-send time, **not** mid-turn. The meter does not move
when the operator sends a message; it moves when the model finishes
processing one.

**Observation only.** B exposes the signal. It does **not** notify,
warn, trigger `/compact`, or route. Those are C/D. Same discipline as
the broker observer seam shipping without a consumer and the L3 reform
shipping without downstream prompt changes.

The extra interface fields beyond `{used,total,percentage}` are load-
bearing for honest semantics: `model`/`provider` (what the denominator
is derived from), `lastUpdatedAt`/`stale` (freshness contract, §3),
`source` (degradation state, §3).

## 2. The two pinned bugs — exact wrong vs. correct

The existing meter (`localToolFacade` `runtimes_list`/`usage_summary`
enrichment + four UI consumers) is **current production wrongness**. B
fixes both as part of its correctness, not as a bonus.

### Bug 1 — `used` is lifetime throughput, not window occupancy

**Wrong (current):** for every `turn_completed` whose
`payload.raw.type==='result'`, the facade does
`bucket.tokensIn += u.input_tokens; bucket.tokensOut += u.output_tokens`
— a **cumulative sum over every turn**, and it **ignores
`cache_read_input_tokens` / `cache_creation_input_tokens` entirely**.
Consequence: the number rises monotonically with session length
regardless of whether the live context actually grew — it is worst
exactly when the meter matters most (a long-running agent).

**Correct:** occupancy is the **most recent turn's snapshot**, not a
sum:

```
used = input_tokens
     + (cache_read_input_tokens     || 0)
     + (cache_creation_input_tokens || 0)
     + output_tokens
```

from the **latest** `turn_completed` `result.usage` frame for that
runtime. Rationale, pinned: Claude's `input_tokens` is the *non-cached*
prompt; the true prompt footprint includes the cached portions;
**including `output_tokens` is deliberate** — the model's output
becomes part of the next turn's prompt, so this approximates the
next-turn occupancy, **which is precisely the quantity C's compaction
threshold will fire on**. This `output_tokens` inclusion is a C design
constraint expressed in B — a future contributor must NOT "simplify"
it away (doing so silently breaks C's threshold semantics).

### Bug 2 — `total` is a hardcoded / split denominator

**Wrong (current):** `RuntimeDrawer.tsx` hardcodes `/ 200_000`;
`AgentCard.tsx` / `cockpit/Inspector.tsx` / `CockpitFlowCanvas.tsx`
divide by a separate `agent.tokenLimit`. Split, inconsistent, and
wrong for any non-200K model (e.g. a 1M-context model reads as
"500% used").

**Correct:** `total` = the **running model's** context window,
resolved per-runtime from the model the runtime is actually using
(the facade already tracks latest model per runtime via
`modelByRuntime`) through a new single-source `MODEL_CONTEXT_WINDOW`
map (the PROVIDER_MAP single-source pattern). Unknown model → `total`
and `percentage` are `null` with `source:'unknown'` (honest
degradation — never guess a denominator).

### Retained, not orphaned: lifetime spend telemetry

`tokensIn` / `tokensOut` / `costUsd` lifetime totals are **kept** with
a **defined consumer**: operator-visible **spend telemetry**
(`usage_summary`, the runtimes_list cost/throughput columns). They are
explicitly **not** the occupancy signal and **not** dead code — two
different products over overlapping data, each with its own consumer.

## 3. Push/pull, staleness & degradation contract

Claude **pushes** usage via stream-json `result` frames already
ingested into the runtime event log. B derives the latest-snapshot
occupancy on ingest; callers **pull** via `getContextUsage`. The
contract is explicit: **"returns what is known as of
`lastUpdatedAt`."**

**`stale` semantics (pinned):** `stale` means *the agent has been
idle for a while*, **not** *a turn is in flight*. Specifically:

- `stale = false` when a completed turn exists within the staleness
  window **OR** a turn is currently in flight (started after
  `lastUpdatedAt` but not yet completed) — the value is the last
  completed snapshot, which legitimately under-reports until the
  in-flight turn finishes; that is correct behavior (occupancy is
  unknowable until the model processes the new input), and we do
  **not** flag it stale.
- `stale = true` only when no completed turn within the staleness
  window and no turn in flight.

**Staleness window (pinned):** default **60s**, config-tunable via
`settings.drift.contextStaleness` (same `settings.<ns>.<key>`-with-
default shape as the other drift config knobs).

**`source` is a sealed enum (pinned):** `'precise' | 'coarse' |
'unknown'`.
- `'precise'` — a real Claude `result.usage` frame parsed with a
  known model window.
- `'unknown'` — Claude degraded: no usage frame yet, parse miss, or
  model not in `MODEL_CONTEXT_WINDOW` (→ `used`/`total`/`percentage`
  null).
- `'coarse'` — **reserved for the future Gemini deferred slot**
  (OAuth plan-auth cannot expose cached-token detail per Google's
  docs, so Gemini precision will degrade by construction). Not
  emitted by the Claude implementation. Naming it now is what makes
  the Gemini deferred slot honest.

Honest degradation everywhere: never report a number we don't have —
null the field and set `source:'unknown'`.

## 4. Provider scope & named-deferred slots

**One real implementation: Claude runtime** (`ClaudeStreamJsonAdapter`
→ runtime event log → supervisor). The interface is provider-agnostic
with **explicit deferred slots** specified enough that pickup is
"write the parser," not "redesign the interface":

- **Codex.** *Trigger:* when Codex is wired as a runtime **team-agent**
  provider (it is a Foundry *planner* only today — short-lived
  `codex exec`, which does not suffer context rot). *Mechanism:
  deferred by design* — `codex exec --json` (one-shot exec format) and
  `/status` (interactive slash) are different mechanisms; which
  applies depends on how Codex runtime is eventually wired (one-shot
  exec vs. persistent stream). The slot accepts **either**; the parser
  implementation chooses at pickup. *Contract that must hold now:*
  returns the same shape; `used` = latest-turn occupancy
  (input + cache_read + cache_creation + output); `total` from
  `MODEL_CONTEXT_WINDOW`; `source` ∈ the sealed enum.
- **Gemini.** *Trigger:* when a `GeminiFoundryAdapter`/runtime exists
  (the unbuilt F.2.5+ item). *Sketch:* `/stats`, degrading to
  `source:'coarse'` under OAuth plan-auth (cached-token detail
  hidden). *Contract:* same shape/semantics as above.

**Architectural clarification (kept in-spec verbatim so a future
reader does not misread Appendix A):** Appendix A conflated three
distinct CLI roles in Symphony — **runtime team agent**, **Foundry
planner**, **future runtime**. B targets the first; the deferred slots
are the third; Foundry-planner Codex is correctly out of scope (a
short-lived one-shot session does not rot).

## 5. Replace-not-parallel + honest blast radius

The buggy meter is **dead the moment B lands** (L3-reform
"delete the dead path, don't disable it" discipline). The corrected
signal is the single source of truth; nothing computes occupancy or a
context denominator independently afterward.

**Module home (pinned):** new `src/runtime/contextUsage/` owns the
interface (`getContextUsage`), the Claude implementation, the
`MODEL_CONTEXT_WINDOW` map, and the Codex/Gemini deferred-slot stubs
— same ownership pattern as `src/drift/llm/` owning the L3 pieces.

**Honest blast radius (named up front):**
- `src/runtime/contextUsage/` (new): interface + Claude impl + model
  map + deferred stubs + the supervisor wiring to expose
  `getContextUsage(agentId)`.
- `src/tools/localToolFacade.js`: occupancy now comes from the new
  signal; the cumulative-sum occupancy computation is **removed**
  (lifetime spend totals retained per §2).
- UI consumers repointed in lockstep to the one corrected value:
  `ui/src/components/RuntimeDrawer.tsx` (drop hardcoded `200_000`),
  `ui/src/components/AgentCard.tsx`,
  `ui/src/components/cockpit/Inspector.tsx`,
  `ui/src/components/CockpitFlowCanvas.tsx`.
  (Same lockstep discipline as the just-completed findingTier /
  DriftFindingForModal fixes.)

**Atomic-commit internal ordering (pinned)** — single commit, but the
operations are sequenced so there is no intermediate half-built state:
1. corrected signal exists and is queryable (`contextUsage/` + facade
   wired to it);
2. all four UI consumers updated to consume it;
3. the old facade occupancy computation removed (lifetime spend
   totals retained).

## 6. Testing & non-goals

**TDD.** Unit:
- occupancy formula = latest snapshot incl. `cache_read` +
  `cache_creation` + `output` (NOT Σ over turns); a synthetic
  multi-turn event sequence proves the value does **not** grow
  monotonically with turn count (the exact Bug-1 regression).
- `MODEL_CONTEXT_WINDOW` resolution per model; unknown model →
  `total/percentage=null`, `source:'unknown'`.
- staleness: `stale` false within window / during in-flight turn;
  true only on idle-beyond-window; window honors
  `settings.drift.contextStaleness`.
- `source` sealed-enum values; `'coarse'` never emitted by the Claude
  impl.
- lockstep: the UI denominator equals the model window, never a
  constant.

**Structural regression guard (pinned):** a grep-style test that
**fails if a hardcoded context-window literal (`200_000`/`200000`/
equivalent) reappears** in `src/` or `ui/src/` once migrated — makes
the split-denominator divergence structurally hard to reintroduce
(same discipline as the lockstep tests / "no parallel reimplementation"
invariant).

**Gates (invariants, not optional):** root `npm test` stays `fail 0`;
UI `tsc -b`/`vite build` stays green (it is genuinely green now after
the DriftFindingForModal fix — B must keep it so).

**Non-goals:** no compaction / notification / threshold action (C);
no routing or quota logic (D); no Codex/Gemini *implementation*
(deferred slots only, §4); no new provider runtimes (E); lifetime
spend telemetry is retained, not redesigned.

## 7. Self-review

- **Placeholders:** none — the occupancy formula, `source` enum,
  staleness default + config key, model-map source, module home,
  UI-consumer set, and commit ordering are all concrete.
- **Internal consistency:** §2's formula (incl. `output_tokens`,
  with the C-constraint rationale) is referenced identically in §4's
  deferred-slot contract and §6's tests; §3's `source` enum matches
  §4's Gemini `'coarse'`; §5's blast radius matches §6's lockstep +
  regression-guard tests; "observation only" (§1) is consistent with
  the non-goals (§6).
- **Scope:** one implementation plan — Claude impl + facade swap + 4
  UI repoints + model map + deferred stubs + the PROJECT.md doctrine
  note (§8). Codex/Gemini impl explicitly out.
- **Ambiguity:** "completed turn" pinned (agent-finished, not
  message-send); `stale` pinned (idle, not in-flight); denominator
  pinned (model window, null on unknown); Codex mechanism explicitly
  deferred while its interface contract is pinned now.

## 8. Banked discipline (PROJECT.md deliverable)

This is the **third** instance where grounding a brainstorm against
current code (not the design/appendix prose) materially changed the
answer (Slice-B contracts/evidence reality; B's Claude-only-runtime
reality; the existing-meter wrongness). The implementation plan MUST
include a step recording this in `PROJECT.md` (alongside §8c
shared-helper-over-reimplementation and the structural-deletion-vs-
flag-disabled discipline) as a named invariant:

> **Ground brainstorm rounds against current code before answering**
> whenever the topic touches an existing surface. Captured design
> prose (appendices, deferred notes) is the *plan*, not *current
> state*; reality moves. Every Appendix-A sub-project (and similar)
> opens with a grounding pass.
