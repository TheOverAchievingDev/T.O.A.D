import type { Agent, TaskStatus, UiTask } from '@/types';
import type { StreamEntry } from '@/utils/agentStream';
import type { ReactNode } from 'react';
import type { TimelineEvent, TimelineDot } from './FlowTimeline';
import { composeTimeline } from '../../../../src/runtime/timelineComposition/index.js';
import { projectSpanSummaryEvents, type SpanSummaryRow } from './spanSummaryProjection';

interface ComposedRow {
  id: string;
  when: string;
  dot: string;
  expanded?: boolean;
  kind: 'stream' | 'drift' | 'lifecycle';
  stream?: { agentName: string; entryKind: string; tool?: string; body: string };
  drift?: { prevScore: number; nextScore: number };
  lifecycle?: { taskId: string; title: string; fromStatus: string | null; toStatus: string; agentLabel: string | null };
}

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
  /** P3c-2 — persisted span summaries (P3c-1 span_summary_list rows).
   *  Prepended (most-recent-first) ahead of the composeTimeline rows. */
  spanSummaries?: SpanSummaryRow[];
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

/** Format an agent's stream entry into a body line.
 *
 *  Examples:
 *    "dev-1 ran Bash — npm run test:e2e"
 *    "dev-1 edited OrderForm.tsx"
 *    "lead sent task_create — t_42 — bulk subscription quantity"
 */
function bodyForStream(p: NonNullable<ComposedRow['stream']>): { body: ReactNode } {
  const verb = p.entryKind === 'tool'
    ? (p.tool === 'Edit' || p.tool === 'Write'
        ? 'edited'
        : p.tool === 'Read'
          ? 'opened'
          : p.tool === 'Bash'
            ? 'ran'
            : p.tool === 'Grep' || p.tool === 'Glob'
              ? 'searched for'
              : 'used')
    : p.entryKind === 'output'
      ? 'reported'
      : p.entryKind === 'thought'
        ? 'thinking:'
        : 'system:';

  const toolLabel = p.tool ?? p.entryKind;

  return {
    body: (
      <>
        <span className="agent">{p.agentName}</span>{' '}
        {verb}{' '}
        {p.entryKind === 'tool' && p.tool ? <span className="file">{toolLabel}</span> : null}
        {p.body ? <> — {p.body}</> : null}
      </>
    ),
  };
}

function driftBody(d: NonNullable<ComposedRow['drift']>): ReactNode {
  return (
    <>
      Drift run completed — score moved from <b>{d.prevScore}%</b> → <b>{d.nextScore}%</b>.
    </>
  );
}

function lifecycleBody(lc: NonNullable<ComposedRow['lifecycle']>): ReactNode {
  if (lc.fromStatus === null) {
    return (
      <>
        {lc.agentLabel ? <span className="agent">{lc.agentLabel}</span> : 'lead'}{' '}
        created task <span className="file">{lc.taskId}</span> — {lc.title}.
      </>
    );
  }
  if (lc.toStatus === 'done') {
    return (
      <>
        <span className="file">{lc.taskId}</span> done
        {lc.agentLabel ? <> · finished by <span className="agent">{lc.agentLabel}</span></> : null}.
      </>
    );
  }
  return (
    <>
      <span className="file">{lc.taskId}</span>{' '}
      moved <b>{lc.fromStatus}</b> → <b>{lc.toStatus}</b>
      {lc.agentLabel ? <> by <span className="agent">{lc.agentLabel}</span></> : null}.
    </>
  );
}

function renderBody(row: ComposedRow): ReactNode {
  if (row.kind === 'stream') return bodyForStream(row.stream!).body;
  if (row.kind === 'drift') return driftBody(row.drift!);
  if (row.kind === 'lifecycle') return lifecycleBody(row.lifecycle!);
  return null;
}

export function projectTimeline(input: TimelineProjectionInput): TimelineEvent[] {
  const now = input.now ?? Date.now();

  const agentStreams: Record<string, Array<{ entryId: string; kind: string; tool?: string; body: string; ts: number }>> = {};
  for (const [agentId, entries] of Object.entries(input.agentStreams)) {
    agentStreams[agentId] = entries.map(e => ({
      entryId: e.id,
      kind: e.kind,
      tool: e.tool,
      body: e.body,
      ts: parseStreamTimestamp(e, now),
    }));
  }

  const rows = composeTimeline({
    agentStreams,
    agents: input.agents,
    driftHistory: input.driftHistory,
    taskTransitions: input.taskTransitions,
    now,
    limit: input.limit,
  });

  const composedEvents = (rows as ComposedRow[]).map((row): TimelineEvent => {
    const body = renderBody(row);
    return {
      id: row.id,
      when: row.when,
      dot: row.dot as TimelineDot,
      ...(row.expanded === true ? { expanded: true } : {}),
      body,
    };
  });

  const summaryEvents = projectSpanSummaryEvents(input.spanSummaries ?? [], now) as TimelineEvent[];
  return [...summaryEvents, ...composedEvents];
}
