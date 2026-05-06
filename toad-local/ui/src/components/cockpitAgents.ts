export interface CockpitAgentLike {
  id: string;
  name: string;
  status: string;
  activity?: { label?: string } | null;
}

export interface CockpitRuntimeLike {
  id: string;
  agent: string;
  status: string;
  provider: string;
  model: string;
  pid: number;
}

export interface CockpitStreamLike {
  body: string;
  time: string;
}

export interface CockpitAgentRow<TMember extends CockpitAgentLike, TRuntime extends CockpitRuntimeLike> {
  member: TMember;
  runtime: TRuntime | null;
  status: string;
  runtimeLabel: string | null;
  latestActivity: string;
  canOpenLogs: boolean;
}

const STATUS_RANK: Record<string, number> = {
  live: 0,
  launching: 1,
  thinking: 2,
  idle: 3,
  stopped: 4,
  error: 5,
};

export function buildCockpitAgentRows<TMember extends CockpitAgentLike, TRuntime extends CockpitRuntimeLike>({
  members,
  runtimes,
  streams,
}: {
  members: TMember[];
  runtimes: TRuntime[];
  streams: Record<string, CockpitStreamLike[]>;
}): CockpitAgentRow<TMember, TRuntime>[] {
  return members.map((member) => {
    const runtime = runtimes.find((candidate) => candidate.agent === member.id || candidate.agent === member.name) ?? null;
    const stream = streams[member.id] ?? streams[member.name] ?? [];
    const latestStream = stream[stream.length - 1];
    const runtimeLabel = runtime ? `${runtime.provider} / ${runtime.model}` : null;
    return {
      member,
      runtime,
      status: runtime?.status ?? member.status,
      runtimeLabel,
      latestActivity: latestStream?.body || member.activity?.label || 'Idle',
      canOpenLogs: runtime !== null,
    };
  }).sort((a, b) => {
    const rankDelta = statusRank(a.status) - statusRank(b.status);
    if (rankDelta !== 0) return rankDelta;
    return a.member.name.localeCompare(b.member.name, undefined, { sensitivity: 'base' });
  });
}

function statusRank(status: string): number {
  return STATUS_RANK[status] ?? 9;
}
