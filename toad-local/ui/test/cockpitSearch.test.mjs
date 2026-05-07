import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('cockpit search helper formats grep matches with limit and overflow count', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-cockpit-search-test-'));
  try {
    const source = path.resolve('src/components/cockpitSearch.ts');
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

    const mod = await import(pathToFileURL(path.join(outDir, 'cockpitSearch.js')).href);
    const summary = mod.buildCockpitSearchSummary([
      { relativePath: 'src/App.tsx', lineNumber: 12, content: '  const   app = true  ' },
      { relativePath: 'README.md', lineNumber: 2, content: 'Symphony app' },
      { relativePath: 'package.json', lineNumber: 1, content: '"app": true' },
    ], 2);

    assert.equal(summary.totalCount, 3);
    assert.equal(summary.overflowCount, 1);
    assert.deepEqual(summary.rows.map((row) => row.title), ['src/App.tsx:12', 'README.md:2']);
    assert.equal(summary.rows[0].snippet, 'const app = true');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
