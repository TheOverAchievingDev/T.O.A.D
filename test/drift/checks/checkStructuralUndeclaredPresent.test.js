import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStructuralUndeclaredPresent } from '../../../src/drift/checks/checkStructuralUndeclaredPresent.js';

// L1.2b — undeclared-but-present structural drift. The SCOPE question:
// is there source the spec never sanctioned? No roadmap awareness —
// reviewer: "there's never a legitimate state where unsanctioned
// surface area is fine. It's drift the moment it appears." Pure fn
// over the snapshot; buildSnapshot supplies snapshot.sourceModules
// via enumerateSourceModules.

function snap(overrides = {}) {
  return {
    teamId: 'team-reaper',
    spec: {
      version: 1,
      stack: { language: 'rust', manifest: 'Cargo.toml', module_root: 'src/main.rs' },
      structure: {
        required: [
          { kind: 'module', name: 'win::procs', evidence: 'src/win/procs.rs' },
          { kind: 'module', name: 'sampler', evidence: 'src/sampler.rs' },
        ],
      },
      provenance: { reviewed: true, extracted_by: 'x', source_docs: ['docs/foundry/tech-spec.md'] },
    },
    sourceModules: [],
    ...overrides,
  };
}

test('no spec / no structure → no findings (cannot judge scope without a declared set)', () => {
  assert.deepEqual(checkStructuralUndeclaredPresent({ snapshot: { teamId: 't', spec: null } }), []);
});

test('structure declares NO module entries → one info meta (not enumerated, not flag-everything)', () => {
  // Empty declared set means "not enumerated", NOT "nothing sanctioned".
  // Flagging every source file here would be the wolf-cry trap.
  const out = checkStructuralUndeclaredPresent({
    snapshot: {
      teamId: 't',
      spec: { version: 1, structure: { required: [] }, provenance: { reviewed: true } },
      sourceModules: ['src/a.rs', 'src/b.rs'],
    },
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'risk');
  assert.equal(out[0].severity, 'info');
  assert.match(out[0].title, /not enumerated|not enforced/i);
});

test('sourceModules null (unsupported stack) → one info meta (honest not-enforced)', () => {
  const out = checkStructuralUndeclaredPresent({
    snapshot: snap({ sourceModules: null }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'risk');
  assert.equal(out[0].severity, 'info');
  assert.match(out[0].actual, /not enforced|stack/i);
});

test('no source yet (empty sourceModules) → no findings', () => {
  assert.deepEqual(checkStructuralUndeclaredPresent({ snapshot: snap({ sourceModules: [] }) }), []);
});

test('every source module is declared → no findings', () => {
  const out = checkStructuralUndeclaredPresent({
    snapshot: snap({ sourceModules: ['src/win/procs.rs', 'src/sampler.rs'] }),
  });
  assert.deepEqual(out, []);
});

test('a source module the spec never declared → high finding (scope drift)', () => {
  const out = checkStructuralUndeclaredPresent({
    snapshot: snap({ sourceModules: ['src/win/procs.rs', 'src/sneaky_telemetry.rs'] }),
  });
  assert.equal(out.length, 1);
  const f = out[0];
  assert.equal(f.category, 'architecture');
  assert.equal(f.severity, 'high');
  assert.match(f.title, /sneaky_telemetry\.rs/);
  assert.match(f.actual, /not declared|undeclared/i);
  assert.equal(f.specReviewed, true);
  assert.equal(f.specProvenance.sourceDoc, 'docs/foundry/tech-spec.md');
});

test('multiple undeclared modules → one finding each', () => {
  const out = checkStructuralUndeclaredPresent({
    snapshot: snap({ sourceModules: ['src/win/procs.rs', 'src/x.rs', 'src/y.rs'] }),
  });
  assert.equal(out.length, 2);
  const titles = out.map((f) => f.title).join(' ');
  assert.match(titles, /x\.rs/);
  assert.match(titles, /y\.rs/);
});

test('file→directory module promotion is covered (declared src/sampler.rs, built as src/sampler/*)', () => {
  // Team promoted `sampler` from a single file to a module directory.
  // That is NOT undeclared drift — the declared name still anchors it.
  const out = checkStructuralUndeclaredPresent({
    snapshot: snap({
      sourceModules: ['src/win/procs.rs', 'src/sampler/core.rs', 'src/sampler/delta.rs'],
    }),
  });
  assert.deepEqual(out, [], 'submodules under a declared module dir are covered');
});

test('unreviewed spec clamps severity to info + tags specReviewed:false (ruling #4)', () => {
  const s = snap({ sourceModules: ['src/win/procs.rs', 'src/rogue.rs'] });
  s.spec.provenance.reviewed = false;
  const out = checkStructuralUndeclaredPresent({ snapshot: s });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'info');
  assert.equal(out[0].specReviewed, false);
});

test('stable ids + required DriftFinding fields + checkName', () => {
  const s = snap({ sourceModules: ['src/win/procs.rs', 'src/rogue.rs'] });
  const a = checkStructuralUndeclaredPresent({ snapshot: s })[0];
  const b = checkStructuralUndeclaredPresent({ snapshot: s })[0];
  assert.equal(a.id, b.id);
  assert.equal(a.checkName, 'check_structural_undeclared_present');
  assert.equal(a.teamId, 'team-reaper');
  for (const k of ['id', 'category', 'severity', 'title', 'expected', 'actual', 'recommendedCorrection']) {
    assert.ok(typeof a[k] === 'string' && a[k].length > 0, `missing ${k}`);
  }
  assert.ok(Array.isArray(a.evidence));
  assert.equal(a.autoFixable, false);
});

test('undeclared-module finding carries needsSemanticReview:true (L3 adjudicates scope-creep judgment)', () => {
  const snapshot = {
    teamId: 't',
    spec: {
      version: 1,
      provenance: { reviewed: true, extracted_by: 'h', source_docs: ['docs/foundry/tech-spec.md'] },
      structure: { required: [{ kind: 'module', name: 'sampler', evidence: 'src/sampler.rs' }] },
    },
    sourceModules: ['src/sampler.rs', 'src/sneaky_telemetry.rs'],
  };
  const findings = checkStructuralUndeclaredPresent({ snapshot });
  const f = findings.find((x) => x.title.includes('sneaky_telemetry'));
  assert.ok(f, 'expected an undeclared-module finding');
  assert.equal(f.needsSemanticReview, true);
  const metas = findings.filter((x) => x.category === 'risk');
  for (const m of metas) assert.notEqual(m.needsSemanticReview, true);
});
