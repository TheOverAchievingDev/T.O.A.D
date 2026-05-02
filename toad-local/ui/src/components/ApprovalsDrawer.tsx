import { useEffect, useState } from 'react';
import type { Team } from '@/types';
import { roleStyle } from '@/data/roles';
import { Icon } from './Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';

export type ApprovalRisk = 'low' | 'med' | 'high';
export type ApprovalDecision = 'approved' | 'denied';

export interface ApprovalItem {
  id: string;
  agentId: string;
  tool: string;
  input: string;
  requestedAgo: string;
  taskId: string;
  risk: ApprovalRisk;
  reason: string;
  /** When set, decisions go through `task_human_approve` instead of `approval_respond`. */
  scope?: 'tool' | 'task-gate';
}

interface DecidedApproval extends ApprovalItem {
  decision: ApprovalDecision;
  decisionReason?: string;
}

const SEED_APPROVALS: ApprovalItem[] = [
  { id: 'ap_1', agentId: 'tom', tool: 'bash', input: 'rm -rf node_modules && pnpm install',
    requestedAgo: 'just now', taskId: 'T-481', risk: 'high',
    reason: 'Destructive: removes node_modules. May take 2+ minutes to reinstall.', scope: 'tool' },
  { id: 'ap_2', agentId: 'rex', tool: 'fetch', input: 'https://deepgram.com/docs/streaming',
    requestedAgo: '1m ago', taskId: 'T-481', risk: 'low',
    reason: 'Network read. Domain not in allowlist.', scope: 'tool' },
  { id: 'ap_3', agentId: 'tom', tool: 'edit', input: 'src/billing/proration.ts',
    requestedAgo: '2m ago', taskId: 'T-481', risk: 'med',
    reason: 'Outside expected files (scope drift on T-481 plan).', scope: 'tool' },
  { id: 'ap_4', agentId: 'alice', tool: 'bash', input: 'git push origin feature/transcribe-v2 --force-with-lease',
    requestedAgo: '5m ago', taskId: 'T-481', risk: 'med',
    reason: 'Force push to feature branch (with-lease).', scope: 'tool' },
];

const RISK_META: Record<ApprovalRisk, { color: string; label: string }> = {
  low: { color: 'var(--fg-muted)', label: 'low' },
  med: { color: 'var(--warn)', label: 'medium' },
  high: { color: 'var(--err)', label: 'high' },
};

interface RowProps {
  approval: ApprovalItem;
  team: Team;
  onDecide: (id: string, decision: ApprovalDecision, reason: string) => void | Promise<void>;
  busy: boolean;
}

