import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// h(): plain-object stand-in for React.createElement / JSX.
// ser(): deterministic, react-free serialization of an element tree.
function h(type, props, ...children) { return { type, props: { ...(props || {}), children } }; }
const FRAG = 'FRAG';
function ser(node) {
  if (node == null || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(ser).join('');
  const t = node.type, c = ser(node.props ? node.props.children : '');
  const cls = node.props && node.props.className;
  if (t === FRAG) return c;
  return cls ? `<${t}.${cls}>${c}</${t}>` : `<${t}>${c}</${t}>`;
}

/* ---- VERBATIM from ui/src/components/cockpit/timelineProjection.tsx (JSX→h, do not edit logic) ---- */

function parseStreamTimestamp(entry, now) {
  const parts = entry.time.split(':').map(Number);
  if (parts.length !== 3 || parts.some(Number.isNaN)) return now;
  const [hh, mm, ss] = parts;
  const candidate = new Date(now);
  candidate.setHours(hh, mm, ss, 0);
  let ts = candidate.getTime();
  if (ts > now) ts -= 24 * 60 * 60 * 1000;
  return ts;
}

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

function dotForStream(entry) {
  // Most agent activity reads as the clay accent; system/output land
  // on tonally neutral colors. Phase 3 can refine.
  switch (entry.kind) {
    case 'tool':    return 'clay';
    case 'output':  return 'green';
    case 'thought': return 'blue';
    case 'system':  return 'amber';
    default:        return 'clay';
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

function bodyForStreamEl(agentName, entry) {
  const verb = entry.kind === 'tool'
    ? (entry.tool === 'Edit' || entry.tool === 'Write'
        ? 'edited'
        : entry.tool === 'Read'
          ? 'opened'
          : entry.tool === 'Bash'
            ? 'ran'
            : entry.tool === 'Grep' || entry.tool === 'Glob'
              ? 'searched for'
              : 'used')
    : entry.kind === 'output'
      ? 'reported'
      : entry.kind === 'thought'
        ? 'thinking:'
        : 'system:';

  const toolLabel = entry.tool ?? entry.kind;

  return h(FRAG, null, h('span', { className: 'agent' }, agentName), ' ', verb, ' ', (entry.kind === 'tool' && entry.tool ? h('span', { className: 'file' }, toolLabel) : null), (entry.body ? h(FRAG, null, ' — ', entry.body) : null));
}

function driftEl(prev, curr) {
  return h(FRAG, null, 'Drift run completed — score moved from ', h('b', null, prev, '%'), ' → ', h('b', null, curr, '%'), '.');
}

function lifecycleEl(t, agentLabel) {
  if (t.fromStatus === null) {
    return h(FRAG, null, (agentLabel ? h('span', { className: 'agent' }, agentLabel) : 'lead'), ' ', 'created task ', h('span', { className: 'file' }, t.taskId), ' — ', t.title, '.');
  }
  if (t.toStatus === 'done') {
    return h(FRAG, null, h('span', { className: 'file' }, t.taskId), ' done', (agentLabel ? h(FRAG, null, ' · finished by ', h('span', { className: 'agent' }, agentLabel)) : null), '.');
  }
  return h(FRAG, null, h('span', { className: 'file' }, t.taskId), ' ', 'moved ', h('b', null, t.fromStatus), ' → ', h('b', null, t.toStatus), (agentLabel ? h(FRAG, null, ' by ', h('span', { className: 'agent' }, agentLabel)) : null), '.');
}

function projectTimelineGolden(input) {
  const now = input.now ?? Date.now();
  const limit = input.limit ?? 8;
  const agentName = new Map();
  for (const a of input.agents) agentName.set(a.id, a.name);

  // Collect candidates from all agent streams (latest 4 per agent so
  // one chatty agent doesn't dominate the list).
  const candidates = [];
  for (const [agentId, entries] of Object.entries(input.agentStreams)) {
    const recent = entries.slice(-4);
    for (const entry of recent) {
      candidates.push({
        agentId,
        entry,
        ts: parseStreamTimestamp(entry, now),
      });
    }
  }

  // Sort by recency desc.
  candidates.sort((a, b) => b.ts - a.ts);
  // Cap candidates so the projection stays cheap even with chatty
  // teams.
  const head = candidates.slice(0, limit);

  // Drift events from history — emit one per consecutive-change pair
  // when the score moved by >= 3 points. Capped at 2 entries.
  const driftEvents = [];
  const driftHist = (input.driftHistory ?? [])
    .slice()
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-4);
  for (let i = 1; i < driftHist.length && driftEvents.length < 2; i++) {
    const prev = driftHist[i - 1];
    const curr = driftHist[i];
    if (Math.abs(curr.teamScore - prev.teamScore) < 3) continue;
    const ts = Date.parse(curr.createdAt);
    if (Number.isNaN(ts)) continue;
    driftEvents.push({
      id: `drift-${curr.runId}`,
      when: formatRelative(ts, now),
      dot: dotForDrift(prev.teamScore, curr.teamScore),
      bodyText: ser(driftEl(prev.teamScore, curr.teamScore)),
    });
  }

  const streamEvents = head.map(({ agentId, entry, ts }, idx) => {
    const name = agentName.get(agentId) ?? agentId;
    const expanded = idx === 0 ? true : undefined;
    return {
      id: `stream-${entry.id}-${idx}`,
      when: formatRelative(ts, now),
      dot: dotForStream(entry),
      ...(expanded === true ? { expanded: true } : {}),
      bodyText: ser(bodyForStreamEl(name, entry)),
      _ts: ts,
    };
  });

  // Phase 3a Task 5 — task lifecycle events from parent-tracked
  // snapshot deltas. Each transition becomes a timeline entry; agent
  // name is resolved from the agents map when available.
  const lifecycleEvents =
    (input.taskTransitions ?? []).map((t) => {
      const agentLabel = t.agentId ? (agentName.get(t.agentId) ?? t.agentId) : null;
      return {
        id: `task-${t.taskId}-${t.at}`,
        when: formatRelative(t.at, now),
        dot: lifecycleDot(t),
        bodyText: ser(lifecycleEl(t, agentLabel)),
        _ts: t.at,
      };
    });

  // Merge all event sources. Sort by recency (descending) so the
  // operator's eye lands on what just happened. Drop the internal _ts
  // key on the way out.
  const driftWithTs = driftEvents.map((e, i) => ({ ...e, _ts: (input.driftHistory?.length ?? 0) * 1000 - i }));
  const merged = [
    ...streamEvents,
    ...lifecycleEvents,
    ...driftWithTs,
  ];
  merged.sort((a, b) => b._ts - a._ts);
  return merged.slice(0, limit).map(({ _ts: _, ...rest }) => rest);
}

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, '..', 'test', 'fixtures', 'timelineComposition.input.json'), 'utf8'));
export function computeRows(allCases) {
  return allCases.map((c) => ({ name: c.name, rows: projectTimelineGolden(c.input) }));
}
if (process.argv[1] && process.argv[1].endsWith('captureTimelineCompositionGolden.mjs')) {
  const out = computeRows(cases);
  writeFileSync(join(here, '..', 'test', 'fixtures', 'timelineComposition.golden.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote golden: ${out.length} cases, ${out.reduce((n, c) => n + c.rows.length, 0)} rows`);
}
