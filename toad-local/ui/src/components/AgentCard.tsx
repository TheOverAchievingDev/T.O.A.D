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

export function AgentCard({ agent, selected, onSelect, variant = 'detail' }: AgentCardProps) {
  const role = ROLES[agent.role];
  const tokensPct = Math.min(100, (agent.tokens / agent.tokenLimit) * 100);

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
            <span className={`status-dot ${agent.status}`} />
          </div>
          <div className="agent-role">{role.short}</div>
        </div>
        <button className="icon-btn" onClick={(e) => e.stopPropagation()} title="Message">
          <Icon name="send" size={13} />
        </button>
      </div>

      <div className={`agent-task ${agent.task ? '' : 'empty'}`}>
        <Icon name={agent.task ? 'workflow' : 'pause'} size={13} className="task-icon" />
        <span style={{ overflow: 'hidden', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' } as React.CSSProperties}>
          {agent.task || 'Idle — awaiting delegation'}
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
