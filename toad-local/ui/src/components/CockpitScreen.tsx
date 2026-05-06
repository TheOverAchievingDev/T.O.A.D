import { useMemo, useState } from 'react';
import type { Actor } from '@/api/client';
import { callTool } from '@/api/client';
import type { Message, Runtime, Team, UiTask } from '@/types';
import type { ProjectEntry } from '@/hooks/useProjects';
import type { DriftRunResult } from '@/hooks/useDrift';
import { roleStyle } from '@/data/roles';
import { Icon } from './Icon';
import { CodeScreen } from './CodeScreen';
import { TaskRiskBadge } from './TaskRiskBadge';
import { DriftBadge } from './DriftBadge';

interface CockpitScreenProps {
  team: Team;
  tasks: UiTask[];
  runtimes: Runtime[];
  messages: Message[];
  teamId: string | null;
  actor: Actor;
  projects: ProjectEntry[];
  activeProject: ProjectEntry | null;
  onSelectProject: (projectId: string) => void;
  onSelectFolder: () => void;
  onOpenTask: (taskId: string) => void;
  onCreateTask: () => void;
  onOpenLogs: (runtimeId: string) => void;
  driftData: DriftRunResult | null;
  driftLoading: boolean;
  driftError: string | null;
  onRefreshDrift: () => Promise<void>;
  onRefreshData: () => void;
}

type LeftTab = 'tasks' | 'agents';
type RightTab = 'output' | 'review' | 'drift';

