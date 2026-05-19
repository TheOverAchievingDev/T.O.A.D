import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

function fakeChild(scriptLines, { exitCode = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.writes = [];
  child.stdin = { write: (s) => child.writes.push(String(s)), end: () => {
    setImmediate(() => {
      for (const l of scriptLines) child.stdout.emit('data', Buffer.from(l + '\n'));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
  }, writable: true };
  child.kill = () => { child.killed = true; };
  return child;
}

test('resume with an unknown session id clears it, emits codex_session_reset, retries as a fresh first-turn carrying the message', async () => {
  const m = new Map([['r1', 'stale-sess']]);
  const store = { get: (id) => (m.has(id) ? m.get(id) : null), set: (id, v) => m.set(id, v), clear: (id) => m.set(id, null) };
  const spawns = [];
  let call = 0;
  const a = new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/w', systemPrompt: 'You are dev-1.',
    spawnImpl: (cmd, args) => {
      spawns.push(args);
      call += 1;
      if (call === 1) return fakeChild([], { exitCode: 1, stderr: 'Error: unknown session id: stale-sess' });
      return fakeChild([JSON.stringify({ type: 'thread.started', thread_id: 'fresh-sess' }), JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok \u27E6TOAD_MCP_OK\u27E7' } }), JSON.stringify({ type: 'turn.completed' })]);
    },
    resolveCliImpl: (n) => n, sessionStore: store,
  });
  const events = [];
  const it = a.events()[Symbol.asyncIterator]();
  const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; events.push(n.value); } })();
  const res = await a.sendTurn({ message: { text: 'still must arrive' } });
  await a.stop();
  await pump;

  assert.equal(res.accepted, true);
  assert.deepEqual(spawns[0].slice(0, 2), ['exec', 'resume']);
  assert.equal(spawns[1][0], 'exec');
  assert.notEqual(spawns[1][1], 'resume');
  assert.equal(store.get('r1'), 'fresh-sess');
  assert.ok(events.some((e) => e.type === 'runtime_event' && e.note === 'codex_session_reset'));
  assert.equal(events.filter((e) => e.type === 'turn_failed').length, 0,
    'a transparently-recovered session-loss must emit NO turn_failed');
});
