import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('ide source helpers round-trip project and task worktree keys', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-ide-source-test-'));
  try {
    const source = path.resolve('src/components/ideSource.ts');
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

    const mod = await import(pathToFileURL(path.join(outDir, 'ideSource.js')).href);
    assert.deepEqual(mod.sourceKeyToIdeSource('project'), { kind: 'project' });
    assert.deepEqual(mod.sourceKeyToIdeSource('task:abc-123'), { kind: 'task_worktree', taskId: 'abc-123' });
    assert.equal(mod.ideSourceToKey({ kind: 'project' }), 'project');
    assert.equal(mod.ideSourceToKey({ kind: 'task_worktree', taskId: 'abc-123' }), 'task:abc-123');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
