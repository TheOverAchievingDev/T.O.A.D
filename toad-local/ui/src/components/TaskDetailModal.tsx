import { useEffect, useMemo, useState } from 'react';
import type { Team, UiTask, TaskRiskLevel, MatchedRiskRule } from '@/types';
import { ROLES, roleStyle } from '@/data/roles';
import { Icon, type IconName } from './Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';
// PlanSection / DiffSection / ValidationsSection are temporarily unused —
// they need real backend data flow before they go back in. See comment
// above the section block in render.
import { TaskRiskBadge } from './TaskRiskBadge';
import { ReviewComposer } from './ReviewComposer';
import { TaskLifecycle } from './TaskLifecycle';
import { OpenPullRequestButton } from './OpenPullRequestButton';
// Plan/Diff/Validations come from the backend task projection. Until those
// are wired through to this modal, the sections are gated on real data
// rather than rendered with the legacy seed constants.

type ActivityKind = 'create' | 'log' | 'change' | 'comment' | 'approval' | 'stage';

interface ActivityEvent {
  kind: ActivityKind;
  actor: string;
  time: string;
  body?: string;
  file?: string;
  added?: number;
  removed?: number;
  msg?: string;
}

interface TaskDetailData {
  id: string;
  shortId: string;
  title: string;
  status: UiTask['status'];
  assigneeId: string;
  leadId: string;
  reviewerId: string;
  createdAgo: string;
  branch: string;
  baseBranch: string | null;
  worktreeBranch: string | null;
  description: string;
  attachments: { name: string; size: string; kind: 'code' | 'doc' }[];
  changes: { file: string; added: number; removed: number }[];
  riskLevel?: TaskRiskLevel | null;
  requiresHumanApproval?: boolean;
  humanApproved?: boolean;
  matchedRules?: MatchedRiskRule[];
  type?: 'feature' | 'bug';
  // Rich content from the lead's EARS-spec task_create calls — surfaced
  // in the description column when present so the assigned agent (and
  // the operator reviewing) can see the full contract for the task.
  priority?: string;
  acceptanceCriteria?: string[];
  expectedDeliverables?: string[];
  dependencyTaskIds?: string[];
  testCommands?: string[];
}

interface BackendTaskEvent {
  eventType?: string;
  type?: string;
  actorId?: string;
  createdAt?: string;
  payload?: {
    text?: string;
    body?: string;
    fromStatus?: string;
    toStatus?: string;
    file?: string;
    added?: number;
    removed?: number;
    [key: string]: unknown;
  };
}

interface BackendTask {
  // Backend's task projection writes `taskId` + `subject`. Older test
  // fixtures used `id` + `title`. Accept both so the modal isn't empty
  // just because the field name shifted.
  id?: string;
  taskId?: string;
  title?: string;
  subject?: string;
  status?: string;
  assignedRole?: string;
  ownerId?: string | null;
  description?: string;
  branch?: string;
  baseBranch?: string;
  worktree?: { branch?: string; status?: string } | null;
  createdAt?: string;
  riskLevel?: TaskRiskLevel | null;
  requiresHumanApproval?: boolean;
  humanApproved?: boolean;
  // Backend post-2026-05-03 stores nested approval object; legacy fixtures
  // used the flat boolean. UI must accept both.
  humanApproval?: { approved?: boolean };
  matchedRules?: MatchedRiskRule[];
  type?: 'feature' | 'bug';
  // Rich fields surfaced from the projection — populated by task_create
  // when the lead follows the EARS-spec system prompt.
  acceptanceCriteria?: string[];
  expectedDeliverables?: string[];
  dependencyTaskIds?: string[];
  testCommands?: string[];
  priority?: string;
}

interface BackendHistory {
  task?: BackendTask | null;
  taskEvents?: BackendTaskEvent[];
  runtimeEvents?: BackendTaskEvent[];
}

