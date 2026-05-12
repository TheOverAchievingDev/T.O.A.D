import { useMemo } from 'react';
import type { Team } from '@/types';
import type { StreamEntry } from '@/utils/agentStream';

/**
 * Phase 3a Task 3 — Output slot for the WITH-me Cockpit BottomPanel.
 *
 * Renders the most recent agent tool-call entries across all team
 * members, newest first. Each row shows time + agent name + tool name
 * + a short summary. Functions like a live activity log so the
 * operator can watch the team work without leaving the editor.
 *
 * Phase 3 keeps it simple — no filtering, no detail expand, just a
 * flat scrollable list capped at 30 entries. Phase 4/5 polish can add
 * filtering by agent / kind, click-to-expand row detail, and link-out
 * to the Audit screen for the full history.
 */

export interface BottomPanelOutputProps {
  team: Team;
  agentStreams: Record<string, StreamEntry[]>;
  /** Max entries rendered. Default 30. */
  limit?: number;
}

interface FlatEntry {
  agentId: string;
  agentName: string;
  entry: StreamEntry;
}

export function BottomPanelOutput({ team, agentStreams, limit = 30 }: BottomPanelOutputProps) {
  const flat: FlatEntry[] = useMemo(() => {
    const agentName = new Map(team.members.map((a) => [a.id, a.name]));
    const all: FlatEntry[] = [];
    for (const [agentId, entries] of Object.entries(agentStreams)) {
      const name = agentName.get(agentId) ?? agentId;
      for (const entry of entries) {
        all.push({ agentId, agentName: name, entry });
      }
    }
    // StreamEntry.time is "HH:MM:SS" — string sort works for same-day
    // entries; for cross-day we'd need a real timestamp (Phase 5 if
    // anyone cares to filter older).
    all.sort((a, b) => b.entry.time.localeCompare(a.entry.time));
    return all.slice(0, limit);
  }, [team.members, agentStreams, limit]);

  if (flat.length === 0) {
    return (
      <div className="bp-output-empty">
        <div className="bp-empty-label">Output</div>
        <div className="bp-empty-hint">
          No recent agent tool calls. Activity from <span className="mono">tool_use</span> /
          <span className="mono"> assistant_text</span> events streams here when an agent runs.
        </div>
      </div>
    );
  }

  return (
    <div className="bp-output">
      {flat.map(({ agentId, agentName, entry }, idx) => (
        <div key={`${agentId}-${entry.id}-${idx}`} className={`bp-output-row kind-${entry.kind}`}>
          <span className="bp-output-time">{entry.time}</span>
          <span className="bp-output-agent">{agentName}</span>
          {entry.tool && <span className="bp-output-tool">{entry.tool}</span>}
          <span className="bp-output-body">{entry.body}</span>
        </div>
      ))}
    </div>
  );
}
