# Readability Layer — Slice 1: shared `eventNarration` + `locCount` — Design

**Status:** Approved for implementation planning (brainstormed + grounded 2026-05-16).
**Cycle:** First slice of the "readability layer" product line. Observation-window-safe, pure-additive.
**Out of this slice (banked, post-C):** server-side persistence of narrated lines, the span-grouped/expandable activity UI, and the Layer-2 spawned-CLI summarizer (`notes/deferred-decisions.md`).

---

## 1. Goal

Make the team's work legible by fixing the root cause of the current
unreadable event stream: **there is no single source of truth for
"event → human line."** **Grounded correction (planning-time, §8d
question-#1):** the earlier draft named `timelineProjection.tsx` as the
cockpit incumbent — that is imprecise. `timelineProjection.tsx::bodyForStream`
consumes an already-projected `StreamEntry`, NOT a normalized runtime
event. The true landscape is **three related sites**, two of which
(`summarizeToolInput` / `summarizeToolCall`) are the literal §8c twin:

- **Cockpit-feed path — `ui/src/utils/agentStream.ts`** → `eventToStreamEntry(event, idx)` maps a normalized runtime event → `StreamEntry { kind: 'thought'|'tool'|'output'|'system', tool?, body }`, with per-tool wording in its own `summarizeToolInput(toolName, input)`. This is the **real per-normalized-event narration** feeding the "WHAT'S HAPPENING" feed. (`agentStream.ts` is node-importable — a type-only `RuntimeEvent` import, no JSX.)
- **Cockpit-feed re-projection — `ui/src/components/cockpit/timelineProjection.tsx`** → `bodyForStream(agentName, entry)` is a thin **`StreamEntry` → verb/JSX** re-projection riding on the above (`tool→edited/opened/ran/searched for/used`, `output→reported`, `thought→thinking:`, `system→system:`), plus `projectTimeline()`'s composition + candidate-capping. NOT a normalized-event consumer.
- **Agent-card path — `ui/src/hooks/useToadData.ts`** → `deriveAgentActivity(event)` maps a normalized event → `AgentActivity { kind: AgentActivityKind, label, tool?, at }` (`AgentActivityKind = 'text'|'tool'|'thinking'|'idle'`, `ui/src/types/index.ts:20`), with per-tool wording in its own `summarizeToolCall(toolName, input)`.

`summarizeToolInput` (agentStream) and `summarizeToolCall` (useToadData)
are wildly divergent twins of the same decision (e.g. `Read` →
`"<file_path>"` vs `"Reading <basename>"`; `Bash` → `"<command>"` vs
`"Bash: <cmd60>…"`; default → `JSON(input).slice(0,200)` vs
`"Tool: <short>"`); the two `kind` taxonomies don't even share a
vocabulary (`thought|tool|output|system` vs `text|tool|thinking|idle`).

This is the §8c smell: three sites implementing one logical decision
(normalized-event → prose + kind), guaranteed to disagree. Slice 1's
work is **consolidation, not greenfield** (the §8d question-#1 catch).

Slice 1 also ships the **lines-of-code activity counter** — a sibling
pure module surfacing per-agent `+added / −removed / files` as a
glance-able *activity-volume* indicator (explicitly not a productivity
metric).

**Success criteria**
1. One pure module owns event→line; both client consumers import it; neither retains its own per-tool wording or `kind` taxonomy.
2. Cockpit feed and agent cards render *as before* except for **deliberately reconciled, documented** behavior deltas. "Small" is quantified by the §5 soft cap: **≤20 unique divergences**; exceeding it is a pause-and-reconvene signal (a large divergence count means the consolidation scope must be re-examined, not rubber-stamped), not an automatic planning failure.
3. A captured-fixture **agreement test** surfaces every divergence between the two old implementations and the new module and forces an explicit accept/reject per case.
4. Per-agent LoC activity volume renders in the agent rail, honestly labelled, with pinned formulas and filtering.
5. No DB / ingestor / supervisor / RuntimeEventBus changes (observation-window-safe; does not perturb surfaces Sub-project C will touch).
6. Root `npm test` stays `fail 0`; UI `tsc -b` / `vite build` stay green.

---

## 2. Grounded reality (verified in code 2026-05-16 — the spec is built on these)

- **Normalized runtime event taxonomy** (`src/runtime/ClaudeStreamJsonAdapter.js`): `assistant_text`, `tool_use` (`{ toolUseId, toolName, input }`, full structured input), `turn_completed`, `turn_failed`, `compact_boundary`, `api_retry`, `approval_request`. **No `turn_started`. No normalized `tool_result` event.** Every normalized event carries the original frame at `raw`.
- **Tool input shapes** (from `tool_use.input`, the *request* — there is no applied-diff result event): `Edit` → `{ file_path, old_string, new_string }`; `MultiEdit` → `{ file_path, edits: [{ old_string, new_string }, …] }`; `Write` → `{ file_path, content }`; `Bash` → `{ command }`; `Read` → `{ file_path }`; MCP tools are prefixed `mcp__<server>__<tool>`.
- **Everything legible today is client-side & ephemeral.** SSE → browser projections → discarded. The only durable substrate is `SqliteRuntimeEventLog` (raw events + `payload.raw`). There is **no server-side event→prose projection** and **no `tool_result`/narrated-line persistence**. (This is why historical narrative view does not work today — and why persistence is correctly deferred to post-C when the ingestor surface is open.)
- **No `.claudeignore`** exists; only `.gitignore`. (An earlier assertion that `.claudeignore` existed was wrong and ungrounded — corrected here per §8d.)
- **`timelineProjection.projectTimeline()` does multi-source composition** beyond narration: it consumes `StreamEntry`s (already narrated by `agentStream.eventToStreamEntry`), folds in drift-score-change rows and task-lifecycle-transition rows, and caps candidates "to stay cheap." That composition + `StreamEntry`→verb re-projection (`bodyForStream`) is **not duplicated** — single-site, view-specific work — but it is a *consumer* of the narration decision and is repointed in §4.4.
- **Three divergent `kind` taxonomies for one concept**: `StreamEntry.kind` `'thought'|'tool'|'output'|'system'` (`agentStream.ts:8`), `AgentActivityKind` `'text'|'tool'|'thinking'|'idle'` (`types/index.ts:20`), and `timelineProjection`'s `dotForStream` switch keyed off `StreamEntry.kind` (`:100-106`). The sealed `NarrationKind` (§4.3) replaces the narration-decision taxonomy; the view-specific `dot`/verb mapping is a thin adapter over it.
- **`agentStream.ts` is node-importable** (type-only `RuntimeEvent` import, no JSX); `useToadData.ts` is a React hook module (not node-importable) and post-consolidation both incumbents *call* `narrate()` — so the agreement test compares **committed golden snapshots** of each incumbent path's *pre-consolidation* output over the fixture, not live re-imports (§5).

---

## 3. Architecture (locked: Option 1 — shared pure module, client-rendered now, persistence deferred)

A new pure module **`src/runtime/eventNarration/`** is the single
source of truth for event→line. Slice 1 wires only the two existing
**client** consumers to it. Persistence and the server-side ingestor
consumer are deferred to post-C, when the ingestor surface is being
touched anyway and a schema migration is acceptable cost-of-business.

```
                       ┌─────────────────────────────┐
   normalized event ─▶ │  src/runtime/eventNarration  │ ─▶ { line, kind, tokens }
   (one event)         │  narrate(event, options?)    │
                       │  + NarrationKind (sealed)    │
                       └──────────────┬──────────────┘
              ┌───────────────────────┴───────────────────────┐
   (Slice 1) client consumers                    (post-C, deferred) server
   timelineProjection.projectTimeline()           RuntimeEventIngestor calls
     — delegates per-event rows to narrate(),        narrate() per event,
       keeps drift/task composition + capping        persists { line, kind,
   deriveAgentActivity()                             tokens } with the raw
     — delegates per-event WORDING to narrate(),     event; Layer-2 summarizer
       keeps "latest/Working…/Thinking…" SELECTION   reads the persisted stream
```

The post-C persisted record is **`{ line, kind, tokens }`** — `kind`
IS persisted (Layer-2 will filter/group spans by kind: tool-only spans,
system-event clusters), not just `line`. (Finding #1: the earlier
diagram dropped `kind` from persistence; corrected.)

**Path is pinned:** `src/runtime/eventNarration/` — not `ui/` (would
imply client-only and block the post-C server consumer), not
`src/cockpit/` (would imply view-specific). The path declares the
intended consumers: shared client today, shared client+server post-C.
The module is **browser-safe pure**: deterministic, no I/O, and a
hard constraint — **no `node:*` builtins, no `fs`/`path`/`process`/env
access** (a casual `import … from 'node:path'` for a tool-name
normalizer would break the UI bundle). A unit test asserts the module's
transitive import set is free of `node:*` builtins.

**Why not the alternatives** (recorded so a future reader doesn't
revert): server-side-persisted-now collides with C's ingestor/read-model
surface during the observation window and forces a `SqliteRuntimeEventLog`
schema migration + backfill mid-window (bad rollback shape).
Client-side-consolidated-only re-introduces the §8c divergence the
moment Layer-2 needs server-side narration (a third implementation in a
new process). Option 1 threads both: kills the divergence now, perturbs
nothing C needs, and the *same* module is imported server-side post-C
(no event→prose rework, historical view becomes a pure read).

---

## 4. Component 1 — `src/runtime/eventNarration/`

### 4.1 Interface (designed once, for both today's and post-C's consumers)

```
narrate(event, options?) → { line: string; kind: NarrationKind; tokens: number | null }
```

- **Pure, deterministic, no I/O.** One normalized event in → one line out.
- `line` — the operator-readable one-liner (e.g. `Reading recorder.ts`, `Bash: cargo test`, `Edited foo.rs`, `Created task T-12 — …`, `Sent message → reviewer`).
- `kind` — a value of the **sealed `NarrationKind` enum** (§4.3), so callers keep styling/verb control without re-deriving the taxonomy.
- `tokens` — **always present in the return object** (never omitted), value `number | null`. **Source pinned (Finding #2, grounded):** `narrate()` itself derives it as `num(event.raw?.usage?.output_tokens) ?? null` (`num(v)` = `typeof v === 'number' && Number.isFinite(v) ? v : null` — **strict, never coerces**: `num("1234") === null`, same helper discipline as Sub-project B's `computeContextUsage`). It is **not** an ingestor passthrough slot — the value is a property already present on the event (the Claude `result` frame carries `usage`), so a pure function surfacing it keeps the contract single-sourced; the post-C ingestor *persists* what `narrate()` returns, it does not re-derive token sizing. **Grounded reconciliation of Finding #2 vs Finding #4:** `usage` lives ONLY on the `result` frame, which is `turn_completed`'s `raw` (and `turn_failed` may carry a partial one). So `tokens` is non-null **exactly for `turn_completed`/`turn_failed` events** and `null` for `tool_use`/`assistant_text`/`compact_boundary`/`api_retry`. The earlier "assert it's always null in Slice 1" framing is therefore wrong (the §4-required fixture must contain a `turn_completed`, which will have a real `output_tokens`). Slice 1 tests instead assert **per event type**: `turn_completed` fixture event → `tokens === <its output_tokens>`; `tool_use`/`assistant_text` → `tokens === null`. Slice 1's client consumers ignore `tokens` entirely; freezing it now means post-C adds a *caller*, not a signature change.
- **Input shape (pinned — ambiguity caught in re-review).** `narrate()` consumes the **normalized event shape where the original frame is at `event.raw`** (the client SSE shape — exactly what `deriveAgentActivity` reads today, so Slice 1's client callers pass events unchanged). The persisted event-log row exposes the frame at `payload.raw` instead; the **post-C ingestor caller is responsible for adapting** the log row to `{ ..., raw: row.payload.raw }` before calling `narrate()`. `narrate()` does **not** implement dual-shape handling — one input contract, the caller adapts. Stated so the post-C wiring is unambiguous and the module stays single-responsibility.
- `options?` — reserved, forward-compat (e.g. future `{ verbosity }`); unused in Slice 1, documented as reserved so post-C does not change the signature.

### 4.2 The narration ↔ composition contract (Scope boundary A — pinned)

`narrate()` owns **only the genuinely-duplicated decision**: a single
runtime event → a single line + kind. **Everything multi-event is the
caller's job** and is explicitly out of the module:

- composition (interleaving drift-score-change rows, task-lifecycle-transition rows with runtime-event rows),
- grouping, span detection, candidate-capping, drop policy,
- "latest activity" selection and `Working…/Thinking…/idle` *state* selection (that is `deriveAgentActivity`'s selection logic, distinct from per-event *wording*).

This contract makes the post-C server consumer's constraint obvious:
the ingestor calls `narrate()` **per event** and persists the line — it
does **not** make composition decisions in the ingestor. The
narration/composition line stays identical across both consumers.

Extracting only the duplicated decision (not the single-site
composition) is the precise §8c cut: over-consolidating would force
`timelineProjection`'s view-specific concerns into a module that has
other consumers.

**Half-life caveat (Finding #5 — surfaced, not smoothed).** "Composition
is single-site" is true *today*. The post-C Layer-2 spawned-CLI
summarizer reads the persisted line stream and will almost certainly
need composition itself (grouping consecutive `tool_use` into spans,
folding drift/task rows). When Layer-2 lands you will either extract
`timelineProjection`'s composition into a shared module (a *second*
§8c consolidation cycle) or Layer-2 reinvents it (the §8c smell). The
§4.2 boundary is therefore correct *now* but has a half-life tied to
Layer-2. This is **flagged as a deferred decision in
`notes/deferred-decisions.md`** so a future reader does not treat the
narration↔composition boundary as permanent — Layer-2's design will
force the composition-extraction call.

### 4.3 `NarrationKind` — one sealed enum, single source of truth

Today the same concept is encoded twice (typed `AgentActivityKind` vs
`timelineProjection`'s inline strings). Slice 1 collapses them: a
single **sealed, exported** `NarrationKind` lives in
`src/runtime/eventNarration/` and is the only definition of "what kinds
of narrated line exist." Both consumers import it; neither keeps a local
kind union. (Bonus consolidation, same shared-helper discipline.)

Proposed sealed set for per-event narration (runtime events only):

```
type NarrationKind = 'tool' | 'text' | 'system'
```

- `tool_use` → `'tool'`
- `assistant_text` → `'text'`
- `compact_boundary` | `api_retry` | `turn_failed` → `'system'`
- `turn_completed` → `'system'` (proposed)
- `approval_request` → `'system'` (proposed; line e.g. `Awaiting approval: <toolName>`). **Disposition is open-per-reconciliation (Finding #2):** the incumbents likely render nothing for it today (approvals have their own UI surface), so the agreement test will show `oldCockpit`/`oldCard` ≈ none vs `new` = a line — that divergence is *expected* and ruled in the behavior table (does the narrated stream include approval lines at all, or does `narrate()` still return the shape but callers filter `'system'`/approval out of the feed?). Pinned now only so `narrate()` never throws on it and the fixture-coverage requirement (§5 item 1) is satisfiable.

The *exact* final mapping for `turn_completed` / `turn_failed` /
`compact_boundary` / `api_retry` / `approval_request`, and whether any
of them deserves a distinct kind, is a **reconciliation-table
decision** (§5), not invented
here — the agreement test forces the explicit ruling. `'thinking'` /
`'idle'` from `AgentActivityKind` are **selection states, not narration
kinds**; they remain in `deriveAgentActivity`'s selection logic and are
intentionally NOT part of `NarrationKind`. Consumers that previously
switched on their own kind values map onto `NarrationKind` (e.g.
`timelineProjection`'s color/verb switch keys off `NarrationKind` — its
old `'system'→amber`, `'tool'→clay` mappings are preserved by mapping,
documented in the behavior table).

### 4.4 Wiring the three sites (preserve rendering — Scope boundary B)

- **`agentStream.eventToStreamEntry()`** — replace its per-tool wording (`summarizeToolInput`) and its event→`kind` classification with `narrate()`: compute `const n = narrate(event)`, set `StreamEntry.body = n.line`, and derive `StreamEntry.kind` from `n.kind` via a pinned **`NarrationKind` → `StreamEntry.kind` adapter** (`tool→'tool'`, `text→'output'`, `system→'system'`; the legacy `'thought'` had exactly one producer — `runtime_event/post_turn_summary` — which `narrate()` classifies, ruled in the behavior table). `summarizeToolInput` is **deleted** (its logic moves into `narrate()`). The `null`-drop decisions (`assistant_text` with no text, `runtime_event` lifecycle, `turn_completed` without `raw.result`) stay in `eventToStreamEntry` (selection, not wording).
- **`timelineProjection.tsx::bodyForStream()`** — its `StreamEntry.kind`→verb map and `dotForStream` continue to key off `StreamEntry.kind` (now derived via the adapter above), so it is **a consumer, unchanged in logic** — but its behavior is now *fed by* `narrate()` transitively. No per-tool wording remains here (there never was; it only re-verbs). Verified by the agreement test through the full `event → eventToStreamEntry → bodyForStream` path.
- **`useToadData.deriveAgentActivity()`** — replace its `summarizeToolCall()` wording with `narrate()`. **Keep** its "latest activity" selection and the `Working…/Thinking…` fallback (selection, not wording). `AgentActivity.label = narrate(event).line`; `AgentActivity.kind` is mapped from `narrate()`'s `NarrationKind` via a pinned **`NarrationKind` → `AgentActivityKind` adapter** (`tool→'tool'`, `text→'text'`, `system→'thinking'` — ruled in the behavior table) plus the selection-only `'thinking'/'idle'` states `deriveAgentActivity` adds itself. `summarizeToolCall` is **deleted**.

Both `summarize*` twins collapse into one `narrate()`; the two
view-specific taxonomy adapters (`NarrationKind`→`StreamEntry.kind`,
`NarrationKind`→`AgentActivityKind`) are tiny pinned pure maps living in
the *consumers* (not in `eventNarration` — they are view concerns), each
covered by the agreement test.

- **Named wiring task — the `NarrationKind`→`AgentActivityKind` adapter (Finding #3, corrected).** `narrate()` emits `'system'` (from `compact_boundary`/`api_retry`/`turn_*`/`approval_request`), which `AgentActivityKind` (`'text'|'tool'|'thinking'|'idle'`) has no member for. Rather than add a fifth value to the card's taxonomy (the corrected wiring uses an **adapter**, not a passthrough), the pinned **`NarrationKind`→`AgentActivityKind` map** lives in `deriveAgentActivity` and maps `system→'thinking'` (proposed; ruled in the behavior table). The adapter function MUST be exhaustive over `NarrationKind` (a `tsc` `satisfies`/`never`-default exhaustiveness check — a missing case is a compile error, so a future `NarrationKind` addition cannot silently fall through). Symmetrically the `NarrationKind`→`StreamEntry.kind` adapter in `agentStream.ts` is exhaustive over `NarrationKind`. The card renderer itself is unchanged (still switches on `AgentActivityKind`); the new-kind risk is absorbed at the adapter, tsc-enforced.

No new feed UX. The cockpit feed and agent cards render *identically*
after Slice 1 **except** for the deliberately-reconciled deltas (§5).
The span-grouped/expandable activity UI is Layer-2-adjacent and
explicitly a later slice — there is therefore **no new visual to mock
up** (the visual-companion question resolves to *not needed* for
Slice 1).

---

## 5. Consolidation reconciliation (the discipline that makes "preserve rendering" honest)

"Identical rendering" is the *goal* but requires deliberate work: the
two incumbents demonstrably disagree (different per-tool templates,
different verb choices, different kind strings, different drop rules).
Consolidation will change what one or both consumers render in some
cases — and a few of those are legitimately "the cockpit was wrong, the
card was right" (or vice versa). That is a **behavior change even under
a preservation framing**, and it must be explicit, not smoothed.

**Mechanism (pinned operationally — Finding #4):** an **agreement
test** (`node:test`) plus a **fixture-coverage test**:

1. **Fixture + minimum coverage (pinned).** A captured real run committed at `test/fixtures/eventNarration.events.json` (array of normalized event-log rows). A separate **fixture-coverage test** asserts the fixture contains **≥1 of every normalized event type** (`tool_use`, `assistant_text`, `turn_completed`, `turn_failed`, `compact_boundary`, `api_retry`, `approval_request`) **and ≥1 MCP-prefixed `tool_use`** (`mcp__…`). Without this, a fixture heavy on `assistant_text` would pass with false completeness. Coverage test fails listing the missing types.
2. **Matching key (pinned).** Each fixture event gets a stable **signature** = `sha1(eventType + ' ' + canonicalJSON(salientInput))` where `salientInput` = `{ toolName, file_path, command, subtype }` projected from the event (the fields narration keys off), NOT the array index — so adding events to the fixture later does not renumber/invalidate prior rulings. The signature is the table key. Pinned projection: `salientInput = { toolName: event.toolName ?? null, file_path: event.input?.file_path ?? null, command: event.input?.command ?? null, subtype: event.raw?.subtype ?? null }` — `subtype` path is **grounded** (system/result frames carry `parsed.subtype`; `event.raw` is that frame, per Section 2). **Lockstep invariant (pinned):** `salientInput` MUST be a superset of every field `narrate()` reads to produce `line`/`kind`. Low-cardinality types (`assistant_text`, `turn_*`) carry none of these fields, so all events of such a type collapse to ONE signature — acceptable ONLY because `narrate()` is a pure function of exactly the salient fields for those types (one ruling per event-class equivalence). If `narrate()` ever keys off an additional field, `salientInput` extends in the same change; a test asserts `narrate`'s read-set is a subset of `salientInput` keys. (The concrete field list is an implementation-plan task; the superset invariant is the spec pin.)
3. **Golden snapshots + diff (pinned — grounded model).** The incumbents are `.ts`/`.tsx` and post-consolidation *call* `narrate()`, so they cannot be live-imported as a stable "before" by the root `node:test` runner (`agentStream.ts` is node-importable but its post-refactor body is `narrate()` itself; `useToadData.ts` is a non-importable React hook). Therefore a **one-time golden-capture step** (run BEFORE the refactor, harness provided by the plan: it copies the *current* verbatim bodies of `agentStream.eventToStreamEntry`+`summarizeToolInput` and `useToadData.deriveAgentActivity`+`summarizeToolCall`+the `bodyForStream` verb map into a throwaway script) emits committed goldens: `test/fixtures/eventNarration.feedGolden.json` (cockpit-feed path: per fixture event → `{ line, kind }` where `line` = `bodyForStream`-rendered text of the `StreamEntry`, `kind` = `StreamEntry.kind`) and `test/fixtures/eventNarration.cardGolden.json` (agent-card path: per event → `{ line: AgentActivity.label, kind: AgentActivity.kind }`; `null`-dropped events recorded as `null`). The agreement test then computes, per fixture event, `new = narrate(event)` adapted through each path's pinned taxonomy adapter, and compares against the two goldens. A **divergence** = for some path, golden vs new is not equal on `line` and/or `kind` (a golden of `null` vs a produced line is a divergence — the expected `approval_request`/drop-rule cases). Emit the divergence set keyed by signature. The goldens are the frozen pre-consolidation "before"; they are regenerated only by deliberately re-running the capture harness (never auto-rewritten by the agreement test).
4. **Behavior-changes table — location & format (pinned).** A committed machine-readable manifest `test/fixtures/eventNarration.behaviorTable.json`: a JSON object `{ entries: { [signature]: Entry }, softCapAcknowledged?: boolean, acknowledgmentRationale?: string }`. `Entry = { eventType: string, salient: <the human-readable salientInput object, not the hash>, oldCockpit: { line: string, kind: string }, oldCard: { line: string, kind: string }, new: { line: string, kind: string }, ruling: "cockpit-was-right" | "card-was-right" | "new-unified", rationale: string }`. Each of `oldCockpit`/`oldCard`/`new` is the **`{ line, kind }` tuple** (not a bare string) so the rendered table shows the full divergence (wording AND mapped kind). The spec/PR additionally renders `entries` as a human Markdown table (generated from the JSON, not hand-maintained: single source).
5. **Pass condition (pinned, mechanical).** The agreement test asserts `divergenceSet ⊆ keys(behaviorTable.entries)` keyed by signature — i.e. **every** observed divergence has a matching `behaviorTable.entries[signature]` with a non-empty `ruling` + `rationale`. Unaccounted divergence ⇒ **fail**. This is the recoverable §8e teeth: a failing run is cleared by *ruling* the divergence (committing the entry), never blocked permanently.
6. **Developer ergonomics (pinned).** On failure the test writes the unaccounted divergences as a ready-to-paste JSON block to `test/.eventNarration.divergences.out` **and** prints a compact table to stdout, so the implementer pastes/rules them into `behaviorTable.json` and re-runs. (This test runs many times during the consolidation — the ergonomics are part of the contract.)
7. **Soft cap (pinned — Finding, "small" quantified).** If the divergence set exceeds **20 unique signatures**, the test additionally requires `behaviorTable.softCapAcknowledged === true` with a non-empty `acknowledgmentRationale`; absent that, it fails with a distinct **pause-and-reconvene** message (surface to the human). This composes (Finding: prior soft-cap was unrecoverable): the ≤20 path needs only all-divergences-ruled (item 5); the >20 path *additionally* needs the committed acknowledgment marker — a **one-time, reviewable gate cleared by the deliberate human acknowledgment** (the rationale is the artifact of having actually reconvened), NOT a forever-fail on set size. After ruling all entries AND committing `softCapAcknowledged`/`acknowledgmentRationale`, the test passes — a large divergence count is a signal the two incumbents diverged more than "preserve rendering" implies and the consolidation scope should be re-examined, not rubber-stamped.

Same discipline as the `isFileDeclaredByModule` agreement test and the
merge-gate "diff against trunk, only flag what this change introduces"
rule: surface intentional change vs. preserved-as-is explicitly. This
is the §8e invariant instantiated.

### 5.1 Behavior-changes table

Lives at `test/fixtures/eventNarration.behaviorTable.json` (schema in
§5 item 4); the human-readable Markdown rendering is generated into the
PR description / an appendix, never hand-maintained. Empty at design
time by construction; the implementer fills it as the agreement test
surfaces cases. Reviewers read the generated table to see exactly what
changed and why.

**Two independent, composing mechanisms for >20 (resolves the prior
incoherence):** (a) *in-test gate* — cleared by committing
`softCapAcknowledged: true` + `acknowledgmentRationale` (§5 item 7);
this is what makes the test pass, and it is recoverable. (b) *review
ergonomics* — independently, when the table exceeds 20 entries the
rulings move into **Commit 1b** (`readability: eventNarration
consolidation rulings`) so Commit 1 stays a reviewable "consolidation
preserves rendering (modulo table)" unit. (a) is a test mechanism; (b)
is a commit-structure choice; neither blocks the other.

---

## 6. Component 2 — `src/runtime/locCount/` (LoC activity volume)

Sibling pure module (different concern + cadence than narration:
aggregation over time vs per-event wording; no shared abstraction worth
extracting). Pure, client-consumed in Slice 1.

### 6.1 Pinned formulas (derived from the Edit/Write **request input** — no `tool_result` exists)

- **`Edit`**: a replace of `old_string` by `new_string` contributes **two numbers, not one netted delta**: `removed = lineCount(old_string)`, `added = lineCount(new_string)`. (The colloquial "newline delta" = `added − removed`; the rail shows the unnetted `+added / −removed` so a large refactor doesn't visually cancel to zero.)
- **`MultiEdit`**: Σ over `edits[]` of the `Edit` rule (sum the per-edit `added` and per-edit `removed` independently).
- **`Write`**: `added = lineCount(content)`; **`removed: null`** — a `Write` overwrites and the event does not carry prior file length, so removed is *unknowable*. `null`, not `0` (honest about uncertainty; same discipline as B's `source:'unknown'`).
- **`lineCount`** (pinned): `lineCount('') === 0`; otherwise `(count of '\n') + (1 if the string does not end in '\n' else 0)` — i.e. the number of textual lines, empty string contributing nothing. The exact predicate is restated verbatim in the plan with unit cases.
- **No-op edit (pinned, agreement-shaped):** if `old_string === new_string` the edit contributes **nothing** (`added 0 / removed 0`), not `+n / −n`. (A no-op replace is not activity.)
- **`filesTouched` (pinned):** `= |unique(file_path)|` over an agent's contributing Edit/MultiEdit/Write events (post-filter).
- Only `Edit`/`MultiEdit`/`Write` contribute. Non-file tools contribute nothing. **Bash-driven file changes (`rm`, `sed -i`, code-gen, `git apply`) contribute nothing by design** — `locCount` measures *edit-tool activity volume*, not filesystem deltas; there is no reliable structured signal for Bash-side mutations. Stated once here to defuse a future "why doesn't deleting/`sed` count?" surprise.
- **Attribution**: lines are credited to the agent that produced them. Deleting another agent's lines does **not** subtract from the deleter (count is what *this* agent produced, not net contribution) — otherwise an agent fixing a colleague's bug looks negative.
- **Known limitation — requested, not applied (pinned, Finding #6).** There is no normalized `tool_result` event (§2), so `locCount` counts the Edit/Write **request**, not its applied result. An `Edit` whose `old_string` failed to match, or a permission-denied `tool_use` that never executed, is still counted. This is the **same honesty class as `removed: null`**: surface it, don't paper over it. The aggregate carries a footnote — *"counts requested edits; the runtime emits no applied-diff signal, so failed or denied edits are included"* — and the activity-volume-not-productivity label (§6.3) is reinforced by this (it is explicitly a *requested-activity* signal).

### 6.2 Filtering (pinned)

- **`.gitignore` semantics, applied at *edit time*.** When an Edit/Write event is processed, its `file_path` is tested against the project `.gitignore` ruleset *then*, and the included/excluded decision is durable for that event. NOT re-evaluated at display time — otherwise counts mutate retroactively as `.gitignore` evolves (confusing). No `.claudeignore` dotfile is introduced.
- **Override: `settings.runtime.locIgnorePaths`** (settings-namespace per §8d: runtime-supervisor behavior). It **augments** `.gitignore` (additional exclude patterns added to the ruleset) — it does **not** replace it (replace would force operators to restate all of `.gitignore` to add one pattern). Default: `.gitignore` rules only.

### 6.3 Aggregation + UI

- Per-agent aggregate: `{ added: number, removed: number, removedUnknown: boolean, filesTouched: number }`. `removedUnknown` is `true` if any contributing `Write` had `removed: null`.
- **UI placement**: agent rail, next to each agent. Render `+added / −removed`. When `removedUnknown`, render `+added / —` at the per-event level and, in the **aggregate**, render `+added / −removed` treating unknown as `0` for the sum **with a footnote**: *"removed counts exclude overwrite-write operations where prior length is unknowable."* This null-handling choice is pinned so every UI surface (rail, tooltip, aggregate) treats `null` identically.
- **Honest framing (pinned):** labelled **activity volume, not productivity**. Show `+1,847 / −412`, never a "productivity score." The label discipline is itself a requirement, not cosmetic (same honesty discipline as B's sealed `source`).
- **Tooltip = per-FILE breakdown (pinned, Finding #7).** The tooltip expands to a **per-file** breakdown, not per-task. Per-file falls directly out of the per-event `file_path` records; a per-*task* breakdown would require task-attribution machinery that is **not** specified (and §6.1 pins attribution to the *agent*, not the task). Per-task is explicitly out of Slice 1 (a future slice could add it if task-attribution is built).

---

## 7. Scope, non-goals, commit sequencing

**In Slice 1:** `eventNarration` module + `NarrationKind` sealed enum +
wiring both client consumers + agreement test + behavior-changes table;
`locCount` module + agent-rail UI + tests.

**Explicitly out (post-C, banked):** persistence of narrated lines;
server-side ingestor consumer; span detection / span-grouped /
expandable activity UI; the Layer-2 spawned-CLI summarizer
(`notes/deferred-decisions.md`). No DB/ingestor/supervisor/RuntimeEventBus
changes in Slice 1.

**Ship as two commits, in sequence** (independent; refactor-first then
feature, same shape as `judgeSpawn` extraction → L3 build):

1. **Commit 1 — `eventNarration` consolidation.** Extract the module + sealed `NarrationKind`; wire `timelineProjection` and `deriveAgentActivity` (incl. the new agent-card `'system'`-kind handling, §4.4); the import-purity test; the fixture-coverage test; the agreement test + filled `behaviorTable.json`. Reviewable as "consolidation preserves rendering (modulo the documented table)." **Bound:** if the behavior table exceeds the §5 soft cap (>20 entries) the rulings split into **Commit 1b — `eventNarration` consolidation rulings**, keeping Commit 1 a reviewable preservation unit.
2. **Commit 2 — `locCount` + rail UI.** Extract the module; wire the agent rail; LoC tests; formula/filtering docs. Reviewable as "new activity-volume indicator added."

(Plus a small documentation commit for the new PROJECT.md invariant — §9 below. The §8e invariant + this spec were committed at brainstorm close — `005389c`; the implementation commits are the two/three above.)

---

## 8. Testing & gates

- **TDD throughout** (project discipline).
- `eventNarration`: per-event unit tests across the full taxonomy (tool_use incl. MCP-prefixed, assistant_text, turn_*, compact_boundary, api_retry, malformed/missing-field events → must degrade to a safe line, never throw); **`tokens` per-type assertions mirroring §4.1's full enumeration** (`turn_completed` → its `output_tokens`; `turn_failed` → `output_tokens` if the partial `usage` is present else `null`; `tool_use` / `assistant_text` / `compact_boundary` / `api_retry` / `approval_request` → `null`); the **import-purity test** (no `node:*` builtins in the transitive import set); the **fixture-coverage test** (≥1 of every event type + ≥1 MCP `tool_use`); the **golden-snapshot agreement test** vs the two committed pre-consolidation goldens (`feedGolden.json` = `eventToStreamEntry`→`bodyForStream` path; `cardGolden.json` = `deriveAgentActivity` path) over the committed fixture, comparing adapted `narrate()` (signature-keyed, `⊆` pass-condition, recoverable >20 soft-cap acknowledgment gate, divergence-output file); plus exhaustiveness tests for the two taxonomy adapters (`NarrationKind`→`StreamEntry.kind`, `NarrationKind`→`AgentActivityKind`) — a missing case is a `tsc`/test failure.
- `locCount`: formula tests (Edit/MultiEdit/Write incl. `removed:null` Write, empty content, no-trailing-newline); `.gitignore` edit-time filtering; `locIgnorePaths` augment-not-replace; attribution (deleter not penalised); aggregate `removedUnknown` propagation + footnote rendering.
- **Gates:** root `npm test` `fail 0`; UI `cd ui && npm run typecheck` zero `error TS` + `npm run build` ✓. Both new modules wired into the canonical `npm test` chain (no un-wired-test false-green).

---

## 9. PROJECT.md invariant (banked as part of this slice's documentation)

Add **§8e — Consolidation-requires-deliberate-reconciliation — INVARIANT**:
a consolidation cycle (collapsing ≥2 implementations of one logical
decision into a shared module) MUST include a deliberate
divergence-reconciliation step: capture real fixtures → run all
implementations + the new module → table every disagreement → rule per
case → commit the rulings as a documented behavior-changes table.
Discovering edge-case divergence in production is the failure mode this
prevents. Origin: this slice (event→prose existed twice, divergently).

**Grounded scope note (surfaced, not smoothed):** the discrete §8
INVARIANT headings in PROJECT.md today are exactly **§8c**
(shared-helper-over-reimplementation) and **§8d** (grounding-first +
settings-namespace, just tightened with the "is this greenfield?"
question). The other disciplines enumerated in discussion
(structural-deletion-vs-flag-disabled; liveness-tests-for-tunable-
settings) are **not** currently discrete §8 headings — they live in the
L3 / Sub-project-B spec lineage as inline rulings. The "consistency
pass" is therefore scoped to the §8c/§8d/§8e block (parallel
heading/structure), **not** a sweeping rewrite. Whether to also promote
those other disciplines to discrete §8 invariants is a separate, deferred
decision — flagged here, not silently actioned.

---

## 10. Pinned-vs-open summary

**Incumbent inventory (grounded correction — planning-time):** the
consolidation collapses `agentStream.summarizeToolInput` **and**
`useToadData.summarizeToolCall` into `narrate()`, replaces
`agentStream.eventToStreamEntry`'s event→kind classification with
`narrate()` + a pinned `NarrationKind`→`StreamEntry.kind` adapter, and
maps `narrate()`'s kind into `deriveAgentActivity` via a pinned
`NarrationKind`→`AgentActivityKind` adapter. `timelineProjection.tsx`
(`bodyForStream`/`projectTimeline`) is an unchanged-logic *consumer* of
the now-`narrate()`-fed `StreamEntry`. The agreement test compares
committed **golden snapshots** of both pre-consolidation paths
(feed: `eventToStreamEntry`→`bodyForStream`; card:
`deriveAgentActivity`) vs adapted `narrate()`. `summarizeToolInput` and
`summarizeToolCall` are both **deleted**.

**Pinned:** Option 1 architecture; module path `src/runtime/eventNarration/`
(browser-safe pure — no `node:*`/fs/path/env, import-purity test);
`narrate(event, options?) → {line, kind, tokens}` signature with
`tokens` **always present**, `number|null`, sourced *by `narrate()`* as
`num(event.raw?.usage?.output_tokens) ?? null` (non-null only for
`turn_completed`/`turn_failed`; per-type test assertions — Finding #2);
post-C persists `{line, kind, tokens}` — **`kind` IS persisted**
(Finding #1); sealed exported `NarrationKind`; narration-vs-composition
contract (A) with the Layer-2 half-life caveat flagged in
`notes/deferred-decisions.md` (Finding #5); new agent-card `'system'`
handling is a named wiring task (Finding #3); preserve current rendering
/ no new feed UX / no visual companion (B); agreement-test mechanics
fully pinned — fixture min-coverage test, signature-hash matching key,
`behaviorTable.json` format (`{ entries, softCapAcknowledged?,
acknowledgmentRationale? }`; each old/new = `{line,kind}` tuple),
`⊆`-pass-condition, failure-output ergonomics, and the **coherent
recoverable soft cap** — >20 needs a committed acknowledgment marker
(not a forever-fail), commit-1b split is an independent review-ergonomics
choice (Finding #4 + round-2 #1); `narrate()` consumes the `event.raw`
shape, post-C ingestor adapts `payload.raw`; `salientInput` superset-of-
narrate's-read-set lockstep invariant; `subtype = event.raw?.subtype`
(grounded); `num` strict (never coerces strings); `approval_request →
'system'` proposed, disposition open-per-reconciliation (round-2 #2); `locCount` sibling module with
the Edit/MultiEdit/Write formulas, `lineCount` predicate, no-op-edit=0,
`filesTouched=|unique|`, Bash-changes-excluded, requested-not-applied
known-limitation footnote (Finding #6), `removed:null` for Write,
edit-time `.gitignore` filtering, `locIgnorePaths` augment-not-replace,
null-as-0-with-footnote aggregate, activity-volume-not-productivity
label, **per-file** (not per-task) tooltip (Finding #7);
two-(or-three-)commits-in-sequence; §8e invariant.

**Open (resolved during implementation, by the agreement test, not by
guesswork):** the exact `NarrationKind` mapping for `turn_completed` /
`turn_failed` / `compact_boundary` / `api_retry` / `approval_request`;
the specific per-divergence rulings in the behavior-changes table.
These are deliberately left to the reconciliation step — pinning them
now would be inventing answers the captured fixture must decide.

---

**Review-trail legend.** `Finding #N` = the first fresh-eyes spec
review; `round-2 #N` = the second. The inline tags are an audit trail
of *why* a pin exists (traceable to the review that forced it). They
are deliberately retained, not migrated to a separate changelog — a
reader hitting a non-obvious pin can trace its origin in place. Future
slices may drop the convention once the spec stabilises; it is not a
required spec section.
