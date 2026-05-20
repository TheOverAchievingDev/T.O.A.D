import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

function fakeChild(scriptLines, { exitCode = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes = [];
  child.stdin = { write: (s) => { writes.push(String(s)); }, end: () => {
    setImmediate(() => {
      for (const l of scriptLines) child.stdout.emit('data', Buffer.from(l + '\n'));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', exitCode);
    });
  }, writable: true, destroyed: false };
  child.writes = writes;
  child.kill = () => { child.killed = true; };
  return child;
}

function memStore() {
  const m = new Map();
  return { get: (id) => (m.has(id) ? m.get(id) : null), set: (id, v) => m.set(id, v), clear: (id) => m.set(id, null), _m: m };
}

function makeAdapter(child, sessionStore) {
  const spawns = [];
  const a = new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/work', systemPrompt: 'You are dev-1.',
    spawnImpl: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return child(); },
    resolveCliImpl: (n) => n, sessionStore,
  });
  a._spawns = spawns;
  return a;
}

test('first turn (no session id) uses first-turn argv + prepends systemPrompt; captures + persists thread_id', async () => {
  const store = memStore();
  let writes;
  const a = makeAdapter(() => {
    const c = fakeChild([
      JSON.stringify({ type: 'thread.started', thread_id: 'sess-xyz' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok \u27E6TOAD_MCP_OK\u27E7' } }),
      JSON.stringify({ type: 'turn.completed' }),
    ]);
    writes = c.writes;
    return c;
  }, store);
  const res = await a.sendTurn({ message: { text: 'do it' } });
  assert.equal(res.accepted, true);
  assert.deepEqual(a._spawns[0].args, ['exec', '--json', '--skip-git-repo-check', '-C', '/work', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-']);
  assert.match(writes.join(''), /You are dev-1\.\n\ndo it/);
  assert.equal(store.get('r1'), 'sess-xyz');
});

test('second turn (session id present) uses resume argv + message-only stdin (no systemPrompt)', async () => {
  const store = memStore();
  store.set('r1', 'sess-xyz');
  let writes;
  const a = makeAdapter(() => { const c = fakeChild([JSON.stringify({ type: 'thread.started', thread_id: 'sess-xyz' }), JSON.stringify({ type: 'turn.completed' })]); writes = c.writes; return c; }, store);
  const res = await a.sendTurn({ message: { text: 'follow up' } });
  assert.equal(res.accepted, true);
  assert.deepEqual(a._spawns[0].args, ['exec', 'resume', '--json', '--skip-git-repo-check', 'sess-xyz', '-']);
  assert.equal(writes.join(''), 'follow up');
  assert.ok(!writes.join('').includes('You are dev-1.'));
});
