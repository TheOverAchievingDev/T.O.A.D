# Readability Layer-2 P3b-2 — Span-Summary Monitor (Trigger/Lifecycle) Design

**Status:** Approved (brainstorm complete 2026-05-17)
**Predecessor:** P3b-1 span-summarizer engine (commits `c19feb7` + `aa7f0d6`)
**Successor:** P3c cockpit/status surfacing (OUT OF SCOPE here)

## 1. Goal

Flip the dormant, fully-tested P3b-1 engine into a live background process. P3b-2
is the **first and only production caller** of `summarizePendingSpans`. It adds a
periodic monitor that, over every live team, calls
`listSpansAwaitingSummary` → `summarizePendingSpans` and exposes an honest
in-memory status snapshot. Nothing else changes — no engine internals, no P3a /
P2b / P2a / P1 / drift behavior, no UI.

## 2. Scope

**In scope (the entire change):**

- New unit: `src/runtime/spanSummary/summaryMonitor.js` — a `SummaryMonitor`
  class, all IO injected, mirroring `src/drift/driftMonitor.js` 1:1 plus an
  `inFlight` skip-guard and a `getStatus()` accessor.
- Wiring: one additive composition block in `scripts/dev-api-server.mjs`
  (the ONLY allowed production-file edit), mirroring the existing drift-monitor
  block.
- Tests: a TDD unit suite + an anti-inert e2e suite, both wired into the
  ratified `scripts/test-suites.txt` chain.

**Out of scope (controller diffs these EMPTY across the P3b-2 range):**

- P3c cockpit/status UI (`toad-local/ui`).
- Any change to drift (`src/drift`), P1 narration, P2a `composeTimeline`,
  P2b `detectSpans`, P3a (`sqliteSpanSummaryStore.js`,
  `spanSummary/decideSpansToSummarize.js`), or the P3b-1 engine internals
  (`buildSummaryPrompt.js`, `extractSummaryText.js`, `resolveSummaryRoute.js`,
  `summarizerSystemPrompt.js`, `summaryRateLimiter.js`, `runSpanSummary.js`,
  `summarizePendingSpans.js`, `index.js`).
- `src/app/LocalToadRuntime.js`, `src/read/LocalReadModel.js`.
- No new runtime method, no HTTP endpoint, no event-trigger seam, no in-run
  failover, no local-model fallback.

**The one allowed production change** is `scripts/dev-api-server.mjs`: 4 added
import lines, one additive `if (driftDb)` composition block, one
`summaryMonitor.stop()` line in `shutdown()`. The controller diffs this file
and confirms NOTHING else in it mutated (drift block, runtime construction,
zombie sweep, SIGINT/SIGTERM, logging all byte-identical).

## 3. Grounded pins (§8d — verified against real shipped code)

1. **`DriftMonitor` precedent** — `src/drift/driftMonitor.js`: class with private
   `#timer`; constructor `{ engine, listLiveTeams, intervalMs = 5*60*1000,
   logger = console }` with `TypeError` guards on `engine.runDrift` and
   `listLiveTeams`; `start()` idempotent (`if (#timer) return;`
   `setInterval(() => this.tickOnce().catch(log), intervalMs)`; `#timer.unref()`);
   `stop()` (`clearInterval`; `#timer = null`); `tickOnce()` async (`await
   listLiveTeams()`; empty → return; `Promise.all` per team in its own
   `try/catch` that swallows + logs). `DEFAULT_INTERVAL_MS = 5 * 60 * 1000`.
   Note: DriftMonitor has **no** overlapping-tick guard — P3b-2 adds one (a
   targeted robustness improvement justified by the heavier CLI fan-out; the
   drift module is NOT modified).
2. **`scripts/dev-api-server.mjs` lifecycle** — the drift block lives at
   lines ~62–156 inside `if (driftDb) { … }` (`driftDb =
   runtime.runtimeRegistry?.db || runtime.eventLog?.db ||
   runtime.taskBoard?.db`). Settings are read once at startup
   (`const all = await runtime.settingsStore.readEffective()` ~line 71,
   try/catch → undefined). `listLiveTeams` is derived (~lines 119–128) from
   `runtime.runtimeRegistry.listRuntimes()` filtered to status
   `running|live|starting` → unique non-empty `teamId`s. `shutdown()`
   (~lines 212–218) calls `driftMonitor.stop()` then `await runtime.close()`;
   registered on `SIGINT` and `SIGTERM`. The HTTP API server is started inside
   `runtime.start()` (~line 170) — there is **no** status/health endpoint in
   this file (consistent with deferring the UI surface to P3c).
   `dev-api-server.mjs` imports **nothing** from `src/runtime/spanSummary/`
   today (P3b-1 has zero production callers — confirmed).
