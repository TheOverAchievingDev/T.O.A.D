import { useEffect, useRef, useState } from 'react';
import type { Agent, Team, Message } from '@/types';
import { ROLES, roleStyle } from '@/data/roles';
import { Icon } from './Icon';
import type { StreamEntry } from '@/utils/agentStream';
import { callTool, ToadApiError, type Actor } from '@/api/client';

type ComposerMode = 'ask' | 'delegate' | 'interrupt';

const MODE_META: Record<ComposerMode, { label: string; placeholder: string; kind: string; urgentPrefix?: string; sendLabel: string }> = {
  ask: {
    label: 'Ask',
    placeholder: 'Ask a question — no work expected.',
    // Use 'instruction' kind so the agent treats it as a question they
    // should answer in chat, not as a task to act on.
    kind: 'instruction',
    sendLabel: 'Ask',
  },
  delegate: {
    label: 'Delegate',
    placeholder: 'Assign work — the agent will treat this as a task.',
    kind: 'task_notification',
    sendLabel: 'Delegate',
  },
  interrupt: {
    label: 'Interrupt',
    placeholder: 'Pre-empt the agent — stop what they\'re doing and follow this instead.',
    // System-kind messages bypass the normal "follow lead" pattern and
    // signal "this is from the operator, take it as a high-priority
    // override". The prefix makes that explicit in the message body.
    kind: 'system',
    urgentPrefix: '[OPERATOR INTERRUPT — pre-empt current work]\n\n',
    sendLabel: 'Interrupt',
  },
};

interface AgentInboxProps {
  agent: Agent;
  team: Team;
  messages: Message[];
  onClose: () => void;
  /** Pre-aggregated stream of events for this agent. Owned by useToadData
   *  and persists across agent-card switches so the inbox doesn't reset. */
  stream: StreamEntry[];
  /** Actor used when the operator sends a direct message via the composer. */
  actor?: Actor;
  /** Called after a message is sent so the parent can refresh its data. */
  onMessageSent?: () => void;
}

const COMPOSER_DEFAULT_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };

type InboxTab = 'activity' | 'messages';

function StreamItem({ item }: { item: StreamEntry }) {
  if (item.kind === 'thought') {
    return (
      <div className="ai-stream-item ai-stream-thought">
        <span className="ai-stream-time mono">{item.time}</span>
        <Icon name="sparkle" size={11} className="ai-stream-icon" />
        <div className="ai-stream-body" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.body}</div>
      </div>
    );
  }
  if (item.kind === 'tool') {
    return (
      <div className="ai-stream-item ai-stream-tool">
        <span className="ai-stream-time mono">{item.time}</span>
        <span className="chip mono" style={{ fontSize: 10, padding: '1px 6px' }}>{item.tool}</span>
        <div className="ai-stream-body mono" style={{ wordBreak: 'break-word' }}>{item.body}</div>
      </div>
    );
  }
  if (item.kind === 'system') {
    return (
      <div className="ai-stream-item" style={{ opacity: 0.7 }}>
        <span className="ai-stream-time mono">{item.time}</span>
        <span className="ai-stream-icon" style={{ color: 'var(--fg-dim)' }}>·</span>
        <div className="ai-stream-body" style={{ fontStyle: 'italic', color: 'var(--fg-muted)' }}>{item.body}</div>
      </div>
    );
  }
  return (
    <div className="ai-stream-item ai-stream-output">
      <span className="ai-stream-time mono">{item.time}</span>
      <span className="ai-stream-icon" style={{ color: 'var(--ok)' }}>›</span>
      <div className="ai-stream-body" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{item.body}</div>
    </div>
  );
}

