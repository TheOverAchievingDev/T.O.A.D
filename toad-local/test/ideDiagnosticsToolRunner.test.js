import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { resolveDiagnosticFileTarget } from '../src/ide/diagnosticsToolRunner.js';

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'toad-dtr-'));
  mkdirSync(path.join(dir, 'src'));
  writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const x = 1;\n');
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('resolveDiagnosticFileTarget accepts an allowed extension and returns posix relative target', () => {
  const f = fixture();
  try {
    const t = resolveDiagnosticFileTarget(f.dir, 'src/a.ts', 'ide_fix_file', ['.ts', '.tsx']);
    assert.equal(t.relativePath, 'src/a.ts');
    assert.equal(t.commandTarget, 'src/a.ts');
  } finally { f.cleanup(); }
});

test('resolveDiagnosticFileTarget rejects a disallowed extension', () => {
  const f = fixture();
  try {
    assert.throws(
      () => resolveDiagnosticFileTarget(f.dir, 'src/a.ts', 'ide_fix_file', ['.py']),
      /ide_fix_file: unsupported file type/,
    );
  } finally { f.cleanup(); }
});

test('resolveDiagnosticFileTarget rejects path traversal / absolute', () => {
  const f = fixture();
  try {
    assert.throws(() => resolveDiagnosticFileTarget(f.dir, '../evil.ts', 'ide_fix_file', ['.ts']),
      /ide_fix_file: path outside source root/);
    assert.throws(() => resolveDiagnosticFileTarget(f.dir, 'C:/abs.ts', 'ide_fix_file', ['.ts']),
      /ide_fix_file: path outside source root/);
  } finally { f.cleanup(); }
});
