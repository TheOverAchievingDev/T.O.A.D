import type { Agent, TaskStatus, UiTask } from '@/types';
import type { StreamEntry } from '@/utils/agentStream';
import type { ReactNode } from 'react';
import type { TimelineEvent, TimelineDot } from './FlowTimeline';

/**
 * A single task transition observed via snapshot delta (parent
 * compares prev vs current tasks list). Phase 3a Task 5 keeps this
 * client-side — no backend changes — at the cost of only surfacing
 * transitions that happen while the timeline is mounted. Phase 5 can
 * swap to a backend task_events_list_recent for cross-session history.
 */
export interface TaskTransition {
  taskId: string;
  title: string;
  /** null when the task is newly created (no prior status). */
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus;
  /** Agent who likely triggered the transition (from task.assignee). */
  agentId: string | null;
  /** Wall-clock ms the parent observed the change. */
  at: number;
}

/**
 * Phase 2 timeline projection — turns raw agent stream entries + drift
 * history into the plain-English event list rendered by FlowTimeline.
 *
 * Phase 2 deliberately ships a SIMPLE version per the plan's risk
 * register: agent stream tool calls become "agent X did Y" lines,
 * drift score changes become "drift moved from X% → Y%" lines. Phase 3
 * polish can layer in:
 *   - Task lifecycle transitions (task moved to review / merge_ready /
 *     done) — needs a task_events history not yet exposed in the UI.
 *   - Message exchanges between agents — needs threading logic.
 *   - Smart deduplication of bursts ("dev-1 edited OrderForm.tsx" fires
 *     once even if there were 12 Edit tool calls).
 *
 * The function is pure + testable. Inputs are all immutable references.
 */

export interface TimelineProjectionInput {
  agentStreams: Record<string, StreamEntry[]>;
  agents: Agent[];
  /** Recent drift runs ascending by createdAt (or any order; sorted
   *  internally). Only the last 3 are considered to keep noise down. */
  driftHistory?: Array<{ runId: string; teamScore: number; createdAt: string }>;
  /** Phase 3a Task 5 — recent task lifecycle transitions observed by
   *  the parent. Most-recent first. Cap usually 10 (parent decides). */
  taskTransitions?: TaskTransition[];
  /** Optional current task selection — used to render the hero header
   *  above the timeline. Not part of the event list itself. */
  activeTask?: UiTask | null;
  /** "Now" in epoch ms — injected so tests can use a fixed clock. */
  now?: number;
  /** Cap on the number of events returned. Default 8. */
  limit?: number;
}

interface RawCandidate {
  agentId: string;
  entry: StreamEntry;
  ts: number;
}

/**
 * Best-effort timestamp parse from a stream entry's HH:MM:SS time
 * string. The current StreamEntry shape only carries time-of-day, not
 * the date — we assume today and resolve ambiguous "earlier today"
 * vs "yesterday" using `now`. Events whose time-of-day appears later
 * than `now` are presumed to be from yesterday.
 */
function parseStreamTimestamp(entry: StreamEntry, now: number): number {
  const parts = entry.time.split(':').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return now;
  const [hh, mm, ss] = parts;
  const candidate = new Date(now);
  candidate.setHours(hh, mm, ss, 0);
  let ts = candidate.getTime();
  if (ts > now) ts -= 24 * 60 * 60 * 1000;
  return ts;
}

function formatRelative(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}

function dotForStream(entry: StreamEntry): TimelineDot {
  // Most agent activity reads as the clay accent; system/output land
  // on tonally neutral colors. Phase 3 can refine.
  switch (entry.kind) {
    case 'tool':    return 'clay';
    case 'output':  return 'green';
    case 'thought': return 'blue';
    case 'system':  return 'amber';
    default:        return 'clay';
  }
}

function dotForDrift(prev: number, next: number): TimelineDot {
  if (next > prev) return 'amber';
  if (next < prev) return 'green';
  return 'clay';
}

/** Format an agent's stream entry into a body line.
 *
 *  Examples:
 *    "dev-1 ran Bash — npm run test:e2e"
 *    "dev-1 edited OrderForm.tsx"
 *    "lead sent task_create — t_42 — bulk subscription quantity"
 */
function bodyForStream(agentName: string, entry: StreamEntry): { body: ReactNode; expanded?: boolean } {
  const verb = entry.kind === 'tool'
    ? (entry.tool === 'Edit' || entry.tool === 'Write'
        ? 'edited'
        : entry.tool === 'Read'
          ? 'opened'
          : entry.tool === 'Bash'
            ? 'ran'
            : entry.tool === 'Grep' || entry.tool === 'Glob'
              ? 'searched for'
              : 'used')
    : entry.kind === 'output'
      ? 'reported'
      : entry.kind === 'thought'
        ? 'thinking:'
        : 'system:';

  const toolLabel = entry.tool ?? entry.kind;

  return {
    body: (
      <>
        <span className="agent">{agentName}</span>{' '}
        {verb}{' '}
        {entry.kind === 'tool' && entry.tool ? <span className="file">{toolLabel}</span> : null}
        {entry.body ? <> — {entry.body}</> : null}
      </>
    ),
  };
}

