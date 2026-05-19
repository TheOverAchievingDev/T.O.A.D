import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  normalizeDiagnosticPath,
  parseMypyDiagnostics,
  parseRuffJsonDiagnostics,
} from '../src/ide/python/pythonDiagnosticParsers.js';

test('parseRuffJsonDiagnostics maps Ruff JSON diagnostics', () => {
  const rootPath = path.resolve('C:/project');
  const stdout = JSON.stringify([
    {
      filename: path.join(rootPath, 'src', 'app.py'),
      code: 'F401',
      message: '`os` imported but unused',
      location: { row: 3, column: 1 },
      end_location: { row: 3, column: 10 },
      fix: { applicability: 'safe' },
    },
  ]);

  assert.deepEqual(parseRuffJsonDiagnostics(stdout, { rootPath }), [
    {
      source: 'ruff',
      code: 'F401',
      severity: 'warning',
      message: '`os` imported but unused',
      path: 'src/app.py',
      line: 3,
      column: 1,
      endLine: 3,
      endColumn: 10,
      fixable: true,
    },
  ]);
});

test('parseRuffJsonDiagnostics handles empty and malformed JSON', () => {
  assert.deepEqual(parseRuffJsonDiagnostics('', { rootPath: process.cwd() }), []);
  assert.deepEqual(parseRuffJsonDiagnostics('not json', { rootPath: process.cwd() }), []);
  assert.deepEqual(parseRuffJsonDiagnostics('[]', { rootPath: process.cwd() }), []);
});

test('parseRuffJsonDiagnostics treats parse failures as errors', () => {
  const diagnostics = parseRuffJsonDiagnostics(JSON.stringify([
    {
      filename: 'src/bad.py',
      code: 'E902',
      message: 'SyntaxError: invalid syntax',
      location: { row: 1, column: 8 },
    },
  ]), { rootPath: process.cwd() });

  assert.equal(diagnostics[0].severity, 'error');
  assert.equal(diagnostics[0].endColumn, 9);
});

test('parseMypyDiagnostics maps errors, notes, warnings, and codes', () => {
  const rootPath = path.resolve('C:/project');
  const stdout = [
    `${path.join(rootPath, 'src', 'app.py')}:12:4: error: Incompatible return value type  [return-value]`,
    'src/app.py:13: note: Revealed type is "builtins.str"',
    'src/app.py:14:1: warning: Something optional  [misc]',
    'Success: no issues found in 1 source file',
  ].join('\n');

  assert.deepEqual(parseMypyDiagnostics(stdout, { rootPath }), [
    {
      source: 'mypy',
      code: 'return-value',
      severity: 'error',
      message: 'Incompatible return value type',
      path: 'src/app.py',
      line: 12,
      column: 4,
      endLine: 12,
      endColumn: 5,
      fixable: false,
    },
    {
      source: 'mypy',
      code: null,
      severity: 'info',
      message: 'Revealed type is "builtins.str"',
      path: 'src/app.py',
      line: 13,
      column: 1,
      endLine: 13,
      endColumn: 2,
      fixable: false,
    },
    {
      source: 'mypy',
      code: 'misc',
      severity: 'warning',
      message: 'Something optional',
      path: 'src/app.py',
      line: 14,
      column: 1,
      endLine: 14,
      endColumn: 2,
      fixable: false,
    },
  ]);
});

test('normalizeDiagnosticPath keeps paths project-relative with POSIX separators', () => {
  const rootPath = path.resolve('C:/project');
  assert.equal(
    normalizeDiagnosticPath(path.join(rootPath, 'tests', 'test_app.py'), { rootPath }),
    'tests/test_app.py',
  );
});
