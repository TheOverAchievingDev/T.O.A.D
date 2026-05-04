import test from 'node:test';
import assert from 'node:assert/strict';
import { checkInvalidTransitions } from '../../../src/drift/checks/checkInvalidTransitions.js';

function snap(taskEvents) {
  return {
    teamId: 'team-a', asOf: '2026-05-04T10:00:00Z',
    tasks: [], taskEvents, runtimeEvents: [],
    foundryDocs: {}, worktrees: [], diffsByTask: {},
  };
}

test('flags ready→done as invalid transition', () => {
  const findings = checkInvalidTransitions({
    snapshot: snap([
      { taskId: 'task-1', eventType: 'task.created',
        createdAt: '2026-05-04T09:00:00Z',
        payload: { subject: 'x', status: 'ready' } },
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-04T09:05:00Z',
        payload: { from: 'ready', to: 'done' } },
    ]),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'architecture');
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].taskId, 'task-1');
  assert.equal(findings[0].checkName, 'check_invalid_transitions');
  assert.match(findings[0].actual, /ready/);
  assert.match(findings[0].actual, /done/);
});

test('does NOT flag legal transitions ready→planned→in_progress', () => {
  const findings = checkInvalidTransitions({
    snapshot: snap([
      { taskId: 'task-1', eventType: 'task.created',
        createdAt: '2026-05-04T09:00:00Z',
        payload: { status: 'ready', subject: 'x' } },
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-04T09:01:00Z',
        payload: { from: 'ready', to: 'planned' } },
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-04T09:02:00Z',
        payload: { from: 'planned', to: 'in_progress' } },
    ]),
  });
  assert.equal(findings.length, 0);
});

test('produces stable finding id for the same offense across runs', () => {
  const events = [
    { taskId: 'task-1', eventType: 'task.created',
      createdAt: '2026-05-04T09:00:00Z',
      payload: { status: 'ready', subject: 'x' } },
    { taskId: 'task-1', eventType: 'task.status_changed',
      createdAt: '2026-05-04T09:05:00Z',
      payload: { from: 'ready', to: 'done' } },
  ];
  const a = checkInvalidTransitions({ snapshot: snap(events) });
  const b = checkInvalidTransitions({ snapshot: snap(events) });
  assert.equal(a[0].id, b[0].id);
});
