import { useEffect, useMemo, useState } from 'react';
import type { Team } from '@/types';
import { Icon, type IconName } from './Icon';
import { roleStyle } from '@/data/roles';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import { useToadEvents, type RuntimeEvent } from '@/api/events';

interface AuditEvent {
  id?: string | number;
  eventId?: string;
  type?: string;
  eventType?: string;
  taskId?: string;
  runtimeId?: string;
  actorId?: string;
  agentId?: string;
  createdAt?: string;
  payload?: Record<string, unknown> | null;
  _source?: 'task' | 'runtime';
}

interface AuditQueryResult {
  events: AuditEvent[];
  hasMore: boolean;
  cap: number;
  sinceMs: number | null;
}

interface AuditLogScreenProps {
  team: Team;
  onOpenTask?: (taskId: string) => void;
  onOpenLogs?: (runtimeId: string) => void;
}

type SourceFilter = 'all' | 'task' | 'runtime';
type TimeWindow = '1h' | '24h' | '7d' | 'all';

const DEFAULT_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };

const WINDOW_LABELS: Record<TimeWindow, string> = {
  '1h': 'Last 1 hour',
  '24h': 'Last 24 hours',
  '7d': 'Last 7 days',
  all: 'All time',
};

function windowToSinceMs(w: TimeWindow): number | null {
  const now = Date.now();
  switch (w) {
    case '1h': return now - 60 * 60 * 1000;
    case '24h': return now - 24 * 60 * 60 * 1000;
    case '7d': return now - 7 * 24 * 60 * 60 * 1000;
    case 'all': return null;
  }
}

function eventKey(e: AuditEvent, fallback: number): string {
  return String(e.eventId ?? e.id ?? `${e.type ?? e.eventType}-${e.createdAt ?? fallback}`);
}

function eventLabel(e: AuditEvent): string {
  return String(e.eventType ?? e.type ?? 'event');
}

function eventColor(e: AuditEvent): { color: string; bg: string; bd: string } {
  const label = eventLabel(e).toLowerCase();
  if (label.includes('error') || label.includes('rejected')) {
    return { color: 'oklch(0.78 0.20 25)', bg: 'oklch(0.30 0.10 25 / 0.4)', bd: 'oklch(0.55 0.18 25 / 0.4)' };
  }
  if (label.includes('approved') || label.includes('merged') || label.includes('done') || label.includes('completed')) {
    return { color: 'oklch(0.82 0.15 145)', bg: 'oklch(0.30 0.06 145 / 0.4)', bd: 'oklch(0.55 0.10 145 / 0.4)' };
  }
  if (label.includes('risk_classified') || label.includes('human_approved') || label.includes('stuck')) {
    return { color: 'oklch(0.85 0.14 80)', bg: 'oklch(0.30 0.06 80 / 0.4)', bd: 'oklch(0.55 0.10 80 / 0.4)' };
  }
  if (e._source === 'task') {
    return { color: 'oklch(0.85 0.10 245)', bg: 'oklch(0.30 0.04 245 / 0.4)', bd: 'oklch(0.55 0.08 245 / 0.30)' };
  }
  return { color: 'var(--fg-muted)', bg: 'rgba(255,255,255,0.03)', bd: 'var(--border-soft, rgba(255,255,255,0.08))' };
}

function formatDateTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function payloadPreview(payload: AuditEvent['payload']): string {
  if (!payload || typeof payload !== 'object') return '';
  const p = payload as Record<string, unknown>;
  if (typeof p.text === 'string') return p.text.slice(0, 240);
  if (typeof p.body === 'string') return p.body.slice(0, 240);
  if (typeof p.message === 'string') return p.message.slice(0, 240);
  if (typeof p.toolName === 'string') return `${p.toolName}(…)`;
  if (typeof p.fromStatus === 'string' && typeof p.toStatus === 'string') {
    return `${p.fromStatus} → ${p.toStatus}`;
  }
  if (typeof p.title === 'string') return p.title;
  try {
    return JSON.stringify(p).slice(0, 240);
  } catch {
    return '';
  }
}

