import { spawn, spawnSync } from 'node:child_process';

/**
 * §3c.2 Provider plan-auth helpers.
 *
 * Each supported provider has a CLI that owns its subscription/plan auth
 * (Claude Pro/Max, ChatGPT Plus, etc). Rather than reimplement OAuth, we
 * shell out to the CLI's own `auth` subcommands and parse their output.
 *
 * Anthropic ships the most stable surface; OpenAI Codex and OpenCode are
 * marked unsupported until we know which CLI binary the user has installed.
 *
 * `spawnImpl` and `spawnSyncImpl` are injectable so tests don't actually
 * launch real processes.
 */

export const SUPPORTED_PROVIDERS = Object.freeze(['anthropic', 'openai', 'opencode']);

const PROVIDER_COMMANDS = Object.freeze({
  anthropic: {
    label: 'Anthropic',
    cli: 'claude',
    statusArgs: ['auth', 'status', '--json'],
    loginArgs: ['auth', 'login'],
    logoutArgs: ['auth', 'logout'],
    parseStatus: parseAnthropicStatus,
    supported: true,
  },
  openai: {
    label: 'OpenAI Codex',
    cli: 'codex',
    statusArgs: ['auth', 'status'],
    loginArgs: ['auth', 'login'],
    logoutArgs: ['auth', 'logout'],
    parseStatus: parseGenericStatus,
    supported: false,
    unsupportedReason: 'OpenAI Codex CLI auth flow varies by version — wire when your installed CLI is known.',
  },
  opencode: {
    label: 'OpenCode',
    cli: 'opencode',
    statusArgs: ['auth', 'status'],
    loginArgs: ['auth', 'login'],
    logoutArgs: ['auth', 'logout'],
    parseStatus: parseGenericStatus,
    supported: false,
    unsupportedReason: 'OpenCode supports many models; the CLI auth shape depends on which one you’re using.',
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
export function getAuthStatus({ providerId, spawnSyncImpl } = {}) {
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
  // Best-effort fallback for CLIs without a documented JSON shape: assume
  // exit 0 with output means signed in.
  const stdout = (result.stdout || '').toString().trim();
  return {
    providerId,
    supported: true,
    signedIn: stdout.length > 0,
    raw: stdout.slice(0, 400),
  };
}

export const PROVIDER_AUTH_DEFINITIONS = PROVIDER_COMMANDS;
