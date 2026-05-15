import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStructuralDeclaredAbsent } from '../../../src/drift/checks/checkStructuralDeclaredAbsent.js';

// L1.2a — declared-but-absent structural drift, roadmap-aware.
// Pure function over the snapshot. buildSnapshot pre-resolves which
// declared module evidence-paths exist (snapshot.structurePresence)
// so this check never touches disk, matching L1.1's pattern.
//
// Severity matrix (reviewer ruling, Option 4 / slice a):
//   declared module present in source                      → no finding
//   declared, absent, NO task delivers it                  → low
//   declared, absent, delivering task pending/in_progress  → no finding (in-flight)
//   declared, absent, delivering task done (no merge ev.)  → high
//   declared, absent, delivering task merged               → critical
//   `delivers` field absent on ALL tasks                   → ONE info meta
//                                                            ("not enforced")

function snap(overrides = {}) {
  return {
    teamId: 'team-reaper',
    spec: {
      version: 1,
      stack: { language: 'rust', manifest: 'Cargo.toml' },
      structure: {
        required: [
          { kind: 'module', name: 'win::procs', evidence: 'src/win/procs.rs' },
          { kind: 'module', name: 'sampler', evidence: 'src/sampler.rs' },
          { kind: 'module', name: 'killer', evidence: 'src/killer.rs' },
        ],
      },
      provenance: { reviewed: true, extracted_by: 'x', source_docs: ['docs/foundry/tech-spec.md'] },
    },
    // map: declared entry name → does its evidence path exist on disk?
    structurePresence: { 'win::procs': true, sampler: false, killer: false },
    tasks: [],
    taskEvents: [],
    ...overrides,
  };
}

test('no spec / no structure section → no findings', () => {
  assert.deepEqual(checkStructuralDeclaredAbsent({ snapshot: { teamId: 't', spec: null } }), []);
  assert.deepEqual(checkStructuralDeclaredAbsent({
    snapshot: { teamId: 't', spec: { version: 1 } },
  }), []);
});

