import { useEffect, useState } from 'react';
import type { Agent } from '@/types';
import { ROLES, roleStyle } from '@/data/roles';
import { Icon } from './Icon';

export type AgentCardVariant = 'detail' | 'compact' | 'terminal';

interface AgentCardProps {
  agent: Agent;
  selected: boolean;
  onSelect: (id: string) => void;
  variant?: AgentCardVariant;
}

const formatTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`);

/** Window during which we treat the agent as "actively working" — drives
 *  the spinning ring + verb-form subtitle. After this elapses the card
 *  cools to a calmer "Working on …" / "Online — awaiting work" state. */
const ACTIVE_MS = 8_000;
/** Window during which we still surface the activity label as the
 *  subtitle (so a card doesn't immediately fall back to "Online" while
 *  the operator is still reading the last action). */
const RECENT_MS = 60_000;

/**
 * Verb-form a tool activity for the card subtitle, e.g.
 *   "Reading product-brief.md"  vs  the panel's terse "product-brief.md"
 * Falls back to the raw label for tools we don't have a verb for so the
 * subtitle never goes blank.
 */
function activitySubtitle(label: string, kind: string, tool?: string): string {
  if (kind !== 'tool') return label;
  if (!tool) return label;
  const t = tool;
  if (t === 'Read') return `Reading ${label.split(/[/\\]/).pop() || label}`;
  if (t === 'Write') return `Writing ${label.split(/[/\\]/).pop() || label}`;
  if (t === 'Edit') return `Editing ${label.split(/[/\\]/).pop() || label}`;
  if (t === 'Bash') return `Running: ${label.slice(0, 60)}${label.length > 60 ? '…' : ''}`;
  if (t === 'Grep') return `Searching: ${label}`;
  if (t === 'Glob') return `Finding files: ${label}`;
  if (t === 'TodoWrite') return 'Updating todos';
  if (t === 'task_create') return `Creating task ${label.split(' — ')[0] || ''}`;
  if (t === 'message_send') return `Messaging ${label.replace(/^→\s*/, '').split(':')[0] || 'team'}`;
  if (t === 'task_update') return `Updating task ${label}`;
  if (t === 'validation_run') return `Running validation: ${label.replace(/^Kind:\s*/, '')}`;
  if (t === 'review_decide') return `Deciding review: ${label.replace(/^Decision:\s*/, '')}`;
  return `${t}: ${label}`;
}

export function AgentCard({ agent, selected, onSelect, variant = 'detail' }: AgentCardProps) {
  const role = ROLES[agent.role];
  const tokensPct = agent.tokenLimit > 0
    ? Math.min(100, (agent.tokens / agent.tokenLimit) * 100)
    : 0;

  // Tick `now` every 2s so isActive/isRecent transitions reflect reality
  // even when no new SSE event arrived to retrigger a parent re-render.
  // Without this, a card that goes silent stays "active" forever.
  const [, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);

  const activityAt = agent.activity ? Date.parse(agent.activity.at) : NaN;
  const ageMs = Number.isFinite(activityAt) ? Math.max(0, Date.now() - activityAt) : Infinity;
  const isActive = ageMs < ACTIVE_MS;
  const isRecent = ageMs < RECENT_MS;

  if (variant === 'compact') {
    return (
      <div
        className={`agent-card ${agent.role === 'lead' ? 'lead' : ''} ${selected ? 'selected' : ''}`}
        style={{ ...roleStyle(agent.role), width: agent.role === 'lead' ? 304 : 220, padding: '10px 12px', gap: 6 }}
        onClick={() => onSelect(agent.id)}
      >
        <div className="agent-head">
          <div className="agent-avatar">{agent.avatar}</div>
          <div className="agent-id">
            <div className="agent-name">
              {agent.name}
              <span className={`status-dot ${agent.status}`} />
            </div>
            <div className="agent-role">{role.short} · {agent.model}</div>
          </div>
        </div>
      </div>
    );
  }

  if (variant === 'terminal') {
    return (
      <div
        className={`agent-card ${agent.role === 'lead' ? 'lead' : ''} ${selected ? 'selected' : ''}`}
        style={{ ...roleStyle(agent.role), padding: '10px 12px' }}
        onClick={() => onSelect(agent.id)}
      >
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--fg-muted)', marginBottom: 6 }}>
          <span style={{ color: 'var(--accent)' }}>{agent.name}</span>
          <span style={{ color: 'var(--fg-dim)' }}>@</span>
          <span>{role.short.toLowerCase()}</span>
          <span style={{ color: 'var(--fg-dim)', marginLeft: 6 }}>$</span>
          <span className={`status-dot ${agent.status}`} style={{ marginLeft: 6 }} />
        </div>
        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {agent.task || '› awaiting task'}
        </div>
      </div>
    );
  }

  // Subtitle resolution priority:
  //   1. Active tool / live activity (most informative — verb-formed)
  //   2. Assigned task title (working on something concrete)
  //   3. Status fallback (Online, Idle, Errored, etc.)
  const subtitle = isRecent && agent.activity
    ? activitySubtitle(agent.activity.label, agent.activity.kind, agent.activity.tool)
    : agent.task
      ? agent.task
      : agent.status === 'thinking'
        ? 'Thinking — no task assigned'
        : agent.status === 'live'
          ? (agent.role === 'lead' ? 'Online — orchestrating' : 'Online — awaiting work from lead')
          : agent.status === 'launching'
            ? 'Launching…'
            : agent.status === 'error'
              ? 'Errored — check logs'
              : 'Idle — agent not running';

  // Status dot CSS — base status + `.active` when there's been activity
  // very recently. The `.active` modifier paints a thin spinning ring
  // around the dot via a ::before pseudo-element (added in styles.css).
  const dotClasses = ['status-dot', agent.status, isActive ? 'active' : ''].filter(Boolean).join(' ');

  return (
    <div
      className={`agent-card ${agent.role === 'lead' ? 'lead' : ''} ${selected ? 'selected' : ''}`}
      style={roleStyle(agent.role)}
      onClick={() => onSelect(agent.id)}
    >
      <div className="agent-head">
        <div className="agent-avatar">{agent.avatar}</div>
        <div className="agent-id">
          <div className="agent-name">
            {agent.name}
            <span className={dotClasses} />
          </div>
          <div className="agent-role">{role.short}</div>
        </div>
        <button className="icon-btn" onClick={(e) => e.stopPropagation()} title="Message">
          <Icon name="send" size={13} />
        </button>
      </div>

      <div className={`agent-task ${subtitle && (agent.task || (isRecent && agent.activity)) ? '' : 'empty'}`}>
        <Icon
          name={
            isActive
              ? 'sparkle'
              : agent.task
                ? 'workflow'
                : agent.status === 'live' || agent.status === 'thinking' || agent.status === 'launching'
                  ? 'sparkle'
                  : 'pause'
          }
          size={13}
          className="task-icon"
        />
        <span
          style={{
            overflow: 'hidden',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            // Slight color shift when actively doing something — pulls the
            // operator's eye to the cards that are currently producing.
            color: isActive ? 'var(--fg)' : undefined,
          } as React.CSSProperties}
          title={agent.activity ? `${agent.activity.kind} · ${agent.activity.at}` : undefined}
        >
          {subtitle}
        </span>
      </div>

      <div className="agent-meta">
        <div className="agent-meta-left">
          <span className="model-badge">
            <span className={`provider-glyph ${agent.provider}`} />
            {agent.model}
          </span>
        </div>
        <div className="agent-meta-left">
          <span title={`${agent.tokens.toLocaleString()} / ${agent.tokenLimit.toLocaleString()} tokens`}>
            {formatTokens(agent.tokens)}
          </span>
          <div className="tokens-bar"><div className="tokens-bar-fill" style={{ width: `${tokensPct}%` }} /></div>
          <span style={{ color: 'var(--fg-dim)' }}>· {agent.tasksDone} done</span>
        </div>
      </div>
    </div>
  );
}
