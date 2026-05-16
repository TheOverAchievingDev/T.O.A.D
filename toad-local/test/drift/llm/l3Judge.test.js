import test from 'node:test';
import assert from 'node:assert/strict';
import { l3Judge } from '../../../src/drift/llm/l3Judge.js';

function fakeJudge(scripted) {
  const calls = [];
  const fn = async ({ model }) => {
    calls.push(model);
    const r = scripted[calls.length - 1];
    if (r instanceof Error) throw r;
    return r;
  };
  fn.calls = calls;
  return fn;
}
const PROVIDER = { cli: 'claude', tier1: 'haiku', tier2: 'sonnet' };

test('Haiku high-confidence → no escalation, tier=haiku', async () => {
  const judge = fakeJudge([{ findings: [{ category: 'risk', severity: 'high', title: 't', expected: 'e', actual: 'a', recommendedCorrection: 'c', evidence: [] }], rawText: '{}' }]);
  const r = await l3Judge({ packet: 'P', provider: PROVIDER, confidenceOf: () => 'high', llmJudgeImpl: judge });
  assert.equal(judge.calls.length, 1);
  assert.deepEqual(judge.calls, ['haiku']);
  assert.equal(r.tier, 'haiku');
  assert.equal(r.findings.length, 1);
});

test('Haiku low-confidence → exactly ONE Sonnet re-run of the SAME packet, tier=sonnet-escalated', async () => {
  const judge = fakeJudge([
    { findings: [], rawText: '{}' },
    { findings: [{ category: 'risk', severity: 'critical', title: 't', expected: 'e', actual: 'a', recommendedCorrection: 'c', evidence: [] }], rawText: '{}' },
  ]);
  const r = await l3Judge({ packet: 'P', provider: PROVIDER, confidenceOf: (i) => (i === 0 ? 'low' : 'high'), llmJudgeImpl: judge });
  assert.deepEqual(judge.calls, ['haiku', 'sonnet']);
  assert.equal(r.tier, 'sonnet-escalated');
  assert.equal(r.findings[0].severity, 'critical', 'sonnet MAY emit critical');
});

test('Sonnet ALSO low-confidence → cached low, NO further escalation (one max), no loop', async () => {
  const judge = fakeJudge([
    { findings: [], rawText: '{}' },
    { findings: [{ category: 'risk', severity: 'high', title: 't', expected: 'e', actual: 'a', recommendedCorrection: 'c', evidence: [] }], rawText: '{}' },
  ]);
  const r = await l3Judge({ packet: 'P', provider: PROVIDER, confidenceOf: () => 'low', llmJudgeImpl: judge });
  assert.equal(judge.calls.length, 2, 'exactly one escalation, never a loop');
  assert.equal(r.tier, 'sonnet-escalated');
  assert.equal(r.confidence, 'low', 'low confidence carried through');
});

test('Haiku-only critical is capped to high (invariant INTRODUCED here)', async () => {
  const judge = fakeJudge([{ findings: [{ category: 'risk', severity: 'critical', title: 't', expected: 'e', actual: 'a', recommendedCorrection: 'c', evidence: [] }], rawText: '{}' }]);
  const r = await l3Judge({ packet: 'P', provider: PROVIDER, confidenceOf: () => 'high', llmJudgeImpl: judge });
  assert.equal(judge.calls.length, 1);
  assert.equal(r.findings[0].severity, 'high', 'a Haiku-tier finding may not be critical');
});

test('judge spawn failure → throws (engine turns it into a meta, not cached)', async () => {
  const judge = fakeJudge([new Error('spawn_failed: exit 1')]);
  await assert.rejects(
    () => l3Judge({ packet: 'P', provider: PROVIDER, confidenceOf: () => 'high', llmJudgeImpl: judge }),
    /spawn_failed/,
  );
});
