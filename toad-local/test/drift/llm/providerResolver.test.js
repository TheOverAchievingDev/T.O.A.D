import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, PROVIDER_MAP } from '../../../src/drift/llm/providerResolver.js';

const NO_OVERRIDES = { drift: { tier1ModelOverride: null, tier2ModelOverride: null } };

test('PROVIDER_MAP exposes the three core providers', () => {
  assert.ok(PROVIDER_MAP.anthropic);
  assert.ok(PROVIDER_MAP.openai);
  assert.ok(PROVIDER_MAP.gemini);
});

test('resolveProvider: anthropic team, tier 1 → claude + haiku-4.5', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'anthropic' } },
    settings: NO_OVERRIDES,
    tier: 1,
  });
  assert.equal(result.cli, 'claude');
  assert.equal(result.model, 'haiku-4.5');
});

test('resolveProvider: anthropic team, tier 2 → claude + opus-4.7', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'anthropic' } },
    settings: NO_OVERRIDES,
    tier: 2,
  });
  assert.equal(result.cli, 'claude');
  assert.equal(result.model, 'opus-4.7');
});

test('resolveProvider: openai team → codex CLI', () => {
  const t1 = resolveProvider({
    teamConfig: { lead: { providerId: 'openai' } },
    settings: NO_OVERRIDES, tier: 1,
  });
  const t2 = resolveProvider({
    teamConfig: { lead: { providerId: 'openai' } },
    settings: NO_OVERRIDES, tier: 2,
  });
  assert.equal(t1.cli, 'codex');
  assert.equal(t1.model, 'gpt-4o-mini');
  assert.equal(t2.cli, 'codex');
  assert.equal(t2.model, 'gpt-5');
});

test('resolveProvider: gemini team → gemini CLI', () => {
  const t1 = resolveProvider({
    teamConfig: { lead: { providerId: 'gemini' } },
    settings: NO_OVERRIDES, tier: 1,
  });
  const t2 = resolveProvider({
    teamConfig: { lead: { providerId: 'gemini' } },
    settings: NO_OVERRIDES, tier: 2,
  });
  assert.equal(t1.cli, 'gemini');
  assert.equal(t1.model, 'gemini-2.5-flash');
  assert.equal(t2.cli, 'gemini');
  assert.equal(t2.model, 'gemini-2.5-pro');
});

test('resolveProvider: unknown providerId falls back to anthropic', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'unknown-xyz' } },
    settings: NO_OVERRIDES, tier: 1,
  });
  assert.equal(result.cli, 'claude');
  assert.equal(result.model, 'haiku-4.5');
});

test('resolveProvider: missing teamConfig defaults to anthropic', () => {
  const result = resolveProvider({
    teamConfig: null, settings: NO_OVERRIDES, tier: 1,
  });
  assert.equal(result.cli, 'claude');
});

test('resolveProvider: tier1ModelOverride wins for tier 1', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'anthropic' } },
    settings: { drift: { tier1ModelOverride: 'sonnet-4.6', tier2ModelOverride: null } },
    tier: 1,
  });
  assert.equal(result.cli, 'claude');
  assert.equal(result.model, 'sonnet-4.6');
});

test('resolveProvider: tier2ModelOverride wins for tier 2', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'anthropic' } },
    settings: { drift: { tier1ModelOverride: null, tier2ModelOverride: 'opus-4.6' } },
    tier: 2,
  });
  assert.equal(result.cli, 'claude');
  assert.equal(result.model, 'opus-4.6');
});

test('resolveProvider: tier1Override does NOT affect tier 2 resolution', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'anthropic' } },
    settings: { drift: { tier1ModelOverride: 'sonnet-4.6', tier2ModelOverride: null } },
    tier: 2,
  });
  assert.equal(result.model, 'opus-4.7');
});
