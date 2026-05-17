# Readability Layer-2 P3c-1 — Span-Summary Transport Design

**Status:** Approved (brainstorm complete 2026-05-17)
**Predecessors (all shipped):** P3a (SqliteSpanSummaryStore + `LocalReadModel.listSpanSummaries` + LocalToadRuntime delegations), P3b-1 (span-summarizer engine), P3b-2 `eaacd23` (periodic `SummaryMonitor` wired live in `dev-api-server.mjs` with an in-memory `getStatus()`).
**Successor:** P3c-2 — the cockpit UI surfacing (separate brainstorm→spec→plan→execute cycle; NOT this).

## 1. Goal

Make the span-summary subsystem reachable by the (future P3c-2) cockpit UI by
adding two read/status commands to the existing `/api/call` → `toolFacade`
command surface, plus the one production wiring line that exposes the
P3b-2 `SummaryMonitor` to the facade. Backend-only; no UI.

## 2. Why a transport piece exists

P3b-2 deliberately added NO HTTP endpoint — `summaryMonitor.getStatus()` is an
in-memory accessor on a `dev-api-server.mjs` local `summaryMonitor` var, not on
the toolFacade/runtime, unreachable by the UI. The cockpit has no REST: every
read flows through `POST /api/call` → `toolFacade.execute({commandName,
actorId, args})` (command registry in `src/tools/localToolFacade.js`, names in
`src/commands/command-contract.js`). `runtime.listSpanSummaries` exists (P3a)
but is NOT yet a command. So the subsystem is invisible until a transport
exists. P3c was decomposed: **P3c-1 = this backend transport (isolated,
contention-free with the operator's flow/grid UI tracks); P3c-2 = the UI.**

## 3. Scope

**In scope (4 additive production edits + tests):**
1. `src/commands/command-contract.js` — add `SPAN_SUMMARY_LIST:
   'span_summary_list'` and `SPAN_SUMMARY_STATUS: 'span_summary_status'` to the
   `COMMANDS` map. Neither is idempotency-gated (`commandRequiresIdempotency`
   must return false for both, mirroring `task_list`/`approval_list`).
2. `src/tools/localToolFacade.js` — a frozen module constant
   `SPAN_SUMMARY_UNAVAILABLE` + two `case`s in `execute()`'s switch + two
   handlers (below).
3. `src/security/roleAuthority.js` — append `'span_summary_list'` and
   `'span_summary_status'` to the frozen `COMMON_READ_TOOLS` array (where
   `task_list`/`approval_list`/`runtime_list`/`health_status` live).
4. `scripts/dev-api-server.mjs` — ONE additive line, immediately after
   `summaryMonitor.start();`, inside the existing `if (driftDb)` block,
   byte-mirroring the existing `driftEngine` injection:
   `if (runtime.toolFacade) runtime.toolFacade.summaryMonitor = summaryMonitor;`
5. Pure-backend tests + wiring into the ratified `scripts/test-suites.txt`.

**Out of scope (controller diffs these EMPTY across the P3c-1 range):**
any `ui/` file (so ZERO contention with the just-shipped flow redesign
`e329e00`+`788c7d9` and the operator's grid-view track); the P3b-2
`SummaryMonitor`/`getStatus()` internals or lifecycle; `readModel`
`listSpanSummaries`/P3a store/decide-core; `src/drift`; P1 narration; P2a
`composeTimeline`; P2b `detectSpans`; any SSE/`/events` change (the cockpit
polls — poll commands suffice; YAGNI); the Sub-project C demo working-tree
changes (`ui/src-tauri/*`, backend compaction) — untouched/uncommitted.

The `dev-api-server.mjs` change is the single allowed production wiring line;
everything else in that file stays byte-identical.

## 4. The command contracts (grounded against shipped precedents)

### `span_summary_list`
Mirrors `approval_list` (`{ approvals: this.readModel.listApprovals({teamId:
actor.teamId}) }`) and its guard.

Handler:
```
{ summaries:
    (this.readModel
      && typeof this.readModel.listSpanSummaries === 'function'
      && actor && typeof actor.teamId === 'string' && actor.teamId.length > 0)
      ? this.readModel.listSpanSummaries({
          teamId: actor.teamId,
          runtimeId: (args && typeof args.runtimeId === 'string') ? args.runtimeId : null,
        })
      : []
}
```
- Envelope `{ summaries: [...] }` (mirrors `approval_list`→`{approvals}`,
  `tool_activity`→`{toolCalls}`).
- Rows verbatim from P3a `listSpanSummaries`: `{spanId, teamId, runtimeId,
  agentId, sessionId, summaryText, model, cli, spanStartedAt, spanEndedAt,
  rowCount, tokens, createdAt}`, ordered oldest-first (P3a's
  `ORDER BY created_at ASC, summary_id ASC`).
- Team scope = `actor.teamId` (the established read-command precedent);
  optional `args.runtimeId` (string) narrows to one runtime, else null = all.
- Guarded: missing/invalid `readModel`, OR a missing/empty `actor.teamId` →
  `{ summaries: [] }`. The `actor.teamId` guard is intentionally stricter than
  the `approval_list` precedent (which would let a teamless actor reach
  `readModel` and throw on its `requireString(teamId)`): a poll-safe read the
  cockpit hits must **genuinely never throw**, mirroring the never-throw
  discipline of `span_summary_status`. Never throws.

### `span_summary_status`
Exposes the P3b-2 `getStatus()` verbatim; honest `unavailable` object when the
monitor isn't injected.

Module constant:
```
const SPAN_SUMMARY_UNAVAILABLE = Object.freeze({
  state: 'unavailable', lastRunAt: null, lastDurationMs: 0,
  teamsPolled: 0, summarizedCount: 0, degradedCount: 0,
  skippedRateLimited: 0, lastReasons: [],
});
```
Handler:
```
(this.summaryMonitor && typeof this.summaryMonitor.getStatus === 'function')
  ? this.summaryMonitor.getStatus()
  : SPAN_SUMMARY_UNAVAILABLE
```
- Returns the P3b-2 `getStatus()` object **verbatim** when injected:
  `{state:'idle'|'summarizing'|'rate-limited'|'degraded', lastRunAt,
  lastDurationMs, teamsPolled, summarizedCount, degradedCount,
  skippedRateLimited, lastReasons}`.
- When absent (tests, no-project mode, monitor not constructed): the frozen
  `SPAN_SUMMARY_UNAVAILABLE` — same shape, `state:'unavailable'`. This is the
  P3 "never paper over degradation" principle at the transport boundary: the
  operator honestly sees "the summarizer monitor isn't running" rather than a
  faked `idle` or a hostile throw. `'unavailable'` is a transport-layer state
  the command adds; the P3b-2 `SummaryMonitor` itself never emits it and is NOT
  modified.
- Takes no args (the monitor is process-global; `getStatus()` is
  team-agnostic). Never throws.

`this.summaryMonitor` is NOT a `localToolFacade` constructor parameter — it
defaults to `null` (an instance field, like `this.driftEngine` defaults null)
and is late-injected by `dev-api-server.mjs` exactly as `driftEngine` is. No
constructor-signature churn.

### roleAuthority
`assertRoleCanCallTool` (called by `execute()`) throws unless the command is in
the actor role's allowlist; per-role lists spread the frozen
`COMMON_READ_TOOLS`. Both new commands MUST be appended to `COMMON_READ_TOOLS`
(mirroring `approval_list`/`runtime_list`/`health_status`) or every non-`human`
actor is denied → dead feature.

### dev-api-server wiring
Existing precedent at `dev-api-server.mjs:107` (inside `if (runtime.toolFacade)`
inside `if (driftDb)`): `runtime.toolFacade.driftEngine = driftEngine;`.
`summaryMonitor` is constructed at ~line 176 and `summaryMonitor.start()` at
~line 203. The single added line goes immediately after `summaryMonitor.start();`,
inside the same `if (driftDb)` block:
`if (runtime.toolFacade) runtime.toolFacade.summaryMonitor = summaryMonitor;`

## 5. Dormant-but-non-inert bar

P3c-1 has no UI caller yet (that's P3c-2) — the accepted P3b-1 pattern. It is
NOT a faked feature: the commands are genuinely dispatchable through the real
`/api/call` → `toolFacade.execute()` seam, tested end-to-end through
`facade.execute({commandName})`, and the `dev-api-server` injection is a real
production wiring line verified by a wiring test. The controller independently
drives both commands through the real `execute()` dispatch (role-authority
included) and confirms the injection is real.

## 6. Testing (TDD, pure backend)

- **command-contract**: `SPAN_SUMMARY_LIST==='span_summary_list'`,
  `SPAN_SUMMARY_STATUS==='span_summary_status'`; `commandRequiresIdempotency`
  false for both.
- **roleAuthority** (`test/roleAuthority.test.js`): both names in
  `COMMON_READ_TOOLS`; `assertRoleCanCallTool` permits them for the roles that
  may call `approval_list`/`runtime_list`; existing assertions stay green.
- **localToolFacade** (epicenter — drive the real `execute()` seam):
  - `span_summary_list`: injected fake `readModel.listSpanSummaries` →
    `{summaries:[...]}` invoked with `{teamId:actor.teamId, runtimeId}`; no
    `readModel`/missing method → `{summaries:[]}`; **actor with missing/empty
    `teamId` → `{summaries:[]}` (never reaches readModel, never throws)**;
    `args.runtimeId` non-string → passed as `null`.
  - `span_summary_status`: injected fake `summaryMonitor.getStatus()` →
    that object verbatim; `summaryMonitor` absent → the frozen
    `SPAN_SUMMARY_UNAVAILABLE` (`state:'unavailable'`); never throws; no args.
  - Both reachable via `execute({commandName, actorId, args})` and
    role-authority-allowed.
- **dev-api-server injection wiring**: the additive line sets
  `runtime.toolFacade.summaryMonitor` to the constructed monitor.
- Wire the new/extended suites into `scripts/test-suites.txt`. Controller
  independently re-runs the FULL root via `node scripts/run-test-suites.mjs`,
  greps the new suite titles in its OWN output, reconciles the exact pass-delta
  vs the post-P3b-2 / post-flow **1554** baseline, asserts
  `package.json scripts.test` unchanged (`node scripts/run-test-suites.mjs`).

## 7. Commit decomposition — ONE atomic commit

The four production edits + tests are one cohesive transport unit: the facade
`case` is inert without the contract entry AND the `COMMON_READ_TOOLS` entry
AND (for status) the dev-api injection; splitting them creates intermediate
broken/denied states. TDD within the commit (red→green per handler). Exact
files: `src/commands/command-contract.js`, `src/tools/localToolFacade.js`,
`src/security/roleAuthority.js`, `scripts/dev-api-server.mjs`, the test file(s),
`scripts/test-suites.txt`.

**Commit-hygiene gate (controller-verified — the P3b-2 lesson):** `git add`
the exact enumerated paths only (never `-A`/`.`); `git diff --cached
--name-only` == exactly that set; NO `ui/` file, NO `ui/src-tauri/*`, NO
`.mockup-symphony-flow`, NO unrelated Sub-project-C/backend file staged.
Post-commit: `git show --stat HEAD` == the exact set; out-of-scope
`git diff --stat <pre> HEAD` EMPTY for `src/drift`, the P3b-1 engine +
`summaryMonitor.js` internals, `sqliteSpanSummaryStore.js`,
`LocalReadModel.js`, P1/P2a/P2b, `ui`; the `dev-api-server.mjs` diff is ONLY
the single additive injection line (drift block / runtime construction /
SIGINT-SIGTERM / the P3b-2 summary block all byte-identical). Mandatory
whole-implementation subagent review before the commit.

## 8. §8d grounding pins (controller re-verifies at impl time)

- `approval_list` handler shape + `actor.teamId` use + the `if (!this.readModel
  || typeof this.readModel.listX !== 'function')` guard idiom.
- `commandRequiresIdempotency` excludes both new commands (mirror `task_list`).
- `COMMON_READ_TOOLS` is the correct frozen allowlist in
  `src/security/roleAuthority.js`; `test/roleAuthority.test.js` asserts it.
- The exact `dev-api-server.mjs` injection site mirrors line 107
  (`runtime.toolFacade.driftEngine = driftEngine;`); `summaryMonitor` is in
  scope there (constructed ~176, started ~203, inside `if (driftDb)`).
- P3a `listSpanSummaries` row contract is consumed verbatim, unchanged.

## 9. Conventions

Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed
paths, `git -c commit.gpgsign=false`, trailer
`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
Subagent-driven execution: fresh implementer, two-stage review
(spec-compliance then code-quality), controller independently verifies every
DONE; the localToolFacade command handlers are the epicenter; mandatory
whole-impl review before the commit. After P3c-1 ships, P3c-2 (the cockpit UI
surfacing) is its own brainstorm cycle — NOT auto-started.
