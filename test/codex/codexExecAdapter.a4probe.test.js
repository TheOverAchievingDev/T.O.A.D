import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';
import { PROBE_SENTINEL } from '../../src/runtime/firstTurnMcpProbe.js';

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

function makeAdapter(child, opts = {}) {
  const store = opts.sessionStore ?? { get: () => null, set: () => {}, clear: () => {} };
  return new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/work',
    systemPrompt: 'You are dev-1.',
    spawnImpl: (cmd, args, spawnOpts) => { makeAdapter._last = { cmd, args, opts: spawnOpts }; return child; },
    resolveCliImpl: (n) => n,
    sessionStore: store,
  });
}

const FIRST_TURN_OK_LINES = [
  JSON.stringify({ type: 'thread.started', thread_id: 's1' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
  JSON.stringify({ type: 'turn.completed' }),
];

const FIRST_TURN_SENTINEL_LINES = [
  JSON.stringify({ type: 'thread.started', thread_id: 's2' }),
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `ok ${PROBE_SENTINEL}` } }),
  JSON.stringify({ type: 'turn.completed' }),
];

// ── (a) First-turn prompt contains the probe instruction + sentinel
test('(a) first-turn prompt includes the probe instruction and PROBE_SENTINEL', async () => {
  const child = fakeChild(FIRST_TURN_OK_LINES);
  const a = makeAdapter(child);
  await a.sendTurn({ message: { text: 'do the task' } });
  const writes = child.writes.join('');
  assert.ok(writes.includes('TOAD MCP CONNECTIVITY CHECK'), 'prompt includes probe instruction');
  assert.ok(writes.includes(PROBE_SENTINEL), 'prompt includes sentinel token');
  assert.ok(writes.includes('agent_status'), 'prompt names the grounded tool');
});

// ── (b) First turn without sentinel → turn_failed
test('(b) first turn without sentinel in assistant_text produces turn_failed', async () => {
  const child = fakeChild(FIRST_TURN_OK_LINES);
  const a = makeAdapter(child);
  const got = [];
  const it = a.events()[Symbol.asyncIterator]();
  const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; got.push(n.value); } })();
  const res = await a.sendTurn({ message: { text: 'do the task' } });
  await a.stop();
  await pump;
  assert.equal(res.accepted, false);
  const failed = got.find((e) => e.type === 'turn_failed');
  assert.ok(failed, 'turn_failed event was pushed');
  assert.match(failed.error, /TOAD tools unavailable/);
});

// ── (c) First turn with sentinel → accepted
test('(c) first turn with sentinel in assistant_text is accepted normally', async () => {
  const child = fakeChild(FIRST_TURN_SENTINEL_LINES);
  const a = makeAdapter(child);
  const res = await a.sendTurn({ message: { text: 'do the task' } });
  assert.equal(res.accepted, true);
  assert.equal(res.responseState, 'accepted_by_runtime');
});

// ── (d) Resume turn → probe skipped, accepted even without sentinel
test('(d) resume turn skips the probe — no instruction appended, accepted without sentinel', async () => {
  const store = { _v: null, get: () => store._v, set: (_k, v) => { store._v = v; }, clear: () => { store._v = null; } };
  store._v = 'ses_abc'; // simulate prior session

  const child = fakeChild(FIRST_TURN_OK_LINES);
  const a = makeAdapter(child, { sessionStore: store });
  const got = [];
  const it = a.events()[Symbol.asyncIterator]();
  const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; got.push(n.value); } })();
  const res = await a.sendTurn({ message: { text: 'continue' } });
  await a.stop();
  await pump;

  assert.equal(res.accepted, true);
  assert.equal(res.responseState, 'accepted_by_runtime');
  // No probe instruction in the prompt (resume skips it)
  const writes = child.writes.join('');
  assert.ok(!writes.includes('TOAD MCP CONNECTIVITY CHECK'), 'resume turn must not include probe instruction');
  // No turn_failed
  assert.equal(got.find((e) => e.type === 'turn_failed'), undefined);
});

// ── (e) BR1 pre-spawn-throw _pendingTexts restore still holds
test('(e) BR1: pre-spawn-throw batch restore intact — coalesced messages survive spawn failure', async () => {
  let spawnCalls = 0;
  const adapter = new CodexExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', cwd: '/work', systemPrompt: 'sys',
    spawnImpl: (_cmd, _args) => {
      spawnCalls += 1;
      if (spawnCalls === 1) throw new Error('EAGAIN');
      const c = fakeChild(FIRST_TURN_SENTINEL_LINES);
      return c;
    },
    resolveCliImpl: (n) => n,
  });

  const pA = adapter.sendTurn({ message: { text: 'alpha' } });
  const pB = adapter.sendTurn({ message: { text: 'beta' } });
  pA.catch(() => {});

  const [resA, resB] = await Promise.allSettled([pA, pB]);
  assert.equal(resA.status, 'rejected');
  assert.equal(resB.status, 'fulfilled');
  assert.equal(resB.value.accepted, true);
});
