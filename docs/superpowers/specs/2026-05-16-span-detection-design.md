# Span Detection (Readability Layer-2 P2b) — Design

**Status:** Approved design (brainstorm complete). Next: implementation plan via `superpowers:writing-plans`.

**Goal:** A pure, server-importable module that groups the persisted narrated stream into single-agent activity **spans**, exposed via a compute-on-read `listSpans`, so P3's spawned-CLI summarizer has bounded, self-contained units to summarize.

**Architecture:** New zero-import pure core `src/runtime/spanDetection/` (same lineage as `eventNarration` / `timelineComposition`) + a thin compute-on-read `listSpans` on `LocalReadModel` / `LocalToadRuntime` that derives spans from `listNarratedTimeline` each call. No new table. Purely additive — no consumer yet (P3 is the first).

**Tech stack:** Node ≥20 ESM, `node:test`, the project's pure-core + sealed-enum + injected-config discipline.

---

## §0 — Context and §8d grounded facts (verified against shipped code 2026-05-16)

Predecessors shipped this session:

- **P1 narration persistence** (`71f9c4c` + `47d1369`): `narrated_lines` durably records one row per in-scope narrated runtime event.
- **P2a timeline composition extraction** (Commit 2 `52b49e4`): pure `src/runtime/timelineComposition/composeTimeline.js`, contract frozen, strict golden agreement.

Grounded facts that constrain P2b (surfaced, not smoothed — §8d):

1. **The persisted narrated stream P2b reads** is
   `LocalToadRuntime.listNarratedTimeline({teamId, runtimeId?})` →
   `LocalReadModel.listNarratedTimeline` →
   `SqliteNarrationStore.listNarration({teamId, runtimeId?})`, returning rows:
   ```
   { narrationId, idempotencyKey, eventId, runtimeId, teamId, agentId,
     sessionId, eventType, createdAt, line, kind, tokens }
   ```
   ordered **`created_at ASC, narration_id ASC`**.
2. **`kind`** ∈ the sealed `NARRATION_KINDS = {'tool','text','system'}`
   (`src/runtime/eventNarration/narrate.js`). `eventType` ∈
   `{assistant_text, tool_use, turn_completed, turn_failed,
   compact_boundary, api_retry, approval_request, runtime_event}`.
   Mapping: `tool_use→kind:'tool'`, `assistant_text→kind:'text'`,
   everything else → `kind:'system'`.
3. **Drift-score-change rows and snapshot-delta task-lifecycle
   transitions are NOT in the narrated stream.** They are separate
   client-derived inputs that only ever reach P2a's *live*
   `composeTimeline` (`driftHistory`, `taskTransitions`); they never
   pass through `narrate()` / `narrated_lines`. Task *tool activity*
   (`task_create` / `task_update` / `review_decide`) **does** appear, as
   `kind:'tool'` lines. ⟹ P2b does **no** drift/task-lifecycle folding;
   the only task signal is the in-stream `task_*` tool lines. Drift/
   lifecycle context, if ever needed, is a **P3** concern (its summarizer
   can be handed drift/task from their own stores).
4. **`detectSpans` is a different consumer than `composeTimeline`.**
   `composeTimeline` → live cockpit rail (client `StreamEntry`s).
   `detectSpans` → P3 summarizer (persisted `narrated_lines`). P2b does
   not touch `composeTimeline`, `CockpitForMe`, `FlowTimeline`, the
   rendered timeline, or narration persistence.
5. **`listNarratedTimeline` currently has zero consumers** (only its
   definitions + tests + design docs). P2b is purely additive infra,
   exactly as `listNarratedTimeline` itself shipped dormant; P3 is the
   first consumer of `listSpans`.
6. **Lineage / pattern precedent:** pure zero-import server-importable
   module + sealed enum + TDD. P2b is **greenfield, not a preservation
   refactor** — there is no pristine logic to freeze, so it follows
   `eventNarration`'s *non-refactor* test shape (TDD unit + purity +
   fixture-coverage), **not** P2a's capture-script/frozen-golden
   preservation discipline.

---

## §1 — Architecture and module boundaries

New pure module **`src/runtime/spanDetection/`**:

- `detectSpans.js` — exports `detectSpans(rows, config)`, the sealed
  `SPAN_BOUNDARY_REASONS`, and the frozen `DEFAULT_SPAN_CONFIG`.
- `index.js` — re-export (the ESM-index discipline used by
  `timelineComposition`/`eventNarration`).

Zero imports (no `node:`/`fs`/`path`/`os`/`child_process`/`react`/JSX,
no `process`). Total/pure: never throws on malformed input. Span is a
**grouping**, not a transformation — narrated line text is reused
verbatim; no re-narration (wording stays `eventNarration`'s single
source of truth).

P2b is a separate consumer from `composeTimeline`; the two never import
each other.

---

## §2 — The `Span` contract (lean span with embedded rows)

