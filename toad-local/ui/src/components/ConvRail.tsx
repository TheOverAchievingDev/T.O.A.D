import { useState } from 'react';
import type { Team, Message } from '@/types';
import { ROLES, roleStyle } from '@/data/roles';
import { Icon } from './Icon';

interface ConvRailProps {
  team: Team;
  selected: string;
  messages: Message[];
}

type ConvTab = 'messages' | 'logs' | 'graph';
type ComposeMode = 'do' | 'ask' | 'delegate';

export function ConvRail({ team, messages }: ConvRailProps) {
  const [tab, setTab] = useState<ConvTab>('messages');
  const [composeMode, setComposeMode] = useState<ComposeMode>('ask');
  const [target, setTarget] = useState<string>(team.members[0]?.id ?? 'lead');

  const filtered = messages;
  const targetMember = team.members.find((m) => m.id === target) ?? team.members[0];
  if (!targetMember) return null;

  return (
    <>
      <div className="conv-tabs">
        <button className={`conv-tab ${tab === 'messages' ? 'active' : ''}`} onClick={() => setTab('messages')}>
          <Icon name="inbox" size={13} /> Messages <span className="num">{filtered.length}</span>
        </button>
        <button className={`conv-tab ${tab === 'logs' ? 'active' : ''}`} onClick={() => setTab('logs')}>
          <Icon name="terminal" size={13} /> Logs
        </button>
        <button className={`conv-tab ${tab === 'graph' ? 'active' : ''}`} onClick={() => setTab('graph')}>
          <Icon name="git" size={13} /> Graph
        </button>
      </div>

      <div className="conv-body">
        {tab === 'messages' && filtered.map((m) => {
          const fromAgent = team.members.find((a) => a.id === m.from);
          const toAgent = team.members.find((a) => a.id === m.to);
          if (!fromAgent) return null;
          return (
            <div key={m.id} className={`msg ${m.isToolCall ? 'tool-call' : ''}`} style={roleStyle(fromAgent.role)}>
              <div className="msg-head">
                <span className="msg-author">{fromAgent.name}</span>
                {toAgent && (
                  <>
                    <span className="msg-arrow">→</span>
                    <span className="msg-target" style={roleStyle(toAgent.role)}>
                      <span style={{ color: 'var(--accent)' }}>{toAgent.name}</span>
                    </span>
                  </>
                )}
                <span className="msg-time mono">{m.time}</span>
              </div>
              <div className="msg-body">{m.body}</div>
            </div>
          );
        })}

        {tab === 'logs' && (
          <div className="mono" style={{ fontSize: 11.5, color: 'var(--fg-muted)', lineHeight: 1.7 }}>
            <div><span style={{ color: 'var(--fg-dim)' }}>14:31:08</span> <span style={{ color: 'var(--clay)' }}>tom</span> tool/edit src/audio/stream.ts</div>
            <div><span style={{ color: 'var(--fg-dim)' }}>14:31:09</span> <span style={{ color: 'var(--clay)' }}>tom</span> tool/bash npm test -- stream.test.ts</div>
            <div><span style={{ color: 'var(--fg-dim)' }}>14:31:14</span> ✓ 8 passed (1.2s)</div>
            <div><span style={{ color: 'var(--fg-dim)' }}>14:32:01</span> <span style={{ color: 'var(--clay)' }}>alice</span> tool/read src/audio/stream.ts</div>
          </div>
        )}

        {tab === 'graph' && (
          <div style={{ color: 'var(--fg-muted)', fontSize: 12, padding: 20, textAlign: 'center' }}>
            <Icon name="git" size={28} style={{ opacity: 0.4, marginBottom: 8 }} />
            <div>Delegation graph view</div>
            <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginTop: 4 }}>Visualizes who delegated what to whom</div>
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-target">
          <span style={roleStyle(targetMember.role)}>
            <span className="status-dot" style={{ background: 'var(--accent)', marginRight: 6 }} />
            <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{targetMember.name}</span>
            <span style={{ color: 'var(--fg-dim)', marginLeft: 6 }}>{ROLES[targetMember.role].short}</span>
          </span>
          <select
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: 'var(--fg-muted)', fontSize: 11.5 }}
          >
            {team.members.map((m) => <option key={m.id} value={m.id}>change → {m.name}</option>)}
          </select>
        </div>
        <textarea
          className="composer-textarea"
          placeholder={`Message ${targetMember.name}…  Use @ for files, # for tasks`}
          rows={2}
        />
        <div className="composer-actions">
          <div className="composer-modes">
            <button className={`mode-btn ${composeMode === 'do' ? 'active' : ''}`} onClick={() => setComposeMode('do')}>Do</button>
            <button className={`mode-btn ${composeMode === 'ask' ? 'active' : ''}`} onClick={() => setComposeMode('ask')}>Ask</button>
            <button className={`mode-btn ${composeMode === 'delegate' ? 'active' : ''}`} onClick={() => setComposeMode('delegate')}>Delegate</button>
          </div>
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <button className="icon-btn" title="Attach"><Icon name="paperclip" size={14} /></button>
            <button className="icon-btn" title="Voice"><Icon name="mic" size={14} /></button>
            <button className="btn btn-primary btn-sm"><Icon name="send" size={12} /> Send</button>
          </div>
        </div>
      </div>
    </>
  );
}
