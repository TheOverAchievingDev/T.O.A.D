import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLlmSemantic } from '../../../src/drift/checks/checkLlmSemantic.js';

const BASE_SNAPSHOT = {
  teamId: 'team-a',
  asOf: '2026-05-04T10:00:00Z',
  tasks: [
    { teamId: 'team-a', taskId: 'task-1', status: 'in_progress',
      allowedFiles: [], forbiddenFiles: [], testCommands: [],
      acceptanceCriteria: [], subject: 'Test task' },
  ],
  taskEvents: [],
  runtimeEvents: [],
  foundryDocs: { architecture: '# Arch', steering: '# Steering' },
  worktrees: [],
  diffsByTask: {},
  teamConfig: { lead: { providerId: 'anthropic' } },
};

const NO_OVERRIDES = { drift: { tier1ModelOverride: null, tier2ModelOverride: null } };

test('checkLlmSemantic@tier1 calls llmJudge and stamps check_name', async () => {
  let called = null;
  const fakeJudge = async (args) => {
    called = args;
    return {
      findings: [
        { category: 'architecture', severity: 'medium', title: 'T',
          expected: 'e', actual: 'a', evidence: ['ev'],
          recommendedCorrection: 'r', taskId: 'task-1' },
      ],
    };
  };
  const findings = await checkLlmSemantic({
    snapshot: BASE_SNAPSHOT, settings: NO_OVERRIDES,
    tier: 1, llmJudgeImpl: fakeJudge,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].checkName, 'check_llm_semantic_t1');
  assert.equal(findings[0].teamId, 'team-a');
  assert.equal(findings[0].runId, '');
  assert.equal(called.cli, 'claude');
  assert.equal(called.model, 'haiku-4.5');
});

test('checkLlmSemantic@tier2 uses tier-2 model + includes tier-1 findings in payload', async () => {
  let called = null;
  const fakeJudge = async (args) => {
    called = args;
    return { findings: [] };
  };
  const tier1Findings = [
    { id: 'f_1', checkName: 'check_invalid_transitions',
      category: 'architecture', severity: 'high', title: 'X',
      expected: 'e', actual: 'a', evidence: ['ev'],
      recommendedCorrection: 'r', taskId: 'task-1' },
  ];
  await checkLlmSemantic({
    snapshot: BASE_SNAPSHOT, settings: NO_OVERRIDES,
    tier: 2, llmJudgeImpl: fakeJudge, tier1Findings,
  });
  assert.equal(called.model, 'opus-4.7');
  // The user payload must include the tier-1 findings.
  assert.match(called.userPayload, /Tier-1 findings/i);
  assert.match(called.userPayload, /check_invalid_transitions/);
});

test('checkLlmSemantic returns meta-finding on judge failure', async () => {
  const failingJudge = async () => { throw new Error('boom'); };
  const findings = await checkLlmSemantic({
    snapshot: BASE_SNAPSHOT, settings: NO_OVERRIDES,
    tier: 1, llmJudgeImpl: failingJudge,
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, 'risk');
  assert.equal(findings[0].severity, 'medium');
  assert.match(findings[0].title, /failed/i);
  assert.equal(findings[0].checkName, 'check_llm_semantic_t1');
});

test('checkLlmSemantic@tier1 caps severity at high (drops critical)', async () => {
  const fakeJudge = async () => ({
    findings: [
      { category: 'risk', severity: 'critical', title: 'T1 critical?',
        expected: 'e', actual: 'a', evidence: ['ev'],
        recommendedCorrection: 'r' },
    ],
  });
  const findings = await checkLlmSemantic({
    snapshot: BASE_SNAPSHOT, settings: NO_OVERRIDES,
    tier: 1, llmJudgeImpl: fakeJudge,
  });
  assert.equal(findings[0].severity, 'high', 'tier 1 caps at high');
});
