import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * §3c.2 Provider plan-auth helpers.
 *
 * Each supported provider has a CLI that owns its subscription/plan auth
 * (Claude Pro/Max, ChatGPT Plus, Gemini, etc). Rather than reimplement OAuth,
 * we shell out to the CLI's own auth subcommands for login/logout, and check
 * status via either the CLI's status flag (Anthropic) or the credentials
 * file the CLI persists to disk (Codex, Gemini).
 *
 * Filesystem-based status detection is more reliable than CLI status
 * commands for two reasons: (1) some CLIs don't ship a status subcommand at
 * all (Codex), (2) the file is the actual source of truth — if it exists
 * and parses, the CLI is authenticated.
 *
 * `spawnImpl`, `spawnSyncImpl`, and `readFileImpl` are injectable so tests
 * don't actually launch real processes or read real disk paths.
 */

export const SUPPORTED_PROVIDERS = Object.freeze(['anthropic', 'openai', 'gemini', 'opencode']);

/**
 * @typedef {Object} ProviderConfig
 * @property {string} label
 * @property {string} cli                       CLI binary name on PATH
 * @property {string[]} loginArgs               argv passed to the login spawn
 * @property {string[]} logoutArgs              argv passed to the logout sync spawn
 * @property {boolean} supported                false hides the provider from get/set; reports unsupportedReason
 * @property {string} [unsupportedReason]
 *
 * @property {('cli'|'file')} statusMode        How to detect signed-in state
 * @property {string[]} [statusArgs]            cli-mode: argv passed to the status sync spawn
 * @property {(result, providerId) => StatusResult} [parseStatus]  cli-mode: stdout parser
 *
 * @property {string} [statusFile]              file-mode: path (with ~ expansion) of the auth file
 * @property {string} [statusInfoFile]          file-mode: optional second file for profile info (e.g. accounts list)
 * @property {(authJson, infoJson, providerId) => StatusResult} [parseFileStatus]
 */

const PROVIDER_COMMANDS = Object.freeze({
  anthropic: {
    label: 'Anthropic',
    cli: 'claude',
    loginArgs: ['auth', 'login'],
    logoutArgs: ['auth', 'logout'],
    supported: true,
    statusMode: 'cli',
    statusArgs: ['auth', 'status', '--json'],
    parseStatus: parseAnthropicStatus,
  },
  openai: {
    label: 'OpenAI Codex',
    cli: 'codex',
    loginArgs: ['login'],
    logoutArgs: ['logout'],
    supported: true,
    statusMode: 'file',
    statusFile: path.join('~', '.codex', 'auth.json'),
    parseFileStatus: parseCodexFileStatus,
  },
  gemini: {
    label: 'Gemini',
    cli: 'gemini',
    loginArgs: ['auth', 'login'],
    logoutArgs: ['auth', 'logout'],
    supported: true,
    statusMode: 'file',
    statusFile: path.join('~', '.gemini', 'oauth_creds.json'),
    statusInfoFile: path.join('~', '.gemini', 'google_accounts.json'),
    parseFileStatus: parseGeminiFileStatus,
  },
  opencode: {
    label: 'OpenCode',
    cli: 'opencode',
    loginArgs: ['auth', 'login'],
    logoutArgs: ['auth', 'logout'],
    supported: false,
    unsupportedReason: 'OpenCode supports many models; the CLI auth shape depends on which one you’re using.',
    statusMode: 'cli',
    statusArgs: ['auth', 'status'],
    parseStatus: parseGenericStatus,
  },
});

/**
 * Synchronously read the current plan-auth status for a provider.
 * @returns {{
 *   providerId: string,
 *   supported: boolean,
 *   signedIn: boolean | null,
 *   user?: { email?: string, login?: string, name?: string } | null,
 *   plan?: string | null,
 *   subscriptionType?: string | null,
 *   authMethod?: string | null,
 *   reason?: string,
 *   raw?: unknown,
 * }}
 */
export function getAuthStatus({ providerId, spawnSyncImpl, readFileImpl, statImpl } = {}) {
  const cfg = PROVIDER_COMMANDS[providerId];
  if (!cfg) {
    return { providerId, supported: false, signedIn: null, reason: `unknown provider: ${providerId}` };
  }
  if (!cfg.supported) {
    return {
      providerId,
      supported: false,
      signedIn: null,
      reason: cfg.unsupportedReason,
    };
  }

  if (cfg.statusMode === 'file') {
    return readFileStatus(cfg, providerId, { readFileImpl, statImpl });
  }

  return readCliStatus(cfg, providerId, { spawnSyncImpl });
}

