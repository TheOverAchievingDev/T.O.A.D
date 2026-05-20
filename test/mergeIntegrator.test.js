import test from 'node:test';
import assert from 'node:assert/strict';
import { integrate } from '../src/task/mergeIntegrator.js';

function fakeRunGit(table) {
  const calls = [];
  const fn = (args, opts) => {
    calls.push({ args: [...args], opts: { ...(opts || {}) } });
    for (const [matcher, result] of table) {
      if (matchPrefix(matcher, args)) return result;
    }
    return { exitCode: 127, stdout: '', stderr: 'no matcher' };
  };
  fn.calls = calls;
  return fn;
}

function matchPrefix(matcher, actual) {
  if (matcher.length > actual.length) return false;
  for (let i = 0; i < matcher.length; i++) {
    if (matcher[i] !== actual[i]) return false;
  }
  return true;
}

test('integrate validates required inputs', () => {
  const r = integrate({ runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  assert.equal(r.status, 'skipped');
  assert.match(r.reason, /projectCwd|taskBranch|baseBranch/);
});

test('integrate runs the full merge-tree → commit-tree → update-ref sequence on success', () => {
  const runGit = fakeRunGit([
    [['rev-parse', 'refs/heads/main'], { exitCode: 0, stdout: 'BASE_TIP_SHA\n', stderr: '' }],
    [['rev-parse', 'refs/heads/toad/team/task'], { exitCode: 0, stdout: 'TASK_TIP_SHA\n', stderr: '' }],
    [['merge-base', 'BASE_TIP_SHA', 'TASK_TIP_SHA'], { exitCode: 0, stdout: 'MERGE_BASE_SHA\n', stderr: '' }],
    [['merge-tree'], { exitCode: 0, stdout: 'MERGED_TREE_SHA\n', stderr: '' }],
    [['commit-tree'], { exitCode: 0, stdout: 'MERGE_COMMIT_SHA\n', stderr: '' }],
    [['update-ref'], { exitCode: 0, stdout: '', stderr: '' }],
  ]);
  const result = integrate({
    projectCwd: '/proj',
    taskBranch: 'toad/team/task',
    baseBranch: 'main',
    taskSubject: 'Add feature X',
    runGit,
  });
  assert.equal(result.status, 'merged');
  assert.equal(result.baseBranch, 'main');
  assert.equal(result.mergeCommit, 'MERGE_COMMIT_SHA');
  assert.deepEqual(result.parents, ['BASE_TIP_SHA', 'TASK_TIP_SHA']);
  assert.equal(typeof result.mergedAt, 'string');
  // Verify update-ref used optimistic-concurrency form (4 args: ref new-sha old-sha)
  const updateCall = runGit.calls.find((c) => c.args[0] === 'update-ref');
  assert.deepEqual(updateCall.args.slice(0, 4), ['update-ref', 'refs/heads/main', 'MERGE_COMMIT_SHA', 'BASE_TIP_SHA']);
});

test('integrate skipped when baseBranch ref does not exist', () => {
  const runGit = fakeRunGit([
    [['rev-parse', 'refs/heads/missing'], { exitCode: 128, stdout: '', stderr: 'fatal: not a valid ref' }],
  ]);
  const result = integrate({
    projectCwd: '/p', taskBranch: 'toad/t/a', baseBranch: 'missing', runGit,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'base_branch_not_found');
});

test('integrate skipped when task branch ref does not exist', () => {
  const runGit = fakeRunGit([
    [['rev-parse', 'refs/heads/main'], { exitCode: 0, stdout: 'BASE\n', stderr: '' }],
    [['rev-parse', 'refs/heads/toad/missing'], { exitCode: 128, stdout: '', stderr: 'fatal: not a valid ref' }],
  ]);
  const result = integrate({
    projectCwd: '/p', taskBranch: 'toad/missing', baseBranch: 'main', runGit,
  });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'task_branch_not_found');
});

test('integrate skipped when there is no common ancestor', () => {
  const runGit = fakeRunGit([
    [['rev-parse', 'refs/heads/main'], { exitCode: 0, stdout: 'BASE\n', stderr: '' }],
    [['rev-parse', 'refs/heads/toad/t/a'], { exitCode: 0, stdout: 'TASK\n', stderr: '' }],
    [['merge-base', 'BASE', 'TASK'], { exitCode: 1, stdout: '', stderr: '' }],
  ]);
  const result = integrate({ projectCwd: '/p', taskBranch: 'toad/t/a', baseBranch: 'main', runGit });
  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'no_common_ancestor');
});

test('integrate FAILS (throws via { status: error }) when merge-tree reports a conflict', () => {
  // merge-tree --write-tree exits with non-zero on conflict
  const runGit = fakeRunGit([
    [['rev-parse', 'refs/heads/main'], { exitCode: 0, stdout: 'BASE\n', stderr: '' }],
    [['rev-parse', 'refs/heads/toad/t/a'], { exitCode: 0, stdout: 'TASK\n', stderr: '' }],
    [['merge-base', 'BASE', 'TASK'], { exitCode: 0, stdout: 'MB\n', stderr: '' }],
    [['merge-tree'], { exitCode: 1, stdout: '', stderr: 'conflict in foo.js' }],
  ]);
  const result = integrate({ projectCwd: '/p', taskBranch: 'toad/t/a', baseBranch: 'main', runGit });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'merge_tree_conflict');
  assert.match(result.stderr, /conflict/);
});

