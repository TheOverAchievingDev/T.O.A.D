import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, getRecentCommits, readProjectDocs } from '../../src/drift/buildSnapshot.js';

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
      // Real diffComputer returns {diff, files, error} — match that.
      diff: null,
      files: worktreePath === '/wt/task-1'
        ? ['src/billing/invoice.js', 'src/auth/oauth.js']
        : [],
      error: null,
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

test('buildSnapshot throws when required taskBoard dep is missing', async () => {
  await assert.rejects(
    buildSnapshot({ teamId: 'team-a', deps: { eventLog: fakeEventLog() } }),
    /taskBoard/,
  );
});

test('buildSnapshot throws when required eventLog dep is missing', async () => {
  await assert.rejects(
    buildSnapshot({ teamId: 'team-a', deps: { taskBoard: fakeTaskBoard() } }),
    /eventLog/,
  );
});

test('buildSnapshot throws when teamId is missing or empty', async () => {
  await assert.rejects(
    buildSnapshot({ deps: { taskBoard: fakeTaskBoard(), eventLog: fakeEventLog() } }),
    /teamId/,
  );
});

test('buildSnapshot includes teamConfig from teamConfigRegistry', async () => {
  const fakeRegistry = {
    getTeam: ({ teamId }) =>
      teamId === 'team-a'
        ? { teamId, lead: { providerId: 'openai', agentId: 'lead' }, teammates: [] }
        : null,
  };
  const snap = await buildSnapshot({
    teamId: 'team-a',
    deps: {
      taskBoard: fakeTaskBoard(),
      eventLog: fakeEventLog(),
      teamConfigRegistry: fakeRegistry,
    },
  });
  assert.ok(snap.teamConfig, 'teamConfig present');
  assert.equal(snap.teamConfig.lead.providerId, 'openai');
});

test('buildSnapshot tolerates missing teamConfigRegistry', async () => {
  const snap = await buildSnapshot({
    teamId: 'team-a',
    deps: {
      taskBoard: fakeTaskBoard(),
      eventLog: fakeEventLog(),
    },
  });
  assert.equal(snap.teamConfig, null);
});

// ---------------------------------------------------------------------------
// getRecentCommits helper
// ---------------------------------------------------------------------------

test('getRecentCommits parses git log output into trimmed lines', () => {
  const fakeRunGit = () => ({
    exitCode: 0,
    stdout: 'abc1234 fix(foo): bar (2026-05-10T12:00:00Z)\ndef5678 chore: baz (2026-05-09T08:00:00Z)\n',
  });
  const commits = getRecentCommits({ cwd: '/proj', count: 30, runGitImpl: fakeRunGit });
  assert.deepEqual(commits, [
    'abc1234 fix(foo): bar (2026-05-10T12:00:00Z)',
    'def5678 chore: baz (2026-05-09T08:00:00Z)',
  ]);
});

test('getRecentCommits returns empty array when runGit exits non-zero', () => {
  const fakeRunGit = () => ({ exitCode: 128, stdout: '', stderr: 'not a git repo' });
  const commits = getRecentCommits({ cwd: '/proj', runGitImpl: fakeRunGit });
  assert.deepEqual(commits, []);
});

test('getRecentCommits returns empty array when runGit throws', () => {
  const fakeRunGit = () => { throw new Error('spawn failed'); };
  const commits = getRecentCommits({ cwd: '/proj', runGitImpl: fakeRunGit });
  assert.deepEqual(commits, []);
});

test('getRecentCommits returns empty array when cwd is null', () => {
  const fakeRunGit = () => ({ exitCode: 0, stdout: 'should-not-see' });
  const commits = getRecentCommits({ cwd: null, runGitImpl: fakeRunGit });
  assert.deepEqual(commits, []);
});

// ---------------------------------------------------------------------------
// readProjectDocs helper
// ---------------------------------------------------------------------------

test('readProjectDocs reads only files that exist, caps at 8KB', () => {
  // endsWith handles both posix and win32 join() output (e.g. /proj/README.md vs \proj\README.md)
  const existsNames = new Set(['README.md', 'AGENTS.md']);
  const fakeExistsSync = (p) => [...existsNames].some((n) => p.endsWith(n));
  const fakeReadFileSync = (p) => p.endsWith('README.md') ? 'a'.repeat(10000) : 'agent docs';
  const docs = readProjectDocs({
    cwd: '/proj',
    existsSyncImpl: fakeExistsSync,
    readFileSyncImpl: fakeReadFileSync,
  });
  assert.equal(docs['README.md'].length, 8192);
  assert.equal(docs['AGENTS.md'], 'agent docs');
  assert.ok(!('CLAUDE.md' in docs));
  assert.ok(!('CONTRIBUTING.md' in docs));
});

test('readProjectDocs returns empty object when cwd is null', () => {
  const docs = readProjectDocs({ cwd: null });
  assert.deepEqual(docs, {});
});

test('readProjectDocs returns empty object when no docs exist', () => {
  const docs = readProjectDocs({
    cwd: '/proj',
    existsSyncImpl: () => false,
  });
  assert.deepEqual(docs, {});
});
