// Grounded adapter suite — asserts the EXACT argv + session/resume model that
// the RATIFIED §7/§10 contract from docs/superpowers/grounding/2026-05-18-gemini-cli.md
// requires for gemini-cli 0.42.0.
//
// THE KEY DEFECT this suite locks (grounding §10, RATIFIED Option 3):
//   - First turn: adapter generates a UUID and passes `--session-id <uuid>`.
//   - Resume turns: adapter passes `--resume latest` (literal string), NEVER
//     the stored UUID (`--resume` does not accept a UUID — §10).
//   - The session store still tracks "do we have a session" for the
//     first-turn-vs-resume dispatch, but the resume ARGUMENT is always
//     `latest`, not the stored id.
//
// The OLD geminiExecAdapter.test.js encoded the UNVERIFIED contract
// (`--resume <uuid>`, no `--session-id`); that file is corrected separately.
// This suite supersedes it on every point that diverges from §7/§10.

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { GeminiExecAdapter } from '../../src/runtime/GeminiExecAdapter.js';

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

const DETERMINISTIC_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UUID_SHAPE = /^[0-9a-f-]{36}$/;

function makeAdapter(child, opts = {}) {
  const store = opts.sessionStore ?? { get: () => null, set: () => {}, clear: () => {} };
  return new GeminiExecAdapter({
    runtimeId: 'r1',
    teamId: 't1',
    agentId: 'dev-1',
    cwd: '/work',
    systemPrompt: 'You are dev-1.',
    spawnImpl: (cmd, args, spawnOpts) => {
      makeAdapter._last = { cmd, args, opts: spawnOpts };
      return child;
    },
    resolveCliImpl: (n) => n,
    sessionStore: store,
    turnTimeoutMs: opts.turnTimeoutMs,
    uuidImpl: opts.uuidImpl,
  });
}

// ── (a) First-turn argv === §7 RATIFIED first-turn array, with --session-id <uuid> ──

test('first-turn argv === §7 RATIFIED array and carries --session-id <generated-uuid>', async () => {
  const child = fakeChild([
    JSON.stringify({ type: 'init', session_id: DETERMINISTIC_UUID, model: 'auto-gemini-3' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'ok', delta: true }),
    JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 5, output_tokens: 2 } }),
  ]);
  const adapter = makeAdapter(child, { uuidImpl: () => DETERMINISTIC_UUID });

  const res = await adapter.sendTurn({ message: { text: 'do the task' } });

  assert.equal(res.accepted, true);
  assert.equal(res.responseState, 'accepted_by_runtime');
  // §7 RATIFIED first-turn argv (governance posture: yolo + skip-trust per §7/spec §4)
  assert.deepEqual(makeAdapter._last.args, [
    '--output-format', 'stream-json',
    '--approval-mode', 'yolo',
    '--skip-trust',
    '--allowed-mcp-server-names', 'toad-local',
    '--session-id', DETERMINISTIC_UUID,
    '-p', 'Follow the instructions above.',
  ]);
  // first turn MUST NOT carry --resume
  assert.ok(!makeAdapter._last.args.includes('--resume'), 'first turn must not pass --resume');
  // systemPrompt is prepended on the first turn (stdin)
  assert.match(child.writes.join(''), /You are dev-1\.\n\ndo the task/);
  assert.equal(makeAdapter._last.opts.cwd, '/work');
});

test('first-turn --session-id value is a generated UUID-shaped string when no uuidImpl injected', async () => {
  const child = fakeChild([
    JSON.stringify({ type: 'init', session_id: 'whatever', model: 'm' }),
    JSON.stringify({ type: 'result', status: 'success', stats: {} }),
  ]);
  const adapter = makeAdapter(child); // default crypto.randomUUID

  await adapter.sendTurn({ message: { text: 'x' } });

  const args = makeAdapter._last.args;
  const idx = args.indexOf('--session-id');
  assert.ok(idx !== -1, '--session-id must be present on the first turn');
  const value = args[idx + 1];
  assert.equal(typeof value, 'string');
  assert.equal(value.length, 36, 'session-id must be a 36-char UUID');
  assert.match(value, UUID_SHAPE);
});

