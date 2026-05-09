import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { FoundryRuntime } from '../../src/foundry/foundryRuntime.js';

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

test('FoundryRuntime.send spawns claude with the locked flag set on first call', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const rt = new FoundryRuntime({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const sendPromise = rt.send({ foundrySessionId: 's1', text: 'hello' });

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

test('FoundryRuntime.send rejects when subprocess crashes before assistant_message', async () => {
  const child = makeFakeChild();
  const spawn = makeFakeSpawn([child]);
  const rt = new FoundryRuntime({
    spawnImpl: spawn,
    instructionsPath: '/tmp/inst.txt',
  });

  const sendPromise = rt.send({ foundrySessionId: 's1', text: 'hello' });
  process.nextTick(() => child.emit('close', 1));

  await assert.rejects(sendPromise, /closed|crashed|exit/i);
});
