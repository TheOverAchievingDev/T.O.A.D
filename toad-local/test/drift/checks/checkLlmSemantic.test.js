import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('checkLlmSemantic writes a brief markdown file, passes its path to the judge, then cleans up', async () => {
  // The "Prompt is too long" CLI failure from 2026-05-15 motivated
  // moving the user payload to a file on disk. The judge gets a short
  // stdin instruction that names the brief path; the CLI's Read tool
  // loads the actual content. Tempdir is cleaned up after the call so
  // /tmp doesn't accumulate cruft on long-running operators.
  let captured = null;
  let observedBriefPathExists = false;
  let observedBriefContent = null;
  const fakeJudge = async (args) => {
    captured = args;
    if (typeof args.briefPath === 'string' && args.briefPath.length > 0) {
      try {
        observedBriefPathExists = fs.existsSync(args.briefPath);
        observedBriefContent = observedBriefPathExists
          ? fs.readFileSync(args.briefPath, 'utf-8')
          : null;
      } catch {
        observedBriefPathExists = false;
      }
    }
    return { findings: [] };
  };

  await checkLlmSemantic({
    snapshot: BASE_SNAPSHOT, settings: NO_OVERRIDES,
    tier: 1, llmJudgeImpl: fakeJudge,
  });

  // Judge was called with a brief path + cwd matching its tempdir.
  assert.ok(captured, 'judge should have been called');
  assert.ok(typeof captured.briefPath === 'string' && captured.briefPath.length > 0,
    'briefPath must be a non-empty string');
  assert.ok(captured.briefPath.endsWith('brief.md'),
    `briefPath should end with brief.md, got ${captured.briefPath}`);
  assert.ok(typeof captured.cwd === 'string' && captured.cwd.length > 0,
    'cwd must be a non-empty string');
  // The brief file existed at the moment the judge was called, and
  // its content was the rendered user payload (contains the team id).
  assert.equal(observedBriefPathExists, true, 'brief file must exist when judge runs');
  assert.match(observedBriefContent, new RegExp(`Team:\\s*${BASE_SNAPSHOT.teamId}`));

  // After the call returned, the tempdir is gone (post-call cleanup).
  assert.equal(fs.existsSync(captured.briefPath), false,
    'brief file should be cleaned up after judge returns');
  assert.equal(fs.existsSync(captured.cwd), false,
    'brief tempdir should be cleaned up after judge returns');
});

test('checkLlmSemantic cleans up the brief tempdir even when the judge throws', async () => {
  // If the judge fails (model rejected, network error, etc.) the
  // finally-block must still tidy. Otherwise we'd leak a tempdir per
  // failed drift run.
  let observedBriefPath = null;
  let observedCwd = null;
  const fakeJudge = async (args) => {
    observedBriefPath = args.briefPath;
    observedCwd = args.cwd;
    throw new Error('simulated judge failure');
  };
  const findings = await checkLlmSemantic({
    snapshot: BASE_SNAPSHOT, settings: NO_OVERRIDES,
    tier: 1, llmJudgeImpl: fakeJudge,
  });
  // Failure path emits a meta-finding (existing behavior).
  assert.equal(findings.length, 1);
  assert.match(findings[0].title, /LLM judge failed/);
  // But the tempdir is still cleaned up.
  assert.equal(fs.existsSync(observedBriefPath), false,
    'brief file must be cleaned up even on judge failure');
  assert.equal(fs.existsSync(observedCwd), false,
    'brief tempdir must be cleaned up even on judge failure');
});

