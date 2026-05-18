import test from 'node:test';
import assert from 'node:assert/strict';
import { listProviderModels } from '../src/providers/providerModels.js';

function spawnOk(stdout) {
  return () => ({ status: 0, stdout, stderr: '', error: null });
}

test('listProviderModels(opencode) returns free models plus authenticated provider models', () => {
  const result = listProviderModels({
    providerId: 'opencode',
    spawnSyncImpl: spawnOk([
      'opencode/big-pickle',
      'opencode/deepseek-v4-flash-free',
      'opencode/minimax-m2.5-free',
      'deepseek/deepseek-v4-pro',
      'google/gemini-3.1-pro-preview',
      'anthropic/claude-sonnet-4-5',
    ].join('\n')),
    readFileImpl: () => JSON.stringify({ deepseek: { type: 'api' }, google: { type: 'api' } }),
    statImpl: () => ({ isFile: () => true }),
  });

  assert.equal(result.providerId, 'opencode');
  assert.deepEqual(result.authenticatedProviders.sort(), ['deepseek', 'google']);
  assert.deepEqual(result.models.map((m) => m.id), [
    'opencode/big-pickle',
    'opencode/deepseek-v4-flash-free',
    'opencode/minimax-m2.5-free',
    'opencode/nemotron-3-super-free',
    'opencode/qwen3.6-plus-free',
    'deepseek/deepseek-v4-pro',
    'google/gemini-3.1-pro-preview',
  ]);
  assert.equal(result.models.find((m) => m.id === 'opencode/deepseek-v4-flash-free')?.free, true);
  assert.equal(result.models.find((m) => m.id === 'deepseek/deepseek-v4-pro')?.authenticated, true);
});

test('listProviderModels(opencode) falls back to known free models when CLI is unavailable', () => {
  const result = listProviderModels({
    providerId: 'opencode',
    spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'missing', error: null }),
    readFileImpl: () => JSON.stringify({}),
    statImpl: () => ({ isFile: () => true }),
  });

  assert.equal(result.providerId, 'opencode');
  assert.ok(result.models.some((m) => m.id === 'opencode/big-pickle'));
  assert.ok(result.models.some((m) => m.id === 'opencode/deepseek-v4-flash-free'));
  assert.equal(result.degraded, true);
  assert.match(result.reason, /opencode models/i);
});

test('listProviderModels rejects unsupported dynamic providers', () => {
  const result = listProviderModels({ providerId: 'anthropic', spawnSyncImpl: spawnOk('') });

  assert.equal(result.providerId, 'anthropic');
  assert.equal(result.supported, false);
});
