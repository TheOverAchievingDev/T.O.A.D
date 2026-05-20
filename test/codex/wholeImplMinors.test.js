/**
 * W6 — whole-impl review minors (Minor 7 intentionally NOT done: there is no
 * grounded real "unknown session" resume-failure stderr text; the broad
 * UNKNOWN_SESSION_RE is the fail-safe direction — a false-positive only
 * degrades to a re-grounded fresh turn, a false-negative from over-tightening
 * would wedge the agent. Revisit only when the real text is grounded.)
 *
 * Minor 6: the registry-backed session store must NOT issue a redundant
 * setRuntimeCliSessionId (UPDATE + updated_at bump) every resume turn when
 * the session id is unchanged (codex re-emits the SAME thread_id each turn).
 *
 * Minor 8: StuckRuntimeMonitor must not let one throwing supervisor.getAdapter
 * abort the whole pass (incl. detection of OTHER stalled agents).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntimeRegistrySessionStore } from '../../src/runtime/codex/runtimeRegistrySessionStore.js';
import { StuckRuntimeMonitor } from '../../src/diagnostics/stuckRuntimeMonitor.js';

test('Minor 6: session store skips the redundant write when cliSessionId is unchanged', () => {
  const registry = {
    _v: null,
    _calls: 0,
    getRuntime() { return { cliSessionId: this._v }; },
    setRuntimeCliSessionId({ cliSessionId }) { this._calls += 1; this._v = cliSessionId; },
  };
  const store = makeRuntimeRegistrySessionStore(registry);

  store.set('r', 's1');           // new value → write
  store.set('r', 's1');           // SAME value (next resume turn) → must be a no-op
  store.set('r', 's1');           // still same → still no-op
  assert.equal(registry._calls, 1, 'unchanged session id must not re-issue setRuntimeCliSessionId');

  store.set('r', 's2');           // changed → write
  assert.equal(registry._calls, 2);
  assert.equal(registry._v, 's2');
});

test('Minor 8: a throwing supervisor.getAdapter for one runtime does not abort the whole stuck pass', () => {
  const T0 = '2026-05-18T00:00:00.000Z';
  const NOW = '2026-05-18T01:00:00.000Z';
  const runtimes = [
    { runtimeId: 'r-bad', teamId: 't1', agentId: 'dev-bad', deliveryMode: 'session_turn', status: 'running', startedAt: T0 },
    { runtimeId: 'r-codex-1', teamId: 't1', agentId: 'dev-1', deliveryMode: 'session_turn', status: 'running', startedAt: T0 },
  ];
  const supervisor = {
    getAdapter: (id) => {
      if (id === 'r-bad') throw new Error('adapter probe blew up');
      return { turnStartedAt: T0, isTurnInFlight: () => true };
    },
  };
  const monitor = new StuckRuntimeMonitor({
    runtimeRegistry: { listRuntimes: () => runtimes },
    eventLog: { latestEventByRuntime: () => new Map() },
    eventBus: { emit: () => {} },
    supervisor,
    now: () => NOW,
    thresholdMs: 15 * 60_000,
    setTimer: () => 0, clearTimer: () => {},
  });

  let stuck;
  assert.doesNotThrow(() => { stuck = monitor.tick(); }, 'one bad adapter probe must not throw the whole pass');
  // The healthy in-flight stalled agent is still detected.
  assert.ok(stuck.some((s) => s.runtimeId === 'r-codex-1'),
    'a stalled session agent must still be flagged despite a sibling probe throwing');
});