3. **`SettingsStore`** — `src/settings/settingsStore.js`: `readEffective()` is
   **async**, returns the merged namespaced sections (+ `_sources`). `summarizer`
   is a forward-compatible unknown section preserved as-is. Drift passes the
   **whole** `readEffective()` result as `settings`; the engine sub-reads
   `settings.drift`. P3b-2 mirrors exactly: pass the whole `all` snapshot as
   `settings`; the orchestrator/route sub-read `settings.summarizer`.
4. **P3a contract** — `runtime.listSpansAwaitingSummary({ teamId,
   runtimeId = null })` (delegates to `LocalReadModel.listSpansAwaitingSummary`
   → `decideSpansToSummarize`; **requires** a non-empty `teamId`).
   `runtime.spanSummaryStore.appendSummary(...)` is idempotent first-write-wins
   by `spanId`. `runtime.listSpanSummaries(...)` is available for read-back.
5. **Lead-provider signal** — `runtime.teamConfigRegistry.get(teamId)` returns a
   `TeamConfig | null`; `TeamConfig.lead = normalizeMember(...)` guarantees a
   non-empty `.providerId` string (default `'anthropic'`). Grounded
   `leadProviderId = runtime.teamConfigRegistry?.get?.(teamId)?.lead?.providerId
   ?? 'anthropic'`.
6. **P3b-1 engine signatures (consumed, unchanged):**
   - `summarizePendingSpans({ teamId, listAwaiting, appendSummary,
     leadProviderId, settings, limiter, runImpl, cwd, isolateHome })` →
     `{ summarized:[{spanId,model,cli}], degraded:[{spanId,reason}],
     skippedRateLimited:number }`; NEVER throws; `resolveSummaryRoute` is
     called internally per span.
   - `runSpanSummary(...)` → `{ok:true,summaryText}|{ok:false,reason}` with
     `reason ∈ SUMMARY_FAIL_REASONS`; NEVER throws.
   - `new SummaryRateLimiter({ maxPerHour = 20, now = Date.now })`;
     `tryAcquire(teamId)` rolling-hour, a `false` does NOT record.
7. **§8d P2b ingestion path for the e2e** — ingest a `tool_use` event for an
   UNREGISTERED runtime (narration persists before the identity check, then
   `ingest` throws — tolerate ONLY `/unknown runtime identity/`), then a
   `turn_completed` event (kind `system`, no identity check) closes the span →
   exactly one closed span.

## 4. Architecture

```
dev-api-server.mjs (composition root, inside the existing `if (driftDb)`)
  └─ new SummaryMonitor({
        intervalMs,                 // settings.summarizer.intervalMs || 5-min default
        listLiveTeams,              // identical derivation to the drift block
        resolveLeadProviderId,      // teamConfigRegistry.get(t).lead.providerId ?? 'anthropic'
        summarize: ({teamId, leadProviderId}) =>
          summarizePendingSpans({   // P3b-1, unchanged
            teamId, leadProviderId,
            listAwaiting:  a => runtime.listSpansAwaitingSummary(a),
            appendSummary: s => runtime.spanSummaryStore.appendSummary(s),
            runImpl:       runSpanSummary,
            limiter:       summaryLimiter,   // one shared SummaryRateLimiter
            settings:      all,              // whole readEffective() snapshot
            cwd:           projectCwd || undefined,
            isolateHome:   false,
          }),
     })
  └─ summaryMonitor.start();
  └─ shutdown(): summaryMonitor.stop()  // BEFORE await runtime.close()
```

## 5. The `SummaryMonitor` unit — `src/runtime/spanSummary/summaryMonitor.js`

A class mirroring `DriftMonitor` 1:1, all IO injected.

**Constructor** `{ summarize, listLiveTeams, resolveLeadProviderId,
intervalMs = 5 * 60 * 1000, logger = console }`

- `TypeError` guards: `summarize` must be a function; `listLiveTeams` must be a
  function; `resolveLeadProviderId` must be a function (mirrors DriftMonitor's
  ctor-guard discipline).
- `summarize({ teamId, leadProviderId })` → resolves to the orchestrator report
  `{summarized[],degraded[],skippedRateLimited}`; production binds the rest of
  the orchestrator deps via closure (only `teamId`+`leadProviderId` vary).
- Private `#timer = null`; private `#inFlight = false`; private `#status`
  (the snapshot, initial state `idle`, all counts 0, `lastRunAt = null`).

