# Timeline Composition Extraction (Readability Layer-2 P2a) — design

> **Lineage / decomposition.** The post-Sub-project-C readability
> **Layer-2** work decomposed into independent sub-projects, each its
> own spec → plan → implementation cycle:
> **P1** server-side narration persistence (shipped — commits
> `71f9c4c` + `47d1369`) · **P2a** composition extraction (this doc) ·
> **P2b** span detection over the persisted narrated stream ·
> **P3** the banked spawned-CLI summarizer (untouched, unblocked by
> P2a+P2b). Agreed order **P2a → P2b → P3**. This spec is **P2a only**.
> Origin: the banked "Composition extraction (narration↔composition
> boundary half-life)" deferred decision in
> `notes/deferred-decisions.md` — its named half-life is now due.
>
> **Grounding-first discipline (§8d).** Derived by reading the real
> shipped code (`ui/src/components/cockpit/timelineProjection.tsx`,
> `ui/src/utils/agentStream.ts`, `ui/src/components/cockpit/FlowTimeline.tsx`,
> `CockpitForMe.tsx`, P1's `SqliteNarrationStore.listNarration`, and the
> `eventNarration` Slice-1 golden-agreement harness), NOT prose.
> Surfaced facts the banked sketch predated: `projectTimeline` consumes
> the **client** `StreamEntry[]` (lossy `HH:MM:SS` `parseStreamTimestamp`
> heuristic, agent-grouped) — a *different shape/fidelity* than P1's
> persisted rows (real ISO `createdAt`, flat); its output `TimelineEvent`
> carries `body: ReactNode` (**JSX — cannot live in a shared
> server-importable pure module**); no span concept exists anywhere
> today.

**Out of scope (non-goals):** span detection (P2b); the P3
summarizer/LLM; the historical-view UI; any change to `narrate()` /
narration persistence; any change to `CockpitForMe` / `FlowTimeline`
(`projectTimeline`'s public signature + return are **preserved** — they
stay untouched); any behavior change to the rendered cockpit timeline
(strict byte-preservation).

---

## 1. Goal & success criterion

`projectTimeline` (`timelineProjection.tsx`, ~278 lines, client TSX)
tangles **pure data-composition** (per-agent recency window, candidate
sort + cap, drift-pair fold, task-lifecycle fold, merge/sort, dot, when)
with **view rendering** (`bodyForStream`/`lifecycleBody`/drift-body →
`ReactNode` JSX). The banked decision: extract the composition into a
**shared pure module** (single source of truth, the §8c discipline that
produced `eventNarration` Slice-1) so P2b/P3 reuse it server-side over
P1's persisted narrated stream — **without changing the rendered
cockpit timeline at all**.

P2a is a **pure preservation refactor**: it relocates logic, ships
**zero behavior change**, and is gated by a **strict byte-identical**
golden-agreement test on the client output (it is a refactor, not a
consolidation — there is no legitimate wording change to rule, so the
gate has no behaviorTable escape hatch).

**Success criterion:** the new pure `composeTimeline` core lives in
`src/runtime/timelineComposition/` (zero imports, server-importable, the
`eventNarration` pattern); `timelineProjection.tsx` becomes a thin
adapter+renderer over it with `projectTimeline`'s signature/return
unchanged; the strict agreement test proves the post-refactor client
path is byte-identical to a golden captured from the **pre-refactor**
code; `composeTimeline` has direct pure unit + purity tests; new suites
wired into the canonical `npm test` chain; root `npm test` `fail 0`;
UI `tsc -b`/`vite build` green; `CockpitForMe`/`FlowTimeline`
byte-unchanged.

---

## 2. Architecture (A1 — shared pure core + thin client renderer + strict one-time golden)

Chosen over **A2** (fresh server `composeTimeline`, client left as-is —
exactly the §8c "Layer-2 reinvents composition server-side" smell the
banked decision explicitly rejected; two drifting copies) and **A3**
(client fetches composed rows from a new server endpoint — huge blast
radius, changes cockpit UX/perf, violates "preserve client exactly").
A1 is the proven `eventNarration` Slice-1 extraction shape and the only
option satisfying *extract-to-single-source + byte-preserve-client +
server-importable-for-P2b/P3*.

### 2.1 The cut & data flow

