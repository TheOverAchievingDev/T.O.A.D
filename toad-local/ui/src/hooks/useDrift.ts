import { useCallback, useEffect, useRef, useState } from 'react';
import { callTool as callToadApi } from '@/api/client';

export interface DriftFinding {
  id: string;
  runId: string;
  teamId: string;
  taskId: string | null;
  category: 'architecture' | 'checklist' | 'slice_scope' | 'test_truth' | 'risk';
  severity: 'info' | 'low' | 'medium' | 'high' | 'critical';
  checkName: string;
  /**
   * PROJECT.md §8 taxonomy, server-derived from checkName:
   *   'conformance' — did the AGENTS follow the PROCESS?
   *   'drift'       — does the ARTIFACT match the SPEC? (code-vs-spec)
   * Optional for back-compat with pre-taxonomy persisted payloads.
   */
  kind?: 'conformance' | 'drift' | null;
  title: string;
  evidence: string[];
  expected: string;
  actual: string;
  recommendedCorrection: string;
  autoFixable: boolean;
  correctionTaskId?: string | null;
}

export type LlmTierStatus =
  | 'completed'
  | 'skipped:cooldown'
  | 'skipped:below_threshold'
  | 'skipped:disabled'
  | { failed: string };

export interface DriftRunResult {
  runId: string;
  asOf: string;
  teamScore: number;
  status: 'healthy' | 'watch' | 'warning' | 'critical';
  findings: DriftFinding[];
  categoryScores: Record<string, number>;
  perTaskScores: Record<string, number>;
  history: { runId: string; teamScore: number; createdAt: string }[];
  trigger: 'manual' | 'periodic' | 'task_event';
  /** Slice-2: LLM tier status per run. Optional for back-compat with
   *  older response payloads (the field is always present in slice 2+). */
  llm?: {
    tier1: LlmTierStatus;
    tier2: LlmTierStatus;
  };
}

interface UseDriftOptions {
  teamId: string | null;
  intervalMs?: number;
}

/**
 * Polls drift_run on the active team. Cadence: on-mount + every 60s
 * (matches the backend periodic ticker so the UI sees fresh data each
 * tick). Manual `refresh()` issues a `trigger: 'manual'` run that
 * bypasses the engine cache.
 */
export function useDrift({ teamId, intervalMs = 60_000 }: UseDriftOptions) {
  const [data, setData] = useState<DriftRunResult | null>(null);
  // `loading` = initial mount fetch (first paint). Drives "Loading
  // drift…" placeholders.
  const [loading, setLoading] = useState(true);
  // `refreshing` = manual user-triggered refresh in flight (separate
  // from `loading` because the operator clicking Run Drift on a screen
  // that already has data shouldn't blank the page — it should show
  // a spinner on the button + leave the prior findings visible).
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const fetchOnce = useCallback(async (
    trigger: 'manual' | 'periodic' = 'periodic',
  ): Promise<DriftRunResult | null> => {
    if (!teamId) {
      // Manual triggers MUST surface this — silently no-oping is the
      // bug the user reported on 2026-05-15 ("nothing happens when I
      // click Run Drift"). Periodic triggers stay quiet because they
      // fire on every interval tick regardless of UI state.
      if (trigger === 'manual') {
        throw new Error('No active team — pick a team before running drift.');
      }
      return null;
    }
    try {
      const res = await callToadApi({
        actor: { teamId, agentId: 'ui-client', role: 'human' },
        method: 'drift_run',
        args: { teamId, trigger },
      });
      if (cancelledRef.current) return null;
      if (res && typeof res === 'object') {
        setData(res as DriftRunResult);
        setError(null);
        return res as DriftRunResult;
      }
      return null;
    } catch (err) {
      if (!cancelledRef.current) setError(String(err));
      // Rethrow so manual callers can show an error toast — periodic
      // callers swallow via the void-call below.
      throw err;
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    // Periodic ticks: swallow errors at the caller boundary — we don't
    // want a transient network hiccup to surface as a toast every
    // 60s. The error state is still populated for any UI that wants
    // to render it inline.
    fetchOnce('periodic').catch(() => {});
    const id = window.setInterval(() => {
      fetchOnce('periodic').catch(() => {});
    }, intervalMs);
    return () => { cancelledRef.current = true; window.clearInterval(id); };
  }, [fetchOnce, intervalMs]);

  const refresh = useCallback(async (): Promise<DriftRunResult | null> => {
    setRefreshing(true);
    try {
      return await fetchOnce('manual');
    } finally {
      if (!cancelledRef.current) setRefreshing(false);
    }
  }, [fetchOnce]);

  return { data, loading, refreshing, error, refresh };
}
