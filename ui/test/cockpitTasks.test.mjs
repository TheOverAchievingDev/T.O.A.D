import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('cockpit task helper groups active tasks in board order', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-cockpit-tasks-test-'));
  try {
    const source = path.resolve('src/components/cockpitTasks.ts');
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

    const mod = await import(pathToFileURL(path.join(outDir, 'cockpitTasks.js')).href);
    const groups = mod.buildCockpitTaskGroups([
      { id: 'done-1', status: 'done' },
      { id: 'rev-1', status: 'review' },
      { id: 'todo-1', status: 'todo' },
      { id: 'prog-1', status: 'in-progress' },
      { id: 'block-1', status: 'blocked' },
      { id: 'reject-1', status: 'rejected' },
    ]);

    assert.deepEqual(groups.map((group) => [group.status, group.count]), [
      ['todo', 1],
      ['in-progress', 1],
      ['review', 1],
      ['blocked', 1],
    ]);
    assert.deepEqual(groups.flatMap((group) => group.tasks.map((task) => task.id)), ['todo-1', 'prog-1', 'rev-1', 'block-1']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
