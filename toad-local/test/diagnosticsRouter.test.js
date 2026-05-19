import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { routeDiagnostics, routeFixFile } from '../src/ide/diagnosticsRouter.js';

function proj(markers) {
  const dir = mkdtempSync(path.join(tmpdir(), 'toad-router-'));
  if (markers.includes('js')) writeFileSync(path.join(dir, 'package.json'), '{}');
  if (markers.includes('py')) writeFileSync(path.join(dir, 'pyproject.toml'), '[tool]\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
const impls = {
  python: { runPythonDiagnostics: async () => ({ diagnostics: [{ source: 'ruff', path: 'a.py', line: 1, column: 1, severity: 'warning', code: null, message: 'm', endLine: 1, endColumn: 2, fixable: false }], toolResults: [{ tool: 'ruff' }], generatedAt: 't' }), fixPythonFile: async () => ({ changed: true, source: 'python' }) },
  js: { runJsDiagnostics: async () => ({ diagnostics: [{ source: 'eslint', path: 'a.ts', line: 1, column: 1, severity: 'error', code: null, message: 'm', endLine: 1, endColumn: 2, fixable: false }], toolResults: [{ tool: 'eslint' }], generatedAt: 't' }), fixJsFile: async () => ({ changed: true, source: 'js' }) },
};

test('file scope routes by extension', async () => {
  const p = proj(['js', 'py']);
  try {
    const ts = await routeDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'a.ts', scope: 'file' }, impls);
    assert.deepEqual(ts.diagnostics.map((d) => d.source), ['eslint']);
    const py = await routeDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'a.py', scope: 'file' }, impls);
    assert.deepEqual(py.diagnostics.map((d) => d.source), ['ruff']);
  } finally { p.cleanup(); }
});

test('project scope runs every detected toolchain, merged', async () => {
  const p = proj(['js', 'py']);
  try {
    const r = await routeDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, scope: 'project' }, impls);
    assert.deepEqual([...new Set(r.diagnostics.map((d) => d.source))].sort(), ['eslint', 'ruff']);
    assert.equal(r.toolResults.length, 2);
  } finally { p.cleanup(); }
});

test('project scope js-only project → js only', async () => {
  const p = proj(['js']);
  try {
    const r = await routeDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, scope: 'project' }, impls);
    assert.deepEqual([...new Set(r.diagnostics.map((d) => d.source))], ['eslint']);
  } finally { p.cleanup(); }
});

test('unknown extension file scope → empty, no throw', async () => {
  const p = proj(['js']);
  try {
    const r = await routeDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'a.md', scope: 'file' }, impls);
    assert.deepEqual(r.diagnostics, []);
  } finally { p.cleanup(); }
});

test('routeFixFile routes by extension', async () => {
  const p = proj(['js', 'py']);
  try {
    assert.equal((await routeFixFile({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'a.ts' }, impls)).source, 'js');
    assert.equal((await routeFixFile({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'a.py' }, impls)).source, 'python');
  } finally { p.cleanup(); }
});
