import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('cockpit agent helper joins runtimes and latest stream activity', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-cockpit-agents-test-'));
  try {
    const source = path.resolve('src/components/cockpitAgents.ts');
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

    const mod = await import(pathToFileURL(path.join(outDir, 'cockpitAgents.js')).href);
    const rows = mod.buildCockpitAgentRows({
      members: [
        { id: 'qa', name: 'QA', status: 'idle', activity: { label: 'waiting' } },
        { id: 'lead', name: 'Lead', status: 'idle', activity: null },
      ],
      runtimes: [
        { id: 'rt-lead', agent: 'lead', status: 'live', provider: 'claude', model: 'opus', pid: 1234 },
      ],
      streams: {
        lead: [
          { id: 's1', time: '12:00:01', kind: 'tool', tool: 'Read', body: 'README.md' },
          { id: 's2', time: '12:00:02', kind: 'output', body: 'done' },
        ],
      },
    });

    assert.deepEqual(rows.map((row) => row.member.id), ['lead', 'qa']);
    assert.equal(rows[0].status, 'live');
    assert.equal(rows[0].runtimeLabel, 'claude / opus');
    assert.equal(rows[0].latestActivity, 'done');
    assert.equal(rows[1].latestActivity, 'waiting');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
