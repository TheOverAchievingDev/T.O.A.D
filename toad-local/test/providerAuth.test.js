import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAuthStatus,
  triggerAuthLogin,
  triggerAuthLogout,
  SUPPORTED_PROVIDERS,
} from '../src/providers/providerAuth.js';

function fakeSpawnSync({ status = 0, stdout = '', stderr = '', error = null } = {}) {
  return () => ({ status, stdout, stderr, error, signal: null, pid: 1234, output: [] });
}

test('SUPPORTED_PROVIDERS is the expected set', () => {
  assert.deepEqual([...SUPPORTED_PROVIDERS].sort(), ['anthropic', 'opencode', 'openai'].sort());
});

test('getAuthStatus returns supported=false for openai/opencode (placeholder)', () => {
  for (const providerId of ['openai', 'opencode']) {
    const result = getAuthStatus({ providerId, spawnSyncImpl: fakeSpawnSync() });
    assert.equal(result.providerId, providerId);
    assert.equal(result.supported, false);
    assert.equal(result.signedIn, null);
    assert.match(result.reason, /CLI auth flow|wire|depends on/i);
  }
});

test('getAuthStatus returns unknown-provider error', () => {
  const result = getAuthStatus({ providerId: 'no-such-thing' });
  assert.equal(result.supported, false);
  assert.match(result.reason, /unknown provider/);
});

test('getAuthStatus(anthropic) parses signedIn=true with email', () => {
  const fake = fakeSpawnSync({
    stdout: JSON.stringify({
      authenticated: true,
      email: 'alice@example.com',
      authMethod: 'oauth',
      subscriptionType: 'pro',
      plan: 'Claude Pro',
    }),
  });
  const result = getAuthStatus({ providerId: 'anthropic', spawnSyncImpl: fake });
  assert.equal(result.supported, true);
  assert.equal(result.signedIn, true);
  assert.equal(result.user.email, 'alice@example.com');
  assert.equal(result.plan, 'Claude Pro');
  assert.equal(result.subscriptionType, 'pro');
  assert.equal(result.authMethod, 'oauth');
});

test('getAuthStatus(anthropic) returns signedIn=false on non-zero exit', () => {
  const fake = fakeSpawnSync({ status: 1, stderr: 'not authenticated' });
  const result = getAuthStatus({ providerId: 'anthropic', spawnSyncImpl: fake });
  assert.equal(result.supported, true);
  assert.equal(result.signedIn, false);
  assert.match(result.reason, /not authenticated/);
});

test('getAuthStatus(anthropic) reports CLI not installed on ENOENT', () => {
  const fake = () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('not found'), { code: 'ENOENT' }) });
  const result = getAuthStatus({ providerId: 'anthropic', spawnSyncImpl: fake });
  assert.equal(result.signedIn, null);
  assert.match(result.reason, /not installed|not on PATH/i);
});

test('getAuthStatus(anthropic) handles non-JSON stdout', () => {
  const fake = fakeSpawnSync({ stdout: 'whoops not json' });
  const result = getAuthStatus({ providerId: 'anthropic', spawnSyncImpl: fake });
  assert.equal(result.supported, true);
  assert.equal(result.signedIn, false);
  assert.match(result.reason, /non-JSON/);
});

test('triggerAuthLogin(anthropic) calls spawn and returns started=true', () => {
  let calledArgs = null;
  const fakeSpawn = (cli, args) => {
    calledArgs = { cli, args };
    return { pid: 999, unref() {} };
  };
  const result = triggerAuthLogin({ providerId: 'anthropic', spawnImpl: fakeSpawn });
  assert.equal(result.started, true);
  assert.equal(result.pid, 999);
  assert.equal(calledArgs.cli, 'claude');
  assert.deepEqual(calledArgs.args, ['auth', 'login']);
});

test('triggerAuthLogin returns started=false for unsupported providers', () => {
  const result = triggerAuthLogin({ providerId: 'opencode' });
  assert.equal(result.started, false);
  assert.match(result.reason, /OpenCode|wire|depends on/i);
});

test('triggerAuthLogin handles spawn throwing', () => {
  const fakeSpawn = () => { throw new Error('boom'); };
  const result = triggerAuthLogin({ providerId: 'anthropic', spawnImpl: fakeSpawn });
  assert.equal(result.started, false);
  assert.match(result.reason, /boom/);
});

test('triggerAuthLogout(anthropic) returns ok=true on exit 0', () => {
  let calledArgs = null;
  const fakeSyncSpawn = (cli, args) => {
    calledArgs = { cli, args };
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  const result = triggerAuthLogout({ providerId: 'anthropic', spawnSyncImpl: fakeSyncSpawn });
  assert.equal(result.ok, true);
  assert.equal(calledArgs.cli, 'claude');
  assert.deepEqual(calledArgs.args, ['auth', 'logout']);
});

test('triggerAuthLogout reports failure on non-zero exit', () => {
  const fakeSyncSpawn = () => ({ status: 2, stdout: '', stderr: 'cannot logout', error: null });
  const result = triggerAuthLogout({ providerId: 'anthropic', spawnSyncImpl: fakeSyncSpawn });
  assert.equal(result.ok, false);
  assert.match(result.reason, /cannot logout/);
});
