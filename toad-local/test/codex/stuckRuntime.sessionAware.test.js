import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStuckRuntimes } from '../../src/diagnostics/stuckRuntimeDetector.js';
import { StuckRuntimeMonitor } from '../../src/diagnostics/stuckRuntimeMonitor.js';

const T0 = '2026-05-18T00:00:00.000Z';
const NOW = '2026-05-18T01:00:00.000Z'; // 60 min later
const session = (over) => ({ runtimeId: 'r-codex-1', teamId: 't1', agentId: 'dev-1', deliveryMode: 'session_turn', status: 'running', startedAt: T0, ...over });

test('idle session agent (no in-flight turn) is NEVER flagged stuck even after long silence', () => {
  const out = detectStuckRuntimes({
    runtimes: [session()],
    latestEventByRuntime: new Map(),
    sessionInFlight: new Map(),
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.deepEqual(out, []);
});

test('in-flight session turn with no progress past threshold IS flagged stuck', () => {
  const out = detectStuckRuntimes({
    runtimes: [session()],
    latestEventByRuntime: new Map(),
    sessionInFlight: new Map([['r-codex-1', T0]]),
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].runtimeId, 'r-codex-1');
  assert.ok(out[0].silentMs > 15 * 60_000);
  assert.equal(out[0].lastEventAt, T0); // refMs = startMs (no events); ISO round-trip is lossless
});

test('in-flight session turn making recent progress is NOT flagged', () => {
  const out = detectStuckRuntimes({
    runtimes: [session()],
    latestEventByRuntime: new Map([['r-codex-1', '2026-05-18T00:58:00.000Z']]),
    sessionInFlight: new Map([['r-codex-1', T0]]),
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.deepEqual(out, []);
});

test('persistent (Claude) runtimes are unaffected by the session branch', () => {
  const out = detectStuckRuntimes({
    runtimes: [{ runtimeId: 'r-claude-1', teamId: 't1', agentId: 'lead', deliveryMode: 'runtime_stdin', status: 'running', startedAt: T0 }],
    latestEventByRuntime: new Map(),
    sessionInFlight: new Map(),
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].runtimeId, 'r-claude-1');
});

test('stale last event (from a prior turn, BEFORE turn-start) does NOT credit old progress — refMs is startMs, still flagged', () => {
  const STALE_EV = '2026-05-17T23:59:00.000Z'; // 1 min BEFORE T0 (belongs to the previous turn)
  const out = detectStuckRuntimes({
    runtimes: [session()],
    latestEventByRuntime: new Map([['r-codex-1', STALE_EV]]),
    sessionInFlight: new Map([['r-codex-1', T0]]),
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.equal(out.length, 1);                 // stale event must NOT reset the staleness clock
  assert.equal(out[0].runtimeId, 'r-codex-1');
  assert.equal(out[0].lastEventAt, T0);        // refMs = startMs, NOT the stale event
  assert.ok(out[0].silentMs > 15 * 60_000);
});

test('StuckRuntimeMonitor builds sessionInFlight from the supervisor and flags a stalled in-flight session turn', () => {
  const runtimes = [{ runtimeId: 'r-codex-1', teamId: 't1', agentId: 'dev-1', deliveryMode: 'session_turn', status: 'running', startedAt: T0 }];
  const supervisor = { getAdapter: (id) => (id === 'r-codex-1' ? { turnStartedAt: T0, isTurnInFlight: () => true } : null) };
  const events = [];
  const monitor = new StuckRuntimeMonitor({
    runtimeRegistry: { listRuntimes: () => runtimes },
    eventLog: { latestEventByRuntime: () => new Map() },
    eventBus: { emit: (n, e) => events.push([n, e]) },
    supervisor,
    now: () => '2026-05-18T01:00:00.000Z',
    thresholdMs: 15 * 60_000,
    setTimer: () => 0, clearTimer: () => {},
  });
  const stuck = monitor.tick();
  assert.equal(stuck.length, 1);
  assert.equal(stuck[0].runtimeId, 'r-codex-1');
  assert.ok(events.some(([n, e]) => n === 'runtime_event' && e.type === 'STUCK_RUNTIME_DETECTED' && e.runtimeId === 'r-codex-1'));
});
