import { useEffect, useMemo, useState } from 'react';
import type { Agent, Runtime, Team, UiTask } from '@/types';
import type { StreamEntry } from '@/utils/agentStream';
import type { DriftRunResult } from '@/hooks/useDrift';
import { Icon } from '../Icon';
import { PaneSplitter } from './PaneSplitter';
import { AgentCard } from './AgentCard';
import { FlowTimeline, type TimelineEvent } from './FlowTimeline';
import { Inspector, type InspectorTab } from './Inspector';
import { projectTimeline } from './timelineProjection';

/**
 * Phase 2 CockpitForMe — the calm three-column observation surface
 * that lands as the default Cockpit for the "AI builds it FOR me"
 * persona. Per spec §8.1.
 *
 * Layout:
 *
 *   ┌───────────┬──────────────────────────────┬─────────────┐
 *   │ Welcome-back banner (reopenContext, dismissible)        │
 *   ├───────────┼──────────────────────────────┼─────────────┤
 *   │           │ [Resume] [+Task] [Drift] ?   │             │
 *   │  AGENT    │                              │             │
 *   │  CARDS    │ WHAT'S HAPPENING             │  INSPECTOR  │
 *   │  (left)   │ Your team is working on ...  │  (task /    │
 *   │           │                              │  agent /    │
 *   │  - lead   │ TIMELINE                     │  drift)     │
 *   │  - dev-1  │ - just now ...               │             │
 *   │  - dev-2  │ - 2 min ...                  │             │
 *   │  - rev-1  │ - 8 min ...                  │             │
 *   │  - QA     │                              │             │
 *   └───────────┴──────────────────────────────┴─────────────┘
 *
 * Two PaneSplitters: outer (left | rest), inner (center | inspector
 * with anchorEnd so the right column is the sized one). Sizes persist
 * via localStorage. Each splitter respects min/max so the layout
 * doesn't collapse on small screens.
 *
 * Selection state (selectedTaskId / selectedAgentId) lives here. The
 * Inspector reflects whichever is active; clicking an agent card
 * focuses the Agent tab, clicking a task in the (future) task list
 * would focus the Task tab. Phase 2 starts with a sensible default:
 * the first in-progress task and the lead agent.
 *
 * ReopenBanner dismissal persists per-project via localStorage so
 * users don't get re-prompted on every refresh.
 */

export interface CockpitForMeProps {
  team: Team;
  tasks: UiTask[];
  runtimes: Runtime[];
  agentStreams?: Record<string, StreamEntry[]>;
  drift: DriftRunResult | null;
  reopenContext?: {
    teamId: string;
    teamName: string;
    isRunning: boolean;
    lastActiveAt: string | null;
    lastTask?: { taskId: string; subject: string; status: string };
    lastDriftScore?: { teamScore: number; status: string; runId: string; createdAt: string };
    lastCommit?: { sha: string; message: string; authoredAt: string | null };
  } | null;
  onResumeTeam?: () => void;
  onCreateTask?: () => void;
  onRefreshDrift?: () => Promise<void>;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenDriftScreen?: () => void;
}

const ACTIVE_STATUSES = new Set(['in-progress', 'review']);

function pickDefaultTask(tasks: UiTask[]): UiTask | null {
  // Prefer in-progress, then review, then any.
  return (
    tasks.find((t) => t.status === 'in-progress') ??
    tasks.find((t) => t.status === 'review') ??
    tasks[0] ??
    null
  );
}
function pickDefaultAgent(team: Team): Agent | null {
  return team.members.find((m) => m.role === 'lead') ?? team.members[0] ?? null;
}

