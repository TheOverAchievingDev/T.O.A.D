import { useMemo } from 'react';
import type { Message, Runtime, Team, UiTask } from '@/types';
import { roleStyle } from '@/data/roles';
import { Icon } from './Icon';
import { TaskRiskBadge } from './TaskRiskBadge';
import { DriftBadge } from './DriftBadge';
import type { DriftRunResult } from '@/hooks/useDrift';
import type { StreamEntry } from '@/utils/agentStream';

interface CockpitFlowCanvasProps {
  team: Team;
  tasks: UiTask[];
  runtimes: Runtime[];
  messages: Message[];
  agentStreams: Record<string, StreamEntry[]>;
  selectedTaskId: string | null;
  selectedAgentId: string | null;
  driftData: DriftRunResult | null;
  onSelectTask: (taskId: string) => void;
  onSelectAgent: (agentId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenLogs: (runtimeId: string) => void;
  onCreateTask: () => void;
}

type FlowLaneKey = 'ready' | 'in-progress' | 'review' | 'blocked';

const FLOW_LANES: Array<{ key: FlowLaneKey; label: string; statuses: UiTask['status'][] }> = [
  { key: 'ready', label: 'Ready', statuses: ['todo'] },
  { key: 'in-progress', label: 'In Progress', statuses: ['in-progress'] },
  { key: 'review', label: 'Review', statuses: ['review'] },
  { key: 'blocked', label: 'Blocked', statuses: ['blocked'] },
];

export function CockpitFlowCanvas({
  team,
  tasks,
  runtimes,
  messages,
  agentStreams,
  selectedTaskId,
  selectedAgentId,
  driftData,
  onSelectTask,
  onSelectAgent,
  onOpenTask,
  onOpenLogs,
  onCreateTask,
}: CockpitFlowCanvasProps) {
  const activeTasks = useMemo(
    () => tasks.filter((task) => task.status !== 'done' && task.status !== 'rejected'),
    [tasks],
  );
  const selectedTask = selectedTaskId ? tasks.find((task) => task.id === selectedTaskId) ?? null : null;
  const doneCount = tasks.filter((task) => task.status === 'done').length;
  const runtimeByAgent = useMemo(() => new Map(runtimes.map((runtime) => [runtime.agent, runtime])), [runtimes]);
  const assignedTasks = useMemo(() => {
    const next = new Map<string, UiTask[]>();
    for (const task of activeTasks) {
      if (!task.assignee) continue;
      const list = next.get(task.assignee) ?? [];
      list.push(task);
      next.set(task.assignee, list);
    }
    return next;
  }, [activeTasks]);
  // Pre-compute the latest visible activity blurb per member so the JSX
  // doesn't filter+at(-1) the messages and streams arrays once per node.
  // O(messages * members) before, O(messages + members) after.
  const latestByAgent = useMemo(() => {
    const map = new Map<string, string>();
    const memberIds = new Set(team.members.map((member) => member.id));
    for (const id of memberIds) {
      const streamEntries = agentStreams[id];
      if (streamEntries) {
        for (let i = streamEntries.length - 1; i >= 0; i -= 1) {
          const body = streamEntries[i].body.trim();
          if (body) {
            map.set(id, body);
            break;
          }
        }
      }
    }
    // Walk messages newest-first so the first match per agent IS the latest.
    // Stop early once every member is covered.
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (map.size === memberIds.size) break;
      const message = messages[i];
      const peer = memberIds.has(message.from) ? message.from
                 : memberIds.has(message.to)   ? message.to
                 : null;
      if (peer && !map.has(peer)) {
        map.set(peer, message.body);
      }
    }
    return map;
  }, [team.members, messages, agentStreams]);
  const lead = team.members.find((member) => member.role === 'lead') ?? team.members[0] ?? null;
  const liveCount = runtimes.filter((runtime) => runtime.status === 'live' || runtime.status === 'launching').length;
  const reviewCount = activeTasks.filter((task) => task.status === 'review').length;
  const blockedCount = activeTasks.filter((task) => task.status === 'blocked').length;
  const focusedAgentId = selectedAgentId || selectedTask?.assignee || lead?.id || null;
  const focusedAgent = focusedAgentId ? team.members.find((member) => member.id === focusedAgentId) ?? null : null;
  const focusedRuntime = focusedAgent ? runtimeByAgent.get(focusedAgent.id) : undefined;
  const focusedAgentTasks = focusedAgent ? assignedTasks.get(focusedAgent.id) ?? [] : [];

  function selectTask(task: UiTask) {
    onSelectTask(task.id);
  }

