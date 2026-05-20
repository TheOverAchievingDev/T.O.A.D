import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function load() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-span-summary-proj-'));
  const source = path.resolve('src/components/cockpit/spanSummaryProjection.ts');
  const outDir = path.join(tmp, 'out');
  const tsc = spawnSync(
    process.execPath,
    [
      path.resolve('node_modules/typescript/bin/tsc'),
      source,
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--target', 'ES2022',
      '--outDir', outDir,
      '--skipLibCheck',
      '--strict',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(tsc.status, 0, `${tsc.stdout}\n${tsc.stderr}`);
  const mod = await import(pathToFileURL(path.join(outDir, 'spanSummaryProjection.js')).href);
  return { mod, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

const R = (id, summaryText, spanEndedAt, extra = {}) => ({
  spanId: id, teamId: 't', runtimeId: 'rt', agentId: 'a', sessionId: 's',
  summaryText, model: 'haiku', cli: 'claude',
  spanStartedAt: '2026-05-16T00:00:00.000Z', spanEndedAt,
  rowCount: 3, tokens: 100, createdAt: spanEndedAt, ...extra,
});

const NOW = Date.parse('2026-05-16T02:00:00.000Z');

test('projectSpanSummaryEvents: maps rows newest-first to {id,when,dot:violet,body}', async () => {
  const { mod, cleanup } = await load();
  try {
    const rows = [
      R('S1', 'wrote the parser', '2026-05-16T00:30:00.000Z'),
      R('S2', 'fixed the bug', '2026-05-16T01:45:00.000Z'),
    ];
    const ev = mod.projectSpanSummaryEvents(rows, NOW);
    // newest spanEndedAt first → S2 then S1
    assert.deepEqual(ev.map((e) => e.id), ['summary-S2', 'summary-S1']);
    assert.ok(ev.every((e) => e.dot === 'violet'));
    assert.equal(ev[0].body, 'fixed the bug · haiku');
    assert.equal(ev[1].body, 'wrote the parser · haiku');
    assert.equal(typeof ev[0].when, 'string');
    assert.ok(ev[0].when.length > 0);
  } finally { await cleanup(); }
});

test('projectSpanSummaryEvents: blank/missing/non-string summaryText rows are SKIPPED', async () => {
  const { mod, cleanup } = await load();
  try {
    const rows = [
      R('A', '   ', '2026-05-16T01:00:00.000Z'),
      R('B', 'real summary', '2026-05-16T01:10:00.000Z'),
      R('C', '', '2026-05-16T01:20:00.000Z'),
      { ...R('D', 'x', '2026-05-16T01:30:00.000Z'), summaryText: 42 },
      { ...R('E', 'x', '2026-05-16T01:40:00.000Z'), summaryText: undefined },
    ];
    const ev = mod.projectSpanSummaryEvents(rows, NOW);
    assert.deepEqual(ev.map((e) => e.id), ['summary-B']);
  } finally { await cleanup(); }
});

test('projectSpanSummaryEvents: unparseable spanEndedAt falls back to createdAt then now; no model → bare text; never throws', async () => {
  const { mod, cleanup } = await load();
  try {
    const r1 = R('F', 'fallback me', 'not-a-date');
    r1.createdAt = '2026-05-16T01:00:00.000Z';
    const r2 = R('G', 'no model', '2026-05-16T01:50:00.000Z', { model: null, cli: null });
    const ev = mod.projectSpanSummaryEvents([r1, r2], NOW);
    assert.equal(ev.length, 2);
    const g = ev.find((e) => e.id === 'summary-G');
    assert.equal(g.body, 'no model');                 // no " · model" suffix when model falsy
    const f = ev.find((e) => e.id === 'summary-F');
    assert.equal(typeof f.when, 'string');             // resolved via createdAt fallback, no throw
  } finally { await cleanup(); }
});

test('projectSpanSummaryEvents: non-array / empty / malformed → [] (total, never throws)', async () => {
  const { mod, cleanup } = await load();
  try {
    assert.deepEqual(mod.projectSpanSummaryEvents([], NOW), []);
    assert.deepEqual(mod.projectSpanSummaryEvents(undefined, NOW), []);
    assert.deepEqual(mod.projectSpanSummaryEvents(null, NOW), []);
    assert.deepEqual(mod.projectSpanSummaryEvents('nope', NOW), []);
    assert.deepEqual(mod.projectSpanSummaryEvents([null, 1, 'x', {}], NOW), []);
    assert.doesNotThrow(() => mod.projectSpanSummaryEvents([{ summaryText: 'ok' }], NOW));
  } finally { await cleanup(); }
});

test('projectSpanSummaryEvents: stable order for equal spanEndedAt (input order preserved among ties)', async () => {
  const { mod, cleanup } = await load();
  try {
    const t = '2026-05-16T01:00:00.000Z';
    const ev = mod.projectSpanSummaryEvents([R('P', 'p', t), R('Q', 'q', t), R('Z', 'z', t)], NOW);
    assert.deepEqual(ev.map((e) => e.id), ['summary-P', 'summary-Q', 'summary-Z']);
  } finally { await cleanup(); }
});

test('projectSpanSummaryEvents output is what projectTimeline prepends (shape contract)', async () => {
  const { mod, cleanup } = await load();
  try {
    // Contract the timelineProjection prepend relies on: each event is a
    // {id,when,dot:'violet',body} object — structurally a TimelineEvent —
    // so `[...summaryEvents, ...composedEvents]` is a valid TimelineEvent[].
    const ev = mod.projectSpanSummaryEvents([R('K', 'k', '2026-05-16T01:00:00.000Z')], NOW);
    assert.equal(ev.length, 1);
    for (const e of ev) {
      assert.deepEqual(Object.keys(e).sort(), ['body', 'dot', 'id', 'when']);
      assert.equal(e.dot, 'violet');
      assert.equal(typeof e.id, 'string');
      assert.equal(typeof e.when, 'string');
      assert.equal(typeof e.body, 'string');
    }
  } finally { await cleanup(); }
});
