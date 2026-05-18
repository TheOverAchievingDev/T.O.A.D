import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createAdapterForProvider } from '../../src/runtime/adapterForProvider.js';
import { ClaudeStreamJsonAdapter } from '../../src/runtime/ClaudeStreamJsonAdapter.js';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';
import { GeminiExecAdapter } from '../../src/runtime/GeminiExecAdapter.js';
import { OpencodeExecAdapter } from '../../src/runtime/OpencodeExecAdapter.js';
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
  // ClaudeStreamJsonAdapter sets providerId='claude' via super('claude') (not 'anthropic');
  // and its ctor requires a real child, so fakeChild() is used above — both differ from the
  // plan draft on purpose. Intent: the Claude branch never receives sessionStore.
  assert.equal(claude.providerId, 'claude');
  assert.equal(claude.sessionStore, undefined);
});

test('gemini routes to GeminiExecAdapter (no child needed)', () => {
  const a = createAdapterForProvider({ runtimeId: 'r', teamId: 't', agentId: 'a', child: null, providerId: 'gemini', cwd: '/w', systemPrompt: 'p' });
  assert.ok(a instanceof GeminiExecAdapter);
  assert.equal(a.providerId, 'gemini');
});

test('opencode routes to OpencodeExecAdapter and keeps model args', () => {
  const a = createAdapterForProvider({
    runtimeId: 'r',
    teamId: 't',
    agentId: 'a',
    child: null,
    providerId: 'opencode',
    cwd: '/w',
    systemPrompt: 'p',
    args: ['--model', 'deepseek/deepseek-v4'],
  });
  assert.ok(a instanceof OpencodeExecAdapter);
  assert.equal(a.providerId, 'opencode');
  assert.deepEqual(a.args, ['--model', 'deepseek/deepseek-v4']);
});
