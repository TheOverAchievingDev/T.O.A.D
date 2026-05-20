import test from 'node:test';
import assert from 'node:assert/strict';
import { checkReviewWithoutFindings } from '../../../src/drift/checks/checkReviewWithoutFindings.js';

function snap(taskEvents) {
  return {
    teamId: 'team-a', asOf: '2026-05-04T10:00:00Z',
    tasks: [], taskEvents, runtimeEvents: [],
    foundryDocs: {}, worktrees: [], diffsByTask: {},
  };
}

test('flags review→testing transition with zero review_feedback events', () => {
  const findings = checkReviewWithoutFindings({
    snapshot: snap([
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-04T09:50:00Z',
        payload: { from: 'in_progress', to: 'review' } },
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-04T09:54:00Z',
        payload: { from: 'review', to: 'testing' } },
    ]),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'low');
  assert.equal(findings[0].category, 'checklist');
  assert.equal(findings[0].taskId, 'task-1');
});

test('does NOT flag review with at least one review_feedback event in window', () => {
  const findings = checkReviewWithoutFindings({
    snapshot: snap([
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-04T09:50:00Z',
        payload: { from: 'in_progress', to: 'review' } },
      { taskId: 'task-1', eventType: 'task.review_feedback',
        createdAt: '2026-05-04T09:52:00Z', payload: { severity: 'minor' } },
      { taskId: 'task-1', eventType: 'task.status_changed',
        createdAt: '2026-05-04T09:54:00Z',
        payload: { from: 'review', to: 'testing' } },
    ]),
  });
  assert.equal(findings.length, 0);
});
