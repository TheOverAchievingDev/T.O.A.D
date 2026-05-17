import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('FOR-me view mode helper defaults to timeline and only accepts known modes', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-for-me-view-mode-test-'));
  try {
    const source = path.resolve('src/components/cockpit/forMeViewMode.ts');
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

    const mod = await import(pathToFileURL(path.join(outDir, 'forMeViewMode.js')).href);
    assert.equal(mod.DEFAULT_FOR_ME_VIEW_MODE, 'timeline');
    assert.equal(mod.FOR_ME_VIEW_MODE_STORAGE_KEY, 'cockpit.forMe.viewMode');
    assert.equal(mod.normalizeForMeViewMode('flow'), 'flow');
    assert.equal(mod.normalizeForMeViewMode('timeline'), 'timeline');
    assert.equal(mod.normalizeForMeViewMode('grid'), 'timeline');
    assert.equal(mod.normalizeForMeViewMode(null), 'timeline');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