// Empty defaults for first render before the API responds. The modal
// only opens via a real task click, so these are placeholders that
// get filled in by the task_history_export call below — never user-
// visible mock data.
const EMPTY_DETAIL: TaskDetailData = {
  id: '',
  shortId: '',
  title: '',
  status: 'todo',
  assigneeId: '',
  leadId: '',
  reviewerId: '',
  createdAgo: '',
  branch: '',
  baseBranch: null,
  worktreeBranch: null,
  description: '',
  attachments: [],
  changes: [],
};

function formatTime(iso: string | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

function backendEventsToTimeline(events: BackendTaskEvent[]): ActivityEvent[] {
  return events.map((e) => {
    const type = e.eventType ?? e.type ?? '';
    const actor = e.actorId ?? 'unknown';
    const time = formatTime(e.createdAt);
    const payload = e.payload ?? {};

    if (type === 'COMMENT_ADDED') {
      return { kind: 'comment', actor, time, body: payload.text ?? payload.body ?? '' };
    }
    if (type === 'HUMAN_APPROVED' || type === 'REVIEW_DECIDED') {
      return { kind: 'approval', actor, time, body: payload.text ?? payload.body ?? 'Approved' };
    }
    if (type === 'STATUS_CHANGED') {
      return { kind: 'stage', actor, time, body: `Moved ${payload.fromStatus ?? '?'} → ${payload.toStatus ?? '?'}` };
    }
    if (type === 'TASK_CREATED') {
      return { kind: 'create', actor, time, body: 'Created task' };
    }
    if (type === 'tool_use' || type === 'TOOL_USE') {
      return {
        kind: 'change',
        actor,
        time,
        file: typeof payload.file === 'string' ? payload.file : '',
        added: typeof payload.added === 'number' ? payload.added : 0,
        removed: typeof payload.removed === 'number' ? payload.removed : 0,
        msg: typeof payload.body === 'string' ? payload.body : '',
      };
    }
    return { kind: 'log', actor, time, body: typeof payload.text === 'string' ? payload.text : type };
  });
}

const ICON_MAP: Record<ActivityKind, IconName> = {
  create: 'plus',
  log: 'terminal',
  change: 'edit',
  comment: 'inbox',
  approval: 'check',
  stage: 'workflow',
};
const LABEL_MAP: Record<ActivityKind, string> = {
  create: 'created task',
  log: 'ran',
  change: 'edited',
  comment: 'commented',
  approval: 'approved',
  stage: 'moved stage',
};

function ActivityRow({ event, team }: { event: ActivityEvent; team: Team }) {
  const member = team.members.find((m) => m.id === event.actor);
  const actor = member ?? {
    id: event.actor,
    name: event.actor,
    role: 'developer' as const,
    avatar: (event.actor[0] ?? '?').toUpperCase(),
  };
  const role = ROLES[actor.role] ?? ROLES.developer;

  if (event.kind === 'comment') {
    return (
      <div className="td-event td-event-comment" style={roleStyle(actor.role)}>
        <div className="agent-avatar td-event-avatar">{actor.avatar}</div>
        <div className="td-event-body">
          <div className="td-event-head">
            <span className="td-event-author">{actor.name}</span>
            <span className="td-event-role">{role.short}</span>
            <span className="td-event-time mono">{event.time}</span>
          </div>
          <div className="td-comment-body">{event.body}</div>
        </div>
      </div>
    );
  }

  if (event.kind === 'approval') {
    return (
      <div className="td-event td-event-comment" style={roleStyle(actor.role)}>
        <div className="agent-avatar td-event-avatar">{actor.avatar}</div>
        <div className="td-event-body">
          <div className="td-event-head">
            <span className="td-event-author">{actor.name}</span>
            <span
              className="chip"
              style={{
                background: 'oklch(0.72 0.15 145 / 0.14)',
                color: 'oklch(0.82 0.15 145)',
                borderColor: 'oklch(0.72 0.15 145 / 0.3)',
              }}
            >
              <Icon name="check" size={10} /> Approved
            </span>
            <span className="td-event-time mono">{event.time}</span>
          </div>
          <div className="td-comment-body">{event.body}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="td-event td-event-meta" style={roleStyle(actor.role)}>
      <div className="td-event-rail">
        <span className="td-event-icon"><Icon name={ICON_MAP[event.kind]} size={11} /></span>
      </div>
      <div className="td-event-meta-body">
        <span className="td-event-author" style={{ color: 'var(--accent)' }}>{actor.name}</span>
        <span className="dim">{LABEL_MAP[event.kind]}</span>
        {event.kind === 'change' && (
          <>
            {event.file && <span className="mono" style={{ color: 'var(--fg)' }}>{event.file}</span>}
            {typeof event.added === 'number' && <span className="mono" style={{ color: 'oklch(0.72 0.15 145)' }}>+{event.added}</span>}
            {typeof event.removed === 'number' && <span className="mono" style={{ color: 'oklch(0.65 0.20 25)' }}>−{event.removed}</span>}
            {event.msg && <span className="dim">— {event.msg}</span>}
          </>
        )}
        {(event.kind === 'log' || event.kind === 'create' || event.kind === 'stage') && (
          <span style={{ color: 'var(--fg-muted)' }}>{event.body}</span>
        )}
        <span className="td-event-time mono" style={{ marginLeft: 'auto' }}>{event.time}</span>
      </div>
    </div>
  );
}

interface TaskDetailModalProps {
  team: Team;
  taskId?: string;
  /** Optional pre-loaded projection so we can render risk/role/etc immediately
   * before the history fetch returns. */
  task?: UiTask;
  onClose: () => void;
  actor?: Actor;
}

const DEFAULT_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };
type TimelineFilter = 'all' | 'comments' | 'changes' | 'logs';

export function TaskDetailModal({ team, taskId, task, onClose, actor = DEFAULT_ACTOR }: TaskDetailModalProps) {
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const [composer, setComposer] = useState('');
  const [detail, setDetail] = useState<TaskDetailData>(() => {
    if (!task) return EMPTY_DETAIL;
    const safeId = task.id || taskId || '';
    return {
      ...EMPTY_DETAIL,
      id: safeId,
      shortId: safeId.slice(0, 8),
      title: task.title || safeId,
      status: task.status,
      assigneeId: task.assignee || EMPTY_DETAIL.assigneeId,
      riskLevel: task.riskLevel ?? null,
      requiresHumanApproval: task.requiresHumanApproval,
      humanApproved: task.humanApproved,
      matchedRules: task.matchedRules,
      type: task.type,
    };
  });
  const [timeline, setTimeline] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !posting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, posting]);

  useEffect(() => {
    if (!taskId) return;
    let cancelled = false;
    const ac = new AbortController();
    setLoading(true);
    setLoadError(null);
    callTool<BackendHistory>({
      actor: { ...actor, teamId: actor.teamId || 'default' },
      method: 'task_history_export',
      args: { taskId },
      signal: ac.signal,
    })
      .then((res) => {
        if (cancelled) return;
        if (res?.task) {
          // Backend projection uses `taskId`/`subject`; legacy fixtures
          // used `id`/`title`. Read both so we never render an empty
          // header when the task itself has data.
          const t = res.task;
          const taskIdOut = t.taskId ?? t.id ?? '';
          const titleOut = t.subject ?? t.title ?? taskIdOut;
          // Status mapping: backend uses pending/in_progress/completed;
          // UI's TaskStatus union expects todo/in-progress/done.
          const statusMap: Record<string, UiTask['status']> = {
            pending: 'todo', todo: 'todo',
            in_progress: 'in-progress', 'in-progress': 'in-progress',
            review: 'review',
            completed: 'done', done: 'done',
            blocked: 'blocked', rejected: 'rejected',
          };
          const status = statusMap[t.status ?? 'pending'] ?? 'todo';
          // assigneeId: prefer ownerId (an actual agentId) over
          // assignedRole when both present, since ownerId is what the
          // sidebar matches against. Apply the same tester→qa mapping
          // used in the workspace agent normalization.
          const rawAssignee = t.ownerId ?? t.assignedRole ?? '';
          const assignee = rawAssignee === 'tester' ? 'qa' : rawAssignee;
          const humanApprovedOut =
            (t.humanApproval && t.humanApproval.approved === true)
            || t.humanApproved === true;
          setDetail((prev) => ({
            ...prev,
            id: taskIdOut,
            shortId: taskIdOut.slice(0, 8),
            title: titleOut,
            status,
            description: t.description ?? prev.description,
            branch: t.branch ?? prev.branch,
            baseBranch: t.baseBranch ?? prev.baseBranch,
            worktreeBranch:
              (t.worktree && typeof t.worktree.branch === 'string'
                ? t.worktree.branch
                : null) ?? prev.worktreeBranch,
            assigneeId: assignee || prev.assigneeId,
            riskLevel: t.riskLevel ?? prev.riskLevel,
            requiresHumanApproval: t.requiresHumanApproval ?? prev.requiresHumanApproval,
            humanApproved: humanApprovedOut,
            matchedRules: Array.isArray(t.matchedRules) ? t.matchedRules : prev.matchedRules,
            type: t.type === 'bug' || t.type === 'feature' ? t.type : prev.type,
            priority: t.priority ?? prev.priority,
            acceptanceCriteria: Array.isArray(t.acceptanceCriteria) ? t.acceptanceCriteria : prev.acceptanceCriteria,
            expectedDeliverables: Array.isArray(t.expectedDeliverables) ? t.expectedDeliverables : prev.expectedDeliverables,
            dependencyTaskIds: Array.isArray(t.dependencyTaskIds) ? t.dependencyTaskIds : prev.dependencyTaskIds,
            testCommands: Array.isArray(t.testCommands) ? t.testCommands : prev.testCommands,
          }));
        }
        const merged = [
          ...(res?.taskEvents ? backendEventsToTimeline(res.taskEvents) : []),
          ...(res?.runtimeEvents ? backendEventsToTimeline(res.runtimeEvents) : []),
        ];
        if (merged.length > 0) setTimeline(merged);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = err instanceof ToadApiError ? err.message
          : err instanceof Error ? err.message
          : 'Failed to load task history';
        setLoadError(message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [taskId, actor]);

  const filtered = useMemo(() => {
    if (filter === 'all') return timeline;
    if (filter === 'comments') return timeline.filter((e) => e.kind === 'comment' || e.kind === 'approval');
    if (filter === 'changes') return timeline.filter((e) => e.kind === 'change');
    return timeline.filter((e) => e.kind === 'log' || e.kind === 'create' || e.kind === 'stage');
  }, [timeline, filter]);

  const counts = useMemo(() => ({
    all: timeline.length,
    comments: timeline.filter((e) => e.kind === 'comment' || e.kind === 'approval').length,
    changes: timeline.filter((e) => e.kind === 'change').length,
    logs: timeline.filter((e) => e.kind === 'log' || e.kind === 'create' || e.kind === 'stage').length,
  }), [timeline]);

  const assignee = team.members.find((m) => m.id === detail.assigneeId);
  const lead = team.members.find((m) => m.id === detail.leadId);
  const reviewer = team.members.find((m) => m.id === detail.reviewerId);
  const totalAdded = detail.changes.reduce((a, c) => a + c.added, 0);
  const totalRemoved = detail.changes.reduce((a, c) => a + c.removed, 0);

  async function handleComment() {
    if (!composer.trim() || !taskId) return;
    setPosting(true);
    setPostError(null);
    try {
      await callTool({
        actor,
        method: 'task_comment',
        args: { taskId, text: composer.trim() },
        idempotencyKey: `task-comment-${taskId}-${Date.now()}`,
      });
      setTimeline((prev) => [
        ...prev,
        {
          kind: 'comment',
          actor: actor.agentId,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          body: composer.trim(),
        },
      ]);
      setComposer('');
    } catch (err) {
      const message = err instanceof ToadApiError ? err.message
        : err instanceof Error ? err.message
        : 'Failed to post comment';
      setPostError(message);
    } finally {
      setPosting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal td-modal" onClick={(e) => e.stopPropagation()}>
        <div className="td-head">
          <div className="td-head-left">
            <span className="mono td-shortid">#{detail.shortId}</span>
            <span
              className="chip"
              style={{
                background: 'oklch(0.78 0.14 80 / 0.14)',
                color: 'oklch(0.85 0.14 80)',
                borderColor: 'oklch(0.78 0.14 80 / 0.3)',
              }}
            >
              <span className="status-dot" style={{ background: 'oklch(0.78 0.14 80)' }} />
              {detail.status === 'in-progress' ? 'In progress' : detail.status}
            </span>
            {detail.riskLevel && (
              <TaskRiskBadge
                level={detail.riskLevel}
                requiresHumanApproval={detail.requiresHumanApproval}
                humanApproved={detail.humanApproved}
                matchedRules={detail.matchedRules}
                variant="full"
              />
            )}
            <span className="dim">·</span>
            <span className="dim">Type: {detail.type === 'bug' ? 'Bug' : 'Feature'}</span>
            <span className="dim">·</span>
            <span className="dim mono">{detail.id}</span>
            <span className="dim">·</span>
            <span className="dim">{detail.createdAgo}</span>
            {loading && <span className="dim" style={{ marginLeft: 8 }}>Loading…</span>}
          </div>
          <div className="td-head-right">
            <button className="btn btn-sm btn-ghost" type="button"><Icon name="eye" size={12} /> Open team</button>
            <button className="icon-btn" title="More" type="button"><Icon name="moreH" size={14} /></button>
            <button className="icon-btn" onClick={onClose} type="button"><Icon name="x" size={16} /></button>
          </div>
        </div>

        {loadError && (
          <div
            style={{
              padding: '6px 14px',
              background: 'oklch(0.30 0.06 60)',
              color: 'oklch(0.92 0.06 80)',
              fontSize: 12,
            }}
          >
            Couldn't load task history — showing seed data. {loadError}
          </div>
        )}

        <div className="td-body">
          <div className="td-main">
            <h1 className="td-title">{detail.title}</h1>

            <div className="td-desc">
              {detail.description.split('\n').map((line, i) => {
                if (line.startsWith('- ') || line.startsWith('• ')) {
                  return <li key={i}>{line.replace(/^[-•]\s/, '')}</li>;
                }
                return <p key={i} style={line.trim() === '' ? { height: 4 } : undefined}>{line}</p>;
              })}
            </div>

            {/* Rich-content sections — populated when the lead's task_create
                call followed the EARS-spec system prompt (acceptance, deliverables,
                dependencies). Each block hides itself when its array is empty
                so legacy tasks created before the prompt change don't show
                empty placeholders. */}
            {((detail.acceptanceCriteria && detail.acceptanceCriteria.length > 0)
              || (detail.expectedDeliverables && detail.expectedDeliverables.length > 0)
              || (detail.dependencyTaskIds && detail.dependencyTaskIds.length > 0)
              || (detail.testCommands && detail.testCommands.length > 0)
              || detail.priority) ? (
              <div className="td-section" style={{ marginTop: 18 }}>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 14 }}>
                  {detail.priority ? (
                    <div>
                      <div className="td-side-label" style={{ marginBottom: 4 }}>Priority</div>
                      <div style={{ fontSize: 13, textTransform: 'capitalize', fontWeight: 600,
                          color: detail.priority === 'critical' || detail.priority === 'high'
                            ? 'var(--err, #f87171)'
                            : detail.priority === 'medium' ? 'var(--warn, #ffcd66)' : 'var(--fg)' }}>
                        {detail.priority}
                      </div>
                    </div>
                  ) : null}
                  {detail.dependencyTaskIds && detail.dependencyTaskIds.length > 0 ? (
                    <div>
                      <div className="td-side-label" style={{ marginBottom: 4 }}>Depends on</div>
                      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                        {detail.dependencyTaskIds.map((dep) => (
                          <span key={dep} className="chip mono" style={{ fontSize: 11 }}>{dep}</span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>

                {detail.acceptanceCriteria && detail.acceptanceCriteria.length > 0 ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="td-side-label" style={{ marginBottom: 6 }}>Acceptance criteria</div>
                    <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--fg)', fontSize: 13, lineHeight: 1.55 }}>
                      {detail.acceptanceCriteria.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                ) : null}

                {detail.expectedDeliverables && detail.expectedDeliverables.length > 0 ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="td-side-label" style={{ marginBottom: 6 }}>Expected deliverables</div>
                    <ul style={{ margin: 0, paddingLeft: 20, color: 'var(--fg)', fontSize: 13, lineHeight: 1.55 }}>
                      {detail.expectedDeliverables.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  </div>
                ) : null}

                {detail.testCommands && detail.testCommands.length > 0 ? (
                  <div style={{ marginTop: 14 }}>
                    <div className="td-side-label" style={{ marginBottom: 6 }}>Test commands</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                      {detail.testCommands.map((c, i) => (
                        <code key={i} className="mono" style={{
                          fontSize: 12,
                          padding: '4px 8px',
                          background: 'var(--bg-panel, rgba(255,255,255,0.04))',
                          borderRadius: 4,
                          color: 'var(--fg)',
                        }}>{c}</code>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {(detail.status === 'review' || taskId) && taskId && (
              <ReviewComposer
                taskId={taskId}
                changedFiles={[]}
                actor={actor}
                onDecided={() => {
                  // Refresh would normally come from a parent. For now we just
                  // close the composer; parent can re-fetch via the projection
                  // hook the next time the modal reopens.
                }}
              />
            )}

            <div className="td-section">
              <div className="td-section-head">
                <h3>Activity</h3>
                <div className="seg">
                  {(['all', 'comments', 'changes', 'logs'] as TimelineFilter[]).map((v) => (
                    <button
                      key={v}
                      className={filter === v ? 'active' : ''}
                      onClick={() => setFilter(v)}
                      type="button"
                    >
                      {v === 'all' ? 'All' : v[0].toUpperCase() + v.slice(1)}
                      <span style={{ color: 'var(--fg-dim)', marginLeft: 4 }}>{counts[v]}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="td-timeline">
                {filtered.map((e, i) => <ActivityRow key={i} event={e} team={team} />)}
              </div>
            </div>
          </div>

          <aside className="td-side">
            <div className="td-side-block">
              <div className="td-side-label">Assignee</div>
              {assignee && (
                <div className="td-people-row" style={roleStyle(assignee.role)}>
                  <div className="agent-avatar" style={{ width: 26, height: 26, fontSize: 11 }}>{assignee.avatar}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}>{assignee.name}</div>
                    <div className="dim" style={{ fontSize: 11 }}>{ROLES[assignee.role].short}</div>
                  </div>
                  <button className="icon-btn" type="button"><Icon name="edit" size={12} /></button>
                </div>
              )}
            </div>

            <div className="td-side-block">
              <div className="td-side-label">Reviewer</div>
              {reviewer && (
                <div className="td-people-row" style={roleStyle(reviewer.role)}>
                  <div className="agent-avatar" style={{ width: 26, height: 26, fontSize: 11 }}>{reviewer.avatar}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}>{reviewer.name}</div>
                    <div className="dim" style={{ fontSize: 11 }}>{ROLES[reviewer.role].short}</div>
                  </div>
                </div>
              )}
            </div>

            <div className="td-side-block">
              <div className="td-side-label">Team</div>
              {lead && (
                <div className="td-people-row" style={roleStyle(lead.role)}>
                  <div className="agent-avatar" style={{ width: 26, height: 26, fontSize: 11 }}>{lead.avatar}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ color: 'var(--accent)', fontWeight: 600, fontSize: 13 }}>{team.name}</div>
                    <div className="dim" style={{ fontSize: 11 }}>led by {lead.name}</div>
                  </div>
                </div>
              )}
            </div>

            <div className="td-side-block">
              <div className="td-side-label">GitHub</div>
              <OpenPullRequestButton
                taskId={detail.id}
                taskTitle={detail.title}
                headBranch={detail.worktreeBranch ?? detail.branch ?? null}
                baseBranch={detail.baseBranch}
                actor={actor}
              />
            </div>

            <div className="td-side-block">
              <div className="td-side-label">Lifecycle</div>
              <TaskLifecycle
                status={detail.status}
                visited={timeline
                  .filter((e) => e.kind === 'stage')
                  .map((e) => e.body ?? '')
                  .flatMap((body) => {
                    // Stage events read like "Moved <from> -> <to>" — pull both ends.
                    const m = /^moved\s+(\S+)\s*(?:→|->)\s*(\S+)/i.exec(body);
                    return m ? [m[1], m[2]] : [];
                  })}
              />
            </div>

            <div className="td-side-block">
              <div className="td-side-label-row">
                <span className="td-side-label">Changes</span>
                <span className="mono dim" style={{ fontSize: 11 }}>
                  <span style={{ color: 'oklch(0.72 0.15 145)' }}>+{totalAdded}</span>{' '}
                  <span style={{ color: 'oklch(0.65 0.20 25)' }}>−{totalRemoved}</span>
                </span>
              </div>
              {detail.changes.map((c, i) => (
                <div key={i} className="td-change-row">
                  <Icon name="file" size={11} style={{ color: 'var(--fg-dim)', flexShrink: 0 }} />
                  <span
                    className="mono"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      fontSize: 11.5,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {c.file}
                  </span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'oklch(0.72 0.15 145)' }}>+{c.added}</span>
                  <span className="mono" style={{ fontSize: 10.5, color: 'oklch(0.65 0.20 25)' }}>−{c.removed}</span>
                </div>
              ))}
            </div>

            <div className="td-side-block">
              <div className="td-side-label">
                Attachments <span className="dim">{detail.attachments.length}</span>
              </div>
              {detail.attachments.map((a, i) => (
                <div key={i} className="td-att-row">
                  <Icon name={a.kind === 'code' ? 'code' : 'file'} size={12} style={{ color: 'var(--fg-muted)' }} />
                  <span
                    className="mono"
                    style={{
                      fontSize: 11.5,
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {a.name}
                  </span>
                  <span className="dim" style={{ fontSize: 10.5 }}>{a.size}</span>
                </div>
              ))}
            </div>
          </aside>
        </div>

        <div className="td-composer">
          <div className="td-composer-target">
            <span className="dim">Comment as</span>
            <span className="chip solid" style={roleStyle('lead')}>
              <span className="chip-dot" style={{ background: 'var(--accent)' }} />
              <span style={{ color: 'var(--accent)' }}>{actor.agentId}</span>
            </span>
            <span className="dim" style={{ marginLeft: 'auto', fontSize: 11 }}>
              <span className="kbd">⌘</span> <span className="kbd">↵</span> to send
            </span>
          </div>
          <div className="td-composer-input">
            <textarea
              className="composer-textarea"
              placeholder="Leave a comment, mention an agent with @, link a task with #…"
              rows={2}
              value={composer}
              onChange={(e) => setComposer(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void handleComment();
                }
              }}
              disabled={posting}
            />
            <div className="composer-actions">
              <div style={{ display: 'flex', gap: 4 }}>
                <button className="icon-btn" type="button"><Icon name="paperclip" size={14} /></button>
                <button className="icon-btn" type="button"><Icon name="mic" size={14} /></button>
                <button className="btn btn-sm btn-ghost" type="button">
                  <Icon name="workflow" size={12} /> Suggest a task
                </button>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {postError && <span style={{ color: 'var(--err)', fontSize: 11 }}>{postError}</span>}
                <button className="btn btn-sm" type="button" disabled={posting}>Approve</button>
                <button
                  className="btn btn-sm btn-primary"
                  type="button"
                  onClick={handleComment}
                  disabled={posting || !composer.trim() || !taskId}
                  title={!taskId ? 'Select a task to comment' : undefined}
                >
                  <Icon name="send" size={11} /> {posting ? 'Posting…' : 'Comment'}
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
