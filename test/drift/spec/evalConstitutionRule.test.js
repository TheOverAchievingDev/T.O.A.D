import test from 'node:test';
import assert from 'node:assert/strict';
import { evalConstitutionRule } from '../../../src/drift/spec/evalConstitutionRule.js';

const GREP = { id: 'no-sedebug', detector: { type: 'grep', pattern: 'SeDebugPrivilege' } };

test('grep: returns ALL hits per content, with 1-based line + snippet', () => {
  const content = 'fn a() {}\nenable(SeDebugPrivilege);\nlet x=1;\ncall(SeDebugPrivilege);\n';
  const hits = evalConstitutionRule(GREP, { path: 'src/p.rs', content });
  assert.equal(hits.length, 2);
  assert.deepEqual(hits.map((h) => h.line), [2, 4]);
  assert.match(hits[0].snippet, /SeDebugPrivilege/);
});

test('grep: comment-only match is suppressed (reuses comment strip)', () => {
  const content = '// no SeDebugPrivilege required per ADR-004\nok();\n';
  assert.deepEqual(evalConstitutionRule(GREP, { path: 'src/p.rs', content }), []);
});

test('grep: real code before a trailing comment still hits', () => {
  const content = 'enable("SeDebugPrivilege"); // bad\n';
  const hits = evalConstitutionRule(GREP, { path: 'src/p.rs', content });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 1);
});

test('grep: exclude_paths suppresses the rule for matching paths', () => {
  const rule = { id: 'r', detector: { type: 'grep', pattern: 'X', exclude_paths: ['tests/**'] } };
  assert.deepEqual(evalConstitutionRule(rule, { path: 'tests/a.rs', content: 'X\n' }), []);
  assert.equal(evalConstitutionRule(rule, { path: 'src/a.rs', content: 'X\n' }).length, 1);
});

test('path_presence: hit iff the path matches a forbidden glob (content ignored)', () => {
  const rule = { id: 'no-exe', detector: { type: 'path_presence', forbidden_paths: ['**/*.exe'] } };
  const hits = evalConstitutionRule(rule, { path: 'bin/reaper.exe', content: '' });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 0);
  assert.deepEqual(evalConstitutionRule(rule, { path: 'src/main.rs', content: 'x' }), []);
});

test('unsupported detector type → null (caller records unsupported, never silent pass)', () => {
  assert.equal(evalConstitutionRule({ id: 'a', detector: { type: 'ast' } }, { path: 'x', content: 'y' }), null);
});

test('invalid grep regex → null (fail-soft, caller records unsupported)', () => {
  assert.equal(evalConstitutionRule({ id: 'b', detector: { type: 'grep', pattern: '([' } }, { path: 'x.rs', content: 'y' }), null);
});
