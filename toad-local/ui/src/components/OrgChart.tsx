import type { Team } from '@/types';
import { AgentCard, type AgentCardVariant } from './AgentCard';

interface OrgChartProps {
  team: Team;
  selected: string;
  onSelect: (id: string) => void;
  cardVariant: AgentCardVariant;
}

export function OrgChart({ team, selected, onSelect, cardVariant }: OrgChartProps) {
  const lead = team.members.find((m) => m.role === 'lead');
  const reports = team.members.filter((m) => m.role !== 'lead');

  return (
    <div className="org-chart">
      {lead && (
        <>
          <AgentCard agent={lead} selected={selected === lead.id} onSelect={onSelect} variant={cardVariant} />
          <div className="org-spine" />
          <div style={{ position: 'relative', width: '100%', maxWidth: 920, height: 1, background: 'var(--border-soft)', marginBottom: 20 }} />
        </>
      )}
      <div className="org-tier">
        {reports.map((m) => (
          <div key={m.id} style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', top: -20, left: '50%', width: 1, height: 20, background: 'var(--border-soft)' }} />
            <AgentCard agent={m} selected={selected === m.id} onSelect={onSelect} variant={cardVariant} />
          </div>
        ))}
      </div>
    </div>
  );
}
