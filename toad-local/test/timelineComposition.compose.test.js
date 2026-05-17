import test from 'node:test';
import assert from 'node:assert/strict';
import { composeTimeline, DOT } from '../src/runtime/timelineComposition/index.js';

const NOW = 1747353600000;
const baseInput = () => ({
  now: NOW, limit: 8,
  agents: [{ id: 'a1', name: 'dev-1' }],
  agentStreams: { a1: [
    { entryId: 's1', kind: 'tool', tool: 'Read', body: 'a', ts: NOW - 5000 },
    { entryId: 's2', kind: 'tool', tool: 'Edit', body: 'b', ts: NOW - 4000 },
  ] },
  driftHistory: [
    { runId: 'd1', teamScore: 50, createdAt: '2026-05-16T09:00:00.000Z' },
    { runId: 'd2', teamScore: 60, createdAt: '2026-05-16T09:01:00.000Z' },
  ],
  taskTransitions: [{ taskId: 't1', title: 'x', fromStatus: null, toStatus: 'in_progress', agentId: 'a1', at: NOW - 1000 }],
});

test('DOT is the sealed FlowTimeline union', () => {
  assert.deepEqual([...DOT].sort(), ['amber', 'blue', 'clay', 'green', 'violet']);
});

test('per-agent slice(-4) window + sort desc + limit cap', () => {
  const i = baseInput();
  i.agentStreams.a1 = Array.from({ length: 6 }, (_, k) => ({ entryId: `s${k}`, kind: 'tool', tool: 'Read', body: `${k}`, ts: NOW - (10 - k) * 1000 }));
  i.driftHistory = []; i.taskTransitions = []; i.limit = 3;
  const rows = composeTimeline(i);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.stream.body), ['5', '4', '3']);
  assert.equal(rows[0].expanded, true);
  assert.equal(rows[1].expanded, undefined);
});

test('stream row shape: id/when/dot/kind/payload', () => {
  const i = baseInput(); i.driftHistory = []; i.taskTransitions = [];
  const r = composeTimeline(i)[0];
  assert.equal(r.kind, 'stream');
  assert.match(r.id, /^stream-s2-0$/);
  assert.equal(r.dot, 'clay');
  assert.equal(typeof r.when, 'string');
  assert.deepEqual(r.stream, { agentName: 'dev-1', entryKind: 'tool', tool: 'Edit', body: 'b' });
});

test('drift fold: |Δ|>=3 emits, <3 skips, cap 2, NaN-date skip', () => {
  const i = baseInput(); i.agentStreams = {}; i.taskTransitions = [];
  i.driftHistory = [
    { runId: 'd1', teamScore: 50, createdAt: '2026-05-16T09:00:00.000Z' },
    { runId: 'd2', teamScore: 51, createdAt: '2026-05-16T09:01:00.000Z' },
    { runId: 'd3', teamScore: 60, createdAt: '2026-05-16T09:02:00.000Z' },
  ];
  const rows = composeTimeline(i);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'drift');
  assert.deepEqual(rows[0].drift, { prevScore: 51, nextScore: 60 });
  assert.equal(rows[0].dot, 'amber');
});

test('lifecycle fold: create/done/move payload + agentLabel resolution + dot', () => {
  const i = baseInput(); i.agentStreams = {}; i.driftHistory = [];
  i.taskTransitions = [
    { taskId: 't1', title: 'c', fromStatus: null, toStatus: 'in_progress', agentId: 'a1', at: NOW - 3000 },
    { taskId: 't2', title: 'd', fromStatus: 'review', toStatus: 'done', agentId: 'zz', at: NOW - 2000 },
    { taskId: 't3', title: 'm', fromStatus: 'in_progress', toStatus: 'review', agentId: null, at: NOW - 1000 },
  ];
  const byId = Object.fromEntries(composeTimeline(i).map((r) => [r.id, r]));
  assert.deepEqual(byId['task-t1-' + (NOW - 3000)].lifecycle, { taskId: 't1', title: 'c', fromStatus: null, toStatus: 'in_progress', agentLabel: 'dev-1' });
  assert.equal(byId['task-t1-' + (NOW - 3000)].dot, 'blue');
  assert.equal(byId['task-t2-' + (NOW - 2000)].lifecycle.agentLabel, 'zz');
  assert.equal(byId['task-t2-' + (NOW - 2000)].dot, 'green');
  assert.equal(byId['task-t3-' + (NOW - 1000)].lifecycle.agentLabel, null);
  assert.equal(byId['task-t3-' + (NOW - 1000)].dot, 'violet');
});

test('merge ordering by _ts desc + final cap; empty input → []', () => {
  assert.deepEqual(composeTimeline({ now: NOW, agents: [], agentStreams: {} }), []);
  const rows = composeTimeline(baseInput());
  assert.ok(rows.length <= 8);
});
