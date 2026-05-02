import { useState } from 'react';
import { roleStyle } from '@/data/roles';
import { Icon, type IconName } from '@/components/Icon';
import type { Team } from '@/types';

type RuntimeTab = 'activity' | 'context' | 'inputs';
type ActivityType = 'thinking' | 'assistant' | 'user' | 'tool_use' | 'tool_result';
type ActivityLines = number | { added: number; removed: number } | null;

interface RuntimeSnapshot {
  id: string;
  agentId: string;
  teamName: string;
  taskId: string;
  status: string;
  pid: number;
  sessionId: string;
  provider: string;
  model: string;
  startedAt: string;
  uptime: string;
  tokens: { in: number; out: number; total: number; budget: number };
  cost: number;
  cwd: string;
  branch: string;
}

interface ActivityEventData {
  t: ActivityType;
  time: string;
  body?: string;
  tool?: string;
  input?: string;
  tokens?: number;
  lines?: ActivityLines;
  ok?: boolean;
}

interface ActivityEventProps {
  event: ActivityEventData;
}

interface ContextBreakdownItem {
  id: string;
  label: string;
  tokens: number;
  color: string;
}

interface InputHistoryItem {
  time: string;
  body: string;
}

interface ActivityMeta {
  color: string;
  label: string;
  icon: IconName;
}

export interface RuntimeDrawerProps {
  team: Team;
  onClose: () => void;
}

const RUNTIME: RuntimeSnapshot = {
  id: 'rt_5efa854c',
  agentId: 'tom',
  teamName: 'signal-ops',
  taskId: 'T-481',
  status: 'running',
  pid: 84221,
  sessionId: 'ses_b7f9c4',
  provider: 'Anthropic',
  model: 'Sonnet 4.6',
  startedAt: '14:03',
  uptime: '32m 14s',
  tokens: { in: 184_320, out: 41_830, total: 226_150, budget: 500_000 },
  cost: 1.84,
  cwd: '~/code/ide-test/.toad/worktrees/T-481',
  branch: 'feature/transcribe-v2',
};

const ACTIVITY_EVENTS: ActivityEventData[] = [
  {
    t: 'thinking',
    time: '14:34:18',
    body: 'I need to handle the case where the buffer flushes a partial frame on pause. Let me look at how recorder.ts handles this currently...',
    tokens: 142,
  },
  { t: 'tool_use', time: '14:34:21', tool: 'read', input: 'src/audio/recorder.ts', tokens: 58 },
  { t: 'tool_result', time: '14:34:21', tool: 'read', lines: 412, ok: true },
  { t: 'tool_use', time: '14:34:24', tool: 'grep', input: "pattern: 'paused', glob: 'src/audio/**'", tokens: 24 },
  { t: 'tool_result', time: '14:34:24', tool: 'grep', lines: 14, ok: true },
  {
    t: 'assistant',
    time: '14:34:31',
    body: "Found it. The pause flag is read on the next iteration but doesn't drain the partial buffer. I'll add a flush step before flipping the flag.",
    tokens: 96,
  },
  {
    t: 'tool_use',
    time: '14:34:34',
    tool: 'edit',
    input: 'src/audio/stream.ts',
    tokens: 184,
    lines: { added: 12, removed: 3 },
  },
  { t: 'tool_result', time: '14:34:34', tool: 'edit', lines: null, ok: true },
  { t: 'tool_use', time: '14:34:38', tool: 'bash', input: 'pnpm test stream', tokens: 18 },
  { t: 'tool_result', time: '14:34:42', tool: 'bash', lines: 24, ok: true, body: '8 passed (1.2s)' },
  {
    t: 'thinking',
    time: '14:34:44',
    body: "Tests pass. Should I also add a vitest case for the partial-frame flush, or is that covered by the existing 'flushes partial frame on pause' test?",
    tokens: 76,
  },
  { t: 'user', time: '14:34:51', body: "It's covered. Move on to the dual-reversal guard - that's still pending.", tokens: 18 },
  { t: 'assistant', time: '14:34:54', body: 'Got it. Wrapping pause/resume now...', tokens: 22 },
];

