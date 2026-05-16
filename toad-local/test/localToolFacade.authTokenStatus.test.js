/**
 * Task 3: localToolFacade surfaces tokenStatus in provider entries.
 *
 * Mirrors the harness from the existing
 * 'LocalToolFacade usage_summary surfaces per-provider plan info ...' test
 * (test/localToolFacade.test.js ~L2041-2095).  Only the anthropic creds
 * JSON and assertions differ.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { COMMANDS } from '../src/commands/command-contract.js';
import { InMemoryTaskBoard } from '../src/task/inMemoryTaskBoard.js';
import { LocalToolFacade } from '../src/tools/localToolFacade.js';

// ---------------------------------------------------------------------------
// Shared infrastructure helpers
// ---------------------------------------------------------------------------

const home = os.homedir();

/**
 * Build a LocalToolFacade with injected file-read stubs.
 * `anthropicCredsJson` is the string returned for the anthropic creds path.
 */
function buildFacade(anthropicCredsJson) {
  const fakeFiles = {
    // anthropic — shaped by the caller
    [path.join(home, '.claude', '.credentials.json')]: anthropicCredsJson,
    // codex — signed in (id_token JWT-shaped payload base64 of {"email":"x@y.com"})
    [path.join(home, '.codex', 'auth.json')]:
      JSON.stringify({ tokens: { id_token: 'header.eyJlbWFpbCI6InhAeS5jb20ifQ.sig' } }),
    // gemini — signed in
    [path.join(home, '.gemini', 'oauth_creds.json')]:
      JSON.stringify({ access_token: 'tok', expiry_date: Date.now() + 3_600_000 }),
  };

  const fakeReadFile = (p) => {
    if (p in fakeFiles) return fakeFiles[p];
    const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
  };
  const fakeStat = (p) => {
    if (p in fakeFiles) return { size: fakeFiles[p].length };
    const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
  };

  return new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    providerAuthSpawnSync: () => ({ status: 0, stdout: JSON.stringify({ loggedIn: true, subscriptionType: 'max' }) }),
    providerAuthReadFile: fakeReadFile,
    providerAuthStat: fakeStat,
    // Skip the live pty probe — return null deterministically and fast.
    claudeUsageProbe: async () => null,
  });
}

/**
 * Execute USAGE_SUMMARY and return the full result.
 */
async function usageSummary(facade) {
  return facade.execute({
    commandName: COMMANDS.USAGE_SUMMARY,
    actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
    args: {},
  });
}

// ---------------------------------------------------------------------------
// Creds JSON helpers — drive each tokenStatus branch via parseAnthropicFileStatus
// ---------------------------------------------------------------------------

// FRESH: accessToken present, expiresAt in the future, refreshToken present
const FRESH_CREDS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'access-tok',
    expiresAt: Date.now() + 3_600_000,   // 1 h in future
    refreshToken: 'refresh-tok',
    subscriptionType: 'max',
  },
});

// STALE_REFRESHABLE: expiresAt in the past BUT refreshToken present
const STALE_CREDS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'stale-access-tok',
    expiresAt: Date.now() - 3_600_000,   // 1 h ago
    refreshToken: 'refresh-tok',
    subscriptionType: 'max',
  },
});

// UNRECOVERABLE: expiresAt in the past AND no refreshToken
const UNRECOV_CREDS = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'dead-access-tok',
    expiresAt: Date.now() - 3_600_000,   // 1 h ago
    // no refreshToken
    subscriptionType: 'max',
  },
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('USAGE_SUMMARY provider entry: anthropic FRESH → signedIn true, tokenStatus fresh, reason null', async () => {
  const result = await usageSummary(buildFacade(FRESH_CREDS));

  assert.ok(Array.isArray(result.providers), 'providers array present');
  const anthropic = result.providers.find((p) => p.providerId === 'anthropic');
  assert.ok(anthropic, 'anthropic entry present');

  assert.equal(anthropic.signedIn, true, 'signedIn true for fresh token');
  assert.equal(anthropic.tokenStatus, 'fresh', 'tokenStatus is fresh');
  assert.equal(anthropic.reason, null, 'reason is null for fresh token');
});

