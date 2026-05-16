import test from 'node:test';
import assert from 'node:assert/strict';
import { lineCount, locForEvent } from '../src/runtime/locCount/index.js';
import { isIgnored } from '../src/runtime/locCount/index.js';
import { accumulateLoc } from '../src/runtime/locCount/index.js';

test('lineCount predicate', () => {
  assert.equal(lineCount(''), 0);
  assert.equal(lineCount('a'), 1);
  assert.equal(lineCount('a\nb'), 2);
  assert.equal(lineCount('a\nb\n'), 2);
});

test('Edit = added/removed line counts; no-op = 0/0', () => {
  const e = { type: 'tool_use', toolName: 'Edit', input: { file_path: 'a.ts', old_string: 'x\ny', new_string: 'x\ny\nz' } };
  assert.deepEqual(locForEvent(e), { file: 'a.ts', added: 3, removed: 2, removedKnown: true });
  const noop = { type: 'tool_use', toolName: 'Edit', input: { file_path: 'a.ts', old_string: 's', new_string: 's' } };
  assert.deepEqual(locForEvent(noop), { file: 'a.ts', added: 0, removed: 0, removedKnown: true });
});

test('MultiEdit sums; Write removed unknown; non-file tools null', () => {
  const m = { type: 'tool_use', toolName: 'MultiEdit', input: { file_path: 'm.ts', edits: [{ old_string: 'a', new_string: 'a\nb' }, { old_string: '', new_string: 'c' }] } };
  assert.deepEqual(locForEvent(m), { file: 'm.ts', added: 3, removed: 1, removedKnown: true });
  const w = { type: 'tool_use', toolName: 'Write', input: { file_path: 'w.ts', content: 'a\nb\nc' } };
  assert.deepEqual(locForEvent(w), { file: 'w.ts', added: 3, removed: 0, removedKnown: false });
  assert.equal(locForEvent({ type: 'tool_use', toolName: 'Bash', input: { command: 'rm x' } }), null);
  assert.equal(locForEvent({ type: 'assistant_text' }), null);
});

test('isIgnored: gitignore-subset glob, locIgnorePaths augments (not replaces)', () => {
  const git = ['node_modules/', '*.lock', 'dist/'];
  assert.equal(isIgnored('node_modules/x/y.js', git, []), true);
  assert.equal(isIgnored('pnpm.lock', git, []), true);
  assert.equal(isIgnored('src/app.ts', git, []), false);
  // augment: extra pattern adds, original still applies
  assert.equal(isIgnored('src/generated/big.ts', git, ['src/generated/']), true);
  assert.equal(isIgnored('pnpm.lock', git, ['src/generated/']), true);
});

test('accumulateLoc: per-agent {added,removed,removedUnknown,filesTouched}, ignore-filtered, deleter not penalised', () => {
  const events = [
    { agentId: 'dev', type: 'tool_use', toolName: 'Edit', input: { file_path: 'a.ts', old_string: 'x', new_string: 'x\ny' } },
    { agentId: 'dev', type: 'tool_use', toolName: 'Write', input: { file_path: 'b.ts', content: 'p\nq' } },
    { agentId: 'dev', type: 'tool_use', toolName: 'Edit', input: { file_path: 'pnpm.lock', old_string: 'a', new_string: 'a\nb' } },
    { agentId: 'qa', type: 'tool_use', toolName: 'Edit', input: { file_path: 'a.ts', old_string: 'x\ny', new_string: '' } },
  ];
  const out = accumulateLoc(events, { gitRules: ['*.lock'], locIgnorePaths: [] });
  assert.deepEqual(out.dev, { added: 1 + 1 + 2, removed: 1 + 0 + 0, removedUnknown: true, filesTouched: 2, byFile: { 'a.ts': { added: 2, removed: 1 }, 'b.ts': { added: 2, removed: 0 } } });
  assert.deepEqual(out.qa, { added: 0, removed: 2, removedUnknown: false, filesTouched: 1, byFile: { 'a.ts': { added: 0, removed: 2 } } });
});
