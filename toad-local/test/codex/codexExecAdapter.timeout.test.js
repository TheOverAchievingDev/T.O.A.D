import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

function hangingChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {}, writable: true };
  child.killed = false;
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)); };
  return child; // never emits turn.completed on its own
}

test('a turn exceeding turnTimeoutMs is SIGTERM-killed and resolves turn_failed(timeout)', async () => {
  const child = hangingChild();
  const a = new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/w', systemPrompt: '',
    spawnImpl: () => child, resolveCliImpl: (n) => n,
    sessionStore: { get: () => null, set: () => {}, clear: () => {} },
    turnTimeoutMs: 40,
  });
  const events = [];
  const it = a.events()[Symbol.asyncIterator]();
  const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; events.push(n.value); } })();
  const res = await a.sendTurn({ message: { text: 'work forever' } });
  await a.stop();
  await pump;
  assert.equal(res.accepted, false);
  assert.equal(child.killed, true);
  const failed = events.find((e) => e.type === 'turn_failed');
  assert.ok(failed && /timeout/i.test(failed.error));
});
