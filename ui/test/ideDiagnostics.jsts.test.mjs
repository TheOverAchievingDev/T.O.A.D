import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

let outDir; let mod;
test.before(async () => {
  outDir = await mkdtemp(path.join(os.tmpdir(), 'toad-idejsts-'));
  const tsc = path.resolve('ui/node_modules/typescript/bin/tsc');
  const r = spawnSync(process.execPath, [tsc, path.resolve('ui/src/components/ideDiagnostics.ts'), '--target', 'ES2022', '--module', 'ES2022', '--moduleResolution', 'Bundler', '--outDir', outDir, '--skipLibCheck'], { encoding: 'utf8' });
  if (r.status !== 0) { await rm(outDir, { recursive: true, force: true }); throw new Error(r.stderr || r.stdout); }
  mod = await import(pathToFileURL(path.join(outDir, 'ideDiagnostics.js')).href);
});
test.after(async () => { await rm(outDir, { recursive: true, force: true }); });

test('isDiagnosablePath: true for py + js/ts variants, false for others', () => {
  for (const p of ['a.py', 'a.js', 'a.jsx', 'a.ts', 'a.tsx', 'a.cjs', 'a.mjs', 'a.cts', 'a.mts', 'src/x.TS'])
    assert.equal(mod.isDiagnosablePath(p), true, p);
  for (const p of ['a.md', 'a.png', 'a.json', 'a'])
    assert.equal(mod.isDiagnosablePath(p), false, p);
});

test('languageForDiagnostics maps extension', () => {
  assert.equal(mod.languageForDiagnostics('a.py'), 'python');
  assert.equal(mod.languageForDiagnostics('a.tsx'), 'jsts');
  assert.equal(mod.languageForDiagnostics('a.md'), null);
});

test('toMonacoMarkerData maps eslint + tsc sources', () => {
  const sev = { Error: 8, Warning: 4, Info: 2 };
  assert.equal(mod.toMonacoMarkerData({ source: 'eslint', code: 'semi', severity: 'warning', message: 'm', path: 'a.ts', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: true }, sev).severity, 4);
  assert.equal(mod.toMonacoMarkerData({ source: 'tsc', code: 'TS2322', severity: 'error', message: 'm', path: 'a.ts', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: false }, sev).severity, 8);
});
