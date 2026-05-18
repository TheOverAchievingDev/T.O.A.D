import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAdapterForProvider } from '../../src/runtime/adapterForProvider.js';
import { ClaudeStreamJsonAdapter } from '../../src/runtime/ClaudeStreamJsonAdapter.js';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';
import { RuntimeSupervisor } from '../../src/runtime/RuntimeSupervisor.js';

function fakeChild() { const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stdin = { writable: true }; return c; }

test('openai → CodexExecAdapter (no child needed)', () => {
  const a = createAdapterForProvider({ runtimeId: 'r', teamId: 't', agentId: 'a', child: null, providerId: 'openai', cwd: '/w', systemPrompt: 'p' });
  assert.ok(a instanceof CodexExecAdapter);
  assert.equal(a.providerId, 'openai');
});

test('anthropic (and default) → ClaudeStreamJsonAdapter with child', () => {
  const a = createAdapterForProvider({ runtimeId: 'r', teamId: 't', agentId: 'a', child: fakeChild(), providerId: 'anthropic' });
  assert.ok(a instanceof ClaudeStreamJsonAdapter);
  const d = createAdapterForProvider({ runtimeId: 'r', teamId: 't', agentId: 'a', child: fakeChild() });
  assert.ok(d instanceof ClaudeStreamJsonAdapter);
});

test('registerSessionAgent creates a childless running record visible to listRuntimes', () => {
  const directory = { registerAgent() {}, unregisterAgent() {} };
  const sup = new RuntimeSupervisor({ runtimeDirectory: directory, createAdapter: createAdapterForProvider });
  const snap = sup.registerSessionAgent({
    teamId: 't', agentId: 'a', runtimeId: 'r-codex', command: 'codex', cwd: '/w', systemPrompt: 'p', providerId: 'openai',
  });
  assert.equal(snap.runtimeId, 'r-codex');
  assert.equal(snap.status, 'running');
  const ad = sup.getAdapter('r-codex');
  assert.ok(ad instanceof CodexExecAdapter);
  assert.ok(sup.listRuntimes().some((r) => r.runtimeId === 'r-codex'));
});

test('createAdapterForProvider threads sessionStore + turnTimeoutMs into the Codex adapter; Claude branch ignores them', async () => {
  const { createAdapterForProvider } = await import('../../src/runtime/adapterForProvider.js');
  const sessionStore = { get: () => null, set: () => {}, clear: () => {} };
  const codex = createAdapterForProvider({
    runtimeId: 'r1', teamId: 't1', agentId: 'a1', providerId: 'openai',
    cwd: '/w', systemPrompt: 'sp', sessionStore, turnTimeoutMs: 1234,
  });
  assert.equal(codex.providerId, 'openai');
  assert.equal(codex.sessionStore, sessionStore);
  assert.equal(codex.turnTimeoutMs, 1234);
  const claude = createAdapterForProvider({
    runtimeId: 'r2', teamId: 't1', agentId: 'lead', providerId: 'anthropic',
    child: fakeChild(), sessionStore, turnTimeoutMs: 1234,
  });
  assert.equal(claude.providerId, 'claude');
  assert.equal(claude.sessionStore, undefined);
});
