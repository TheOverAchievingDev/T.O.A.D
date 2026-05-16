# Readability Layer — Slice 1: shared `eventNarration` + `locCount` — Design

**Status:** Approved for implementation planning (brainstormed + grounded 2026-05-16).
**Cycle:** First slice of the "readability layer" product line. Observation-window-safe, pure-additive.
**Out of this slice (banked, post-C):** server-side persistence of narrated lines, the span-grouped/expandable activity UI, and the Layer-2 spawned-CLI summarizer (`notes/deferred-decisions.md`).

---

## 1. Goal

Make the team's work legible by fixing the root cause of the current
unreadable event stream: **there is no single source of truth for
"event → human line."** Two divergent client-side implementations exist:

- `ui/src/components/cockpit/timelineProjection.tsx` → `projectTimeline()` — the cockpit "WHAT'S HAPPENING" feed (`"dev-1 ran Bash — npm run test:e2e"`, `reported`/`system:` verbs), with its own per-tool wording, its own ad-hoc `kind` strings (`'tool'|'system'|…`, inline/untyped, `:101-104`), and its own candidate-capping/drop policy.
- `ui/src/hooks/useToadData.ts` → `deriveAgentActivity()` / `summarizeToolCall()` — the per-agent-card *latest activity* blurb, with its own per-tool wording and a typed taxonomy `AgentActivityKind = 'text'|'tool'|'thinking'|'idle'` (`ui/src/types/index.ts:20`).