```
raw RuntimeEvent ──narrate()──▶ {line,kind,tokens}        (Slice-1, shipped, UNTOUCHED)

CLIENT  (timelineProjection.tsx — becomes thin adapter+renderer):
  StreamEntry[] (per-agent) + agents + driftHistory + taskTransitions
    │  client adapter:  ts = parseStreamTimestamp(entry, now)   ← lossy HH:MM:SS heuristic STAYS client-side
    ▼
  composeTimeline({ agentStreams, agents, driftHistory?, taskTransitions?, now, limit? })   ← NEW shared pure core
    │  per-agent slice(-4) · sort ts desc · slice(0,limit) head
    │  drift: sorted slice(-4) pairwise |Δ|≥3 cap-2 · lifecycle fold
    │  merge · sort by _ts desc · slice(0,limit) · strip _ts
    │  derive id · when(formatRelative) · dot(dotForStream/Drift/lifecycleDot) · expanded(idx===0?true:undefined)
    ▼
  ComposedRow[]   (JSX-FREE — id/when/dot/expanded/kind + one typed payload)
    │  client renderer:  ComposedRow → TimelineEvent{ ...row, body: ReactNode }
    │                     via bodyForStream / lifecycleBody / drift-body (VERBATIM JSX builders, relocated client-side)
    ▼
  projectTimeline(input): TimelineEvent[]   ← SAME public signature/return → CockpitForMe & FlowTimeline UNCHANGED

SERVER  (P2b/P3, later — NOT built here): composeTimeline is server-importable; the adapter feeds
        ts = Date.parse(listNarratedTimeline row.createdAt). Same pure core, no JSX.
```

Only the JSX `body` builders and the lossy client timestamp parse stay
client-side. `projectTimeline`'s contract is preserved → the only
modified production file is `timelineProjection.tsx` (it shrinks to
adapter+renderer); the new pure module + tests are additive.

### 2.2 Contracts (exact, JSX-free)

**`composeTimeline(input) → ComposedRow[]`** — input is normalized; the
per-agent windowing/folding stays *in* the core (it is composition
P2b/P3 also need, not adapter glue):

```
input = {
  agentStreams: Record<agentId, Array<{ entryId:string, kind:'thought'|'tool'|'output'|'system',
                                         tool?:string, body:string, ts:number }>>,
  agents:       Array<{ id:string, name:string }>,
  driftHistory?:     Array<{ runId:string, teamScore:number, createdAt:string }>,
  taskTransitions?:  Array<{ taskId:string, title:string, fromStatus:string|null,
                             toStatus:string, agentId:string|null, at:number }>,
  now: number,
  limit?: number,                    // default 8
}

ComposedRow = {
  id: string,
  when: string,                      // formatRelative(ts, now)
  dot: TimelineDot,                  // 'clay'|'green'|'blue'|'amber'|'violet'
  expanded?: boolean,
  kind: 'stream'|'drift'|'lifecycle',
  stream?:    { agentName:string, entryKind:'thought'|'tool'|'output'|'system', tool?:string, body:string },
  drift?:     { prevScore:number, nextScore:number },
  lifecycle?: { taskId:string, title:string, fromStatus:string|null, toStatus:string, agentLabel:string|null },
}
```

The core replicates the **exact current `projectTimeline` algorithm**
so client output is byte-identical:

- stream: per-agent `entries.slice(-4)` → candidates `{agentId, …, ts}`
  → `sort((a,b)=>b.ts-a.ts)` → `slice(0,limit)` head; per head item
  `id = \`stream-${entryId}-${idx}\``, `when = formatRelative(ts,now)`,
  `dot = dotForStream(entryKind)`, `expanded = idx===0 ? true :
  undefined`, `_ts = ts`; `stream` payload `{ agentName (resolved from
  agents, fallback agentId), entryKind, tool, body }`.
- drift: `(driftHistory ?? []).slice().sort((a,b)=>Date.parse(a.createdAt)
  -Date.parse(b.createdAt)).slice(-4)`; for `i=1..` while emitted `<2`,
  skip if `|curr.teamScore-prev.teamScore| < 3` or `Date.parse(curr.
  createdAt)` is NaN; `id = \`drift-${curr.runId}\``, `when =
  formatRelative(Date.parse(curr.createdAt),now)`, `dot =
  dotForDrift(prev.teamScore,curr.teamScore)`, `_ts =
  (driftHistory?.length ?? 0)*1000 - i`; `drift` payload `{ prevScore,
  nextScore }`.