```
Span = {
  spanId: string,            // `span-${rows[0].narrationId}` — deterministic, stable, idempotent for P3
  agentId: string,
  runtimeId: string,
  teamId: string,
  sessionId: string | null,  // from the first row
  startedAt: string,         // rows[0].createdAt
  endedAt:   string,         // rows[rows.length-1].createdAt
  closed: boolean,           // false ⟺ trailing span with no terminating boundary yet
  boundary: {                // why it closed; null while open
    reason: 'system' | 'agent-change' | 'runtime-change' | 'time-gap' | 'size-cap',
    systemEventType?: string // present iff reason==='system' (the breaking row's eventType)
  } | null,
  rowCount: number,          // rows.length
  tokens: number,            // Σ row.tokens, null treated as 0
  rows: Array<{ narrationId, eventId, eventType, kind, line, tokens, createdAt }>
}
```

- `rows` carries the **exact narrated rows by reference** (the subset of
  fields above), in order, never re-narrated.
- `boundary` **surfaces** the closing signal (incl. the system
  `eventType` such as `turn_completed`/`compact_boundary`) so P3 has
  that context without P2b emitting non-activity rows.
- `kindCounts` deliberately **omitted** (YAGNI — P3 derives from `rows`).
- An **open** trailing span has `closed:false, boundary:null`. P3 must
  skip open spans and pick them up once closed on a later poll; the open
  tail growing between calls is correct live-data behavior, not a bug.

---

## §3 — Detection algorithm: pure `detectSpans(rows, config)`

`rows` arrive already ordered `created_at ASC, narration_id ASC` (as
`listNarration` returns); the algorithm does **not** re-sort (it trusts
the store order, mirroring how `composeTimeline` trusts its inputs).

Single forward pass. The open span accumulates **consecutive activity
rows** — `kind` ∈ `{'tool','text'}` — for one `(agentId, runtimeId)`.

For each row, **before** appending it, close the open span (if any) when
the row triggers a boundary; then either start a new span with the row
(activity) or consume it as a pure boundary (system):

| Trigger (evaluated in this order) | `boundary.reason` | The triggering row |
|---|---|---|
| `kind === 'system'` | `system` (+`systemEventType = row.eventType`) | **consumed as boundary** — never inside a span, never its own span |
| `row.agentId !== open.agentId` | `agent-change` | starts a new span |
| `row.runtimeId !== open.runtimeId` | `runtime-change` | starts a new span |
| `Date.parse(row.createdAt) − Date.parse(prev.createdAt) > config.gapMs` (both parseable) | `time-gap` | starts a new span |

After appending an activity row, if `rowCount >= config.maxRows` **or**
`tokens >= config.maxTokens`, close the span with `reason:'size-cap'`;
the next activity row starts a fresh span. (A lone row whose own
`tokens` exceed the cap is its own bounded 1-row span — can't do
better.)

**Determinism of triggers.** The **first** trigger to match in the
table's listed order (`system` → `agent-change` → `runtime-change` →
`time-gap`) determines `boundary.reason` — e.g. a row that is both a
different agent *and* past the gap closes with `agent-change`.
Evaluation is **eager**: a span closes the moment its triggering row is
seen, or the moment its size cap is hit, independent of later rows. A
`system`/boundary row encountered while **no span is open** is simply
**skipped** — it neither closes nor starts a span (this is why
all-`system` input yields `[]`).

End of input: the last span (if any) has no boundary →
`closed:false, boundary:null`.

`spanId = \`span-${rows[0].narrationId}\``. Identical input ⇒ identical
output (deterministic; golden-stable except the intentionally-live open
tail, which is exercised deterministically by a fixed-tail fixture).

**Config.** `DEFAULT_SPAN_CONFIG = Object.freeze({ gapMs: 300000,
maxRows: 40, maxTokens: 6000 })` (5-minute idle; ≤40 rows or ≤6000
summed tokens). Passed in as an **injected parameter** — the pure module
performs no env/store reads. `SPAN_BOUNDARY_REASONS` is a **sealed Set**
(`['system','agent-change','runtime-change','time-gap','size-cap']`)
using the throwing-mutator seal — see §8 for the Node-v22 caveat.

**Explicit edge cases (all fixture-covered):**

- `[]` input → `[]`.
- All-`system` input → `[]` (no activity rows ⇒ no spans).
- Single activity row then EOF → one **open** span (`closed:false`).
- A `text`-only run (no tools) → a valid thin span.
- `tokens` null/non-finite → counted as `0`.
- Unparseable `createdAt` on either side of a pair → the gap test is
  treated as **no gap** (do not NaN-split), mirroring `composeTimeline`'s
  `Number.isNaN` skip discipline.
- Missing/empty `agentId` or `runtimeId` → treated as the literal key
  (`''`), never a crash; an `''→'x'` change is an ordinary
  `agent-change`/`runtime-change` boundary.

---

## §4 — Exposure and config

- `LocalReadModel.listSpans({ teamId, runtimeId = null })` =
  `detectSpans(this.listNarratedTimeline({ teamId, runtimeId }),
  DEFAULT_SPAN_CONFIG)`. Compute-on-read; **no table**. Returns `[]` if
  the narration store is absent (the same guard `listNarratedTimeline`
  uses).
