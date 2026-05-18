import { spawnSync } from 'node:child_process';
import { getAuthStatus } from './providerAuth.js';

const FALLBACK_OPENCODE_FREE_MODELS = Object.freeze([
  'opencode/big-pickle',
  'opencode/deepseek-v4-flash-free',
  'opencode/minimax-m2.5-free',
  'opencode/nemotron-3-super-free',
  'opencode/qwen3.6-plus-free',
]);

export function listProviderModels({
  providerId,
  spawnSyncImpl,
  readFileImpl,
  statImpl,
} = {}) {
  if (providerId !== 'opencode') {
    return {
      providerId,
      supported: false,
      models: [],
      authenticatedProviders: [],
      reason: `dynamic model listing is not supported for provider: ${providerId}`,
    };
  }

  const auth = getAuthStatus({ providerId: 'opencode', readFileImpl, statImpl });
  const authenticatedProviders = Array.isArray(auth?.raw?.providers)
    ? auth.raw.providers.filter((p) => typeof p === 'string' && p.length > 0)
    : [];
  const authenticatedSet = new Set(authenticatedProviders.map((p) => p.toLowerCase()));

  const cli = spawnSyncImpl || spawnSync;
  const result = cli('opencode', ['models'], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    shell: process.platform === 'win32',
  });
  let degraded = false;
  let reason = null;
  let ids = [];
  if (result && !result.error && result.status === 0) {
    ids = parseModelLines(result.stdout);
  } else {
    degraded = true;
    const detail = result?.error?.message
      || (typeof result?.stderr === 'string' && result.stderr.trim())
      || 'failed';
    reason = `opencode models ${detail}`;
    ids = [...FALLBACK_OPENCODE_FREE_MODELS];
  }

  const models = [];
  const seen = new Set();
  for (const id of ids) {
    const provider = id.split('/')[0]?.toLowerCase() || '';
    const free = isFreeOpencodeModel(id);
    const authenticated = authenticatedSet.has(provider);
    if (!free && !authenticated) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      label: id,
      provider,
      free,
      authenticated,
    });
  }

  for (const id of FALLBACK_OPENCODE_FREE_MODELS) {
    if (seen.has(id)) continue;
    seen.add(id);
    models.unshift({
      id,
      label: id,
      provider: 'opencode',
      free: true,
      authenticated: false,
    });
  }

  return {
    providerId: 'opencode',
    supported: true,
    models: sortModels(models),
    authenticatedProviders,
    degraded,
    reason,
  };
}

function parseModelLines(stdout) {
  if (typeof stdout !== 'string') return [];
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[a-z0-9_.-]+\/[a-z0-9_.:-]+$/i.test(line));
}

function isFreeOpencodeModel(id) {
  return /^opencode\//i.test(id);
}

function sortModels(models) {
  return [...models].sort((a, b) => {
    if (a.free !== b.free) return a.free ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
}