This is the §8c smell: two implementations of the same logical
decision (event→prose), guaranteed to disagree on edge cases. Slice 1's
work is **consolidation, not greenfield** (the §8d question-#1 catch).

Slice 1 also ships the **lines-of-code activity counter** — a sibling
pure module surfacing per-agent `+added / −removed / files` as a
glance-able *activity-volume* indicator (explicitly not a productivity
metric).

**Success criteria**
1. One pure module owns event→line; both client consumers import it; neither retains its own per-tool wording or `kind` taxonomy.
2. Cockpit feed and agent cards render *as before* except for a small set of **deliberately reconciled, documented** behavior deltas.
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
- **`timelineProjection` does multi-source composition** beyond per-event narration: it folds in drift-score-change rows and task-lifecycle-transition rows, and caps candidates "to stay cheap." That composition is **not duplicated** anywhere — it is single-site, view-specific work.
- **Two divergent `kind` taxonomies**: typed `AgentActivityKind` (`types/index.ts:20`) vs `timelineProjection`'s inline untyped strings (`:101-104`).

---

## 3. Architecture (locked: Option 1 — shared pure module, client-rendered now, persistence deferred)

A new pure module **`src/runtime/eventNarration/`** is the single
source of truth for event→line. Slice 1 wires only the two existing
**client** consumers to it. Persistence and the server-side ingestor
consumer are deferred to post-C, when the ingestor surface is being
touched anyway and a schema migration is acceptable cost-of-business.

```
                       ┌─────────────────────────────┐
   normalized event ─▶ │  src/runtime/eventNarration  │ ─▶ { line, kind, tokens? }
   (one event)         │  narrate(event, options?)    │
                       │  + NarrationKind (sealed)    │
                       └──────────────┬──────────────┘
              ┌───────────────────────┴───────────────────────┐
   (Slice 1) client consumers                    (post-C, deferred) server
   timelineProjection.projectTimeline()           RuntimeEventIngestor calls
     — delegates per-event rows to narrate(),        narrate() per event,
       keeps drift/task composition + capping        persists { line, tokens }
   deriveAgentActivity()                             with the raw event;
     — delegates per-event WORDING to narrate(),     Layer-2 summarizer reads
       keeps "latest/Working…/Thinking…" SELECTION   the persisted line stream
```

**Path is pinned:** `src/runtime/eventNarration/` — not `ui/` (would
imply client-only and block the post-C server consumer), not
`src/cockpit/` (would imply view-specific). The path declares the
intended consumers: shared client today, shared client+server post-C.
The module is pure (no I/O, deterministic) so it imports cleanly into
both the browser bundle and the Node ingestor.

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
narrate(event, options?) → { line: string; kind: NarrationKind; tokens?: number | null }
```

- **Pure, deterministic, no I/O.** One normalized event in → one line out.
- `line` — the operator-readable one-liner (e.g. `Reading recorder.ts`, `Bash: cargo test`, `Edited foo.rs`, `Created task T-12 — …`, `Sent message → reviewer`).
- `kind` — a value of the **sealed `NarrationKind` enum** (§4.3), so callers keep styling/verb control without re-deriving the taxonomy.
- `tokens?` — reserved metadata the **post-C ingestor** will persist alongside the raw event (token count / sizing hints). Today's client callers ignore it; it is `null`/omitted in Slice 1. Freezing it in the signature now means post-C adds a *caller*, not a signature change.
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

The *exact* final mapping for `turn_completed` / `turn_failed` /
`compact_boundary` / `api_retry`, and whether any of them deserves a
distinct kind, is a **reconciliation-table decision** (§5), not invented
here — the agreement test forces the explicit ruling. `'thinking'` /
`'idle'` from `AgentActivityKind` are **selection states, not narration
kinds**; they remain in `deriveAgentActivity`'s selection logic and are
intentionally NOT part of `NarrationKind`. Consumers that previously
switched on their own kind values map onto `NarrationKind` (e.g.
`timelineProjection`'s color/verb switch keys off `NarrationKind` — its
old `'system'→amber`, `'tool'→clay` mappings are preserved by mapping,
documented in the behavior table).

### 4.4 Wiring the two consumers (preserve rendering — Scope boundary B)

- `timelineProjection.projectTimeline()` — replace its per-tool wording + inline kind logic for **runtime-event rows** with `narrate()`. **Keep** its drift/task-transition composition and candidate-capping/drop policy verbatim. Color/verb selection switches on the imported `NarrationKind`.
- `deriveAgentActivity()` — replace its `summarizeToolCall()` wording with `narrate()`. **Keep** its "latest activity" selection and the `Working…/Thinking…` fallback (these are selection, not wording). `AgentActivity.kind` is sourced from `narrate()`'s `NarrationKind` (and the selection-only `'thinking'/'idle'` states it adds itself).

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

**Mechanism (pinned):** an **agreement test** (`node:test`) that:
1. Loads a captured real event-log fixture (a representative recorded run; committed under `test/fixtures/`).
2. Runs every fixture event through (a) old `projectTimeline` wording, (b) old `deriveAgentActivity`/`summarizeToolCall`, (c) new `narrate()`.
3. Emits every divergence (line text and/or kind) as a table.
4. **Fails** until every divergence is explicitly accounted for by an entry in a committed **behavior-changes table** in this spec's companion (§5.1) — i.e. divergence is ruled at consolidation time, never discovered in production.

Same discipline as the `isFileDeclaredByModule` agreement test and the
merge-gate "diff against trunk, only flag what this change introduces"
rule: surface intentional change vs. preserved-as-is explicitly.

### 5.1 Behavior-changes table (filled during implementation, lives in the spec/PR)

For each reconciled divergence: *event shape → old cockpit line / old card line → new line → ruling (which was right / new unified behavior) → rationale.* Empty at design time by construction; the implementer fills it as the agreement test surfaces cases. Reviewers read this table to see exactly what changed and why.

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
- Only `Edit`/`MultiEdit`/`Write` contribute. Non-file tools contribute nothing.
- **Attribution**: lines are credited to the agent that produced them. Deleting another agent's lines does **not** subtract from the deleter (count is what *this* agent produced, not net contribution) — otherwise an agent fixing a colleague's bug looks negative.

### 6.2 Filtering (pinned)

- **`.gitignore` semantics, applied at *edit time*.** When an Edit/Write event is processed, its `file_path` is tested against the project `.gitignore` ruleset *then*, and the included/excluded decision is durable for that event. NOT re-evaluated at display time — otherwise counts mutate retroactively as `.gitignore` evolves (confusing). No `.claudeignore` dotfile is introduced.
- **Override: `settings.runtime.locIgnorePaths`** (settings-namespace per §8d: runtime-supervisor behavior). It **augments** `.gitignore` (additional exclude patterns added to the ruleset) — it does **not** replace it (replace would force operators to restate all of `.gitignore` to add one pattern). Default: `.gitignore` rules only.

### 6.3 Aggregation + UI

- Per-agent aggregate: `{ added: number, removed: number, removedUnknown: boolean, filesTouched: number }`. `removedUnknown` is `true` if any contributing `Write` had `removed: null`.
- **UI placement**: agent rail, next to each agent. Render `+added / −removed`. When `removedUnknown`, render `+added / —` at the per-event level and, in the **aggregate**, render `+added / −removed` treating unknown as `0` for the sum **with a footnote**: *"removed counts exclude overwrite-write operations where prior length is unknowable."* This null-handling choice is pinned so every UI surface (rail, tooltip, aggregate) treats `null` identically.
- **Honest framing (pinned):** labelled **activity volume, not productivity**. Show `+1,847 / −412`, never a "productivity score." Tooltip expands to a per-task breakdown. The label discipline is itself a requirement, not cosmetic (same honesty discipline as B's sealed `source`).

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

1. **Commit 1 — `eventNarration` consolidation.** Extract the module + sealed `NarrationKind`; wire `timelineProjection` and `deriveAgentActivity`; agreement test + filled behavior-changes table. Reviewable as "consolidation preserves rendering (modulo the documented table)."
2. **Commit 2 — `locCount` + rail UI.** Extract the module; wire the agent rail; LoC tests; formula/filtering docs. Reviewable as "new activity-volume indicator added."

(Plus a small documentation commit for the new PROJECT.md invariant — §9 below.)

---

## 8. Testing & gates

- **TDD throughout** (project discipline).
- `eventNarration`: per-event unit tests across the full taxonomy (tool_use incl. MCP-prefixed, assistant_text, turn_*, compact_boundary, api_retry, malformed/missing-field events → must degrade to a safe line, never throw); the **agreement test** vs both incumbents over the committed fixture.
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

**Pinned:** Option 1 architecture; module path `src/runtime/eventNarration/`;
`narrate(event, options?) → {line, kind, tokens?}` signature; sealed
exported `NarrationKind`; narration-vs-composition contract (A);
preserve current rendering / no new feed UX / no visual companion (B);
`locCount` as sibling module with the Edit/MultiEdit/Write formulas,
`removed:null` for Write, edit-time `.gitignore` filtering,
`locIgnorePaths` augment-not-replace, null-as-0-with-footnote aggregate,
activity-volume-not-productivity label (C); agreement test +
behavior-changes table; two-commits-in-sequence; §8e invariant.

**Open (resolved during implementation, by the agreement test, not by
guesswork):** the exact `NarrationKind` mapping for `turn_completed` /
`turn_failed` / `compact_boundary` / `api_retry`; the specific
per-divergence rulings in the behavior-changes table. These are
deliberately left to the reconciliation step — pinning them now would
be inventing answers the captured fixture must decide.
