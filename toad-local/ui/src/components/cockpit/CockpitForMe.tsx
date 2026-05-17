import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent, Message, Runtime, Team, UiTask } from '@/types';
import type { StreamEntry } from '@/utils/agentStream';
import type { DriftRunResult } from '@/hooks/useDrift';
import { Icon } from '../Icon';
import { CockpitFlowCanvas } from '../CockpitFlowCanvas';
import { PaneSplitter } from './PaneSplitter';
import { AgentCard } from './AgentCard';
import { FlowTimeline, type TimelineEvent } from './FlowTimeline';
import { Inspector, type InspectorTab } from './Inspector';
import { projectTimeline, type TaskTransition } from './timelineProjection';
import {
  DEFAULT_FOR_ME_VIEW_MODE,
  FOR_ME_VIEW_MODE_STORAGE_KEY,
  type ForMeViewMode,
  normalizeForMeViewMode,
} from './forMeViewMode';
import {
  FLOW_LEFT_PANEL_STORAGE_KEY,
  FLOW_RIGHT_PANEL_STORAGE_KEY,
  type FlowPanelState,
  normalizeFlowPanelState,
} from './forMeFlowPanels';

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
  messages?: Message[];
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
  /** Optional pause handler. When provided AND team.status === 'running'
   *  (or any runtime is live), the Resume button morphs into Pause so
   *  the operator can stop the team mid-flight without leaving the
   *  cockpit. Same handler the menubar's Pause Team uses (App.tsx
   *  handlePauseTeam → team_stop). */
  onPauseTeam?: () => void | Promise<void>;
  /** Optional provider-swap handler — wires the Inspector's "Provider"
   *  dropdown to agent_swap_provider. App.tsx passes this when the
   *  active team is known; the dropdown is hidden when omitted. */
  onSwapAgentProvider?: (input: { agentId: string; providerId: string }) => Promise<void>;
  onCreateTask?: () => void;
  onRefreshDrift?: () => Promise<void>;
  /** When true, the Run Drift button renders as "Running drift…" with
   *  a spinner and is disabled. Without this, clicking the button on a
   *  slow drift run (LLM judge takes ~30s) produces no visible change
   *  for half a minute and the operator clicks again and again — the
   *  2026-05-15 "nothing happens when I press Run Drift" report was
   *  this gap, not a backend bug. */
  driftRefreshing?: boolean;
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
  messages = [],
  agentStreams = {},
  drift,
  reopenContext = null,
  onResumeTeam,
  onPauseTeam,
  onSwapAgentProvider,
  onCreateTask,
  onRefreshDrift,
  driftRefreshing = false,
  onOpenTaskDetail,
  onOpenDriftScreen,
}: CockpitForMeProps) {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(() => pickDefaultTask(tasks)?.id ?? null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(() => pickDefaultAgent(team)?.id ?? null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>('task');
  const [bannerDismissed, setBannerDismissed] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<ForMeViewMode>(() => {
    try {
      return normalizeForMeViewMode(window.localStorage.getItem(FOR_ME_VIEW_MODE_STORAGE_KEY));
    } catch {
      return DEFAULT_FOR_ME_VIEW_MODE;
    }
  });
  const [flowLeftPanel, setFlowLeftPanel] = useState<FlowPanelState>(() => {
    try {
      return normalizeFlowPanelState(window.localStorage.getItem(FLOW_LEFT_PANEL_STORAGE_KEY));
    } catch {
      return 'collapsed';
    }
  });
  const [flowRightPanel, setFlowRightPanel] = useState<FlowPanelState>(() => {
    try {
      return normalizeFlowPanelState(window.localStorage.getItem(FLOW_RIGHT_PANEL_STORAGE_KEY));
    } catch {
      return 'collapsed';
    }
  });

  // Phase 3a Task 5 — observe task lifecycle transitions via snapshot
  // delta. Each render compares prev tasks vs current; new rows or
  // status changes become TaskTransition entries fed to the timeline
  // projection. Cap at 10 to keep memory bounded.
  const prevTasksRef = useRef<UiTask[]>(tasks);
  const [taskTransitions, setTaskTransitions] = useState<TaskTransition[]>([]);
  useEffect(() => {
    const prev = prevTasksRef.current;
    const prevMap = new Map(prev.map((t) => [t.id, t]));
    const next: TaskTransition[] = [];
    const at = Date.now();
    for (const curr of tasks) {
      const before = prevMap.get(curr.id);
      if (!before) {
        // New task created — emit a creation transition.
        next.push({
          taskId: curr.id,
          title: curr.title,
          fromStatus: null,
          toStatus: curr.status,
          agentId: curr.assignee || null,
          at,
        });
      } else if (before.status !== curr.status) {
        next.push({
          taskId: curr.id,
          title: curr.title,
          fromStatus: before.status,
          toStatus: curr.status,
          agentId: curr.assignee || null,
          at,
        });
      }
    }
    if (next.length > 0) {
      setTaskTransitions((existing) => [...next, ...existing].slice(0, 10));
    }
    prevTasksRef.current = tasks;
  }, [tasks]);

  // Auto-promote the selected task as work moves on. The Cockpit FOR me
  // view has no task list — selectedTaskId is only ever set by this
  // effect, not by user clicks — so we always follow the live focal
  // task. Triggers:
  //
  //   - Selection is null → pick a default.
  //   - Selected task disappeared from the list → pick a new default.
  //   - Selected task is no longer in-progress → jump to whichever IS
  //     in-progress, so the "Your team is working on T-002 — …" hero
  //     reflects the team's current focus.
  //
  // Before this fix the title pinned to whichever task was in-progress
  // at mount and never updated when the team moved on (Bug B from the
  // 2026-05-14 triage screenshot — title stuck on T-001 long after the
  // team had moved past it).
  useEffect(() => {
    if (selectedTaskId) {
      const current = tasks.find((t) => t.id === selectedTaskId);
      if (!current) {
        const next = pickDefaultTask(tasks);
        setSelectedTaskId(next?.id ?? null);
        return;
      }
      if (current.status !== 'in-progress') {
        const inProgress = tasks.find((t) => t.status === 'in-progress' && t.id !== selectedTaskId);
        if (inProgress) {
          setSelectedTaskId(inProgress.id);
        }
      }
      return;
    }
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

  const changeViewMode = (mode: ForMeViewMode) => {
    setViewMode(mode);
    try {
      window.localStorage.setItem(FOR_ME_VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  };

  const changeFlowPanel = (side: 'left' | 'right', state: FlowPanelState) => {
    if (side === 'left') {
      setFlowLeftPanel(state);
    } else {
      setFlowRightPanel(state);
    }
    try {
      window.localStorage.setItem(
        side === 'left' ? FLOW_LEFT_PANEL_STORAGE_KEY : FLOW_RIGHT_PANEL_STORAGE_KEY,
        state,
      );
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

  // "Is the team alive right now?" — drives the Resume↔Pause button
  // toggle. We check the runtime status set rather than team.status
  // because team.status lags slightly (it's derived from the live
  // runtimes list after the next refresh tick), and the operator
  // wants the button to update the instant a Pause click hits.
  // Includes 'launching' so the operator can still hit Pause to abort
  // a slow startup.
  const teamIsLive = useMemo(
    () => runtimes.some((r) => r.status === 'live' || r.status === 'launching'),
    [runtimes],
  );

  // Project timeline events from agent streams + drift history + the
  // task-transition snapshot deltas observed by this component.
  const timelineEvents: TimelineEvent[] = useMemo(
    () =>
      projectTimeline({
        agentStreams,
        agents: team.members,
        driftHistory: drift?.history,
        taskTransitions,
        activeTask: selectedTask,
        limit: 8,
      }),
    [agentStreams, team.members, drift?.history, taskTransitions, selectedTask],
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

  if (viewMode === 'flow') {
    return (
      <div className="cockpit-for">
        {reopenContext && !bannerDismissed && (
          <ReopenBanner
            context={reopenContext}
            isRunning={teamIsLive}
            onResume={onResumeTeam}
            onPause={onPauseTeam}
            onDismiss={dismissBanner}
          />
        )}
        <div className="cockpit-for-flow-shell">
          <aside className={`cockpit-flow-side cockpit-flow-side-left ${flowLeftPanel}`}>
            {flowLeftPanel === 'expanded' ? (
              <div className="cockpit-flow-panel">
                <div className="cockpit-flow-panel-head">
                  <div>
                    <h4>TEAM</h4>
                    <span>{activeAgents}/{team.members.length} active</span>
                  </div>
                  <button
                    type="button"
                    className="cockpit-flow-collapse"
                    onClick={() => changeFlowPanel('left', 'collapsed')}
                    title="Collapse team panel"
                  >
                    <Icon name="chevronLeft" size={14} />
                  </button>
                </div>
                <div className="cockpit-flow-panel-body">
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
                          changeFlowPanel('right', 'expanded');
                        }}
                      />
                    );
                  })}
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="cockpit-flow-rail-button"
                onClick={() => changeFlowPanel('left', 'expanded')}
                title="Open team panel"
              >
                <Icon name="users" size={15} />
                <span>Team</span>
                <strong>{activeAgents}/{team.members.length}</strong>
              </button>
            )}
          </aside>

          <main className="cockpit-flow-main">
            <div className="cockpit-action-strip">
              {teamIsLive && onPauseTeam && (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => { void onPauseTeam(); }}
                  title="Stop every live agent in this team"
                >
                  <Icon name="pause" size={11} /> Pause team
                </button>
              )}
              {!teamIsLive && onResumeTeam && (
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
                <button
                  type="button"
                  className="btn"
                  onClick={() => { void onRefreshDrift(); }}
                  disabled={driftRefreshing}
                  title={driftRefreshing
                    ? 'Drift judge is running (this can take up to 30s)'
                    : 'Re-run all drift checks now'}
                  style={driftRefreshing ? { opacity: 0.65, cursor: 'wait' } : undefined}
                >
                  <Icon
                    name={driftRefreshing ? 'refresh' : 'eye'}
                    size={12}
                    className={driftRefreshing ? 'spin' : undefined}
                  />
                  {driftRefreshing ? ' Running drift...' : ' Run drift'}
                </button>
              )}
              <div style={{ flex: 1 }} />
              <div className="cockpit-view-toggle" role="group" aria-label="FOR me view">
                <button
                  type="button"
                  aria-pressed={false}
                  onClick={() => changeViewMode('timeline')}
                  title="Show the plain-English activity timeline"
                >
                  <Icon name="list" size={12} /> Timeline
                </button>
                <button
                  type="button"
                  className="active"
                  aria-pressed
                  onClick={() => changeViewMode('flow')}
                  title="Show the team flow canvas"
                >
                  <Icon name="workflow" size={12} /> Flow
                </button>
              </div>
              <button type="button" className="btn ghost" title="What can I do here? (Phase 4)">
                <Icon name="info" size={12} /> ?
              </button>
            </div>
            <CockpitFlowCanvas
              team={team}
              tasks={tasks}
              runtimes={runtimes}
              messages={messages}
              agentStreams={agentStreams}
              selectedTaskId={selectedTaskId}
              selectedAgentId={selectedAgentId}
              driftData={drift}
              onSelectTask={(taskId) => {
                setSelectedTaskId(taskId);
                setInspectorTab('task');
              }}
              onSelectAgent={(agentId) => {
                setSelectedAgentId(agentId);
                setInspectorTab('agent');
              }}
              onOpenTask={(taskId) => {
                setSelectedTaskId(taskId);
                setInspectorTab('task');
                onOpenTaskDetail?.(taskId);
                changeFlowPanel('right', 'expanded');
              }}
              onOpenLogs={(runtimeId) => {
                const runtime = runtimes.find((r) => r.id === runtimeId);
                if (runtime?.agent) {
                  setSelectedAgentId(runtime.agent);
                  setInspectorTab('agent');
                  changeFlowPanel('right', 'expanded');
                }
              }}
              onCreateTask={onCreateTask ?? (() => {})}
            />
          </main>

          <aside className={`cockpit-flow-side cockpit-flow-side-right ${flowRightPanel}`}>
            {flowRightPanel === 'expanded' ? (
              <div className="cockpit-flow-panel">
                <div className="cockpit-flow-panel-head">
                  <div>
                    <h4>INSPECTOR</h4>
                    <span>{inspectorTab}</span>
                  </div>
                  <button
                    type="button"
                    className="cockpit-flow-collapse"
                    onClick={() => changeFlowPanel('right', 'collapsed')}
                    title="Collapse inspector panel"
                  >
                    <Icon name="chevronRight" size={14} />
                  </button>
                </div>
                <div className="cockpit-flow-panel-body inspector-body">
                  <Inspector
                    activeTab={inspectorTab}
                    onChangeTab={setInspectorTab}
                    selectedTask={selectedTask}
                    selectedAgent={selectedAgent}
                    drift={drift}
                    onOpenTaskDetail={onOpenTaskDetail}
                    onOpenDriftScreen={onOpenDriftScreen}
                    onSwapAgentProvider={onSwapAgentProvider}
                  />
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="cockpit-flow-rail-button"
                onClick={() => changeFlowPanel('right', 'expanded')}
                title="Open inspector panel"
              >
                <Icon name="info" size={15} />
                <span>Inspector</span>
                <strong>{selectedTask?.id ?? selectedAgent?.name ?? 'Open'}</strong>
              </button>
            )}
          </aside>
        </div>
      </div>
    );
  }

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
                isRunning={teamIsLive}
                onResume={onResumeTeam}
                onPause={onPauseTeam}
                onDismiss={dismissBanner}
              />
            )}
            <div className="cockpit-action-strip">
              {/*
                Resume/Pause toggle: when the team is running we show
                Pause (stops every live agent via team_stop). Otherwise
                we show Resume (relaunches the team). The handler is
                wired in App.tsx — handlePauseTeam fires the same
                team_stop the menubar's "Pause Team" uses, so behavior
                is identical from either entry point.
              */}
              {teamIsLive && onPauseTeam && (
                <button
                  type="button"
                  className="btn primary"
                  onClick={() => { void onPauseTeam(); }}
                  title="Stop every live agent in this team"
                >
                  <Icon name="pause" size={11} /> Pause team
                </button>
              )}
              {!teamIsLive && onResumeTeam && (
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
                <button
                  type="button"
                  className="btn"
                  onClick={() => { void onRefreshDrift(); }}
                  disabled={driftRefreshing}
                  title={driftRefreshing
                    ? 'Drift judge is running (this can take up to 30s)'
                    : 'Re-run all drift checks now'}
                  style={driftRefreshing ? { opacity: 0.65, cursor: 'wait' } : undefined}
                >
                  <Icon
                    name={driftRefreshing ? 'refresh' : 'eye'}
                    size={12}
                    className={driftRefreshing ? 'spin' : undefined}
                  />
                  {driftRefreshing ? ' Running drift…' : ' Run drift'}
                </button>
              )}
              <div style={{ flex: 1 }} />
              <div className="cockpit-view-toggle" role="group" aria-label="FOR me view">
                <button
                  type="button"
                  className="active"
                  aria-pressed
                  onClick={() => changeViewMode('timeline')}
                  title="Show the plain-English activity timeline"
                >
                  <Icon name="list" size={12} /> Timeline
                </button>
                <button
                  type="button"
                  aria-pressed={false}
                  onClick={() => changeViewMode('flow')}
                  title="Show the team flow canvas"
                >
                  <Icon name="workflow" size={12} /> Flow
                </button>
              </div>
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
            onSwapAgentProvider={onSwapAgentProvider}
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
  isRunning,
  onResume,
  onPause,
  onDismiss,
}: {
  context: NonNullable<CockpitForMeProps['reopenContext']>;
  /** Live "is the team alive right now?" signal from the runtimes list.
   *  Overrides context.isRunning (which is captured at banner-render
   *  time and lags behind reality after the operator clicks Resume). */
  isRunning: boolean;
  onResume?: () => void;
  onPause?: () => void | Promise<void>;
  onDismiss: () => void;
}) {
  return (
    <div className="cockpit-reopen-banner">
      <div className="cockpit-reopen-text">
        <strong>Welcome back to {context.teamName}.</strong>{' '}
        {isRunning
          ? 'Your team is running now.'
          : 'Resume the team to pick up where you left off.'}
        {context.lastTask && (
          <> Last task: <code className="mono">{context.lastTask.taskId}</code> — {context.lastTask.subject}.</>
        )}
      </div>
      <div className="cockpit-reopen-actions">
        {isRunning && onPause && (
          <button
            type="button"
            className="btn primary"
            onClick={() => { void onPause(); }}
            title="Stop every live agent in this team"
          >
            <Icon name="pause" size={11} /> Pause team
          </button>
        )}
        {!isRunning && onResume && (
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
