import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot } from '../../src/drift/buildSnapshot.js';

function fakeTaskBoard() {
  return {
    listTasks: ({ teamId }) =>
      teamId === 'team-a'
        ? [{ teamId, taskId: 'task-1', status: 'in_progress',
             worktree: '/wt/task-1', baseRef: 'main',
             allowedFiles: ['src/billing/**'], forbiddenFiles: [],
             testCommands: ['npm test'] }]
        : [],
    listEvents: ({ teamId }) =>
      teamId === 'team-a'
        ? [
            { teamId, taskId: 'task-1', eventType: 'task.created',
              createdAt: '2026-05-03T09:00:00Z', payload: { subject: 'X' } },
            { teamId, taskId: 'task-1', eventType: 'task.status_changed',
              createdAt: '2026-05-03T09:05:00Z',
              payload: { from: 'ready', to: 'in_progress' } },
          ]
        : [],
  };
}
function fakeEventLog() {
  return {
    listEvents: ({ teamId }) =>
      teamId === 'team-a'
        ? [{ teamId, eventType: 'tool_call_denied', createdAt: '2026-05-03T09:10:00Z',
             payload: { agentId: 'dev-1', toolName: 'task_delete' } }]
        : [],
  };
}
function fakeFoundryStore() {
  return {
    readDocs: ({ teamId }) => ({
      architecture: teamId === 'team-a' ? '# Arch' : null,
      steering: '# Steering',
      definitionOfDone: null, designDecisions: null, checklist: null,
    }),
  };
}
function fakeWorktreeManager() {
  return {
    listWorktrees: ({ teamId }) =>
      teamId === 'team-a'
        ? [{ taskId: 'task-1', path: '/wt/task-1', baseRef: 'main' }]
        : [],
  };
}
function fakeDiffComputer() {
  return {
    computeDiff: ({ worktreePath }) => ({
      changedFiles: worktreePath === '/wt/task-1'
        ? ['src/billing/invoice.js', 'src/auth/oauth.js']
        : [],
    }),
  };
}

test('buildSnapshot returns DriftSnapshot with all inputs collected', async () => {
  const snap = await buildSnapshot({
    teamId: 'team-a',
    deps: {
      taskBoard: fakeTaskBoard(),
      eventLog: fakeEventLog(),
      foundryStore: fakeFoundryStore(),
      worktreeManager: fakeWorktreeManager(),
      diffComputer: fakeDiffComputer(),
    },
  });
  assert.equal(snap.teamId, 'team-a');
  assert.ok(snap.asOf, 'asOf timestamp present');
  assert.equal(snap.tasks.length, 1);
  assert.equal(snap.tasks[0].taskId, 'task-1');
  assert.equal(snap.taskEvents.length, 2);
  assert.equal(snap.runtimeEvents.length, 1);
  assert.equal(snap.foundryDocs.architecture, '# Arch');
  assert.equal(snap.worktrees.length, 1);
  assert.deepEqual(snap.diffsByTask['task-1'].changedFiles,
    ['src/billing/invoice.js', 'src/auth/oauth.js']);
});

test('buildSnapshot tolerates missing optional deps (no foundryStore, no worktreeManager)', async () => {
  const snap = await buildSnapshot({
    teamId: 'team-a',
    deps: {
      taskBoard: fakeTaskBoard(),
      eventLog: fakeEventLog(),
      // no foundryStore, no worktreeManager, no diffComputer
    },
  });
  assert.deepEqual(snap.foundryDocs, {});
  assert.deepEqual(snap.worktrees, []);
  assert.deepEqual(snap.diffsByTask, {});
});

test('buildSnapshot returns empty arrays for an unknown team rather than throwing', async () => {
  const snap = await buildSnapshot({
    teamId: 'team-zzz',
    deps: {
      taskBoard: fakeTaskBoard(),
      eventLog: fakeEventLog(),
    },
  });
  assert.equal(snap.tasks.length, 0);
  assert.equal(snap.taskEvents.length, 0);
});
