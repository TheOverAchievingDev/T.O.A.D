import { useState, type CSSProperties } from 'react';
import type { TaskRiskLevel, MatchedRiskRule } from '@/types';
import { Icon } from './Icon';

interface TaskRiskBadgeProps {
  level: TaskRiskLevel;
  requiresHumanApproval?: boolean;
  humanApproved?: boolean;
  matchedRules?: MatchedRiskRule[];
  /** Compact = icon-only with tooltip; full = pill with label. */
  variant?: 'compact' | 'full';
  style?: CSSProperties;
}

const LEVEL_META: Record<TaskRiskLevel, { color: string; bg: string; bd: string; label: string }> = {
  low: {
    color: 'oklch(0.78 0.05 245)',
    bg: 'oklch(0.30 0.04 245 / 0.4)',
    bd: 'oklch(0.55 0.08 245 / 0.30)',
    label: 'low',
  },
  medium: {
    color: 'oklch(0.85 0.14 80)',
    bg: 'oklch(0.78 0.14 80 / 0.14)',
    bd: 'oklch(0.78 0.14 80 / 0.30)',
    label: 'medium',
  },
  high: {
    color: 'oklch(0.78 0.20 25)',
    bg: 'oklch(0.65 0.20 25 / 0.14)',
    bd: 'oklch(0.65 0.20 25 / 0.30)',
    label: 'high',
  },
  critical: {
    color: 'oklch(0.85 0.20 25)',
    bg: 'oklch(0.55 0.20 25 / 0.22)',
    bd: 'oklch(0.65 0.20 25 / 0.50)',
    label: 'critical',
  },
};

export function TaskRiskBadge({
  level, requiresHumanApproval, humanApproved, matchedRules,
  variant = 'compact', style,
}: TaskRiskBadgeProps) {
  const [open, setOpen] = useState(false);
  const meta = LEVEL_META[level];
  const ruleCount = matchedRules?.length ?? 0;
  const gateOpen = requiresHumanApproval && !humanApproved;
  const gateApproved = requiresHumanApproval && humanApproved;

  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', ...style }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={(e) => {
        e.stopPropagation();
        setOpen((o) => !o);
      }}
    >
      <span
        className="chip"
        title={`Risk: ${meta.label}${requiresHumanApproval ? ' · human approval required' : ''}`}
        style={{
          background: meta.bg,
          color: meta.color,
          borderColor: meta.bd,
          fontSize: 10,
          padding: variant === 'compact' ? '1px 5px' : '2px 6px',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 3,
          cursor: 'help',
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          fontWeight: 600,
        }}
      >
        {gateOpen && <Icon name="info" size={9} />}
        {gateApproved && <Icon name="check" size={9} />}
        <span>{variant === 'compact' ? meta.label.slice(0, 4) : meta.label}</span>
        {ruleCount > 0 && variant === 'full' && (
          <span style={{ opacity: 0.6, marginLeft: 2 }}>· {ruleCount}</span>
        )}
      </span>

      {open && (matchedRules?.length ?? 0) + Number(!!requiresHumanApproval) > 0 && (
        <span
          role="tooltip"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: 6,
            zIndex: 200,
            minWidth: 280,
            maxWidth: 380,
            padding: '10px 12px',
            background: 'var(--bg-panel, #1a1916)',
            border: '1px solid var(--border-soft, rgba(255,255,255,0.12))',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
            color: 'var(--fg, #fff)',
            fontSize: 11.5,
            cursor: 'default',
            textTransform: 'none',
            letterSpacing: 0,
            fontWeight: 400,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
            <span
              className="chip"
              style={{
                background: meta.bg, color: meta.color, borderColor: meta.bd,
                fontSize: 10, padding: '1px 6px',
              }}
            >
              {meta.label}
            </span>
            {gateOpen && (
              <span
                className="chip"
                style={{
                  background: 'oklch(0.55 0.20 25 / 0.22)',
                  color: 'oklch(0.85 0.20 25)',
                  borderColor: 'oklch(0.65 0.20 25 / 0.50)',
                  fontSize: 10, padding: '1px 6px',
                }}
              >
                §14 — needs human approval
              </span>
            )}
            {gateApproved && (
              <span
                className="chip"
                style={{
                  background: 'oklch(0.72 0.15 145 / 0.14)',
                  color: 'oklch(0.82 0.15 145)',
                  borderColor: 'oklch(0.72 0.15 145 / 0.30)',
                  fontSize: 10, padding: '1px 6px',
                }}
              >
                §14 — approved
              </span>
            )}
          </div>

          {matchedRules && matchedRules.length > 0 && (
            <>
              <div className="section-label" style={{ fontSize: 10, marginBottom: 4 }}>
                Why this level
              </div>
              <ul style={{ margin: 0, padding: '0 0 0 4px', listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {matchedRules.map((rule, i) => {
                  const sub = LEVEL_META[rule.riskLevel ?? level];
                  return (
                    <li key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.4 }}>
                      <span
                        className="mono"
                        style={{
                          flex: '0 0 auto',
                          fontSize: 10,
                          padding: '1px 5px',
                          background: sub.bg,
                          color: sub.color,
                          borderRadius: 3,
                          border: `1px solid ${sub.bd}`,
                          alignSelf: 'flex-start',
                          marginTop: 1,
                        }}
                      >
                        {rule.appliesTo === 'commands' ? 'cmd' : 'file'} · {rule.pattern}
                      </span>
                      <span style={{ flex: 1, color: 'var(--fg-muted)' }}>
                        {rule.reason ?? `Elevated to ${rule.riskLevel ?? level}${rule.requiresHumanApproval ? ' + gate' : ''}`}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          {!matchedRules?.length && requiresHumanApproval && (
            <div className="dim" style={{ fontSize: 11.5 }}>
              This task is gated by §14 — a human must approve before it can move to merge_ready.
            </div>
          )}
        </span>
      )}
    </span>
  );
}
