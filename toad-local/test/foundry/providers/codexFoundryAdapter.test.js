import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { CodexFoundryAdapter } from '../../../src/foundry/providers/CodexFoundryAdapter.js';

function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = {
    written: [],
    write(chunk) { this.written.push(String(chunk)); return true; },
    end() { this.ended = true; },
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => { child._kill = signal || 'SIGTERM'; child.emit('close', 0); };
  return child;
}

function makeFakeSpawn(children = []) {
  let idx = 0;
  const calls = [];
  const fn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = children[idx++] ?? makeFakeChild();
    return child;
  };
  fn.calls = calls;
  return fn;
}

const FAKE_INSTRUCTIONS_PATH = '/tmp/foundry-instructions.txt';

// Helper: simulate a typical successful turn from codex exec --json output.
function emitTurnSuccess(child, { threadId = 'thr-1', text = 'OK' } = {}) {
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: threadId }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.started' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'item.completed',
    item: { type: 'agent_message', text },
  }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'turn.completed',
    usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 },
  }) + '\n'));
}

test('CodexFoundryAdapter providerId is openai', () => {
  const adapter = new CodexFoundryAdapter({
    resolveCliImpl: (name) => name, // identity so test assertions on call.cmd stay platform-independent
    spawnImpl: makeFakeSpawn(),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'INSTRUCTIONS',
  });
  assert.equal(adapter.providerId, 'openai');
});

test('CodexFoundryAdapter.send first turn spawns codex exec --json with prepended instructions', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const adapter = new CodexFoundryAdapter({
    resolveCliImpl: (name) => name, // identity so test assertions on call.cmd stay platform-independent
    spawnImpl: spawn,
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj/x',
    readFileImpl: () => 'SYSTEM PROMPT BODY',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'hello world', cliSessionId: null });
  emitTurnSuccess(child, { threadId: 'thr-1', text: 'hi' });
  const result = await sendPromise;

  assert.equal(spawn.calls.length, 1);
  const call = spawn.calls[0];
  assert.equal(call.cmd, 'codex');
  // Prompt is sent via stdin (Codex's `-` sentinel) to dodge Windows
  // cmd.exe's ~8KB command-line cap — see CodexFoundryAdapter.js comments.
  assert.deepEqual(call.args, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '-C', '/proj/x',
    '-',
  ]);
  assert.deepEqual(child.stdin.written, ['SYSTEM PROMPT BODY\n\nhello world']);
  assert.equal(child.stdin.ended, true);
  assert.equal(result.text, 'hi');
  assert.equal(result.sessionUuid, 'thr-1');
});

test('CodexFoundryAdapter.send resume turn spawns codex exec resume without system prompt', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const adapter = new CodexFoundryAdapter({
    resolveCliImpl: (name) => name, // identity so test assertions on call.cmd stay platform-independent
    spawnImpl: spawn,
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj/x',
    readFileImpl: () => 'SYSTEM',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'follow-up', cliSessionId: 'thr-existing' });
  emitTurnSuccess(child, { threadId: 'thr-existing', text: 'response' });
  const result = await sendPromise;

  const call = spawn.calls[0];
  // Resume turn — only the new user message goes to stdin; the prior
  // conversation (system prompt + history) lives in Codex's session file.
  assert.deepEqual(call.args, [
    'exec',
    'resume',
    'thr-existing',
    '--json',
    '--skip-git-repo-check',
    '-C', '/proj/x',
    '-',
  ]);
  assert.deepEqual(child.stdin.written, ['follow-up']);
  assert.equal(child.stdin.ended, true);
  assert.equal(result.text, 'response');
  assert.equal(result.sessionUuid, 'thr-existing');
});

test('CodexFoundryAdapter concatenates multiple agent_message item.completed events', async () => {
  const child = makeFakeChild();
  const adapter = new CodexFoundryAdapter({
    resolveCliImpl: (name) => name, // identity so test assertions on call.cmd stay platform-independent
    spawnImpl: makeFakeSpawn([child]),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'go' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'part one ' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'part two' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));
  const result = await sendPromise;

  assert.equal(result.text, 'part one part two');
});

test('CodexFoundryAdapter ignores non-agent_message item.completed events', async () => {
  const child = makeFakeChild();
  const adapter = new CodexFoundryAdapter({
    resolveCliImpl: (name) => name, // identity so test assertions on call.cmd stay platform-independent
    spawnImpl: makeFakeSpawn([child]),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'go' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_reasoning', text: 'thinking...' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));
  const result = await sendPromise;

  assert.equal(result.text, 'answer');
});

test('CodexFoundryAdapter throws when turn.completed arrives without any agent_message', async () => {
  const child = makeFakeChild();
  const adapter = new CodexFoundryAdapter({
    resolveCliImpl: (name) => name, // identity so test assertions on call.cmd stay platform-independent
    spawnImpl: makeFakeSpawn([child]),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'go' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'thread.started', thread_id: 't' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'turn.completed' }) + '\n'));

  await assert.rejects(sendPromise, /no agent_message|missing.*message/i);
});

test('CodexFoundryAdapter skips non-JSON lines silently', async () => {
  const child = makeFakeChild();
  const adapter = new CodexFoundryAdapter({
    resolveCliImpl: (name) => name, // identity so test assertions on call.cmd stay platform-independent
    spawnImpl: makeFakeSpawn([child]),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'go' });
  child.stdout.emit('data', Buffer.from('this is a warning line, not JSON\n'));
  emitTurnSuccess(child, { threadId: 't', text: 'OK' });
  const result = await sendPromise;

  assert.equal(result.text, 'OK');
});

test('CodexFoundryAdapter.isAttached always returns false', () => {
  const adapter = new CodexFoundryAdapter({
    resolveCliImpl: (name) => name, // identity so test assertions on call.cmd stay platform-independent
    spawnImpl: makeFakeSpawn(),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });
  assert.equal(adapter.isAttached({ foundrySessionId: 'anything' }), false);
});

test('CodexFoundryAdapter.close and closeAll are no-ops', async () => {
  const adapter = new CodexFoundryAdapter({
    resolveCliImpl: (name) => name, // identity so test assertions on call.cmd stay platform-independent
    spawnImpl: makeFakeSpawn(),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });
  await adapter.close({ foundrySessionId: 's' });
  await adapter.closeAll();
  // No throw = pass.
});

test('CodexFoundryAdapter timeout kills the child and rejects', async () => {
  const child = makeFakeChild();
  const adapter = new CodexFoundryAdapter({
    resolveCliImpl: (name) => name, // identity so test assertions on call.cmd stay platform-independent
    spawnImpl: makeFakeSpawn([child]),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
    timeoutMs: 30,
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'go' });
  // Don't emit anything — let it time out.
  await assert.rejects(sendPromise, /timed out/i);
  assert.equal(child._kill, 'SIGTERM');
});

test('CodexFoundryAdapter rejects when child emits an ENOENT error (codex binary missing)', async () => {
  const child = makeFakeChild();
  const adapter = new CodexFoundryAdapter({
    resolveCliImpl: (name) => name, // identity so test assertions on call.cmd stay platform-independent
    spawnImpl: makeFakeSpawn([child]),
    instructionsPath: FAKE_INSTRUCTIONS_PATH,
    projectCwdResolver: () => '/proj',
    readFileImpl: () => 'SYSTEM',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'go' });
  // Simulate spawn-time failure (codex binary not on PATH).
  const enoent = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
  child.emit('error', enoent);

  await assert.rejects(sendPromise, /ENOENT|spawn codex/i);
});