export function AgentInbox({ agent, team, messages, onClose, stream, actor = COMPOSER_DEFAULT_ACTOR, onMessageSent }: AgentInboxProps) {
  const [tab, setTab] = useState<InboxTab>('activity');
  const myMsgs = messages.filter((m) => m.from === agent.id || m.to === agent.id);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Composer state — selectable mode + draft text + in-flight + error
  const [mode, setMode] = useState<ComposerMode>('delegate');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);

  async function sendComposerMessage() {
    const text = draft.trim();
    if (!text || sending) return;
    const meta = MODE_META[mode];
    const body = meta.urgentPrefix ? `${meta.urgentPrefix}${text}` : text;
    setSending(true);
    setComposerError(null);
    try {
      await callTool({
        actor,
        method: 'message_send',
        args: {
          to: { kind: 'agent', agentId: agent.id, teamId: actor.teamId },
          kind: meta.kind,
          text: body,
        },
        idempotencyKey: `composer-${agent.id}-${Date.now()}`,
      });
      setDraft('');
      onMessageSent?.();
    } catch (err) {
      const m = err instanceof ToadApiError ? err.message
        : err instanceof Error ? err.message
        : 'Failed to send message';
      setComposerError(m);
    } finally {
      setSending(false);
    }
  }

  // Auto-scroll to newest entry as the stream grows. Only when on the
  // activity tab so switching to messages/files doesn't yank the scroll.
  useEffect(() => {
    if (tab !== 'activity') return;
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [stream.length, tab, agent.id]);

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

      <div className="conv-tabs">
        <button className={`conv-tab ${tab === 'activity' ? 'active' : ''}`} onClick={() => setTab('activity')}>
          <Icon name="sparkle" size={12} /> Live <span className="num">{stream.length}</span>
        </button>
        <button className={`conv-tab ${tab === 'messages' ? 'active' : ''}`} onClick={() => setTab('messages')}>
          <Icon name="inbox" size={12} /> Messages <span className="num">{myMsgs.length}</span>
        </button>
      </div>

      <div className="conv-body" style={{ padding: 0 }}>
        {tab === 'activity' && (
          <div className="ai-stream" ref={scrollRef}>
            {stream.length === 0 ? (
              <div className="dim" style={{ padding: 24, textAlign: 'center', fontSize: 12 }}>
                Waiting for activity from {agent.name}…
                {agent.status === 'live' ? ' (agent is online)' : ''}
              </div>
            ) : null}
            {stream.map((s) => <StreamItem key={s.id} item={s} />)}
            {agent.status === 'live' || agent.status === 'thinking' ? (
              <div className="ai-stream-cursor mono">
                <span className="status-dot thinking" style={{ marginRight: 6 }} />
                {agent.status === 'thinking' ? 'thinking…' : 'live'}
              </div>
            ) : null}
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

      </div>

      <div className="composer">
        <div className="composer-target">
          <span className="status-dot" style={{ background: 'var(--accent)', marginRight: 6 }} />
          <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{agent.name}</span>
          <span className="dim" style={{ marginLeft: 6 }}>{MODE_META[mode].label.toLowerCase()} mode</span>
        </div>
        <textarea
          className="composer-textarea"
          placeholder={MODE_META[mode].placeholder}
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Cmd/Ctrl+Enter sends — common pattern, doesn't fight with
            // multi-line drafts. Plain Enter inserts a newline.
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void sendComposerMessage();
            }
          }}
          disabled={sending}
        />
        {composerError ? (
          <div style={{ fontSize: 11, color: 'var(--err, #f87171)', padding: '4px 0' }}>
            {composerError}
          </div>
        ) : null}
        <div className="composer-actions">
          <div className="composer-modes">
            {(['ask', 'delegate', 'interrupt'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`mode-btn ${mode === m ? 'active' : ''}`}
                onClick={() => setMode(m)}
                title={MODE_META[m].placeholder}
              >
                {MODE_META[m].label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => void sendComposerMessage()}
            disabled={sending || draft.trim().length === 0}
            title="Send (⌘/Ctrl + Enter)"
          >
            <Icon name="send" size={11} /> {sending ? 'Sending…' : MODE_META[mode].sendLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
