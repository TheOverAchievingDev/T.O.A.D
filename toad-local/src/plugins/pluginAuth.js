import { readFileSync, statSync } from 'node:fs';
import { spawnSync as defaultSpawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_COMMANDS } from './pluginRegistry.js';

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
  const authPath = expandHome(cfg.statusFile);

  let raw;
  try {
    stat(authPath);
    raw = readFile(authPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        pluginId,
        supported: true,
        signedIn: false,
        reason: `Not signed in (${cfg.statusFile} does not exist).`,
      };
    }
    return {
      pluginId,
      supported: true,
      signedIn: null,
      reason: err && err.message ? err.message : 'read failed',
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
      reason: `Auth file ${cfg.statusFile} did not parse as JSON.`,
    };
  }

  return cfg.parseFileStatus(json, null, pluginId);
}

/**
 * For plugins with manualLogin: returns instructions for the operator
 * to follow at the terminal. (Symphony does not auto-spawn `railway
 * login` because it opens a browser tab and we don't want unattended
 * processes blocking on user interaction.)
 */
export function triggerAuthLogin({ pluginId } = {}) {
  const cfg = PLUGIN_COMMANDS[pluginId];
  if (!cfg) {
    return { pluginId, started: false, reason: `unknown plugin: ${pluginId}` };
  }
  if (!cfg.supported) {
    return { pluginId, started: false, reason: cfg.unsupportedReason };
  }
  if (cfg.manualLogin) {
    return {
      pluginId,
      started: false,
      manualLogin: true,
      cli: cfg.cli,
      reason: cfg.loginInstructions || `Sign in via the ${cfg.cli} CLI directly.`,
    };
  }
  return { pluginId, started: false, reason: 'auto-spawn login not supported in slice 1' };
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
  if (typeof p !== 'string' || !p.startsWith('~')) return p;
  return path.join(os.homedir(), p.slice(1));
}
