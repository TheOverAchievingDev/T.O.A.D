import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function load() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'toad-flow-canvas-model-'));
  const source = path.resolve('src/components/flowCanvasModel.ts');
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
  const mod = await import(pathToFileURL(path.join(outDir, 'flowCanvasModel.js')).href);
  return { mod, cleanup: () => rm(tmp, { recursive: true, force: true }) };
}

const M = (id, role, extra = {}) => ({ id, name: id.toUpperCase(), role, avatar: id[0], status: 'idle', task: null, ...extra });
const T = (id, status, assignee, extra = {}) => ({ id, title: `title ${id}`, status, assignee, type: 'feature', ...extra });

test('buildFlowCanvas: lead pick, pipeline order, tasks-underneath, ticker, doneBucket, warnings', async () => {
  const { mod, cleanup } = await load();
  try {
    const team = { members: [
      M('dev1', 'developer'),
      M('lead1', 'lead'),
      M('arch1', 'architect'),
      M('rev1', 'reviewer'),
      M('weird1', 'designer'),
    ] };
    const tasks = [
      T('T-1', 'todo', 'dev1'),
      T('T-2', 'in-progress', 'dev1'),
      T('T-3', 'done', 'dev1'),
      T('T-4', 'rejected', 'dev1'),
      T('T-5', 'review', 'rev1', { requiresHumanApproval: true, humanApproved: false }),
      T('T-6', 'blocked', 'arch1'),
      T('T-7', 'done', 'arch1'),
      T('T-8', 'todo', 'ghost'),
    ];
    const runtimes = [
      { agent: 'dev1', status: 'live' },
      { agent: 'lead1', status: 'launching' },
      { agent: 'rev1', status: 'idle' },
    ];
    const drift = { teamScore: 42, perTaskScores: { 'T-2': 80, 'T-6': 10 } };

    const r = mod.buildFlowCanvas({ team, tasks, runtimes, drift, isDriftElevated: (s) => s >= 66 });

    assert.equal(r.lead.member.id, 'lead1');
    assert.equal(r.lead.coordinating, 4);
    assert.deepEqual(r.agents.map((a) => a.member.id), ['arch1', 'dev1', 'rev1', 'weird1']);
    const dev = r.agents.find((a) => a.member.id === 'dev1');
    assert.deepEqual(dev.tasks.map((t) => t.id), ['T-1', 'T-2']);
    assert.equal(dev.taskCount, 2);
    assert.equal(dev.runtimeStatus, 'live');
    assert.ok(r.agents.every((a) => !a.tasks.some((t) => t.id === 'T-8')));
    assert.deepEqual(r.ticker, {
      live: 2,
      open: 5,
      inReview: 1,
      blocked: 1,
      done: 2,
      driftPct: 42,
    });
    assert.equal(r.doneBucket.count, 2);
    assert.deepEqual(r.doneBucket.recent.map((t) => t.id), ['T-3', 'T-7']);
    const kinds = r.warnings.map((w) => `${w.kind}:${w.taskId}`).sort();
    assert.deepEqual(kinds, ['approval:T-5', 'drift:T-2']);
    assert.equal(r.lead.runtimeStatus, 'launching');
  } finally {
    await cleanup();
  }
});

test('buildFlowCanvas: unmapped role -> rank 99, stable same-role order', async () => {
  const { mod, cleanup } = await load();
  try {
    const team = { members: [
      M('u', 'wizard'),       // unmapped -> rank 99
      M('a', 'developer'),    // rank 2
      M('v', 'wizard'),       // unmapped -> rank 99 (after u, stable)
      M('b', 'developer'),    // rank 2 (after a, stable)
      M('c', 'qa'),           // rank 5
      M('d', 'lead'),         // excluded (lead)
      M('z', 'researcher'),   // rank 1
    ] };
    const r = mod.buildFlowCanvas({ team, tasks: [], runtimes: [], drift: null });
    // researcher(1) -> developer(2) a,b stable -> qa(5) -> wizard(99) u,v stable;
    // lead 'd' excluded. If `?? 99` were removed the unmapped roles would
    // produce NaN comparisons and this exact order would not hold.
    assert.deepEqual(r.agents.map((x) => x.member.id), ['z', 'a', 'b', 'c', 'u', 'v']);
  } finally {
    await cleanup();
  }
});

test('buildFlowCanvas: edge cases — empty team, lead-only, no drift, no runtimes, never throws', async () => {
  const { mod, cleanup } = await load();
  try {
    const empty = mod.buildFlowCanvas({ team: { members: [] }, tasks: [], runtimes: [], drift: null });
    assert.equal(empty.lead, null);
    assert.deepEqual(empty.agents, []);
    assert.deepEqual(empty.doneBucket, { count: 0, recent: [] });
    assert.deepEqual(empty.warnings, []);
    assert.deepEqual(empty.ticker, { live: 0, open: 0, inReview: 0, blocked: 0, done: 0, driftPct: null });

    const leadOnly = mod.buildFlowCanvas({ team: { members: [M('L', 'lead')] }, tasks: [T('T-1', 'todo', 'L')], runtimes: [], drift: null });
    assert.equal(leadOnly.lead.member.id, 'L');
    assert.deepEqual(leadOnly.agents, []);
    assert.equal(leadOnly.lead.runtimeStatus, 'idle');

    const noLead = mod.buildFlowCanvas({
      team: { members: [M('x', 'developer')] },
      tasks: [], runtimes: [], drift: { teamScore: 99, perTaskScores: { 'T-9': 100 } },
    });
    assert.equal(noLead.lead.member.id, 'x');
    assert.deepEqual(noLead.agents, []);
    assert.deepEqual(noLead.warnings, []);

    assert.doesNotThrow(() => mod.buildFlowCanvas({}));
    const junk = mod.buildFlowCanvas({});
    assert.equal(junk.lead, null);
    assert.deepEqual(junk.agents, []);
  } finally {
    await cleanup();
  }
});
