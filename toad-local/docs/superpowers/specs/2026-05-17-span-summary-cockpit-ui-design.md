# Readability Layer-2 P3c-2 — Span-Summary Cockpit UI Design

**Status:** Approved (brainstorm complete 2026-05-17)
**Predecessors (all shipped):** P3a (persistence), P3b-1 (engine), P3b-2 `aa7f0d6` (live `SummaryMonitor`), the flow-canvas redesign `e329e00`+`788c7d9`, P3c-1 `78932d8`+ratify `f098415` (the `/api/call` transport: `span_summary_list` + `span_summary_status`).
**Successor:** none — P3c-2 is the FINAL P3 sub-project; it completes the Readability Layer-2 span-summary vision.

## 1. Goal

Surface the span-summary subsystem to the operator in the cockpit: (a) render
the persisted plain-English span summaries interleaved into the cockpit
timeline ("the historical view is just rendered text"), and (b) show the honest
`SummaryMonitor` status (`summarizing`/`idle`/`rate-limited`/`degraded`/
`unavailable` + `lastReasons`) as a Statusbar segment — never papered over.
UI-only; P3c-2 is the first production caller of the P3c-1 commands.

## 2. The P3c-1 seam (consumed verbatim — NOT changed)

`/api/call` → `toolFacade.execute()` exposes two read commands (both in
`COMMON_READ_TOOLS`, dispatchable today, no UI caller yet):

- **`span_summary_list`** → `{ summaries: SpanSummaryRow[] }`, oldest-first,
  guarded/never-throws. `SpanSummaryRow = { spanId, teamId, runtimeId,
  agentId, sessionId, summaryText, model, cli, spanStartedAt, spanEndedAt,
  rowCount, tokens, createdAt }`. Team-scoped by `actor.teamId`; a teamless
  actor → `{ summaries: [] }`.
- **`span_summary_status`** → the P3b-2 `getStatus()` verbatim
  `{ state:'idle'|'summarizing'|'rate-limited'|'degraded', lastRunAt,
  lastDurationMs, teamsPolled, summarizedCount, degradedCount,
  skippedRateLimited, lastReasons:string[] }`, OR the frozen honest
  `{ state:'unavailable', lastRunAt:null, lastDurationMs:0, teamsPolled:0,
  summarizedCount:0, degradedCount:0, skippedRateLimited:0, lastReasons:[] }`
  when the monitor isn't running. No args. Never throws.

The UI client is `ui/src/api/client.ts`
`callTool<T>({ actor, method, args?, idempotencyKey?, signal? })` (POST to
`TOAD_API_CALL_URL`). P3c-2 uses it as-is.

## 3. Architecture

```
useSpanSummaries(activeTeamId)            [NEW sibling hook — Approach A]
  ├─ callTool({actor(teamId), method:'span_summary_list'})  → spanSummaries: SpanSummaryRow[]
  └─ callTool({actor(teamId), method:'span_summary_status'}) → summaryStatus: SummaryStatus|null
App.tsx  ── summaryStatus.state/lastReasons ─▶ <Statusbar>  (NEW non-clickable segment)
         └─ spanSummaries ─▶ <CockpitForMe> ─▶ timelineProjection.projectTimeline
              └─ projectSpanSummaryEvents(rows, now)  [NEW pure helper]
                 → TimelineEvent[] merged BY TIMESTAMP with composeTimeline rows
                 → <FlowTimeline events=…> (distinct 'violet' dot)
```

