import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OpencodeExecAdapter } from '../../src/runtime/OpencodeExecAdapter.js';

function fakeChild(scriptLines, { exitCode = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const writes = [];
  child.stdin = {
    write: (s) => { writes.push(String(s)); },
    end: () => {
      setImmediate(() => {
        for (const l of scriptLines) child.stdout.emit('data', Buffer.from(`${l}\n`));
        if (stderr) child.stderr.emit('data', Buffer.from(stderr));
        child.emit('close', exitCode);
      });
    },
    writable: true,
    destroyed: false,
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
      return child;
    },
    resolveCliImpl: (n) => n,
    sessionStore: store,
    turnTimeoutMs: opts.turnTimeoutMs,
  });
}

test('first sendTurn spawns OpenCode run json with prompt on stdin', async () => {
  const child = fakeChild([
    JSON.stringify({ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } }),
    JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'ok' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', reason: 'stop', tokens: { input: 5, output: 2 } } }),
  ]);
  const adapter = makeAdapter(child, { args: ['--model', 'deepseek/deepseek-v4'] });

  const res = await adapter.sendTurn({ message: { text: 'do the task' } });

  assert.equal(res.accepted, true);
  assert.equal(res.responseState, 'accepted_by_runtime');
  assert.deepEqual(makeAdapter._last.args, [
    'run',
    '--format', 'json',
    '--dangerously-skip-permissions',
    '--model', 'deepseek/deepseek-v4',
  ]);
  assert.match(child.writes.join(''), /You are dev-1\.\n\ndo the task/);
  assert.equal(makeAdapter._last.opts.cwd, '/work');
});

test('session id is persisted and resume sends only the follow-up message', async () => {
  const child = fakeChild([
    JSON.stringify({ type: 'step_start', sessionID: 'ses_existing', part: { type: 'step-start' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'ses_existing', part: { type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1 } } }),
  ]);
  const calls = [];
  const store = {
    get: () => 'ses_existing',
    set: (...args) => calls.push(['set', ...args]),
    clear: (...args) => calls.push(['clear', ...args]),
  };
  const adapter = makeAdapter(child, { sessionStore: store });

  const res = await adapter.sendTurn({ message: { text: 'second turn' } });

  assert.equal(res.accepted, true);
  assert.deepEqual(makeAdapter._last.args, [
    'run',
    '--format', 'json',
    '--dangerously-skip-permissions',
    '--session', 'ses_existing',
  ]);
  assert.equal(child.writes.join(''), 'second turn');
  assert.deepEqual(calls, [['set', 'r1', 'ses_existing']]);
});

test('events() yields normalized assistant text and turn_completed', async () => {
  const child = fakeChild([
    JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'hi' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'ses_1', part: { type: 'step-finish', reason: 'stop', tokens: { input: 2, output: 1 } } }),
  ]);
  const adapter = makeAdapter(child);
  const seen = [];
  const it = adapter.events()[Symbol.asyncIterator]();
  const pump = (async () => {
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      seen.push(next.value.type);
    }
  })();

  await adapter.sendTurn({ message: { text: 'x' } });
  await adapter.stop();
  await pump;

  assert.ok(seen.includes('assistant_text'));
  assert.ok(seen.includes('turn_completed'));
});

test('non-zero exit before result emits turn_failed with stderr', async () => {
  const child = fakeChild([], { exitCode: 1, stderr: 'auth required' });
  const adapter = makeAdapter(child);
  const got = [];
  const it = adapter.events()[Symbol.asyncIterator]();
  const pump = (async () => {
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      got.push(next.value);
    }
  })();

  const res = await adapter.sendTurn({ message: { text: 'x' } });
  await adapter.stop();
  await pump;

  assert.equal(res.accepted, false);
  assert.match(got.find((e) => e.type === 'turn_failed').error, /auth required/);
});

test('providerId and not-applicable methods are OpenCode-specific', async () => {
  const adapter = makeAdapter(fakeChild([]));

  assert.equal(adapter.providerId, 'opencode');
  assert.equal((await adapter.approve({ approvalId: 'a1' })).responseState, 'approval_not_applicable_opencode');
  assert.equal((await adapter.sendToolResult({ toolUseId: 't1' })).responseState, 'not_applicable_opencode_mcp_direct');
});

test('stale resume session clears stored id and retries as a fresh first turn', async () => {
  const first = fakeChild([], { exitCode: 1, stderr: 'session not found' });
  const second = fakeChild([
    JSON.stringify({ type: 'step_start', sessionID: 'ses_new', part: { type: 'step-start' } }),
    JSON.stringify({ type: 'step_finish', sessionID: 'ses_new', part: { type: 'step-finish', reason: 'stop', tokens: { input: 1, output: 1 } } }),
  ]);
  const calls = [];
  const children = [first, second];
  const store = {
    get: () => 'ses_missing',
    set: (...args) => calls.push(['set', ...args]),
    clear: (...args) => calls.push(['clear', ...args]),
  };
  const adapter = new OpencodeExecAdapter({
    runtimeId: 'r1',
    teamId: 't1',
    agentId: 'dev-1',
    cwd: '/work',
    systemPrompt: 'You are dev-1.',
    spawnImpl: (_cmd, args, opts) => {
      makeAdapter._last = { args, opts };
      return children.shift();
    },
    resolveCliImpl: (n) => n,
    sessionStore: store,
  });

  const res = await adapter.sendTurn({ message: { text: 'recover' } });

  assert.equal(res.accepted, true);
  assert.deepEqual(calls, [['clear', 'r1'], ['set', 'r1', 'ses_new']]);
  assert.ok(!makeAdapter._last.args.includes('--session'));
  assert.match(second.writes.join(''), /You are dev-1\.\n\nrecover/);
});