test('USAGE_SUMMARY provider entry: anthropic STALE_REFRESHABLE → signedIn true, tokenStatus stale_refreshable, reason non-empty string', async () => {
  const result = await usageSummary(buildFacade(STALE_CREDS));

  const anthropic = result.providers.find((p) => p.providerId === 'anthropic');
  assert.ok(anthropic, 'anthropic entry present');

  assert.equal(anthropic.signedIn, true, 'signedIn true for stale_refreshable');
  assert.equal(anthropic.tokenStatus, 'stale_refreshable', 'tokenStatus is stale_refreshable');
  assert.equal(typeof anthropic.reason, 'string', 'reason is a string');
  assert.ok(anthropic.reason.length > 0, 'reason is non-empty');
});

test('USAGE_SUMMARY provider entry: anthropic UNRECOVERABLE → signedIn false, tokenStatus unrecoverable, reason non-null; byte-identical to old shape sans tokenStatus', async () => {
  const result = await usageSummary(buildFacade(UNRECOV_CREDS));

  const anthropic = result.providers.find((p) => p.providerId === 'anthropic');
  assert.ok(anthropic, 'anthropic entry present');

  assert.equal(anthropic.signedIn, false, 'signedIn false for unrecoverable');
  assert.equal(anthropic.tokenStatus, 'unrecoverable', 'tokenStatus is unrecoverable');
  assert.ok(anthropic.reason != null && anthropic.reason.length > 0, 'reason is non-null and non-empty');

  // Regression guard: removing tokenStatus must leave the entry byte-identical
  // to what the OLD projection would have produced.
  //
  // The old entry shape (from reading the real code in localToolFacade.js):
  //   {
  //     providerId: 'anthropic',
  //     label: 'Anthropic Claude',          ← providerEntries hard-codes this
  //     signedIn: false,
  //     plan: authStatus?.subscriptionType (→ 'max' from UNRECOV_CREDS) → 'max'
  //          (plan is null because authJson has no `.plan`; subscriptionType
  //           is null on the auth-status object because parseAnthropicFileStatus
  //           returns signedIn:false for unrecoverable — let's check what it returns)
  //     user: null,
  //     reason: <the unrecoverable reason string>,
  //     quota: null,   ← claudeUsageProbe returns null → quota is null → providerQuota null
  //     symphonyUsage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  //   }
  //
  // parseAnthropicFileStatus for unrecoverable (expired no-refresh) returns:
  //   { providerId, supported, signedIn:false, tokenStatus:'unrecoverable', reason:... }
  // No `.plan`, no `.subscriptionType` on that object. So:
  //   plan: authStatus?.plan ?? authStatus?.subscriptionType ?? null  → null
  //   user: authStatus?.user ?? null                                  → null
  //
  const expectedOldShape = {
    providerId: 'anthropic',
    label: 'Anthropic Claude',
    signedIn: false,
    plan: null,
    user: null,
    reason: anthropic.reason,  // same string — we're just verifying structural identity
    quota: null,
    symphonyUsage: { tokensIn: 0, tokensOut: 0, costUsd: 0 },
  };

  const clone = { ...anthropic };
  delete clone.tokenStatus;

  assert.deepEqual(clone, expectedOldShape, 'entry minus tokenStatus is byte-identical to old projection');
});

test('USAGE_SUMMARY provider entry: codex (openai) → tokenStatus null', async () => {
  const result = await usageSummary(buildFacade(FRESH_CREDS));

  const codex = result.providers.find((p) => p.providerId === 'openai');
  assert.ok(codex, 'openai/codex entry present');
  assert.equal(codex.tokenStatus, null, 'codex tokenStatus is null (no anthropic token concept)');
});

test('USAGE_SUMMARY provider entry: gemini → tokenStatus null', async () => {
  const result = await usageSummary(buildFacade(FRESH_CREDS));

  const gemini = result.providers.find((p) => p.providerId === 'gemini');
  assert.ok(gemini, 'gemini entry present');
  assert.equal(gemini.tokenStatus, null, 'gemini tokenStatus is null (no anthropic token concept)');
});
