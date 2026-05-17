import { useCallback, useEffect, useRef, useState } from 'react';
import { callTool, type Actor } from '@/api/client';

export interface SpanSummaryRow {
  spanId: string;
  teamId?: string;
  runtimeId?: string;
  agentId?: string;
  sessionId?: string;
  summaryText: string;
  model?: string | null;
  cli?: string | null;
  spanStartedAt?: string;
  spanEndedAt?: string;
  rowCount?: number;
  tokens?: number | null;
  createdAt?: string;
}

export interface SummaryStatus {
  state: 'idle' | 'summarizing' | 'rate-limited' | 'degraded' | 'unavailable';
  lastRunAt: number | null;
  lastDurationMs: number;
  teamsPolled: number;
  summarizedCount: number;
  degradedCount: number;
  skippedRateLimited: number;
  lastReasons: string[];
}

export interface UseSpanSummaries {
  spanSummaries: SpanSummaryRow[];
  summaryStatus: SummaryStatus | null;
  error: string | null;
  refresh: () => void;
}

const STATUS_POLL_MS = 30_000;

export function useSpanSummaries(activeTeamId: string | null = null): UseSpanSummaries {
  const [spanSummaries, setSpanSummaries] = useState<SpanSummaryRow[]>([]);
  const [summaryStatus, setSummaryStatus] = useState<SummaryStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshNonceRef = useRef(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const refresh = useCallback(() => {
    refreshNonceRef.current += 1;
    setRefreshNonce(refreshNonceRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    // Sibling-hook actor (does NOT import useToadData's POLL_ACTOR —
    // Approach A keeps them decoupled). span_summary_list is team-scoped
    // by actor.teamId; a non-matching team → P3c-1 returns [] (no throw).
    const actor: Actor = {
      teamId: activeTeamId ?? 'default',
      agentId: 'ui-client',
      agentName: 'ui',
    };

    async function loadList() {
      try {
        const res = await callTool<{ summaries?: SpanSummaryRow[] }>({
          actor, method: 'span_summary_list', args: {}, signal: ac.signal,
        });
        if (cancelled) return;
        setSpanSummaries(Array.isArray(res?.summaries) ? res.summaries : []);
      } catch (e) {
        if (cancelled || ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    async function loadStatus() {
      try {
        const res = await callTool<SummaryStatus>({
          actor, method: 'span_summary_status', args: {}, signal: ac.signal,
        });
        if (cancelled) return;
        if (res && typeof res === 'object' && typeof res.state === 'string') {
          setSummaryStatus(res);
        }
      } catch (e) {
        if (cancelled || ac.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
      }
    }

    setError(null);
    void loadList();
    void loadStatus();
    const statusTimer = setInterval(() => { void loadStatus(); }, STATUS_POLL_MS);

    return () => {
      cancelled = true;
      ac.abort();
      clearInterval(statusTimer);
    };
  }, [activeTeamId, refreshNonce]);

  return { spanSummaries, summaryStatus, error, refresh };
}
