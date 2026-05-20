import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OpencodeExecAdapter } from '../../src/runtime/OpencodeExecAdapter.js';
import { PROBE_SENTINEL } from '../../src/runtime/firstTurnMcpProbe.js';

function groundedLines(ses = 'ses_1c2b157c3ffesws2xivZl0UA5M', text = 'ok') {
  return [
    JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: ses, part: { type: 'step-start' } }),
    JSON.stringify({ type: 'text', timestamp: 2, sessionID: ses, part: { type: 'text', text } }),
    JSON.stringify({ type: 'step_finish', timestamp: 3, sessionID: ses, part: { type: 'step-finish', reason: 'stop', tokens: { total: 7505, input: 7504, output: 1, cache: { read: 0, write: 0 } }, cost: 0.001 } }),
  ];
}

function fakeChild(scriptLines, { exitCode = 0, stderr = '', emitClose = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes = [];
  child.stdin = {
    write: (s) => { writes.push(String(s)); },
    end: () => {
      setImmediate(() => {
        for (const l of scriptLines) child.stdout.emit('data', Buffer.from(`${l}\r\n`));
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        if (emitClose) child.emit('close', exitCode);
      });
    },
    writable: true,
    destroyed: false,
  };
  child.__drive = () => {
    setImmediate(() => {
      for (const l of scriptLines) child.stdout.emit('data', Buffer.from(`${l}\r\n`));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      if (emitClose) child.emit('close', exitCode);
    });
  };
  child.writes = writes;
  child.kill = () => { child.killed = true; };
  return child;
}

function makeAdapter(child, opts = {}) {
  const store = opts.sessionStore ?? { get: () => null, set: () => {}, clear: () => {} };
  return new OpencodeExecAdapter({
    runtimeId: 'r1',
    teamId: 't1',
    agentId: 'dev-1',
    cwd: '/work',
    systemPrompt: 'You are dev-1.',
    args: opts.args || [],
    spawnImpl: (cmd, args, spawnOpts) => {
      makeAdapter._last = { cmd, args, opts: spawnOpts };
      child.__drive();
      return child;
    },
    resolveCliImpl: (n) => n,
    sessionStore: store,
    turnTimeoutMs: opts.turnTimeoutMs,
  });
}

const SES = 'ses_4a5b6c7d8e9f';

// ── (a) First-turn positional message includes the probe instruction
test('(a) first-turn positional message includes the probe instruction and PROBE_SENTINEL', async () => {
  const child = fakeChild(groundedLines(SES, `ok ${PROBE_SENTINEL}`));
  const a = makeAdapter(child);
  await a.sendTurn({ message: { text: 'do the task' } });
  const posMsg = makeAdapter._last.args[makeAdapter._last.args.length - 1];
  assert.ok(posMsg.includes('TOAD MCP CONNECTIVITY CHECK'), 'message includes probe instruction');
  assert.ok(posMsg.includes(PROBE_SENTINEL), 'message includes sentinel token');
  assert.ok(posMsg.includes('agent_status'), 'message names the grounded tool');
});

// ── (b) First turn without sentinel → turn_failed
test('(b) first turn without sentinel in assistant_text produces turn_failed', async () => {
  const child = fakeChild(groundedLines(SES, 'just ok'));
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
  const child = fakeChild(groundedLines(SES, `ok ${PROBE_SENTINEL}`));
  const a = makeAdapter(child);
  const res = await a.sendTurn({ message: { text: 'do the task' } });
  assert.equal(res.accepted, true);
  assert.equal(res.responseState, 'accepted_by_runtime');
});

// ── (d) Resume turn → probe skipped
test('(d) resume turn skips the probe — no instruction appended, accepted without sentinel', async () => {
  const store = { _v: null, get: () => store._v, set: (_k, v) => { store._v = v; }, clear: () => { store._v = null; } };
  store._v = SES;

  const child = fakeChild(groundedLines(SES, 'just ok'));
  const a = makeAdapter(child, { sessionStore: store });
  const got = [];
  const it = a.events()[Symbol.asyncIterator]();
  const pump = (async () => { for (;;) { const n = await it.next(); if (n.done) break; got.push(n.value); } })();
  const res = await a.sendTurn({ message: { text: 'continue' } });
  await a.stop();
  await pump;

  assert.equal(res.accepted, true);
  assert.equal(res.responseState, 'accepted_by_runtime');
  const posMsg = makeAdapter._last.args[makeAdapter._last.args.length - 1];
  assert.ok(!posMsg.includes('TOAD MCP CONNECTIVITY CHECK'), 'resume turn must not include probe instruction');
  assert.equal(got.find((e) => e.type === 'turn_failed'), undefined);
});

// ── (e) BR1 pre-spawn-throw batch restore intact
test('(e) BR1: pre-spawn-throw batch restore intact — coalesced messages survive spawn failure', async () => {
  let spawnCalls = 0;
  const adapter = new OpencodeExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'dev-1', cwd: '/work', systemPrompt: 'sys',
    spawnImpl: (_cmd, args) => {
      spawnCalls += 1;
      if (spawnCalls === 1) throw new Error('EAGAIN');
      const c = fakeChild(groundedLines(SES, `recovered ${PROBE_SENTINEL}`));
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
