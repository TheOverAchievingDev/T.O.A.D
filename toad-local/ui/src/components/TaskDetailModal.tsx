import { useEffect, useMemo, useState } from 'react';
import type { Team, UiTask, TaskRiskLevel, MatchedRiskRule } from '@/types';
import { ROLES, roleStyle } from '@/data/roles';
import { Icon, type IconName } from './Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import { PlanSection } from './task-detail/PlanSection';
import { DiffSection } from './task-detail/DiffSection';
import { ValidationsSection } from './task-detail/ValidationsSection';
import { TaskRiskBadge } from './TaskRiskBadge';
import { ReviewComposer } from './ReviewComposer';
import { SEED_PLAN, SEED_DIFF_FILES, SEED_VALIDATIONS } from './task-detail/seed';

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
  description: string;
  attachments: { name: string; size: string; kind: 'code' | 'doc' }[];
  changes: { file: string; added: number; removed: number }[];
  riskLevel?: TaskRiskLevel | null;
  requiresHumanApproval?: boolean;
  humanApproved?: boolean;
  matchedRules?: MatchedRiskRule[];
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
  id: string;
  title?: string;
  status?: UiTask['status'];
  assignedRole?: string;
  description?: string;
  branch?: string;
  createdAt?: string;
  riskLevel?: TaskRiskLevel | null;
  requiresHumanApproval?: boolean;
  humanApproved?: boolean;
  matchedRules?: MatchedRiskRule[];
}

interface BackendHistory {
  task?: BackendTask | null;
  taskEvents?: BackendTaskEvent[];
  runtimeEvents?: BackendTaskEvent[];
}

const SEED_DETAIL: TaskDetailData = {
  id: 'T-481',
  shortId: '5efa854c',
  title: 'Streaming buffer for transcription',
  status: 'in-progress',
  assigneeId: 'tom',
  leadId: 'lead',
  reviewerId: 'alice',
  createdAgo: 'about 3 hours ago',
  branch: 'feature/transcribe-v2',
  description: `Implement a streaming transcription buffer in src/audio/stream.ts that exposes streamTranscribe() as an async iterator. Preserve the current 4096-frame default chunk size and allow override via the AUDIO_CHUNK_FRAMES env var.

Requirements:
- Single index.ts with no new dependencies
- Buffer flush on pause must emit any partial frame (don't drop trailing audio)
- Dual-reversal guard around stream pause/resume
- Emit a 'partial' event for in-progress transcripts`,
  attachments: [
    { name: 'src/audio/stream.ts', size: '264 lines', kind: 'code' },
    { name: 'audio-pipeline.md', size: '2 KB', kind: 'doc' },
    { name: 'stream.test.ts', size: '180 lines', kind: 'code' },
  ],
  changes: [
    { file: 'src/audio/stream.ts', added: 128, removed: 41 },
    { file: 'src/audio/buffer.ts', added: 22, removed: 8 },
    { file: 'tests/stream.test.ts', added: 64, removed: 0 },
  ],
};

const SEED_TIMELINE: ActivityEvent[] = [
  { kind: 'create', actor: 'lead', time: '14:00', body: 'Created task and assigned to tom' },
  { kind: 'log', actor: 'tom', time: '14:03', body: 'Started work — pulled chunking logic into src/audio/stream.ts' },
  { kind: 'change', actor: 'tom', time: '14:31', file: 'src/audio/stream.ts', added: 128, removed: 41, msg: 'Add streamTranscribe() async iterator' },
  { kind: 'log', actor: 'tom', time: '14:32', body: 'Tests: 8 passed (1.2s) · stream.test.ts' },
  { kind: 'comment', actor: 'tom', time: '14:34', body: 'Implementation complete. Single file, no external deps.' },
  { kind: 'comment', actor: 'alice', time: '14:38', body: 'Review of #5efa854c — looking solid. Verified the dual-reversal guard catches the race.' },
  { kind: 'approval', actor: 'alice', time: '14:39', body: 'Meets all requirements; clean implementation.' },
  { kind: 'stage', actor: 'lead', time: '14:45', body: 'Moved to Review stage' },
];

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
    if (!task) return SEED_DETAIL;
    return {
      ...SEED_DETAIL,
      id: task.id,
      shortId: task.id.slice(0, 8),
      title: task.title,
      status: task.status,
      assigneeId: task.assignee || SEED_DETAIL.assigneeId,
      riskLevel: task.riskLevel ?? null,
      requiresHumanApproval: task.requiresHumanApproval,
      humanApproved: task.humanApproved,
      matchedRules: task.matchedRules,
    };
  });
  const [timeline, setTimeline] = useState<ActivityEvent[]>(SEED_TIMELINE);
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
          setDetail((prev) => ({
            ...prev,
            id: res.task!.id,
            shortId: res.task!.id.slice(0, 8),
            title: res.task!.title ?? res.task!.id,
            status: (res.task!.status ?? 'in-progress') as UiTask['status'],
            description: res.task!.description ?? prev.description,
            branch: res.task!.branch ?? prev.branch,
            assigneeId: res.task!.assignedRole ?? prev.assigneeId,
            riskLevel: res.task!.riskLevel ?? prev.riskLevel,
            requiresHumanApproval: res.task!.requiresHumanApproval ?? prev.requiresHumanApproval,
            humanApproved: res.task!.humanApproved ?? prev.humanApproved,
            matchedRules: Array.isArray(res.task!.matchedRules) ? res.task!.matchedRules : prev.matchedRules,
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

            <PlanSection team={team} plan={SEED_PLAN} />
            <DiffSection files={SEED_DIFF_FILES} />
            <ValidationsSection validations={SEED_VALIDATIONS} />

            {(detail.status === 'review' || taskId) && taskId && (
              <ReviewComposer
                taskId={taskId}
                changedFiles={SEED_DIFF_FILES.map((f) => f.path)}
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
              <div className="td-side-label">Workflow</div>
              <div className="td-workflow">
                {[
                  { id: 'todo', label: 'To do', done: detail.status !== 'todo' },
                  { id: 'in-progress', label: 'In progress', active: detail.status === 'in-progress' },
                  { id: 'review', label: 'Review', active: detail.status === 'review' },
                  { id: 'done', label: 'Done', done: detail.status === 'done' },
                ].map((s) => (
                  <div key={s.id} className={`td-wf-step ${s.done ? 'done' : ''} ${s.active ? 'active' : ''}`}>
                    <span className="td-wf-dot" />
                    <span>{s.label}</span>
                  </div>
                ))}
              </div>
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
