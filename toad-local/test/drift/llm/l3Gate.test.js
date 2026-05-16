import test from 'node:test';
import assert from 'node:assert/strict';
import {
  l3Gate, l3CacheKey, diffHash, specProvenanceHash, l1FindingSetHash,
  l3PromptHash, silentButSignificant,
} from '../../../src/drift/llm/l3Gate.js';

const BASE = {
  trigger: 'task_event', boundaryTo: 'review', boundaryTaskId: 'T-1',
  l1FindingsForTask: [{ checkName: 'check_constitution', severity: 'medium', file: 'a', line: 1, ruleId: 'r', needsSemanticReview: true }],
  cacheHasKey: false,
};

test('periodic → skip(reason periodic), regardless of ambiguity', () => {
  assert.deepEqual(l3Gate({ ...BASE, trigger: 'periodic' }), { action: 'skip', reason: 'periodic' });
});
test('task_event with non-submission status → skip', () => {
  assert.deepEqual(l3Gate({ ...BASE, boundaryTo: 'testing' }), { action: 'skip', reason: 'non_submission_status' });
});
test('submission status + flagged finding + no cache → invoke', () => {
  assert.deepEqual(l3Gate(BASE), { action: 'invoke', reason: 'ambiguous' });
});
test('submission status but NO ambiguity → skip even though boundary fired', () => {
  assert.deepEqual(
    l3Gate({ ...BASE, l1FindingsForTask: [{ checkName: 'x', severity: 'low', file: 'a', line: 1, ruleId: null }] }),
    { action: 'skip', reason: 'not_ambiguous' },
  );
});
test('manual + ambiguity + cache HIT → invoke (manual bypasses cache)', () => {
  assert.deepEqual(l3Gate({ ...BASE, trigger: 'manual', cacheHasKey: true }), { action: 'invoke', reason: 'manual_bypass' });
});
test('manual + NO ambiguity → skip (manual honors ambiguity gate)', () => {
  assert.deepEqual(
    l3Gate({ ...BASE, trigger: 'manual', l1FindingsForTask: [] }),
    { action: 'skip', reason: 'not_ambiguous' },
  );
});
test('task_event + ambiguity + cache HIT → serve_cached', () => {
  assert.deepEqual(l3Gate({ ...BASE, cacheHasKey: true }), { action: 'serve_cached', reason: 'cache_hit' });
});
test('silentButSignificant: malformed/empty input → false (conservative)', () => {
  assert.equal(silentButSignificant({}), false);
  assert.equal(silentButSignificant({ snapshot: null, boundaryTaskId: 'x' }), false);
});
test('ambiguity also true when an L1 finding is needsSemanticReview even with cache miss', () => {
  assert.equal(l3Gate(BASE).action, 'invoke');
});

test('diffHash: stable to whitespace/format churn, changes on real content change', () => {
  const a = diffHash([{ file: 'x.rs', content: 'fn a(){}\n' }]);
  const b = diffHash([{ file: 'x.rs', content: 'fn a(){}   \n' }]);
  const c = diffHash([{ file: 'x.rs', content: 'fn b(){}\n' }]);
  assert.equal(a, b, 'whitespace churn must not change the hash');
  assert.notEqual(a, c, 'real content change MUST change the hash');
});
test('l1FindingSetHash: order-independent, changes on set add/remove', () => {
  const f1 = { checkName: 'c', severity: 's', file: 'f', line: 1, ruleId: 'r', needsSemanticReview: true };
  const f2 = { checkName: 'd', severity: 's', file: 'g', line: 2, ruleId: 'q', needsSemanticReview: true };
  assert.equal(l1FindingSetHash([f1, f2]), l1FindingSetHash([f2, f1]), 'order must not matter');
  assert.notEqual(l1FindingSetHash([f1, f2]), l1FindingSetHash([f1]), 'removing one MUST change it');
  assert.notEqual(l1FindingSetHash([f1]), l1FindingSetHash([{ ...f1, severity: 'X' }]), 'a field change MUST change it');
});
test('specProvenanceHash: flips on reviewed AND on any other provenance field', () => {
  const base = { version: 1, provenance: { reviewed: false, extracted_at: 'a', extracted_by: 'b' } };
  const rev = { version: 1, provenance: { reviewed: true, extracted_at: 'a', extracted_by: 'b' } };
  const ver = { version: 2, provenance: { reviewed: false, extracted_at: 'a', extracted_by: 'b' } };
  const by = { version: 1, provenance: { reviewed: false, extracted_at: 'a', extracted_by: 'Z' } };
  assert.notEqual(specProvenanceHash(base), specProvenanceHash(rev));
  assert.notEqual(specProvenanceHash(base), specProvenanceHash(ver));
  assert.notEqual(specProvenanceHash(base), specProvenanceHash(by));
});
test('l3CacheKey composes all four components deterministically', () => {
  const args = {
    diffFiles: [{ file: 'x', content: 'y' }],
    spec: { version: 1, provenance: { reviewed: true } },
    l1Findings: [{ checkName: 'c', severity: 's', file: 'f', line: 1, ruleId: 'r', needsSemanticReview: true }],
    promptTemplate: 'PROMPT',
  };
  const k1 = l3CacheKey(args);
  const k2 = l3CacheKey(args);
  assert.equal(k1, k2);
  assert.notEqual(k1, l3CacheKey({ ...args, promptTemplate: 'PROMPT2' }), 'prompt edit invalidates');
});