export function CockpitScreen({
  team,
  tasks,
  runtimes,
  messages,
  teamId,
  actor,
  projects,
  activeProject,
  onSelectProject,
  onSelectFolder,
  onOpenTask,
  onCreateTask,
  onOpenLogs,
  driftData,
  driftLoading,
  driftError,
  onRefreshDrift,
  onRefreshData,
}: CockpitScreenProps) {
  const [leftTab, setLeftTab] = useState<LeftTab>('tasks');
  const [rightTab, setRightTab] = useState<RightTab>('output');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(tasks[0]?.id ?? null);
  const [testRunning, setTestRunning] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);

  const selectedTask = useMemo(() => {
    if (selectedTaskId) return tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null;
    return tasks[0] ?? null;
  }, [selectedTaskId, tasks]);

  const liveRuntimes = runtimes.filter((runtime) => runtime.status === 'live' || runtime.status === 'launching');
  const reviewTasks = tasks.filter((task) => task.status === 'review');
  const activeTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'rejected');
  const selectedDriftFindings = driftData?.findings.filter((finding) =>
    selectedTask ? finding.taskId === selectedTask.id : true,
  ) ?? [];
  const recentMessages = messages.slice(-8).reverse();

  async function runSelectedTaskTests() {
    if (!selectedTask || testRunning) return;
    setTestRunning(true);
    setTestMessage(null);
    try {
      const result = await callTool<{ verdict?: string; exitCode?: number }>({
        actor,
        method: 'validation_run',
        idempotencyKey: `cockpit-validation-${selectedTask.id}-${Date.now()}`,
        args: { taskId: selectedTask.id, kind: 'test' },
      });
      setTestMessage(`Validation ${result.verdict ?? 'recorded'}${typeof result.exitCode === 'number' ? `, exit ${result.exitCode}` : ''}`);
      onRefreshData();
    } catch (err) {
      setTestMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setTestRunning(false);
    }
  }

  return (
    <main className="cockpit-screen">
      <aside className="cockpit-left" aria-label="Cockpit task and agent status">
        <div className="cockpit-pane-head">
          <div>
            <div className="eyebrow">Cockpit</div>
            <h2>{team.name || activeProject?.name || 'No team'}</h2>
          </div>
          <button className="btn btn-sm btn-primary" type="button" onClick={onCreateTask}>
            <Icon name="plus" size={12} />
            Task
          </button>
        </div>
        <div className="cockpit-seg">
          <button type="button" className={leftTab === 'tasks' ? 'active' : ''} onClick={() => setLeftTab('tasks')}>
            <Icon name="kanban" size={12} />
            Tasks
          </button>
          <button type="button" className={leftTab === 'agents' ? 'active' : ''} onClick={() => setLeftTab('agents')}>
            <Icon name="users" size={12} />
            Agents
          </button>
        </div>

        {leftTab === 'tasks' ? (
          <div className="cockpit-task-list">
            {activeTasks.length === 0 ? (
              <div className="cockpit-empty">
                <Icon name="kanban" size={18} />
                <strong>No active tasks</strong>
                <span>Create a task to give the team work inside the cockpit.</span>
              </div>
            ) : (
              activeTasks.map((task) => {
                const member = team.members.find((m) => m.id === task.assignee);
                return (
                  <button
                    key={task.id}
                    type="button"
                    className={`cockpit-task ${selectedTask?.id === task.id ? 'active' : ''}`}
                    style={roleStyle(member?.role ?? 'developer')}
                    onClick={() => setSelectedTaskId(task.id)}
                    onDoubleClick={() => onOpenTask(task.id)}
                    title="Double-click to open full task detail"
                  >
                    <span className="cockpit-task-top">
                      <span className="task-id">{task.id}</span>
                      <span className={`cockpit-status ${task.status}`}>{task.status}</span>
                    </span>
                    <span className="cockpit-task-title">{task.title}</span>
                    <span className="cockpit-task-meta">
                      {member ? member.name : task.assignee || 'unassigned'}
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
              })
            )}
          </div>
        ) : (
          <div className="cockpit-agent-list">
            {team.members.length === 0 ? (
              <div className="cockpit-empty">
                <Icon name="users" size={18} />
                <strong>No team yet</strong>
                <span>Create or launch a team to see agent status here.</span>
              </div>
            ) : (
              team.members.map((member) => {
                const runtime = runtimes.find((r) => r.agent === member.id || r.agent === member.name);
                return (
                  <button
                    key={member.id}
                    type="button"
                    className="cockpit-agent"
                    style={roleStyle(member.role)}
                    onClick={() => runtime && onOpenLogs(runtime.id)}
                    disabled={!runtime}
                  >
                    <span className={`status-dot ${member.status}`} />
                    <span className="agent-avatar">{member.avatar}</span>
                    <span className="cockpit-agent-main">
                      <strong>{member.name}</strong>
                      <span>{member.activity?.label ?? member.task ?? 'Idle'}</span>
                    </span>
                    {runtime && <span className="mono cockpit-agent-pid">pid {runtime.pid}</span>}
                  </button>
                );
              })
            )}
          </div>
        )}
      </aside>

      <section className="cockpit-center" aria-label="Code editor and diff viewer">
        <CodeScreen
          teamId={teamId}
          tasks={tasks}
          projects={projects}
          activeProject={activeProject}
          onSelectProject={onSelectProject}
          onSelectFolder={onSelectFolder}
          actor={actor}
          driftData={driftData}
          runtimes={runtimes}
        />
      </section>

      <aside className="cockpit-right" aria-label="Agent output, review notes, and drift">
        <div className="cockpit-seg">
          <button type="button" className={rightTab === 'output' ? 'active' : ''} onClick={() => setRightTab('output')}>
            Output
          </button>
          <button type="button" className={rightTab === 'review' ? 'active' : ''} onClick={() => setRightTab('review')}>
            Review
            {reviewTasks.length > 0 && <span className="count-pill">{reviewTasks.length}</span>}
          </button>
          <button type="button" className={rightTab === 'drift' ? 'active' : ''} onClick={() => setRightTab('drift')}>
            Drift
          </button>
        </div>

        {rightTab === 'output' && (
          <div className="cockpit-right-body">
            <div className="cockpit-metric-grid">
              <Metric label="Live" value={`${liveRuntimes.length}/${runtimes.length}`} />
              <Metric label="Open" value={String(activeTasks.length)} />
              <Metric label="Review" value={String(reviewTasks.length)} />
              <Metric label="Drift" value={driftData ? `${driftData.teamScore}%` : '-'} />
            </div>
            <h3>Recent output</h3>
            {recentMessages.length === 0 ? (
              <div className="cockpit-empty small">No agent messages yet.</div>
            ) : recentMessages.map((message) => (
              <div key={message.id} className="cockpit-message">
                <span className="mono">{message.from} {'->'} {message.to}</span>
                <p>{message.body}</p>
              </div>
            ))}
          </div>
        )}

        {rightTab === 'review' && (
          <div className="cockpit-right-body">
            <h3>{selectedTask ? selectedTask.id : 'No task selected'}</h3>
            {selectedTask ? (
              <>
                <p className="dim">{selectedTask.title}</p>
                <div className="cockpit-review-row">
                  <span>Status</span>
                  <strong>{selectedTask.status}</strong>
                </div>
                <div className="cockpit-review-row">
                  <span>Assignee</span>
                  <strong>{selectedTask.assignee || 'unassigned'}</strong>
                </div>
                <button className="btn btn-sm" type="button" onClick={() => onOpenTask(selectedTask.id)}>
                  Open full task
                </button>
              </>
            ) : (
              <div className="cockpit-empty small">Select a task to inspect review context.</div>
            )}
          </div>
        )}

        {rightTab === 'drift' && (
          <div className="cockpit-right-body">
            <div className="cockpit-panel-title">
              <h3>Drift report</h3>
              <button className="btn btn-sm" type="button" onClick={() => void onRefreshDrift()} disabled={driftLoading}>
                <Icon name="refresh" size={12} />
                {driftLoading ? 'Running' : 'Run'}
              </button>
            </div>
            {driftError && <div className="code-error">{driftError}</div>}
            {!driftData && !driftError && <div className="cockpit-empty small">No drift run yet.</div>}
            {driftData && (
              <>
                <div className="cockpit-drift-score">
                  <strong>{driftData.teamScore}%</strong>
                  <span>{driftData.status}</span>
                </div>
                {(selectedDriftFindings.length === 0) ? (
                  <div className="cockpit-empty small">No drift findings for the selected task.</div>
                ) : selectedDriftFindings.slice(0, 6).map((finding) => (
                  <div key={finding.id} className={`cockpit-finding ${finding.severity}`}>
                    <span>{finding.severity}</span>
                    <strong>{finding.title}</strong>
                    <p>{finding.recommendedCorrection}</p>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </aside>

      <section className="cockpit-bottom" aria-label="Integrated terminal and test runner">
        <div className="cockpit-bottom-title">
          <Icon name="terminal" size={14} />
          <strong>Terminal / Test Runner</strong>
          <span className="dim">
            {selectedTask ? `${selectedTask.id} selected` : 'No task selected'}
          </span>
        </div>
        <div className="cockpit-bottom-actions">
          <button className="btn btn-sm" type="button" onClick={() => void runSelectedTaskTests()} disabled={!selectedTask || testRunning}>
            <Icon name="play" size={12} />
            {testRunning ? 'Running tests' : 'Run validation'}
          </button>
          {testMessage && <span className="mono cockpit-test-message">{testMessage}</span>}
        </div>
      </section>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="cockpit-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