// ── (b) Resume turn argv === §7 RATIFIED resume array (--resume latest, NOT the uuid) ──

test('resume turn argv === §7 RATIFIED array; --resume value is literal "latest", never the stored uuid', async () => {
  const STORED_UUID = 'd7108a26-61db-4261-9865-549ab9d788e6';
  const child = fakeChild([
    JSON.stringify({ type: 'init', session_id: STORED_UUID }),
    JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 1, output_tokens: 1 } }),
  ]);
  const calls = [];
  const store = {
    get: () => STORED_UUID, // sessionStore says: we already have a session
    set: (...a) => calls.push(['set', ...a]),
    clear: (...a) => calls.push(['clear', ...a]),
  };
  const adapter = makeAdapter(child, { sessionStore: store });

  const res = await adapter.sendTurn({ message: { text: 'second turn' } });

  assert.equal(res.accepted, true);
  // §7 RATIFIED resume argv
  assert.deepEqual(makeAdapter._last.args, [
    '--output-format', 'stream-json',
    '--approval-mode', 'yolo',
    '--skip-trust',
    '--allowed-mcp-server-names', 'toad-local',
    '--resume', 'latest',
    '-p', 'Follow the instructions above.',
  ]);
  const args = makeAdapter._last.args;
  const ridx = args.indexOf('--resume');
  assert.equal(args[ridx + 1], 'latest', '--resume value must be the literal string "latest"');
  // THE KEY DEFECT guard: the stored UUID must NEVER be the --resume value
  assert.notEqual(args[ridx + 1], STORED_UUID, '--resume must NOT be the stored UUID (§10: --resume rejects a UUID)');
  assert.ok(!args.includes(STORED_UUID), 'the stored UUID must not appear anywhere in resume argv');
  // resume turn must NOT re-pass --session-id (that starts a NEW session)
  assert.ok(!args.includes('--session-id'), 'resume turn must not pass --session-id');
  // resume sends only the follow-up message (systemPrompt already on disk)
  assert.equal(child.writes.join(''), 'second turn');
});

// ── (c) sendTurn resolves on the grounded terminal event; events() surfaced stream ──

test('sendTurn resolves on result:success (normalized turn_completed); events() surfaced the normalized stream', async () => {
  const child = fakeChild([
    'Warning: True color (24-bit) support not detected.',
    'Ripgrep is not available. Falling back to GrepTool.',
    JSON.stringify({ type: 'init', session_id: DETERMINISTIC_UUID, model: 'auto-gemini-3' }),
    JSON.stringify({ type: 'message', role: 'user', content: 'do the task' }),
    JSON.stringify({ type: 'message', role: 'assistant', content: 'hi', delta: true }),
    JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 2, output_tokens: 1 } }),
  ]);
  const adapter = makeAdapter(child, { uuidImpl: () => DETERMINISTIC_UUID });
  const seen = [];
  const it = adapter.events()[Symbol.asyncIterator]();
  const pump = (async () => {
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      seen.push(next.value.type);
    }
  })();

  const res = await adapter.sendTurn({ message: { text: 'do the task' } });
  await adapter.stop();
  await pump;

  assert.equal(res.accepted, true);
  assert.equal(res.responseState, 'accepted_by_runtime');
  assert.ok(seen.includes('session_started'), 'events() must surface session_started from the normalizer');
  assert.ok(seen.includes('assistant_text'), 'events() must surface assistant_text from the normalizer');
  assert.ok(seen.includes('turn_completed'), 'events() must surface turn_completed from the normalizer');
});

// ── (d) session id captured from init/session_started is stored, NOT used as --resume ──