test('NO task carries a `delivers` field → ONE info meta-finding (not enforced), not N low spam', () => {
  // Reaper today: 7 declared modules, tasks have no delivers field.
  // Must NOT emit a finding per absent module — that's wolf-crying.
  const out = checkStructuralDeclaredAbsent({
    snapshot: snap({
      tasks: [
        { taskId: 'T-001', status: 'in_progress' },
        { taskId: 'T-002', status: 'pending' },
      ],
    }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'risk');
  assert.equal(out[0].severity, 'info');
  assert.match(out[0].title, /not enforced/i);
  assert.match(out[0].actual, /delivers/);
});

test('declared module present in source → no finding for it', () => {
  const out = checkStructuralDeclaredAbsent({
    snapshot: snap({
      structurePresence: { 'win::procs': true, sampler: true, killer: true },
      tasks: [{ taskId: 'T-1', status: 'completed', delivers: ['module:win::procs', 'module:sampler', 'module:killer'] }],
    }),
  });
  assert.deepEqual(out, []);
});

test('declared, absent, NO task delivers it → low', () => {
  const out = checkStructuralDeclaredAbsent({
    snapshot: snap({
      structurePresence: { 'win::procs': true, sampler: false, killer: true },
      // delivers field IS adopted (T-1 has it) but nothing delivers `sampler`
      tasks: [{ taskId: 'T-1', status: 'completed', delivers: ['module:win::procs'] }],
    }),
  });
  // win::procs present → ok. killer present → ok. sampler absent + no
  // delivering task → low.
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'low');
  assert.equal(out[0].category, 'architecture');
  assert.match(out[0].title, /sampler/);
  assert.match(out[0].actual, /no task/i);
});

test('declared, absent, delivering task pending/in_progress → NO finding (in-flight work)', () => {
  const out = checkStructuralDeclaredAbsent({
    snapshot: snap({
      structurePresence: { 'win::procs': true, sampler: false, killer: false },
      tasks: [
        { taskId: 'T-2', status: 'in_progress', delivers: ['module:sampler'] },
        { taskId: 'T-3', status: 'pending', delivers: ['module:killer'] },
      ],
    }),
  });
  assert.deepEqual(out, [], 'modules whose delivery task is still in-flight are not drift');
});

test('declared, absent, delivering task done (no merge evidence) → high', () => {
  const out = checkStructuralDeclaredAbsent({
    snapshot: snap({
      structurePresence: { 'win::procs': true, sampler: false, killer: true },
      tasks: [{ taskId: 'T-2', status: 'done', delivers: ['module:sampler'] }],
    }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'high');
  assert.equal(out[0].category, 'architecture');
  assert.match(out[0].title, /sampler/);
  assert.match(out[0].actual, /T-2/);
  assert.match(out[0].actual, /done/i);
});

test('"completed" status is treated the same as "done" (real TASK_STATUS value)', () => {
  const out = checkStructuralDeclaredAbsent({
    snapshot: snap({
      structurePresence: { 'win::procs': true, sampler: false, killer: true },
      tasks: [{ taskId: 'T-2', status: 'completed', delivers: ['module:sampler'] }],
    }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'high');
});

test('declared, absent, delivering task merged (task.integration set) → critical', () => {
  const out = checkStructuralDeclaredAbsent({
    snapshot: snap({
      structurePresence: { 'win::procs': true, sampler: false, killer: true },
      tasks: [{ taskId: 'T-2', status: 'done', delivers: ['module:sampler'], integration: { mergeCommit: 'abc123' } }],
    }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'critical');
  assert.match(out[0].actual, /merged/i);
});

test('declared, absent, delivering task merged via integration_merged event → critical', () => {
  const out = checkStructuralDeclaredAbsent({
    snapshot: snap({
      structurePresence: { 'win::procs': true, sampler: false, killer: true },
      tasks: [{ taskId: 'T-2', status: 'done', delivers: ['module:sampler'] }],
      taskEvents: [{ eventType: 'task.integration_merged', taskId: 'T-2' }],
    }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'critical');
});

test('unreviewed spec clamps every severity to info (ruling #4) and tags specReviewed:false', () => {
  const s = snap({
    structurePresence: { 'win::procs': true, sampler: false, killer: false },
    tasks: [
      { taskId: 'T-2', status: 'done', delivers: ['module:sampler'] },        // would be high
      { taskId: 'T-3', status: 'completed', delivers: ['module:killer'], integration: { x: 1 } }, // would be critical
    ],
  });
  s.spec.provenance.reviewed = false;
  const out = checkStructuralDeclaredAbsent({ snapshot: s });
  assert.equal(out.length, 2);
  for (const f of out) {
    assert.equal(f.severity, 'info');
    assert.equal(f.specReviewed, false);
  }
});

test('endpoint-kind entries are not presence-checked in v1 (route enumeration is later) — emits one info note when ONLY endpoints declared', () => {
  const out = checkStructuralDeclaredAbsent({
    snapshot: {
      teamId: 't',
      spec: {
        version: 1,
        structure: { required: [{ kind: 'endpoint', method: 'GET', path: '/api/health' }] },
        provenance: { reviewed: true },
      },
      structurePresence: {},
      tasks: [{ taskId: 'T-1', status: 'completed', delivers: ['endpoint:GET /api/health'] }],
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'risk');
  assert.equal(out[0].severity, 'info');
  assert.match(out[0].title, /endpoint/i);
});

test('stable ids + required DriftFinding fields + checkName', () => {
  const s = snap({
    structurePresence: { 'win::procs': true, sampler: false, killer: true },
    tasks: [{ taskId: 'T-2', status: 'done', delivers: ['module:sampler'] }],
  });
  const a = checkStructuralDeclaredAbsent({ snapshot: s })[0];
  const b = checkStructuralDeclaredAbsent({ snapshot: s })[0];
  assert.equal(a.id, b.id);
  assert.equal(a.checkName, 'check_structural_declared_absent');
  assert.equal(a.teamId, 'team-reaper');
  for (const k of ['id', 'category', 'severity', 'title', 'expected', 'actual', 'recommendedCorrection']) {
    assert.ok(typeof a[k] === 'string' && a[k].length > 0, `missing ${k}`);
  }
  assert.ok(Array.isArray(a.evidence));
  assert.equal(a.autoFixable, false);
});
