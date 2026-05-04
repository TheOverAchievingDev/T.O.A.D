import test from 'node:test';
import assert from 'node:assert/strict';
import { checkMissingTestArtifacts } from '../../../src/drift/checks/checkMissingTestArtifacts.js';

function snap({ taskEvents = [], runtimeEvents = [], tasks = [] } = {}) {
  return {
    teamId: 'team-a', asOf: '2026-05-04T10:00:00Z',
    tasks, taskEvents, runtimeEvents,
    foundryDocs: {}, worktrees: [], diffsByTask: {},
  };
}

test('flags testing→merge_ready with no test command between', () => {
  const findings = checkMissingTestArtifacts({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'merge_ready',
                testCommands: [] }],
      taskEvents: [
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-04T09:50:00Z',
          payload: { from: 'review', to: 'testing' } },
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-04T10:00:00Z',
          payload: { from: 'testing', to: 'merge_ready' } },
      ],
      runtimeEvents: [],
    }),
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, 'high');
  assert.equal(findings[0].category, 'test_truth');
  assert.equal(findings[0].taskId, 'task-1');
});

test('does NOT flag when a Bash test command ran in the testing window', () => {
  const findings = checkMissingTestArtifacts({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'merge_ready',
                testCommands: [] }],
      taskEvents: [
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-04T09:50:00Z',
          payload: { from: 'review', to: 'testing' } },
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-04T10:00:00Z',
          payload: { from: 'testing', to: 'merge_ready' } },
      ],
      runtimeEvents: [
        { eventType: 'tool_call', createdAt: '2026-05-04T09:55:00Z',
          payload: { toolName: 'Bash', input: { command: 'npm test' } } },
      ],
    }),
  });
  assert.equal(findings.length, 0);
});

test('uses task.testCommands when declared (more specific than fallback regex)', () => {
  const findings = checkMissingTestArtifacts({
    snapshot: snap({
      tasks: [{ teamId: 'team-a', taskId: 'task-1', status: 'merge_ready',
                testCommands: ['python -m pytest tests/foo'] }],
      taskEvents: [
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-04T09:50:00Z',
          payload: { from: 'review', to: 'testing' } },
        { taskId: 'task-1', eventType: 'task.status_changed',
          createdAt: '2026-05-04T10:00:00Z',
          payload: { from: 'testing', to: 'merge_ready' } },
      ],
      runtimeEvents: [
        { eventType: 'tool_call', createdAt: '2026-05-04T09:55:00Z',
          payload: { toolName: 'Bash', input: { command: 'pytest tests/bar' } } },
      ],
    }),
  });
  assert.equal(findings.length, 1, 'declared command did not run, fallback regex must NOT save it');
});