function readCliStatus(cfg, providerId, { spawnSyncImpl } = {}) {
  const sync = spawnSyncImpl || spawnSync;
  let result;
  try {
    result = sync(cfg.cli, cfg.statusArgs, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
  } catch (err) {
    return {
      providerId,
      supported: true,
      signedIn: null,
      reason: err && err.message ? err.message : 'spawn failed',
    };
  }
  if (result.error) {
    const code = result.error.code;
    if (code === 'ENOENT') {
      return {
        providerId,
        supported: true,
        signedIn: null,
        reason: `${cfg.cli} CLI is not installed or not on PATH`,
      };
    }
    return { providerId, supported: true, signedIn: null, reason: result.error.message };
  }
  if (result.status !== 0) {
    return {
      providerId,
      supported: true,
      signedIn: false,
      reason: result.stderr ? result.stderr.toString().trim().slice(0, 400) : `${cfg.cli} exited ${result.status}`,
    };
  }
  return cfg.parseStatus(result, providerId);
}

function readFileStatus(cfg, providerId, { readFileImpl, statImpl } = {}) {
  const readFile = readFileImpl || ((p) => readFileSync(p, 'utf8'));
  const stat = statImpl || ((p) => statSync(p));
  const authPath = expandHome(cfg.statusFile);
  const infoPath = cfg.statusInfoFile ? expandHome(cfg.statusInfoFile) : null;

  let authRaw;
  try {
    stat(authPath); // existence check; throws ENOENT if missing
    authRaw = readFile(authPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        providerId,
        supported: true,
        signedIn: false,
        reason: `Not signed in (${cfg.statusFile} does not exist).`,
      };
    }
    return {
      providerId,
      supported: true,
      signedIn: null,
      reason: err && err.message ? err.message : 'read failed',
    };
  }

  let authJson = null;
  try {
    authJson = JSON.parse(authRaw);
  } catch {
    return {
      providerId,
      supported: true,
      signedIn: false,
      reason: `Auth file ${cfg.statusFile} did not parse as JSON.`,
    };
  }

  let infoJson = null;
  if (infoPath) {
    try {
      infoJson = JSON.parse(readFile(infoPath));
    } catch {
      infoJson = null;
    }
  }

  return cfg.parseFileStatus(authJson, infoJson, providerId);
}

/**
 * Trigger the CLI's interactive login. Spawns the process detached so the
 * CLI can open a browser tab without blocking the request. Returns
 * immediately with a small handle the UI can use to check progress (mostly
 * informational — the real progress signal is `getAuthStatus` polling).
 */
export function triggerAuthLogin({ providerId, spawnImpl } = {}) {
  const cfg = PROVIDER_COMMANDS[providerId];
  if (!cfg) {
    return { providerId, started: false, reason: `unknown provider: ${providerId}` };
  }
  if (!cfg.supported) {
    return { providerId, started: false, reason: cfg.unsupportedReason };
  }
  const spawnFn = spawnImpl || spawn;
  let child;
  try {
    child = spawnFn(cfg.cli, cfg.loginArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: false, // let the CLI surface its prompt
    });
    if (child && typeof child.unref === 'function') child.unref();
  } catch (err) {
    return { providerId, started: false, reason: err && err.message ? err.message : 'spawn failed' };
  }
  return {
    providerId,
    started: true,
    pid: child?.pid ?? null,
    cli: cfg.cli,
    args: cfg.loginArgs,
  };
}

/**
 * Logout. Synchronous — most CLIs return quickly because it just clears a
 * local file.
 */