export function CockpitForMe({
  team,
  tasks,
  runtimes,
  agentStreams = {},
  drift,
  reopenContext = null,
  onResumeTeam,
  onCreateTask,
  onRefreshDrift,
  onOpenTaskDetail,
  onOpenDriftScreen,
}: CockpitForMeProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => pickDefaultTask(tasks)?.id ?? null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => pickDefaultAgent(team)?.id ?? null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('task');
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(false);

  // Promote the in-progress task to the default selection if the
  // previous selection vanished (task completed or list refreshed).
  useEffect(() => {
    if (selectedTaskId && tasks.some((t) => t.id === selectedTaskId)) return;
    const next = pickDefaultTask(tasks);
    setSelectedTaskId(next?.id ?? null);
  }, [tasks, selectedTaskId]);

  // Persist reopen-banner dismissal per project so it doesn't pester
  // the user on every refresh.
  useEffect(() => {
    if (!reopenContext) return;
    const key = `cockpit.reopenBanner.dismissed.${reopenContext.teamId}`;
    try {
      const stored = window.localStorage.getItem(key);
      if (stored === '1') setBannerDismissed(true);
    } catch {
      /* ignore */
    }
  }, [reopenContext]);

  const dismissBanner = () => {
    setBannerDismissed(true);
    if (!reopenContext) return;
    try {
      window.localStorage.setItem(`cockpit.reopenBanner.dismissed.${reopenContext.teamId}`, '1');
    } catch {
      /* ignore */
    }
  };

  const selectedTask = useMemo(
    () => (selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) ?? null : null),
    [selectedTaskId, tasks],
  );
  const selectedAgent = useMemo(
    () => (selectedAgentId ? team.members.find((m) => m.id === selectedAgentId) ?? null : null),
    [selectedAgentId, team.members],
  );

  // Map each agent → its runtime (first match by agent id).
  const runtimeByAgent = useMemo(() => {
    const m = new Map<string, Runtime>();
    for (const r of runtimes) if (r.agent) m.set(r.agent, r);
    return m;
  }, [runtimes]);

  // Project timeline events from the agent streams.
  const timelineEvents: TimelineEvent[] = useMemo(
    () =>
      projectTimeline({
        agentStreams,
        agents: team.members,
        driftHistory: drift?.history,
        activeTask: selectedTask,
        limit: 7,
      }),
    [agentStreams, team.members, drift?.history, selectedTask],
  );

  // Hero text: "Your team is working on t_42 — bulk subscription quantity"
  const heroNode = selectedTask
    ? {
        title: (
          <>
            Your team is working on <span style={{ color: 'var(--clay)' }}>{selectedTask.id} — {selectedTask.title}</span>.
          </>
        ),
        subline: (
          <>
            {activeAgentCount(team, runtimes)} of {team.members.length} agents active
            {' · '}
            {tasks.filter((t) => t.status === 'review').length} task awaiting review
            {drift?.status ? ` · drift ${drift.status}` : ''}
          </>
        ),
      }
    : undefined;

  const activeAgents = team.members.filter((a) => ACTIVE_STATUSES.has(a.status as string)).length;

  return (
    <div className="cockpit-for">
      {/* Outer splitter: left agent column | rest */}
      <PaneSplitter
        orientation="horizontal"
        defaultSize={240}
        minSize={200}
        maxSize={360}
        storageKey="cockpit.forMe.leftCol"
      >
        {/* LEFT: agent column */}
        <div className="cockpit-for-left">
          <div className="cockpit-col-head">
            <h4>TEAM</h4>
            <span className="cockpit-col-sub">{activeAgents}/{team.members.length} active</span>
          </div>
          <div className="cockpit-col-body">
            {team.members.map((a) => {
              const agentTask = a.task
                ? tasks.find((t) => t.id === a.task) ?? null
                : null;
              return (
                <AgentCard
                  key={a.id}
                  agent={a}
                  runtime={runtimeByAgent.get(a.id) ?? null}
                  currentTask={agentTask}
                  active={selectedAgentId === a.id}
                  onSelect={(id) => {
                    setSelectedAgentId(id);
                    setInspectorTab('agent');
                  }}
                />
              );
            })}
          </div>
        </div>

        {/* RIGHT of outer splitter: inner splitter (center | inspector) */}
        <PaneSplitter
          orientation="horizontal"
          defaultSize={320}
          minSize={260}
          maxSize={480}
          storageKey="cockpit.forMe.rightCol"
          anchorEnd
        >
          {/* CENTER: action strip + hero + timeline */}
          <div className="cockpit-for-center">
            {reopenContext && !bannerDismissed && (
              <ReopenBanner
                context={reopenContext}
                onResume={onResumeTeam}
                onDismiss={dismissBanner}
              />
            )}
            <div className="cockpit-action-strip">
              {onResumeTeam && (
                <button type="button" className="btn primary" onClick={onResumeTeam}>
                  <Icon name="play" size={11} /> Resume team
                </button>
              )}
              {onCreateTask && (
                <button type="button" className="btn" onClick={onCreateTask}>
                  <Icon name="plus" size={12} /> Add task
                </button>
              )}
              {onRefreshDrift && (
                <button type="button" className="btn" onClick={() => { void onRefreshDrift(); }}>
                  <Icon name="eye" size={12} /> Run drift
                </button>
              )}
              <div style={{ flex: 1 }} />
              <button type="button" className="btn ghost" title="What can I do here? (Phase 4)">
                <Icon name="info" size={12} /> ?
              </button>
            </div>
            <FlowTimeline events={timelineEvents} hero={heroNode} />
          </div>

          {/* RIGHT: Inspector */}
          <Inspector
            activeTab={inspectorTab}
            onChangeTab={setInspectorTab}
            selectedTask={selectedTask}
            selectedAgent={selectedAgent}
            drift={drift}
            onOpenTaskDetail={onOpenTaskDetail}
            onOpenDriftScreen={onOpenDriftScreen}
          />
        </PaneSplitter>
      </PaneSplitter>
    </div>
  );
}

function activeAgentCount(team: Team, _runtimes: Runtime[]): number {
  // Today's data uses agent.status; runtime correlation is a Phase 3
  // refinement (Agent.status and Runtime.status can diverge briefly).
  return team.members.filter((m) => m.status === 'live' || m.status === 'thinking').length;
}

function ReopenBanner({
  context,
  onResume,
  onDismiss,
}: {
  context: NonNullable<CockpitForMeProps['reopenContext']>;
  onResume?: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="cockpit-reopen-banner">
      <div className="cockpit-reopen-text">
        <strong>Welcome back to {context.teamName}.</strong>{' '}
        {context.isRunning
          ? 'Your team is already running.'
          : 'Resume the team to pick up where you left off.'}
        {context.lastTask && (
          <> Last task: <code className="mono">{context.lastTask.taskId}</code> — {context.lastTask.subject}.</>
        )}
      </div>
      <div className="cockpit-reopen-actions">
        {onResume && !context.isRunning && (
          <button type="button" className="btn primary" onClick={onResume}>
            <Icon name="play" size={11} /> Resume team
          </button>
        )}
        <button type="button" className="btn ghost" onClick={onDismiss} title="Dismiss">
          <Icon name="x" size={12} />
        </button>
      </div>
    </div>
  );
}