`composeTimeline` (P2a) is **not** modified — summaries are merged in the UI
`timelineProjection` layer. `useToadData.ts` is **not** modified (Approach A:
a sibling hook, minimizing contention with the hottest shared file and the
operator's concurrent grid-view track).

## 4. The dedicated hook — `ui/src/hooks/useSpanSummaries.ts` (NEW)

`useSpanSummaries(activeTeamId) → { spanSummaries: SpanSummaryRow[],
summaryStatus: SummaryStatus | null, error: string | null, refresh: () => void }`.

- Calls `callTool<{summaries:SpanSummaryRow[]}>({ actor, method:
  'span_summary_list' })` and `callTool<SummaryStatus>({ actor, method:
  'span_summary_status' })`, where `actor` is the **same team-scoped actor
  `useToadData` constructs** for `activeTeamId` (grounded at impl time from
  `useToadData.ts`'s actor — so `span_summary_list` is team-scoped; teamless
  actor → P3c-1 returns `[]`/`unavailable`, never throws).
- Mirrors `useToadData`'s `loadOnce` discipline: `useEffect` +
  `AbortController` + `try/catch`; (re)fetch on mount / `activeTeamId` change /
  `refresh()` (nonce). **Plus a modest status re-poll `setInterval`
  (30_000 ms)** — there is no SSE `runtime_event` on a `SummaryMonitor` tick,
  so without a poll the honest status would go stale. The interval is cleared
  on unmount/team change; aborted fetches don't set state.
- On ANY `callTool` error (network/abort/non-ok): keep the last good value,
  set `error`, NEVER throw out of the hook (mirrors `useToadData`).
  `summaryStatus` is `null` until the first successful status fetch (Statusbar
  hides the segment when null).
- Types are consumed verbatim from P3c-1 (§2); the hook declares matching
  local TypeScript interfaces (`SpanSummaryRow`, `SummaryStatus`) — it does
  NOT import backend types and does NOT reshape the payloads.

## 5. The pure projection core — `projectSpanSummaryEvents` (NEW)

A pure, React-free, total (never-throws) helper `projectSpanSummaryEvents(
rows: SpanSummaryRow[], now: number) → TimelineEvent[]`, in the NEW file
**`ui/src/components/cockpit/spanSummaryProjection.ts`** (mirrors the
`flowCanvasModel.ts` + `flowCanvasModel.test.mjs` precedent so the `.mjs` test
`tsc`-compiles it standalone — NO `@/` import; it declares its own local
`SpanSummaryRow`/`TimelineEvent`-compatible types rather than importing
`FlowTimeline`/`@/`).

- Each `SpanSummaryRow` → one `TimelineEvent`
  (`ui/src/components/cockpit/FlowTimeline.tsx`'s exported shape:
  `{ time:string, dot:TimelineDot, …body…, meta?:TimelineMeta[] }`):
  `dot:'violet'` (distinct from stream/drift/lifecycle); `time` = relative
  string derived from `spanEndedAt` (fallback `createdAt`, then `now`, if
  unparseable — NEVER throw); body = `summaryText`; optional `meta` chip =
  `model`/`cli` when present.
- A stable, internal sortable `ts` per event (epoch ms from `spanEndedAt`
  else `createdAt` else `now`) so `projectTimeline` can merge.
- Total: non-array / empty / malformed-row input → `[]` or well-formed
  events; missing/empty `summaryText` → the row is skipped (never a blank
  ghost row); never throws.
- `timelineProjection.tsx`'s `projectTimeline(input)` gains an optional
  `spanSummaries: SpanSummaryRow[]` input; it calls
  `projectSpanSummaryEvents`, concatenates the result with the existing
  `composeTimeline`-derived `TimelineEvent[]`, and sorts the combined list by
  `ts` so summaries interleave chronologically. `composeTimeline`/P2a output
  and the existing stream/drift/lifecycle mapping are untouched.

## 6. Render surfaces

**Statusbar segment** (`ui/src/components/Statusbar.tsx`): add props
`summaryState?: SummaryStatus['state'] | null` and
`summaryReasons?: string[]`. Render a new `status-seg` mirroring the drift
segment's markup, **non-interactive** (no target screen → a non-button
`status-seg` element; the drift seg is a `<button>` only because it navigates).
Tone (mirror `statusbarTone`): `degraded`/`unavailable` → `bad` (pulsing dot),
`rate-limited` → `warn`, `summarizing` → active, `idle` → quiet/green. Content:
a dot + `summaries` label + the state text; `title` tooltip = `Span summaries:
<state>` plus, when `summaryReasons` non-empty, ` — ` + reasons joined. Hidden
when `summaryState == null` (mirrors "null hides the segment").

**FlowTimeline** (`ui/src/components/cockpit/FlowTimeline.tsx`): it already
renders a generic `TimelineEvent[]` keyed on `dot`. The only change is
ensuring the `'violet'` dot has a visual treatment (a minimal dot/CSS addition
if not already styled; otherwise zero change). No structural/markup rework.

**Wiring (additive only):** `App.tsx` calls `useSpanSummaries(activeTeamId)`
alongside `useToadData`; threads `summaryStatus?.state`/`lastReasons` →
`<Statusbar>` (the new props) and `spanSummaries` → `<CockpitForMe>`.
`CockpitForMe.tsx` passes `spanSummaries` into the existing
`timelineProjection` call that builds the `events` for `<FlowTimeline … />`.

## 7. Dormant→live (the non-inert bar)

