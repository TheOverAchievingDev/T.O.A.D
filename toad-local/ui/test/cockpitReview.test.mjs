import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('cockpit review helper summarizes diff and gate state', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-cockpit-review-test-'));
  try {
    const source = path.resolve('src/components/cockpitReview.ts');
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

    const mod = await import(pathToFileURL(path.join(outDir, 'cockpitReview.js')).href);
    const summary = mod.summarizeCockpitReview({
      review: {
        summary: 'Adds marker file',
        files: ['SMOKE.md', 'src/app.ts'],
        scopeDrift: ['package.json'],
        noOpDiff: false,
      },
      validations: [
        { kind: 'test', verdict: 'passed' },
        { kind: 'typecheck', verdict: 'failed' },
      ],
    });

    assert.equal(summary.state, 'blocked');
    assert.equal(summary.fileCount, 2);
    assert.equal(summary.scopeDriftCount, 1);
    assert.equal(summary.validationLabel, '1 pass / 1 fail');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
