import { useCallback, useEffect, useRef, useState } from 'react';
import { callTool, ToadApiError, type Actor } from '@/api/client';

export type SettingsScope = 'global' | 'project' | 'effective';

export interface SettingsPayload {
  general?: Record<string, unknown>;
  providers?: Record<string, unknown>;
  github?: Record<string, unknown>;
  workspace?: Record<string, unknown>;
  risk?: Record<string, unknown>;
  mcp?: Record<string, unknown>;
  notifications?: Record<string, unknown>;
  advanced?: Record<string, unknown>;
  /** Per-section provenance: 'global' | 'project'. Synthetic. */
  _sources?: Record<string, 'global' | 'project'>;
  [section: string]: unknown;
}

interface UseSettingsResult {
  /** Effective merged settings (global ⊕ project). */
  settings: SettingsPayload;
  /** Per-scope file paths the backend reported. */
  paths: { global: string | null; project: string | null };
  loading: boolean;
  error: string | null;
  /** Last sync timestamp in ms. */
  lastSyncedAt: number | null;
  /** Manually refetch settings. */
  refresh: () => void;
  /** Write one section to the chosen scope. Refreshes effective on success. */
  setSection: (input: { scope: 'global' | 'project'; section: string; value: Record<string, unknown> }) => Promise<void>;
}

const DEFAULT_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };

/**
 * Reads the merged effective settings from the backend (`settings_get`) and
 * exposes a `setSection` writer that calls `settings_set`. Designed to mirror
 * the local-only `useTweaks` hook so each settings-tab component can swap
 * between them without changing its prop signature.
 */
export function useSettings(actor: Actor = DEFAULT_ACTOR): UseSettingsResult {
  const [settings, setSettings] = useState<SettingsPayload>({});
  const [paths, setPaths] = useState<{ global: string | null; project: string | null }>({ global: null, project: null });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const refreshNonceRef = useRef(0);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const refresh = useCallback(() => {
    refreshNonceRef.current += 1;
    setRefreshNonce(refreshNonceRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();

    async function load() {
      try {
        setLoading(true);
        setError(null);
        const result = await callTool<{
          settings: SettingsPayload;
          paths?: { global?: string | null; project?: string | null };
        }>({
          actor,
          method: 'settings_get',
          args: {},
          signal: ac.signal,
        });
        if (cancelled) return;
        setSettings(result.settings ?? {});
        setPaths({
          global: result.paths?.global ?? null,
          project: result.paths?.project ?? null,
        });
        setLastSyncedAt(Date.now());
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof ToadApiError ? err.message
          : err instanceof Error ? err.message
          : 'Failed to load settings';
        setError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [actor, refreshNonce]);

  const setSection = useCallback<UseSettingsResult['setSection']>(async ({ scope, section, value }) => {
    setError(null);
    try {
      await callTool({
        actor,
        method: 'settings_set',
        args: { scope, section, value },
        idempotencyKey: `settings-set-${scope}-${section}-${Date.now()}`,
      });
      refresh();
    } catch (err) {
      const message = err instanceof ToadApiError ? err.message
        : err instanceof Error ? err.message
        : 'Failed to save settings';
      setError(message);
      throw err;
    }
  }, [actor, refresh]);

  return { settings, paths, loading, error, lastSyncedAt, refresh, setSection };
}