**`start()`** — idempotent: `if (#timer) return;`
`#timer = setInterval(() => this.tickOnce().catch(err =>
this.logger.warn('[summary] tick failed:', err)), this.intervalMs);`
`if (typeof #timer.unref === 'function') #timer.unref();`
(Byte-equivalent shape to DriftMonitor lines 48–54.)

**`stop()`** — `if (#timer) { clearInterval(#timer); #timer = null; }`
(idempotent; safe before `start()`).

**`tickOnce()`** — `async`, **never throws**:

1. If `#inFlight` → `logger.warn('[summary] tick skipped: previous in flight')`;
   `return`.
2. `#inFlight = true`; `const startedAt = Date.now()`.
3. `try`:
   a. `const teams = await Promise.resolve(this.listLiveTeams());`
   b. if not a non-empty array → finalize status as `idle` (0 counts); return.
   c. accumulate across `await Promise.all(teams.map(async (teamId) => { try {
      const leadProviderId = this.resolveLeadProviderId(teamId);
      const r = await this.summarize({ teamId, leadProviderId });
      // accumulate r.summarized.length, r.degraded.length,
      // r.skippedRateLimited, and r.degraded[].reason into local tallies
   } catch (err) { this.logger.warn(`[summary] team=${teamId} failed:`, err); }
   }));` (per-team isolation is defense-in-depth — `summarize` already never
   throws, but mirrors DriftMonitor's per-team swallow so a thrown
   `resolveLeadProviderId`/`summarize` cannot wedge the tick).
4. `finally`: write the per-tick tallies + the **settled** classification
   (`degraded` / `rate-limited` / `idle` per §`getStatus()` step 2) into
   `#status` = `{ state: <settled>, lastRunAt: startedAt,
   lastDurationMs: Date.now() - startedAt, teamsPolled, summarizedCount,
   degradedCount, skippedRateLimited, lastReasons }`; then `#inFlight = false`.
   (`#status.state` never stores `summarizing` — that dimension is overlaid by
   `getStatus()` from the live `#inFlight`.)

Any throw from steps 3a–3c (e.g. `listLiveTeams` itself throwing) is caught by
the surrounding `try/finally` so `tickOnce` resolves (never rejects out of the
timer) and `#inFlight` is always cleared.

**`getStatus()`** — returns a fresh shallow copy
`{ state, lastRunAt, lastDurationMs, teamsPolled, summarizedCount,
degradedCount, skippedRateLimited, lastReasons }` (mutating the returned object
must not affect internal state). `teamsPolled`, `summarizedCount`,
`degradedCount`, `skippedRateLimited` are numbers; `lastReasons` is a string[];
`lastRunAt`/`lastDurationMs` are numbers (`lastRunAt = null` before the first
tick).

**State derivation — single source of truth.** `getStatus()` computes `state`
at call time:

1. if `#inFlight` is currently `true` → `'summarizing'` (takes precedence,
   regardless of the last persisted outcome)
2. else return the **persisted settled state**, computed once at the end of the
   last completed tick (in the `finally`) from that tick's tallies:
   - `degradedCount > 0` → `'degraded'`
   - else `skippedRateLimited > 0 && summarizedCount === 0` → `'rate-limited'`
   - else → `'idle'` (covers `summarizedCount > 0`, zero pending, and the
     never-run initial state)

So the only call-time-dynamic input is `#inFlight`; the
degraded/rate-limited/idle classification is frozen per-tick. No tick has yet
run → `#inFlight` false and the initial persisted state is `'idle'`.

`lastReasons` = deduplicated array of `degraded[].reason` strings observed in
the last tick (members of the sealed run set plus the orchestrator-only
`persist_failed`), so P3c can show the truthful cause without inventing one.

## 6. The wiring block — `scripts/dev-api-server.mjs`

Placed immediately after the existing drift block, **inside the same
`if (driftDb) { … }`**, reusing the `all` settings snapshot already read for
drift (no second `readEffective()`):

