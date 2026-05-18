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

function makeAdapter(child) {
  return new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/work',
    systemPrompt: 'You are dev-1.',
    spawnImpl: (cmd, args, opts) => { makeAdapter._last = { cmd, args, opts }; return child; },
    resolveCliImpl: (n) => n,
  });
}

test('first sendTurn spawns codex exec with RATIFIED argv + prompt on stdin', async () => {
  const child = fakeChild([
    JSON.stringify({ type: 'thread.started', thread_id: 's1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ]);
  const a = makeAdapter(child);
  const res = await a.sendTurn({ message: { text: 'do the task' } });
  assert.equal(res.accepted, true);
  assert.equal(res.responseState, 'accepted_by_runtime');
  const { args } = makeAdapter._last;
  assert.deepEqual(args, ['exec', '--json', '--skip-git-repo-check', '-C', '/work', '--sandbox', 'workspace-write', '-c', 'approval_policy="never"', '-']);
  assert.match(child.writes.join(''), /You are dev-1\.\n\ndo the task/);
});

test('events() yields the normalized stream incl. turn_completed', async () => {
  const child = fakeChild([
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }),
    JSON.stringify({ type: 'turn.completed' }),
  ]);
  const a = makeAdapter(child);
  const seen = [];
  const it = a.events()[Symbol.asyncIterator]();
  const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; seen.push(n.value.type); } })();
  await a.sendTurn({ message: { text: 'x' } });
  await a.stop();
  await pump;
  assert.ok(seen.includes('assistant_text'));
  assert.ok(seen.includes('turn_completed'));
});

test('non-zero exit before turn.completed → turn_failed with stderr', async () => {
  const child = fakeChild([], { exitCode: 2, stderr: 'codex: auth required' });
  const a = makeAdapter(child);
  const it = a.events()[Symbol.asyncIterator]();
  const got = [];
  const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; got.push(n.value); } })();
  const res = await a.sendTurn({ message: { text: 'x' } });
  await a.stop();
  await pump;
  assert.equal(res.accepted, false);
  const failed = got.find((e) => e.type === 'turn_failed');
  assert.ok(failed && /auth required/.test(failed.error));
});

test('approve() and sendToolResult() return structured not-applicable', async () => {
  const a = makeAdapter(fakeChild([]));
  const ap = await a.approve({ approvalId: 'x', decision: 'approved' });
  assert.equal(ap.accepted, false);
  assert.equal(ap.responseState, 'approval_not_applicable_codex');
  const tr = await a.sendToolResult({ toolUseId: 'x', result: {} });
  assert.equal(tr.responseState, 'not_applicable_codex_mcp_direct');
});

test('providerId is openai', () => {
  assert.equal(makeAdapter(fakeChild([])).providerId, 'openai');
});

test('constructor accepts optional sessionStore + turnTimeoutMs (defaults: no store, generous timeout)', () => {
  const a = makeAdapter(fakeChild([]));
  assert.equal(a.sessionStore, null);
  assert.equal(typeof a.turnTimeoutMs, 'number');
  assert.ok(a.turnTimeoutMs >= 600000);
});

test('turnStartedAt/isTurnInFlight reflect an in-flight turn and clear on completion', async () => {
  let release;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => { release = () => { child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n')); child.emit('close', 0); }; }, writable: true };
  child.kill = () => {};
  const a = new CodexExecAdapter({ runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/w', systemPrompt: '', spawnImpl: () => child, resolveCliImpl: (n) => n, sessionStore: { get: () => null, set: () => {}, clear: () => {} } });
  assert.equal(a.isTurnInFlight(), false);
  const p = a.sendTurn({ message: { text: 'x' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(a.isTurnInFlight(), true);
  assert.equal(typeof a.turnStartedAt, 'string');
  release();
  await p;
  assert.equal(a.isTurnInFlight(), false);
  assert.equal(a.turnStartedAt, null);
});
