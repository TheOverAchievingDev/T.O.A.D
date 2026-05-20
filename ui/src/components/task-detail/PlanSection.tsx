import { useState } from 'react';
import type { Team } from '@/types';
import { roleStyle } from '@/data/roles';
import { Icon } from '../Icon';
import type { PlanData, PlanState } from './seed';

const STATE_META: Record<PlanState, { color: string; bg: string; bd: string; label: string }> = {
  proposed: { color: 'oklch(0.70 0.13 245)', bg: 'oklch(0.70 0.13 245 / 0.14)', bd: 'oklch(0.70 0.13 245 / 0.30)', label: 'Awaiting approval' },
  approved: { color: 'oklch(0.72 0.15 145)', bg: 'oklch(0.72 0.15 145 / 0.14)', bd: 'oklch(0.72 0.15 145 / 0.30)', label: 'Approved' },
  rejected: { color: 'oklch(0.65 0.20 25)', bg: 'oklch(0.65 0.20 25 / 0.14)', bd: 'oklch(0.65 0.20 25 / 0.30)', label: 'Changes requested' },
};

interface PlanSectionProps {
  team: Team;
  plan: PlanData;
}

export function PlanSection({ team, plan }: PlanSectionProps) {
  const [open, setOpen] = useState(true);
  const proposer = team.members.find((m) => m.id === plan.proposer);
  const decider = team.members.find((m) => m.id === plan.decider);
  const stateMeta = STATE_META[plan.state];

  return (
    <div className="td-section sect">
      <button className="sect-head" onClick={() => setOpen(!open)} type="button">
        <Icon name="workflow" size={12} className="sect-chev" style={{ transform: open ? 'none' : 'rotate(-90deg)' }} />
        <h3>Plan</h3>
        <span className="chip" style={{ background: stateMeta.bg, color: stateMeta.color, borderColor: stateMeta.bd }}>
          {plan.state === 'approved' && <Icon name="check" size={10} />}
          {plan.state === 'proposed' && <span className="status-dot live" style={{ background: stateMeta.color }} />}
          {stateMeta.label}
        </span>
        <span className="dim mono" style={{ marginLeft: 'auto', fontSize: 11 }}>
          {plan.filesExpected.length} files · {plan.risks.length} risks
        </span>
      </button>

      {open && (
        <div className="sect-body">
          <div className="plan-people">
            {proposer && (
              <div className="plan-person" style={roleStyle(proposer.role)}>
                <span className="dim" style={{ fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Proposed by</span>
                <span className="agent-avatar" style={{ width: 18, height: 18, fontSize: 9 }}>{proposer.avatar}</span>
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{proposer.name}</span>
                <span className="dim mono">{plan.proposedAt}</span>
              </div>
            )}
            {decider && plan.state === 'approved' && (
              <div className="plan-person" style={roleStyle(decider.role)}>
                <span className="dim" style={{ fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Approved by</span>
                <span className="agent-avatar" style={{ width: 18, height: 18, fontSize: 9 }}>{decider.avatar}</span>
                <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{decider.name}</span>
                <span className="dim mono">{plan.decidedAt}</span>
              </div>
            )}
          </div>

          <div className="plan-summary">{plan.summary}</div>

          <div className="plan-block">
            <div className="plan-block-h">Approach</div>
            <ol className="plan-list">
              {plan.approach.map((a, i) => <li key={i}>{a}</li>)}
            </ol>
          </div>

          <div className="plan-grid">
            <div className="plan-block">
              <div className="plan-block-h">Files expected to change <span className="dim mono">{plan.filesExpected.length}</span></div>
              <div className="plan-files">
                {plan.filesExpected.map((f) => (
                  <div key={f} className="plan-file mono">
                    <Icon name="file" size={11} style={{ color: 'var(--fg-muted)' }} />
                    {f}
                  </div>
                ))}
              </div>
            </div>

            <div className="plan-block">
              <div className="plan-block-h">Validation steps <span className="dim mono">{plan.validation.length}</span></div>
              <div className="plan-files">
                {plan.validation.map((v, i) => (
                  <div key={i} className="plan-file mono">
                    <span className="plan-val-kind">{v.kind}</span>
                    <span style={{ color: 'var(--fg-muted)' }}>{v.cmd}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="plan-block">
            <div className="plan-block-h">Risks</div>
            <div className="plan-risks">
              {plan.risks.map((r, i) => {
                const sevColor = r.sev === 'high' ? 'var(--err)' : r.sev === 'med' ? 'var(--warn)' : 'var(--fg-muted)';
                return (
                  <div key={i} className="plan-risk">
                    <span
                      className="plan-risk-sev"
                      style={{
                        background: `color-mix(in oklch, ${sevColor} 18%, transparent)`,
                        color: sevColor,
                        borderColor: `color-mix(in oklch, ${sevColor} 35%, transparent)`,
                      }}
                    >
                      {r.sev}
                    </span>
                    <span style={{ flex: 1 }}>{r.text}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="plan-actions">
            {plan.state === 'proposed' ? (
              <>
                <button className="btn btn-sm btn-primary" type="button"><Icon name="check" size={11} /> Approve plan</button>
                <button className="btn btn-sm" type="button">Request changes</button>
                <button className="btn btn-sm btn-ghost" type="button">Re-propose</button>
              </>
            ) : (
              <>
                <button className="btn btn-sm btn-ghost" type="button"><Icon name="edit" size={11} /> Re-propose</button>
                <span className="dim" style={{ fontSize: 11, marginLeft: 'auto' }}>Plan history (2) →</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
