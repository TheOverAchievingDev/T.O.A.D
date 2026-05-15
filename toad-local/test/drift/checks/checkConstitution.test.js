import test from 'node:test';
import assert from 'node:assert/strict';
import { checkConstitution } from '../../../src/drift/checks/checkConstitution.js';

// L1.3 — pure fn over snapshot.constitutionHits (buildSnapshot runs the
// bounded whole-tree scan via scanConstitution). Shapes hits into
// findings at each RULE's declared severity, carries the rule's mode
// (observe|gate) so a future broker-seam gate path can act, clamps to
// info when the spec is unreviewed (ruling #4), and emits honest
// info-meta for unsupported detector types / scanner errors.

function snap(overrides = {}) {
  return {
    teamId: 'team-reaper',
    spec: {
      version: 1,
      constitution: {
        rules: [
          { id: 'no-sedebug', description: 'Never request SeDebugPrivilege', severity: 'critical', mode: 'gate', source: 'steering.md' },
          { id: 'no-anyhow', description: 'anyhow::Error only in main', severity: 'medium', mode: 'observe', source: 'steering.md' },
        ],
      },
      provenance: { reviewed: true, extracted_by: 'x', source_docs: ['docs/foundry/steering.md'] },
    },
    constitutionHits: [],
    constitutionUnsupported: [],
    constitutionError: null,
    ...overrides,
  };
}

test('no spec / no constitution → no findings', () => {
  assert.deepEqual(checkConstitution({ snapshot: { teamId: 't', spec: null } }), []);
  assert.deepEqual(checkConstitution({ snapshot: { teamId: 't', spec: { version: 1 } } }), []);
});

test('rules declared but zero hits → no findings (clean)', () => {
  assert.deepEqual(checkConstitution({ snapshot: snap() }), []);
});

test('a hit → finding at the RULE\'s severity, carrying its mode', () => {
  const out = checkConstitution({
    snapshot: snap({
      constitutionHits: [{ ruleId: 'no-sedebug', file: 'src/win/procs.rs', line: 12, snippet: 'enable(SeDebugPrivilege);' }],
    }),
  });
  assert.equal(out.length, 1);
  const f = out[0];
  assert.equal(f.category, 'risk');
  assert.equal(f.severity, 'critical');        // from the rule, not hardcoded
  assert.equal(f.checkName, 'check_constitution');
  assert.equal(f.constitutionMode, 'gate');     // carried for the broker-seam gate path
  assert.match(f.title, /no-sedebug|SeDebugPrivilege/i);
  assert.match(f.actual, /src\/win\/procs\.rs:12/);
  assert.match(f.actual, /SeDebugPrivilege/);
  assert.equal(f.specReviewed, true);
  assert.equal(f.specProvenance.sourceDoc, 'docs/foundry/steering.md');
});

test('multiple hits across rules → one finding each, correct per-rule severity', () => {
  const out = checkConstitution({
    snapshot: snap({
      constitutionHits: [
        { ruleId: 'no-sedebug', file: 'a.rs', line: 1, snippet: 'SeDebugPrivilege' },
        { ruleId: 'no-anyhow', file: 'b.rs', line: 2, snippet: 'use anyhow::Error;' },
      ],
    }),
  });
  assert.equal(out.length, 2);
  const bySev = Object.fromEntries(out.map((f) => [f.severity, f]));
  assert.ok(bySev.critical);
  assert.ok(bySev.medium);
});

test('hit referencing an unknown ruleId is ignored (defensive — scanner/spec mismatch)', () => {
  const out = checkConstitution({
    snapshot: snap({ constitutionHits: [{ ruleId: 'ghost', file: 'x.rs', line: 1, snippet: 'x' }] }),
  });
  assert.deepEqual(out, []);
});

test('unreviewed spec clamps every severity to info + tags specReviewed:false (ruling #4)', () => {
  const s = snap({
    constitutionHits: [{ ruleId: 'no-sedebug', file: 'a.rs', line: 1, snippet: 'SeDebugPrivilege' }],
  });
  s.spec.provenance.reviewed = false;
  const out = checkConstitution({ snapshot: s });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'info');
  assert.equal(out[0].specReviewed, false);
  // mode is still carried even when severity is clamped — gating
  // policy is independent of review state.
  assert.equal(out[0].constitutionMode, 'gate');
});

test('unsupported detector rules → ONE aggregate info meta (honest not-enforced)', () => {
  const out = checkConstitution({
    snapshot: snap({ constitutionUnsupported: ['ast-rule-1', 'ast-rule-2'] }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'risk');
  assert.equal(out[0].severity, 'info');
  assert.match(out[0].actual, /ast-rule-1/);
  assert.match(out[0].actual, /ast-rule-2/);
  assert.match(out[0].title, /not enforced/i);
});

test('unsupported meta + real hits coexist (one meta + one finding per hit)', () => {
  const out = checkConstitution({
    snapshot: snap({
      constitutionHits: [{ ruleId: 'no-sedebug', file: 'a.rs', line: 1, snippet: 'SeDebugPrivilege' }],
      constitutionUnsupported: ['ast-rule-1'],
    }),
  });
  assert.equal(out.length, 2);
  assert.ok(out.some((f) => f.severity === 'critical'));
  assert.ok(out.some((f) => f.severity === 'info' && /not enforced/i.test(f.title)));
});

test('scanner error → one info meta, does not crash', () => {
  const out = checkConstitution({
    snapshot: snap({ constitutionError: 'walk failed: EACCES' }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].severity, 'info');
  assert.match(out[0].actual, /EACCES|walk failed/);
});

test('stable ids + required DriftFinding fields', () => {
  const s = snap({ constitutionHits: [{ ruleId: 'no-sedebug', file: 'a.rs', line: 9, snippet: 'SeDebugPrivilege' }] });
  const a = checkConstitution({ snapshot: s })[0];
  const b = checkConstitution({ snapshot: s })[0];
  assert.equal(a.id, b.id);
  assert.equal(a.teamId, 'team-reaper');
  for (const k of ['id', 'category', 'severity', 'title', 'expected', 'actual', 'recommendedCorrection']) {
    assert.ok(typeof a[k] === 'string' && a[k].length > 0, `missing ${k}`);
  }
  assert.ok(Array.isArray(a.evidence));
  assert.equal(a.autoFixable, false);
});