  if (team.members.length === 0 && activeTasks.length === 0) {
    return (
      <div className="flow-canvas empty">
        <div className="flow-empty">
          <Icon name="workflow" size={28} />
          <h2>No active team graph</h2>
          <p>Create or launch a team to see agents, tasks, ownership, and review flow here.</p>
          <button className="btn btn-primary" type="button" onClick={onCreateTask}>
            <Icon name="plus" size={13} />
            Create task
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flow-canvas" aria-label="Team flow canvas">
      <div className="flow-hero">
        <div>
          <div className="eyebrow">AI-first delivery map</div>
          <h2>{team.name || 'Symphony team'}</h2>
          <p>{team.description || 'Agents coordinate around task ownership, review, drift, and validation.'}</p>
        </div>
        <div className="flow-stats" aria-label="Team flow stats">
          <FlowStat label="Live" value={`${liveCount}/${runtimes.length}`} />
          <FlowStat label="Open" value={String(activeTasks.length)} />
          <FlowStat label="Review" value={String(reviewCount)} />
          <FlowStat label="Done" value={String(doneCount)} />
          <FlowStat label="Blocked" value={String(blockedCount)} tone={blockedCount > 0 ? 'warn' : undefined} />
          <FlowStat label="Drift" value={driftData ? `${driftData.teamScore}%` : '-'} />
        </div>
      </div>

      {lead && (
        <section className="flow-lead-band" style={roleStyle(lead.role)}>
          <div className="flow-node lead-node">
            <span className={`status-dot ${runtimeStatusClass(runtimeByAgent.get(lead.id)?.status ?? lead.status)}`} />
            <span className="agent-avatar">{lead.avatar}</span>
            <div>
              <strong>{lead.name}</strong>
              <span>{lead.activity?.label ?? latestByAgent.get(lead.id) ?? 'Delegating and monitoring the plan'}</span>
            </div>
          </div>
          <div className="flow-lead-line" />
        </section>
      )}

      <section className="flow-focus-panel" aria-label="Selected flow context">
        <div className="flow-focus-card primary" style={roleStyle(focusedAgent?.role ?? 'developer')}>
          <div className="flow-focus-kicker">Focused agent</div>
          {focusedAgent ? (
            <>
              <div className="flow-focus-agent">
                <span className={`status-dot ${runtimeStatusClass(focusedRuntime?.status ?? focusedAgent.status)}`} />
                <span className="agent-avatar">{focusedAgent.avatar}</span>
                <div>
                  <strong>{focusedAgent.name}</strong>
                  <span>{focusedAgent.role} / {runtimeLabel(focusedRuntime)}</span>
                </div>
              </div>
              <p>{focusedAgent.activity?.label ?? latestByAgent.get(focusedAgent.id) ?? 'No recent runtime activity.'}</p>
              <div className="flow-focus-chips">
                <span>{focusedAgentTasks.length} active</span>
                <span>{focusedAgent.tasksDone} done</span>
                <span>{formatTokenUse(focusedAgent.tokens, focusedAgent.tokenLimit)}</span>
              </div>
            </>
          ) : (
            <p>No agent selected.</p>
          )}
        </div>

        <div className="flow-focus-card">
          <div className="flow-focus-kicker">Selected task</div>
          {selectedTask ? (
            <>
              <div className="flow-focus-task-title">
                <strong>{selectedTask.id}</strong>
                <span className={`cockpit-status ${selectedTask.status}`}>{selectedTask.status}</span>
              </div>
              <p>{selectedTask.title}</p>
              <div className="flow-focus-chips">
                <span>{selectedTask.assignee || 'unassigned'}</span>
                <span>{selectedTask.validations?.length ?? 0} validations</span>
                <span>{selectedTask.review ? 'review captured' : 'no review yet'}</span>
                <DriftBadge score={driftData?.perTaskScores?.[selectedTask.id]} />
              </div>
              <button className="btn btn-sm" type="button" onClick={() => onOpenTask(selectedTask.id)}>
                Open task
              </button>
            </>
          ) : (
            <p>Select a task node to inspect ownership, validation, review, and drift context.</p>
          )}
        </div>
      </section>

      <section className="flow-relations" aria-label="Agent task relationships">
        <div className="flow-section-head">
          <Icon name="git" size={14} />
          <span>Assignment graph</span>
        </div>
        <div className="flow-relation-list">
          {team.members.map((member) => {
            const owned = assignedTasks.get(member.id) ?? [];
            return (
              <div
                key={member.id}
                className={`flow-relation-row ${focusedAgentId === member.id ? 'active' : ''}`}
                style={roleStyle(member.role)}
              >
                <button type="button" className="flow-relation-agent" onClick={() => onSelectAgent(member.id)}>
                  <span className="agent-avatar">{member.avatar}</span>
                  <strong>{member.name}</strong>
                </button>
                <div className="flow-relation-line" />
                <div className="flow-relation-tasks">
                  {owned.length === 0 ? (
                    <span className="flow-relation-empty">no active assignments</span>
                  ) : owned.slice(0, 6).map((task) => (
                    <button
                      key={task.id}
                      type="button"
                      className={`flow-relation-task ${selectedTaskId === task.id ? 'active' : ''}`}
                      onClick={() => selectTask(task)}
                    >
                      <span className="task-id">{task.id}</span>
                      <em>{task.status}</em>
                    </button>
                  ))}
                  {owned.length > 6 && <span className="flow-relation-more">+{owned.length - 6}</span>}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <div className="flow-board">
        <section className="flow-agent-column" aria-label="Agents">
          <div className="flow-section-head">
            <Icon name="users" size={14} />
            <span>Agents</span>
          </div>
          <div className="flow-agent-list">
            {team.members.map((member) => {
              const runtime = runtimeByAgent.get(member.id);
              const owned = assignedTasks.get(member.id) ?? [];
              return (
                <button
                  key={member.id}
                  type="button"
                  className="flow-agent-node"
                  style={roleStyle(member.role)}
                  onClick={() => onSelectAgent(member.id)}
                  onDoubleClick={() => runtime && onOpenLogs(runtime.id)}
                >
                  <span className={`status-dot ${runtimeStatusClass(runtime?.status ?? member.status)}`} />
                  <span className="agent-avatar">{member.avatar}</span>
                  <span className="flow-agent-main">
                    <span className="flow-agent-title">
                      <strong>{member.name}</strong>
                      <em>{member.role}</em>
                    </span>
                    <span>{member.activity?.label ?? latestByAgent.get(member.id) ?? runtimeLabel(runtime)}</span>
                    <span className="flow-agent-work">
                      {owned.length === 0 ? 'No assigned active tasks' : `${owned.length} active task${owned.length === 1 ? '' : 's'}`}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="flow-task-board" aria-label="Task flow">
          <div className="flow-section-head">
            <Icon name="workflow" size={14} />
            <span>Task flow</span>
          </div>
          <div className="flow-lanes">
            {FLOW_LANES.map((lane) => {
              const laneTasks = activeTasks.filter((task) => lane.statuses.includes(task.status));
              return (
                <section key={lane.key} className={`flow-lane ${lane.key}`}>
                  <div className="flow-lane-head">
                    <span>{lane.label}</span>
                    <strong>{laneTasks.length}</strong>
                  </div>
                  {laneTasks.length === 0 ? (
                    <div className="flow-lane-empty">No tasks</div>
                  ) : laneTasks.map((task) => {
                    const member = team.members.find((candidate) => candidate.id === task.assignee);
                    return (
                      <button
                        key={task.id}
                        type="button"
                        className={`flow-task-node ${selectedTaskId === task.id ? 'active' : ''}`}
                        style={roleStyle(member?.role ?? 'developer')}
                        onClick={() => selectTask(task)}
                        onDoubleClick={() => onOpenTask(task.id)}
                      >
                        <span className="flow-task-top">
                          <span className="task-id">{task.id}</span>
                          <span className={`cockpit-status ${task.status}`}>{task.status}</span>
                        </span>
                        <strong>{task.title}</strong>
                        <span className="flow-task-meta">
                          <span>{member ? member.name : task.assignee || 'unassigned'}</span>
                          {task.riskLevel && (
                            <TaskRiskBadge
                              level={task.riskLevel}
                              requiresHumanApproval={task.requiresHumanApproval}
                              humanApproved={task.humanApproved}
                              matchedRules={task.matchedRules}
                            />
                          )}
                          <DriftBadge score={driftData?.perTaskScores?.[task.id]} />
                        </span>
                      </button>
                    );
                  })}
                </section>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

function FlowStat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className={`flow-stat ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function runtimeStatusClass(status: Runtime['status'] | Team['members'][number]['status']): string {
  if (status === 'live') return 'live active';
  if (status === 'launching' || status === 'thinking') return 'thinking active';
  if (status === 'error') return 'err active';
  return 'idle';
}

function runtimeLabel(runtime: Runtime | undefined): string {
  if (!runtime) return 'Idle';
  if (runtime.status === 'live') return `${runtime.provider} ${runtime.model}`;
  if (runtime.status === 'launching') return 'Launching runtime';
  return runtime.status;
}

function formatTokenUse(tokens: number, tokenLimit: number): string {
  if (!tokenLimit) return `${tokens.toLocaleString()} tokens`;
  const percent = Math.round((tokens / tokenLimit) * 100);
  return `${percent}% tokens`;
}

