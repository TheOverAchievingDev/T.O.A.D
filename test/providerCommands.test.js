import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PROVIDER_COMMANDS,
  commandForProvider,
  providerForCommand,
} from '../src/team/providerCommands.js';

test('PROVIDER_COMMANDS exposes the four primary CLI bindings', () => {
  assert.equal(PROVIDER_COMMANDS.anthropic, 'claude');
  assert.equal(PROVIDER_COMMANDS.openai, 'codex');
  assert.equal(PROVIDER_COMMANDS.gemini, 'gemini');
  assert.equal(PROVIDER_COMMANDS.opencode, 'opencode');
});

test('PROVIDER_COMMANDS is frozen — accidental mutation throws/no-ops', () => {
  // The map is the SINGLE source of truth for team_create,
  // agent_swap_provider, drift providerResolver — letting any caller
  // mutate it could subtly drift the others.
  assert.ok(Object.isFrozen(PROVIDER_COMMANDS));
});

test('commandForProvider returns the canonical binary for known providers', () => {
  assert.equal(commandForProvider('anthropic'), 'claude');
  assert.equal(commandForProvider('openai'), 'codex');
  assert.equal(commandForProvider('gemini'), 'gemini');
  assert.equal(commandForProvider('opencode'), 'opencode');
});

test('commandForProvider returns null for unknown / missing / empty input', () => {
  assert.equal(commandForProvider('not-a-real-provider'), null);
  assert.equal(commandForProvider(''), null);
  assert.equal(commandForProvider(null), null);
  assert.equal(commandForProvider(undefined), null);
  assert.equal(commandForProvider(42), null);
});

test('providerForCommand inverts the mapping for known commands', () => {
  assert.equal(providerForCommand('claude'), 'anthropic');
  assert.equal(providerForCommand('codex'), 'openai');
  assert.equal(providerForCommand('gemini'), 'gemini');
  assert.equal(providerForCommand('opencode'), 'opencode');
});

test('providerForCommand returns null for unknown / missing / empty input', () => {
  assert.equal(providerForCommand('/opt/claude-beta/bin/claude'), null);
  assert.equal(providerForCommand(''), null);
  assert.equal(providerForCommand(null), null);
  assert.equal(providerForCommand(undefined), null);
});

test('PROVIDER_COMMANDS values are unique (no two providers share a CLI)', () => {
  // Defense against future regressions — if someone adds e.g.
  // { anthropic: 'claude', anthropicOpus: 'claude' }, the
  // providerForCommand inverse breaks silently.
  const seen = new Set();
  for (const [providerId, cmd] of Object.entries(PROVIDER_COMMANDS)) {
    assert.ok(!seen.has(cmd), `command "${cmd}" is shared by multiple providers (last: ${providerId})`);
    seen.add(cmd);
  }
});
