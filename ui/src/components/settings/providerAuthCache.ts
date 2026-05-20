import { callTool, type Actor } from '@/api/client';
import type { AuthStatus, ProviderId } from './ProviderPlanAuth';

// Module-level cache so ProvidersSettings (which probes all four providers
// to decide which auth-mode toggles to show) and ProviderPlanAuth (which
// renders the live status badge for the currently-selected plan-auth
// provider) don't double-fetch on mount. After a login/logout, we
// refresh in-place and notify every subscriber so the toggle row and the
// badge stay in sync.

const ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };

type Status = AuthStatus | null;

const cache = new Map<ProviderId, Status>();
const inflight = new Map<ProviderId, Promise<Status>>();
const listeners = new Map<ProviderId, Set<(status: Status) => void>>();

function notify(id: ProviderId) {
  const set = listeners.get(id);
  if (!set) return;
  const value = cache.get(id) ?? null;
  for (const cb of set) cb(value);
}

async function fetchStatus(id: ProviderId): Promise<Status> {
  try {
    const res = await callTool<AuthStatus>({
      actor: ACTOR,
      method: 'provider_auth_status',
      args: { providerId: id },
    });
    return res;
  } catch {
    return null;
  }
}

/** Returns whatever is cached right now without triggering a fetch. */
export function getCachedStatus(id: ProviderId): Status {
  return cache.get(id) ?? null;
}

/** Read the status, using the cache when available. Pass `force: true` to
 *  bypass the cache and refetch (used after login/logout). All subscribers
 *  are notified once the value lands. */
export function loadStatus(id: ProviderId, opts: { force?: boolean } = {}): Promise<Status> {
  if (!opts.force && cache.has(id)) {
    return Promise.resolve(cache.get(id) ?? null);
  }
  const existing = inflight.get(id);
  if (existing && !opts.force) return existing;
  const promise = fetchStatus(id).then((value) => {
    cache.set(id, value);
    inflight.delete(id);
    notify(id);
    return value;
  });
  inflight.set(id, promise);
  return promise;
}

/** Fetch all four providers in parallel, deduped through `loadStatus`. */
export function loadAllStatuses(ids: ProviderId[], opts: { force?: boolean } = {}): Promise<Status[]> {
  return Promise.all(ids.map((id) => loadStatus(id, opts)));
}

/** Subscribe to status changes for a provider. Returns unsubscribe. */
export function subscribeStatus(id: ProviderId, cb: (status: Status) => void): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(id);
  };
}

/** Test/devtools helper — reset all cached state. Not part of the public API. */
export function __resetProviderAuthCache(): void {
  cache.clear();
  inflight.clear();
  listeners.clear();
}