P3c-1's commands gain their genuine first production caller. P3c-2 is NOT a
faked feature: the controller independently confirms `useSpanSummaries` calls
`callTool` with both methods, `App.tsx` threads the results, and the
Statusbar/FlowTimeline render real data (a teamless/empty/`unavailable` path
renders the honest empty/unavailable, not a fabricated value).

## 8. Testing

- **TDD** `ui/test/spanSummaryProjection.test.mjs` for `projectSpanSummaryEvents`
  (the `flowCanvasModel` `tsc`-compile-then-`import` `node:test` harness): row→
  event mapping, `'violet'` dot, relative-time from `spanEndedAt` +
  unparseable fallback, blank-`summaryText` skipped, stable order, empty/
  non-array/malformed → well-formed empties, never throws.
- The hook + Statusbar + FlowTimeline + `App`/`CockpitForMe` wiring are
  view/IO-layer (no GUI e2e harness, consistent with the flow redesign):
  `cd ui && npm run typecheck` **clean (zero TS errors)** + `npm run build`
  **passes**; existing `ui/test/*.mjs` (incl. `flowCanvasModel`/`forMeViewMode`
  /`forMeFlowPanels`) stay green.
- These ui `.mjs` tests run via `cd ui && node --test test/X.test.mjs` — they
  are **NOT** in `scripts/test-suites.txt` (the backend chain). P3c-2 does
  **not** modify `test-suites.txt`; the backend root suite stays **1564 pass
  / 0 fail** unchanged (UI-only) — a cheap controller regression guard.

## 9. Commit decomposition — 2 ordered commits (data-layer-first)

- **Commit 1 (data layer):** `ui/src/hooks/useSpanSummaries.ts` (new) +
  `ui/src/components/cockpit/spanSummaryProjection.ts` (new — the pure
  `projectSpanSummaryEvents` helper) + `ui/test/spanSummaryProjection.test.mjs`
  (new, TDD).
- **Commit 2 (render + wiring):** `ui/src/components/cockpit/timelineProjection.tsx`
  (merge), `ui/src/components/Statusbar.tsx` (segment + props),
  `ui/src/components/cockpit/FlowTimeline.tsx` (the `'violet'` dot, if needed),
  `ui/src/App.tsx` + `ui/src/components/cockpit/CockpitForMe.tsx` (additive
  threading). `typecheck` + `build` green.

**Commit-hygiene gate (controller-verified — the P3b-2/P3c-1 lesson):** each
commit `git add` only its exact enumerated paths (never `-A`/`.`);
`git diff --cached --name-only` == exactly that set; NO `ui/src-tauri/**`
(Sub-project C), NO backend file, NO `.mockup-symphony-flow/**`, NO grid-view
file. Post-commit: `git show --stat HEAD` == the exact set; out-of-scope
`git diff --stat <pre> HEAD` EMPTY for `toad-local/src` (backend incl.
`composeTimeline`/P2a, P3c-1 transport, `summaryMonitor.js`, P3a, drift, P1,
P2b), `toad-local/ui/src-tauri`; `useToadData.ts` byte-unchanged (Approach A).
Mandatory whole-implementation subagent review before Commit 2.

## 10. §8d grounding pins (controller re-verifies at impl time)

- `callTool` signature/return-envelope handling (`ui/src/api/client.ts`); the
  `actor` shape `useToadData` constructs for the active team (the team-scoped
  read actor P3c-2 mirrors).
- `useToadData`'s `loadOnce`/`AbortController`/`refresh`-nonce/error pattern
  (the discipline `useSpanSummaries` mirrors; `useToadData` itself NOT edited).
- The exported `TimelineEvent`/`TimelineMeta`/`TimelineDot` shape
  (`FlowTimeline.tsx`) and `projectTimeline`'s signature/merge point
  (`timelineProjection.tsx`); `composeTimeline` (P2a) consumed unchanged.
- `Statusbar`'s `status-seg` markup + `statusbarTone` + the "null hides the
  segment" precedent (`Statusbar.tsx`).
- The P3c-1 command return shapes (§2) consumed verbatim — P3c-1 NOT changed.

## 11. Conventions

Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed
paths, `git -c commit.gpgsign=false`, trailer
`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
Subagent-driven execution: fresh implementer per task, two-stage review
(spec-compliance then code-quality), controller independently verifies every
DONE; the pure projection core is the epicenter; mandatory whole-impl review
before Commit 2. After P3c-2 ships, hand the operator the exact committed file
list so the grid-view track rebases onto it; the entire P3 arc is then
complete.
