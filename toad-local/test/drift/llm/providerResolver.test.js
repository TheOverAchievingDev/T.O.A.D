import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, PROVIDER_MAP } from '../../../src/drift/llm/providerResolver.js';

const NO_OVERRIDES = { drift: { tier1ModelOverride: null, tier2ModelOverride: null } };

test('PROVIDER_MAP exposes the three core providers', () => {
  assert.ok(PROVIDER_MAP.anthropic);
  assert.ok(PROVIDER_MAP.openai);
  assert.ok(PROVIDER_MAP.gemini);
});

/**
 * Anti-regression: each PROVIDER_MAP entry must use a model string the
 * CLI actually accepts. The 2026-05-14 bug shipped "haiku-4.5" and
 * "opus-4.7" which Claude rejects with exit 1 — every drift LLM check
 * fired a `judge_failed` meta-finding and the team score stuck at +8
 * forever. The mitigation: empirical model-string discipline (only
 * names the CLI accepts) + this test as a tripwire.
 */
test('PROVIDER_MAP only uses CLI-accepted model strings (no hyphenated-version shorthands like haiku-4.5)', () => {
  // Claude CLI: aliases haiku/sonnet/opus OR full versioned ids
  // (claude-...-YYYYMMDD). Reject hyphenated shorthands.
  const claudeAliases = new Set(['haiku', 'sonnet', 'opus']);
  for (const tier of ['tier1', 'tier2']) {
    const m = PROVIDER_MAP.anthropic[tier];
    const isAlias = claudeAliases.has(m);
    const isFullId = /^claude-(haiku|sonnet|opus)(-\d)?(-\d)?-?\d{8}$/.test(m);
    assert.ok(
      isAlias || isFullId,
      `Claude ${tier} model "${m}" must be an alias (haiku/sonnet/opus) or a full versioned id (claude-...-YYYYMMDD), got something the CLI will reject`,
    );
  }
  // Codex: model strings should match Plus/Pro plan dashboard values.
  // No leading "openai:" prefix, no quotes.
  for (const tier of ['tier1', 'tier2']) {
    const m = PROVIDER_MAP.openai[tier];
    assert.ok(/^[a-z][a-z0-9-]*$/i.test(m), `Codex ${tier} model "${m}" looks malformed`);
  }
  // Gemini: published gemini-*.*-* names.
  for (const tier of ['tier1', 'tier2']) {
    const m = PROVIDER_MAP.gemini[tier];
    assert.ok(m.startsWith('gemini-'), `Gemini ${tier} model "${m}" should start with "gemini-"`);
  }
});

test('resolveProvider: anthropic team, tier 1 → claude + haiku', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'anthropic' } },
    settings: NO_OVERRIDES,
    tier: 1,
  });
  assert.equal(result.cli, 'claude');
  assert.equal(result.model, 'haiku');
});

test('resolveProvider: anthropic team, tier 2 → claude + opus', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'anthropic' } },
    settings: NO_OVERRIDES,
    tier: 2,
  });
  assert.equal(result.cli, 'claude');
  assert.equal(result.model, 'opus');
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
  assert.equal(t1.model, 'gpt-5-codex');
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
  assert.equal(result.model, 'haiku');
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
  assert.equal(result.model, 'opus');
});
