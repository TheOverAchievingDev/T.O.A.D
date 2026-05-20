import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { LocalToolFacade } from '../src/tools/localToolFacade.js';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { InMemoryTaskBoard } from '../src/task/inMemoryTaskBoard.js';
import { COMMANDS } from '../src/commands/command-contract.js';

function makeGitProject(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'toad-ide-changes-'));
  execSync('git init', { cwd: root });
  execSync('git config core.autocrlf false', { cwd: root });
  execSync('git config user.name "Test User"', { cwd: root });
  execSync('git config user.email "test@example.com"', { cwd: root });
  writeFileSync(path.join(root, 'keep.txt'), 'line1\nline2\nline3\n');
  writeFileSync(path.join(root, 'gone.txt'), 'delete me\n');
  execSync('git add keep.txt gone.txt', { cwd: root });
  execSync('git commit -m "base"', { cwd: root });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeFacade(projectCwd) {
  return new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    projectCwd,
  });
}

test('LocalToolFacade ide_changes_summary reports modified, deleted, untracked files', async (t) => {
  const projectCwd = makeGitProject(t);
  writeFileSync(path.join(projectCwd, 'keep.txt'), 'line1\nCHANGED\nline3\nline4\n');
  unlinkSync(path.join(projectCwd, 'gone.txt'));
  writeFileSync(path.join(projectCwd, 'fresh.txt'), 'brand new\n');

  const facade = makeFacade(projectCwd);
  const result = await facade.execute({
    commandName: COMMANDS.IDE_CHANGES_SUMMARY,
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { source: { kind: 'project' } },
  });

  const byPath = Object.fromEntries(result.files.map((f) => [f.relativePath, f]));

  assert.equal(byPath['keep.txt'].status, 'M');
  assert.ok(byPath['keep.txt'].additions >= 1);
  assert.ok(byPath['keep.txt'].deletions >= 1);
  assert.equal(byPath['keep.txt'].binary, false);

  assert.equal(byPath['gone.txt'].status, 'D');

  assert.equal(byPath['fresh.txt'].status, '?');
  assert.equal(byPath['fresh.txt'].additions, null);
  assert.equal(byPath['fresh.txt'].deletions, null);
});

test('LocalToolFacade ide_changes_summary is read-only and repeatable', async (t) => {
  const projectCwd = makeGitProject(t);
  writeFileSync(path.join(projectCwd, 'keep.txt'), 'line1\nX\nline3\n');
  const facade = makeFacade(projectCwd);
  const call = () => facade.execute({
    commandName: COMMANDS.IDE_CHANGES_SUMMARY,
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { source: { kind: 'project' } },
  });
  const first = await call();
  const second = await call();
  assert.deepEqual(first.files, second.files);
});
