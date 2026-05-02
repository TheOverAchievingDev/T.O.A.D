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

function fakeFsModule({ files = {} } = {}) {
  return {
    readFileImpl: (p) => {
      if (!(p in files)) {
        const err = new Error(`ENOENT: no such file: ${p}`);
        // @ts-expect-error – setting Node-style .code on the error
        err.code = 'ENOENT';
        throw err;
      }
      return files[p];
    },
    statImpl: (p) => {
      if (!(p in files)) {
        const err = new Error(`ENOENT: no such file: ${p}`);
        // @ts-expect-error – setting Node-style .code on the error
        err.code = 'ENOENT';
        throw err;
      }
      return { isFile: () => true };
    },
  };
}

test('SUPPORTED_PROVIDERS is the expected set', () => {
  assert.deepEqual([...SUPPORTED_PROVIDERS].sort(), ['anthropic', 'gemini', 'opencode', 'openai'].sort());
});

test('getAuthStatus returns supported=false for opencode (placeholder)', () => {
  const result = getAuthStatus({ providerId: 'opencode' });
  assert.equal(result.providerId, 'opencode');
  assert.equal(result.supported, false);
  assert.equal(result.signedIn, null);
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

test('getAuthStatus(openai) returns signedIn=true when ~/.codex/auth.json exists', async () => {
  const home = (await import('node:os')).homedir();
  const path = (await import('node:path')).default;
  const authPath = path.join(home, '.codex', 'auth.json');
  const fs = fakeFsModule({
    files: {
      [authPath]: JSON.stringify({
        type: 'chatgpt',
        email: 'kayden@example.com',
        plan: 'plus',
        tokens: { access_token: 'tok' },
      }),
    },
  });
  const result = getAuthStatus({ providerId: 'openai', ...fs });
  assert.equal(result.supported, true);
  assert.equal(result.signedIn, true);
  assert.equal(result.user.email, 'kayden@example.com');
  assert.equal(result.plan, 'plus');
  assert.equal(result.authMethod, 'chatgpt');
});

test('getAuthStatus(openai) returns signedIn=false when auth.json missing', () => {
  const fs = fakeFsModule({ files: {} });
  const result = getAuthStatus({ providerId: 'openai', ...fs });
  assert.equal(result.supported, true);
  assert.equal(result.signedIn, false);
  assert.match(result.reason, /Not signed in/);
});

test('getAuthStatus(openai) handles malformed auth.json', async () => {
  const home = (await import('node:os')).homedir();
  const path = (await import('node:path')).default;
  const authPath = path.join(home, '.codex', 'auth.json');
  const fs = fakeFsModule({ files: { [authPath]: '{not json' } });
  const result = getAuthStatus({ providerId: 'openai', ...fs });
  assert.equal(result.supported, true);
  assert.equal(result.signedIn, false);
  assert.match(result.reason, /did not parse/);
});

test('getAuthStatus(gemini) merges oauth_creds + google_accounts.json', async () => {
  const home = (await import('node:os')).homedir();
  const path = (await import('node:path')).default;
  const authPath = path.join(home, '.gemini', 'oauth_creds.json');
  const infoPath = path.join(home, '.gemini', 'google_accounts.json');
  const fs = fakeFsModule({
    files: {
      [authPath]: JSON.stringify({ access_token: 'tok-abc', expiry: '2026-06-01' }),
      [infoPath]: JSON.stringify({
        accounts: [
          { email: 'kayden@example.com', name: 'Kayden', active: true, plan: 'Gemini Advanced' },
          { email: 'old@example.com', active: false },
        ],
      }),
    },
  });
  const result = getAuthStatus({ providerId: 'gemini', ...fs });
  assert.equal(result.supported, true);
  assert.equal(result.signedIn, true);
  assert.equal(result.user.email, 'kayden@example.com');
  assert.equal(result.user.name, 'Kayden');
  assert.equal(result.plan, 'Gemini Advanced');
  assert.equal(result.authMethod, 'google oauth');
});

test('getAuthStatus(gemini) tolerates missing google_accounts.json (creds only)', async () => {
  const home = (await import('node:os')).homedir();
  const path = (await import('node:path')).default;
  const authPath = path.join(home, '.gemini', 'oauth_creds.json');
  const fs = fakeFsModule({
    files: { [authPath]: JSON.stringify({ access_token: 'tok' }) },
  });
  const result = getAuthStatus({ providerId: 'gemini', ...fs });
  assert.equal(result.signedIn, true);
  assert.equal(result.user.email, null);
});

test('triggerAuthLogin(codex) uses `codex login` (no auth prefix)', () => {
  let calledArgs = null;
  const fakeSpawn = (cli, args) => {
    calledArgs = { cli, args };
    return { pid: 999, unref() {} };
  };
  const result = triggerAuthLogin({ providerId: 'openai', spawnImpl: fakeSpawn });
  assert.equal(result.started, true);
  assert.equal(calledArgs.cli, 'codex');
  assert.deepEqual(calledArgs.args, ['login']);
});

test('triggerAuthLogin(gemini) uses `gemini auth login`', () => {
  let calledArgs = null;
  const fakeSpawn = (cli, args) => {
    calledArgs = { cli, args };
    return { pid: 999, unref() {} };
  };
  const result = triggerAuthLogin({ providerId: 'gemini', spawnImpl: fakeSpawn });
  assert.equal(result.started, true);
  assert.equal(calledArgs.cli, 'gemini');
  assert.deepEqual(calledArgs.args, ['auth', 'login']);
});

test('triggerAuthLogin(anthropic) calls spawn and returns started=true', () => {
  let calledArgs = null;
  const fakeSpawn = (cli, args) => {
    calledArgs = { cli, args };
    return { pid: 999, unref() {} };
  };
  const result = triggerAuthLogin({ providerId: 'anthropic', spawnImpl: fakeSpawn });
  assert.equal(result.started, true);
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

test('triggerAuthLogout(codex) returns ok=true', () => {
  let calledArgs = null;
  const fakeSyncSpawn = (cli, args) => {
    calledArgs = { cli, args };
    return { status: 0, stdout: '', stderr: '', error: null };
  };
  const result = triggerAuthLogout({ providerId: 'openai', spawnSyncImpl: fakeSyncSpawn });
  assert.equal(result.ok, true);
  assert.equal(calledArgs.cli, 'codex');
  assert.deepEqual(calledArgs.args, ['logout']);
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
