import test from 'node:test';
import assert from 'node:assert/strict';
import { DriftMonitor } from '../../src/drift/driftMonitor.js';

function fakeEngine() {
  const calls = [];
  return {
    calls,
    async runDrift({ teamId, trigger, boundaryTaskId = null, boundaryTo = null }) {
      calls.push({ teamId, trigger, boundaryTaskId, boundaryTo });
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
      { teamId: 'team-a', trigger: 'periodic', boundaryTaskId: null, boundaryTo: null },
      { teamId: 'team-b', trigger: 'periodic', boundaryTaskId: null, boundaryTo: null },
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

test('DriftMonitor.notifyTaskEvent fires an off-cycle run for status transitions of interest + threads boundary args', async () => {
  const engine = fakeEngine();
  const monitor = new DriftMonitor({
    engine, listLiveTeams: () => ['team-a'],
  });
  await monitor.notifyTaskEvent({
    teamId: 'team-a',
    eventType: 'task.status_changed',
    payload: { from: 'in_progress', to: 'review' },
    taskId: 'task-42',
  });
  assert.equal(engine.calls.length, 1);
  assert.equal(engine.calls[0].trigger, 'task_event');
  // Step 5: the boundary task id + target status are threaded into
  // runDrift so the L3 gate has full boundary context.
  assert.equal(engine.calls[0].boundaryTaskId, 'task-42');
  assert.equal(engine.calls[0].boundaryTo, 'review');
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

test('DriftMonitor.notifyTaskEvent no longer fires for the dropped "testing" transition (design §3.2)', async () => {
  // testing was removed from TRIGGER_TRANSITIONS — L3 adjudicates at
  // the submission boundary (review/merge_ready/done), not at
  // intermediate work states. A testing transition is now a no-op.
  const engine = fakeEngine();
  const monitor = new DriftMonitor({
    engine, listLiveTeams: () => ['team-a'],
  });
  await monitor.notifyTaskEvent({
    teamId: 'team-a',
    eventType: 'task.status_changed',
    payload: { from: 'in_progress', to: 'testing' },
    taskId: 'task-1',
  });
  assert.equal(engine.calls.length, 0, 'testing must not trigger an off-cycle drift run');
});

test('DriftMonitor.notifyTaskEvent fires for merge_ready and done (still submission statuses)', async () => {
  for (const to of ['merge_ready', 'done']) {
    const engine = fakeEngine();
    const monitor = new DriftMonitor({
      engine, listLiveTeams: () => ['team-a'],
    });
    await monitor.notifyTaskEvent({
      teamId: 'team-a',
      eventType: 'task.status_changed',
      payload: { from: 'review', to },
      taskId: `task-${to}`,
    });
    assert.equal(engine.calls.length, 1, `${to} should fire`);
    assert.equal(engine.calls[0].boundaryTo, to);
    assert.equal(engine.calls[0].boundaryTaskId, `task-${to}`);
  }
});
