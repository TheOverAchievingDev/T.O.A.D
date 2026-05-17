import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { composeTimeline } from '../src/runtime/timelineComposition/index.js';

// === IDENTICAL to scripts/captureTimelineCompositionGolden.mjs ===
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

// renderBodyText is the transparent ComposedRow->builder-args rename
// shim — the .js analog of the .tsx renderer's renderBody. composeTimeline
// emits stream:{agentName,entryKind,tool,body}, drift:{prevScore,nextScore},
// lifecycle:{taskId,title,fromStatus,toStatus,agentLabel}; the shim only
// renames/destructures those back into the byte-identical builders'
// original arg shapes. NO logic, NO defaulting.
function renderBodyText(row) {
  if (row.kind === 'stream') {
    const s = row.stream;
    return ser(bodyForStreamEl(s.agentName, { kind: s.entryKind, tool: s.tool, body: s.body }));
  }
  if (row.kind === 'drift') return ser(driftEl(row.drift.prevScore, row.drift.nextScore));
  return ser(lifecycleEl(
    { fromStatus: row.lifecycle.fromStatus, toStatus: row.lifecycle.toStatus, taskId: row.lifecycle.taskId, title: row.lifecycle.title },
    row.lifecycle.agentLabel,
  ));
}
// =================================================================

const here = dirname(fileURLToPath(import.meta.url));
const cases = JSON.parse(readFileSync(join(here, 'fixtures', 'timelineComposition.input.json'), 'utf8'));
const golden = JSON.parse(readFileSync(join(here, 'fixtures', 'timelineComposition.golden.json'), 'utf8'));

function adaptInput(input) {
  const now = typeof input.now === 'number' ? input.now : Date.now();
  function parseStreamTimestamp(entry) {
    const parts = String(entry.time).split(':').map(Number);
    if (parts.length !== 3 || parts.some(Number.isNaN)) return now;
    const [hh, mm, ss] = parts;
    const c = new Date(now); c.setHours(hh, mm, ss, 0);
    let ts = c.getTime(); if (ts > now) ts -= 24 * 60 * 60 * 1000;
    return ts;
  }
  const agentStreams = {};
  for (const [aid, entries] of Object.entries(input.agentStreams ?? {})) {
    agentStreams[aid] = (entries ?? []).map((e) => ({ entryId: e.id, kind: e.kind, tool: e.tool, body: e.body, ts: parseStreamTimestamp(e) }));
  }
  return { ...input, agentStreams };
}

test('agreement: post-refactor composeTimeline path is BYTE-IDENTICAL to the frozen pristine golden', () => {
  const out = cases.map((c) => ({
    name: c.name,
    rows: composeTimeline(adaptInput(c.input)).map((row) => ({
      id: row.id,
      when: row.when,
      dot: row.dot,
      ...(row.expanded === true ? { expanded: true } : {}),
      bodyText: renderBodyText(row),
    })),
  }));
  assert.deepEqual(out, golden);
});
