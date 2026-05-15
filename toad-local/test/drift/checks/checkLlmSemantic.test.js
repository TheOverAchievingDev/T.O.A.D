import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLlmSemantic, buildUserPayload } from '../../../src/drift/checks/checkLlmSemantic.js';
import { buildTier1SystemPrompt } from '../../../src/drift/llm/prompts/tier1.js';
import { buildTier2SystemPrompt } from '../../../src/drift/llm/prompts/tier2.js';

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
  assert.equal(called.model, 'haiku');
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
  assert.equal(called.model, 'opus');
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

test('semantic check prompt includes Foundry docs section when snapshot uses foundry_docs mode', () => {
  const snapshot = {
    teamId: 't', asOf: '2026-05-10', tasks: [], taskEvents: [], runtimeEvents: [],
    foundryDocs: { architecture: 'this is the architecture doc' },
    currentStateContext: null,
    worktrees: [], diffsByTask: {}, teamConfig: null,
  };
  const prompt = buildUserPayload(snapshot, null);
  assert.match(prompt, /## Foundry docs/);
  assert.match(prompt, /architecture/);
  assert.doesNotMatch(prompt, /## Current codebase context/);
});

test('semantic check prompt includes Current codebase context when snapshot uses current_state mode', () => {
  const snapshot = {
    teamId: 't', asOf: '2026-05-10', tasks: [], taskEvents: [], runtimeEvents: [],
    foundryDocs: {},
    currentStateContext: {
      recentCommits: ['abc1 first commit (2026)', 'def2 second (2026)'],
      projectDocs: { 'README.md': 'This is the README.' },
    },
    worktrees: [], diffsByTask: {}, teamConfig: null,
  };
  const prompt = buildUserPayload(snapshot, null);
  assert.match(prompt, /## Current codebase context/);
  assert.match(prompt, /abc1 first commit/);
  assert.match(prompt, /This is the README/);
  assert.doesNotMatch(prompt, /## Foundry docs/);
});

test('semantic check prompt with empty currentStateContext omits subsections gracefully', () => {
  const snapshot = {
    teamId: 't', asOf: '2026-05-10', tasks: [], taskEvents: [], runtimeEvents: [],
    foundryDocs: {},
    currentStateContext: { recentCommits: [], projectDocs: {} },
    worktrees: [], diffsByTask: {}, teamConfig: null,
  };
  // Should not throw. Header may still be present without subsections.
  const prompt = buildUserPayload(snapshot, null);
  assert.ok(typeof prompt === 'string');
  assert.match(prompt, /## Current codebase context/);
  assert.doesNotMatch(prompt, /## Foundry docs/);
  assert.doesNotMatch(prompt, /### Recent commits/);
  assert.doesNotMatch(prompt, /### Project documentation/);
});

test('buildTier1SystemPrompt frames against Foundry docs when snapshot has no currentStateContext', () => {
  const snapshot = { currentStateContext: null, foundryDocs: { architecture: '# A' } };
  const prompt = buildTier1SystemPrompt(snapshot);
  assert.match(prompt, /Foundry spec docs/);
  assert.match(prompt, /architecture, steering, design decisions, definition of done/);
  assert.doesNotMatch(prompt, /recent commits/);
});

test('buildTier1SystemPrompt frames against current codebase when snapshot has currentStateContext', () => {
  const snapshot = {
    currentStateContext: { recentCommits: [], projectDocs: {} },
    foundryDocs: {},
  };
  const prompt = buildTier1SystemPrompt(snapshot);
  assert.match(prompt, /current state/);
  assert.match(prompt, /recent commits \+ project README\/docs/);
  assert.doesNotMatch(prompt, /Foundry spec docs/);
});

test('buildTier2SystemPrompt frames against Foundry docs when snapshot has no currentStateContext', () => {
  const snapshot = { currentStateContext: null, foundryDocs: { architecture: '# A' } };
  const prompt = buildTier2SystemPrompt(snapshot);
  assert.match(prompt, /Foundry spec docs/);
  assert.doesNotMatch(prompt, /recent commits/);
});

test('buildTier2SystemPrompt frames against current codebase when snapshot has currentStateContext', () => {
  const snapshot = {
    currentStateContext: { recentCommits: [], projectDocs: {} },
    foundryDocs: {},
  };
  const prompt = buildTier2SystemPrompt(snapshot);
  assert.match(prompt, /current state/);
  assert.match(prompt, /recent commits \+ project README\/docs/);
  assert.doesNotMatch(prompt, /Foundry spec docs/);
});

test('checkLlmSemantic@tier1 system prompt adapts to current_state snapshot mode', async () => {
  const currentStateSnapshot = {
    ...BASE_SNAPSHOT,
    foundryDocs: {},
    currentStateContext: { recentCommits: ['abc commit'], projectDocs: { 'README.md': 'readme' } },
  };
  let called = null;
  const fakeJudge = async (args) => { called = args; return { findings: [] }; };
  await checkLlmSemantic({
    snapshot: currentStateSnapshot, settings: NO_OVERRIDES,
    tier: 1, llmJudgeImpl: fakeJudge,
  });
  assert.match(called.systemPrompt, /current state/);
  assert.doesNotMatch(called.systemPrompt, /Foundry spec docs/);
});

test('checkLlmSemantic@tier1 system prompt defaults to Foundry framing on legacy snapshots', async () => {
  let called = null;
  const fakeJudge = async (args) => { called = args; return { findings: [] }; };
  await checkLlmSemantic({
    snapshot: BASE_SNAPSHOT, settings: NO_OVERRIDES,
    tier: 1, llmJudgeImpl: fakeJudge,
  });
  assert.match(called.systemPrompt, /Foundry spec docs/);
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
