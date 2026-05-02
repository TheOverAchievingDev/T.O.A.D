import { useMemo, useState } from 'react';
import type { Team, UiTask, TaskStatus } from '@/types';
import { roleStyle } from '@/data/roles';
import { Icon, type IconName } from './Icon';
import { TaskRiskBadge } from './TaskRiskBadge';
import { EmptyTasksState } from './EmptyTasksState';

type TasksView = 'kanban' | 'list';

interface TasksScreenProps {
  team: Team;
  tasks: UiTask[];
  onOpenTask: (id: string) => void;
  onCreateTask?: () => void;
}

const KANBAN_COLS: { key: TaskStatus; label: string; icon: IconName }[] = [
  { key: 'todo', label: 'To do', icon: 'list' },
  { key: 'in-progress', label: 'In progress', icon: 'play' },
  { key: 'review', label: 'Review', icon: 'eye' },
  { key: 'done', label: 'Done', icon: 'check' },
];

const STATUS_LABEL: Record<TaskStatus, string> = {
  'todo': 'To do',
  'in-progress': 'In progress',
  'review': 'Review',
  'done': 'Done',
  'blocked': 'Blocked',
  'rejected': 'Rejected',
};

export function TasksScreen({ team, tasks, onOpenTask, onCreateTask }: TasksScreenProps) {
  const [view, setView] = useState<TasksView>('kanban');
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) =>
      t.id.toLowerCase().includes(q)
      || t.title.toLowerCase().includes(q)
      || t.assignee.toLowerCase().includes(q),
    );
  }, [tasks, query]);

  const grouped = useMemo(() => {
    const g: Record<TaskStatus, UiTask[]> = {
      'todo': [], 'in-progress': [], 'review': [], 'done': [], 'blocked': [], 'rejected': [],
    };
    filtered.forEach((t) => {
      if (g[t.status]) g[t.status].push(t);
    });
    return g;
  }, [filtered]);

  const counts = useMemo(() => ({
    total: tasks.length,
    todo: tasks.filter((t) => t.status === 'todo').length,
    'in-progress': tasks.filter((t) => t.status === 'in-progress').length,
    review: tasks.filter((t) => t.status === 'review').length,
    done: tasks.filter((t) => t.status === 'done').length,
  }), [tasks]);

  return (
    <main className="ws-main" style={{ overflow: 'auto' }}>
      <div className="ws-main-header">
        <div className="team-title">
          <h1>Tasks</h1>
          <span className="team-meta mono">· {team.name}</span>
          <span className="dim mono" style={{ fontSize: 11 }}>
            {counts.total} total · {counts['in-progress']} in flight · {counts.review} in review
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input
            className="search-input"
            placeholder="Search tasks…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 240 }}
          />
          <div className="seg">
            <button
              type="button"
              className={view === 'kanban' ? 'active' : ''}
              onClick={() => setView('kanban')}
            >
              <Icon name="kanban" size={11} /> Kanban
            </button>
            <button
              type="button"
              className={view === 'list' ? 'active' : ''}
              onClick={() => setView('list')}
            >
              <Icon name="list" size={11} /> List
            </button>
          </div>
          {onCreateTask && (
            <button className="btn btn-sm btn-primary" type="button" onClick={onCreateTask}>
              <Icon name="plus" size={11} /> New task
            </button>
          )}
        </div>
      </div>

      <div className="ws-main-body">
        {tasks.length === 0 && (
          <EmptyTasksState
            title="This board is empty"
            body={`No tasks on ${team.name} yet. Create the first one and the team can start picking it up.`}
            ctaLabel="Create your first task"
            onCta={onCreateTask}
          />
        )}

        {view === 'kanban' && tasks.length > 0 && (
          <div className="kanban" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
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
                        {member && (
                          <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--accent)' }}>
                            {member.name}
                          </span>
                        )}
                      </div>
                      <div>{t.title}</div>
                    </div>
                  );
                })}
                {(grouped[col.key]?.length ?? 0) === 0 && (
                  <div className="dim" style={{ fontSize: 11, padding: '8px 4px' }}>—</div>
                )}
              </div>
            ))}
          </div>
        )}

        {view === 'list' && tasks.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 12 }}>
            {filtered.length === 0 && (
              <div className="dim" style={{ padding: 24, textAlign: 'center', fontSize: 13 }}>
                No tasks match your search.
              </div>
            )}
            {filtered.map((t) => {
              const member = team.members.find((m) => m.id === t.assignee);
              return (
                <div
                  key={t.id}
                  className="task-row"
                  style={{ ...roleStyle(member?.role ?? 'developer'), padding: '10px 12px' }}
                  onClick={() => onOpenTask(t.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span className="task-id">{t.id}</span>
                    <span
                      className="chip"
                      style={{ fontSize: 10, padding: '1px 6px' }}
                    >
                      {STATUS_LABEL[t.status] ?? t.status}
                    </span>
                    {t.riskLevel && (
                      <TaskRiskBadge
                        level={t.riskLevel}
                        requiresHumanApproval={t.requiresHumanApproval}
                        humanApproved={t.humanApproved}
                        matchedRules={t.matchedRules}
                        variant="full"
                      />
                    )}
                    {member && (
                      <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--accent)' }}>
                        ● {member.name}
                      </span>
                    )}
                  </div>
                  <div className="task-title" style={{ fontSize: 13 }}>{t.title}</div>
                  <div className="task-foot">
                    <span style={{ marginLeft: 'auto' }}>{t.project}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
