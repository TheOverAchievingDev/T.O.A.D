import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

function gatedChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.writes = [];
  child.release = () => {
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 's1' }) + '\n'));
      child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));
      child.emit('close', 0);
    });
  };
  child.stdin = { write: (s) => child.writes.push(String(s)), end: () => {}, writable: true };
  child.kill = () => { child.killed = true; };
  return child;
}

test('overlapping sendTurn calls run one-at-a-time (FIFO); messages mid-turn coalesce into a single follow-up turn', async () => {
  const children = [];
  const a = new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/w', systemPrompt: '',
    spawnImpl: () => { const c = gatedChild(); children.push(c); return c; },
    resolveCliImpl: (n) => n,
    sessionStore: { get: () => null, set: () => {}, clear: () => {} },
  });

  const p1 = a.sendTurn({ message: { text: 'first' } });
  const p2 = a.sendTurn({ message: { text: 'second' } });
  const p3 = a.sendTurn({ message: { text: 'third' } });

  await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 1);

  children[0].release();
  const r1 = await p1;
  assert.equal(r1.accepted, true);

  await new Promise((r) => setImmediate(r));
  assert.equal(children.length, 2);
  children[1].release();
  const [r2, r3] = await Promise.all([p2, p3]);
  assert.equal(r2.accepted, true);
  assert.equal(r3.accepted, true);
  assert.equal(children.length, 2);
  assert.match(children[1].writes.join(''), /second[\s\S]*third|second\nthird/);
});
