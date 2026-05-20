import test from 'node:test';
import assert from 'node:assert';
import { join } from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import {
  getIdeStatus,
  getIdeDiff,
  createIdeCheckpoint,
  applyIdePatch,
  searchIdeFiles,
} from '../src/ide/ideGitTools.js';

test('ideGitTools', async (t) => {
  let projectCwd;
  let taskPath;
  let mockTaskBoard;

  t.beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'toad-git-test-'));
    // Setup git repo
    execSync('git init', { cwd: projectCwd });
    // Configure git user
    execSync('git config core.autocrlf false', { cwd: projectCwd });
    execSync('git config user.name "Test User"', { cwd: projectCwd });
    execSync('git config user.email "test@example.com"', { cwd: projectCwd });

    // Initial commit
    writeFileSync(join(projectCwd, 'existing.txt'), 'initial content\n');
    execSync('git add existing.txt', { cwd: projectCwd });
    execSync('git commit -m "Initial commit"', { cwd: projectCwd });

    taskPath = join(projectCwd, 'task-worktree');
    mkdirSync(taskPath);
    execSync('git init', { cwd: taskPath });
    execSync('git config core.autocrlf false', { cwd: taskPath });
    execSync('git config user.name "Test User"', { cwd: taskPath });
    execSync('git config user.email "test@example.com"', { cwd: taskPath });
    writeFileSync(join(taskPath, 'taskfile.txt'), 'task content\n');
    execSync('git add taskfile.txt', { cwd: taskPath });
    execSync('git commit -m "Task base"', { cwd: taskPath });

    mockTaskBoard = {
      getTask({ taskId }) {
        if (taskId === 't1') {
          return { worktree: { status: 'created', path: taskPath } };
        }
        return null;
      },
    };
  });

  t.afterEach(() => {
    try {
      rmSync(projectCwd, { recursive: true, force: true });
    } catch {}
  });

  await t.test('getIdeStatus returns modified, added, and untracked files', () => {
    writeFileSync(join(projectCwd, 'existing.txt'), 'modified content\n');
    writeFileSync(join(projectCwd, 'new.txt'), 'new content\n');
    execSync('git add new.txt', { cwd: projectCwd });
    writeFileSync(join(projectCwd, 'untracked.txt'), 'untracked content\n');

    const result = getIdeStatus({
      projectCwd,
      taskBoard: mockTaskBoard,
      teamId: 'team1',
      source: { kind: 'project' },
    });

    assert.ok(result.entries.length >= 3);
    const existing = result.entries.find(e => e.relativePath === 'existing.txt');
    assert.strictEqual(existing.status, ' M');
    const newFile = result.entries.find(e => e.relativePath === 'new.txt');
    assert.strictEqual(newFile.status, 'A ');
    const untracked = result.entries.find(e => e.relativePath === 'untracked.txt');
    assert.strictEqual(untracked.status, '??');
  });

  await t.test('getIdeDiff returns unified diff for modified file', () => {
    writeFileSync(join(projectCwd, 'existing.txt'), 'modified content\n');
    
    const result = getIdeDiff({
      projectCwd,
      taskBoard: mockTaskBoard,
      teamId: 'team1',
      source: { kind: 'project' },
      relativePath: 'existing.txt',
    });

    assert.ok(result.diff.includes('--- a/existing.txt'));
    assert.ok(result.diff.includes('+++ b/existing.txt'));
    assert.ok(result.diff.includes('-initial content'));
    assert.ok(result.diff.includes('+modified content'));
  });

  await t.test('getIdeDiff returns empty string if file is unmodified', () => {
    const result = getIdeDiff({
      projectCwd,
      taskBoard: mockTaskBoard,
      teamId: 'team1',
      source: { kind: 'project' },
      relativePath: 'existing.txt',
    });

    assert.strictEqual(result.diff, '');
  });

  await t.test('getIdeDiff returns a new-file diff when the repo has no HEAD yet', () => {
    const emptyProjectCwd = mkdtempSync(join(tmpdir(), 'toad-git-no-head-test-'));
    try {
      execSync('git init', { cwd: emptyProjectCwd });
      execSync('git config core.autocrlf false', { cwd: emptyProjectCwd });
      writeFileSync(join(emptyProjectCwd, 'first.txt'), 'first line\nsecond line\n');

      const result = getIdeDiff({
        projectCwd: emptyProjectCwd,
        taskBoard: mockTaskBoard,
        teamId: 'team1',
        source: { kind: 'project' },
        relativePath: 'first.txt',
      });

      assert.ok(result.diff.includes('--- /dev/null'));
      assert.ok(result.diff.includes('+++ b/first.txt'));
      assert.ok(result.diff.includes('+first line'));
      assert.ok(result.diff.includes('+second line'));
    } finally {
      rmSync(emptyProjectCwd, { recursive: true, force: true });
    }
  });

  await t.test('createIdeCheckpoint commits all changes', () => {
    writeFileSync(join(taskPath, 'taskfile.txt'), 'modified task content\n');
    writeFileSync(join(taskPath, 'newtaskfile.txt'), 'new content\n');

    const result = createIdeCheckpoint({
      projectCwd,
      taskBoard: mockTaskBoard,
      teamId: 'team1',
      source: { kind: 'task_worktree', taskId: 't1' },
      message: 'Checkpoint 1',
    });

    assert.strictEqual(result.checkpointCommit.length, 40); // SHA-1 length
    
    // Status should be clean now
    const status = getIdeStatus({
      projectCwd,
      taskBoard: mockTaskBoard,
      teamId: 'team1',
      source: { kind: 'task_worktree', taskId: 't1' },
    });
    assert.strictEqual(status.entries.length, 0);
  });

  await t.test('applyIdePatch applies a reverse patch successfully', () => {
    // Generate a diff
    writeFileSync(join(projectCwd, 'existing.txt'), 'modified content\n');
    execSync('git add existing.txt', { cwd: projectCwd });
    execSync('git commit -m "Update"', { cwd: projectCwd });

    const diffOutput = execSync('git diff HEAD~1 HEAD -- existing.txt', { cwd: projectCwd, encoding: 'utf8' });

    // Apply the patch in reverse
    const result = applyIdePatch({
      projectCwd,
      taskBoard: mockTaskBoard,
      teamId: 'team1',
      source: { kind: 'project' },
      patchContent: diffOutput,
      reverse: true,
    });

    assert.strictEqual(result.success, true);
    
    // Check content reverted
    const revertedContent = readFileSync(join(projectCwd, 'existing.txt'), 'utf8');
    assert.strictEqual(revertedContent, 'initial content\n');
  });

  await t.test('applyIdePatch handles invalid patch', () => {
    assert.throws(() => {
      applyIdePatch({
        projectCwd,
        taskBoard: mockTaskBoard,
        teamId: 'team1',
        source: { kind: 'project' },
        patchContent: 'invalid patch content',
        reverse: true,
      });
    }, /ide_apply_patch:/);
  });
});