test('checkLlmSemantic trims an oversized payload before writing the brief (size budget)', async () => {
  // A long-running team can accumulate enough runtime events that
  // even the file-based brief becomes huge (50 fat turn_completed
  // frames at 5KB each = 250KB). The judge needs context but not
  // every event ever — we cap the brief at ~80KB so token cost
  // stays bounded.
  // Build a snapshot with absurd numbers of runtime events.
  const bloatedSnapshot = {
    ...BASE_SNAPSHOT,
    runtimeEvents: Array.from({ length: 500 }, (_, i) => ({
      createdAt: `2026-05-15T10:${String(i % 60).padStart(2, '0')}:00Z`,
      eventType: 'turn_completed',
      payload: { raw: { type: 'result', usage: { input_tokens: 5000, output_tokens: 5000 }, junk: 'X'.repeat(2000) } },
    })),
  };
  let observedBriefContent = null;
  const fakeJudge = async (args) => {
    observedBriefContent = fs.readFileSync(args.briefPath, 'utf-8');
    return { findings: [] };
  };
  await checkLlmSemantic({
    snapshot: bloatedSnapshot, settings: NO_OVERRIDES,
    tier: 1, llmJudgeImpl: fakeJudge,
  });
  // Brief should be capped well under the raw 500-event size.
  const briefBytes = Buffer.byteLength(observedBriefContent, 'utf-8');
  assert.ok(briefBytes < 100 * 1024,
    `brief should be trimmed under 100KB, got ${briefBytes} bytes`);
  // And the trim left enough room for the structural sections to
  // survive — tasks header and a runtime-events header are both still
  // present even though most event lines are gone.
  assert.match(observedBriefContent, /## Tasks/);
  assert.match(observedBriefContent, /## Recent runtime events/);
});

test('buildUserPayload includes diffsByTask in a "Task diffs" section (2026-05-15 alignment fix)', () => {
  // The whole point of a drift judge is to compare CODE against SPEC.
  // Before this fix, the brief carried tasks + events + foundry docs
  // but never the actual code diffs — so the judge had no way to spot
  // an implementation that diverged from the spec's mandated approach.
  // diffsByTask is already computed by buildSnapshot; the fix is just
  // putting it in front of the judge.
  const snapshot = {
    ...BASE_SNAPSHOT,
    tasks: [
      { teamId: 'team-a', taskId: 'task-1', status: 'in_progress',
        allowedFiles: ['src/billing/**'], forbiddenFiles: [], testCommands: [],
        acceptanceCriteria: ['user can set quantity'], subject: 'Bulk subscription quantity' },
    ],
    diffsByTask: {
      'task-1': {
        changedFiles: ['src/billing/quantity.ts', 'test/billing/quantity.test.ts'],
        diff: '--- a/src/billing/quantity.ts\n+++ b/src/billing/quantity.ts\n@@ -1,3 +1,8 @@\n export function setQuantity(n: number) {\n+  if (n < 1) throw new Error("min 1");\n+  return n;\n }\n',
        error: null,
      },
    },
  };
  const payload = buildUserPayload(snapshot, null);
  // The new section is present.
  assert.match(payload, /## Task diffs \(current work vs base ref/);
  // The task subject is in the diff section header.
  assert.match(payload, /Bulk subscription quantity/);
  // Changed files are listed.
  assert.match(payload, /src\/billing\/quantity\.ts/);
  // The actual diff content is present (the judge needs this to spot
  // CODE ALIGNMENT issues).
  assert.match(payload, /\+\+\+ b\/src\/billing\/quantity\.ts/);
  assert.match(payload, /\+\s*if \(n < 1\) throw new Error\("min 1"\);/);
  // Wrapped in a diff fence so the model parses it as code.
  assert.match(payload, /```diff/);
});

test('buildUserPayload truncates oversized diffs to keep the brief bounded (per-task cap)', () => {
  // A single noisy task shouldn't blow the budget alone. Per-task diff
  // cap is 4000 chars; oversized diffs get a truncation marker so the
  // judge knows context was elided rather than seeing a mysterious cut.
  const giantDiff = '--- a/file.ts\n+++ b/file.ts\n' + Array.from({ length: 200 }, (_, i) => `+ line ${i}: ${'X'.repeat(40)}`).join('\n');
  const snapshot = {
    ...BASE_SNAPSHOT,
    tasks: [
      { teamId: 'team-a', taskId: 'task-noisy', status: 'in_progress',
        allowedFiles: [], forbiddenFiles: [], testCommands: [],
        acceptanceCriteria: [], subject: 'Noisy refactor' },
    ],
    diffsByTask: {
      'task-noisy': {
        changedFiles: ['file.ts'],
        diff: giantDiff,
        error: null,
      },
    },
  };
  const payload = buildUserPayload(snapshot, null);
  // Truncation marker present.
  assert.match(payload, /truncated, \d+ chars elided/);
  // First line of the diff still appears (we didn't drop the start).
  assert.match(payload, /--- a\/file\.ts/);
});

test('buildUserPayload skips the Task diffs section when no task has a diff', () => {
  // Don't render an empty section header — distracts the judge and
  // wastes tokens. The section only appears when at least one task
  // has actual diff content.
  const snapshot = {
    ...BASE_SNAPSHOT,
    diffsByTask: {}, // empty
  };
  const payload = buildUserPayload(snapshot, null);
  assert.doesNotMatch(payload, /## Task diffs/);
});

test('buildUserPayload surfaces diff errors instead of fabricating content', () => {
  // When buildSnapshot couldn't compute a diff (worktree missing, git
  // error, etc.) the entry has { error: 'reason' }. The judge gets a
  // clear "Diff error: ..." line instead of pretending we have data.
  const snapshot = {
    ...BASE_SNAPSHOT,
    diffsByTask: {
      'task-1': {
        changedFiles: [],
        diff: null,
        error: 'fatal: no such worktree',
      },
    },
  };
  const payload = buildUserPayload(snapshot, null);
  assert.match(payload, /## Task diffs/);
  assert.match(payload, /Diff error: fatal: no such worktree/);
});
