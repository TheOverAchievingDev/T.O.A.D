import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('cockpit file source helper lists project plus created worktrees with selected task first', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-cockpit-file-sources-test-'));
  try {
    const source = path.resolve('src/components/cockpitFileSources.ts');
    const outDir = path.join(tmp, 'out');
    const tsc = spawnSync(
      process.execPath,
      [
        path.resolve('node_modules/typescript/bin/tsc'),
        source,
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        '--target',
        'ES2022',
        '--outDir',
        outDir,
        '--skipLibCheck',
        '--strict',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);

    const mod = await import(pathToFileURL(path.join(outDir, 'cockpitFileSources.js')).href);
    const options = mod.buildCockpitFileSourceOptions({
      selectedTaskId: 'task-2',
      projectLabel: 'Symphony',
      tasks: [
        { id: 'task-1', title: 'Add API', status: 'in-progress', worktree: { status: 'created', path: 'C:/wt/one', branch: 'feature/one' } },
        { id: 'task-2', title: 'Fix UI', status: 'blocked', worktree: { status: 'created', path: 'C:/wt/two', branch: 'feature/two' } },
        { id: 'task-3', title: 'Done', status: 'done', worktree: { status: 'removed', path: 'C:/wt/three' } },
        { id: 'task-4', title: 'No path', status: 'review', worktree: { status: 'created' } },
      ],
    });

    assert.deepEqual(options.map((option) => option.key), ['project', 'task:task-2', 'task:task-1']);
    assert.equal(options[0].label, 'Symphony');
    assert.equal(options[1].isSelectedTask, true);
    assert.equal(options[1].detail, 'feature/two');
    assert.equal(mod.selectedTaskWorktreeSourceKey({ id: 'task-2', worktree: { status: 'created', path: 'C:/wt/two' } }), 'task:task-2');
    assert.equal(mod.selectedTaskWorktreeSourceKey({ id: 'task-3', worktree: { status: 'removed', path: 'C:/wt/three' } }), null);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
