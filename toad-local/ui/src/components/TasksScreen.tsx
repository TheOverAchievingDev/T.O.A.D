import { useMemo, useState } from 'react';
import type { Team, UiTask, TaskStatus } from '@/types';
import { roleStyle } from '@/data/roles';
import { Icon, type IconName } from './Icon';
import { TaskRiskBadge } from './TaskRiskBadge';
import { EmptyTasksState } from './EmptyTasksState';
import { DriftBadge } from './DriftBadge';

type TasksView = 'kanban' | 'list';
export type TasksGroupBy = 'status' | 'assignee' | 'type' | 'risk';

interface TasksScreenProps {
  team: Team;
  tasks: UiTask[];
  onOpenTask: (id: string) => void;
  onCreateTask?: () => void;
  /** Per-task drift scores from App-level useDrift. Empty object when
   *  drift hasn't loaded yet — DriftBadge hides on undefined scores. */
  perTaskDrift?: Record<string, number>;
  /** Phase 3b — group-by selection persisted in tweaks. Defaults to
   *  'status' when undefined so the screen renders identically for
   *  callers that haven't been updated yet. */
  groupBy?: TasksGroupBy;
  onChangeGroupBy?: (next: TasksGroupBy) => void;
  /** Phase 3b Task 7 — inline-create handler. Receives the typed
   *  subject and is expected to call task_create with sensible
   *  defaults (type=feature, role=developer, priority=medium).
   *  Returns a promise so the input can show a brief "Adding…" state.
   *  When undefined, the inline-create row is hidden. */
  onInlineCreate?: (subject: string) => Promise<void>;
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

// Phase 3b Task 6 — group-by helpers. Each grouping defines its
// columns AND how to compute a task's column key. Status keeps the
// original 4-column kanban (To do / In progress / Review / Done);
// other modes generate their columns dynamically from the task set.

interface GroupColumn {
  key: string;
  label: string;
  icon?: IconName;
}

function groupKeyForTask(task: UiTask, mode: TasksGroupBy): string {
  switch (mode) {
    case 'status':   return task.status;
    case 'assignee': return task.assignee?.trim() || 'unassigned';
    case 'type':     return task.type ?? 'feature';
    case 'risk':     return task.riskLevel ?? 'none';
  }
}

function groupColumnsFor(mode: TasksGroupBy, tasks: UiTask[], team: Team): GroupColumn[] {
  switch (mode) {
    case 'status':
      return KANBAN_COLS.map((c) => ({ key: c.key, label: c.label, icon: c.icon }));
    case 'assignee': {
      // One column per unique assignee + an "Unassigned" lane when
      // any task lacks one. Order: lead first (if present), then
      // declared team members in config order, then any agent ids
      // that show up only in tasks (e.g. external/dropped roles),
      // then 'unassigned' last.
      const taskKeys = new Set(tasks.map((t) => groupKeyForTask(t, 'assignee')));
      const cols: GroupColumn[] = [];
      const seen = new Set<string>();
      for (const m of team.members) {
        if (taskKeys.has(m.id)) {
          cols.push({ key: m.id, label: m.name, icon: 'user' });
          seen.add(m.id);
        }
      }
      for (const k of taskKeys) {
        if (k === 'unassigned' || seen.has(k)) continue;
        cols.push({ key: k, label: k, icon: 'user' });
      }
      if (taskKeys.has('unassigned')) {
        cols.push({ key: 'unassigned', label: 'Unassigned', icon: 'user' });
      }
      return cols.length > 0 ? cols : [{ key: 'unassigned', label: 'Unassigned', icon: 'user' }];
    }
    case 'type':
      return [
        { key: 'feature', label: 'Feature', icon: 'sparkle' },
        { key: 'bug',     label: 'Bug',     icon: 'info' },
      ];
    case 'risk':
      return [
        { key: 'critical', label: 'Critical', icon: 'info' },
        { key: 'high',     label: 'High',     icon: 'info' },
        { key: 'medium',   label: 'Medium',   icon: 'info' },
        { key: 'low',      label: 'Low',      icon: 'info' },
        { key: 'none',     label: 'No risk',  icon: 'check' },
      ];
  }
}

const GROUP_BY_OPTIONS: Array<{ id: TasksGroupBy; label: string }> = [
  { id: 'status',   label: 'Status' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'type',     label: 'Type' },
  { id: 'risk',     label: 'Risk' },
];

export function TasksScreen({
  team,
  tasks,
  onOpenTask,
  onCreateTask,
  perTaskDrift = {},
  groupBy = 'status',
  onChangeGroupBy,
  onInlineCreate,
}: TasksScreenProps) {
  const [view, setView] = useState<TasksView>('kanban');
  const [query, setQuery] = useState('');
  // Phase 3b Task 7 — inline-create local state.
  const [inlineSubject, setInlineSubject] = useState('');
  const [inlineBusy, setInlineBusy] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);

