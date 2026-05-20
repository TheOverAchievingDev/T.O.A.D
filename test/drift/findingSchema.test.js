import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStructuralUndeclaredPresent } from '../../src/drift/checks/checkStructuralUndeclaredPresent.js';

// Locks the finding-shape contract that l3Gate (l1FindingSetHash) and
// the lead's review-packet rendering depend on. A schema drift here
// (renamed field, dropped flag, key-present-on-meta) breaks this
// snapshot — the tripwire to re-review l3Gate's hash + the lead
// prompt (design §6, §3.3, §7).

const REVIEWED = {
  teamId: 't',
  spec: {
    version: 1,
    provenance: { reviewed: true, extracted_by: 'h', source_docs: ['docs/foundry/tech-spec.md'] },
    structure: { required: [{ kind: 'module', name: 'sampler', evidence: 'src/sampler.rs' }] },
  },
  sourceModules: ['src/sampler.rs', 'src/extra.rs'],
};

test('a flagged L1 finding has exactly the expected key set (with needsSemanticReview)', () => {
  const f = checkStructuralUndeclaredPresent({ snapshot: REVIEWED }).find((x) => x.title.includes('extra'));
  assert.ok(f, 'expected an undeclared-module finding for src/extra.rs');
  assert.deepEqual(Object.keys(f).sort(), [
    'actual', 'autoFixable', 'category', 'checkName', 'evidence', 'expected',
    'id', 'needsSemanticReview', 'recommendedCorrection', 'runId', 'severity',
    'specProvenance', 'specReviewed', 'taskId', 'teamId', 'title',
  ].sort());
  assert.equal(f.needsSemanticReview, true);
});

test('a non-flagged meta finding omits needsSemanticReview entirely', () => {
  const metaOnly = checkStructuralUndeclaredPresent({ snapshot: {
    teamId: 't',
    spec: { version: 1, provenance: { reviewed: true, extracted_by: 'h', source_docs: ['d'] }, structure: { required: [] } },
  } });
  assert.equal(metaOnly.length, 1);
  assert.equal(Object.prototype.hasOwnProperty.call(metaOnly[0], 'needsSemanticReview'), false);
});