export function triggerAuthLogout({ providerId, spawnSyncImpl } = {}) {
  const cfg = PROVIDER_COMMANDS[providerId];
  if (!cfg) {
    return { providerId, ok: false, reason: `unknown provider: ${providerId}` };
  }
  if (!cfg.supported) {
    return { providerId, ok: false, reason: cfg.unsupportedReason };
  }
  const sync = spawnSyncImpl || spawnSync;
  let result;
  try {
    result = sync(cfg.cli, cfg.logoutArgs, {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
  } catch (err) {
    return { providerId, ok: false, reason: err && err.message ? err.message : 'spawn failed' };
  }
  if (result.error) {
    return {
      providerId,
      ok: false,
      reason: result.error.code === 'ENOENT' ? `${cfg.cli} CLI is not installed` : result.error.message,
    };
  }
  if (result.status !== 0) {
    return {
      providerId,
      ok: false,
      reason: result.stderr ? result.stderr.toString().trim().slice(0, 200) : `${cfg.cli} exited ${result.status}`,
    };
  }
  return { providerId, ok: true };
}

// ---- Parsers --------------------------------------------------------------

function parseAnthropicStatus(result, providerId) {
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout || 'null');
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      providerId,
      supported: true,
      signedIn: false,
      reason: 'claude auth status returned non-JSON output',
    };
  }
  const signedIn = parsed.authenticated === true || parsed.signedIn === true;
  return {
    providerId,
    supported: true,
    signedIn,
    user: signedIn
      ? {
          email: typeof parsed.email === 'string' ? parsed.email : null,
          login: typeof parsed.login === 'string' ? parsed.login : null,
          name: typeof parsed.name === 'string' ? parsed.name : null,
        }
      : null,
    plan: typeof parsed.plan === 'string' ? parsed.plan : null,
    subscriptionType: typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : null,
    authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : null,
    raw: parsed,
  };
}

function parseGenericStatus(result, providerId) {
  const stdout = (result.stdout || '').toString().trim();
  return {
    providerId,
    supported: true,
    signedIn: stdout.length > 0,
    raw: stdout.slice(0, 400),
  };
}

/**
 * Codex stores auth at `~/.codex/auth.json`. Common shapes the CLI uses
 * across versions:
 *   { tokens: {...}, last_refresh: "...", account: {email, plan, ...} }
 *   { type: "chatgpt", email: "...", plan: "plus" }
 *
 * We're conservative: file-exists + parses-as-JSON-object => signed in.
 * Surface whatever profile fields we can spot.
 */
function parseCodexFileStatus(authJson, _infoJson, providerId) {
  if (!authJson || typeof authJson !== 'object' || Array.isArray(authJson)) {
    return { providerId, supported: true, signedIn: false, reason: 'codex auth file is empty or not an object' };
  }
  const account = (authJson.account && typeof authJson.account === 'object') ? authJson.account : {};
  const email = pickString(authJson.email, account.email, authJson.user_email);
  const plan = pickString(authJson.plan, account.plan, authJson.subscription, account.subscription);
  const accountType = pickString(authJson.type, account.type, authJson.auth_method);
  return {
    providerId,
    supported: true,
    signedIn: true,
    user: {
      email,
      login: pickString(authJson.login, account.login, account.username),
      name: pickString(authJson.name, account.name),
    },
    plan,
    subscriptionType: plan,
    authMethod: accountType ?? 'codex login',
    raw: { hasTokens: !!authJson.tokens || !!authJson.access_token, account },
  };
}

/**
 * Gemini stores OAuth creds at `~/.gemini/oauth_creds.json` and the active
 * account list at `~/.gemini/google_accounts.json`. The combination tells us
 * which Google account is authed.
 */
function parseGeminiFileStatus(authJson, infoJson, providerId) {
  if (!authJson || typeof authJson !== 'object' || Array.isArray(authJson)) {
    return { providerId, supported: true, signedIn: false, reason: 'gemini oauth_creds.json is empty or invalid' };
  }
  const accounts = infoJson && typeof infoJson === 'object'
    ? (Array.isArray(infoJson.accounts) ? infoJson.accounts : Object.values(infoJson))
    : [];
  const active = accounts.find((a) => a && (a.active === true || a.is_default === true)) || accounts[0] || null;
  const email = pickString(active?.email, authJson.email, authJson.user_email);
  return {
    providerId,
    supported: true,
    signedIn: true,
    user: {
      email,
      login: pickString(active?.username, active?.login),
      name: pickString(active?.name, active?.displayName),
    },
    plan: pickString(active?.plan, active?.tier),
    subscriptionType: pickString(active?.subscription_type),
    authMethod: 'google oauth',
    raw: { hasAccessToken: !!authJson.access_token || !!authJson.token, accounts: accounts.length },
  };
}

// ---- Helpers --------------------------------------------------------------

function pickString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return null;
}

function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

export const PROVIDER_AUTH_DEFINITIONS = PROVIDER_COMMANDS;
