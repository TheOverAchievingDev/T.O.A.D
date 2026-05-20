import test from 'node:test';
import assert from 'node:assert/strict';
import { makeRuntimeRegistrySessionStore } from '../../src/runtime/codex/runtimeRegistrySessionStore.js';

function fakeRegistry() {
  const rows = new Map();
  return {
    _rows: rows,
    getRuntime: (id) => (rows.has(id) ? { runtimeId: id, cliSessionId: rows.get(id) } : null),
    setRuntimeCliSessionId: ({ runtimeId, cliSessionId }) => {
      rows.set(runtimeId, typeof cliSessionId === 'string' && cliSessionId.length > 0 ? cliSessionId : null);
      return { runtimeId, cliSessionId: rows.get(runtimeId) };
    },
  };
}

test('get returns null when unset; set then get round-trips; clear nulls it', () => {
  const reg = fakeRegistry();
  reg._rows.set('r1', null);
  const store = makeRuntimeRegistrySessionStore(reg);

  assert.equal(store.get('r1'), null);
  store.set('r1', 'sess-1');
  assert.equal(store.get('r1'), 'sess-1');
  store.clear('r1');
  assert.equal(store.get('r1'), null);
});

test('get returns null for an unknown runtime (never throws)', () => {
  const store = makeRuntimeRegistrySessionStore(fakeRegistry());
  assert.doesNotThrow(() => store.get('missing'));
  assert.equal(store.get('missing'), null);
});

test('set/clear on an unknown runtime are swallowed (best-effort, never throw)', () => {
  const reg = { getRuntime: () => null, setRuntimeCliSessionId: () => { throw new Error('unknown runtime: x'); } };
  const store = makeRuntimeRegistrySessionStore(reg);
  assert.doesNotThrow(() => store.set('x', 'sess'));
  assert.doesNotThrow(() => store.clear('x'));
});
