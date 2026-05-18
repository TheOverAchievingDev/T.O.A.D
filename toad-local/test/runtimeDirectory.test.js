import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeDirectory } from '../src/delivery/runtimeDirectory.js';
import { RuntimeSupervisor } from '../src/runtime/RuntimeSupervisor.js';
import { createAdapterForProvider } from '../src/runtime/adapterForProvider.js';

test('RuntimeDirectory accepts session_turn and resolve() returns it', () => {
  const dir = new RuntimeDirectory();
  dir.registerAgent({ teamId: 't', agentId: 'dev-1', runtimeId: 'r1', deliveryMode: 'session_turn' });
  const r = dir.resolve({ kind: 'agent', teamId: 't', agentId: 'dev-1' });
  assert.equal(r.runtimeId, 'r1');
  assert.equal(r.deliveryMode, 'session_turn');
  assert.ok(dir.listAgents().some((a) => a.agentId === 'dev-1' && a.deliveryMode === 'session_turn'));
});

test('RuntimeDirectory still rejects a genuinely unsupported delivery mode', () => {
  const dir = new RuntimeDirectory();
  assert.throws(
    () => dir.registerAgent({ teamId: 't', agentId: 'x', runtimeId: 'r', deliveryMode: 'totally_bogus' }),
    /unsupported delivery mode: totally_bogus/,
  );
});

test('RuntimeSupervisor.registerSessionAgent works against a REAL RuntimeDirectory (the coverage the stub masked)', () => {
  const sup = new RuntimeSupervisor({ runtimeDirectory: new RuntimeDirectory(), createAdapter: createAdapterForProvider });
  const snap = sup.registerSessionAgent({
    teamId: 't', agentId: 'dev-1', runtimeId: 'r-codex', command: 'codex',
    cwd: '/w', systemPrompt: 'p', providerId: 'openai',
  });
  assert.equal(snap.runtimeId, 'r-codex');
  assert.equal(snap.status, 'running');
  assert.ok(sup.listRuntimes().some((x) => x.runtimeId === 'r-codex'));
});