export function projectTimeline(input: TimelineProjectionInput): TimelineEvent[] {
  const now = input.now ?? Date.now();
  const limit = input.limit ?? 8;
  const agentName = new Map<string, string>();
  for (const a of input.agents) agentName.set(a.id, a.name);

  // Collect candidates from all agent streams (latest 4 per agent so
  // one chatty agent doesn't dominate the list).
  const candidates: RawCandidate[] = [];
  for (const [agentId, entries] of Object.entries(input.agentStreams)) {
    const recent = entries.slice(-4);
    for (const entry of recent) {
      candidates.push({
        agentId,
        entry,
        ts: parseStreamTimestamp(entry, now),
      });
    }
  }

  // Sort by recency desc.
  candidates.sort((a, b) => b.ts - a.ts);
  // Cap candidates so the projection stays cheap even with chatty
  // teams.
  const head = candidates.slice(0, limit);

  // Drift events from history — emit one per consecutive-change pair
  // when the score moved by >= 3 points. Capped at 2 entries.
  const driftEvents: TimelineEvent[] = [];
  const driftHist = (input.driftHistory ?? [])
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-4);
  for (let i = 1; i < driftHist.length && driftEvents.length < 2; i++) {
    const prev = driftHist[i - 1];
    const curr = driftHist[i];
    if (Math.abs(curr.teamScore - prev.teamScore) < 3) continue;
    const ts = Date.parse(curr.createdAt);
    if (Number.isNaN(ts)) continue;
    driftEvents.push({
      id: `drift-${curr.runId}`,
      when: formatRelative(ts, now),
      dot: dotForDrift(prev.teamScore, curr.teamScore),
      body: (
        <>
          Drift run completed — score moved from <b>{prev.teamScore}%</b> → <b>{curr.teamScore}%</b>.
        </>
      ),
    });
  }

  const streamEvents: Array<TimelineEvent & { _ts: number }> = head.map(({ agentId, entry, ts }, idx) => {
    const name = agentName.get(agentId) ?? agentId;
    const { body, expanded } = bodyForStream(name, entry);
    return {
      id: `stream-${entry.id}-${idx}`,
      when: formatRelative(ts, now),
      dot: dotForStream(entry),
      expanded: idx === 0 ? true : expanded, // First event renders expanded for emphasis
      body,
      _ts: ts,
    };
  });

  // Phase 3a Task 5 — task lifecycle events from parent-tracked
  // snapshot deltas. Each transition becomes a timeline entry; agent
  // name is resolved from the agents map when available.
  const lifecycleEvents: Array<TimelineEvent & { _ts: number }> =
    (input.taskTransitions ?? []).map((t) => {
      const agentLabel = t.agentId ? (agentName.get(t.agentId) ?? t.agentId) : null;
      const body = lifecycleBody(t, agentLabel);
      return {
        id: `task-${t.taskId}-${t.at}`,
        when: formatRelative(t.at, now),
        dot: lifecycleDot(t),
        body,
        _ts: t.at,
      };
    });

  // Merge all event sources. Sort by recency (descending) so the
  // operator's eye lands on what just happened. Drop the internal _ts
  // key on the way out.
  const driftWithTs = driftEvents.map((e, i) => ({ ...e, _ts: (input.driftHistory?.length ?? 0) * 1000 - i }));
  const merged: Array<TimelineEvent & { _ts: number }> = [
    ...streamEvents,
    ...lifecycleEvents,
    ...driftWithTs,
  ];
  merged.sort((a, b) => b._ts - a._ts);
  return merged.slice(0, limit).map(({ _ts: _, ...rest }) => rest);
}

function lifecycleDot(t: TaskTransition): TimelineDot {
  if (t.fromStatus === null) return 'blue';
  if (t.toStatus === 'done') return 'green';
  if (t.toStatus === 'blocked' || t.toStatus === 'rejected') return 'amber';
  if (t.toStatus === 'review') return 'violet';
  return 'clay';
}

function lifecycleBody(t: TaskTransition, agentLabel: string | null): ReactNode {
  if (t.fromStatus === null) {
    return (
      <>
        {agentLabel ? <span className="agent">{agentLabel}</span> : 'lead'}{' '}
        created task <span className="file">{t.taskId}</span> — {t.title}.
      </>
    );
  }
  if (t.toStatus === 'done') {
    return (
      <>
        <span className="file">{t.taskId}</span> done
        {agentLabel ? <> · finished by <span className="agent">{agentLabel}</span></> : null}.
      </>
    );
  }
  return (
    <>
      <span className="file">{t.taskId}</span>{' '}
      moved <b>{t.fromStatus}</b> → <b>{t.toStatus}</b>
      {agentLabel ? <> by <span className="agent">{agentLabel}</span></> : null}.
    </>
  );
}
