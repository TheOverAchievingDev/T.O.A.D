import test from 'node:test';
import assert from 'node:assert/strict';
import { computeDiff } from '../src/task/diffComputer.js';

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

test('computeDiff runs git diff baseRef..HEAD inside the worktree path', () => {
  const runGit = fakeRunGit([
    [['diff', 'abc123..HEAD', '--name-only'], { exitCode: 0, stdout: 'src/foo.js\nsrc/bar.js\n', stderr: '' }],
    [['diff', 'abc123..HEAD'], { exitCode: 0, stdout: 'diff --git a/src/foo.js ...', stderr: '' }],
  ]);
  const result = computeDiff({ worktreePath: '/tmp/wt', baseRef: 'abc123', runGit });
  assert.equal(result.diff, 'diff --git a/src/foo.js ...');
  assert.deepEqual(result.files, ['src/foo.js', 'src/bar.js']);
  // Both calls used the worktree as cwd
  for (const call of runGit.calls) {
    assert.equal(call.opts.cwd, '/tmp/wt');
  }
});

test('computeDiff returns empty diff when no changes', () => {
  const runGit = fakeRunGit([
    [['diff', 'sha..HEAD', '--name-only'], { exitCode: 0, stdout: '\n', stderr: '' }],
    [['diff', 'sha..HEAD'], { exitCode: 0, stdout: '', stderr: '' }],
  ]);
  const result = computeDiff({ worktreePath: '/tmp/wt', baseRef: 'sha', runGit });
  assert.equal(result.diff, '');
  assert.deepEqual(result.files, []);
});

test('computeDiff returns error when git fails on file list', () => {
  const runGit = fakeRunGit([
    [['diff', 'badref..HEAD', '--name-only'], { exitCode: 128, stdout: '', stderr: 'fatal: bad revision' }],
  ]);
  const result = computeDiff({ worktreePath: '/tmp/wt', baseRef: 'badref', runGit });
  assert.equal(result.diff, null);
  assert.deepEqual(result.files, []);
  assert.match(result.error, /bad revision/);
});

test('computeDiff returns error when worktree path is missing', () => {
  const result = computeDiff({ worktreePath: '', baseRef: 'sha', runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  assert.equal(result.diff, null);
  assert.match(result.error, /worktreePath/);
});

test('computeDiff returns error when baseRef is missing', () => {
  const result = computeDiff({ worktreePath: '/tmp/x', baseRef: '', runGit: () => ({ exitCode: 0, stdout: '', stderr: '' }) });
  assert.equal(result.diff, null);
  assert.match(result.error, /baseRef/);
});

test('computeDiff filters out blank lines from --name-only output', () => {
  const runGit = fakeRunGit([
    [['diff', 'sha..HEAD', '--name-only'], { exitCode: 0, stdout: 'a.js\n\nb.js\n   \n', stderr: '' }],
    [['diff', 'sha..HEAD'], { exitCode: 0, stdout: 'd', stderr: '' }],
  ]);
  const result = computeDiff({ worktreePath: '/tmp/wt', baseRef: 'sha', runGit });
  assert.deepEqual(result.files, ['a.js', 'b.js']);
});
