export interface CockpitStreamEntry {
  id: string;
  time: string;
  kind: 'thought' | 'tool' | 'output' | 'system';
  tool?: string;
  body: string;
}

export interface CockpitMessage {
  id: number | string;
  from: string;
  to: string;
  time: string;
  body: string;
}

export interface CockpitOutputEntry {
  id: string;
  time: string;
  order: number;
  kind: CockpitStreamEntry['kind'] | 'message';
  agentId: string;
  label: string;
  body: string;
  tool?: string;
}

export function buildCockpitOutputEntries({
  streams,
  messages,
  limit = 12,
}: {
  streams: Record<string, CockpitStreamEntry[]>;
  messages: CockpitMessage[];
  limit?: number;
}): CockpitOutputEntry[] {
  const entries: CockpitOutputEntry[] = [];
  for (const [agentId, stream] of Object.entries(streams)) {
    for (let index = 0; index < stream.length; index += 1) {
      const item = stream[index];
      entries.push({
        id: `stream-${agentId}-${item.id}`,
        time: item.time,
        order: timeOrder(item.time, index),
        kind: item.kind,
        agentId,
        label: item.tool ?? streamKindLabel(item.kind),
        body: item.body,
        tool: item.tool,
      });
    }
  }
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    entries.push({
      id: `message-${message.id}`,
      time: message.time,
      order: timeOrder(message.time, index),
      kind: 'message',
      agentId: message.from,
      label: `${message.from} -> ${message.to}`,
      body: message.body,
    });
  }
  return entries
    .sort((a, b) => b.order - a.order)
    .slice(0, limit);
}

function streamKindLabel(kind: CockpitStreamEntry['kind']): string {
  if (kind === 'output') return 'assistant';
  if (kind === 'thought') return 'status';
  return kind;
}

function timeOrder(time: string, fallback: number): number {
  const match = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return fallback;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  if (![hours, minutes, seconds].every(Number.isFinite)) return fallback;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + fallback;
}
