import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDoneWithoutMergeEvidence } from '../../../src/drift/checks/checkDoneWithoutMergeEvidence.js';

function snap({ tasks, taskEvents = [] }) {
  return {
    teamId: 'team-a', asOf: '2026-05-04T10:00:00Z',
    tasks, taskEvents, runtimeEvents: [],
    foundryDocs: {}, worktrees: [], diffsByTask: {},
  };
}

test('flags done task with null integration and no integration_merged event', () => {
  const findings = checkDoneWithoutMergeEvidence({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'done', integration: null }],
      taskEvents: [
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-04T09:50:00Z',
          payload: { from: 'merge_ready', to: 'done' } },
      ],
    }),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'architecture');
  assert.equal(findings[0].severity, 'high');
});

test('does NOT flag done task with integration set', () => {
  const findings = checkDoneWithoutMergeEvidence({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'done',
                integration: { mergeCommit: 'abc123', baseBranch: 'main' } }],
    }),
  });
  assert.equal(findings.length, 0);
});

test('does NOT flag done task with task.integration_merged event present', () => {
  const findings = checkDoneWithoutMergeEvidence({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'done', integration: null }],
      taskEvents: [
        { taskId: 'task-1', eventType: 'task.integration_merged',
          createdAt: '2026-05-04T09:49:00Z',
          payload: { mergeCommit: 'abc123' } },
      ],
    }),
  });
  assert.equal(findings.length, 0);
});

test('only checks tasks with status "done"', () => {
  const findings = checkDoneWithoutMergeEvidence({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'in_progress', integration: null }],
    }),
  });
  assert.equal(findings.length, 0);
});