```js
// top of file, with the other imports
import { SummaryMonitor } from '../src/runtime/spanSummary/summaryMonitor.js';
import { summarizePendingSpans } from '../src/runtime/spanSummary/summarizePendingSpans.js';
import { runSpanSummary } from '../src/runtime/spanSummary/runSpanSummary.js';
import { SummaryRateLimiter } from '../src/runtime/spanSummary/summaryRateLimiter.js';

// inside `if (driftDb) { … }`, after the drift-monitor block:
const sumCfg = (all && typeof all === 'object' && all.summarizer) || {};
const sumIntervalMs =
  Number.isFinite(sumCfg.intervalMs) && sumCfg.intervalMs > 0
    ? sumCfg.intervalMs
    : undefined;                 // undefined → SummaryMonitor's 5-min default
const summaryLimiter = new SummaryRateLimiter({
  maxPerHour:
    Number.isFinite(sumCfg.maxPerHour) && sumCfg.maxPerHour > 0
      ? sumCfg.maxPerHour
      : 20,
});
const summaryMonitor = new SummaryMonitor({
  intervalMs: sumIntervalMs,
  listLiveTeams: () => {
    const runtimes = runtime.runtimeRegistry?.listRuntimes?.() ?? [];
    const liveTeams = new Set(
      runtimes
        .filter((r) => r && (r.status === 'running' || r.status === 'live' || r.status === 'starting'))
        .map((r) => r.teamId)
        .filter((tid) => typeof tid === 'string' && tid.length > 0)
    );
    return Array.from(liveTeams);
  },
  resolveLeadProviderId: (teamId) =>
    runtime.teamConfigRegistry?.get?.(teamId)?.lead?.providerId ?? 'anthropic',
  summarize: ({ teamId, leadProviderId }) =>
    summarizePendingSpans({
      teamId,
      leadProviderId,
      listAwaiting: (a) => runtime.listSpansAwaitingSummary(a),
      appendSummary: (s) => runtime.spanSummaryStore.appendSummary(s),
      runImpl: runSpanSummary,
      limiter: summaryLimiter,
      settings: all,
      cwd: projectCwd || undefined,
      isolateHome: false,
    }),
});
summaryMonitor.start();
```

`shutdown()` gains, **before** `await runtime.close()` and alongside
`driftMonitor.stop()`:

```js
if (summaryMonitor && typeof summaryMonitor.stop === 'function') {
  summaryMonitor.stop();
}
```

**Grounded rationale for the fixed choices:** `cwd: projectCwd` mirrors how
drift threads `projectCwd`; `isolateHome: false` because the summarizer must use
the operator's normal provider-CLI auth (`isolateHome` scrubs `CLAUDE_*` — it
exists only for drift's credential-isolated judge and would break summary auth);
`settings: all` is the whole effective snapshot, the orchestrator sub-reads
`.summarizer` (exact drift mirror); the `if (driftDb)` guard means no project /
`:memory:` with no sqlite handle → no monitor (no false "running" state).

## 7. Data flow (one tick)

`setInterval` fires → `tickOnce()` → inFlight guard passes → `listLiveTeams()`
(running/live/starting → unique teamIds) → `Promise.all` per team:
`resolveLeadProviderId(teamId)` → `summarize({teamId,leadProviderId})` →
`summarizePendingSpans` → per pending span: `resolveSummaryRoute` (lead-minus
route + `settings.summarizer` overrides) → `SummaryRateLimiter.tryAcquire` →
`runSpanSummary` (one-shot provider CLI) → `{ok:true}` → `appendSummary`
(P3a idempotent) else `degraded[]` → report bubbles up → monitor accumulates →
`#status` written.

## 8. Error handling & honest degradation (totality)

- **Never throws out of the timer**: the `start()` `.catch()` backstop + the
  inner per-team `try/catch` + the `try/finally` around the whole tick body
  guarantee a stuck/failed team or a throwing `listLiveTeams` cannot wedge the
  monitor or leak `#inFlight`.
- **Honest degradation, never papered over**: a failed span stays `pending`
  (P3b-1 never persists junk) → retried next tick; idempotent via P3a
  first-write-wins. Degraded reasons surface verbatim in
  `getStatus().lastReasons` and the `degraded` state.
- **Rate-limited is a distinct honest state** (skipped, not failed) so P3c can
  show "throttled, not broken."
- **No project / no sqlite** → monitor never constructed (mirrors drift).

## 9. Testing

TDD throughout: write the failing test, watch it fail for the right reason,
minimal green.

**Unit — `test/spanSummary.summaryMonitor.test.js`** (injected deps; call
`tickOnce()` directly, no real timers/CLI/db):

- ctor `TypeError` on missing/invalid `summarize` / `listLiveTeams` /
  `resolveLeadProviderId`
- `start()` idempotent (double-start → one timer), calls `setInterval`,
  `unref()` invoked; `stop()` clears, idempotent, safe before `start()`
- empty live teams → status `idle`, `summarize` never called
- one team → `resolveLeadProviderId` + `summarize({teamId,leadProviderId})`
  called; status reflects the report
