import { useState } from 'react';
import type { Agent, UiTask, ValidationKind, UiValidationRun } from '@/types';
import type { DriftFinding, DriftRunResult } from '@/hooks/useDrift';
import { Icon } from '../Icon';
import { providerBrand, providerLabel, type ProviderId } from '@/data/providerLabels';

/**
 * Providers the operator can swap a live agent to. Order matches the
 * dropdown render. Keep in sync with the backend's
 * agent_swap_provider PROVIDER_COMMANDS map — both are the source of
 * truth for "which providers exist?" and they must agree or the
 * dropdown will offer choices the backend rejects.
 */
const SWAPPABLE_PROVIDERS: ProviderId[] = ['anthropic', 'openai', 'gemini', 'opencode'];

/**
 * Phase 2 Inspector — right column of the FOR-me Cockpit.
 *
 * Three tabs: Task / Agent / Drift. Each renders a rich card matching
 * the mockup the user approved. Operators glance here to answer
 * "what's the active thing about?" without leaving the calm flow.
 *
 * The Task tab is the most opinionated render: id + type + status
 * chips up top, title, description (if present), a progress bar with
 * a soft ETA estimate, assignees with their live status, a compact
 * validations table (lint / typecheck / test / build with verdict
 * dots), and files-in-scope listing the active task's expected diff.
 *
 * Drift tab pulls from the existing DriftRunResult shape — score,
 * status, top findings by severity. "Open drift screen" CTA at the
 * bottom routes to the full Drift screen for deep-dive.
 */

export type InspectorTab = 'task' | 'agent' | 'drift';

export interface InspectorProps {
  activeTab: InspectorTab;
  onChangeTab: (tab: InspectorTab) => void;

  selectedTask: UiTask | null;
  selectedAgent: Agent | null;

  /** Drift data — top-level run result; the Drift tab renders the
   *  team-wide summary, not per-task slices. */
  drift: DriftRunResult | null;

  /** Optional CTA — open the Drift screen for deep dive. */
  onOpenDriftScreen?: () => void;
  /** Optional CTA — open the full Task detail modal. */
  onOpenTaskDetail?: (taskId: string) => void;

  /** Optional provider-swap handler. When provided, the Agent pane
   *  renders a "Swap provider" control next to the Provider row.
   *  Returns a promise so the pane can show "Swapping…" while the
   *  backend stop→update→relaunch cycle runs (typically 1-3 seconds).
   *  When omitted, the control is hidden. */
  onSwapAgentProvider?: (input: { agentId: string; providerId: string }) => Promise<void>;
}

interface TabSpec {
  id: InspectorTab;
  label: string;
}
const TABS: TabSpec[] = [
  { id: 'task', label: 'TASK' },
  { id: 'agent', label: 'AGENT' },
  { id: 'drift', label: 'DRIFT' },
];

