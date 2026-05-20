/**
 * BR4 — Important A2 (bundle whole-impl review): registerSessionAgent
 * re-derived the provider from `command` only (`providerForCommand(command)
 * || 'openai'`), discarding the authoritative `input.providerId`. A launch
 * with providerId:'gemini' but a NON-canonical command (operator custom
 * binary / full path) → providerForCommand → null → 'openai' → builds a
 * CodexExecAdapter that spawns `codex` instead of Gemini. Same class as the
 * 2026-05-15 wrong-binary bug; the launch dispatch was hardened to be
 * providerId-first but that authority was dropped at adapter construction.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeSupervisor } from '../../src/runtime/RuntimeSupervisor.js';
import { RuntimeDirectory } from '../../src/delivery/runtimeDirectory.js';
import { createAdapterForProvider } from '../../src/runtime/adapterForProvider.js';
import { GeminiExecAdapter } from '../../src/runtime/GeminiExecAdapter.js';
import { OpencodeExecAdapter } from '../../src/runtime/OpencodeExecAdapter.js';
import { CodexExecAdapter } from '../../src/runtime/CodexExecAdapter.js';

function sup() {
  return new RuntimeSupervisor({ runtimeDirectory: new RuntimeDirectory(), createAdapter: createAdapterForProvider });
}

test('authoritative providerId wins over a non-canonical command (gemini)', () => {
  const s = sup();
  s.registerSessionAgent({
    teamId: 't', agentId: 'dev-1', runtimeId: 'r-g',
    command: '/opt/custom/my-gemini-wrapper', // non-canonical → providerForCommand → null
    cwd: '/w', systemPrompt: 'p', providerId: 'gemini',
  });
  assert.ok(s.getAdapter('r-g') instanceof GeminiExecAdapter,
    'providerId:gemini + non-canonical command must build GeminiExecAdapter, not CodexExecAdapter');
});

test('authoritative providerId wins over a non-canonical command (opencode)', () => {
  const s = sup();
  s.registerSessionAgent({
    teamId: 't', agentId: 'dev-2', runtimeId: 'r-o',
    command: 'C:\\tools\\oc.exe', cwd: '/w', systemPrompt: 'p', providerId: 'opencode',
  });
  assert.ok(s.getAdapter('r-o') instanceof OpencodeExecAdapter,
    'providerId:opencode + non-canonical command must build OpencodeExecAdapter');
});

test('no providerId + canonical command still command-derives (unchanged residual)', () => {
  const s = sup();
  s.registerSessionAgent({
    teamId: 't', agentId: 'dev-3', runtimeId: 'r-c',
    command: 'codex', cwd: '/w', systemPrompt: 'p',
  });
  assert.ok(s.getAdapter('r-c') instanceof CodexExecAdapter,
    'no providerId + canonical codex command still resolves to CodexExecAdapter');
});
