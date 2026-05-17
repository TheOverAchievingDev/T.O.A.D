import { useMemo } from 'react';
import type { Message, Runtime, Team, UiTask, TaskRiskLevel, MatchedRiskRule } from '@/types';
import { roleStyle } from '@/data/roles';
import { Icon } from './Icon';
import { TaskRiskBadge } from './TaskRiskBadge';
import { DriftBadge } from './DriftBadge';
import type { DriftRunResult } from '@/hooks/useDrift';
import type { StreamEntry } from '@/utils/agentStream';
import { buildFlowCanvas } from './flowCanvasModel';

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

// DriftBadge treats >= 66 as red/elevated; keep the flow warning in lockstep.
const isDriftElevated = (score: number) => score >= 66;

function runtimeStatusClass(status: string): string {
  if (status === 'live') return 'live active';
  if (status === 'launching' || status === 'thinking') return 'thinking active';
  if (status === 'error') return 'err active';
  return 'idle';
}

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
  const model = useMemo(
    () => buildFlowCanvas({ team, tasks, runtimes, drift: driftData, isDriftElevated }),
    [team, tasks, runtimes, driftData],
  );

  const runtimeByAgent = useMemo(
    () => new Map(runtimes.map((r) => [r.agent, r])),
    [runtimes],
  );

  const latestByAgent = useMemo(() => {
    const map = new Map<string, string>();
    const memberIds = new Set(team.members.map((m) => m.id));
    for (const id of memberIds) {
      const entries = agentStreams[id];
      if (entries) {
        for (let i = entries.length - 1; i >= 0; i -= 1) {
          const body = entries[i].body.trim();
          if (body) { map.set(id, body); break; }
        }
      }
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (map.size === memberIds.size) break;
      const m = messages[i];
      const peer = memberIds.has(m.from) ? m.from : memberIds.has(m.to) ? m.to : null;
      if (peer && !map.has(peer)) map.set(peer, m.body);
    }
    return map;
  }, [team.members, messages, agentStreams]);

  const activityFor = (id: string, modelActivity: string, fallback: string) =>
    latestByAgent.get(id) || modelActivity || fallback;

  const activeTaskCount = model.ticker.open;
  if (team.members.length === 0 && activeTaskCount === 0) {
    return (
      <div className="flowx-canvas empty" aria-label="Team flow canvas">
        <div className="flowx-empty">
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

  const { ticker, lead, agents, doneBucket, warnings } = model;

  return (
    <div className="flowx-canvas" aria-label="Team flow canvas">
      <div className="flowx-ticker" aria-label="Team flow stats">
        <span className="flowx-tick live"><i className="status-dot live active" />{ticker.live} live</span>
        <span className="flowx-tick">{ticker.open} open</span>
        <span className="flowx-tick">{ticker.inReview} in review</span>
        <span className={`flowx-tick ${ticker.blocked > 0 ? 'warn' : ''}`}>{ticker.blocked} blocked</span>
        <span className="flowx-tick">{ticker.done} done</span>
        <span className="flowx-drift">
          DRIFT
          <span className="flowx-drift-bar" aria-hidden="true">
            <span style={{ width: `${ticker.driftPct == null ? 0 : Math.max(0, Math.min(100, ticker.driftPct))}%` }} />
          </span>
          {ticker.driftPct == null ? '-' : `${ticker.driftPct}%`}
        </span>
      </div>

      <div className="flowx-pipeline">
        <div className="flowx-col flowx-col-lead">
          {lead && (
            <button
              type="button"
              className={`flowx-lead ${selectedAgentId === lead.member.id ? 'active' : ''}`}
              style={roleStyle('lead')}
              onClick={() => onSelectAgent(lead.member.id)}
              onDoubleClick={() => {
                const rt = runtimeByAgent.get(lead.member.id);
                if (rt) onOpenLogs(rt.id);
              }}
            >
              <span className="flowx-card-top">
                <span className={`status-dot ${runtimeStatusClass(lead.runtimeStatus)}`} />
                <span className="agent-avatar">{lead.member.avatar}</span>
                <span className="flowx-card-id">
                  <em>Lead Agent</em>
                  <strong>{lead.member.name}</strong>
                </span>
              </span>
              <span className="flowx-card-activity">
                {activityFor(lead.member.id, lead.activity, `Coordinating ${lead.coordinating} agents`)}
              </span>
              <span className="flowx-card-foot">
                <span><strong>{lead.coordinating}</strong> agents</span>
              </span>
            </button>
          )}
          {warnings.map((w) => (
            <button
              key={w.id}
              type="button"
              className={`flowx-warn ${w.kind}`}
              onClick={() => { if (w.taskId) onSelectTask(w.taskId); }}
            >
              <span className="flowx-warn-head">
                <Icon name="info" size={13} />
                <span>
                  <strong>{w.title}</strong>
                  <em>{w.sub}</em>
                </span>
              </span>
              <span className="flowx-warn-desc">{w.desc}</span>
              <span className="flowx-warn-cta">
                {w.kind === 'approval' ? 'Review now' : 'Investigate'}
                <Icon name="chevronRight" size={11} />
              </span>
            </button>
          ))}
        </div>

        {agents.map((a) => (
          <div className="flowx-col" key={a.member.id}>
            <button
              type="button"
              className={`flowx-agent ${selectedAgentId === a.member.id ? 'active' : ''}`}
              style={roleStyle(a.member.role as Parameters<typeof roleStyle>[0])}
              onClick={() => onSelectAgent(a.member.id)}
              onDoubleClick={() => {
                const rt = runtimeByAgent.get(a.member.id);
                if (rt) onOpenLogs(rt.id);
              }}
            >
              <span className="flowx-card-top">
                <span className={`status-dot ${runtimeStatusClass(a.runtimeStatus)}`} />
                <span className="agent-avatar">{a.member.avatar}</span>
                <span className="flowx-card-id">
                  <em>{a.member.role}</em>
                  <strong>{a.member.name}</strong>
                </span>
              </span>
              <span className="flowx-card-activity">
                {activityFor(a.member.id, a.activity, a.statusLabel)}
              </span>
              <span className="flowx-card-foot">
                <span><strong>{a.taskCount}</strong> tasks</span>
                <span className={`flowx-status ${runtimeStatusClass(a.runtimeStatus)}`}>{a.statusLabel}</span>
              </span>
            </button>
            <div className="flowx-spine" aria-hidden="true" />
            <div className="flowx-tasks">
              {a.tasks.length === 0 ? (
                <div className="flowx-task-empty">No tasks</div>
              ) : a.tasks.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`flowx-task ${selectedTaskId === t.id ? 'active' : ''}`}
                  onClick={() => onSelectTask(t.id)}
                  onDoubleClick={() => onOpenTask(t.id)}
                >
                  <span className="flowx-task-top">
                    <span className="task-id">{t.id}</span>
                    <span className={`cockpit-status ${t.status}`}>{t.status}</span>
                  </span>
                  <strong>{t.title}</strong>
                  <span className="flowx-task-meta">
                    {t.type === 'bug' && <span className="task-bug-badge">Bug</span>}
                    {t.riskLevel && (
                      <TaskRiskBadge
                        level={t.riskLevel as TaskRiskLevel}
                        requiresHumanApproval={t.requiresHumanApproval}
                        humanApproved={t.humanApproved}
                        matchedRules={t.matchedRules as MatchedRiskRule[] | undefined}
                      />
                    )}
                    <DriftBadge score={driftData?.perTaskScores?.[t.id]} />
                  </span>
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="flowx-col flowx-col-done">
          <div className="flowx-done">
            <span className="flowx-done-head">
              <Icon name="check" size={12} />
              <span>Ready</span>
              <strong>{doneBucket.count}</strong>
            </span>
            <div className="flowx-done-list">
              {doneBucket.recent.length === 0 ? (
                <div className="flowx-task-empty">Nothing shipped yet</div>
              ) : doneBucket.recent.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className="flowx-done-line"
                  onClick={() => onSelectTask(t.id)}
                  onDoubleClick={() => onOpenTask(t.id)}
                >
                  <span className="task-id">{t.id}</span>
                  <span className="flowx-done-title">{t.title}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
