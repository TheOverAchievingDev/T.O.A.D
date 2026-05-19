export interface CockpitTreeActorLike {
  teamId?: string;
  agentId?: string;
  agentName?: string;
  role?: string;
}

export function resolveCockpitTreeActor({
  actor,
  teamName,
}: {
  actor?: CockpitTreeActorLike;
  teamName?: string;
}) {
  return {
    teamId: actor?.teamId || teamName || 'system',
    agentId: actor?.agentId || 'ui-client',
    agentName: actor?.agentName || 'ui',
    role: 'human',
  };
}
