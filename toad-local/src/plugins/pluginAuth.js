import { readFileSync, statSync } from 'node:fs';
import { spawn, spawnSync as defaultSpawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_COMMANDS } from './pluginRegistry.js';

const defaultSpawn = spawn;

/**
 * Status of a plugin's CLI authentication. Mirrors the providerAuth.js
 * surface — same shape, same injectable hooks for tests, just keyed
 * on PLUGIN_COMMANDS instead of PROVIDER_COMMANDS.
 */
export function getAuthStatus({ pluginId, readFileImpl, statImpl } = {}) {
  const cfg = PLUGIN_COMMANDS[pluginId];
  if (!cfg) {
    return { pluginId, supported: false, signedIn: null, reason: `unknown plugin: ${pluginId}` };
  }
  if (!cfg.supported) {
    return {
      pluginId,
      supported: false,
      signedIn: null,
      reason: cfg.unsupportedReason ?? `Plugin ${pluginId} is not yet implemented.`,
    };
  }
  if (cfg.statusMode !== 'file') {
    return { pluginId, supported: true, signedIn: null, reason: 'unsupported statusMode' };
  }

  const readFile = readFileImpl || ((p) => readFileSync(p, 'utf8'));
  const stat = statImpl || ((p) => statSync(p));
  const statusFiles = Array.isArray(cfg.statusFiles) && cfg.statusFiles.length > 0
    ? cfg.statusFiles
    : [cfg.statusFile];

  let raw;
  let statusFile;
  for (const candidate of statusFiles) {
    const authPath = expandHome(candidate);
    try {
      stat(authPath);
      raw = readFile(authPath);
      statusFile = candidate;
      break;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        continue;
      }
      return {
        pluginId,
        supported: true,
        signedIn: null,
        reason: err && err.message ? err.message : 'read failed',
      };
    }
  }

  if (typeof raw !== 'string') {
    return {
      pluginId,
      supported: true,
      signedIn: false,
      reason: `Not signed in (${statusFiles.join(', ')} do not exist).`,
    };
  }

  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      pluginId,
      supported: true,
      signedIn: false,
      reason: `Auth file ${statusFile} did not parse as JSON.`,
    };
  }

  return cfg.parseFileStatus(json, null, pluginId);
}

/**
 * For plugins with manualLogin: opens a terminal where supported, then
 * falls back to instructions for the operator.
 */
export function triggerAuthLogin({ pluginId, spawnImpl } = {}) {
  const cfg = PLUGIN_COMMANDS[pluginId];
  if (!cfg) {
    return { pluginId, started: false, reason: `unknown plugin: ${pluginId}` };
  }
  if (!cfg.supported) {
    return { pluginId, started: false, reason: cfg.unsupportedReason };
  }

  const spawn = spawnImpl || defaultSpawn;

  if (cfg.manualLogin) {
    const loginCmd = cfg.loginArgs ? [cfg.cli, ...cfg.loginArgs] : [cfg.cli, 'login'];

    // Try to spawn a real terminal window if possible.
    try {
      if (process.platform === 'win32') {
        // Windows: use 'start powershell' to open a new window.
        // We use -NoExit so the user can see if the CLI failed to start.
        spawn('cmd', ['/c', 'start', 'powershell', '-NoExit', '-Command', loginCmd.join(' ')], {
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        return {
          pluginId,
          started: true,
          terminalStarted: true,
          reason: `Opened powershell to run \`${loginCmd.join(' ')}\`.`,
        };
      } else if (process.platform === 'darwin') {
        // macOS: use 'open -a Terminal' to run the command in a new window.
        // Note: this requires the command to be fully qualified or on PATH.
        spawn('open', ['-a', 'Terminal', ...loginCmd], {
          detached: true,
          stdio: 'ignore',
        });
        return {
          pluginId,
          started: true,
          terminalStarted: true,
          reason: `Opened Terminal to run \`${loginCmd.join(' ')}\`.`,
        };
      }
    } catch (err) {
      console.warn(`[pluginAuth] failed to spawn terminal for ${pluginId}:`, err);
    }

    return {
      pluginId,
      started: false,
      manualLogin: true,
      cli: cfg.cli,
      reason: cfg.loginInstructions || `Sign in via the ${cfg.cli} CLI directly.`,
    };
  }
  return { pluginId, started: false, reason: 'auto-spawn login not supported for this plugin' };
}

export function triggerAuthLogout({ pluginId, spawnSyncImpl } = {}) {
  const cfg = PLUGIN_COMMANDS[pluginId];
  if (!cfg) {
    return { pluginId, loggedOut: false, reason: `unknown plugin: ${pluginId}` };
  }
  if (!cfg.supported) {
    return { pluginId, loggedOut: false, reason: cfg.unsupportedReason };
  }
  const sync = spawnSyncImpl || defaultSpawnSync;
  try {
    const result = sync(cfg.cli, cfg.logoutArgs || ['logout'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.status === 0) {
      return { pluginId, loggedOut: true };
    }
    return {
      pluginId,
      loggedOut: false,
      reason: result.stderr?.toString().trim() || `${cfg.cli} exited ${result.status}`,
    };
  } catch (err) {
    return { pluginId, loggedOut: false, reason: err && err.message ? err.message : 'spawn failed' };
  }
}

function expandHome(p) {
  if (typeof p !== 'string') return p;
  if (p.toUpperCase().startsWith('%APPDATA%')) {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    const suffix = p.slice('%APPDATA%'.length).replace(/^[\\/]+/, '');
    return path.join(appData, suffix);
  }
  if (!p.startsWith('~')) return p;
  return path.join(os.homedir(), p.slice(1));
}
