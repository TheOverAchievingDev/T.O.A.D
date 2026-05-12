import type { Actor } from '@/api/client';
import type { Agent, Message, Team } from '@/types';
import type { StreamEntry } from '@/utils/agentStream';
import { Icon } from '../Icon';
import { AgentInbox } from '../AgentInbox';

/**
 * Phase 2 AgentInboxPanel — right-side panel of the WITH-me Cockpit.
 *
 * Wraps the existing AgentInbox.tsx (Ask / Delegate / Interrupt modes
 * already wired) with right-panel chrome:
 *   - Header strip with an agent picker dropdown (lists team.members)
 *     and a close button (flips tweaks.showRightPanel to false).
 *   - Body = mounted AgentInbox for the currently picked agent.
 *
 * Selection persists per-session via `tweaks.rightPanelAgent` so the
 * operator returns to the same conversation when they re-open. When
 * the stored agent isn't in the current team (e.g. team changed),
 * falls back to the lead.
 */

export interface AgentInboxPanelProps {
  team: Team;
  /** Map agentId → recent stream entries. Defaults to empty. */
  agentStreams?: Record<string, StreamEntry[]>;
  /** Recent messages — passed through to AgentInbox for the messages
   *  tab. Same shape useToadData provides. */
  messages: Message[];
  /** Actor for sending replies from this panel. */
  actor?: Actor;
  /** Selected agent id, persisted by parent (tweaks.rightPanelAgent). */
  selectedAgentId: string | null;
  onSelectAgent: (id: string) => void;
  onClose: () => void;
  /** Called after a message is sent so the parent can refresh data. */
  onMessageSent?: () => void;
}

function pickDefaultAgent(team: Team, requestedId: string | null): Agent | null {
  if (requestedId) {
    const found = team.members.find((m) => m.id === requestedId);
    if (found) return found;
  }
  return team.members.find((m) => m.role === 'lead') ?? team.members[0] ?? null;
}

export function AgentInboxPanel({
  team,
  agentStreams = {},
  messages,
  actor,
  selectedAgentId,
  onSelectAgent,
  onClose,
  onMessageSent,
}: AgentInboxPanelProps) {
  const agent = pickDefaultAgent(team, selectedAgentId);

  if (!agent) {
    return (
      <div className="right-panel">
        <div className="right-panel-head">
          <span className="right-panel-title">Agent Inbox</span>
          <button type="button" className="right-panel-close" onClick={onClose} title="Close panel (Ctrl+Alt+I)">
            <Icon name="x" size={13} />
          </button>
        </div>
        <div className="right-panel-empty">No agents in this team yet.</div>
      </div>
    );
  }

  // The existing AgentInbox renders its own header and three-mode
  // composer; we just provide the panel chrome around it (agent picker
  // + close button).
  return (
    <div className="right-panel">
      <div className="right-panel-head">
        <label className="right-panel-picker">
          <span className="right-panel-picker-label">Agent</span>
          <select
            value={agent.id}
            onChange={(e) => onSelectAgent(e.target.value)}
          >
            {team.members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.role}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="right-panel-close"
          onClick={onClose}
          title="Close panel (Ctrl+Alt+I)"
        >
          <Icon name="x" size={13} />
        </button>
      </div>
      <div className="right-panel-body">
        <AgentInbox
          agent={agent}
          team={team}
          messages={messages}
          stream={agentStreams[agent.id] ?? []}
          actor={actor}
          onClose={onClose}
          onMessageSent={onMessageSent}
        />
      </div>
    </div>
  );
}