  async function submitInline() {
    const subject = inlineSubject.trim();
    if (!subject) return;
    if (!onInlineCreate) return;
    setInlineBusy(true);
    setInlineError(null);
    try {
      await onInlineCreate(subject);
      setInlineSubject('');
    } catch (err) {
      setInlineError(err instanceof Error ? err.message : 'Could not create task.');
    } finally {
      setInlineBusy(false);
    }
  }
  // Drift scores arrive via the perTaskDrift prop — App.tsx hosts the
  // single useDrift loop and threads scores down to every consumer.
  // UiTask.id IS the backend's taskId (see normalizeTask in useToadData).
  const perTask = perTaskDrift;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tasks;
    return tasks.filter((t) =>
      t.id.toLowerCase().includes(q)
      || t.title.toLowerCase().includes(q)
      || t.assignee.toLowerCase().includes(q),
    );
  }, [tasks, query]);

  // Phase 3b Task 6 — dynamic grouping. Columns depend on the selected
  // mode; bucket population is uniform via groupKeyForTask. The kanban
  // grid CSS gets `repeat(N, 1fr)` so any column count lays out cleanly.
  const columns: GroupColumn[] = useMemo(
    () => groupColumnsFor(groupBy, filtered, team),
    [groupBy, filtered, team],
  );
  const grouped = useMemo(() => {
    const g: Record<string, UiTask[]> = {};
    for (const col of columns) g[col.key] = [];
    for (const t of filtered) {
      const key = groupKeyForTask(t, groupBy);
      if (!g[key]) g[key] = []; // tolerate keys not in the column set (e.g. an exotic risk level)
      g[key].push(t);
    }
    return g;
  }, [filtered, columns, groupBy]);

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
          {view === 'kanban' && onChangeGroupBy && (
            <div className="seg" title="Group tasks by…">
              {GROUP_BY_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={groupBy === opt.id ? 'active' : ''}
                  onClick={() => onChangeGroupBy(opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
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
        {/* Phase 3b Task 7 — inline-create input pinned to the top of
            the body. Quick path for "title only" task creation; the
            full TaskCreationModal (via onCreateTask, the header's
            "+ New task" button) still handles the richer cases like
            allowedFiles, acceptance criteria, base branch, etc. */}
        {onInlineCreate && (
          <div className="tasks-inline-create">
            <Icon name="plus" size={13} />
            <input
              className="field-input"
              placeholder="Add task — title and press Enter"
              value={inlineSubject}
              disabled={inlineBusy}
              onChange={(e) => { setInlineSubject(e.target.value); if (inlineError) setInlineError(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submitInline();
                }
                if (e.key === 'Escape') {
                  setInlineSubject('');
                  setInlineError(null);
                }
              }}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={inlineBusy || !inlineSubject.trim()}
              onClick={() => void submitInline()}
            >
              {inlineBusy ? 'Adding…' : 'Add'}
            </button>
            <span className="dim" style={{ fontSize: 11 }}>
              feature · developer · medium priority. Use <span className="mono">+ New task</span> for full options.
            </span>
            {inlineError && (
              <span style={{ color: 'var(--err)', fontSize: 11, marginLeft: 'auto' }}>{inlineError}</span>
            )}
          </div>
        )}

        {tasks.length === 0 && (
          <EmptyTasksState
            title="This board is empty"
            body={`No tasks on ${team.name} yet. Create the first one and the team can start picking it up.`}
            ctaLabel="Create your first task"
            onCta={onCreateTask}
          />
        )}

        {view === 'kanban' && tasks.length > 0 && (
          <div
            className="kanban"
            style={{ gridTemplateColumns: `repeat(${Math.max(1, columns.length)}, minmax(220px, 1fr))` }}
          >
            {columns.map((col) => (
              <div key={col.key} className="kanban-col">
                <h4>
                  {col.icon && <Icon name={col.icon} size={11} />}
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
                        {t.type === 'bug' && (
                          <span className="task-bug-badge" title="Bug fix">Bug</span>
                        )}
                        {t.riskLevel && (
                          <TaskRiskBadge
                            level={t.riskLevel}
                            requiresHumanApproval={t.requiresHumanApproval}
                            humanApproved={t.humanApproved}
                            matchedRules={t.matchedRules}
                            style={{ marginLeft: 6 }}
                          />
                        )}
                        <DriftBadge score={perTask[t.id]} />
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
        {view === 'kanban' && tasks.length > 0 && columns.length > 4 && (
          <div className="dim" style={{ fontSize: 10.5, marginTop: 8 }}>
            Tip: kanban scrolls horizontally when grouping produces many columns.
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
                    {t.type === 'bug' && (
                      <span className="task-bug-badge" title="Bug fix">Bug</span>
                    )}
                    {t.riskLevel && (
                      <TaskRiskBadge
                        level={t.riskLevel}
                        requiresHumanApproval={t.requiresHumanApproval}
                        humanApproved={t.humanApproved}
                        matchedRules={t.matchedRules}
                        variant="full"
                      />
                    )}
                    <DriftBadge score={perTask[t.id]} />
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
