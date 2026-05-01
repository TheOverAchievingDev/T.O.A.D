# Stuck/Zombie Runtime Detector — Checklist §13 follow-up

Date: 2026-05-01
Status: in progress

Builds on §11 (runtime→task pinning) and the auto-consume fix that makes `runtime_events` flow for live agents. Also reuses `SqliteRuntimeEventLog.listEventsByTask` join.

## Goal

Detect agent runtimes that are alive but silent — process is still running, but stream-json events have stopped flowing past a configurable inactivity threshold. Useful for:

- catching agents stuck in tool-loops they can't escape
- catching agents waiting on a permission that nobody answered
- catching crashed-but-still-PID-alive child processes
- surfacing "this task hasn't moved in N minutes" to the operator

Detection only — this slice does **not** stop or restart the runtime. Stopping is the operator's call (or a future auto-recovery slice).

## Design

### Pure function

`src/diagnostics/stuckRuntimeDetector.js`:

```js
detectStuckRuntimes({
  runtimes,              // [{ runtimeId, teamId, agentId, taskId, status, ... }]
  latestEventByRuntime,  // Map<runtimeId, ISO timestamp>
  now,                   // ISO timestamp
  thresholdMs,           // inactivity threshold (default 15 * 60_000)
}) → [{ runtimeId, taskId, teamId, agentId, lastEventAt, silentMs, thresholdMs }]
```

Rules:
- Only `status === 'running'` runtimes are candidates.
- A runtime with no events at all uses `runtime.startedAt` as the reference.
- `silentMs = now - lastEventAt`. Stuck when `silentMs > thresholdMs`.
- Output sorted by `silentMs` descending (most-stuck first).

### Wrapper

`src/diagnostics/listStuckRuntimes.js`:

```js
listStuckRuntimes({ runtimeRegistry, eventLog, thresholdMs, now }) → stuckList
```

Pulls running runtimes from the registry, looks up latest event per runtime, calls the pure detector.

### MCP tool

`stuck_runtime_list` — read-only, all roles, no idempotency. Args: `{ thresholdMs?: number }`. Returns the detector output. Wired into `LocalToolFacade` and added to `COMMON_READ_TOOLS`.

### Diagnostics integration

A new check in `runDiagnostics` for system-level summary:
- `id: stuck_runtimes_within_threshold`
- pass when no running runtimes exceed the threshold; warning when ≥1 stuck.
- Evidence: list of runtimeIds + silentMs.

## Out of scope

- Auto-stop / auto-restart on detection (operator-driven only this slice).
- Heartbeats explicit (the detector uses the natural cadence of `runtime_events`).
- UI presentation (handed off to the design phase).

## TDD plan

1. Detector unit tests (8): empty input; all silent within threshold; one stuck; multiple stuck (sorted by silentMs); non-running ignored; runtime with no events uses startedAt; threshold default; threshold override.
2. Wrapper unit test (3): combines registry + eventLog correctly; passes threshold through; empty registry returns empty.
3. Facade dispatch test (1): `stuck_runtime_list` returns the list.
4. Diagnostics check test (2): pass when none stuck; warning when ≥1 stuck.
