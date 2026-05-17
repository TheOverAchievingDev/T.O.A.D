import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('FOR-me flow panel helper defaults collapsed and only accepts expanded/collapsed', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-for-me-flow-panels-test-'));
  try {
    const source = path.resolve('src/components/cockpit/forMeFlowPanels.ts');
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

    const mod = await import(pathToFileURL(path.join(outDir, 'forMeFlowPanels.js')).href);
    assert.equal(mod.DEFAULT_FLOW_PANEL_STATE, 'collapsed');
    assert.equal(mod.FLOW_LEFT_PANEL_STORAGE_KEY, 'cockpit.forMe.flow.leftPanel');
    assert.equal(mod.FLOW_RIGHT_PANEL_STORAGE_KEY, 'cockpit.forMe.flow.rightPanel');
    assert.equal(mod.normalizeFlowPanelState('expanded'), 'expanded');
    assert.equal(mod.normalizeFlowPanelState('collapsed'), 'collapsed');
    assert.equal(mod.normalizeFlowPanelState('open'), 'collapsed');
    assert.equal(mod.normalizeFlowPanelState(undefined), 'collapsed');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