test('merge_ready and done are also submission statuses (invoke when ambiguous)', () => {
  assert.deepEqual(l3Gate({ ...BASE, boundaryTo: 'merge_ready' }), { action: 'invoke', reason: 'ambiguous' });
  assert.deepEqual(l3Gate({ ...BASE, boundaryTo: 'done' }), { action: 'invoke', reason: 'ambiguous' });
});

test('diffHash: CRLF and LF content produce identical hashes', () => {
  const lf   = diffHash([{ file: 'x.rs', content: 'fn a() {\n  return 1;\n}' }]);
  const crlf = diffHash([{ file: 'x.rs', content: 'fn a() {\r\n  return 1;\r\n}' }]);
  assert.equal(lf, crlf, 'CRLF must not bust the cache vs LF');
});

test('diffHash: leading-whitespace-only changes collapse to same hash (documented tradeoff — whitespace-significant languages)', () => {
  const indented = diffHash([{ file: 'x.py', content: '    return x\n' }]);
  const flat     = diffHash([{ file: 'x.py', content: 'return x\n' }]);
  assert.equal(indented, flat, 'indentation-only change is cache-stable by design — see norm() comment + design §3.3');
});

import { isSubmissionStatus, l3CheapEligible, SUBMISSION } from '../../../src/drift/llm/l3Gate.js';

test('SUBMISSION is exactly {review, merge_ready, done}', () => {
  assert.deepEqual([...SUBMISSION].sort(), ['done', 'merge_ready', 'review']);
  assert.equal(isSubmissionStatus('review'), true);
  assert.equal(isSubmissionStatus('testing'), false);
  assert.equal(isSubmissionStatus(null), false);
});
test('l3CheapEligible: periodic never; manual needs only a boundary task; task_event needs submission status', () => {
  assert.equal(l3CheapEligible({ trigger: 'periodic', boundaryTo: 'review', boundaryTaskId: 'T' }), false);
  assert.equal(l3CheapEligible({ trigger: 'manual', boundaryTo: null, boundaryTaskId: 'T' }), true);
  assert.equal(l3CheapEligible({ trigger: 'manual', boundaryTo: null, boundaryTaskId: '' }), false);
  assert.equal(l3CheapEligible({ trigger: 'task_event', boundaryTo: 'testing', boundaryTaskId: 'T' }), false);
  assert.equal(l3CheapEligible({ trigger: 'task_event', boundaryTo: 'done', boundaryTaskId: 'T' }), true);
});

test('l3CacheKey folds l1SignalKind: flagged vs silent_significant never collide', () => {
  const base = {
    diffFiles: [{ file: 'x', content: 'y' }],
    spec: { version: 1, provenance: { reviewed: true } },
    l1Findings: [], promptTemplate: 'P',
  };
  const flagged = l3CacheKey({ ...base, l1SignalKind: 'flagged' });
  const silent = l3CacheKey({ ...base, l1SignalKind: 'silent_significant' });
  assert.notEqual(flagged, silent, 'kind must partition the cache');
  assert.equal(flagged, l3CacheKey({ ...base, l1SignalKind: 'flagged' }), 'deterministic');
  // Back-compat default: absent kind hashes as 'flagged'.
  assert.equal(l3CacheKey(base), flagged, 'absent l1SignalKind defaults to flagged');
});
