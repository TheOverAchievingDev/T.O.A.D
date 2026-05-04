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
  title: string;
  evidence: string[];
  expected: string;
  actual: string;
  recommendedCorrection: string;
  autoFixable: boolean;
}

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const fetchOnce = useCallback(async (trigger: 'manual' | 'periodic' = 'periodic') => {
    if (!teamId) return;
    try {
      const res = await callToadApi({
        actor: { teamId, agentId: 'ui-client', role: 'human' },
        method: 'drift_run',
        args: { teamId, trigger },
      });
      if (!cancelledRef.current && res && typeof res === 'object') {
        setData(res as DriftRunResult);
        setError(null);
      }
    } catch (err) {
      if (!cancelledRef.current) setError(String(err));
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [teamId]);

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    void fetchOnce('periodic');
    const id = window.setInterval(() => { void fetchOnce('periodic'); }, intervalMs);
    return () => { cancelledRef.current = true; window.clearInterval(id); };
  }, [fetchOnce, intervalMs]);

  return { data, loading, error, refresh: () => fetchOnce('manual') };
}
