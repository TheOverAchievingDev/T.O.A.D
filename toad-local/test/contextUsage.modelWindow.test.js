import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_CONTEXT_WINDOW, resolveContextWindow } from '../src/runtime/contextUsage/modelContextWindow.js';

test('known Claude models resolve to their window', () => {
  assert.equal(resolveContextWindow('claude-sonnet-4-20250514'), 200_000);
  assert.equal(resolveContextWindow('claude-3-5-haiku-20241022'), 200_000);
  assert.equal(resolveContextWindow('claude-opus-4-1m'), 1_000_000);
});
test('prefix match: a versioned model id resolves via its family prefix', () => {
  assert.equal(resolveContextWindow('claude-sonnet-4-5-20990101'), 200_000);
});
test('unknown / empty / non-string model → null (honest, never guess a denominator)', () => {
  assert.equal(resolveContextWindow('gpt-some-future'), null);
  assert.equal(resolveContextWindow(''), null);
  assert.equal(resolveContextWindow(null), null);
  assert.equal(resolveContextWindow(undefined), null);
});
test('MODEL_CONTEXT_WINDOW is frozen (single source of truth, not mutable)', () => {
  assert.throws(() => { MODEL_CONTEXT_WINDOW['x'] = 1; }, TypeError);
});
