import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import { useToadEvents, type RuntimeEvent } from '@/api/events';

interface LogViewerDrawerProps {
  runtimeId: string;
  /** Optional friendly title shown in the header — usually the agent name. */
  title?: string;
  onClose: () => void;
  actor?: Actor;
  /** Optional pre-loaded runtime row so we can render metadata chips
   *  (model, uptime, reqs) without an extra fetch. */
  runtime?: {
    id: string;
    agent: string;
    provider: string;
    model: string;
    pid: number;
    status: string;
    uptime?: string;
    reqs?: number;
    tokensIn?: number;
    tokensOut?: number;
  };
  /** Refresh the parent's data after a Stop action lands. */
  onAfterAction?: () => void;
}

interface AuditEvent {
  id?: string | number;
  runtimeId?: string;
  type?: string;
  eventType?: string;
  createdAt?: string;
  payload?: Record<string, unknown> | null;
}

type Tab = 'timeline' | 'stdout';
type Filter = 'all' | 'tools' | 'output' | 'errors';

const DEFAULT_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };

const FILTER_LABELS: Record<Filter, string> = {
  all: 'All',
  tools: 'Tool calls',
  output: 'Output',
  errors: 'Errors',
};

function classifyEvent(e: AuditEvent): Filter {
  const type = String(e.type ?? e.eventType ?? '').toLowerCase();
  if (type === 'tool_use' || type.includes('tool_call') || type.includes('tool_use')) return 'tools';
  if (type.includes('error')) return 'errors';
  return 'output';
}

function eventTitle(e: AuditEvent): string {
  const type = String(e.type ?? e.eventType ?? 'event');
  return type;
}

function formatPayload(payload: AuditEvent['payload']): string {
  if (!payload) return '';
  if (typeof payload === 'string') return payload;
  if (typeof payload !== 'object') return String(payload);
  // Common payload shapes — prefer human-readable fields first.
  const p = payload as Record<string, unknown>;
  if (typeof p.text === 'string') return p.text;
  if (typeof p.body === 'string') return p.body;
  if (typeof p.message === 'string') return p.message;
  if (p.toolName && typeof p.toolName === 'string') {
    const args = p.toolInput ?? p.input ?? p.args;
    return `${p.toolName}(${typeof args === 'object' && args ? JSON.stringify(args).slice(0, 240) : ''})`;
  }
  try {
    return JSON.stringify(p, null, 2).slice(0, 1000);
  } catch {
    return String(p);
  }
}

function formatTime(iso?: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '';
  }
}

