import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorktreeManager } from '../src/task/worktreeManager.js';

function makeTmpProject() {
  const dir = mkdtempSync(join(tmpdir(), 'toad-worktree-test-'));
  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function fakeRunGit(table) {
  const calls = [];
  const fn = (args, { cwd } = {}) => {
    calls.push({ args: [...args], cwd });
    for (const [matcher, result] of table) {
      if (matchArgs(matcher, args)) return result;
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  fn.calls = calls;
  return fn;
}

function matchArgs(matcher, actual) {
  // Matcher is the leading prefix
  if (matcher.length > actual.length) return false;
  for (let i = 0; i < matcher.length; i++) {
    if (matcher[i] !== actual[i]) return false;
  }
  return true;
}

test('WorktreeManager.createForTask returns skipped when not in a git repo', () => {
  const tmp = makeTmpProject();
  try {
    const runGit = fakeRunGit([
      [['rev-parse', '--is-inside-work-tree'], { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }],
    ]);
    const mgr = new WorktreeManager({ projectCwd: tmp.dir, runGit });
    const result = mgr.createForTask({ teamId: 'team-a', taskId: 'task-1' });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'not_in_git_repo');
    // Should not have attempted worktree add
    const addCalls = runGit.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    assert.equal(addCalls.length, 0);
  } finally {
    tmp.cleanup();
  }
});

test('WorktreeManager.createForTask returns skipped when worktree path already exists', () => {
  const tmp = makeTmpProject();
  try {
    const path = join(tmp.dir, '.toad', 'worktrees', 'team-a', 'task-1');
    mkdirSync(path, { recursive: true });
    const runGit = fakeRunGit([
      [['rev-parse', '--is-inside-work-tree'], { exitCode: 0, stdout: 'true\n', stderr: '' }],
      [['rev-parse', 'HEAD'], { exitCode: 0, stdout: 'abc123\n', stderr: '' }],
    ]);
    const mgr = new WorktreeManager({ projectCwd: tmp.dir, runGit });
    const result = mgr.createForTask({ teamId: 'team-a', taskId: 'task-1' });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'path_exists');
    // Should not have attempted worktree add
    const addCalls = runGit.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    assert.equal(addCalls.length, 0);
  } finally {
    tmp.cleanup();
  }
});

test('WorktreeManager.createForTask runs git worktree add with the right args and returns created', () => {
  const tmp = makeTmpProject();
  try {
    const runGit = fakeRunGit([
      [['rev-parse', '--is-inside-work-tree'], { exitCode: 0, stdout: 'true\n', stderr: '' }],
      [['rev-parse', 'HEAD'], { exitCode: 0, stdout: 'abc123def456\n', stderr: '' }],
      [['worktree', 'add'], { exitCode: 0, stdout: '', stderr: '' }],
    ]);
    const mgr = new WorktreeManager({ projectCwd: tmp.dir, runGit });
    const result = mgr.createForTask({ teamId: 'team-a', taskId: 'task-1' });
    assert.equal(result.status, 'created');
    assert.equal(result.branch, 'toad/team-a/task-1');
    assert.equal(result.baseRef, 'abc123def456');
    assert.equal(typeof result.path, 'string');
    assert.ok(result.path.includes('.toad'));
    assert.ok(result.path.includes('worktrees'));
    assert.ok(result.path.endsWith('task-1') || result.path.endsWith('task-1/'));
    assert.equal(typeof result.createdAt, 'string');
    // Verify the actual git invocation
    const addCalls = runGit.calls.filter((c) => c.args[0] === 'worktree' && c.args[1] === 'add');
    assert.equal(addCalls.length, 1);
    const addArgs = addCalls[0].args;
    assert.equal(addArgs[2], '-b');
    assert.equal(addArgs[3], 'toad/team-a/task-1');
    // path arg + baseRef arg
    assert.ok(addArgs[4].includes('task-1'));
    assert.equal(addArgs[5], 'abc123def456');
  } finally {
    tmp.cleanup();
  }
});

test('WorktreeManager.createForTask returns skipped when git worktree add fails', () => {
  const tmp = makeTmpProject();
  try {
    const runGit = fakeRunGit([
      [['rev-parse', '--is-inside-work-tree'], { exitCode: 0, stdout: 'true\n', stderr: '' }],
      [['rev-parse', 'HEAD'], { exitCode: 0, stdout: 'abc123\n', stderr: '' }],
      [['worktree', 'add'], { exitCode: 1, stdout: '', stderr: 'fatal: branch already exists' }],
    ]);
    const mgr = new WorktreeManager({ projectCwd: tmp.dir, runGit });
    const result = mgr.createForTask({ teamId: 'team-a', taskId: 'task-1' });
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'git_command_failed');
    assert.match(result.stderr || '', /already exists/);
  } finally {
    tmp.cleanup();
  }
});

test('WorktreeManager.createForTask uses deterministic path under .toad/worktrees/<team>/<task>', () => {
  const tmp = makeTmpProject();
  try {
    const runGit = fakeRunGit([
      [['rev-parse', '--is-inside-work-tree'], { exitCode: 0, stdout: 'true\n', stderr: '' }],
      [['rev-parse', 'HEAD'], { exitCode: 0, stdout: 'sha\n', stderr: '' }],
      [['worktree', 'add'], { exitCode: 0, stdout: '', stderr: '' }],
    ]);
    const mgr = new WorktreeManager({ projectCwd: tmp.dir, runGit });
    const result = mgr.createForTask({ teamId: 'team-a', taskId: 'task-1' });
    const expected = join(tmp.dir, '.toad', 'worktrees', 'team-a', 'task-1');
    assert.equal(result.path, expected);
  } finally {
    tmp.cleanup();
  }
});
