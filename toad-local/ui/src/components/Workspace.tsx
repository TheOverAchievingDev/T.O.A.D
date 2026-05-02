import { useMemo, useState } from 'react';
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
}

function ActivityStrip({ team }: { team: Team }) {
  return (
    <div className="activity-strip">
      <div className="activity-step done">
        <span className="step-num"><Icon name="check" size={11} /></span>
        <span>Provisioned</span>
      </div>
      <div className="activity-line done" />
      <div className="activity-step done">
        <span className="step-num"><Icon name="check" size={11} /></span>
        <span>Members joined</span>
      </div>
      <div className="activity-line done" />
      <div className="activity-step active">
        <span className="step-num">3</span>
        <span>Working — 4 tasks in flight</span>
      </div>
      <div className="activity-line" />
      <div className="activity-step">
        <span className="step-num">4</span>
        <span>Review</span>
      </div>
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12, fontSize: 11.5, color: 'var(--fg-muted)' }}>
        <span><span className="mono" style={{ color: 'var(--fg)' }}>{team.uptime}</span> uptime</span>
        <span>·</span>
        <span><span className="mono" style={{ color: 'var(--fg)' }}>54.7k</span> tokens used</span>
        <span>·</span>
        <span className="mono" style={{ color: 'var(--fg-dim)' }}>pid 32828</span>
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
}: WorkspaceProps) {
  const [selected, setSelected] = useState<string>(team.members[1]?.id ?? team.members[0]?.id ?? '');
  const [kanbanOpen, setKanbanOpen] = useState(true);

  const inboxAgent = agentInbox ? team.members.find((m) => m.id === agentInbox) : null;

  const grouped = useMemo(() => {
    const g: Record<TaskStatus, UiTask[]> = {
      'todo': [], 'in-progress': [], 'review': [], 'done': [], 'blocked': [], 'rejected': [],
    };
    tasks.filter((t) => t.status !== 'done').forEach((t) => {
      if (g[t.status]) g[t.status].push(t);
    });
    return g;
  }, [tasks]);

  return (
    <div className="workspace">
      <aside className="ws-rail">
        {inboxAgent ? (
          <AgentInbox agent={inboxAgent} team={team} messages={messages} onClose={onCloseAgent} />
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
        <div className="ws-main-header">
          <div className="team-title">
            <h1>{team.name}</h1>
            <span className="run-pill">
              <span className="status-dot live" />
              {team.status === 'running' ? 'Running' : team.status}
            </span>
            <span className="team-meta mono">· {team.branch}</span>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-sm"><Icon name="pause" size={11} /> Pause team</button>
            <button className="btn btn-sm btn-ghost"><Icon name="settings" size={13} /></button>
            <button className="btn btn-sm btn-ghost" onClick={onCreateTeam}><Icon name="plus" size={13} /> New team</button>
          </div>
        </div>

        <div className="ws-main-body">
          <ActivityStrip team={team} />

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '32px 0 4px' }}>
            <div>
              <div className="section-label">Team</div>
              <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginTop: 4 }}>{team.description}</div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn btn-sm"><Icon name="layers" size={13} /> Org</button>
              <button className="btn btn-sm btn-ghost"><Icon name="git" size={13} /> Graph</button>
              <button className="btn btn-sm btn-ghost"><Icon name="list" size={13} /> List</button>
            </div>
          </div>

          <OrgChart
            team={team}
            selected={selected}
            onSelect={(id) => { setSelected(id); onOpenAgent(id); }}
            cardVariant={cardVariant}
          />

          <div className={`section-block ${kanbanOpen ? '' : 'collapsed'}`}>
            <div className="section-head" onClick={() => setKanbanOpen(!kanbanOpen)}>
              <h3>
                <Icon name="kanban" size={14} />
                Kanban
                <span className="chip" style={{ marginLeft: 4 }}>{tasks.filter((t) => t.status !== 'done').length} active</span>
              </h3>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={(e) => { e.stopPropagation(); onCreateTask?.(); }}
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
                    {(grouped[col.key] ?? []).map((t) => {
                      const member = team.members.find((m) => m.id === t.assignee);
                      return (
                        <div
                          key={t.id}
                          className="kanban-card"
                          style={roleStyle(member?.role ?? 'developer')}
                          onClick={() => onOpenTask(t.id)}
                        >
                          <div className="kanban-card-head">
                            <span className="kanban-card-id">{t.id}</span>
                            {t.riskLevel && (
                              <TaskRiskBadge
                                level={t.riskLevel}
                                requiresHumanApproval={t.requiresHumanApproval}
                                humanApproved={t.humanApproved}
                                matchedRules={t.matchedRules}
                                style={{ marginLeft: 6 }}
                              />
                            )}
                            {member && <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--accent)' }}>{member.name}</span>}
                          </div>
                          <div>{t.title}</div>
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
      </main>

      <aside className="ws-side">
        <TasksSide
          team={team}
          tasks={tasks}
          runtimes={runtimes}
          onOpenTask={onOpenTask}
          onCreateTask={onCreateTask}
          onOpenLogs={onOpenLogs}
        />
      </aside>
    </div>
  );
}

// Avoid unused-import warnings for AgentCard (re-exported for callers if needed)
export { AgentCard };
