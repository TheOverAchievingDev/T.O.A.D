import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSummaryRoute, SUMMARY_PROVIDER_MAP } from '../src/runtime/spanSummary/index.js';

test('banked heuristic: pref [gemini,openai,anthropic] minus lead', () => {
  assert.deepEqual(resolveSummaryRoute({ leadProviderId: 'anthropic' }), { providerId: 'gemini', cli: 'gemini', model: 'gemini-2.5-flash' });
  assert.deepEqual(resolveSummaryRoute({ leadProviderId: 'openai' }), { providerId: 'gemini', cli: 'gemini', model: 'gemini-2.5-flash' });
  assert.deepEqual(resolveSummaryRoute({ leadProviderId: 'gemini' }), { providerId: 'openai', cli: 'codex', model: 'gpt-5-codex' });
});

test('unknown / absent lead is treated as anthropic → gemini', () => {
  assert.equal(resolveSummaryRoute({ leadProviderId: 'mystery' }).providerId, 'gemini');
  assert.equal(resolveSummaryRoute({ leadProviderId: null }).providerId, 'gemini');
  assert.equal(resolveSummaryRoute({}).providerId, 'gemini');
  assert.equal(resolveSummaryRoute().providerId, 'gemini');
});

test('settings.summarizer.providerId overrides the provider entirely', () => {
  const r = resolveSummaryRoute({ leadProviderId: 'anthropic', settings: { summarizer: { providerId: 'openai' } } });
  assert.deepEqual(r, { providerId: 'openai', cli: 'codex', model: 'gpt-5-codex' });
});

test('an unknown settings.summarizer.providerId is ignored (falls back to heuristic)', () => {
  const r = resolveSummaryRoute({ leadProviderId: 'gemini', settings: { summarizer: { providerId: 'nope' } } });
  assert.equal(r.providerId, 'openai');
});

test('settings.summarizer.model overrides only the model', () => {
  const r = resolveSummaryRoute({ leadProviderId: 'anthropic', settings: { summarizer: { model: 'gemini-2.5-pro' } } });
  assert.deepEqual(r, { providerId: 'gemini', cli: 'gemini', model: 'gemini-2.5-pro' });
});

test('SUMMARY_PROVIDER_MAP is the frozen tier1 map', () => {
  assert.deepEqual({ ...SUMMARY_PROVIDER_MAP }, {
    anthropic: { cli: 'claude', model: 'haiku' },
    openai: { cli: 'codex', model: 'gpt-5-codex' },
    gemini: { cli: 'gemini', model: 'gemini-2.5-flash' },
  });
  assert.ok(Object.isFrozen(SUMMARY_PROVIDER_MAP));
});
