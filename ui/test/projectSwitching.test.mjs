import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('switchToProjectPath returns picked project metadata in browser fallback mode', async () => {
  const tmp = path.resolve('.tmp-project-switch-test');
  try {
    const source = path.resolve('src/integrations/tauri.ts');
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

    const mod = await import(pathToFileURL(path.join(outDir, 'tauri.js')).href);
    assert.equal(typeof mod.switchToProjectPath, 'function');

    const switched = await mod.switchToProjectPath('C:\\Projects\\alpha-repo');
    assert.deepEqual(switched, {
      path: 'C:\\Projects\\alpha-repo',
      name: 'alpha-repo',
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
