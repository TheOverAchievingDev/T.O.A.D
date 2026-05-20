// Pure timeline composition (Readability Layer-2 P2a). Zero imports,
// JSX-free, server-importable — the eventNarration pure-core discipline.
// Replicates the EXACT pre-refactor projectTimeline algorithm; emits
// structured ComposedRow[] (no ReactNode). The client renderer maps
// ComposedRow → TimelineEvent via the (kept-client) JSX body builders.

// Sealed dot set — kept EQUAL to FlowTimeline.tsx's TimelineDot union
// by a guard assertion in the purity test (no import coupling).
export const DOT = Object.freeze(new Set(['clay', 'green', 'blue', 'amber', 'violet']));

function formatRelative(ts, now) {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
}
function dotForStreamKind(kind) {
  switch (kind) {
    case 'tool': return 'clay';
    case 'output': return 'green';
    case 'thought': return 'blue';
    case 'system': return 'amber';
    default: return 'clay';
  }
}
function dotForDrift(prev, next) {
  if (next > prev) return 'amber';
  if (next < prev) return 'green';
  return 'clay';
}
function lifecycleDot(t) {
  if (t.fromStatus === null) return 'blue';
  if (t.toStatus === 'done') return 'green';
  if (t.toStatus === 'blocked' || t.toStatus === 'rejected') return 'amber';
  if (t.toStatus === 'review') return 'violet';
  return 'clay';
}

/**
 * @param {{ agentStreams:Record<string,Array<{entryId:string,kind:string,tool?:string,body:string,ts:number}>>,
 *           agents:Array<{id:string,name:string}>,
 *           driftHistory?:Array<{runId:string,teamScore:number,createdAt:string}>,
 *           taskTransitions?:Array<{taskId:string,title:string,fromStatus:string|null,toStatus:string,agentId:string|null,at:number}>,
 *           now:number, limit?:number }} input
 * @returns {Array<{id:string,when:string,dot:string,expanded?:boolean,kind:'stream'|'drift'|'lifecycle',
 *                   stream?:object, drift?:object, lifecycle?:object}>}
 */
export function composeTimeline(input) {
  const now = typeof input.now === 'number' ? input.now : Date.now();
  const limit = input.limit ?? 8;
  const agentName = new Map();
  for (const a of input.agents ?? []) agentName.set(a.id, a.name);

  const candidates = [];
  for (const [agentId, entries] of Object.entries(input.agentStreams ?? {})) {
    const recent = (entries ?? []).slice(-4);
    for (const entry of recent) candidates.push({ agentId, entry, ts: entry.ts });
  }
  candidates.sort((a, b) => b.ts - a.ts);
  const head = candidates.slice(0, limit);

  const driftRows = [];
  const driftHist = (input.driftHistory ?? [])
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-4);
  for (let i = 1; i < driftHist.length && driftRows.length < 2; i++) {
    const prev = driftHist[i - 1];
    const curr = driftHist[i];
    if (Math.abs(curr.teamScore - prev.teamScore) < 3) continue;
    const ts = Date.parse(curr.createdAt);
    if (Number.isNaN(ts)) continue;
    driftRows.push({
      id: `drift-${curr.runId}`,
      when: formatRelative(ts, now),
      dot: dotForDrift(prev.teamScore, curr.teamScore),
      kind: 'drift',
      drift: { prevScore: prev.teamScore, nextScore: curr.teamScore },
    });
  }
  const driftWithTs = driftRows.map((e, i) => ({ ...e, _ts: (input.driftHistory?.length ?? 0) * 1000 - i }));

  const streamRows = head.map(({ agentId, entry, ts }, idx) => ({
    id: `stream-${entry.entryId}-${idx}`,
    when: formatRelative(ts, now),
    dot: dotForStreamKind(entry.kind),
    expanded: idx === 0 ? true : undefined,
    kind: 'stream',
    stream: { agentName: agentName.get(agentId) ?? agentId, entryKind: entry.kind, tool: entry.tool, body: entry.body },
    _ts: ts,
  }));

  const lifecycleRows = (input.taskTransitions ?? []).map((t) => ({
    id: `task-${t.taskId}-${t.at}`,
    when: formatRelative(t.at, now),
    dot: lifecycleDot(t),
    kind: 'lifecycle',
    lifecycle: {
      taskId: t.taskId,
      title: t.title,
      fromStatus: t.fromStatus,
      toStatus: t.toStatus,
      agentLabel: t.agentId ? (agentName.get(t.agentId) ?? t.agentId) : null,
    },
    _ts: t.at,
  }));

  const merged = [...streamRows, ...lifecycleRows, ...driftWithTs];
  merged.sort((a, b) => b._ts - a._ts);
  return merged.slice(0, limit).map(({ _ts: _omit, ...rest }) => rest);
}
