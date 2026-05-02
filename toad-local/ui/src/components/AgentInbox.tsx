import { useState } from 'react';
import type { Agent, Team, Message } from '@/types';
import { ROLES, roleStyle } from '@/data/roles';
import { Icon } from './Icon';

interface StreamEntry {
  time: string;
  kind: 'thought' | 'tool' | 'output';
  tool?: string;
  body: string;
}

interface AgentInboxData {
  currentTask: {
    id: string;
    title: string;
    progress: number;
    step: string;
    files: string[];
  } | null;
  liveStream: StreamEntry[];
}

const AGENT_INBOX_DATA: Record<string, AgentInboxData> = {
  tom: {
    currentTask: {
      id: 'T-481',
      title: 'Streaming buffer for transcription',
      progress: 68,
      step: 'Writing tests',
      files: ['src/audio/stream.ts', 'src/audio/buffer.ts', 'tests/stream.test.ts'],
    },
    liveStream: [
      { time: '14:34:02', kind: 'thought', body: 'Need to handle the partial frame on pause — alice flagged dropping <16ms of audio' },
      { time: '14:34:08', kind: 'tool', tool: 'edit', body: 'src/audio/stream.ts +12 −3' },
      { time: '14:34:14', kind: 'tool', tool: 'bash', body: 'npm test -- stream.test.ts' },
      { time: '14:34:19', kind: 'output', body: '✓ 9 passed (1.4s)' },
    ],
  },
  alice: {
    currentTask: {
      id: 'T-479',
      title: 'Review PR #42 — chunking edge cases',
      progress: 92,
      step: 'Final pass',
      files: ['src/audio/stream.ts', 'tests/stream.test.ts'],
    },
    liveStream: [
      { time: '14:32:01', kind: 'tool', tool: 'read', body: 'src/audio/stream.ts (264 lines)' },
      { time: '14:32:18', kind: 'thought', body: 'Checking the reversal guard implementation. Need to trace pause/resume path.' },
    ],
  },
};

function StreamItem({ item }: { item: StreamEntry }) {
  if (item.kind === 'thought') {
    return (
      <div className="ai-stream-item ai-stream-thought">
        <span className="ai-stream-time mono">{item.time}</span>
        <Icon name="sparkle" size={11} className="ai-stream-icon" />
        <div className="ai-stream-body">{item.body}</div>
      </div>
    );
  }
  if (item.kind === 'tool') {
    return (
      <div className="ai-stream-item ai-stream-tool">
        <span className="ai-stream-time mono">{item.time}</span>
        <span className="chip mono" style={{ fontSize: 10, padding: '1px 6px' }}>{item.tool}</span>
        <div className="ai-stream-body mono">{item.body}</div>
      </div>
    );
  }
  return (
    <div className="ai-stream-item ai-stream-output">
      <span className="ai-stream-time mono">{item.time}</span>
      <span className="ai-stream-icon" style={{ color: 'var(--ok)' }}>›</span>
      <div className="ai-stream-body mono">{item.body}</div>
    </div>
  );
}

interface AgentInboxProps {
  agent: Agent;
  team: Team;
  messages: Message[];
  onClose: () => void;
}

type InboxTab = 'activity' | 'messages' | 'files';