const CONTEXT_BREAKDOWN: ContextBreakdownItem[] = [
  { id: 'claude-md', label: 'CLAUDE.md', tokens: 8_420, color: 'oklch(0.70 0.13 245)' },
  { id: 'mentioned', label: 'Mentioned files', tokens: 64_180, color: 'oklch(0.72 0.15 145)' },
  { id: 'tool-out', label: 'Tool output', tokens: 92_440, color: 'oklch(0.78 0.14 80)' },
  { id: 'thinking', label: 'Thinking text', tokens: 18_710, color: 'oklch(0.65 0.18 295)' },
  { id: 'team', label: 'Team coordination', tokens: 14_320, color: 'oklch(0.65 0.20 25)' },
  { id: 'user', label: 'User messages', tokens: 28_080, color: 'var(--clay)' },
];

const INPUT_HISTORY: InputHistoryItem[] = [
  { time: '14:34:51', body: "It's covered. Move on to the dual-reversal guard - that's still pending." },
  { time: '14:18:02', body: 'Skip the manual recording step for now - focus on tests + typecheck.' },
  { time: '14:09:14', body: 'Plan looks good. Approved.' },
];

const ACTIVITY_META: Record<ActivityType, ActivityMeta> = {
  thinking: { color: 'oklch(0.65 0.18 295)', label: 'thinking', icon: 'info' },
  assistant: { color: 'var(--clay)', label: 'assistant', icon: 'send' },
  user: { color: 'oklch(0.70 0.13 245)', label: 'user', icon: 'users' },
  tool_use: { color: 'oklch(0.78 0.14 80)', label: 'tool', icon: 'edit' },
  tool_result: { color: 'oklch(0.72 0.15 145)', label: 'result', icon: 'check' },
};

function ActivityEvent({ event }: ActivityEventProps) {
  const meta = ACTIVITY_META[event.t];

  const lineMeta = (() => {
    if (event.lines == null) return null;
    if (typeof event.lines === 'number') {
      return <span style={{ color: 'var(--fg-muted)' }}>{event.lines} lines</span>;
    }
    return (
      <>
        <span style={{ color: 'var(--ok)' }}>+{event.lines.added}</span>
        <span style={{ color: 'var(--err)' }}>-{event.lines.removed}</span>
      </>
    );
  })();

  return (
    <div className="rt-event">
      <div className="rt-event-rail" style={{ color: meta.color }}>
        <span className="rt-event-dot" style={{ background: meta.color }} />
        <Icon name={meta.icon} size={11} />
      </div>
      <div className="rt-event-body">
        <div className="rt-event-head">
          <span className="rt-event-label" style={{ color: meta.color }}>{meta.label}</span>
          {event.tool && <span className="mono rt-event-tool">{event.tool}</span>}
          <span className="mono rt-event-time">{event.time}</span>
          {event.tokens && <span className="rt-event-tokens mono">{event.tokens}t</span>}
        </div>
        {event.input && <div className="mono rt-event-input">{event.input}</div>}
        {event.body && <div className="rt-event-text">{event.body}</div>}
        {lineMeta && (
          <div className="rt-event-meta mono">
            <span style={{ color: event.ok ? 'var(--ok)' : 'var(--err)' }}>{event.ok ? 'ok' : 'x'}</span>
            {lineMeta}
          </div>
        )}
      </div>
    </div>
  );
}

