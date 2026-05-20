import test from 'node:test';
import assert from 'node:assert/strict';
import { getExtractor, PROVIDER_KEYS } from '../src/runtime/contextUsage/extractorRegistry.js';

test('Claude/Anthropic aliases resolve to the Claude extractor', () => {
  const a = getExtractor('claude');
  const b = getExtractor('anthropic');
  assert.ok(a && typeof a.extractLatestUsage === 'function');
  assert.equal(a, b, 'claude and anthropic share one extractor');
});

test('unknown provider → null', () => {
  assert.equal(getExtractor('openai'), null);
  assert.equal(getExtractor(''), null);
  assert.equal(getExtractor(undefined), null);
});

test('PROVIDER_KEYS includes the implemented providers and is frozen', () => {
  for (const k of ['claude', 'anthropic']) {
    assert.ok(PROVIDER_KEYS.includes(k), `missing key ${k}`);
  }
  assert.throws(() => { PROVIDER_KEYS.push('foo'); }, /Cannot|read.?only|extensible/i);
});

test('inherited prototype keys return null (no prototype-pollution leak)', () => {
  // REGISTRY[providerId] would resolve __proto__/constructor as truthy
  // without an own-property guard, breaking the dispatcher's no-throw
  // contract downstream.
  assert.equal(getExtractor('__proto__'), null);
  assert.equal(getExtractor('constructor'), null);
  assert.equal(getExtractor('hasOwnProperty'), null);
  assert.equal(getExtractor('toString'), null);
});
