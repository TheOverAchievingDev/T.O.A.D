import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSupervisor } from '../../src/runtime/RuntimeSupervisor.js';
import { RuntimeDirectory } from '../../src/delivery/runtimeDirectory.js';
import { createAdapterForProvider } from '../../src/runtime/adapterForProvider.js';
import { ClaudeStreamJsonAdapter } from '../../src/runtime/ClaudeStreamJsonAdapter.js';
import { EventEmitter } from 'node:events';

test('stopAgent drains a childless session adapter so its events() consumer terminates', async () => {
  const sup = new RuntimeSupervisor({ runtimeDirectory: new RuntimeDirectory(), createAdapter: createAdapterForProvider });
  sup.registerSessionAgent({ teamId: 't', agentId: 'dev-1', runtimeId: 'r-codex', command: 'codex', cwd: '/w', systemPrompt: 'p', providerId: 'openai' });
  const adapter = sup.getAdapter('r-codex');

  // Simulate the LocalToadRuntime pattern: a consumer parked on events().
  let done = false;
  const consumer = (async () => { for await (const _ of adapter.events()) { /* drain */ } done = true; })();

  await sup.stopAgent('r-codex');
  // The consumer MUST terminate (adapter.stop() drained the waiter).
  await Promise.race([consumer, new Promise((_, rej) => setTimeout(() => rej(new Error('events() consumer did NOT terminate after stopAgent — leak')), 1500))]);
  assert.equal(done, true);
});

test('stopAgent on a Claude (child, runtime_stdin) record does NOT call the throwing base stop()', async () => {
  // Build a Claude record via launchAgent with an injected fake child + the
  // provider-aware factory; stopAgent must NOT throw "stop() is not implemented".
  const sup = new RuntimeSupervisor({
    runtimeDirectory: new RuntimeDirectory(),
    createAdapter: createAdapterForProvider,
    spawnProcess: () => { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = Object.assign(new EventEmitter(), { setEncoding() {} }); c.stdin = { writable: true, write(){}, end(){} }; c.pid = 999; c.kill = () => {}; return c; },
  });
  await sup.launchAgent({ teamId: 't', agentId: 'lead', runtimeId: 'r-claude', command: 'claude', cwd: '/w' });
  const ad = sup.getAdapter('r-claude');
  assert.ok(ad instanceof ClaudeStreamJsonAdapter);
  await assert.doesNotReject(() => sup.stopAgent('r-claude')); // must NOT hit the throwing inherited stop()
});
