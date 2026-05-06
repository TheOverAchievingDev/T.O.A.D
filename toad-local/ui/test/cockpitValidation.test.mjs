import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

test('cockpit validation helpers summarize latest run and output lines', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-cockpit-validation-test-'));
  try {
    const source = path.resolve('src/components/cockpitValidation.ts');
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

    const mod = await import(pathToFileURL(path.join(outDir, 'cockpitValidation.js')).href);
    const runs = mod.sortValidationRuns([
      { kind: 'test', verdict: 'passed', command: 'npm test', exitCode: 0, durationMs: 1500, stdout: 'ok', stderr: '', actorId: 'qa', createdAt: '2026-01-01T00:00:00.000Z' },
      { kind: 'lint', verdict: 'failed', command: 'npm run lint', exitCode: 1, durationMs: 250, stdout: 'checking', stderr: 'error one\nerror two', actorId: 'lead', createdAt: '2026-01-01T00:01:00.000Z' },
    ]);

    assert.equal(runs[0].kind, 'lint');
    assert.equal(mod.validationSummary(runs), '1 pass / 1 fail');
    assert.equal(mod.formatValidationDuration(1500), '1.5s');
    assert.deepEqual(mod.validationOutputLines(runs[0]), ['checking', 'error one', 'error two']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
