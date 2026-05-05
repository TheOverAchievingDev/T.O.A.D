import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuthStatus, triggerAuthLogin, triggerAuthLogout } from '../../src/plugins/pluginAuth.js';

test('getAuthStatus: unknown pluginId → not supported', () => {
  const result = getAuthStatus({ pluginId: 'bogus' });
  assert.equal(result.supported, false);
  assert.match(result.reason, /unknown plugin/i);
});

test('getAuthStatus: railway not signed in (file missing)', () => {
  const result = getAuthStatus({
    pluginId: 'railway',
    statImpl: () => { const e = new Error(); e.code = 'ENOENT'; throw e; },
    readFileImpl: () => '{}',
  });
  assert.equal(result.signedIn, false);
  assert.match(result.reason, /not signed in|does not exist/i);
});

test('getAuthStatus: railway signed in (file has token)', () => {
  const result = getAuthStatus({
    pluginId: 'railway',
    statImpl: () => ({ size: 50 }),
    readFileImpl: () => JSON.stringify({ token: 'abc', user: { email: 'a@b.c' } }),
  });
  assert.equal(result.signedIn, true);
  assert.equal(result.user.email, 'a@b.c');
});

test('getAuthStatus: eas marked unsupported in slice 1', () => {
  const result = getAuthStatus({ pluginId: 'eas' });
  assert.equal(result.supported, false);
  assert.match(result.reason, /slice 2/i);
});

test('triggerAuthLogin returns manualLogin instructions for railway', () => {
  const result = triggerAuthLogin({ pluginId: 'railway' });
  assert.equal(result.started, false);
  assert.equal(result.manualLogin, true);
  assert.match(result.reason, /railway login/);
});

test('triggerAuthLogout shells out to railway logout', () => {
  const calls = [];
  const fakeSpawnSync = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = triggerAuthLogout({ pluginId: 'railway', spawnSyncImpl: fakeSpawnSync });
  assert.equal(result.loggedOut, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'railway');
  assert.deepEqual(calls[0].args, ['logout']);
});
