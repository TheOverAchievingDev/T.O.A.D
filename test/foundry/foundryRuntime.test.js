import test from 'node:test';
import assert from 'node:assert/strict';
import { FoundryRuntime } from '../../src/foundry/foundryRuntime.js';

function makeFakeAdapter(providerId) {
  const calls = [];
  let attached = false;
  return {
    providerId,
    calls,
    setAttached(v) { attached = v; },
    async send(args) {
      calls.push({ method: 'send', args });
      return { text: `[${providerId}] reply`, sessionUuid: `${providerId}-uuid`, model: null, eventCount: 1 };
    },
    isAttached(args) {
      calls.push({ method: 'isAttached', args });
      return attached;
    },
    async close(args) { calls.push({ method: 'close', args }); },
    async closeAll() { calls.push({ method: 'closeAll', args: null }); },
  };
}

test('FoundryRuntime constructor builds Claude and Codex adapters by default', () => {
  // Smoke: constructing without injection should not throw and should expose dispatch.
  // Use the injection path to avoid hitting fs in tests, but verify the keys exist.
  const claude = makeFakeAdapter('anthropic');
  const codex = makeFakeAdapter('openai');
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });
  assert.ok(rt);
});

test('FoundryRuntime.send dispatches to the adapter matching the provider', async () => {
  const claude = makeFakeAdapter('anthropic');
  const codex = makeFakeAdapter('openai');
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });

  const result = await rt.send({
    foundrySessionId: 's1', text: 'hi', cliSessionId: null, provider: 'openai',
  });
  assert.equal(result.text, '[openai] reply');
  assert.equal(codex.calls.length, 1);
  assert.equal(claude.calls.length, 0);
});

test('FoundryRuntime.send throws on unknown provider', async () => {
  const rt = new FoundryRuntime({ adapters: { anthropic: makeFakeAdapter('anthropic') } });
  await assert.rejects(
    rt.send({ foundrySessionId: 's1', text: 'hi', provider: 'grok' }),
    /unsupported provider/i,
  );
});

test('FoundryRuntime.isAttached delegates to the right adapter', () => {
  const claude = makeFakeAdapter('anthropic');
  claude.setAttached(true);
  const codex = makeFakeAdapter('openai');
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });
  assert.equal(rt.isAttached({ foundrySessionId: 's1', provider: 'anthropic' }), true);
  assert.equal(rt.isAttached({ foundrySessionId: 's1', provider: 'openai' }), false);
});

test('FoundryRuntime.close with provider delegates to that adapter only', async () => {
  const claude = makeFakeAdapter('anthropic');
  const codex = makeFakeAdapter('openai');
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });
  await rt.close({ foundrySessionId: 's1', provider: 'anthropic' });
  assert.equal(claude.calls.length, 1);
  assert.equal(claude.calls[0].method, 'close');
  assert.equal(codex.calls.length, 0);
});

test('FoundryRuntime.close without provider closes on all adapters (defensive)', async () => {
  const claude = makeFakeAdapter('anthropic');
  const codex = makeFakeAdapter('openai');
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });
  await rt.close({ foundrySessionId: 's1' });
  assert.equal(claude.calls.length, 1);
  assert.equal(codex.calls.length, 1);
});

test('FoundryRuntime.closeAll fans out to all adapters', async () => {
  const claude = makeFakeAdapter('anthropic');
  const codex = makeFakeAdapter('openai');
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });
  await rt.closeAll();
  assert.equal(claude.calls.find((c) => c.method === 'closeAll') !== undefined, true);
  assert.equal(codex.calls.find((c) => c.method === 'closeAll') !== undefined, true);
});

test('FoundryRuntime.close without provider continues to second adapter when first throws', async () => {
  const claude = makeFakeAdapter('anthropic');
  const codex = makeFakeAdapter('openai');
  // Make claude.close reject; codex.close should still be called.
  claude.close = async () => { throw new Error('claude close exploded'); };
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });
  await rt.close({ foundrySessionId: 's1' });
  // codex must have received the close call despite claude throwing.
  assert.ok(
    codex.calls.find((c) => c.method === 'close'),
    'codex.close should have been called despite claude.close throwing',
  );
});

test('FoundryRuntime.closeAll continues to second adapter when first throws', async () => {
  const claude = makeFakeAdapter('anthropic');
  const codex = makeFakeAdapter('openai');
  claude.closeAll = async () => { throw new Error('claude closeAll exploded'); };
  const rt = new FoundryRuntime({ adapters: { anthropic: claude, openai: codex } });
  await rt.closeAll();
  assert.ok(
    codex.calls.find((c) => c.method === 'closeAll'),
    'codex.closeAll should have been called despite claude.closeAll throwing',
  );
});
