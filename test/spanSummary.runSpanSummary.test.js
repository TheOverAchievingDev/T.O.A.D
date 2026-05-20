import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runSpanSummary, SUMMARY_FAIL_REASONS } from '../src/runtime/spanSummary/index.js';

// A minimal fake child process: emits stdout then exits with `code`.
function fakeProc({ stdoutChunks = [], code = 0, emitError = null } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  proc.kill = () => {};
  setImmediate(() => {
    if (emitError) { proc.emit('error', emitError); return; }
    for (const c of stdoutChunks) proc.stdout.emit('data', Buffer.from(c));
    proc.emit('exit', code);
  });
  return proc;
}
const resolveOk = (cli) => `/usr/bin/${cli}`;
const noShell = () => false;

test('claude success → {ok:true,summaryText}, argv + stdin match the llmJudge inline shape', async () => {
  let seen;
  const spawnImpl = (cmd, args, opts) => { seen = { cmd, args, opts }; return fakeProc({ stdoutChunks: ['agent read a.js\n'] }); };
  const r = await runSpanSummary({
    systemPrompt: 'SYS', userPayload: 'PAY', cli: 'claude', model: 'haiku',
    spawnImpl, resolveCliImpl: resolveOk, needsShellImpl: noShell,
  });
  assert.deepEqual(r, { ok: true, summaryText: 'agent read a.js' });
  assert.equal(seen.cmd, '/usr/bin/claude');
  assert.deepEqual(seen.args, ['--model', 'haiku', '--print', '--setting-sources', 'project,local', '--tools', '']);
  assert.deepEqual(seen.opts.stdio, ['pipe', 'pipe', 'pipe']);
});

test('codex argv shape', async () => {
  let seen;
  const spawnImpl = (cmd, args) => { seen = args; return fakeProc({ stdoutChunks: ['done'] }); };
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'codex', model: 'gpt-5-codex', spawnImpl, resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.equal(r.ok, true);
  assert.deepEqual(seen, ['exec', '--model', 'gpt-5-codex', '-']);
});

test('gemini argv shape (combined positional, stdin ignored)', async () => {
  let seen;
  const spawnImpl = (cmd, args, opts) => { seen = { args, opts }; return fakeProc({ stdoutChunks: ['g'] }); };
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'gemini', model: 'gemini-2.5-flash', spawnImpl, resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.equal(r.ok, true);
  assert.deepEqual(seen.args, ['-m', 'gemini-2.5-flash', '-p', 'S\n\nP']);
  assert.deepEqual(seen.opts.stdio, ['ignore', 'pipe', 'pipe']);
});

test('non-zero exit → {ok:false,reason:spawn_failed}', async () => {
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', spawnImpl: () => fakeProc({ code: 1, stdoutChunks: ['err'] }), resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.deepEqual(r, { ok: false, reason: 'spawn_failed' });
});

test('proc error event → spawn_failed', async () => {
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', spawnImpl: () => fakeProc({ emitError: new Error('ENOENT') }), resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.deepEqual(r, { ok: false, reason: 'spawn_failed' });
});

test('spawn throws synchronously → spawn_failed (never throws)', async () => {
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', spawnImpl: () => { throw new Error('boom'); }, resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.deepEqual(r, { ok: false, reason: 'spawn_failed' });
});

test('timeout → {ok:false,reason:timeout} and SIGKILL fired', async () => {
  let killed = false;
  const spawnImpl = () => { const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.stdin = { write() {}, end() {} }; p.kill = () => { killed = true; }; return p; /* never exits */ };
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', timeoutMs: 10, spawnImpl, resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.deepEqual(r, { ok: false, reason: 'timeout' });
  assert.equal(killed, true);
});

test('late exit after timeout does not double-resolve (settled guard)', async () => {
  // kill() schedules a LATE exit emission — simulating the OS delivering
  // 'exit' after SIGKILL, AFTER the timeout already settled the Promise.
  let onExit = null;
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { write() {}, end() {} };
  proc.kill = () => { setImmediate(() => { if (onExit) onExit(0); }); };
  const orig = proc.on.bind(proc);
  proc.on = (ev, cb) => { if (ev === 'exit') onExit = cb; return orig(ev, cb); };

  let unhandled = null;
  const onUnhandled = (e) => { unhandled = e; };
  process.on('unhandledRejection', onUnhandled);
  try {
    const r = await runSpanSummary({
      systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku',
      timeoutMs: 5, spawnImpl: () => proc, resolveCliImpl: (c) => `/usr/bin/${c}`, needsShellImpl: () => false,
    });
    // Give the late kill()-scheduled exit a tick to fire post-settle.
    await new Promise((res) => setImmediate(res));
    assert.deepEqual(r, { ok: false, reason: 'timeout' });
    assert.equal(unhandled, null, 'no unhandled rejection / no double-resolve');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
  }
});

test('empty stdout → {ok:false,reason:empty_output}', async () => {
  const r = await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', spawnImpl: () => fakeProc({ stdoutChunks: ['   \n'] }), resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.deepEqual(r, { ok: false, reason: 'empty_output' });
});

test('unsupported cli / bad model / resolveCli throws → cli_unresolved (never throws)', async () => {
  assert.deepEqual(await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'opencode', model: 'x', spawnImpl: () => fakeProc(), resolveCliImpl: resolveOk, needsShellImpl: noShell }), { ok: false, reason: 'cli_unresolved' });
  assert.deepEqual(await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: '', spawnImpl: () => fakeProc(), resolveCliImpl: resolveOk, needsShellImpl: noShell }), { ok: false, reason: 'cli_unresolved' });
  assert.deepEqual(await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', spawnImpl: () => fakeProc(), resolveCliImpl: () => { throw new Error('x'); }, needsShellImpl: noShell }), { ok: false, reason: 'cli_unresolved' });
});

test('isolateHome+cwd scrubs CLAUDE_* (except BEDROCK/VERTEX) and sets HOME/USERPROFILE', async () => {
  process.env.CLAUDE_SCRATCH = 'leak';
  process.env.CLAUDE_CODE_USE_BEDROCK = 'keep';
  let opts;
  const spawnImpl = (c, a, o) => { opts = o; return fakeProc({ stdoutChunks: ['ok'] }); };
  await runSpanSummary({ systemPrompt: 'S', userPayload: 'P', cli: 'claude', model: 'haiku', cwd: '/tmp/iso', isolateHome: true, spawnImpl, resolveCliImpl: resolveOk, needsShellImpl: noShell });
  assert.equal(opts.cwd, '/tmp/iso');
  assert.equal(opts.env.HOME, '/tmp/iso');
  assert.equal(opts.env.USERPROFILE, '/tmp/iso');
  assert.equal(opts.env.CLAUDE_SCRATCH, undefined);
  assert.equal(opts.env.CLAUDE_CODE_USE_BEDROCK, 'keep');
  delete process.env.CLAUDE_SCRATCH; delete process.env.CLAUDE_CODE_USE_BEDROCK;
});

test('SUMMARY_FAIL_REASONS is the sealed set', () => {
  assert.deepEqual([...SUMMARY_FAIL_REASONS].sort(), ['cli_unresolved', 'empty_output', 'spawn_failed', 'timeout']);
});