export function RuntimeDrawer({ onClose, team }: RuntimeDrawerProps) {
  const [tab, setTab] = useState<RuntimeTab>('activity');
  const [autoScroll, setAutoScroll] = useState(true);
  const [composer, setComposer] = useState('');
  const member = team.members.find((candidate) => candidate.id === RUNTIME.agentId);
  const totalContextTokens = CONTEXT_BREAKDOWN.reduce((total, item) => total + item.tokens, 0);
  const budgetPct = (totalContextTokens / 200_000) * 100;

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer rt-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="rt-head">
          <div className="rt-head-top">
            <div className="rt-head-left">
              {member && (
                <div className="rt-head-avatar" style={roleStyle(member.role)}>
                  <span className="agent-avatar" style={{ width: 32, height: 32, fontSize: 13 }}>{member.avatar}</span>
                  <span className="rt-head-pulse" style={{ background: 'var(--accent)' }} />
                </div>
              )}
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="rt-head-row">
                  <span className="rt-head-name" style={member ? roleStyle(member.role) : undefined}>
                    <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{member?.name ?? 'Agent'}</span>
                  </span>
                  <span
                    className="chip"
                    style={{
                      background: 'oklch(0.72 0.15 145 / 0.14)',
                      color: 'oklch(0.82 0.15 145)',
                      borderColor: 'oklch(0.72 0.15 145 / 0.30)',
                      fontSize: 10.5,
                    }}
                  >
                    <span className="status-dot live" /> Running
                  </span>
                  <span className="chip mono" style={{ fontSize: 10.5 }}>{RUNTIME.taskId}</span>
                </div>
                <div className="rt-head-sub mono">
                  {RUNTIME.id} - pid {RUNTIME.pid} - {RUNTIME.uptime} - {RUNTIME.provider} {RUNTIME.model}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button className="icon-btn"><Icon name="moreH" size={14} /></button>
              <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
            </div>
          </div>

          <div className="rt-stat-strip">
            <div className="rt-stat">
              <div className="rt-stat-label">Tokens</div>
              <div className="rt-stat-value mono">
                <span style={{ color: 'var(--fg)' }}>{(RUNTIME.tokens.total / 1000).toFixed(1)}k</span>
                <span style={{ color: 'var(--fg-dim)', marginLeft: 4 }}>/ {(RUNTIME.tokens.budget / 1000).toFixed(0)}k</span>
              </div>
              <div className="rt-stat-bar">
                <span style={{ width: `${(RUNTIME.tokens.total / RUNTIME.tokens.budget) * 100}%` }} />
              </div>
            </div>
            <div className="rt-stat">
              <div className="rt-stat-label">Cost</div>
              <div className="rt-stat-value mono">${RUNTIME.cost.toFixed(2)}</div>
              <div className="rt-stat-foot mono">
                in {(RUNTIME.tokens.in / 1000).toFixed(0)}k - out {(RUNTIME.tokens.out / 1000).toFixed(0)}k
              </div>
            </div>
            <div className="rt-stat">
              <div className="rt-stat-label">Branch</div>
              <div className="rt-stat-value mono" style={{ fontSize: 11.5, fontWeight: 500 }}>
                <Icon name="git" size={11} style={{ marginRight: 4, color: 'var(--fg-muted)' }} />
                {RUNTIME.branch}
              </div>
              <div className="rt-stat-foot mono">started {RUNTIME.startedAt}</div>
            </div>
          </div>

          <div className="rt-tabs">
            <button
              className={`side-tab ${tab === 'activity' ? 'active' : ''}`}
              onClick={() => setTab('activity')}
            >
              Activity <span className="num">{ACTIVITY_EVENTS.length}</span>
            </button>
            <button
              className={`side-tab ${tab === 'context' ? 'active' : ''}`}
              onClick={() => setTab('context')}
            >
              Context
            </button>
            <button
              className={`side-tab ${tab === 'inputs' ? 'active' : ''}`}
              onClick={() => setTab('inputs')}
            >
              Inputs <span className="num">{INPUT_HISTORY.length}</span>
            </button>
          </div>
        </div>

        <div className="rt-body">
          {tab === 'activity' && (
            <div className="rt-activity">
              <div className="rt-activity-toolbar">
                <div className="seg">
                  <button className="active">All</button>
                  <button>Tools</button>
                  <button>Assistant</button>
                  <button>Errors</button>
                </div>
                <label className="rt-autoscroll">
                  <input
                    type="checkbox"
                    checked={autoScroll}
                    onChange={(event) => setAutoScroll(event.target.checked)}
                  />
                  Auto-scroll
                </label>
              </div>
              <div className="rt-event-stack">
                {ACTIVITY_EVENTS.map((event, index) => <ActivityEvent key={`${event.time}-${index}`} event={event} />)}
                <div className="rt-live-indicator">
                  <span className="status-dot live" />
                  <span className="dim mono" style={{ fontSize: 11 }}>Streaming...</span>
                </div>
              </div>
            </div>
          )}

          {tab === 'context' && (
            <div className="rt-context">
              <div className="rt-context-budget">
                <div className="rt-context-budget-head">
                  <div>
                    <div className="rt-stat-label">Context window</div>
                    <div className="rt-stat-value mono" style={{ fontSize: 18 }}>
                      <span style={{ color: 'var(--fg)' }}>{(totalContextTokens / 1000).toFixed(1)}k</span>
                      <span style={{ color: 'var(--fg-dim)', fontSize: 13 }}> / 200k</span>
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div className="rt-stat-label">Headroom</div>
                    <div className="mono" style={{ fontSize: 14, color: budgetPct > 80 ? 'var(--warn)' : 'var(--ok)' }}>
                      {(100 - budgetPct).toFixed(0)}%
                    </div>
                  </div>
                </div>
                <div className="rt-context-bar">
                  {CONTEXT_BREAKDOWN.map((item) => (
                    <span
                      key={item.id}
                      style={{ width: `${(item.tokens / 200_000) * 100}%`, background: item.color }}
                      title={`${item.label}: ${item.tokens.toLocaleString()} tokens`}
                    />
                  ))}
                </div>
              </div>

              <div className="rt-context-list">
                {CONTEXT_BREAKDOWN.map((item) => {
                  const pct = (item.tokens / totalContextTokens) * 100;
                  return (
                    <div key={item.id} className="rt-context-row">
                      <span className="rt-context-swatch" style={{ background: item.color }} />
                      <span className="rt-context-label">{item.label}</span>
                      <div className="rt-context-mini-bar"><span style={{ width: `${pct}%`, background: item.color }} /></div>
                      <span className="mono rt-context-num">{(item.tokens / 1000).toFixed(1)}k</span>
                      <span className="dim mono rt-context-pct">{pct.toFixed(0)}%</span>
                    </div>
                  );
                })}
              </div>

              <div className="rt-context-actions">
                <button className="btn btn-sm btn-ghost"><Icon name="moreH" size={11} /> Compact context</button>
                <button className="btn btn-sm btn-ghost">Drop tool output</button>
                <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }}>Export breakdown</button>
              </div>
            </div>
          )}

          {tab === 'inputs' && (
            <div className="rt-inputs">
              <div className="rt-input-history">
                <div className="rt-input-history-h">
                  Sent inputs <span className="dim mono">{INPUT_HISTORY.length}</span>
                </div>
                {INPUT_HISTORY.map((input, index) => (
                  <div key={`${input.time}-${index}`} className="rt-input-row">
                    <span className="mono rt-input-time">{input.time}</span>
                    <div className="rt-input-body">{input.body}</div>
                  </div>
                ))}
              </div>

              <div className="rt-input-composer">
                <div className="rt-input-composer-h">
                  <span className="dim" style={{ fontSize: 11 }}>
                    Send to {member?.name ?? 'agent'} via runtime_send_input
                  </span>
                </div>
                <textarea
                  className="composer-textarea"
                  placeholder="Type a message - sent directly to the live runtime..."
                  rows={3}
                  value={composer}
                  onChange={(event) => setComposer(event.target.value)}
                />
                <div className="rt-input-foot">
                  <span className="dim" style={{ fontSize: 11 }}>
                    <span className="kbd">Ctrl</span> <span className="kbd">Enter</span> to send - interrupts current turn
                  </span>
                  <button className="btn btn-sm btn-primary"><Icon name="send" size={11} /> Send input</button>
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="rt-foot">
          <button className="btn btn-sm" style={{ color: 'var(--err)', borderColor: 'oklch(0.65 0.20 25 / 0.30)' }}>
            <Icon name="x" size={11} /> Stop
          </button>
          <button className="btn btn-sm">Restart</button>
          <button className="btn btn-sm btn-ghost"><Icon name="terminal" size={11} /> Tail logs</button>
          <button className="btn btn-sm btn-ghost"><Icon name="file" size={11} /> Export session</button>
          <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }}>
            <Icon name="eye" size={11} /> Open in IDE
          </button>
        </div>
      </div>
    </div>
  );
}
