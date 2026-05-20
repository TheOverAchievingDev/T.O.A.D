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

test('getAuthStatus reports opencode credentials from auth file', () => {
  const result = getAuthStatus({
    providerId: 'opencode',
    statImpl: () => ({ isFile: () => true }),
    readFileImpl: () => JSON.stringify({ deepseek: { type: 'api' }, google: { type: 'api' } }),
  });
  assert.equal(result.providerId, 'opencode');
  assert.equal(result.supported, true);
  assert.equal(result.apiOnly, true);
  assert.equal(result.signedIn, true);
  assert.deepEqual(result.raw.providers.sort(), ['deepseek', 'google']);
});

test('getAuthStatus returns unknown-provider error', () => {
  const result = getAuthStatus({ providerId: 'no-such-thing' });
  assert.equal(result.supported, false);
  assert.match(result.reason, /unknown provider/);
});

test('getAuthStatus(anthropic) returns signedIn=true when ~/.claude/.credentials.json has a fresh access token', async () => {
  const home = (await import('node:os')).homedir();
  const path = (await import('node:path')).default;
  const credPath = path.join(home, '.claude', '.credentials.json');
  const fs = fakeFsModule({
    files: {
      [credPath]: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-x',
          refreshToken: 'sk-ant-ort01-x',
          expiresAt: Date.now() + 1000 * 60 * 60,
          scopes: ['user:inference'],
          subscriptionType: 'max',
        },
      }),
    },
  });
  const result = getAuthStatus({ providerId: 'anthropic', ...fs });
  assert.equal(result.supported, true);
  assert.equal(result.signedIn, true);
  assert.equal(result.subscriptionType, 'max');
  assert.match(result.plan, /Claude Max/i);
  assert.equal(result.authMethod, 'claude.ai oauth');
});

test('getAuthStatus(anthropic) treats expired access token + refresh token as still signed in', async () => {
  // The Claude Code CLI silently refreshes — TOAD should follow suit.
  const home = (await import('node:os')).homedir();
  const path = (await import('node:path')).default;
  const credPath = path.join(home, '.claude', '.credentials.json');
  const fs = fakeFsModule({
    files: {
      [credPath]: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-old',
          refreshToken: 'sk-ant-ort01-fresh',
          expiresAt: Date.now() - 1000,
          subscriptionType: 'pro',
        },
      }),
    },
  });
  const result = getAuthStatus({ providerId: 'anthropic', ...fs });
  assert.equal(result.signedIn, true);
  assert.equal(result.raw.accessExpired, true);
  assert.equal(result.raw.hasRefreshToken, true);
});

test('getAuthStatus(anthropic) returns signedIn=false when credentials file missing', () => {
  const fs = fakeFsModule({ files: {} });
  const result = getAuthStatus({ providerId: 'anthropic', ...fs });
  assert.equal(result.supported, true);
  assert.equal(result.signedIn, false);
  assert.match(result.reason, /does not exist/);
});

test('getAuthStatus(anthropic) returns signedIn=false when file is empty / malformed JSON', async () => {
  const home = (await import('node:os')).homedir();
  const path = (await import('node:path')).default;
  const credPath = path.join(home, '.claude', '.credentials.json');
  const fs = fakeFsModule({ files: { [credPath]: 'not json at all' } });
  const result = getAuthStatus({ providerId: 'anthropic', ...fs });
  assert.equal(result.signedIn, false);
  assert.match(result.reason, /did not parse/);
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

test('triggerAuthLogin(codex) returns manual-login instructions instead of auto-spawning', () => {
  // The CLI's `codex login` opens an OAuth scope users don't want from
  // TOAD. Surface manual instructions so the user runs it themselves.
  let spawnCalled = false;
  const fakeSpawn = () => { spawnCalled = true; return { pid: 999, unref() {} }; };
  const result = triggerAuthLogin({ providerId: 'openai', spawnImpl: fakeSpawn });
  assert.equal(result.started, false);
  assert.equal(result.manualLogin, true);
  assert.equal(result.cli, 'codex');
  assert.match(result.reason, /codex login/);
  assert.equal(spawnCalled, false, 'must NOT spawn for manual-login providers');
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

test('triggerAuthLogin(anthropic) returns manual-login instructions instead of auto-spawning', () => {
  // Claude Code's auth is managed via its own /login slash command;
  // `claude auth login` opens a different OAuth scope (claude.ai chats).
  let spawnCalled = false;
  const fakeSpawn = () => { spawnCalled = true; return { pid: 999, unref() {} }; };
  const result = triggerAuthLogin({ providerId: 'anthropic', spawnImpl: fakeSpawn });
  assert.equal(result.started, false);
  assert.equal(result.manualLogin, true);
  assert.equal(result.cli, 'claude');
  assert.match(result.reason, /\/login/);
  assert.equal(spawnCalled, false, 'must NOT spawn for manual-login providers');
});

test('triggerAuthLogin(opencode) returns manual provider-login instructions', () => {
  const result = triggerAuthLogin({ providerId: 'opencode' });
  assert.equal(result.started, false);
  assert.equal(result.manualLogin, true);
  assert.match(result.reason, /opencode providers login/i);
});

test('triggerAuthLogin handles spawn throwing for non-manual providers', () => {
  // Gemini is still auto-spawn (its auth flow is correct), so this exercises
  // the actual spawn-throws path.
  const fakeSpawn = () => { throw new Error('boom'); };
  const result = triggerAuthLogin({ providerId: 'gemini', spawnImpl: fakeSpawn });
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