export function AuditLogScreen({ team, onOpenTask, onOpenLogs }: AuditLogScreenProps) {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowKey, setWindowKey] = useState<TimeWindow>('24h');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [search, setSearch] = useState('');
  const [followLive, setFollowLive] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await callTool<AuditQueryResult>({
        actor: DEFAULT_ACTOR,
        method: 'audit_log_query',
        args: {
          limit: 500,
          ...(windowToSinceMs(windowKey) ? { sinceMs: windowToSinceMs(windowKey) } : {}),
        },
      });
      setEvents(Array.isArray(result?.events) ? result.events : []);
      setHasMore(result?.hasMore === true);
    } catch (err) {
      setError(err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Failed to load audit log'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey]);

  // Live append from SSE — only when "follow" is on.
  useToadEvents({
    onEvent: (event: RuntimeEvent) => {
      if (!followLive) return;
      setEvents((prev) => [
        {
          id: typeof event.id === 'string' || typeof event.id === 'number' ? event.id : Date.now(),
          type: typeof event.type === 'string' ? event.type : '',
          runtimeId: typeof event.runtimeId === 'string' ? event.runtimeId : undefined,
          actorId: typeof event.agentId === 'string' ? event.agentId : undefined,
          createdAt: typeof event.createdAt === 'string' ? event.createdAt : new Date().toISOString(),
          payload: (event.payload as Record<string, unknown> | undefined) ?? {},
          _source: 'runtime',
        },
        ...prev,
      ]);
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return events.filter((e) => {
      if (sourceFilter !== 'all' && e._source !== sourceFilter) return false;
      if (!q) return true;
      const hay = [
        eventLabel(e),
        e.taskId ?? '',
        e.runtimeId ?? '',
        e.actorId ?? e.agentId ?? '',
        payloadPreview(e.payload),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [events, sourceFilter, search]);

  const counts = useMemo(() => ({
    all: events.length,
    task: events.filter((e) => e._source === 'task').length,
    runtime: events.filter((e) => e._source === 'runtime').length,
  }), [events]);

  return (
    <main className="ws-main" style={{ overflow: 'hidden' }}>
      <div className="ws-main-header">
        <div className="team-title">
          <h1>Audit log</h1>
          <span className="team-meta mono">· {team.name}</span>
          <span className="dim mono" style={{ fontSize: 11 }}>
            {filtered.length} of {events.length} shown {hasMore && '· capped at 500'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            className="search-input"
            placeholder="Search events…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ width: 220 }}
          />
          <select
            className="field-input"
            value={windowKey}
            onChange={(e) => setWindowKey(e.target.value as TimeWindow)}
            style={{ width: 140, fontSize: 12 }}
          >
            {(Object.keys(WINDOW_LABELS) as TimeWindow[]).map((k) => (
              <option key={k} value={k}>{WINDOW_LABELS[k]}</option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => void load()}
            disabled={loading}
          >
            <Icon name="play" size={11} /> {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      <div
        style={{
          padding: '8px 24px',
          borderBottom: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
          display: 'flex',
          gap: 8,
          alignItems: 'center',
        }}
      >
        <div className="seg">
          {(['all', 'task', 'runtime'] as SourceFilter[]).map((s) => (
            <button
              key={s}
              type="button"
              className={sourceFilter === s ? 'active' : ''}
              onClick={() => setSourceFilter(s)}
            >
              {s === 'all' ? 'All' : s[0].toUpperCase() + s.slice(1)}
              <span className="dim" style={{ marginLeft: 4 }}>
                {counts[s]}
              </span>
            </button>
          ))}
        </div>
        <label
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            fontSize: 11,
            color: 'var(--fg-muted)',
            cursor: 'pointer',
            marginLeft: 'auto',
          }}
        >
          <input
            type="checkbox"
            checked={followLive}
            onChange={(e) => setFollowLive(e.target.checked)}
          />
          Follow live
        </label>
      </div>

      {error && (
        <div
          style={{
            padding: '8px 24px',
            background: 'oklch(0.30 0.06 25 / 0.4)',
            color: 'oklch(0.86 0.10 25)',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      <div className="ws-main-body" style={{ padding: '16px 24px 32px' }}>
        {filtered.length === 0 && (
          <div className="dim" style={{ padding: '40px 0', textAlign: 'center', fontSize: 13 }}>
            {events.length === 0
              ? 'No events in the selected time window.'
              : 'No events match the current search/filter.'}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {filtered.map((e, i) => {
            const colors = eventColor(e);
            const member = e.actorId
              ? team.members.find((m) => m.id === e.actorId)
              : (e.agentId ? team.members.find((m) => m.id === e.agentId) : null);
            const memberRole = member?.role ?? 'developer';
            return (
              <div
                key={eventKey(e, i)}
                style={{
                  ...roleStyle(memberRole),
                  display: 'grid',
                  gridTemplateColumns: '120px 100px auto 1fr auto',
                  alignItems: 'center',
                  gap: 10,
                  padding: '8px 10px',
                  background: colors.bg,
                  border: `1px solid ${colors.bd}`,
                  borderRadius: 6,
                  fontSize: 12,
                }}
              >
                <span className="mono dim" style={{ fontSize: 10.5 }}>
                  {formatDateTime(e.createdAt)}
                </span>
                <span
                  className="chip mono"
                  style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    background: 'rgba(255,255,255,0.06)',
                    color: colors.color,
                    borderColor: colors.bd,
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    fontWeight: 600,
                    textAlign: 'center',
                  }}
                >
                  {e._source}
                </span>
                <span className="mono" style={{ fontSize: 11, color: colors.color }}>
                  {eventLabel(e)}
                </span>
                <div style={{ minWidth: 0, color: 'var(--fg)' }}>
                  {member && (
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{member.name}</span>
                  )}
                  {!member && (e.actorId || e.agentId) && (
                    <span className="mono dim">{e.actorId ?? e.agentId}</span>
                  )}
                  <span
                    className="dim"
                    style={{
                      marginLeft: member || e.actorId || e.agentId ? 8 : 0,
                      fontSize: 11,
                    }}
                  >
                    {payloadPreview(e.payload)}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {e.taskId && onOpenTask && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => onOpenTask(e.taskId!)}
                      title="Open task detail"
                    >
                      <Icon name="eye" size={10} /> {e.taskId}
                    </button>
                  )}
                  {e.runtimeId && onOpenLogs && (
                    <button
                      type="button"
                      className="btn btn-sm btn-ghost"
                      onClick={() => onOpenLogs(e.runtimeId!)}
                      title="Open runtime logs"
                    >
                      <Icon name="terminal" size={10} />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
