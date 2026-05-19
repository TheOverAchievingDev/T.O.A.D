import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { runJsDiagnostics, formatJsFile, fixJsFile } from '../src/ide/js/jsDiagnosticsRunner.js';

function fakeSpawn(plan) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      const r = plan(command, args) || { stdout: '', stderr: '', code: 0 };
      if (r.stdout) child.stdout.emit('data', Buffer.from(r.stdout));
      if (r.stderr) child.stderr.emit('data', Buffer.from(r.stderr));
      child.emit('close', r.code ?? 0);
    });
    return child;
  };
}

function jsProject(withEslintBin = true) {
  const dir = mkdtempSync(path.join(tmpdir(), 'toad-jsrun-'));
  mkdirSync(path.join(dir, 'src'), { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}\n');
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const x=1\n');
  if (withEslintBin) {
    mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
    const ext = process.platform === 'win32' ? '.cmd' : '';
    writeFileSync(path.join(dir, 'node_modules', '.bin', `eslint${ext}`), '');
    writeFileSync(path.join(dir, 'node_modules', '.bin', `tsc${ext}`), '');
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('runJsDiagnostics parses ESLint + tsc when binaries present', async () => {
  const p = jsProject(true);
  try {
    const spawn = fakeSpawn((cmd) => cmd.includes('eslint')
      ? { stdout: JSON.stringify([{ filePath: path.join(p.dir, 'src/a.ts'), messages: [{ ruleId: 'semi', severity: 2, message: 'Missing semicolon.', line: 1, column: 14, endLine: 1, endColumn: 15 }] }]), code: 1 }
      : { stdout: `${path.join(p.dir, 'src/a.ts')}(1,1): error TS1005: ';' expected.\n`, code: 2 });
    const r = await runJsDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, scope: 'project', spawn });
    assert.deepEqual([...new Set(r.diagnostics.map((d) => d.source))].sort(), ['eslint', 'tsc']);
    assert.equal(r.toolResults.length, 2);
  } finally { p.cleanup(); }
});

test('runJsDiagnostics: missing eslint binary → available:false actionable message, no throw', async () => {
  const p = jsProject(false);
  try {
    const r = await runJsDiagnostics({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, scope: 'project', spawn: fakeSpawn(() => ({ stdout: '', code: 0 })) });
    const eslint = r.toolResults.find((t) => t.tool === 'eslint');
    assert.equal(eslint.available, false);
    assert.match(eslint.message, /Install the project's dev dependencies/i);
  } finally { p.cleanup(); }
});

test('formatJsFile: no project Prettier → unsupported result, no throw', async () => {
  const p = jsProject(true);
  try {
    const r = await formatJsFile({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'src/a.ts', spawn: fakeSpawn(() => ({ code: 0 })) });
    assert.equal(r.changed, false);
    assert.equal(r.toolResults.find((t) => t.tool === 'prettier').available, false);
  } finally { p.cleanup(); }
});

test('fixJsFile rejects non-JS/TS + path traversal', async () => {
  const p = jsProject(true);
  try {
    await assert.rejects(fixJsFile({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: 'README.md', spawn: fakeSpawn(() => ({})) }), /unsupported file type/);
    await assert.rejects(fixJsFile({ projectCwd: p.dir, teamId: 't', source: { kind: 'project' }, relativePath: '../x.ts', spawn: fakeSpawn(() => ({})) }), /path outside source root/);
  } finally { p.cleanup(); }
});
