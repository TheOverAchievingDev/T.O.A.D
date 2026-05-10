/**
 * MIGRATED from test/foundry/foundryRuntime.test.js as part of F.2.
 * This file should retain bit-identical behavior assertions for the
 * Claude path. The dispatcher-level FoundryRuntime tests live in
 * test/foundry/foundryRuntime.test.js after F.2's rewrite.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ClaudeFoundryAdapter } from '../../../src/foundry/providers/ClaudeFoundryAdapter.js';

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

test('ClaudeFoundryAdapter.send spawns claude with the locked flag set on first call', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const adapter = new ClaudeFoundryAdapter({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'hello' });

  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'claude-uuid-1' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'world' }], model: 'claude-sonnet-4' },
  }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', subtype: 'success' }) + '\n'));

  const result = await sendPromise;

  assert.equal(spawn.calls.length, 1);
  const call = spawn.calls[0];
  assert.equal(call.cmd, 'claude');
  assert.ok(call.args.includes('--verbose'));
  assert.ok(call.args.includes('--input-format'));
  assert.ok(call.args.includes('stream-json'));
  assert.ok(call.args.includes('--output-format'));
  assert.ok(call.args.includes('--append-system-prompt-file'));
  assert.ok(call.args.includes('/tmp/inst.txt'));
  assert.ok(call.args.includes('--disallowedTools'));
  assert.ok(call.args.includes('*'));
  assert.ok(call.args.includes('--session-id'));

  assert.equal(child.stdin.written.length, 1);
  const written = JSON.parse(child.stdin.written[0]);
  assert.equal(written.type, 'user');
  assert.equal(written.message.content[0].text, 'hello');

  assert.equal(result.text, 'world');
  assert.equal(result.sessionUuid, 'claude-uuid-1');
  assert.equal(result.model, 'claude-sonnet-4');
});

test('ClaudeFoundryAdapter.send rejects when subprocess crashes before assistant_message', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const adapter = new ClaudeFoundryAdapter({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const sendPromise = adapter.send({ foundrySessionId: 's1', text: 'hello' });
  process.nextTick(() => child.emit('close', 1));

  await assert.rejects(sendPromise, /closed|crashed|exit/i);
});

// ── Task 5: registry reuse ──────────────────────────────────────────────────

test('ClaudeFoundryAdapter.send reuses the existing process for the same foundrySessionId', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const adapter = new ClaudeFoundryAdapter({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const turn1 = adapter.send({ foundrySessionId: 's1', text: 'first' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'uuid-1' }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r1' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn1;

  const turn2 = adapter.send({ foundrySessionId: 's1', text: 'second' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r2' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn2;

  assert.equal(spawn.calls.length, 1, 'should NOT re-spawn for same session');
  assert.equal(child.stdin.written.length, 2, 'should write each turn separately');
});

test('ClaudeFoundryAdapter.send spawns separate processes for different foundrySessionIds', async () => {
  const child1 = makeFakeChild();
  const child2 = makeFakeChild();
  const spawn = makeFakeSpawn([child1, child2]);
  const adapter = new ClaudeFoundryAdapter({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const turn1 = adapter.send({ foundrySessionId: 's1', text: 'a' });
  child1.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'uuid-a' }) + '\n'));
  child1.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a-resp' }], model: 'm' } }) + '\n'));
  child1.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn1;

  const turn2 = adapter.send({ foundrySessionId: 's2', text: 'b' });
  child2.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'uuid-b' }) + '\n'));
  child2.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'b-resp' }], model: 'm' } }) + '\n'));
  child2.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn2;

  assert.equal(spawn.calls.length, 2);
});

test('ClaudeFoundryAdapter.isAttached reflects registry state', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const adapter = new ClaudeFoundryAdapter({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  assert.equal(adapter.isAttached({ foundrySessionId: 's1' }), false);
  const turn = adapter.send({ foundrySessionId: 's1', text: 'x' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn;
  assert.equal(adapter.isAttached({ foundrySessionId: 's1' }), true);
});

// ── Task 6: close + closeAll + auto-cleanup on crash ───────────────────────

test('ClaudeFoundryAdapter.close kills the subprocess and removes it from the registry', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const adapter = new ClaudeFoundryAdapter({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const turn = adapter.send({ foundrySessionId: 's1', text: 'x' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn;

  await adapter.close({ foundrySessionId: 's1' });
  assert.equal(child._kill, 'SIGTERM');
  assert.equal(adapter.isAttached({ foundrySessionId: 's1' }), false);
});

test('ClaudeFoundryAdapter.close is idempotent (safe to call when no process exists)', async () => {
  const adapter = new ClaudeFoundryAdapter({
    spawnImpl: makeFakeSpawn(),
    instructionsPath: '/tmp/inst.txt',
  });
  await adapter.close({ foundrySessionId: 'never-spawned' });
  assert.equal(adapter.isAttached({ foundrySessionId: 'never-spawned' }), false);
});

test('ClaudeFoundryAdapter.closeAll kills every live subprocess', async () => {
  const child1 = makeFakeChild();
  const child2 = makeFakeChild();
  const spawn = makeFakeSpawn([child1, child2]);
  const adapter = new ClaudeFoundryAdapter({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const t1 = adapter.send({ foundrySessionId: 's1', text: 'x' });
  child1.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child1.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await t1;

  const t2 = adapter.send({ foundrySessionId: 's2', text: 'y' });
  child2.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child2.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await t2;

  await adapter.closeAll();
  assert.equal(child1._kill, 'SIGTERM');
  assert.equal(child2._kill, 'SIGTERM');
  assert.equal(adapter.isAttached({ foundrySessionId: 's1' }), false);
  assert.equal(adapter.isAttached({ foundrySessionId: 's2' }), false);
});

test('ClaudeFoundryAdapter.send removes registry entry when subprocess closes unexpectedly', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const adapter = new ClaudeFoundryAdapter({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const turn = adapter.send({ foundrySessionId: 's1', text: 'x' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn;

  child.emit('close', 1);

  assert.equal(adapter.isAttached({ foundrySessionId: 's1' }), false);
});

// ── Task 7: --resume recovery ──────────────────────────────────────────────

test('ClaudeFoundryAdapter.send with cliSessionId spawns claude with --resume', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const adapter = new ClaudeFoundryAdapter({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const turn = adapter.send({ foundrySessionId: 's1', text: 'x', cliSessionId: 'recovered-uuid' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn;

  const args = spawn.calls[0].args;
  assert.ok(args.includes('--resume'));
  const resumeIdx = args.indexOf('--resume');
  assert.equal(args[resumeIdx + 1], 'recovered-uuid');
  assert.ok(args.includes('--session-id'));
  const sessionIdIdx = args.indexOf('--session-id');
  assert.equal(args[sessionIdIdx + 1], 'recovered-uuid');
});

test('ClaudeFoundryAdapter.send without cliSessionId does NOT pass --resume', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const adapter = new ClaudeFoundryAdapter({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const turn = adapter.send({ foundrySessionId: 's1', text: 'x' });
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'r' }], model: 'm' } }) + '\n'));
  child.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result' }) + '\n'));
  await turn;

  assert.equal(spawn.calls[0].args.includes('--resume'), false);
});
