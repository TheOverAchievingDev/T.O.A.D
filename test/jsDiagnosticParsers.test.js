import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseEslintJsonDiagnostics, parseTscDiagnostics } from '../src/ide/js/jsDiagnosticParsers.js';

test('parseEslintJsonDiagnostics maps ESLint JSON, severity + fixable', () => {
  const rootPath = path.resolve('C:/project');
  const stdout = JSON.stringify([
    {
      filePath: path.join(rootPath, 'src', 'a.ts'),
      messages: [
        { ruleId: 'no-unused-vars', severity: 2, message: "'x' is defined but never used.", line: 3, column: 7, endLine: 3, endColumn: 8 },
        { ruleId: 'semi', severity: 1, message: 'Missing semicolon.', line: 4, column: 10, endLine: 4, endColumn: 11, fix: { range: [1, 2], text: ';' } },
      ],
    },
  ]);
  assert.deepEqual(parseEslintJsonDiagnostics(stdout, { rootPath }), [
    { source: 'eslint', code: 'no-unused-vars', severity: 'error', message: "'x' is defined but never used.", path: 'src/a.ts', line: 3, column: 7, endLine: 3, endColumn: 8, fixable: false },
    { source: 'eslint', code: 'semi', severity: 'warning', message: 'Missing semicolon.', path: 'src/a.ts', line: 4, column: 10, endLine: 4, endColumn: 11, fixable: true },
  ]);
});

test('parseEslintJsonDiagnostics: empty / malformed → []', () => {
  assert.deepEqual(parseEslintJsonDiagnostics('', { rootPath: process.cwd() }), []);
  assert.deepEqual(parseEslintJsonDiagnostics('not json', { rootPath: process.cwd() }), []);
  assert.deepEqual(parseEslintJsonDiagnostics('{}', { rootPath: process.cwd() }), []);
});

test('parseEslintJsonDiagnostics: message without ruleId → code null', () => {
  const rootPath = path.resolve('C:/project');
  const stdout = JSON.stringify([
    { filePath: path.join(rootPath, 'a.js'), messages: [
      { ruleId: null, severity: 1, message: 'Parsing error: x', line: 1, column: 1, endLine: 1, endColumn: 2 },
    ] },
  ]);
  assert.deepEqual(parseEslintJsonDiagnostics(stdout, { rootPath }), [
    { source: 'eslint', code: null, severity: 'warning', message: 'Parsing error: x', path: 'a.js', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: false },
  ]);
});

test('parseTscDiagnostics maps tsc stdout incl. TS code, drops non-matching + out-of-root', () => {
  const rootPath = path.resolve('C:/project');
  const stdout = [
    `${path.join(rootPath, 'src', 'a.ts')}(5,3): error TS2322: Type 'number' is not assignable to type 'string'.`,
    `${path.join(rootPath, 'src', 'b.tsx')}(1,1): warning TS6133: 'React' is declared but never used.`,
    'Found 2 errors.',
    `${path.resolve('C:/other')}(9,9): error TS1005: ';' expected.`,
  ].join('\n');
  assert.deepEqual(parseTscDiagnostics(stdout, { rootPath }), [
    { source: 'tsc', code: 'TS2322', severity: 'error', message: "Type 'number' is not assignable to type 'string'.", path: 'src/a.ts', line: 5, column: 3, endLine: 5, endColumn: 4, fixable: false },
    { source: 'tsc', code: 'TS6133', severity: 'warning', message: "'React' is declared but never used.", path: 'src/b.tsx', line: 1, column: 1, endLine: 1, endColumn: 2, fixable: false },
  ]);
});

test('parseTscDiagnostics: empty / no matches → []', () => {
  assert.deepEqual(parseTscDiagnostics('', { rootPath: process.cwd() }), []);
  assert.deepEqual(parseTscDiagnostics('Found 0 errors.', { rootPath: process.cwd() }), []);
});