export function Inspector({
  activeTab,
  onChangeTab,
  selectedTask,
  selectedAgent,
  drift,
  onOpenDriftScreen,
  onOpenTaskDetail,
  onSwapAgentProvider,
}: InspectorProps) {
  return (
    <div className="insp">
      <div className="insp-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className="insp-tab"
            data-active={t.id === activeTab || undefined}
            onClick={() => onChangeTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="insp-body">
        {activeTab === 'task' && <TaskPane task={selectedTask} onOpenDetail={onOpenTaskDetail} />}
        {activeTab === 'agent' && <AgentPane agent={selectedAgent} onSwapProvider={onSwapAgentProvider} />}
        {activeTab === 'drift' && <DriftPane drift={drift} onOpenDriftScreen={onOpenDriftScreen} />}
      </div>
    </div>
  );
}

// ============================================================
// Task pane
// ============================================================

function TaskPane({ task, onOpenDetail }: { task: UiTask | null; onOpenDetail?: (id: string) => void }) {
  if (!task) {
    return <EmptyPane label="Select a task to inspect." />;
  }
  return (
    <>
      <div className="insp-section">
        <div className="insp-chip-row">
          <span className="chip mono">{task.id}</span>
          {task.type && <span className={`chip ${task.type === 'bug' ? 'amber' : 'blue'}`}>{task.type}</span>}
          <span className={`chip ${statusChipClass(task.status)}`}>{task.status.replace(/_/g, ' ')}</span>
        </div>
        <h3 className="insp-title">{task.title}</h3>
      </div>

      <div className="insp-section">
        <h5>Assignee</h5>
        <div className="kv">
          <span className="k">Assigned</span>
          <span className="v mono">{task.assignee || '—'}</span>
        </div>
        {task.requiresHumanApproval && (
          <div className="kv" style={{ marginTop: 6 }}>
            <span className="k">Approval</span>
            <span className={`v ${task.humanApproved ? '' : 'mono'}`}>
              {task.humanApproved ? 'approved' : 'pending'}
            </span>
          </div>
        )}
      </div>

      {task.validations && task.validations.length > 0 && (
        <div className="insp-section">
          <h5>Validations</h5>
          <ValidationGrid latest={task.latestValidation} runs={task.validations} />
        </div>
      )}

      {task.review?.files && task.review.files.length > 0 && (
        <div className="insp-section">
          <h5>Files in scope</h5>
          <div className="insp-files">
            {task.review.files.slice(0, 6).map((f) => (
              <div key={f} className="insp-file mono">{f}</div>
            ))}
            {task.review.files.length > 6 && (
              <div className="insp-files-more">+{task.review.files.length - 6} more</div>
            )}
          </div>
        </div>
      )}

      {onOpenDetail && (
        <div className="insp-section insp-actions">
          <button type="button" className="insp-btn" onClick={() => onOpenDetail(task.id)}>
            Open full task <Icon name="chevronRight" size={12} />
          </button>
        </div>
      )}
    </>
  );
}

function statusChipClass(status: UiTask['status']): string {
  switch (status) {
    case 'in-progress': return 'clay';
    case 'review':      return 'blue';
    case 'done':        return 'green';
    case 'blocked':     return 'amber';
    case 'rejected':    return 'amber';
    case 'todo':        return '';
    default:            return '';
  }
}

function ValidationGrid({
  latest,
  runs,
}: {
  latest: UiTask['latestValidation'];
  runs: UiValidationRun[];
}) {
  // Build a lookup of "most recent run per kind" — falls back to
  // scanning `runs` if `latest` isn't provided.
  const lookup = new Map<ValidationKind, UiValidationRun>();
  const kinds: ValidationKind[] = ['lint', 'typecheck', 'test', 'build'];
  if (latest) {
    for (const k of kinds) {
      const run = latest[k];
      if (run) lookup.set(k, run);
    }
  } else {
    for (const run of runs) {
      const existing = lookup.get(run.kind);
      if (!existing) lookup.set(run.kind, run);
    }
  }
  return (
    <div className="insp-validations">
      {kinds.map((kind) => {
        const run = lookup.get(kind);
        const verdict = run?.verdict ?? 'not_run';
        return (
          <div key={kind} className={`insp-val ${verdict}`}>
            <span className={`dot ${verdictDotClass(verdict)}`} />
            <span className="k">{kind}</span>
            <span className="v">{verdictLabel(verdict)}</span>
          </div>
        );
      })}
    </div>
  );
}

function verdictDotClass(v: 'passed' | 'failed' | 'not_run'): string {
  if (v === 'passed') return 'green';
  if (v === 'failed') return 'red';
  return 'idle';
}
function verdictLabel(v: 'passed' | 'failed' | 'not_run'): string {
  if (v === 'passed') return 'pass';
  if (v === 'failed') return 'fail';
  return 'not yet run';
}

// ============================================================
// Agent pane
// ============================================================

function AgentPane({
  agent,
  onSwapProvider,
}: {
  agent: Agent | null;
  onSwapProvider?: InspectorProps['onSwapAgentProvider'];
}) {
  const [swapPending, setSwapPending] = useState(false);
  const [swapError, setSwapError] = useState<string | null>(null);

  if (!agent) return <EmptyPane label="Select an agent to inspect." />;
  const pct = agent.tokenLimit > 0 ? Math.min(100, Math.round((agent.tokens / agent.tokenLimit) * 100)) : 0;
  const handleSwap: React.ChangeEventHandler<HTMLSelectElement> = async (e) => {
    const next = e.target.value as ProviderId;
    if (!onSwapProvider) return;
    if (!next || next === agent.provider) return;
    setSwapPending(true);
    setSwapError(null);
    try {
      await onSwapProvider({ agentId: agent.id, providerId: next });
    } catch (err) {
      setSwapError(err instanceof Error ? err.message : String(err));
    } finally {
      setSwapPending(false);
    }
  };

  return (
    <>
      <div className="insp-section">
        <h5>Identity</h5>
        <div className="kv">
          <span className="k">Name</span><span className="v">{agent.name}</span>
          <span className="k">Role</span><span className="v">{agent.role}</span>
          <span className="k">Provider</span>
          {onSwapProvider ? (
            <span className="v" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <select
                className="insp-provider-select"
                value={agent.provider}
                onChange={handleSwap}
                disabled={swapPending}
                title="Swap this agent's provider. The agent will stop, the team config updates, and the agent relaunches with the new CLI. Conversation history is preserved."
                style={{
                  background: 'transparent',
                  color: 'inherit',
                  border: '1px solid var(--border, oklch(0.4 0.02 60))',
                  borderRadius: 4,
                  padding: '1px 4px',
                  font: 'inherit',
                }}
              >
                {SWAPPABLE_PROVIDERS.map((p) => (
                  <option key={p} value={p}>{providerLabel(p)}</option>
                ))}
                {!SWAPPABLE_PROVIDERS.includes(agent.provider as ProviderId) && (
                  <option value={agent.provider}>{providerLabel(agent.provider as ProviderId)}</option>
                )}
              </select>
              {agent.model && (
                <span
                  className="mono"
                  style={{ opacity: 0.65, fontSize: 11 }}
                  title={agent.model}
                >
                  / {agent.model}
                </span>
              )}
              {swapPending && <span style={{ opacity: 0.6, fontSize: 11 }}>swapping…</span>}
            </span>
          ) : (
            <span className="v">
              <span className="mono">{providerBrand(agent.provider as ProviderId)}</span>
              {agent.model && (
                <span className="mono" style={{ opacity: 0.65, fontSize: 11 }} title={agent.model}>
                  {' / '}{agent.model}
                </span>
              )}
            </span>
          )}
          <span className="k">Status</span><span className="v">{agent.status}</span>
        </div>
        {swapError && (
          <div style={{ marginTop: 6, fontSize: 11, color: 'var(--danger, #d97757)' }}>
            Swap failed: {swapError}
          </div>
        )}
      </div>
      <div className="insp-section">
        <h5>Token use</h5>
        <div className={`bar ${pct >= 90 ? 'amber' : ''}`}>
          <div className="fill" style={{ width: `${pct}%` }} />
        </div>
        <div className="kv" style={{ marginTop: 8 }}>
          <span className="k">Used</span>
          <span className="v mono">{agent.tokens.toLocaleString()} / {agent.tokenLimit.toLocaleString()}</span>
          <span className="k">Tasks done</span>
          <span className="v mono">{agent.tasksDone}</span>
        </div>
      </div>
      {agent.task && (
        <div className="insp-section">
          <h5>Current task</h5>
          <div className="v mono">{agent.task}</div>
        </div>
      )}
    </>
  );
}

// ============================================================
// Drift pane
// ============================================================

function DriftPane({
  drift,
  onOpenDriftScreen,
}: {
  drift: DriftRunResult | null;
  onOpenDriftScreen?: () => void;
}) {
  if (!drift) return <EmptyPane label="No drift run yet — trigger one from Run → Run Drift Check." />;
  const top = drift.findings
    .slice()
    .sort((a, b) => severityWeight(b.severity) - severityWeight(a.severity))
    .slice(0, 3);
  return (
    <>
      <div className="insp-section">
        <h5>Score</h5>
        <div className="insp-drift-score">
          <strong>{Math.round(drift.teamScore)}%</strong>
          <span className={`chip ${driftStatusChipClass(drift.status)}`}>{drift.status}</span>
        </div>
      </div>
      <div className="insp-section">
        <h5>Top findings</h5>
        {top.length === 0 ? (
          <div className="insp-empty-small">No active findings.</div>
        ) : (
          top.map((f) => (
            <div key={f.id} className={`insp-finding sev-${f.severity}`}>
              <span className="sev">{f.severity}</span>
              <span className="title">{f.title}</span>
            </div>
          ))
        )}
      </div>
      {onOpenDriftScreen && (
        <div className="insp-section insp-actions">
          <button type="button" className="insp-btn" onClick={onOpenDriftScreen}>
            Open drift screen <Icon name="chevronRight" size={12} />
          </button>
        </div>
      )}
    </>
  );
}

function severityWeight(s: DriftFinding['severity']): number {
  switch (s) {
    case 'critical': return 5;
    case 'high':     return 4;
    case 'medium':   return 3;
    case 'low':      return 2;
    case 'info':     return 1;
    default:         return 0;
  }
}
function driftStatusChipClass(status: DriftRunResult['status']): string {
  if (status === 'healthy')  return 'green';
  if (status === 'watch')    return 'clay';
  if (status === 'warning')  return 'amber';
  if (status === 'critical') return 'amber';
  return '';
}

// ============================================================
// Shared empty state
// ============================================================

function EmptyPane({ label }: { label: string }) {
  return <div className="insp-empty">{label}</div>;
}
