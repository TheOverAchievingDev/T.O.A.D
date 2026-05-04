import test from 'node:test';
import assert from 'node:assert/strict';
import { checkOutOfScopeFiles } from '../../../src/drift/checks/checkOutOfScopeFiles.js';

const ACTIVE_STATUSES = ['in_progress', 'review', 'testing', 'merge_ready'];

function makeSnap({ allowedFiles = [], forbiddenFiles = [], changedFiles = [],
                    status = 'in_progress' } = {}) {
  return {
    teamId: 'team-a', asOf: '2026-05-04T10:00:00Z',
    tasks: [{ teamId: 'team-a', taskId: 'task-1', status,
              allowedFiles, forbiddenFiles, worktree: '/wt/task-1' }],
    taskEvents: [], runtimeEvents: [],
    foundryDocs: {},
    worktrees: [{ taskId: 'task-1', path: '/wt/task-1', baseRef: 'main' }],
    diffsByTask: { 'task-1': { changedFiles } },
  };
}

test('flags files NOT in the task allowedFiles glob list', () => {
  const findings = checkOutOfScopeFiles({
    snapshot: makeSnap({
      allowedFiles: ['src/billing/**'],
      changedFiles: ['src/billing/invoice.js', 'src/auth/oauth.js'],
    }),
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].actual, /src\/auth\/oauth\.js/);
  assert.equal(findings[0].category, 'slice_scope');
  assert.equal(findings[0].severity, 'medium');
});

test('flags files matching forbiddenFiles even when allowedFiles is empty', () => {
  const findings = checkOutOfScopeFiles({
    snapshot: makeSnap({
      allowedFiles: [],
      forbiddenFiles: ['src/auth/**'],
      changedFiles: ['src/auth/oauth.js'],
    }),
  });
  assert.equal(findings.length, 1);
  assert.match(findings[0].actual, /src\/auth\/oauth\.js/);
});

test('does NOT flag a task with empty allowedFiles + empty forbiddenFiles (no contract)', () => {
  const findings = checkOutOfScopeFiles({
    snapshot: makeSnap({
      changedFiles: ['src/anything.js'],
    }),
  });
  assert.equal(findings.length, 0);
});

test('skips tasks not in active statuses', () => {
  for (const status of ['backlog', 'ready', 'planned', 'done', 'rejected']) {
    const findings = checkOutOfScopeFiles({
      snapshot: makeSnap({
        allowedFiles: ['src/billing/**'],
        changedFiles: ['src/auth/x.js'],
        status,
      }),
    });
    assert.equal(findings.length, 0, `status=${status} should be skipped`);
  }
  for (const status of ACTIVE_STATUSES) {
    const findings = checkOutOfScopeFiles({
      snapshot: makeSnap({
        allowedFiles: ['src/billing/**'],
        changedFiles: ['src/auth/x.js'],
        status,
      }),
    });
    assert.equal(findings.length, 1, `status=${status} should be checked`);
  }
});
