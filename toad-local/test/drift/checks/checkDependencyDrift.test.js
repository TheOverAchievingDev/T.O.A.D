import test from 'node:test';
import assert from 'node:assert/strict';
import { checkDependencyDrift } from '../../../src/drift/checks/checkDependencyDrift.js';

// checkDependencyDrift is a PURE function over the snapshot — buildSnapshot
// pre-loads spec + manifest deps and attaches them, matching the
// existing check pattern (e.g. checkDoneWithoutMergeEvidence). These
// tests build snapshots as plain objects, no fs.

function snap(overrides = {}) {
  return {
    teamId: 'team-reaper',
    spec: null,
    specError: null,
    manifestDeps: null,
    manifestError: null,
    ...overrides,
  };
}

const REVIEWED_SPEC = {
  version: 1,
  stack: { language: 'rust', manifest: 'Cargo.toml' },
  dependencies: {
    authorized: ['serde', 'toml', 'eframe', 'windows'],
    forbidden: ['reqwest', 'tokio'],
  },
  provenance: { reviewed: true, extracted_by: 'foundry_extract_spec@v1', source_docs: ['docs/foundry/tech-spec.md'] },
};

test('no spec present and no error → no findings (absence is not this check\'s concern)', () => {
  const out = checkDependencyDrift({ snapshot: snap() });
  assert.deepEqual(out, []);
});

test('spec.json present but unparseable → one info-level risk meta-finding', () => {
  const out = checkDependencyDrift({
    snapshot: snap({ specError: 'spec.json parse error: Unexpected token' }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'risk');
  assert.equal(out[0].severity, 'info');
  assert.match(out[0].title, /spec\.json/i);
});

test('spec has no dependencies section → no findings (spec declares no dep constraints)', () => {
  const out = checkDependencyDrift({
    snapshot: snap({ spec: { version: 1, stack: {}, provenance: { reviewed: true } } }),
  });
  assert.deepEqual(out, []);
});

test('manifest unsupported/unreadable → one info-level meta-finding (honest "not enforced")', () => {
  const out = checkDependencyDrift({
    snapshot: snap({
      spec: REVIEWED_SPEC,
      manifestError: 'parseManifestDeps: language "haskell" unsupported in v1',
    }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'risk');
  assert.equal(out[0].severity, 'info');
  assert.match(out[0].actual, /not.*enforced|unsupported/i);
});

test('all manifest deps authorized → no findings', () => {
  const out = checkDependencyDrift({
    snapshot: snap({
      spec: REVIEWED_SPEC,
      manifestDeps: ['serde', 'toml', 'eframe'],
    }),
  });
  assert.deepEqual(out, []);
});

test('unauthorized dependency → one architecture finding (reviewed spec → real severity)', () => {
  const out = checkDependencyDrift({
    snapshot: snap({
      spec: REVIEWED_SPEC,
      manifestDeps: ['serde', 'clap'], // clap not in authorized
    }),
  });
  assert.equal(out.length, 1);
  const f = out[0];
  assert.equal(f.category, 'architecture');
  assert.equal(f.severity, 'medium'); // reviewed spec, unauthorized = medium
  assert.match(f.title, /clap/);
  assert.match(f.actual, /clap/);
  assert.equal(f.specReviewed, true);
  assert.equal(f.specProvenance.extractedBy, 'foundry_extract_spec@v1');
  assert.equal(f.specProvenance.sourceDoc, 'docs/foundry/tech-spec.md');
});

test('forbidden dependency present → CRITICAL finding even if also unlisted', () => {
  const out = checkDependencyDrift({
    snapshot: snap({
      spec: REVIEWED_SPEC,
      manifestDeps: ['serde', 'reqwest'], // reqwest is forbidden
    }),
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].category, 'architecture');
  assert.equal(out[0].severity, 'critical');
  assert.match(out[0].title, /forbidden/i);
  assert.match(out[0].title, /reqwest/);
});

test('unreviewed spec clamps ALL severities to info (ruling #4)', () => {
  const unreviewed = { ...REVIEWED_SPEC, provenance: { reviewed: false, extracted_by: 'foundry_extract_spec@v1', source_docs: ['docs/foundry/tech-spec.md'] } };
  const out = checkDependencyDrift({
    snapshot: snap({
      spec: unreviewed,
      manifestDeps: ['serde', 'reqwest', 'clap'], // 1 forbidden + 1 unauthorized
    }),
  });
  assert.equal(out.length, 2);
  for (const f of out) {
    assert.equal(f.severity, 'info', `unreviewed spec must clamp ${f.title} to info`);
    assert.equal(f.specReviewed, false);
  }
});

test('empty authorized list → only forbidden is enforced (no "everything unauthorized" spam)', () => {
  const spec = {
    version: 1,
    stack: { language: 'rust', manifest: 'Cargo.toml' },
    dependencies: { authorized: [], forbidden: ['tokio'] },
    provenance: { reviewed: true },
  };
  const out = checkDependencyDrift({
    snapshot: snap({ spec, manifestDeps: ['serde', 'toml', 'tokio', 'anything'] }),
  });
  // Only `tokio` (forbidden) is flagged; serde/toml/anything are NOT
  // flagged as unauthorized because authorized:[] means "not enumerated".
  assert.equal(out.length, 1);
  assert.match(out[0].title, /forbidden/i);
  assert.match(out[0].title, /tokio/);
});

test('stable finding ids — same drift on two runs produces the same id', () => {
  const s = snap({ spec: REVIEWED_SPEC, manifestDeps: ['serde', 'clap'] });
  const a = checkDependencyDrift({ snapshot: s })[0];
  const b = checkDependencyDrift({ snapshot: s })[0];
  assert.equal(a.id, b.id);
  assert.ok(a.id.length > 0);
});

test('every finding carries checkName + teamId + the required DriftFinding fields', () => {
  const out = checkDependencyDrift({
    snapshot: snap({ spec: REVIEWED_SPEC, manifestDeps: ['clap'] }),
  });
  const f = out[0];
  assert.equal(f.checkName, 'check_dependency_drift');
  assert.equal(f.teamId, 'team-reaper');
  for (const field of ['id', 'category', 'severity', 'title', 'expected', 'actual', 'recommendedCorrection']) {
    assert.ok(typeof f[field] === 'string' && f[field].length > 0, `missing ${field}`);
  }
  assert.ok(Array.isArray(f.evidence));
  assert.equal(f.autoFixable, false);
});