test('integrate FAILS when commit-tree fails', () => {
  const runGit = fakeRunGit([
    [['rev-parse', 'refs/heads/main'], { exitCode: 0, stdout: 'BASE\n', stderr: '' }],
    [['rev-parse', 'refs/heads/toad/t/a'], { exitCode: 0, stdout: 'TASK\n', stderr: '' }],
    [['merge-base'], { exitCode: 0, stdout: 'MB\n', stderr: '' }],
    [['merge-tree'], { exitCode: 0, stdout: 'TREE\n', stderr: '' }],
    [['commit-tree'], { exitCode: 1, stdout: '', stderr: 'commit-tree disk error' }],
  ]);
  const result = integrate({ projectCwd: '/p', taskBranch: 'toad/t/a', baseBranch: 'main', runGit });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'commit_tree_failed');
});

test('integrate FAILS when update-ref optimistic-concurrency check fails (someone moved baseBranch)', () => {
  const runGit = fakeRunGit([
    [['rev-parse', 'refs/heads/main'], { exitCode: 0, stdout: 'BASE\n', stderr: '' }],
    [['rev-parse', 'refs/heads/toad/t/a'], { exitCode: 0, stdout: 'TASK\n', stderr: '' }],
    [['merge-base'], { exitCode: 0, stdout: 'MB\n', stderr: '' }],
    [['merge-tree'], { exitCode: 0, stdout: 'TREE\n', stderr: '' }],
    [['commit-tree'], { exitCode: 0, stdout: 'NEW\n', stderr: '' }],
    [['update-ref'], { exitCode: 1, stdout: '', stderr: 'reference already updated' }],
  ]);
  const result = integrate({ projectCwd: '/p', taskBranch: 'toad/t/a', baseBranch: 'main', runGit });
  assert.equal(result.status, 'error');
  assert.equal(result.reason, 'update_ref_failed');
  assert.match(result.stderr, /already updated/);
});

test('integrate uses --merge-base flag and the right parent ordering for commit-tree', () => {
  const runGit = fakeRunGit([
    [['rev-parse', 'refs/heads/main'], { exitCode: 0, stdout: 'BASE\n', stderr: '' }],
    [['rev-parse', 'refs/heads/toad/t/a'], { exitCode: 0, stdout: 'TASK\n', stderr: '' }],
    [['merge-base'], { exitCode: 0, stdout: 'MB\n', stderr: '' }],
    [['merge-tree'], { exitCode: 0, stdout: 'TREE\n', stderr: '' }],
    [['commit-tree'], { exitCode: 0, stdout: 'NEW\n', stderr: '' }],
    [['update-ref'], { exitCode: 0, stdout: '', stderr: '' }],
  ]);
  integrate({ projectCwd: '/p', taskBranch: 'toad/t/a', baseBranch: 'main', taskSubject: 'subj', runGit });
  const mergeTreeCall = runGit.calls.find((c) => c.args[0] === 'merge-tree');
  // merge-tree --write-tree --merge-base=MB BASE TASK
  assert.ok(mergeTreeCall.args.includes('--write-tree'));
  assert.ok(mergeTreeCall.args.includes('--merge-base=MB'));
  assert.ok(mergeTreeCall.args.includes('BASE'));
  assert.ok(mergeTreeCall.args.includes('TASK'));
  const commitTreeCall = runGit.calls.find((c) => c.args[0] === 'commit-tree');
  // commit-tree TREE -p BASE -p TASK -m "..."
  // base (the existing branch) is the FIRST parent so `git log baseBranch` keeps linear history
  const args = commitTreeCall.args;
  const treeIdx = args.indexOf('TREE');
  assert.ok(treeIdx > -1);
  // First -p should be BASE, second -p should be TASK
  const firstP = args.indexOf('-p');
  const secondP = args.indexOf('-p', firstP + 1);
  assert.equal(args[firstP + 1], 'BASE');
  assert.equal(args[secondP + 1], 'TASK');
});
