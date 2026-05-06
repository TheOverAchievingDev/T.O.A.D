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

test('getAuthStatus: eas is now supported in slice 2', () => {
  const result = getAuthStatus({ pluginId: 'eas' });
  assert.equal(result.supported, true);
});

test('getAuthStatus: vercel reads auth token through configured file path', () => {
  const statPaths = [];
  const result = getAuthStatus({
    pluginId: 'vercel',
    statImpl: (p) => {
      statPaths.push(p);
      return { size: 50 };
    },
    readFileImpl: () => JSON.stringify({ token: 'vercel-token' }),
  });
  assert.equal(result.signedIn, true);
  assert.equal(result.raw.tokenLength, 'vercel-token'.length);
  assert.ok(statPaths[0]);
  assert.equal(statPaths[0].includes('%APPDATA%'), false);
});

test('getAuthStatus: vercel checks fallback auth paths', () => {
  let attempts = 0;
  const result = getAuthStatus({
    pluginId: 'vercel',
    statImpl: () => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error('missing');
        err.code = 'ENOENT';
        throw err;
      }
      return { size: 50 };
    },
    readFileImpl: () => JSON.stringify({ token: 'fallback-token' }),
  });
  assert.equal(result.signedIn, true);
  assert.equal(result.raw.tokenLength, 'fallback-token'.length);
  assert.equal(attempts, 2);
});

test('triggerAuthLogin spawns terminal for railway when on supported platform', () => {
  let terminalSpawned = false;
  const result = triggerAuthLogin({
    pluginId: 'railway',
    spawnImpl: () => {
      terminalSpawned = true;
      return { unref: () => {} };
    },
  });

  if (process.platform === 'win32' || process.platform === 'darwin') {
    assert.equal(result.started, true);
    assert.equal(result.terminalStarted, true);
    assert.ok(terminalSpawned);
  } else {
    assert.equal(result.started, false);
    assert.equal(result.manualLogin, true);
  }
  assert.match(result.reason, /railway login/i);
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
