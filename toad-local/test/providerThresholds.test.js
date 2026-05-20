import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_COMPACTION_THRESHOLDS,
  DEFAULT_THRESHOLD,
  getProviderThreshold,
} from '../src/runtime/compactionTrigger/providerThresholds.js';

test('per-provider thresholds match memory-grounded values', () => {
  assert.equal(PROVIDER_COMPACTION_THRESHOLDS.claude.trigger, 0.65);
  assert.equal(PROVIDER_COMPACTION_THRESHOLDS.anthropic.trigger, 0.65);
  assert.equal(PROVIDER_COMPACTION_THRESHOLDS.codex.trigger, 0.70);
  assert.equal(PROVIDER_COMPACTION_THRESHOLDS.gemini.trigger, 0.60);
  assert.equal(PROVIDER_COMPACTION_THRESHOLDS.opencode.trigger, 0.70);
});

test('frozen — cannot mutate', () => {
  assert.throws(() => { PROVIDER_COMPACTION_THRESHOLDS.claude = {}; }, /Cannot|read.?only/i);
  assert.throws(() => { DEFAULT_THRESHOLD.trigger = 0.5; }, /Cannot|read.?only/i);
});

test('getProviderThreshold(known) → provider entry', () => {
  assert.equal(getProviderThreshold('claude').trigger, 0.65);
  assert.equal(getProviderThreshold('opencode').trigger, 0.70);
});

test('getProviderThreshold(unknown) → DEFAULT_THRESHOLD', () => {
  assert.equal(getProviderThreshold('openai'), DEFAULT_THRESHOLD);
  assert.equal(getProviderThreshold(''), DEFAULT_THRESHOLD);
  assert.equal(getProviderThreshold(undefined), DEFAULT_THRESHOLD);
});