test('session id from init is stored (dispatch + confirmation) but is NOT the --resume value next turn', async () => {
  const ECHOED_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const first = fakeChild([
    JSON.stringify({ type: 'init', session_id: ECHOED_UUID, model: 'm' }),
    JSON.stringify({ type: 'result', status: 'success', stats: {} }),
  ]);
  const second = fakeChild([
    JSON.stringify({ type: 'init', session_id: ECHOED_UUID }),
    JSON.stringify({ type: 'result', status: 'success', stats: {} }),
  ]);
  const calls = [];
  let stored = null;
  const store = {
    get: () => stored,
    set: (rid, sid) => { stored = sid; calls.push(['set', rid, sid]); },
    clear: (rid) => { stored = null; calls.push(['clear', rid]); },
  };
  const children = [first, second];
  const adapter = new GeminiExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'dev-1', cwd: '/work', systemPrompt: 'You are dev-1.',
    spawnImpl: (_cmd, args) => { makeAdapter._last = { args }; return children.shift(); },
    resolveCliImpl: (n) => n,
    sessionStore: store,
    uuidImpl: () => ECHOED_UUID,
  });

  await adapter.sendTurn({ message: { text: 'first' } });
  // init.session_id captured into the store (confirmation + first-turn-vs-resume dispatch)
  assert.deepEqual(calls, [['set', 'r1', ECHOED_UUID]]);
  assert.equal(stored, ECHOED_UUID);

  await adapter.sendTurn({ message: { text: 'second' } });
  // second turn dispatched as a resume (store has a session) but the stored
  // UUID is NOT the --resume value
  const args = makeAdapter._last.args;
  const ridx = args.indexOf('--resume');
  assert.notEqual(ridx, -1, 'second turn must be a resume');
  assert.equal(args[ridx + 1], 'latest');
  assert.notEqual(args[ridx + 1], ECHOED_UUID);
  assert.ok(!args.includes(ECHOED_UUID), 'stored UUID must not be passed as a CLI argument on resume');
});

// ── (e) non-zero exit / timeout → turn_failed ────────────────────────────────

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
  assert.equal(res.responseState, 'turn_failed');
  assert.match(got.find((e) => e.type === 'turn_failed').error, /auth required/);
});

test('turn timeout → turn_failed', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write() {}, end() {}, writable: true };
  child.kill = function () { this.killed = true; this.emit('close', null); };
  const adapter = makeAdapter(child, { turnTimeoutMs: 20 });

  const res = await adapter.sendTurn({ message: { text: 'x' } });

  assert.equal(res.accepted, false);
  assert.equal(res.responseState, 'turn_failed');
});

// ── (f) BR1 pre-spawn-throw guard still restores _pendingTexts ───────────────
// Ported assertion shape from test/bundle/spawnThrowGuard.test.js.

test('BR1: a synchronous spawn throw does not lose the coalesced batch (_pendingTexts restored)', async () => {
  let spawnCalls = 0;
  const children = [];
  const adapter = new GeminiExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'dev-1', cwd: '/work', systemPrompt: 'sys',
    spawnImpl: () => {
      spawnCalls += 1;
      if (spawnCalls === 1) throw new Error('EAGAIN'); // sync pre-spawn failure
      const c = fakeChild([
        JSON.stringify({ type: 'init', session_id: DETERMINISTIC_UUID, model: 'm' }),
        JSON.stringify({ type: 'message', role: 'assistant', content: 'ok', delta: true }),
        JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 5, output_tokens: 2 } }),
      ]);
      children.push(c);
      return c;
    },
    resolveCliImpl: (n) => n,
    sessionStore: { get: () => null, set: () => {}, clear: () => {} },
    uuidImpl: () => DETERMINISTIC_UUID,
  });

  const pA = adapter.sendTurn({ message: { text: 'alpha' } });
  const pB = adapter.sendTurn({ message: { text: 'beta' } });
  pA.catch(() => {}); // first caller's turn rejects on the pre-spawn throw

  const [sA, sB] = await Promise.allSettled([pA, pB]);

  assert.ok(spawnCalls >= 2, `coalesced batch must be re-spawned after a pre-spawn throw, got spawnCalls=${spawnCalls}`);
  for (const s of [sA, sB]) {
    if (s.status === 'fulfilled') {
      assert.notEqual(s.value.responseState, 'coalesced',
        'a message in the discarded batch must NOT be reported as a coalesced success');
    }
  }
  assert.ok(children.length >= 1, 'a real turn must have run after the throw');
  assert.match(children[0].writes.join(''), /alpha[\s\S]*beta/,
    'the recovered turn must carry the full coalesced batch');
});
