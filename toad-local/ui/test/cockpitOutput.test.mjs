import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('cockpit output helper merges streams and messages newest-first', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-cockpit-output-test-'));
  try {
    const source = path.resolve('src/components/cockpitOutput.ts');
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

    const mod = await import(pathToFileURL(path.join(outDir, 'cockpitOutput.js')).href);
    const entries = mod.buildCockpitOutputEntries({
      streams: {
        lead: [
          { id: 'old-tool', time: '12:00:01', kind: 'tool', tool: 'Read', body: 'README.md' },
          { id: 'new-output', time: '12:00:05', kind: 'output', body: 'done' },
        ],
      },
      messages: [
        { id: 'm1', from: 'lead', to: 'developer', time: '12:00:03', body: 'please build it' },
      ],
      limit: 3,
    });

    assert.deepEqual(entries.map((entry) => entry.id), ['stream-lead-new-output', 'message-m1', 'stream-lead-old-tool']);
    assert.equal(entries[0].agentId, 'lead');
    assert.equal(entries[1].kind, 'message');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