export function AgentInbox({ agent, team, messages, onClose }: AgentInboxProps) {
  const [tab, setTab] = useState<InboxTab>('activity');
  const data = AGENT_INBOX_DATA[agent.id] ?? { liveStream: [], currentTask: null };
  const myMsgs = messages.filter((m) => m.from === agent.id || m.to === agent.id);

  return (
    <div className="ai-inbox" style={roleStyle(agent.role)}>
      <div className="ai-inbox-head">
        <button className="icon-btn" onClick={onClose}><Icon name="chevronLeft" size={14} /></button>
        <div className="agent-avatar" style={{ width: 34, height: 34, fontSize: 14 }}>{agent.avatar}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ai-inbox-name">
            {agent.name}
            <span className={`status-dot ${agent.status}`} />
          </div>
          <div className="ai-inbox-sub">
            {ROLES[agent.role].short} · <span className="mono">{agent.model}</span>
          </div>
        </div>
        <button className="icon-btn" title="More"><Icon name="moreH" size={14} /></button>
      </div>

      {data.currentTask && (
        <div className="ai-task-card">
          <div className="ai-task-head">
            <span className="section-label">Working on</span>
            <span className="mono dim" style={{ fontSize: 10.5 }}>{data.currentTask.id}</span>
          </div>
          <div className="ai-task-title">{data.currentTask.title}</div>
          <div className="ai-task-progress">
            <div className="ai-task-bar">
              <div className="ai-task-bar-fill" style={{ width: `${data.currentTask.progress}%` }} />
            </div>
            <span className="dim mono" style={{ fontSize: 10.5 }}>{data.currentTask.progress}%</span>
          </div>
          <div className="ai-task-step">
            <span className="status-dot thinking" />
            <span style={{ fontSize: 12 }}>{data.currentTask.step}</span>
          </div>
        </div>
      )}

      <div className="conv-tabs">
        <button className={`conv-tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')}>
          <Icon name="sparkle" size={12} /> Live <span className="num">{data.liveStream.length}</span>
        </button>
        <button className={`conv-tab ${tab === 'messages' ? 'active' : ''}`} onClick={() => setTab('messages')}>
          <Icon name="inbox" size={12} /> Messages <span className="num">{myMsgs.length}</span>
        </button>
        <button className={`conv-tab ${tab === 'files' ? 'active' : ''}`} onClick={() => setTab('files')}>
          <Icon name="file" size={12} /> Files
        </button>
      </div>

      <div className="conv-body" style={{ padding: 0 }}>
        {tab === 'activity' && (
          <div className="ai-stream">
            {data.liveStream.map((s, i) => <StreamItem key={i} item={s} />)}
            <div className="ai-stream-cursor mono">
              <span className="status-dot thinking" style={{ marginRight: 6 }} />
              thinking…
            </div>
          </div>
        )}

        {tab === 'messages' && (
          <div style={{ padding: '8px 14px' }}>
            {myMsgs.length === 0 && (
              <div className="dim" style={{ padding: 24, textAlign: 'center', fontSize: 12 }}>
                No messages yet.
              </div>
            )}
            {myMsgs.map((m) => {
              const fromAgent = team.members.find((a) => a.id === m.from);
              const toAgent = team.members.find((a) => a.id === m.to);
              if (!fromAgent || !toAgent) return null;
              const isOutgoing = m.from === agent.id;
              return (
                <div key={m.id} className={`ai-msg ${isOutgoing ? 'outgoing' : 'incoming'}`}>
                  <div className="ai-msg-head">
                    <span style={{ ...roleStyle(fromAgent.role), color: 'var(--accent)', fontWeight: 600 }}>{fromAgent.name}</span>
                    <span className="msg-arrow">→</span>
                    <span style={{ ...roleStyle(toAgent.role), color: 'var(--accent)' }}>{toAgent.name}</span>
                    <span className="msg-time mono">{m.time}</span>
                  </div>
                  <div className="ai-msg-body">{m.body}</div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'files' && data.currentTask && (
          <div style={{ padding: '8px 14px' }}>
            {data.currentTask.files.map((f) => (
              <div key={f} className="ai-file-row">
                <Icon name="file" size={12} style={{ color: 'var(--fg-muted)' }} />
                <span className="mono" style={{ fontSize: 12, flex: 1 }}>{f}</span>
                <span className="dim" style={{ fontSize: 10.5 }}>edited 2m ago</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="composer">
        <div className="composer-target">
          <span className="status-dot" style={{ background: 'var(--accent)', marginRight: 6 }} />
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{agent.name}</span>
          <span className="dim" style={{ marginLeft: 6 }}>direct message</span>
        </div>
        <textarea
          className="composer-textarea"
          placeholder={`Message ${agent.name} directly…`}
          rows={2}
        />
        <div className="composer-actions">
          <div className="composer-modes">
            <button className="mode-btn">Ask</button>
            <button className="mode-btn active">Delegate</button>
            <button className="mode-btn">Interrupt</button>
          </div>
          <button className="btn btn-primary btn-sm"><Icon name="send" size={11} /> Send</button>
        </div>
      </div>
    </div>
  );
}
