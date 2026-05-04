import test from 'node:test';
import assert from 'node:assert/strict';
import { DriftMonitor } from '../../src/drift/driftMonitor.js';

function fakeEngine() {
  const calls = [];
  return {
    calls,
    async runDrift({ teamId, trigger }) {
      calls.push({ teamId, trigger });
      return { runId: `r_${calls.length}`, teamScore: 0, status: 'healthy',
               findings: [], categoryScores: {}, perTaskScores: {},
               history: [], trigger, asOf: new Date().toISOString() };
    },
  };
}

test('DriftMonitor.tickOnce runs drift for every team with a live runtime', async () => {
  const engine = fakeEngine();
  const monitor = new DriftMonitor({
    engine,
    listLiveTeams: () => ['team-a', 'team-b'],
  });
  await monitor.tickOnce();
  assert.deepEqual(
    engine.calls.sort((a, b) => a.teamId.localeCompare(b.teamId)),
    [
      { teamId: 'team-a', trigger: 'periodic' },
      { teamId: 'team-b', trigger: 'periodic' },
    ]
  );
});

test('DriftMonitor.tickOnce skips when there are no live teams', async () => {
  const engine = fakeEngine();
  const monitor = new DriftMonitor({ engine, listLiveTeams: () => [] });
  await monitor.tickOnce();
  assert.equal(engine.calls.length, 0);
});

test('DriftMonitor.start / stop runs ticks at the configured interval', async () => {
  const engine = fakeEngine();
  const monitor = new DriftMonitor({
    engine, listLiveTeams: () => ['team-a'], intervalMs: 20,
  });
  monitor.start();
  await new Promise((r) => setTimeout(r, 70));
  monitor.stop();
  // 70ms / 20ms ≈ 3-4 ticks; allow some jitter.
  assert.ok(engine.calls.length >= 2 && engine.calls.length <= 5,
    `expected 2-5 ticks, got ${engine.calls.length}`);
});

test('DriftMonitor.notifyTaskEvent fires an off-cycle run for status transitions of interest', async () => {
  const engine = fakeEngine();
  const monitor = new DriftMonitor({
    engine, listLiveTeams: () => ['team-a'],
  });
  await monitor.notifyTaskEvent({
    teamId: 'team-a',
    eventType: 'task.status_changed',
    payload: { from: 'in_progress', to: 'review' },
  });
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].trigger, 'task_event');
});

test('DriftMonitor.notifyTaskEvent ignores transitions that are not in the trigger set', async () => {
  const engine = fakeEngine();
  const monitor = new DriftMonitor({
    engine, listLiveTeams: () => ['team-a'],
  });
  await monitor.notifyTaskEvent({
    teamId: 'team-a',
    eventType: 'task.status_changed',
    payload: { from: 'backlog', to: 'ready' },
  });
  assert.equal(engine.calls.length, 0);
});
