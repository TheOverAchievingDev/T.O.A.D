import test from 'node:test';
import assert from 'node:assert/strict';
import { checkForConflicts } from '../src/task/mergeChecker.js';

function fakeRunGit(table) {
  const calls = [];
  const fn = (args, opts) => {
    calls.push({ args: [...args], opts: { ...(opts || {}) } });
    for (const [matcher, result] of table) {
      if (matchPrefix(matcher, args)) return result;
    }
    return { exitCode: 0, stdout: '', stderr: '' };
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

test('checkForConflicts returns clean when git merge --no-commit succeeds and aborts cleanly', () => {
  const runGit = fakeRunGit([
    [['status', '--porcelain'], { exitCode: 0, stdout: '', stderr: '' }],
    [['merge', '--no-commit', '--no-ff'], { exitCode: 0, stdout: '', stderr: '' }],
    [['merge', '--abort'], { exitCode: 0, stdout: '', stderr: '' }],
  ]);
  const result = checkForConflicts({ worktreePath: '/tmp/wt', baseRef: 'abc', runGit });
  assert.equal(result.status, 'clean');
  // Should always abort to leave the worktree unmodified
  const aborts = runGit.calls.filter((c) => c.args[0] === 'merge' && c.args[1] === '--abort');
  assert.equal(aborts.length, 1);
});

test('checkForConflicts detects conflict files via diff --diff-filter=U then aborts', () => {
  const runGit = fakeRunGit([
    [['status', '--porcelain'], { exitCode: 0, stdout: '', stderr: '' }],
    [['merge', '--no-commit', '--no-ff'], { exitCode: 1, stdout: 'CONFLICT (content): Merge conflict in foo.js', stderr: '' }],
    [['diff', '--name-only', '--diff-filter=U'], { exitCode: 0, stdout: 'foo.js\nbar.js\n', stderr: '' }],
    [['merge', '--abort'], { exitCode: 0, stdout: '', stderr: '' }],
  ]);
  const result = checkForConflicts({ worktreePath: '/tmp/wt', baseRef: 'abc', runGit });
  assert.equal(result.status, 'conflict');
  assert.deepEqual(result.files, ['foo.js', 'bar.js']);
  // Always cleans up
  const aborts = runGit.calls.filter((c) => c.args[0] === 'merge' && c.args[1] === '--abort');
  assert.equal(aborts.length, 1);
});

test('checkForConflicts returns error when worktree has uncommitted changes', () => {
  const runGit = fakeRunGit([
    [['status', '--porcelain'], { exitCode: 0, stdout: ' M foo.js\n', stderr: '' }],
  ]);
  const result = checkForConflicts({ worktreePath: '/tmp/wt', baseRef: 'abc', runGit });
  assert.equal(result.status, 'error');
  assert.match(result.error, /uncommitted changes/);
  // Should NOT have attempted merge if status is dirty
  const merges = runGit.calls.filter((c) => c.args[0] === 'merge' && c.args[1] === '--no-commit');
  assert.equal(merges.length, 0);
});

test('checkForConflicts returns error when git status itself fails', () => {
  const runGit = fakeRunGit([
    [['status', '--porcelain'], { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }],
  ]);
  const result = checkForConflicts({ worktreePath: '/tmp/wt', baseRef: 'abc', runGit });
  assert.equal(result.status, 'error');
  assert.match(result.error, /not a git repository/);
});

test('checkForConflicts validates worktreePath and baseRef', () => {
  const runGit = () => ({ exitCode: 0, stdout: '', stderr: '' });
  let r = checkForConflicts({ worktreePath: '', baseRef: 'a', runGit });
  assert.equal(r.status, 'error');
  assert.match(r.error, /worktreePath/);
  r = checkForConflicts({ worktreePath: '/x', baseRef: '', runGit });
  assert.equal(r.status, 'error');
  assert.match(r.error, /baseRef/);
});

test('checkForConflicts uses the worktreePath as cwd for every git call', () => {
  const runGit = fakeRunGit([
    [['status', '--porcelain'], { exitCode: 0, stdout: '', stderr: '' }],
    [['merge', '--no-commit', '--no-ff'], { exitCode: 0, stdout: '', stderr: '' }],
    [['merge', '--abort'], { exitCode: 0, stdout: '', stderr: '' }],
  ]);
  checkForConflicts({ worktreePath: '/specific/wt', baseRef: 'abc', runGit });
  for (const call of runGit.calls) {
    assert.equal(call.opts.cwd, '/specific/wt');
  }
});
