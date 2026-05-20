import type { Agent, Runtime, UiTask } from '@/types';

/**
 * Phase 2 AgentCard — single agent row used in both Cockpit modes:
 *   - FOR-me left column (full agent list, vertical stack)
 *   - WITH-me left column (agent section below the file tree)
 *
 * Renders the 36px avatar (initials + role-tinted background), name,
 * role label, current-task chip, and a spark indicator that
 * communicates intensity at a glance. Status dot at the avatar
 * corner shows the agent's runtime state.
 *
 * Status mapping (real Agent.status → mockup .avatar .status class):
 *   thinking/launching → 'working' (clay)
 *   live               → 'live'    (green)
 *   idle               → 'idle'    (gray)
 *   error              → 'error'   (red — Phase 2 adds new color)
 *
 * The card is a button so keyboard nav (tab/arrow) works without
 * extra wiring. Clicking selects the agent for the Inspector's
 * Agent tab.
 */

export interface AgentCardProps {
  agent: Agent;
  /** Runtime that this agent's process is attached to, when live. */
  runtime?: Runtime | null;
  /** Task currently assigned/in-progress for this agent, when known. */
  currentTask?: UiTask | null;
  /** Highlight the card as currently focused in the Inspector. */
  active?: boolean;
  onSelect: (agentId: string) => void;
}

type AvatarStatusClass = 'live' | 'idle' | 'working' | 'review' | 'error';

function statusClassFor(agent: Agent, currentTask: UiTask | null | undefined): AvatarStatusClass {
  // If the agent is reviewing a task, show review-blue regardless of
  // the lower-level runtime status — operators read "is this person
  // reviewing?" not "is the process running?"
  if (currentTask?.status === 'review' && agent.role === 'reviewer') return 'review';
  switch (agent.status) {
    case 'live':      return 'live';
    case 'thinking':  return 'working';
    case 'launching': return 'working';
    case 'error':     return 'error';
    case 'idle':
    default:          return 'idle';
  }
}

/**
 * Spark — five tiny squares filled left-to-right as intensity goes up.
 * Useful at a glance: ●●●●● is "fully active," ●●○○○ is "background."
 * Driven by agent.status today; Phase 3 polish can use real tokens-per-
 * minute or tool-call rate.
 */
function sparkFor(agent: Agent): string {
  switch (agent.status) {
    case 'live':      return '●●●●●';
    case 'thinking':  return '●●●●○';
    case 'launching': return '●●●○○';
    case 'error':     return '●○○○○';
    case 'idle':
    default:          return '○○○○○';
  }
}

/** Short, dense rendering of "task t_42 — bulk subscription quantity".
 *  Truncated to first ~32 chars to keep the card compact. */
function formatTaskLine(task: UiTask | null | undefined): string | null {
  if (!task) return null;
  const head = `${task.id} — ${task.title}`;
  return head.length > 32 ? `${head.slice(0, 30)}…` : head;
}

function initialsFor(agent: Agent): string {
  // Prefer the curated avatar if present (e.g. "D1"); else derive from
  // the agent name ("dev-1" → "D1", "reviewer-1" → "R1").
  if (agent.avatar && agent.avatar.length <= 3) return agent.avatar.toUpperCase();
  const parts = agent.name.split(/[-_\s]+/).filter(Boolean);
  if (parts.length === 1) {
    return agent.name.slice(0, 2).toUpperCase();
  }
  // first letter of first part + first digit/letter of second part
  const a = parts[0][0] ?? '?';
  const b = parts[1][0] ?? '';
  return (a + b).toUpperCase();
}

export function AgentCard({ agent, runtime: _runtime, currentTask = null, active = false, onSelect }: AgentCardProps) {
  const statusClass = statusClassFor(agent, currentTask);
  const taskLine = formatTaskLine(currentTask);
  const spark = sparkFor(agent);

  return (
    <button
      type="button"
      className={`agent-card${active ? ' active' : ''}`}
      data-role={agent.role}
      data-status={statusClass}
      onClick={() => onSelect(agent.id)}
      title={`${agent.name} · ${agent.role}`}
    >
      <div className="avatar mono">
        {initialsFor(agent)}
        <span className={`status ${statusClass}`} />
      </div>
      <div className="agent-meta">
        <div className="name">{agent.name}</div>
        <div className="role">{agent.role}</div>
        {taskLine && <div className="task">{taskLine}</div>}
      </div>
      <div className="spark" aria-hidden="true">{spark}</div>
    </button>
  );
}
