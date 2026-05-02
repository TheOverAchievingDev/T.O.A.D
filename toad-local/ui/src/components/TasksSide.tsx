import { useEffect, useMemo, useState } from 'react';
import type { Team, UiTask, Runtime, TaskStatus } from '@/types';
import { roleStyle } from '@/data/roles';
import { Icon } from './Icon';
import { EmptyTasksState } from './EmptyTasksState';

interface TasksSideProps {
  team: Team;
  tasks: UiTask[];
  runtimes: Runtime[];
  onOpenTask?: (id: string) => void;
  onCreateTask?: () => void;
}

type SideTab = 'tasks' | 'runtimes' | 'sessions' | 'files';

const PROVIDER_COLOR: Record<string, string> = {
  anthropic: 'var(--clay)',
  openai: 'oklch(0.70 0.13 165)',
  opencode: 'oklch(0.70 0.13 250)',
  gemini: 'oklch(0.74 0.13 80)',
};

const ACTIVE_STATUSES: TaskStatus[] = ['in-progress', 'todo', 'review', 'done'];

export function TasksSide({ team, tasks, runtimes, onOpenTask, onCreateTask }: TasksSideProps) {
  const [tab, setTab] = useState<SideTab>('tasks');

  useEffect(() => {
    const h = () => setTab('runtimes');
    window.addEventListener('toad:open-runtimes', h);
    return () => window.removeEventListener('toad:open-runtimes', h);
  }, []);

  const grouped = useMemo(() => {
    const g: Record<TaskStatus, UiTask[]> = {
      'todo': [], 'in-progress': [], 'review': [], 'done': [], 'blocked': [], 'rejected': [],
    };
    tasks.forEach((t) => {
      if (g[t.status]) g[t.status].push(t);
    });
    return g;
  }, [tasks]);

  return (
    <>
      <div className="side-tabs">
        <button className={`side-tab ${tab === 'tasks' ? 'active' : ''}`} onClick={() => setTab('tasks')}>Tasks</button>
        <button className={`side-tab ${tab === 'runtimes' ? 'active' : ''}`} onClick={() => setTab('runtimes')}>
          Runtimes
          <span style={{ marginLeft: 6, fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', background: 'var(--bg-input)', padding: '1px 5px', borderRadius: 4 }}>{runtimes.length}</span>
        </button>
        <button className={`side-tab ${tab === 'sessions' ? 'active' : ''}`} onClick={() => setTab('sessions')}>Sessions</button>
        <button className={`side-tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>Files</button>
        <button className="icon-btn" style={{ marginLeft: 'auto', marginBottom: 4 }} title="Filter"><Icon name="settings" size={13} /></button>
      </div>
      <div className="side-search">
        <input className="search-input" placeholder={tab === 'runtimes' ? 'Search runtimes…' : 'Search tasks…'} />
      </div>
      <div className="task-list">
        {tab === 'tasks' && tasks.length === 0 && (
          <EmptyTasksState
            variant="compact"
            title="No tasks yet"
            body="Create the first one to populate this rail."
            ctaLabel="Create task"
            onCta={onCreateTask}
          />
        )}
        {tab === 'tasks' && tasks.length > 0 && ACTIVE_STATUSES.map((status) => (
          <div key={status} style={{ marginBottom: 14 }}>
            <div className="sticky-section-head">
              <span className="section-label">{status === 'in-progress' ? 'In progress' : status}</span>
              <span className="count-pill">{grouped[status].length}</span>
            </div>
            {grouped[status].map((t) => {
              const member = team.members.find((m) => m.id === t.assignee);
              return (
                <div key={t.id} className="task-row" onClick={() => onOpenTask?.(t.id)}>
                  <div className="task-row-head">
                    <span className="task-id">{t.id}</span>
                    {status === 'done' && <Icon name="check" size={11} style={{ color: 'var(--ok)' }} />}
                    {status === 'in-progress' && <span className="status-dot live" />}
                  </div>
                  <div className="task-title">{t.title}</div>
                  <div className="task-foot">
                    {member && (
                      <span style={roleStyle(member.role)}>
                        <span style={{ color: 'var(--accent)' }}>● {member.name}</span>
                      </span>
                    )}
                    <span style={{ marginLeft: 'auto' }}>{t.project}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ))}

        {tab === 'runtimes' && <RuntimesPanel runtimes={runtimes} team={team} />}

        {tab === 'sessions' && (
          <div style={{ padding: '0 4px', fontSize: 12, color: 'var(--fg-muted)' }}>
            <div className="sticky-section-head">
              <span className="status-dot live" />
              <span className="section-label">Active</span>
              <span className="count-pill">{team.members.filter((m) => m.status !== 'idle').length}</span>
            </div>
            <div style={{ padding: '4px 4px 0' }}>
              {team.members.filter((m) => m.status !== 'idle').map((m) => (
                <div key={m.id} style={{ ...roleStyle(m.role), padding: '8px 10px', borderRadius: 8, marginBottom: 6, background: 'var(--bg-hover)', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="status-dot live" />
                  <span style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 12 }}>{m.name}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--fg-dim)', marginLeft: 'auto' }}>pid 32{800 + m.tokens % 99}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'files' && (
          <div style={{ padding: 12, fontSize: 12, color: 'var(--fg-muted)' }}>
            <div className="mono" style={{ fontSize: 11.5 }}>
              <div style={{ padding: '4px 8px' }}>📄 src/audio/stream.ts</div>
              <div style={{ padding: '4px 8px' }}>📄 src/audio/buffer.ts</div>
              <div style={{ padding: '4px 8px' }}>📄 tests/stream.test.ts</div>
              <div style={{ padding: '4px 8px' }}>📄 docs/audio.md</div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function RuntimesPanel({ runtimes, team }: { runtimes: Runtime[]; team: Team }) {
  const live = runtimes.filter((r) => r.status === 'live');
  const idle = runtimes.filter((r) => r.status === 'idle');
  const totalCpu = runtimes.reduce((a, r) => a + r.cpu, 0);
  const totalMem = runtimes.reduce((a, r) => a + r.mem, 0);
  const totalReqs = runtimes.reduce((a, r) => a + r.reqs, 0);

  const RuntimeRow = ({ r }: { r: Runtime }) => {
    const member = team.members.find((m) => m.id === r.agent);
    const cpuPct = Math.min(100, r.cpu * 4);
    return (
      <div className={`runtime-row ${r.status}`}>
        <div className="rt-head">
          <span className="status-dot" style={{ background: r.status === 'live' ? 'var(--ok)' : 'var(--fg-dim)', boxShadow: r.status === 'live' ? '0 0 6px var(--ok)' : 'none' }} />
          <span className="rt-name">{member ? member.name : r.agent}</span>
          <span className="rt-pid">pid {r.pid}</span>
        </div>
        <div className="rt-meta">
          <span style={{ color: PROVIDER_COLOR[r.provider] || 'var(--fg-muted)', fontSize: 10.5, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>{r.provider}</span>
          <span style={{ color: 'var(--fg-dim)' }}>·</span>
          <span className="mono">{r.model}</span>
        </div>
        <div className="rt-meta" style={{ gridColumn: '1 / -1', marginTop: 2 }}>
          <span><span className="mono">{r.cpu}%</span> cpu</span>
          <span style={{ color: 'var(--fg-dim)' }}>·</span>
          <span><span className="mono">{r.mem}MB</span></span>
          <span style={{ color: 'var(--fg-dim)' }}>·</span>
          <span><span className="mono">{r.reqs}</span> reqs</span>
          <span style={{ color: 'var(--fg-dim)', marginLeft: 'auto' }} className="mono">{r.uptime}</span>
        </div>
        <div className="rt-bar"><span style={{ width: `${cpuPct}%` }} /></div>
      </div>
    );
  };

  return (
    <>
      <div style={{ padding: '10px 12px 14px', margin: '4px 0 8px', background: 'var(--bg-panel)', borderRadius: 10, border: '1px solid var(--border-soft)' }}>
        <div className="section-label" style={{ marginBottom: 8 }}>Aggregate</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, fontSize: 11.5 }}>
          <div><div style={{ color: 'var(--fg-dim)', fontSize: 10.5 }}>Active</div><div className="mono" style={{ color: 'var(--fg)', fontSize: 14 }}>{live.length}<span style={{ color: 'var(--fg-dim)', fontSize: 11 }}> / {runtimes.length}</span></div></div>
          <div><div style={{ color: 'var(--fg-dim)', fontSize: 10.5 }}>CPU</div><div className="mono" style={{ color: 'var(--fg)', fontSize: 14 }}>{totalCpu}%</div></div>
          <div><div style={{ color: 'var(--fg-dim)', fontSize: 10.5 }}>Memory</div><div className="mono" style={{ color: 'var(--fg)', fontSize: 14 }}>{(totalMem / 1024).toFixed(1)}<span style={{ color: 'var(--fg-dim)', fontSize: 11 }}>GB</span></div></div>
          <div><div style={{ color: 'var(--fg-dim)', fontSize: 10.5 }}>Requests</div><div className="mono" style={{ color: 'var(--fg)', fontSize: 14 }}>{totalReqs}</div></div>
        </div>
      </div>

      <div style={{ marginBottom: 14 }}>
        <div className="sticky-section-head">
          <span className="status-dot live" style={{ marginRight: 2 }} />
          <span className="section-label">Live</span>
          <span className="count-pill">{live.length}</span>
        </div>
        <div style={{ padding: '4px 4px 0' }}>
          {live.map((r) => <RuntimeRow key={r.id} r={r} />)}
        </div>
      </div>

      {idle.length > 0 && (
        <div style={{ marginBottom: 14 }}>
          <div className="sticky-section-head">
            <span className="section-label">Idle</span>
            <span className="count-pill">{idle.length}</span>
          </div>
          <div style={{ padding: '4px 4px 0' }}>
            {idle.map((r) => <RuntimeRow key={r.id} r={r} />)}
          </div>
        </div>
      )}
    </>
  );
}