- `LocalToadRuntime.listSpans(input)` → `this.readModel.listSpans(input)`.
  One-for-one mirror of the `listNarratedTimeline` delegation.
- **Per-project config override is out of scope for P2b.** Wiring an
  override that no consumer honors is the inert-feature trap;
  `DEFAULT_SPAN_CONFIG` is the single source until P3 (the first
  consumer) needs routing/config and wires it then.

---

## §5 — Error handling / totality

`detectSpans` is total: malformed/missing fields degrade per the §3 edge
rules; it never throws. `listSpans` returns `[]` when the narration
store is missing (no partial throws across the read path). No
try/catch-swallow that hides a real bug — degradation is the documented
edge behavior above, not a catch-all.

---

## §6 — Testing & TDD discipline

Greenfield ⟹ TDD (write boundary tests red → minimal green), **no
capture-script/frozen-golden** (nothing pristine to preserve — this is
the deliberate, reasoned deviation from P2a). Suites:

1. `test/spanDetection.detectSpans.test.js` — every `boundary.reason`;
   open vs closed; `maxRows` and `maxTokens` caps (incl. the
   single-oversized-row case); `time-gap` split; multi-agent and
   multi-runtime interleaving; `task_*` tool lines staying in-span;
   determinism (same input ⇒ deep-equal output); all §3 edge cases.
2. `test/spanDetection.purity.test.js` — source has no
   `node:`/`fs`/`path`/`os`/`child_process`/`react` import, no JSX, no
   `process` use; `SPAN_BOUNDARY_REASONS` and `DEFAULT_SPAN_CONFIG` are
   sealed/frozen (the `NARRATION_KINDS` seal, incl. the Node-v22 caveat
   §8).
3. `test/spanDetection.fixtureCoverage.test.js` over a committed
   `test/fixtures/spanDetection.input.json` — asserts every boundary
   reason, `closed:false`, empty, and all-system cases are genuinely
   exercised (the `eventNarration.fixtureCoverage` precedent).
4. `test/localToadRuntime.spanDetection.test.js` — compute-on-read
   `listSpans` over a seeded `SqliteNarrationStore` returns the expected
   spans; absent-store → `[]`; purely additive (no consumer asserted).

All suites wired into the canonical `package.json` `scripts.test` chain.
Controller independently re-runs the full root suite (fail 0) and greps
the new suite titles in its own output (the P2a un-wired-test trap).
`src/` stays `react`-free.

---

## §7 — Scope

**In:** the pure `spanDetection` module, the sealed enum + frozen
default config, compute-on-read `listSpans` on `LocalReadModel` /
`LocalToadRuntime`, the four test suites + fixture, npm wiring.

**Out (unless a follow-on surfaces it):** P3 summarizer/LLM;
drift-score / task-lifecycle folding (not in the persisted stream —
§0.3); per-project config override plumbing; any spans persistence
table; any narration-persistence, `composeTimeline`, `CockpitForMe`,
`FlowTimeline`, rendered-timeline, or historical-view-UI change.

---

## §8 — Pinned items to confirm at implementation (§8d — ground, do not pre-invent)

- **`listNarratedTimeline` insertion sites:** mirror the exact existing
  delegation pattern — `LocalReadModel.listNarratedTimeline` (the
  `narrationStore`/`listNarration` guard) and
  `LocalToadRuntime.listNarratedTimeline(input) →
  this.readModel.listNarratedTimeline(input)`. Place `listSpans`
  immediately adjacent, same shape; confirm `requireString(teamId,...)`
  is applied as in the sibling method.
- **Sealed-Set Node-v22 caveat (from the `NARRATION_KINDS` T1
  ratification):** `Object.freeze(new Set([...]))` does **not** make
  `.add()` throw on Node v22 (freeze guards own props, not the Set
  internal slot). Seal `SPAN_BOUNDARY_REASONS` via own throwing
  `add`/`delete`/`clear` so mutation throws while `.has()`/iteration/
  spread still work — copy the `narrate.js` `NARRATION_KINDS` IIFE
  pattern verbatim. `DEFAULT_SPAN_CONFIG` is a plain `Object.freeze({...})`.
- **`createdAt` parse discipline:** reuse the `composeTimeline`
  `Date.parse`/`Number.isNaN`-skip semantics exactly so the gap test
  never NaN-splits; confirm `narrated_lines.created_at` is the ISO
  string `appendNarration` writes (`new Date().toISOString()` default).
- **Import path** for `detectSpans` from `LocalReadModel.js`: confirm
  the real relative depth at implementation (the
  `src/read/` → `src/runtime/spanDetection/index.js` path), mirroring
  how the read model imports sibling runtime modules — do not pre-invent
  the `../` count.
- **§8d standing rule:** if any grounded fact above is wrong at
  implementation time (the narrated-row shape, the kind set, the
  absence of drift/task in the stream, the delegation pattern), STOP and
  surface it for controller pre-emptive ratification — as in the
  auth / compaction / narration / P2a cycles. Do not code around a
  wrong spec.