- lifecycle: per `taskTransitions ?? []`, `id = \`task-${taskId}-${at}\``,
  `when = formatRelative(at,now)`, `dot = lifecycleDot(t)`, `_ts = at`;
  `lifecycle` payload `{ taskId, title, fromStatus, toStatus, agentLabel
  (resolved from agents when agentId, else null) }`.
- merge `[...stream, ...lifecycle, ...drift]` → `sort((a,b)=>b._ts-
  a._ts)` → `slice(0,limit)` → strip `_ts` → `ComposedRow[]`.

`dotForStream`/`dotForDrift`/`lifecycleDot`/`formatRelative` are pure
data functions (color string / relative-time string) — they **move
verbatim into the core**. `bodyForStream`/`lifecycleBody`/the drift-body
JSX builders **stay client-side verbatim**; the client renderer maps
each `ComposedRow`'s payload through them to produce `body: ReactNode`,
then assembles `TimelineEvent { id, when, dot, expanded, body }`.
Byte-identical: every field — including `body` — is produced by the
same code over the same inputs, only relocated.

`TimelineDot` is currently declared in `FlowTimeline.tsx`. The shared
core needs the dot string values but must not import a `.tsx`.
**Resolution (no ambiguity, zero blast radius):** the core declares its
**own** sealed dot-string set (the `NARRATION_KINDS` discipline) and
emits those literal strings; `FlowTimeline.tsx`'s `TimelineDot` type is
left **byte-unchanged** and is **not** imported from / does not import
the core (introducing a cross-layer type import would be new coupling
beyond the preservation scope). The two declarations are kept in sync by
a **guard assertion in the purity/compose test** that the core's
dot-value set equals the `FlowTimeline` union members exactly — so any
future drift fails the build — *not* by a code dependency. (Same
"duplicate-the-tiny-frozen-set, guard-by-test, no import coupling"
stance the `eventNarration` `NARRATION_KINDS` extraction took.)

---

## 3. Testing

- **TDD throughout.**
- **One-time pre-refactor golden capture (mirror eventNarration
  Slice-1).** A throwaway `scripts/captureTimelineCompositionGolden.mjs`
  copies the *current verbatim* `projectTimeline` +
  `bodyForStream`/`lifecycleBody`/drift-body over a committed hand-built
  fixture `test/fixtures/timelineComposition.input.json` (≥1 per kind:
  multi-agent streams that force the per-agent `slice(-4)` window + the
  `limit` cap, a chatty agent, a drift pair with `|Δ|≥3` and one `<3`,
  task transitions incl. create / done / generic-move, an
  empty-streams case) and emits the committed golden
  `test/fixtures/timelineComposition.golden.json` = serialized
  `TimelineEvent[]` `{ id, when, dot, expanded, bodyHtml:
  renderToStaticMarkup(body) }`. Generated **once, before** the
  refactor; never auto-rewritten (regenerated only by deliberately
  re-running the script).
- **Strict agreement test** (`test/timelineComposition.agreement.test.js`):
  run the *post-refactor* `projectTimeline` over the same fixture,
  serialize identically, assert **byte-identical to the golden — ANY
  divergence fails the build.** No behaviorTable (it is a refactor, not
  a consolidation). `react-dom/server` `renderToStaticMarkup` is the
  deterministic body serializer both sides use.
- **Pure-core unit tests** (`test/timelineComposition.compose.test.js`):
  `composeTimeline` directly over the normalized contract — per-agent
  `slice(-4)` windowing; `limit` cap; drift threshold (`≥3` emits,
  `<3` skips), drift cap-2, NaN-date skip; lifecycle fold (create / done
  / move payloads + `agentLabel` resolution); merge ordering by the
  exact `_ts` keys; `dot`/`when`/`id`/`expanded` derivation;
  empty/missing `driftHistory`/`taskTransitions`/`agentStreams`.
