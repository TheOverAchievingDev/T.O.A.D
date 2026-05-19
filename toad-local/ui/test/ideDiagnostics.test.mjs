import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function compileHelper() {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'toad-ide-diagnostics-'));
  const uiRoot = path.basename(process.cwd()).toLowerCase() === 'ui'
    ? process.cwd()
    : path.resolve('ui');
  const source = path.join(uiRoot, 'src/components/ideDiagnostics.ts');
  const tsc = path.join(uiRoot, 'node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [
    tsc,
    source,
    '--target', 'ES2022',
    '--module', 'ES2022',
    '--moduleResolution', 'Bundler',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    await rm(outDir, { recursive: true, force: true });
    throw new Error(result.stderr || result.stdout || 'tsc failed');
  }
  return {
    outDir,
    mod: await import(pathToFileURL(path.join(outDir, 'ideDiagnostics.js')).href),
  };
}

test('ide diagnostics helpers filter, count, and group by normalized path', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    const diagnostics = [
      diagnostic({ path: 'src\\app.py', severity: 'warning', line: 2 }),
      diagnostic({ path: 'tests/test_app.py', severity: 'error', line: 1 }),
      diagnostic({ path: 'src/app.py', severity: 'info', line: 3 }),
    ];

    assert.equal(mod.isPythonPath('src\\app.py'), true);
    assert.equal(mod.isPythonPath('README.md'), false);
    assert.deepEqual(mod.countDiagnosticsBySeverity(diagnostics), {
      total: 3,
      error: 1,
      warning: 1,
      info: 1,
    });
    assert.equal(mod.diagnosticsForPath(diagnostics, 'src/app.py').length, 2);
    assert.deepEqual(mod.groupDiagnosticsByFile(diagnostics).map((group) => group.path), [
      'src/app.py',
      'tests/test_app.py',
    ]);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('toMonacoMarkerData maps severity and range defaults', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    const marker = mod.toMonacoMarkerData(
      diagnostic({ code: 'F401', line: 8, column: 4, endLine: 8, endColumn: 4 }),
      { Error: 8, Warning: 4, Info: 2 },
    );

    assert.equal(marker.severity, 4);
    assert.equal(marker.startLineNumber, 8);
    assert.equal(marker.startColumn, 4);
    assert.equal(marker.endColumn, 5);
    assert.match(marker.message, /ruff:F401/);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

function diagnostic(overrides = {}) {
  return {
    source: 'ruff',
    code: null,
    severity: 'warning',
    message: 'diagnostic',
    path: 'src/app.py',
    line: 1,
    column: 1,
    endLine: 1,
    endColumn: 2,
    fixable: false,
    ...overrides,
  };
}