function ApprovalRow({ approval, team, onDecide, busy }: RowProps) {
  const [reason, setReason] = useState('');
  const [showReason, setShowReason] = useState(false);
  const member = team.members.find((m) => m.id === approval.agentId);
  const meta = RISK_META[approval.risk];

  return (
    <div className={`approval-card approval-risk-${approval.risk}`}>
      <div className="approval-head">
        {member && (
          <span
            className="agent-avatar"
            style={{ ...roleStyle(member.role), width: 24, height: 24, fontSize: 11 }}
          >
            {member.avatar}
          </span>
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="approval-title">
            <span style={{ color: 'var(--accent)' }}>{member?.name ?? approval.agentId}</span>
            <span className="dim"> wants to run </span>
            <span className="mono" style={{ color: 'var(--fg)' }}>{approval.tool}</span>
            {approval.scope === 'task-gate' && (
              <span
                className="chip"
                style={{
                  marginLeft: 6,
                  fontSize: 10,
                  background: 'oklch(0.65 0.20 25 / 0.14)',
                  color: 'oklch(0.78 0.20 25)',
                  borderColor: 'oklch(0.65 0.20 25 / 0.30)',
                }}
              >
                §14 task-gate
              </span>
            )}
          </div>
          <div className="approval-meta mono">
            <span>{approval.taskId}</span>
            <span>·</span>
            <span style={{ color: meta.color }}>{meta.label} risk</span>
            <span>·</span>
            <span>{approval.requestedAgo}</span>
          </div>
        </div>
      </div>

      <div className="approval-input mono">{approval.input}</div>

      {approval.reason && (
        <div className="approval-reason">
          <Icon name="info" size={11} style={{ color: meta.color, flexShrink: 0, marginTop: 2 }} />
          <span>{approval.reason}</span>
        </div>
      )}

      {showReason && (
        <input
          className="approval-reason-input mono"
          placeholder="Why? (optional, sent to agent)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy}
        />
      )}

      <div className="approval-actions">
        <button
          className="btn btn-sm btn-primary"
          type="button"
          onClick={() => onDecide(approval.id, 'approved', reason)}
          disabled={busy}
        >
          <Icon name="check" size={11} /> Approve
        </button>
        <button
          className="btn btn-sm"
          type="button"
          onClick={() => onDecide(approval.id, 'denied', reason)}
          disabled={busy}
        >
          Deny
        </button>
        <button
          className="btn btn-sm btn-ghost"
          type="button"
          onClick={() => setShowReason(!showReason)}
          disabled={busy}
        >
          {showReason ? 'Hide reason' : 'Add reason'}
        </button>
        <span style={{ marginLeft: 'auto' }}>
          <button className="btn btn-sm btn-ghost" type="button">
            <Icon name="eye" size={11} /> Diff preview
          </button>
        </span>
      </div>
    </div>
  );
}

interface ApprovalsDrawerProps {
  team: Team;
  onClose: () => void;
  approvals?: ApprovalItem[];
  actor?: Actor;
}

const DEFAULT_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };
type Tab = 'pending' | 'history';

export function ApprovalsDrawer({ team, onClose, approvals, actor = DEFAULT_ACTOR }: ApprovalsDrawerProps) {
  const [tab, setTab] = useState<Tab>('pending');
  const [items, setItems] = useState<ApprovalItem[]>(approvals ?? SEED_APPROVALS);
  const [history, setHistory] = useState<DecidedApproval[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (approvals) setItems(approvals);
  }, [approvals]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function decide(id: string, decision: ApprovalDecision, reason: string) {
    const target = items.find((x) => x.id === id);
    if (!target) return;
    setBusyId(id);
    setError(null);
    try {
      if (target.scope === 'task-gate') {
        // §14 path: human approves the task-level gate
        if (decision === 'approved') {
          await callTool({
            actor,
            method: 'task_human_approve',
            args: { taskId: target.taskId, reason: reason || undefined },
            idempotencyKey: `human-approve-${target.taskId}-${Date.now()}`,
          });
        }
        // For task-gate denial we just remove from queue locally — there's no
        // explicit deny RPC; the agent stays blocked until someone approves.
      } else {
        await callTool({
          actor,
          method: 'approval_respond',
          args: { approvalId: id, decision, reason: reason || undefined },
          idempotencyKey: `approval-${id}-${Date.now()}`,
        });
      }
      setItems((prev) => prev.filter((x) => x.id !== id));
      setHistory((prev) => [{ ...target, decision, decisionReason: reason }, ...prev]);
    } catch (err) {
      const message = err instanceof ToadApiError ? err.message
        : err instanceof Error ? err.message
        : 'Failed to record decision';
      setError(message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer notif-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="info" size={15} />
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Approvals</h2>
            <span
              className="chip"
              style={{
                fontSize: 10.5,
                background: 'oklch(0.78 0.14 80 / 0.14)',
                color: 'oklch(0.85 0.14 80)',
                borderColor: 'oklch(0.78 0.14 80 / 0.30)',
              }}
            >
              {items.length} pending
            </span>
          </div>
          <button className="icon-btn" onClick={onClose} type="button">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border-soft)' }}>
          <div className="seg">
            <button
              className={tab === 'pending' ? 'active' : ''}
              onClick={() => setTab('pending')}
              type="button"
            >
              Pending <span style={{ color: 'var(--fg-dim)', marginLeft: 4 }}>{items.length}</span>
            </button>
            <button
              className={tab === 'history' ? 'active' : ''}
              onClick={() => setTab('history')}
              type="button"
            >
              History <span style={{ color: 'var(--fg-dim)', marginLeft: 4 }}>{history.length}</span>
            </button>
          </div>
        </div>

        {error && (
          <div
            style={{
              padding: '6px 14px',
              background: 'oklch(0.30 0.06 25)',
              color: 'oklch(0.92 0.06 25)',
              fontSize: 12,
            }}
          >
            {error}
          </div>
        )}

        <div className="notif-body-scroll" style={{ padding: '12px' }}>
          {tab === 'pending' && (
            items.length === 0 ? (
              <div className="approval-empty">
                <Icon name="check" size={28} />
                <div className="approval-empty-h">All clear.</div>
                <div className="approval-empty-p">No pending approvals. Agents are running with their existing tool permissions.</div>
              </div>
            ) : (
              <div className="approval-stack">
                {items.map((a) => (
                  <ApprovalRow
                    key={a.id}
                    approval={a}
                    team={team}
                    onDecide={decide}
                    busy={busyId === a.id}
                  />
                ))}
              </div>
            )
          )}

          {tab === 'history' && (
            history.length === 0 ? (
              <div className="approval-empty">
                <div className="approval-empty-h">No decisions yet.</div>
                <div className="approval-empty-p">Approval history shows up here once you've responded.</div>
              </div>
            ) : (
              <div className="approval-stack">
                {history.map((a) => {
                  const member = team.members.find((m) => m.id === a.agentId);
                  return (
                    <div key={a.id} className="approval-card" style={{ opacity: 0.78 }}>
                      <div className="approval-head">
                        {member && (
                          <span
                            className="agent-avatar"
                            style={{ ...roleStyle(member.role), width: 22, height: 22, fontSize: 10 }}
                          >
                            {member.avatar}
                          </span>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div className="approval-title">
                            <span style={{ color: 'var(--accent)' }}>{member?.name ?? a.agentId}</span>
                            <span className="dim"> {a.tool} </span>
                            <span
                              className="chip"
                              style={{
                                marginLeft: 6,
                                background: a.decision === 'approved'
                                  ? 'oklch(0.72 0.15 145 / 0.14)'
                                  : 'oklch(0.65 0.20 25 / 0.14)',
                                color: a.decision === 'approved' ? 'oklch(0.82 0.15 145)' : 'oklch(0.78 0.20 25)',
                                fontSize: 10,
                              }}
                            >
                              {a.decision}
                            </span>
                          </div>
                          <div className="approval-meta mono">
                            <span>{a.taskId}</span>
                            {a.decisionReason && (
                              <>
                                <span>·</span>
                                <span style={{ color: 'var(--fg-muted)' }}>{a.decisionReason}</span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className="approval-input mono">{a.input}</div>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