- **Purity guard** (`test/timelineComposition.purity.test.js`): the
  `src/runtime/timelineComposition/` module imports no
  `node:`/`fs`/`path`/`os`/`child_process`/`react`, no JSX, never
  touches `process` (server-importable — the `eventNarration` purity
  precedent).
- **Gates:** new suites wired into the canonical `npm test` chain (grep
  the new suite titles in the *actual* full-run output — the
  un-wired-test false-green trap); root `npm test` `fail 0`; UI
  `tsc -b`/`vite build` green (the thin `timelineProjection.tsx`
  adapter+renderer typechecks against the new module and the cockpit
  still builds — proves the extraction didn't break the client); a
  **whole-implementation review before each commit** (the gate that
  caught the auth no-creds Critical and the readability
  lying-behaviorTable).

---

## 4. Surfacing / behavior

P2a surfaces nothing new and changes nothing the operator sees — the
cockpit timeline renders byte-identically (that is the entire gate).
Its deliverable is internal: a single shared composition source of
truth, server-importable, ready for P2b (span detection over P1's
persisted stream) and P3. Same "relocate, preserve exactly, prove with
a golden" discipline as the `eventNarration` Slice-1 extraction.

---

## 5. Pinned / open (resolved at plan-time by grounding, not pre-invented)

- **`TimelineDot` ownership.** Grounded: declared in `FlowTimeline.tsx`
  as `'clay'|'green'|'blue'|'amber'|'violet'`. The pure core owns the
  sealed dot-string set; `FlowTimeline`/client keep their `TimelineDot`
  type structurally identical. Confirm the exact union members against
  the real `FlowTimeline.tsx` at plan-time and that no third
  consumer's type drifts (no behavior change).
- **`bodyForStream`/`lifecycleBody`/drift-body relocation.** These move
  *verbatim* into the client renderer half of `timelineProjection.tsx`
  (they already live there); the refactor re-points them to consume a
  `ComposedRow` payload instead of a raw `StreamEntry`/transition.
  Confirm the exact field set each uses against the real functions at
  plan-time so the `ComposedRow.{stream,drift,lifecycle}` payloads are
  necessary-and-sufficient (no extra, none missing).
- **Body serialization for the golden.** `renderToStaticMarkup` from
  `react-dom/server`; confirm it is available to the test runner /
  the existing UI test tooling at plan-time, else use the equivalent
  deterministic recursive text flatten the eventNarration agreement
  harness used. The serializer must be identical on the capture side
  and the agreement side.
- **Module path / import seam.** New `src/runtime/timelineComposition/`
  (`index.js` + `composeTimeline.js`), imported by
  `ui/src/components/cockpit/timelineProjection.tsx` via the same
  relative `../../../src/runtime/...` path `agentStream.ts` already uses
  to import `eventNarration` — confirm the exact relative path at
  plan-time.

---

## 6. Scope summary

**In:** `src/runtime/timelineComposition/` pure `composeTimeline` core
(window/cap/drift-fold/lifecycle-fold/merge/sort + `dot`/`when`/`id`/
`expanded`, JSX-free) + sealed dot enum; the `timelineProjection.tsx`
refactor to a thin adapter (StreamEntry/drift/transition → normalized
input, `ts` via the kept client `parseStreamTimestamp`) + renderer
(`ComposedRow` → `TimelineEvent` via the kept-client-side verbatim JSX
builders) with `projectTimeline`'s public contract preserved; one-time
golden capture + strict byte-identical agreement test + pure-core unit
+ purity suites; full TDD + gates.

**Out (explicit / banked):** P2b span detection; P3 summarizer/LLM; the
historical-view UI; any `narrate()`/narration-persistence change; any
`CockpitForMe`/`FlowTimeline` change; any rendered-timeline behavior
change.

**Likely commit decomposition (plan finalizes):** **Commit 1** =
the one-time golden-capture script + committed fixture + committed
golden + the strict agreement test wired into `npm test` (captures the
**current untouched** behavior as the frozen baseline — reviewable as
"baseline locked, nothing refactored yet"). **Commit 2** = the
`src/runtime/timelineComposition/` pure core + purity/compose unit
suites + the `timelineProjection.tsx` refactor + the agreement test now
passing byte-identical against the Commit-1 golden + gates + whole-impl
review. Two atomic commits in the **safe order** (golden captured from
pristine code first, extraction proven against it second).