- multi-team → `Promise.all`, counts/reasons accumulate
- per-team isolation: one team's `summarize` throws → others still processed,
  `tickOnce` does not throw, status still written
- inFlight guard: second `tickOnce()` while the first's `summarize` is pending
  → skipped + logged (`summarize` called once); `#inFlight` cleared in
  `finally` even when a team throws (a subsequent tick proceeds)
- state machine: every branch — `summarizing` / `degraded` /
  `rate-limited` (skipped>0 & summarized==0) / `idle`
- `getStatus()` full shape + returns a copy (mutating it doesn't poison
  internal state); `lastReasons` deduped from degraded reasons;
  `lastRunAt`/`lastDurationMs` set
- never throws when `listLiveTeams` throws or `resolveLeadProviderId` throws
- `intervalMs` default `5*60*1000` when omitted; custom honored

**Anti-inert e2e — `test/spanSummary.summaryMonitor.e2e.test.js`**: real
`LocalToadRuntime` + real P3a (`listSpansAwaitingSummary` /
`spanSummaryStore.appendSummary`) + real `summarizePendingSpans` + real
`SummaryRateLimiter` + a **FAKE `runImpl`** (no real CLI, ever) driving a real
`SummaryMonitor.tickOnce()` (called directly, not via real timers). Ingest the
§8d P2b path → one closed span; assert `listSpansAwaitingSummary` shows it →
`monitor.tickOnce()` → span persisted via real P3a → second `tickOnce()`
excludes it (idempotent) → `getStatus().summarizedCount === 1` and
`state === 'idle'`. Proves genuine composition (the P1/P2b/P3a/P3b-1 accepted
anti-inert pattern), not a faked feature.

**Wiring & gates:** append both suites to `scripts/test-suites.txt`
(150 → 152, in dependency order after the existing P3b-1 suites);
`package.json` `scripts.test` stays `node scripts/run-test-suites.mjs`. The
controller independently re-runs the FULL root suite via the runner, greps
both new titles in its OWN output, and reconciles the pass-count delta exactly
versus the post-P3b-1 **1533** baseline (never trusts pasted numbers).

## 10. Controller independent-verification surfaces

- `SummaryMonitor` never throws out of the timer; the inFlight guard truly
  serializes (controller drives concurrent `tickOnce()`, a throwing team, a
  throwing `listLiveTeams`, and proves `finally` always clears `#inFlight`).
- The state machine matches §5 exactly (controller re-derives every branch
  from first principles).
- `dev-api-server.mjs` is the ONLY production file changed and ONLY by the
  additive block + 4 imports + the one `shutdown()` line (controller diffs the
  file and confirms the drift block, runtime construction, zombie sweep,
  SIGINT/SIGTERM, and logging are byte-identical).
- Out-of-scope diff EMPTY across the P3b-2 range for drift / P1 / P2a / P2b /
  P3a engine + store + decide-core / `LocalToadRuntime` / `LocalReadModel` /
  `ui` / the P3b-1 engine files.
- The e2e genuinely composes real `LocalToadRuntime` + real P3a + a FAKE
  `runImpl` (controller confirms NO real CLI, genuine persistence +
  idempotency, real `SummaryMonitor` driving the real engine).
- The un-wired-test trap at the commit boundary (controller re-runs full root
  via the runner, greps both titles in its own output, reconciles +N exactly).
- Mandatory whole-implementation subagent review before the commit.

## 11. Commit decomposition

**One atomic commit.** Files (5): `src/runtime/spanSummary/summaryMonitor.js`,
`test/spanSummary.summaryMonitor.test.js`,
`test/spanSummary.summaryMonitor.e2e.test.js`, `scripts/dev-api-server.mjs`,
`scripts/test-suites.txt`. TDD is strict within the commit: unit suite
red→green first, then the e2e, then the wiring, then full-root fail-0 +
whole-impl review, then commit. Rationale: the unit is inert without the
wiring and the wiring is meaningless without the unit; one commit also keeps
the shared `dev-api-server.mjs` touch in a single reviewable diff (eases
deconfliction with concurrent guardrail work). Post-commit verify:
`git show --stat HEAD` exactly 5 files; the §10 out-of-scope diffs EMPTY;
`dev-api-server.mjs` diff is only the additive block + imports + shutdown line.

## 12. Session conventions

Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed
paths, `git -c commit.gpgsign=false`, trailer
`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
Subagent-driven execution: fresh implementer per task, two-stage review
(spec-compliance then code-quality) with fix-loops, controller independently
verifies every DONE.