test('searchIdeFiles', async (t) => {
  let projectCwd;

  t.beforeEach(() => {
    projectCwd = mkdtempSync(join(tmpdir(), 'toad-search-test-'));
    execSync('git init', { cwd: projectCwd });
    execSync('git config core.autocrlf false', { cwd: projectCwd });
    execSync('git config user.name "Test User"', { cwd: projectCwd });
    execSync('git config user.email "test@example.com"', { cwd: projectCwd });
  });

  t.afterEach(() => {
    try {
      rmSync(projectCwd, { recursive: true, force: true });
    } catch {}
  });

  await t.test('finds text and respects untracked files but ignores .git', () => {
    writeFileSync(join(projectCwd, 'committed.txt'), 'Hello world\nThis is a test');
    execSync('git add committed.txt && git commit -m "commit"', { cwd: projectCwd });

    writeFileSync(join(projectCwd, 'untracked.txt'), 'Another test line');

    writeFileSync(join(projectCwd, '.gitignore'), 'ignored.txt\n');
    writeFileSync(join(projectCwd, 'ignored.txt'), 'Secret test');

    const result = searchIdeFiles({ projectCwd, query: 'test' });
    
    assert.strictEqual(result.matches.length, 2);
    const committedMatch = result.matches.find(m => m.relativePath === 'committed.txt');
    const untrackedMatch = result.matches.find(m => m.relativePath === 'untracked.txt');
    const ignoredMatch = result.matches.find(m => m.relativePath === 'ignored.txt');

    assert.ok(committedMatch);
    assert.strictEqual(committedMatch.lineNumber, 2);
    assert.strictEqual(committedMatch.content, 'This is a test');

    assert.ok(untrackedMatch);
    assert.strictEqual(untrackedMatch.lineNumber, 1);
    assert.strictEqual(untrackedMatch.content, 'Another test line');

    assert.strictEqual(ignoredMatch, undefined);
  });

  await t.test('returns empty array on no matches', () => {
    const result = searchIdeFiles({ projectCwd, query: 'does-not-exist' });
    assert.deepEqual(result.matches, []);
  });

  await t.test('throws on invalid regex if git grep rejects it', () => {
    assert.throws(
      () => searchIdeFiles({ projectCwd, query: '[' }),
      /ide_search_files:/
    );
  });
});
