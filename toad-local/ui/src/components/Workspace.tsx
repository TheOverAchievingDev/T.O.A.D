import { useEffect, useMemo, useState } from 'react';
import type { Team, UiTask, Runtime, Message, TaskStatus } from '@/types';
import { roleStyle } from '@/data/roles';
import { Icon, type IconName } from './Icon';
import { AgentCard, type AgentCardVariant } from './AgentCard';
import { OrgChart } from './OrgChart';
import { ConvRail } from './ConvRail';
import { TasksSide } from './TasksSide';
import { AgentInbox } from './AgentInbox';
import { TaskRiskBadge } from './TaskRiskBadge';
import { EmptyTasksState } from './EmptyTasksState';
import { EmptyWorkspace } from './EmptyWorkspace';
import { useDrift } from '@/hooks/useDrift';
import { DriftBadge } from './DriftBadge';

interface WorkspaceProps {
  team: Team;
  tasks: UiTask[];
  runtimes: Runtime[];
  messages: Message[];
  cardVariant: AgentCardVariant;
  layout: 'org' | 'chat' | 'kanban';
  agentInbox: string;
  onCreateTeam: () => void;
  onCreateTask?: () => void;
  onOpenTask: (id: string) => void;
  onOpenAgent: (id: string) => void;
  onCloseAgent: () => void;
  onOpenLogs?: (runtimeId: string) => void;
  /** Stop every running agent in the team but keep the team config. */
  onPauseTeam?: () => Promise<void> | void;
  /** Stop every running agent and delete the team config + delivery rows. */
  onEndTeam?: () => Promise<void> | void;
  /** Per-agent activity streams accumulated by useToadData. Persists across
   *  agent-card switches so the inbox feed doesn't reset. */
  agentStreams?: Record<string, import('@/utils/agentStream').StreamEntry[]>;
  /** Number of pending human approvals across this team. Surfaced as a
   *  prominent banner so the operator can't miss them. */
  pendingApprovals?: number;
  /** Open the approvals drawer (parent owns the drawer state). */
  onOpenApprovals?: () => void;
  /** Errored runtimes count — shown in the attention banner when > 0. */
  erroredRuntimes?: number;
  /** Composer actor for AgentInbox direct-message sends. Falls back to a
   *  generic ui-client actor when omitted, but the parent should always
   *  pass the real team's actor so messages land on the right team. */
  composerActor?: import('@/api/client').Actor;
  /** Refresh callback fired after the operator sends a composer message. */
  onComposerSent?: () => void;
  /** Open the team-settings drawer for this team. */
  onOpenTeamSettings?: () => void;
}

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function pluralize(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`;
}

function ActivityStrip({ team, tasks, runtimes }: { team: Team; tasks: UiTask[]; runtimes: Runtime[] }) {
  const hasMembers = team.members.length > 0;
  const inFlightTasks = tasks.filter((task) => task.status === 'in-progress' || task.status === 'blocked');
  const reviewTasks = tasks.filter((task) => task.status === 'review');
  const openTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'rejected');
  const liveRuntimes = runtimes.filter((runtime) => runtime.status === 'live' || runtime.status === 'launching');
  const tokenTotal = runtimes.reduce((sum, runtime) => sum + runtime.tokensIn + runtime.tokensOut, 0);
  const pidList = liveRuntimes.map((runtime) => runtime.pid).filter((pid) => pid > 0);
  const workingLabel = inFlightTasks.length > 0
    ? `Working - ${pluralize(inFlightTasks.length, 'task')} in flight`
    : openTasks.length > 0
      ? `Ready - ${pluralize(openTasks.length, 'open task')}`
      : 'Ready - no tasks yet';

  return (
    <div className="activity-strip">
      <div className="activity-step done">
        <span className="step-num"><Icon name="check" size={11} /></span>
        <span>Provisioned</span>
      </div>
      <div className="activity-line done" />
      <div className={`activity-step ${hasMembers ? 'done' : ''}`}>
        <span className="step-num">{hasMembers ? <Icon name="check" size={11} /> : 2}</span>
        <span>Members joined</span>
      </div>
      <div className={`activity-line ${hasMembers ? 'done' : ''}`} />
      <div className={`activity-step ${inFlightTasks.length > 0 || liveRuntimes.length > 0 ? 'active' : ''}`}>
        <span className="step-num">3</span>
        <span>{workingLabel}</span>
      </div>
      <div className="activity-line" />
      <div className={`activity-step ${reviewTasks.length > 0 ? 'active' : ''}`}>
        <span className="step-num">4</span>
        <span>{reviewTasks.length > 0 ? `${pluralize(reviewTasks.length, 'task')} in review` : 'Review'}</span>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, fontSize: 11.5, color: 'var(--fg-muted)' }}>
        <span><span className="mono" style={{ color: 'var(--fg)' }}>{team.uptime}</span> uptime</span>
        <span>/</span>
        <span><span className="mono" style={{ color: 'var(--fg)' }}>{formatTokens(tokenTotal)}</span> tokens used</span>
        {pidList.length > 0 && (
          <>
            <span>/</span>
            <span className="mono" style={{ color: 'var(--fg-dim)' }}>
              pid {pidList.slice(0, 2).join(', ')}{pidList.length > 2 ? ` +${pidList.length - 2}` : ''}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

const KANBAN_COLS: { key: TaskStatus; label: string; icon: IconName }[] = [
  { key: 'todo', label: 'To do', icon: 'list' },
  { key: 'in-progress', label: 'In progress', icon: 'play' },
  { key: 'review', label: 'Review', icon: 'eye' },
];

export function Workspace({
  team, tasks, runtimes, messages,
  cardVariant, agentInbox,
  onCreateTeam, onCreateTask, onOpenTask, onOpenAgent, onCloseAgent, onOpenLogs,
  onPauseTeam, onEndTeam, agentStreams,
  pendingApprovals = 0, onOpenApprovals, erroredRuntimes = 0,
  composerActor, onComposerSent, onOpenTeamSettings,
}: WorkspaceProps) {
  const [pausing, setPausing] = useState(false);
  const [ending, setEnding] = useState(false);
  // Two-click confirm for End Team. Tauri 2 blocks window.confirm by
  // default and we don't want to wire the dialog plugin just for this.
  // First click sets confirmEnd=true and changes the label to "Click
  // again to confirm"; a 4-second timer auto-resets.
  const [confirmEnd, setConfirmEnd] = useState(false);
  useEffect(() => {
    if (!confirmEnd) return;
    const t = setTimeout(() => setConfirmEnd(false), 4000);
    return () => clearTimeout(t);
  }, [confirmEnd]);

  const handlePause = async () => {
    if (pausing || !onPauseTeam) return;
    setPausing(true);
    try { await onPauseTeam(); } finally { setPausing(false); }
  };
  const handleEnd = async () => {
    if (ending || !onEndTeam) return;
    if (!confirmEnd) {
      setConfirmEnd(true);
      return;
    }
    setConfirmEnd(false);
    setEnding(true);
    try { await onEndTeam(); } finally { setEnding(false); }
  };
  const [selected, setSelected] = useState<string>(team.members[1]?.id ?? team.members[0]?.id ?? '');
  const [kanbanOpen, setKanbanOpen] = useState(true);
  const [teamView, setTeamView] = useState<'org' | 'graph' | 'list'>('org');
  // Drift scores keyed by taskId. Mirrors App.tsx's DriftScreen wiring —
  // team.name is the backend team id. Hook handles null teamId gracefully.
  const { data: drift } = useDrift({ teamId: team.name || null });
  const perTaskDrift = drift?.perTaskScores ?? {};
  const hasTeam = team.name.trim().length > 0 || team.members.length > 0;
  const inboxAgent = hasTeam && agentInbox ? team.members.find((m) => m.id === agentInbox) : null;

  const grouped = useMemo(() => {
    const g: Record<TaskStatus, UiTask[]> = {
      todo: [],
      'in-progress': [],
      review: [],
      done: [],
      blocked: [],
      rejected: [],
    };
    tasks.filter((task) => task.status !== 'done').forEach((task) => {
      g[task.status].push(task);
    });
    return g;
  }, [tasks]);

  return (
    <div className="workspace">
      <aside className="ws-rail">
        {!hasTeam ? (
          <div className="conv-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Icon name="users" size={14} style={{ color: 'var(--fg-muted)' }} />
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg-muted)' }}>No team</span>
            </div>
          </div>
        ) : inboxAgent ? (
          <AgentInbox
            agent={inboxAgent}
            team={team}
            messages={messages}
            onClose={onCloseAgent}
            stream={agentStreams?.[inboxAgent.id] ?? []}
            actor={composerActor}
            onMessageSent={onComposerSent}
          />
        ) : (
          <>
            <div className="conv-header">
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Icon name="users" size={14} style={{ color: 'var(--fg-muted)' }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{team.name}</span>
              </div>
              <button className="icon-btn" title="Settings"><Icon name="moreH" size={14} /></button>
            </div>
            <ConvRail team={team} selected={selected} messages={messages} />
          </>
        )}
      </aside>

      <main className="ws-main">
        {!hasTeam ? (
          <EmptyWorkspace onCreateTeam={onCreateTeam} />
        ) : (
          <>
            <div className="ws-main-header">
              <div className="team-title">
                <h1>{team.name}</h1>
                <span className="run-pill">
                  <span className={`status-dot ${team.status === 'running' ? 'live' : team.status}`} />
                  {team.status === 'running' ? 'Running' : team.status}
                </span>
                {team.branch && <span className="team-meta mono">/ {team.branch}</span>}
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button
                  className="btn btn-sm"
                  disabled={pausing || ending || runtimes.filter((r) => r.status === 'live' || r.status === 'launching').length === 0}
                  onClick={handlePause}
                  title="Stop every running agent in this team. Team config + tasks are kept."
                >
                  <Icon name="pause" size={11} /> {pausing ? 'Pausing…' : 'Pause team'}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={pausing || ending || team.members.length === 0}
                  onClick={handleEnd}
                  title={confirmEnd
                    ? 'Click again to confirm — stops every agent and deletes the team config'
                    : 'Stop every running agent AND delete this team. Tasks/history preserved in DB.'}
                  style={{
                    color: confirmEnd ? 'var(--bg, #1a1a1a)' : 'var(--danger, #f87171)',
                    background: confirmEnd ? 'var(--danger, #f87171)' : undefined,
                    fontWeight: confirmEnd ? 700 : undefined,
                  }}
                >
                  <Icon name="x" size={11} /> {ending
                    ? 'Ending…'
                    : confirmEnd
                      ? 'Click again to confirm'
                      : 'End team'}
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={onOpenTeamSettings}
                  disabled={team.members.length === 0 || !onOpenTeamSettings}
                  title="Team settings — edit prompts, validation commands, and permissions"
                  type="button"
                >
                  <Icon name="settings" size={13} />
                </button>
                <button className="btn btn-sm btn-ghost" onClick={onCreateTeam}><Icon name="plus" size={13} /> New team</button>
              </div>
            </div>

            <div className="ws-main-body">
              {/* Attention banner — sticky at top of workspace whenever
                  something needs the operator. Currently surfaces pending
                  human approvals + errored runtimes. Clicking jumps to the
                  relevant drawer so the operator never has to hunt. */}
              {(pendingApprovals > 0 || erroredRuntimes > 0) ? (
                <div
                  style={{
                    display: 'flex',
                    gap: 12,
                    padding: '10px 14px',
                    margin: '0 0 16px',
                    borderRadius: 8,
                    background: 'rgba(255, 196, 102, 0.10)',
                    border: '1px solid rgba(255, 196, 102, 0.35)',
                    fontSize: 13,
                    alignItems: 'center',
                  }}
                >
                  <Icon name="bell" size={16} style={{ color: 'var(--warn, #ffcd66)', flexShrink: 0 }} />
                  <span style={{ flex: 1, color: 'var(--fg)' }}>
                    {pendingApprovals > 0 ? (
                      <strong>{pendingApprovals}</strong>
                    ) : null}
                    {pendingApprovals > 0 ? ` approval${pendingApprovals === 1 ? '' : 's'} waiting for you` : null}
                    {pendingApprovals > 0 && erroredRuntimes > 0 ? ' · ' : null}
                    {erroredRuntimes > 0 ? (
                      <><strong>{erroredRuntimes}</strong> {`runtime${erroredRuntimes === 1 ? '' : 's'} errored`}</>
                    ) : null}
                  </span>
                  {pendingApprovals > 0 && onOpenApprovals ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={onOpenApprovals}
                      style={{ background: 'var(--warn, #ffcd66)', color: '#1a1a1a', fontWeight: 600 }}
                    >
                      Review
                    </button>
                  ) : null}
                </div>
              ) : null}

              <ActivityStrip team={team} tasks={tasks} runtimes={runtimes} />

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '32px 0 4px' }}>
                <div>
                  <div className="section-label">Team</div>
                  <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>{team.description}</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    type="button"
                    className={`btn btn-sm ${teamView === 'org' ? '' : 'btn-ghost'}`}
                    onClick={() => setTeamView('org')}
                  >
                    <Icon name="layers" size={13} /> Org
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${teamView === 'graph' ? '' : 'btn-ghost'}`}
                    onClick={() => setTeamView('graph')}
                  >
                    <Icon name="git" size={13} /> Graph
                  </button>
                  <button
                    type="button"
                    className={`btn btn-sm ${teamView === 'list' ? '' : 'btn-ghost'}`}
                    onClick={() => setTeamView('list')}
                  >
                    <Icon name="list" size={13} /> List
                  </button>
                </div>
              </div>

              {teamView === 'org' ? (
                <OrgChart
                  team={team}
                  selected={selected}
                  onSelect={(id) => { setSelected(id); onOpenAgent(id); }}
                  cardVariant={cardVariant}
                />
              ) : teamView === 'list' ? (
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 6, marginTop: 12,
                }}>
                  {team.members.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => { setSelected(m.id); onOpenAgent(m.id); }}
                      className={selected === m.id ? 'agent-card selected' : 'agent-card'}
                      style={{
                        ...roleStyle(m.role),
                        display: 'flex', alignItems: 'center', gap: 12,
                        padding: '10px 14px', textAlign: 'left',
                      }}
                    >
                      <div className="agent-avatar" style={{ width: 32, height: 32, fontSize: 13 }}>{m.avatar}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontWeight: 600 }}>{m.name}</span>
                          <span className={`status-dot ${m.status}`} />
                          <span className="dim" style={{ fontSize: 11 }}>· {m.role}</span>
                        </div>
                        <div className="dim" style={{ fontSize: 11, marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {m.activity?.label ?? m.task ?? 'Idle'}
                        </div>
                      </div>
                      <span className="dim mono" style={{ fontSize: 11 }}>{m.model}</span>
                    </button>
                  ))}
                </div>
              ) : (
                // Graph view: simple message-flow diagram. Lead in the center;
                // teammates around the edge; arrows for lead→teammate messages
                // and teammate→lead replies pulled from the messages prop.
                <MessageGraph team={team} messages={messages} selected={selected} onSelect={(id) => { setSelected(id); onOpenAgent(id); }} />
              )}

              <div className={`section-block ${kanbanOpen ? '' : 'collapsed'}`}>
                <div className="section-head" onClick={() => setKanbanOpen(!kanbanOpen)}>
                  <h3>
                    <Icon name="kanban" size={14} />
                    Kanban
                    <span className="chip" style={{ marginLeft: 4 }}>
                      {tasks.filter((task) => task.status !== 'done').length} active
                    </span>
                  </h3>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={(event) => { event.stopPropagation(); onCreateTask?.(); }}
                      disabled={!onCreateTask}
                    >
                      <Icon name="plus" size={12} /> Task
                    </button>
                    <Icon name="chevronDown" size={14} className="chevron" />
                  </div>
                </div>
                <div className="section-body">
                  {tasks.length === 0 && (
                    <EmptyTasksState
                      title="No tasks yet"
                      body="When you add tasks, they show up here in the kanban so the team can pick them up."
                      ctaLabel="Create a task"
                      onCta={onCreateTask}
                    />
                  )}
                  {tasks.length > 0 && (
                    <div className="kanban">
                      {KANBAN_COLS.map((col) => (
                        <div key={col.key} className="kanban-col">
                          <h4>
                            <Icon name={col.icon} size={11} />
                            {col.label}
                            <span className="count">{grouped[col.key]?.length ?? 0}</span>
                          </h4>
                          {(grouped[col.key] ?? []).map((task) => {
                            const member = team.members.find((m) => m.id === task.assignee);
                            return (
                              <div
                                key={task.id}
                                className="kanban-card"
                                style={roleStyle(member?.role ?? 'developer')}
                                onClick={() => onOpenTask(task.id)}
                              >
                                <div className="kanban-card-head">
                                  <span className="kanban-card-id">{task.id}</span>
                                  {task.riskLevel && (
                                    <TaskRiskBadge
                                      level={task.riskLevel}
                                      requiresHumanApproval={task.requiresHumanApproval}
                                      humanApproved={task.humanApproved}
                                      matchedRules={task.matchedRules}
                                      style={{ marginLeft: 6 }}
                                    />
                                  )}
                                  <DriftBadge score={perTaskDrift[task.id]} />
                                  {member && (
                                    <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--accent)' }}>
                                      {member.name}
                                    </span>
                                  )}
                                </div>
                                <div>{task.title}</div>
                              </div>
                            );
                          })}
                          <button
                            className="kanban-add"
                            type="button"
                            onClick={onCreateTask}
                            disabled={!onCreateTask}
                          >
                            <Icon name="plus" size={11} /> Add task
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>

      <aside className="ws-side">
        <TasksSide
          team={team}
          tasks={tasks}
          runtimes={runtimes}
          onOpenTask={onOpenTask}
          onCreateTask={hasTeam ? onCreateTask : undefined}
          onOpenLogs={onOpenLogs}
        />
      </aside>
    </div>
  );
}

// Avoid unused-import warnings for AgentCard (re-exported for callers if needed)
export { AgentCard };

/**
 * Compact messaging graph — shows who's talking to whom.
 * Lead in the center, teammates ringed around. Edge thickness reflects
 * message count between the two agents in the recent window. Edges are
 * directional (sender → recipient).
 *
 * SVG-based, no external graph library — straightforward layout because
 * teams are small (<12 members typically).
 */
function MessageGraph({
  team,
  messages,
  selected,
  onSelect,
}: {
  team: Team;
  messages: Message[];
  selected: string;
  onSelect: (id: string) => void;
}) {
  const lead = team.members.find((m) => m.role === 'lead') ?? team.members[0];
  const others = team.members.filter((m) => m.id !== lead?.id);
  if (!lead) return null;
  const w = 720;
  const h = 360;
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) / 2 - 60;
  const positions = new Map<string, { x: number; y: number }>();
  positions.set(lead.id, { x: cx, y: cy });
  others.forEach((m, i) => {
    const angle = (-Math.PI / 2) + (i / Math.max(1, others.length)) * Math.PI * 2;
    positions.set(m.id, { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius });
  });

  // Aggregate edges. Map<"from→to", count>
  const edgeCounts = new Map<string, number>();
  for (const msg of messages) {
    if (!msg.from || !msg.to || msg.from === 'user' || msg.to === 'user') continue;
    if (!positions.has(msg.from) || !positions.has(msg.to)) continue;
    const key = `${msg.from}→${msg.to}`;
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
  }
  const maxCount = Math.max(1, ...Array.from(edgeCounts.values()));

  return (
    <div style={{ marginTop: 16, padding: 16, borderRadius: 10, border: '1px solid var(--border, rgba(255,255,255,0.08))', background: 'var(--bg-panel, rgba(255,255,255,0.02))' }}>
      <svg viewBox={`0 0 ${w} ${h}`} style={{ width: '100%', height: 'auto', maxHeight: 420 }}>
        <defs>
          <marker id="msg-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
            <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
          </marker>
        </defs>
        {Array.from(edgeCounts.entries()).map(([key, count]) => {
          const [from, to] = key.split('→');
          const a = positions.get(from)!;
          const b = positions.get(to)!;
          // Pull endpoints back from each node so arrowheads don't overlap circles
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          const nodeR = from === lead.id || to === lead.id ? 30 : 24;
          const px = dx / len, py = dy / len;
          const x1 = a.x + px * nodeR;
          const y1 = a.y + py * nodeR;
          const x2 = b.x - px * nodeR;
          const y2 = b.y - py * nodeR;
          const thickness = 1 + (count / maxCount) * 4;
          return (
            <g key={key} style={{ color: 'var(--accent, #7cd1ff)' }}>
              <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="currentColor" strokeWidth={thickness} opacity={0.5} markerEnd="url(#msg-arrow)" />
              <text x={(x1 + x2) / 2} y={(y1 + y2) / 2 - 4} textAnchor="middle" fontSize="9" fill="var(--fg-muted)">{count}</text>
            </g>
          );
        })}
        {Array.from(positions.entries()).map(([id, pos]) => {
          const m = team.members.find((x) => x.id === id);
          if (!m) return null;
          const isLead = id === lead.id;
          const isSelected = id === selected;
          const r = isLead ? 30 : 24;
          return (
            <g key={id} style={{ cursor: 'pointer' }} onClick={() => onSelect(id)}>
              <circle
                cx={pos.x}
                cy={pos.y}
                r={r}
                fill="var(--bg-panel, #1a1a1a)"
                stroke={isSelected ? 'var(--accent, #7cd1ff)' : 'var(--border, rgba(255,255,255,0.18))'}
                strokeWidth={isSelected ? 2 : 1}
              />
              <text x={pos.x} y={pos.y + 1} textAnchor="middle" fontSize={isLead ? 14 : 12} fontWeight={isLead ? 700 : 500} fill="var(--fg)">
                {m.avatar}
              </text>
              <text x={pos.x} y={pos.y + r + 14} textAnchor="middle" fontSize="11" fill="var(--fg-muted)">
                {m.name}
              </text>
              {m.status === 'live' || m.status === 'thinking' ? (
                <circle cx={pos.x + r * 0.7} cy={pos.y - r * 0.7} r={4} fill="var(--ok, #4ade80)" />
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="dim" style={{ fontSize: 11, textAlign: 'center', marginTop: 8 }}>
        {edgeCounts.size === 0 ? 'No messages between agents yet.' : `${edgeCounts.size} edge${edgeCounts.size === 1 ? '' : 's'} · message counts shown on each line`}
      </div>
    </div>
  );
}