export function LogViewerDrawer({ runtimeId, title, onClose, actor = DEFAULT_ACTOR, runtime, onAfterAction }: LogViewerDrawerProps) {
  const [tab, setTab] = useState<Tab>('timeline');
  const [filter, setFilter] = useState<Filter>('all');
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoFollow, setAutoFollow] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  async function stopRuntime() {
    if (stopping) return;
    setStopping(true);
    setStopError(null);
    try {
      await callTool({
        actor,
        method: 'agent_stop',
        args: { runtimeId },
        idempotencyKey: `stop-${runtimeId}-${Date.now()}`,
      });
      onAfterAction?.();
    } catch (err) {
      const m = err instanceof ToadApiError ? err.message
        : err instanceof Error ? err.message
        : 'Failed to stop runtime';
      setStopError(m);
    } finally {
      setStopping(false);
    }
  }

  const isLive = runtime?.status === 'live' || runtime?.status === 'running' || runtime?.status === 'launching';

  // Initial fetch + manual refresh.
  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await callTool<{ events?: AuditEvent[] } | AuditEvent[]>({
        actor,
        method: 'runtime_events',
        args: { runtimeId },
      });
      const events = Array.isArray(result) ? result : result?.events;
      setEvents(Array.isArray(events) ? events : []);
    } catch (err) {
      setError(err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Failed to load logs'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runtimeId]);

  // Live append from SSE stream.
  useToadEvents({
    onEvent: (event: RuntimeEvent) => {
      if (String(event.runtimeId ?? '') !== runtimeId) return;
      setEvents((prev) => [...prev, {
        id: typeof event.id === 'string' || typeof event.id === 'number' ? event.id : prev.length + 1,
        runtimeId: String(event.runtimeId),
        type: String(event.type ?? ''),
        createdAt: typeof event.createdAt === 'string' ? event.createdAt : new Date().toISOString(),
        payload: (event.payload as Record<string, unknown> | undefined) ?? {},
      }]);
    },
  });

  // Auto-scroll on new events when follow mode is on.
  useEffect(() => {
    if (!autoFollow) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, autoFollow]);

  // Toggle auto-follow off when the user scrolls up.
  function handleScroll() {
    const el = bodyRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    if (!atBottom && autoFollow) setAutoFollow(false);
    else if (atBottom && !autoFollow) setAutoFollow(true);
  }

  const filtered = useMemo(() => {
    if (filter === 'all') return events;
    return events.filter((e) => classifyEvent(e) === filter);
  }, [events, filter]);

  const stdoutText = useMemo(() => {
    return events
      .map((e) => {
        const time = formatTime(e.createdAt);
        const head = `[${time}] ${eventTitle(e)}`;
        const body = formatPayload(e.payload);
        return body ? `${head}\n${body}` : head;
      })
      .join('\n\n');
  }, [events]);

  const counts = useMemo(() => ({
    all: events.length,
    tools: events.filter((e) => classifyEvent(e) === 'tools').length,
    output: events.filter((e) => classifyEvent(e) === 'output').length,
    errors: events.filter((e) => classifyEvent(e) === 'errors').length,
  }), [events]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div
        className="drawer notif-drawer"
        onClick={(e) => e.stopPropagation()}
        style={{ width: 'min(640px, 100vw)' }}
      >
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
            <Icon name="terminal" size={15} />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                Logs · {title ?? runtimeId}
              </div>
              <div className="dim mono" style={{ fontSize: 10.5 }}>{runtimeId}</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => void load()}
              disabled={loading}
              title="Refresh"
            >
              <Icon name="play" size={11} /> {loading ? 'Loading…' : 'Refresh'}
            </button>
            <button type="button" className="icon-btn" onClick={onClose}>
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        {/* Runtime metadata chips — populated from the runtime row when the
            parent passes it in. Each chip is a small reified data point so
            the operator can inspect a runtime without leaving the drawer. */}
        {runtime ? (
          <div style={{
            display: 'flex', gap: 8, padding: '8px 16px',
            borderBottom: '1px solid var(--border-soft)',
            fontSize: 11, color: 'var(--fg-muted)', flexWrap: 'wrap',
            alignItems: 'center',
          }}>
            <span className="chip" style={{ fontSize: 10.5, fontWeight: 600 }}>{runtime.provider}</span>
            <span className="mono">{runtime.model}</span>
            <span style={{ color: 'var(--fg-dim)' }}>·</span>
            <span><span className="mono" style={{ color: 'var(--fg)' }}>{runtime.uptime ?? '00:00:00'}</span> uptime</span>
            <span style={{ color: 'var(--fg-dim)' }}>·</span>
            <span><span className="mono" style={{ color: 'var(--fg)' }}>{runtime.reqs ?? 0}</span> reqs</span>
            {runtime.pid > 0 ? (
              <>
                <span style={{ color: 'var(--fg-dim)' }}>·</span>
                <span className="mono dim">pid {runtime.pid}</span>
              </>
            ) : null}
            <span style={{ marginLeft: 'auto' }}>
              <span className={`status-dot ${runtime.status === 'live' || runtime.status === 'running' ? 'live' : runtime.status}`} style={{ marginRight: 4 }} />
              <span style={{ textTransform: 'capitalize', fontWeight: 600, color: 'var(--fg)' }}>{runtime.status}</span>
            </span>
          </div>
        ) : null}

        <div style={{ padding: '8px 16px', borderBottom: '1px solid var(--border-soft)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="seg">
            <button
              type="button"
              className={tab === 'timeline' ? 'active' : ''}
              onClick={() => setTab('timeline')}
            >
              Timeline
            </button>
            <button
              type="button"
              className={tab === 'stdout' ? 'active' : ''}
              onClick={() => setTab('stdout')}
            >
              Stdout
            </button>
          </div>
          {tab === 'timeline' && (
            <div className="seg">
              {(Object.keys(FILTER_LABELS) as Filter[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  className={filter === f ? 'active' : ''}
                  onClick={() => setFilter(f)}
                >
                  {FILTER_LABELS[f]} <span className="dim" style={{ marginLeft: 4 }}>{counts[f]}</span>
                </button>
              ))}
            </div>
          )}
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
            title="When on, the view auto-scrolls as new events arrive."
          >
            <input
              type="checkbox"
              checked={autoFollow}
              onChange={(e) => setAutoFollow(e.target.checked)}
            />
            Follow
          </label>
        </div>

        {error && (
          <div
            style={{
              padding: '8px 12px',
              background: 'oklch(0.30 0.06 25 / 0.4)',
              color: 'oklch(0.86 0.10 25)',
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <div
          ref={bodyRef}
          onScroll={handleScroll}
          className="notif-body-scroll"
          style={{ flex: 1, overflowY: 'auto' }}
        >
          {tab === 'timeline' ? (
            <TimelineView events={filtered} />
          ) : (
            <StdoutView text={stdoutText} />
          )}
        </div>

        {/* Action toolbar: Stop the runtime when it's live, and any
            transient stop-error messaging. Stop calls agent_stop and
            asks the parent to refresh after — the row will flip to
            "stopped" and the dot animation will clear. */}
        <div style={{
          padding: '10px 14px',
          borderTop: '1px solid var(--border-soft)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          {stopError ? (
            <span style={{ fontSize: 11, color: 'var(--err, #f87171)', flex: 1 }}>{stopError}</span>
          ) : (
            <span style={{ flex: 1 }} />
          )}
          {isLive ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => void stopRuntime()}
              disabled={stopping}
              style={{ color: 'var(--danger, #f87171)' }}
              title="Send SIGTERM to this runtime (agent_stop)"
            >
              <Icon name="x" size={11} /> {stopping ? 'Stopping…' : 'Stop runtime'}
            </button>
          ) : (
            <span className="dim" style={{ fontSize: 11 }}>Runtime is not live — relaunch the team to restart.</span>
          )}
        </div>
      </div>
    </div>
  );
}

function TimelineView({ events }: { events: AuditEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="dim" style={{ padding: '40px 20px', textAlign: 'center', fontSize: 12 }}>
        No events match the current filter.
      </div>
    );
  }
  return (
    <div style={{ padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      {events.map((e, i) => {
        const kind = classifyEvent(e);
        const color = kind === 'errors' ? 'var(--err, #e5484d)'
          : kind === 'tools' ? 'oklch(0.78 0.14 80)'
          : 'var(--fg-muted)';
        return (
          <div
            key={(e.id ?? i).toString()}
            style={{
              padding: '8px 10px',
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
              borderRadius: 6,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <span className="mono dim">{formatTime(e.createdAt)}</span>
              <span className="mono" style={{ color, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                {eventTitle(e)}
              </span>
            </div>
            <pre
              style={{
                margin: 0,
                fontFamily: 'var(--font-mono, monospace)',
                fontSize: 11,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: 'var(--fg)',
                lineHeight: 1.4,
              }}
            >
              {formatPayload(e.payload)}
            </pre>
          </div>
        );
      })}
    </div>
  );
}

function StdoutView({ text }: { text: string }) {
  if (!text) {
    return (
      <div className="dim" style={{ padding: '40px 20px', textAlign: 'center', fontSize: 12 }}>
        No output yet.
      </div>
    );
  }
  return (
    <pre
      className="mono"
      style={{
        margin: 0,
        padding: '12px 16px',
        fontSize: 11.5,
        lineHeight: 1.5,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--fg)',
      }}
    >
      {text}
    </pre>
  );
}
