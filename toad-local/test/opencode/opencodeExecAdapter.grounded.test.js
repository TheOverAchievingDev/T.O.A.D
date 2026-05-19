/**
 * SP1c Task 4 — GROUNDED adapter contract for opencode 1.15.4.
 *
 * Grounding doc 2026-05-18-opencode-cli.md §2/§7/§9/§10 RATIFIED (verbatim
 * 1-turn DeepSeek capture). The PRE-Task-4 adapter wrote the prompt to
 * child.stdin and passed NO positional message — grounding proved that is
 * WRONG: `opencode run "<message>" --format json ...` works as a CONFIRMED
 * positional arg, NOT stdin. This locks:
 *   (a) first-turn argv === §7 RATIFIED, message is a POSITIONAL (no stdin)
 *   (b) resume argv === §7 RATIFIED resume (['--session','<ses_*>'] + message)
 *   (c) sendTurn resolves on step_finish→turn_completed; events() surfaced
 *   (d) top-level `sessionID` from line-1 step_start is captured and drives
 *       turn-2 `--session`
 *   (e) non-zero exit / timeout → turn_failed
 *   (f) BR1 pre-spawn-throw _pendingTexts restore intact (ported assertion)
 *   (g) BR5 shell-metachar --model value still dropped
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { OpencodeExecAdapter } from '../../src/runtime/OpencodeExecAdapter.js';

// Grounded NDJSON shapes — §8 verbatim envelope {type,sessionID,part}.
function groundedLines(ses = 'ses_1c2b157c3ffesws2xivZl0UA5M', text = 'ok \u27E6TOAD_MCP_OK\u27E7') {
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
  // If the adapter never touches stdin at all (grounded positional path), we
  // still must emit the scripted stream. Drive it from spawn instead.
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
      // Grounded path delivers the prompt as a positional arg and never
      // writes stdin, so the scripted stream must be driven from spawn.
      child.__drive();
      return child;
    },
    resolveCliImpl: (n) => n,
    sessionStore: store,
    turnTimeoutMs: opts.turnTimeoutMs,
  });
}

test('(a) first-turn argv is §7 RATIFIED and the message is a POSITIONAL, not stdin', async () => {
  const child = fakeChild(groundedLines());
  const adapter = makeAdapter(child, { args: ['--model', 'deepseek/deepseek-chat'] });

  const res = await adapter.sendTurn({ message: { text: 'do the task' } });

  assert.equal(res.accepted, true);
  assert.equal(res.responseState, 'accepted_by_runtime');
  // §7 RATIFIED first-turn: run --format json --dangerously-skip-permissions
  // ...modelArgs <message-as-positional>. NO --session. NO stdin write.
  assert.ok(makeAdapter._last.args.includes('--model'), 'args must include --model');
  assert.ok(makeAdapter._last.args.includes('deepseek/deepseek-chat'), 'args must include model value');
  assert.ok(makeAdapter._last.args.includes('run'), 'args must include run subcommand');
  // Message is the final positional element and includes the probe instruction.
  assert.ok(
    makeAdapter._last.args[makeAdapter._last.args.length - 1].startsWith('You are dev-1.\n\ndo the task'),
  );
  // The prompt must NOT have been written to child.stdin (grounded defect fix).
  assert.equal(child.writes.join(''), '', 'prompt must NOT be written to child.stdin');
});

test('(b)(d) resume turn argv is §7 RATIFIED resume; captured top-level sessionID drives --session', async () => {
  // Turn 1 captures the ses_* id from the line-1 step_start top-level sessionID.
  let stored = null;
  const store = {
    get: () => stored,
    set: (_rt, id) => { stored = id; },
    clear: () => { stored = null; },
  };

  const child1 = fakeChild(groundedLines('ses_FROMSTREAM01'));
  const a1 = makeAdapter(child1, { sessionStore: store, args: ['--model', 'deepseek/deepseek-chat'] });
  await a1.sendTurn({ message: { text: 'first' } });
  assert.equal(stored, 'ses_FROMSTREAM01', 'line-1 step_start top-level sessionID captured to sessionStore');

  // Turn 2: sessionStore now has the captured id → §7 RATIFIED resume argv.
  const child2 = fakeChild(groundedLines('ses_FROMSTREAM01'));
  const a2 = makeAdapter(child2, { sessionStore: store, args: ['--model', 'deepseek/deepseek-chat'] });
  const res2 = await a2.sendTurn({ message: { text: 'second turn' } });

  assert.equal(res2.accepted, true);
  assert.deepEqual(makeAdapter._last.args, [
    'run',
    '--format', 'json',
    '--dangerously-skip-permissions',
    '--session', 'ses_FROMSTREAM01',
    '--model', 'deepseek/deepseek-chat',
    'second turn',
  ]);
  assert.equal(
    makeAdapter._last.args[makeAdapter._last.args.length - 1],
    'second turn',
    'resume message is the final positional arg, no systemPrompt prefix on resume',
  );
  assert.equal(child2.writes.join(''), '', 'resume prompt must NOT be written to child.stdin');
});

test('(c) sendTurn resolves on grounded step_finish→turn_completed and events() surfaced the normalized stream', async () => {
  const child = fakeChild(groundedLines('ses_X', 'hello world \u27E6TOAD_MCP_OK\u27E7'));
  const adapter = makeAdapter(child);
  const seen = [];
  const it = adapter.events()[Symbol.asyncIterator]();
  const pump = (async () => {
    for (;;) {
      const next = await it.next();
      if (next.done) break;
      seen.push(next.value);
    }
  })();

  const res = await adapter.sendTurn({ message: { text: 'x' } });
  await adapter.stop();
  await pump;

  assert.equal(res.accepted, true);
  assert.equal(res.responseState, 'accepted_by_runtime');
  const types = seen.map((e) => e.type);
  assert.ok(types.includes('session_started'), 'session_started surfaced');
  assert.ok(types.includes('assistant_text'), 'assistant_text surfaced');
  assert.ok(types.includes('turn_completed'), 'turn_completed surfaced');
  const at = seen.find((e) => e.type === 'assistant_text');
  assert.ok(at.text.includes('hello world'));
});

test('(e) non-zero exit → turn_failed with stderr', async () => {
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

test('(e) timeout → turn_failed', async () => {
  // A hung turn: only the line-1 step_start arrives, NO terminal step_finish,
  // and the process never exits on its own. The adapter's timeout timer must
  // SIGTERM the child; the fake emits close on kill so the failure resolves.
  const onlyStepStart = [
    JSON.stringify({ type: 'step_start', timestamp: 1, sessionID: 'ses_HANG', part: { type: 'step-start' } }),
  ];
  const child = fakeChild(onlyStepStart, { emitClose: false });
  child.kill = () => { child.killed = true; child.emit('close', null); };
  const adapter = makeAdapter(child, { turnTimeoutMs: 20 });

  const res = await adapter.sendTurn({ message: { text: 'x' } });

  assert.equal(res.accepted, false);
  assert.equal(res.responseState, 'turn_failed');
  assert.match(res.__failError || '', /timeout/);
});

test('(f) BR1: a synchronous pre-spawn throw does NOT lose the coalesced batch', async () => {
  let spawnCalls = 0;
  const children = [];
  const adapter = new OpencodeExecAdapter({
    runtimeId: 'r1', teamId: 't1', agentId: 'dev-1', cwd: '/work', systemPrompt: 'sys',
    spawnImpl: (_cmd, args) => {
      spawnCalls += 1;
      if (spawnCalls === 1) throw new Error('EAGAIN'); // sync pre-spawn failure
      const c = fakeChild(groundedLines());
      c.__spawnArgs = args;
      children.push(c);
      c.__drive();
      return c;
    },
    resolveCliImpl: (n) => n,
    sessionStore: { get: () => null, set: () => {}, clear: () => {} },
  });

  const pA = adapter.sendTurn({ message: { text: 'alpha' } });
  const pB = adapter.sendTurn({ message: { text: 'beta' } });
  pA.catch(() => {});

  const [sA, sB] = await Promise.allSettled([pA, pB]);

  assert.ok(spawnCalls >= 2, `coalesced batch must be re-spawned after a pre-spawn throw, got ${spawnCalls}`);
  for (const s of [sA, sB]) {
    if (s.status === 'fulfilled') {
      assert.notEqual(s.value.responseState, 'coalesced',
        'a message in the discarded batch must NOT be reported as a coalesced success');
    }
  }
  assert.ok(children.length >= 1, 'a real turn must have run after the throw');
  // Grounded: the recovered batch lands in the POSITIONAL message argv (not stdin).
  const argv = children[0].__spawnArgs.join('');
  assert.match(argv, /alpha[\s\S]*beta/,
    'the recovered turn must carry the full coalesced batch in its positional message arg');
  assert.equal(children[0].writes.join(''), '', 'recovered turn must NOT write the prompt to stdin');
});

test('(g) BR5: a shell-metachar --model value is still dropped from the allowlist', () => {
  const a = new OpencodeExecAdapter({
    runtimeId: 'r', teamId: 't', agentId: 'a', cwd: '/w', systemPrompt: 'p',
    args: ['--model', 'x" & calc.exe'],
    spawnImpl: () => { throw new Error('not spawned'); },
    resolveCliImpl: (n) => n,
    sessionStore: { get: () => null, set: () => {}, clear: () => {} },
  });
  assert.deepEqual(a.args, [], 'shell-metachar --model value dropped before reaching argv');
});
