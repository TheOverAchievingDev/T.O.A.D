# Drift Slice 2 (LLM-Semantic Tier) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-04-drift-slice-2-llm-tier-design.md`

**Goal:** Add a two-tier LLM-semantic check tier to the drift engine — Haiku/Mini/Flash always-on (tier 1), Opus 4.7 / GPT-5 / Gemini 2.5 Pro escalating only when the deterministic+tier-1 score crosses Warning (41+).

**Architecture:** New `src/drift/llm/` module (judge, escalation gate, provider resolver, prompts). New async-aware check `checkLlmSemantic` that spawns a CLI judge in one-shot mode. Engine refactored to `await check.fn`, gains in-memory cooldown state + tier-2 orchestration. Findings persist in the existing `drift_findings` table with tier encoded in `check_name`. UI adds badges + a non-blocking failure banner.

**Tech Stack:** Node 20+ ESM, `node:child_process` (spawn), `node:test`, React 18 + TypeScript (UI), no new runtime deps.

**Test discipline:** TDD throughout. Every new module ships with its failing test before implementation lands. LLM-judge spawn is testable via injected `spawnImpl` returning canned stdout — no live model calls in unit tests.

---

## File structure

```
src/drift/
├── llm/                                  ← NEW directory
│   ├── escalationGate.js                 ← Task 1
│   ├── providerResolver.js               ← Task 2
│   ├── llmJudge.js                       ← Task 5
│   └── prompts/
│       ├── tier1.js                      ← Task 3 (exports prompt as string)
│       └── tier2.js                      ← Task 4 (exports prompt as string)
├── checks/
│   └── checkLlmSemantic.js               ← Task 6
├── buildSnapshot.js                      ← MODIFIED in Task 7 (add teamConfig)
├── driftEngine.js                        ← MODIFIED in Task 8 + 9 (async checks, tier 2)
└── checks/index.js                       ← MODIFIED in Task 6 (register new check)

scripts/dev-api-server.mjs                ← MODIFIED in Task 11 (wire teamConfigRegistry into engine deps)

ui/src/hooks/useDrift.ts                  ← MODIFIED in Task 12 (DriftRunResult.llm field)
ui/src/components/DriftScreen.tsx         ← MODIFIED in Task 13 (tier badges + banner)
ui/src/components/findingTier.ts          ← NEW (Task 13)

test/drift/llm/
├── escalationGate.test.js                ← Task 1
├── providerResolver.test.js              ← Task 2
└── llmJudge.test.js                      ← Task 5

test/drift/checks/
└── checkLlmSemantic.test.js              ← Task 6

test/drift/
└── driftEngineLlm.test.js                ← Task 9 (extends engine tests)

package.json                              ← MODIFIED in Task 14 (test chain)
```

---

## Phase 1 — Pure-function foundation

### Task 1: `escalationGate` pure function

**Files:**
- Create: `src/drift/llm/escalationGate.js`
- Test: `test/drift/llm/escalationGate.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/llm/escalationGate.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { escalationGate } from '../../../src/drift/llm/escalationGate.js';

const BASE = {
  threshold: 41,
  cooldownMs: 300_000,
  scoreDelta: 10,
  now: 1_700_000_000_000,
};

test('escalationGate: below threshold → no escalate', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 30, lastT2RunAt: null, lastT2Score: null,
  });
  assert.equal(result.escalate, false);
  assert.equal(result.reason, 'below_threshold');
});

test('escalationGate: above threshold + no prior run → escalate (first_time)', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 50, lastT2RunAt: null, lastT2Score: null,
  });
  assert.equal(result.escalate, true);
  assert.equal(result.reason, 'first_time');
});

test('escalationGate: above threshold + within cooldown → no escalate', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 50,
    lastT2RunAt: BASE.now - 60_000, // 1 min ago, cooldown is 5 min
    lastT2Score: 50,
  });
  assert.equal(result.escalate, false);
  assert.equal(result.reason, 'cooldown');
});

test('escalationGate: above threshold + cooldown expired + score-delta sufficient → escalate', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 65,
    lastT2RunAt: BASE.now - 600_000, // 10 min ago
    lastT2Score: 50, // delta = 15, threshold delta = 10
  });
  assert.equal(result.escalate, true);
  assert.equal(result.reason, 'score_delta');
});

test('escalationGate: above threshold + cooldown expired + score-delta too small → no escalate', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 53,
    lastT2RunAt: BASE.now - 600_000,
    lastT2Score: 50, // delta = 3, threshold delta = 10
  });
  assert.equal(result.escalate, false);
  assert.equal(result.reason, 'no_material_change');
});

test('escalationGate: above threshold + lastT2Score missing treated as 0 → escalate', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 50,
    lastT2RunAt: BASE.now - 600_000,
    lastT2Score: null, // counts as 0; delta = 50, threshold = 10
  });
  assert.equal(result.escalate, true);
  assert.equal(result.reason, 'score_delta');
});

test('escalationGate: exactly at threshold escalates', () => {
  const result = escalationGate({
    ...BASE, tier1Score: 41, lastT2RunAt: null, lastT2Score: null,
  });
  assert.equal(result.escalate, true);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/llm/escalationGate.test.js`
Expected: FAIL — "Cannot find module '../../../src/drift/llm/escalationGate.js'"

- [ ] **Step 3: Implement `src/drift/llm/escalationGate.js`**

```js
/**
 * Decide whether the tier-2 LLM judge should run for this drift run.
 *
 * Pure function — no I/O, no side effects. Engine maintains the
 * cooldown state in memory and passes it in via lastT2RunAt /
 * lastT2Score.
 *
 * Logic (from spec §7):
 *   1. tier1Score < threshold      → skip (below_threshold)
 *   2. lastT2RunAt is null         → escalate (first_time)
 *   3. now - lastT2RunAt < cooldown → skip (cooldown)
 *   4. |tier1Score - lastT2Score| ≥ delta → escalate (score_delta)
 *   5. otherwise                   → skip (no_material_change)
 */
export function escalationGate({
  tier1Score,
  threshold,
  cooldownMs,
  scoreDelta,
  lastT2RunAt,
  lastT2Score,
  now,
} = {}) {
  if (typeof tier1Score !== 'number') {
    return { escalate: false, reason: 'invalid_score' };
  }
  if (tier1Score < threshold) {
    return { escalate: false, reason: 'below_threshold' };
  }
  if (lastT2RunAt === null || lastT2RunAt === undefined) {
    return { escalate: true, reason: 'first_time' };
  }
  if (now - lastT2RunAt < cooldownMs) {
    return { escalate: false, reason: 'cooldown' };
  }
  const prior = typeof lastT2Score === 'number' ? lastT2Score : 0;
  if (Math.abs(tier1Score - prior) >= scoreDelta) {
    return { escalate: true, reason: 'score_delta' };
  }
  return { escalate: false, reason: 'no_material_change' };
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/llm/escalationGate.test.js`
Expected: PASS — 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/drift/llm/escalationGate.js test/drift/llm/escalationGate.test.js
git commit -m "feat(drift): escalationGate pure function for tier-2 LLM cascade"
```

---

### Task 2: `providerResolver` pure function

**Files:**
- Create: `src/drift/llm/providerResolver.js`
- Test: `test/drift/llm/providerResolver.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/llm/providerResolver.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProvider, PROVIDER_MAP } from '../../../src/drift/llm/providerResolver.js';

const NO_OVERRIDES = { drift: { tier1ModelOverride: null, tier2ModelOverride: null } };

test('PROVIDER_MAP exposes the three core providers', () => {
  assert.ok(PROVIDER_MAP.anthropic);
  assert.ok(PROVIDER_MAP.openai);
  assert.ok(PROVIDER_MAP.gemini);
});

test('resolveProvider: anthropic team, tier 1 → claude + haiku-4.5', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'anthropic' } },
    settings: NO_OVERRIDES,
    tier: 1,
  });
  assert.equal(result.cli, 'claude');
  assert.equal(result.model, 'haiku-4.5');
});

test('resolveProvider: anthropic team, tier 2 → claude + opus-4.7', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'anthropic' } },
    settings: NO_OVERRIDES,
    tier: 2,
  });
  assert.equal(result.cli, 'claude');
  assert.equal(result.model, 'opus-4.7');
});

test('resolveProvider: openai team → codex CLI', () => {
  const t1 = resolveProvider({
    teamConfig: { lead: { providerId: 'openai' } },
    settings: NO_OVERRIDES, tier: 1,
  });
  const t2 = resolveProvider({
    teamConfig: { lead: { providerId: 'openai' } },
    settings: NO_OVERRIDES, tier: 2,
  });
  assert.equal(t1.cli, 'codex');
  assert.equal(t1.model, 'gpt-4o-mini');
  assert.equal(t2.cli, 'codex');
  assert.equal(t2.model, 'gpt-5');
});

test('resolveProvider: gemini team → gemini CLI', () => {
  const t1 = resolveProvider({
    teamConfig: { lead: { providerId: 'gemini' } },
    settings: NO_OVERRIDES, tier: 1,
  });
  const t2 = resolveProvider({
    teamConfig: { lead: { providerId: 'gemini' } },
    settings: NO_OVERRIDES, tier: 2,
  });
  assert.equal(t1.cli, 'gemini');
  assert.equal(t1.model, 'gemini-2.5-flash');
  assert.equal(t2.cli, 'gemini');
  assert.equal(t2.model, 'gemini-2.5-pro');
});

test('resolveProvider: unknown providerId falls back to anthropic', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'unknown-xyz' } },
    settings: NO_OVERRIDES, tier: 1,
  });
  assert.equal(result.cli, 'claude');
  assert.equal(result.model, 'haiku-4.5');
});

test('resolveProvider: missing teamConfig defaults to anthropic', () => {
  const result = resolveProvider({
    teamConfig: null, settings: NO_OVERRIDES, tier: 1,
  });
  assert.equal(result.cli, 'claude');
});

test('resolveProvider: tier1ModelOverride wins for tier 1', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'anthropic' } },
    settings: { drift: { tier1ModelOverride: 'sonnet-4.6', tier2ModelOverride: null } },
    tier: 1,
  });
  assert.equal(result.cli, 'claude');
  assert.equal(result.model, 'sonnet-4.6');
});

test('resolveProvider: tier2ModelOverride wins for tier 2', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'anthropic' } },
    settings: { drift: { tier1ModelOverride: null, tier2ModelOverride: 'opus-4.6' } },
    tier: 2,
  });
  assert.equal(result.cli, 'claude');
  assert.equal(result.model, 'opus-4.6');
});

test('resolveProvider: tier1Override does NOT affect tier 2 resolution', () => {
  const result = resolveProvider({
    teamConfig: { lead: { providerId: 'anthropic' } },
    settings: { drift: { tier1ModelOverride: 'sonnet-4.6', tier2ModelOverride: null } },
    tier: 2,
  });
  assert.equal(result.model, 'opus-4.7'); // default tier-2, not the tier-1 override
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/llm/providerResolver.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/drift/llm/providerResolver.js`**

```js
/**
 * Pick the CLI + model the drift judge should spawn.
 *
 * Default: match the team's lead provider.
 * Override: settings.drift.tier{1,2}ModelOverride wins when set.
 *
 * Pure function — no I/O. Returns { cli, model }.
 */

export const PROVIDER_MAP = Object.freeze({
  anthropic: Object.freeze({
    cli: 'claude',
    tier1: 'haiku-4.5',
    tier2: 'opus-4.7',
  }),
  openai: Object.freeze({
    cli: 'codex',
    tier1: 'gpt-4o-mini',
    tier2: 'gpt-5',
  }),
  gemini: Object.freeze({
    cli: 'gemini',
    tier1: 'gemini-2.5-flash',
    tier2: 'gemini-2.5-pro',
  }),
});

const FALLBACK_PROVIDER = 'anthropic';

export function resolveProvider({ teamConfig, settings, tier } = {}) {
  if (tier !== 1 && tier !== 2) {
    throw new TypeError(`resolveProvider: tier must be 1 or 2 (got ${tier})`);
  }
  const driftSettings = settings?.drift ?? {};
  const override = tier === 1
    ? driftSettings.tier1ModelOverride
    : driftSettings.tier2ModelOverride;

  const leadProviderId = teamConfig?.lead?.providerId ?? FALLBACK_PROVIDER;
  const provider = PROVIDER_MAP[leadProviderId] || PROVIDER_MAP[FALLBACK_PROVIDER];

  return {
    cli: provider.cli,
    model: typeof override === 'string' && override.length > 0
      ? override
      : (tier === 1 ? provider.tier1 : provider.tier2),
  };
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/llm/providerResolver.test.js`
Expected: PASS — 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/drift/llm/providerResolver.js test/drift/llm/providerResolver.test.js
git commit -m "feat(drift): providerResolver maps team→{cli,model} for tier 1/2"
```

---

## Phase 2 — Prompts

### Task 3: Tier 1 system prompt

**Files:**
- Create: `src/drift/llm/prompts/tier1.js`

- [ ] **Step 1: Implement `src/drift/llm/prompts/tier1.js`**

```js
/**
 * System prompt for the tier-1 drift judge (Haiku / GPT-4o-mini /
 * Gemini Flash). Keep this prompt CONSTANT across model providers —
 * differences in instruction-following style are tolerable; spec-drift
 * caused by per-model prompt customization is not.
 */
export const TIER1_SYSTEM_PROMPT = `You are a drift judge for a multi-agent coding team. Read the team's current state and spec docs and report places where the team has drifted from spec.

CRITICAL: Output JSON ONLY. No prose, no markdown fences, no explanation. Just a JSON object matching the schema below.

Schema:
{ "findings": [
  { "category": "architecture|checklist|slice_scope|test_truth|risk",
    "severity": "info|low|medium|high|critical",
    "title": "<one short sentence>",
    "expected": "<what should be true per the spec>",
    "actual": "<what is currently true>",
    "evidence": ["<specific quote or task ref>", ...],
    "recommendedCorrection": "<concrete next step>",
    "taskId": "<optional: which task this is about>"
  }, ...
] }

Focus on three axes:
1. PLAN ALIGNMENT — do active task plans match steering.md's principles?
2. DoD ADHERENCE — tasks at review/merge_ready/done that don't meet the criteria in definition_of_done.md.
3. ADR VIOLATIONS — any current work violating decisions in design_decisions.md.

Be specific. Findings without quoted evidence are useless. Return {"findings": []} if you see no drift — better than fabricating.

Severity cap for tier 1: maximum severity is "high". Use "critical" only when an issue blocks any further work; tier 2 (Opus / GPT-5 / Gemini Pro) is escalated for critical-severity reasoning.`;
```

- [ ] **Step 2: Commit**

```bash
git add src/drift/llm/prompts/tier1.js
git commit -m "feat(drift): tier-1 LLM judge system prompt"
```

(No test — this is a pure string export. Tests in later tasks will verify the judge uses it.)

---

### Task 4: Tier 2 system prompt

**Files:**
- Create: `src/drift/llm/prompts/tier2.js`

- [ ] **Step 1: Implement `src/drift/llm/prompts/tier2.js`**

```js
/**
 * System prompt for the tier-2 drift judge (Opus 4.7 / GPT-5 /
 * Gemini 2.5 Pro). Tier 2 escalates when tier 1's combined-with-
 * deterministic score crosses Warning (41+).
 */
export const TIER2_SYSTEM_PROMPT = `You are escalated to deep-judge mode. The cheaper tier-1 judge flagged this team's drift score >= 41. Your job is to confirm or refute the tier-1 findings AND identify any subtle drift that tier 1 missed.

For each tier-1 finding, you may:
- CONFIRM (re-emit it, optionally adjust severity)
- REFUTE (drop it — don't include in your output)
- AUGMENT (emit a sharper version with better evidence)

You may also add NEW findings the tier-1 judge missed — focus on nuance: subtle ADR violations, cross-task scope creep, plans that technically pass DoD but miss its spirit.

CRITICAL: Output JSON ONLY. No prose, no markdown fences, no explanation. Just a JSON object matching the schema below.

Schema:
{ "findings": [
  { "category": "architecture|checklist|slice_scope|test_truth|risk",
    "severity": "info|low|medium|high|critical",
    "title": "<one short sentence>",
    "expected": "<what should be true per the spec>",
    "actual": "<what is currently true>",
    "evidence": ["<specific quote or task ref>", ...],
    "recommendedCorrection": "<concrete next step>",
    "taskId": "<optional: which task this is about>"
  }, ...
] }

The tier-1 findings are appended below your normal context. Use them as a baseline; your output replaces theirs entirely. Tier-2 may emit "critical" severity (tier-1 caps at "high").`;
```

- [ ] **Step 2: Commit**

```bash
git add src/drift/llm/prompts/tier2.js
git commit -m "feat(drift): tier-2 LLM judge system prompt"
```

---

## Phase 3 — LLM judge

### Task 5: `llmJudge` with mocked spawn

**Files:**
- Create: `src/drift/llm/llmJudge.js`
- Test: `test/drift/llm/llmJudge.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/llm/llmJudge.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { llmJudge } from '../../../src/drift/llm/llmJudge.js';
import { EventEmitter } from 'node:events';

/**
 * Build a fake spawn that emits a canned stdout string and exits 0.
 * The real spawn returns a ChildProcess with stdout/stderr streams +
 * an 'exit' event — we simulate just enough of that surface for the
 * judge to consume.
 */
function fakeSpawn(stdout, { exitCode = 0, exitDelayMs = 5 } = {}) {
  return () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write() {}, end() {} };
    proc.kill = () => proc.emit('exit', null, 'SIGKILL');
    setTimeout(() => {
      proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('exit', exitCode, null);
    }, exitDelayMs);
    return proc;
  };
}

test('llmJudge parses well-formed JSON response into findings', async () => {
  const stdout = JSON.stringify({
    findings: [
      {
        category: 'architecture',
        severity: 'medium',
        title: 'Plan diverges from steering',
        expected: 'Use Postgres per ADR-002',
        actual: 'Plan calls for SQLite',
        evidence: ['plan: "use SQLite for simplicity"', 'ADR-002 mandates Postgres'],
        recommendedCorrection: 'Update plan to use Postgres',
        taskId: 'task-1',
      },
    ],
  });

  const result = await llmJudge({
    cli: 'claude',
    model: 'haiku-4.5',
    systemPrompt: 'system',
    userPayload: 'user',
    timeoutMs: 5000,
    spawnImpl: fakeSpawn(stdout),
  });

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].category, 'architecture');
  assert.equal(result.findings[0].taskId, 'task-1');
  assert.equal(result.rawText, stdout);
});

test('llmJudge strips markdown code fences if model wraps JSON', async () => {
  const stdout = '```json\n' + JSON.stringify({ findings: [] }) + '\n```';
  const result = await llmJudge({
    cli: 'claude', model: 'haiku-4.5',
    systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
    spawnImpl: fakeSpawn(stdout),
  });
  assert.deepEqual(result.findings, []);
});

test('llmJudge drops malformed findings, keeps valid ones', async () => {
  const stdout = JSON.stringify({
    findings: [
      // valid
      {
        category: 'risk', severity: 'low', title: 'OK',
        expected: 'e', actual: 'a', evidence: ['ev'],
        recommendedCorrection: 'r',
      },
      // malformed: invalid category
      {
        category: 'bogus', severity: 'low', title: 'Bad',
        expected: 'e', actual: 'a', evidence: [],
        recommendedCorrection: 'r',
      },
      // malformed: missing required field (title)
      {
        category: 'risk', severity: 'low',
        expected: 'e', actual: 'a', evidence: [],
        recommendedCorrection: 'r',
      },
    ],
  });
  const result = await llmJudge({
    cli: 'claude', model: 'haiku-4.5',
    systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
    spawnImpl: fakeSpawn(stdout),
  });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, 'OK');
});

test('llmJudge throws on completely unparseable response', async () => {
  await assert.rejects(
    () => llmJudge({
      cli: 'claude', model: 'haiku-4.5',
      systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
      spawnImpl: fakeSpawn('not json at all'),
    }),
    /invalid_response/,
  );
});

test('llmJudge throws timeout when CLI never exits', async () => {
  // never-exiting fake
  const neverExits = () => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write() {}, end() {} };
    proc.kill = () => proc.emit('exit', null, 'SIGKILL');
    return proc;
  };
  await assert.rejects(
    () => llmJudge({
      cli: 'claude', model: 'haiku-4.5',
      systemPrompt: 's', userPayload: 'u', timeoutMs: 100,
      spawnImpl: neverExits,
    }),
    /timeout/,
  );
});

test('llmJudge throws on non-zero exit', async () => {
  await assert.rejects(
    () => llmJudge({
      cli: 'claude', model: 'haiku-4.5',
      systemPrompt: 's', userPayload: 'u', timeoutMs: 5000,
      spawnImpl: fakeSpawn('', { exitCode: 1 }),
    }),
    /spawn_failed/,
  );
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/llm/llmJudge.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/drift/llm/llmJudge.js`**

```js
import { spawn as defaultSpawn } from 'node:child_process';

const ALLOWED_CATEGORIES = new Set([
  'architecture', 'checklist', 'slice_scope', 'test_truth', 'risk',
]);
const ALLOWED_SEVERITIES = new Set([
  'info', 'low', 'medium', 'high', 'critical',
]);
const REQUIRED_STRING_FIELDS = ['title', 'expected', 'actual', 'recommendedCorrection'];

/**
 * Build the argv each provider's CLI expects for a one-shot prompt run.
 *
 *   claude  --model <model> --print "<combined>"
 *   codex   exec --model <model> "<combined>"
 *   gemini  -m <model> -p "<combined>"
 *
 * The "combined" string is "<system>\n\n<user>" — most CLIs don't expose
 * a separate system-prompt flag in one-shot mode, so we paste the
 * system prompt as the first paragraph of the user prompt. The model
 * still treats the leading instructions as governing.
 */
function argsFor(cli, model, combined) {
  if (cli === 'claude') return ['--model', model, '--print', combined];
  if (cli === 'codex') return ['exec', '--model', model, combined];
  if (cli === 'gemini') return ['-m', model, '-p', combined];
  throw new TypeError(`llmJudge: unsupported cli "${cli}"`);
}

/**
 * Strip leading/trailing markdown code fences. Handles:
 *   ```json\n{...}\n```
 *   ```\n{...}\n```
 *   {...}                         (no fences)
 */
function stripFences(text) {
  const trimmed = text.trim();
  const fenceRe = /^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/;
  const match = trimmed.match(fenceRe);
  return match ? match[1].trim() : trimmed;
}

/**
 * Validate one finding against the expected schema. Returns the
 * normalized finding when valid, null when malformed.
 */
function validateFinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (!ALLOWED_CATEGORIES.has(raw.category)) return null;
  if (!ALLOWED_SEVERITIES.has(raw.severity)) return null;
  for (const field of REQUIRED_STRING_FIELDS) {
    if (typeof raw[field] !== 'string' || raw[field].length === 0) return null;
  }
  const evidence = Array.isArray(raw.evidence)
    ? raw.evidence.filter((e) => typeof e === 'string')
    : [];
  return {
    category: raw.category,
    severity: raw.severity,
    title: raw.title,
    expected: raw.expected,
    actual: raw.actual,
    evidence,
    recommendedCorrection: raw.recommendedCorrection,
    taskId: typeof raw.taskId === 'string' ? raw.taskId : null,
  };
}

/**
 * Spawn the team's CLI in one-shot mode, send the combined prompt,
 * collect stdout, parse JSON, validate findings, return.
 *
 * Throws on spawn failure, timeout, non-zero exit, or unparseable
 * response. Engine catches and emits a meta-finding describing the
 * failure (so the run continues).
 *
 * @param {object} options
 * @param {string} options.cli         e.g. 'claude'
 * @param {string} options.model       e.g. 'haiku-4.5'
 * @param {string} options.systemPrompt
 * @param {string} options.userPayload
 * @param {number} [options.timeoutMs=30000]
 * @param {Function} [options.spawnImpl]  inject for tests
 */
export async function llmJudge({
  cli,
  model,
  systemPrompt,
  userPayload,
  timeoutMs = 30_000,
  spawnImpl,
} = {}) {
  if (typeof cli !== 'string' || cli.length === 0) {
    throw new TypeError('llmJudge: cli is required');
  }
  if (typeof model !== 'string' || model.length === 0) {
    throw new TypeError('llmJudge: model is required');
  }

  const spawnFn = spawnImpl || defaultSpawn;
  const combined = `${systemPrompt}\n\n${userPayload}`;
  const args = argsFor(cli, model, combined);

  const result = await new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnFn(cli, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`llmJudge: spawn_failed: ${err && err.message ? err.message : err}`));
      return;
    }

    let stdoutBuf = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`llmJudge: timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    if (proc.stdout) {
      proc.stdout.on('data', (chunk) => { stdoutBuf += chunk.toString(); });
    }
    proc.on('exit', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`llmJudge: spawn_failed: exit code ${code}`));
        return;
      }
      resolve(stdoutBuf);
    });
    proc.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(new Error(`llmJudge: spawn_failed: ${err.message}`));
    });
  });

  // Parse the response.
  const cleaned = stripFences(result);
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error('llmJudge: invalid_response: not valid JSON');
  }
  if (!parsed || !Array.isArray(parsed.findings)) {
    throw new Error('llmJudge: invalid_response: missing findings array');
  }

  const findings = [];
  for (const raw of parsed.findings) {
    const validated = validateFinding(raw);
    if (validated) findings.push(validated);
    // Drop malformed silently; engine logs total count after the call.
  }

  return {
    findings,
    rawText: result,
    tokensUsed: null, // CLI providers don't expose token counts on stdout
  };
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/drift/llm/llmJudge.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/drift/llm/llmJudge.js test/drift/llm/llmJudge.test.js
git commit -m "feat(drift): llmJudge spawns provider CLI + validates findings"
```

---

## Phase 4 — `checkLlmSemantic` + buildSnapshot enrichment

### Task 6: Async `checkLlmSemantic` + register in checks index

**Files:**
- Create: `src/drift/checks/checkLlmSemantic.js`
- Modify: `src/drift/checks/index.js` — add the new check
- Test: `test/drift/checks/checkLlmSemantic.test.js`

- [ ] **Step 1: Write the failing test**

```js
// test/drift/checks/checkLlmSemantic.test.js
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
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/checks/checkLlmSemantic.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/drift/checks/checkLlmSemantic.js`**

```js
import { stableFindingId } from './_findingId.js';
import { llmJudge as defaultLlmJudge } from '../llm/llmJudge.js';
import { resolveProvider } from '../llm/providerResolver.js';
import { TIER1_SYSTEM_PROMPT } from '../llm/prompts/tier1.js';
import { TIER2_SYSTEM_PROMPT } from '../llm/prompts/tier2.js';

/**
 * LLM semantic check. Async — calls a provider CLI in one-shot mode.
 *
 * Returns DriftFinding[] (possibly empty). On judge failure, returns
 * a single meta-finding describing the failure (engine surfaces this
 * to the UI as the tier-2 status banner).
 *
 * Tier 1 caps severity at "high" — only tier 2 is allowed to emit
 * "critical" per the spec (§11 risk).
 */
export async function checkLlmSemantic({
  snapshot,
  settings,
  tier,
  tier1Findings = [], // tier 2 only — for context in the prompt
  llmJudgeImpl,
} = {}) {
  if (!snapshot) return [];
  if (tier !== 1 && tier !== 2) {
    throw new TypeError(`checkLlmSemantic: tier must be 1 or 2 (got ${tier})`);
  }

  const judge = llmJudgeImpl || defaultLlmJudge;
  const checkName = tier === 1 ? 'check_llm_semantic_t1' : 'check_llm_semantic_t2';

  let provider;
  try {
    provider = resolveProvider({
      teamConfig: snapshot.teamConfig,
      settings,
      tier,
    });
  } catch (err) {
    return [makeMetaFinding(snapshot.teamId, checkName, 'provider_resolve_failed',
      err && err.message ? err.message : String(err))];
  }

  const systemPrompt = tier === 1 ? TIER1_SYSTEM_PROMPT : TIER2_SYSTEM_PROMPT;
  const userPayload = buildUserPayload(snapshot, tier === 2 ? tier1Findings : null);

  let result;
  try {
    result = await judge({
      cli: provider.cli,
      model: provider.model,
      systemPrompt,
      userPayload,
      timeoutMs: 30_000,
    });
  } catch (err) {
    return [makeMetaFinding(snapshot.teamId, checkName, 'judge_failed',
      err && err.message ? err.message : String(err))];
  }

  // Stamp + cap-severity-at-high for tier 1.
  return result.findings.map((f) => ({
    id: stableFindingId({
      checkName, category: f.category,
      taskId: f.taskId ?? null,
      salient: f.title,
    }),
    runId: '',
    teamId: snapshot.teamId,
    taskId: f.taskId ?? null,
    category: f.category,
    severity: tier === 1 && f.severity === 'critical' ? 'high' : f.severity,
    checkName,
    title: f.title,
    evidence: f.evidence,
    expected: f.expected,
    actual: f.actual,
    recommendedCorrection: f.recommendedCorrection,
    autoFixable: false,
  }));
}

function makeMetaFinding(teamId, checkName, code, detail) {
  return {
    id: `f_${checkName}_failed_${teamId}`,
    runId: '',
    teamId,
    taskId: null,
    category: 'risk',
    severity: 'medium',
    checkName,
    title: `LLM judge failed (${code})`,
    evidence: [detail],
    expected: 'judge returns DriftFinding[]',
    actual: `judge threw: ${detail}`,
    recommendedCorrection: 'Inspect logs; verify the provider CLI is installed + authenticated.',
    autoFixable: false,
  };
}

function buildUserPayload(snapshot, tier1Findings) {
  const lines = [];
  lines.push(`# Team: ${snapshot.teamId}`);
  lines.push(`# As-of: ${snapshot.asOf}`);
  lines.push('');

  // Tasks (cap to 20 most-recent in full schema; older summarized)
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const recent = tasks.slice(0, 20);
  const older = tasks.slice(20);
  lines.push(`## Tasks (${recent.length} of ${tasks.length} shown)`);
  for (const t of recent) {
    lines.push(`- ${t.taskId} [${t.status}] "${t.subject ?? ''}"`);
    if (t.allowedFiles?.length) lines.push(`  allowedFiles: ${t.allowedFiles.join(', ')}`);
    if (t.forbiddenFiles?.length) lines.push(`  forbiddenFiles: ${t.forbiddenFiles.join(', ')}`);
    if (t.testCommands?.length) lines.push(`  testCommands: ${t.testCommands.join(' ; ')}`);
    if (t.acceptanceCriteria?.length) lines.push(`  acceptanceCriteria: ${JSON.stringify(t.acceptanceCriteria)}`);
  }
  if (older.length > 0) {
    const counts = {};
    for (const t of older) counts[t.status] = (counts[t.status] || 0) + 1;
    lines.push(`(older: ${JSON.stringify(counts)})`);
  }
  lines.push('');

  // Recent task events (last 50)
  const taskEvents = Array.isArray(snapshot.taskEvents) ? snapshot.taskEvents : [];
  const recentTaskEvents = taskEvents.slice(-50);
  lines.push(`## Recent task events (last ${recentTaskEvents.length})`);
  for (const e of recentTaskEvents) {
    const t = e.createdAt?.slice(11, 16) ?? '';
    lines.push(`- ${t} ${e.taskId ?? ''} ${e.eventType} ${JSON.stringify(e.payload ?? {})}`);
  }
  lines.push('');

  // Recent runtime events (last 50)
  const runtimeEvents = Array.isArray(snapshot.runtimeEvents) ? snapshot.runtimeEvents : [];
  const recentRuntimeEvents = runtimeEvents.slice(-50);
  lines.push(`## Recent runtime events (last ${recentRuntimeEvents.length})`);
  for (const e of recentRuntimeEvents) {
    const t = e.createdAt?.slice(11, 16) ?? '';
    lines.push(`- ${t} ${e.eventType} ${JSON.stringify(e.payload ?? {})}`);
  }
  lines.push('');

  // Foundry docs (full content)
  lines.push('## Foundry docs');
  for (const [key, content] of Object.entries(snapshot.foundryDocs ?? {})) {
    if (typeof content !== 'string' || content.length === 0) continue;
    lines.push(`### ${key}.md`);
    lines.push(content);
    lines.push('');
  }

  // Tier-2 only: include tier-1 findings as baseline
  if (Array.isArray(tier1Findings) && tier1Findings.length > 0) {
    lines.push('## Tier-1 findings (your baseline — confirm/refute/augment)');
    for (const f of tier1Findings) {
      lines.push(`- [${f.severity}] ${f.checkName}: ${f.title}`);
      lines.push(`  expected: ${f.expected}`);
      lines.push(`  actual: ${f.actual}`);
      if (f.evidence?.length) lines.push(`  evidence: ${f.evidence.join(' | ')}`);
    }
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Add to check registry**

Modify `src/drift/checks/index.js` — append to `DETERMINISTIC_CHECKS`:

```js
import { checkInvalidTransitions } from './checkInvalidTransitions.js';
import { checkOutOfScopeFiles } from './checkOutOfScopeFiles.js';
import { checkMissingTestArtifacts } from './checkMissingTestArtifacts.js';
import { checkRolePermissionViolations } from './checkRolePermissionViolations.js';
import { checkReviewWithoutFindings } from './checkReviewWithoutFindings.js';
import { checkProviderLogicLeakage } from './checkProviderLogicLeakage.js';
import { checkDoneWithoutMergeEvidence } from './checkDoneWithoutMergeEvidence.js';
import { checkLlmSemantic } from './checkLlmSemantic.js';

/**
 * Check registry. The engine runs all `tier: 1` checks first, scores
 * the result, and decides whether to run any `tier: 2` checks via
 * escalationGate.
 */
export const ALL_CHECKS = Object.freeze([
  // Deterministic — all tier 1 (always run)
  { name: 'check_invalid_transitions', tier: 1, fn: checkInvalidTransitions },
  { name: 'check_out_of_scope_files', tier: 1, fn: checkOutOfScopeFiles },
  { name: 'check_missing_test_artifacts', tier: 1, fn: checkMissingTestArtifacts },
  { name: 'check_role_permission_violations', tier: 1, fn: checkRolePermissionViolations },
  { name: 'check_review_without_findings', tier: 1, fn: checkReviewWithoutFindings },
  { name: 'check_provider_logic_leakage', tier: 1, fn: checkProviderLogicLeakage },
  { name: 'check_done_without_merge_evidence', tier: 1, fn: checkDoneWithoutMergeEvidence },
  // LLM tier 1 — Haiku/Mini/Flash, always runs
  { name: 'check_llm_semantic_t1', tier: 1, fn: (args) => checkLlmSemantic({ ...args, tier: 1 }) },
  // LLM tier 2 — Opus/GPT-5/Gemini-Pro, escalation only
  { name: 'check_llm_semantic_t2', tier: 2, fn: (args) => checkLlmSemantic({ ...args, tier: 2 }) },
]);

/** Back-compat: existing engine code reads DETERMINISTIC_CHECKS. */
export const DETERMINISTIC_CHECKS = Object.freeze(
  ALL_CHECKS.filter((c) => c.tier === 1 && !c.name.startsWith('check_llm_'))
);
```

- [ ] **Step 5: Run tests, watch them pass**

Run: `node --no-warnings --test test/drift/checks/checkLlmSemantic.test.js`
Expected: PASS — 4 tests

- [ ] **Step 6: Commit**

```bash
git add src/drift/checks/checkLlmSemantic.js src/drift/checks/index.js test/drift/checks/checkLlmSemantic.test.js
git commit -m "feat(drift): checkLlmSemantic async check + tier-aware registry"
```

---

### Task 7: Enrich `buildSnapshot` with `teamConfig`

**Files:**
- Modify: `src/drift/buildSnapshot.js` — read team config, add to snapshot
- Modify: `test/drift/buildSnapshot.test.js` — assert teamConfig is included

- [ ] **Step 1: Add a failing test for the new field**

Append to `test/drift/buildSnapshot.test.js`:

```js
test('buildSnapshot includes teamConfig from teamConfigRegistry', async () => {
  const fakeRegistry = {
    getTeam: ({ teamId }) =>
      teamId === 'team-a'
        ? { teamId, lead: { providerId: 'openai', agentId: 'lead' }, teammates: [] }
        : null,
  };
  const snap = await buildSnapshot({
    teamId: 'team-a',
    deps: {
      taskBoard: fakeTaskBoard(),
      eventLog: fakeEventLog(),
      teamConfigRegistry: fakeRegistry,
    },
  });
  assert.ok(snap.teamConfig, 'teamConfig present');
  assert.equal(snap.teamConfig.lead.providerId, 'openai');
});

test('buildSnapshot tolerates missing teamConfigRegistry', async () => {
  const snap = await buildSnapshot({
    teamId: 'team-a',
    deps: {
      taskBoard: fakeTaskBoard(),
      eventLog: fakeEventLog(),
    },
  });
  assert.equal(snap.teamConfig, null);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/buildSnapshot.test.js`
Expected: FAIL — `snap.teamConfig` is undefined

- [ ] **Step 3: Modify `src/drift/buildSnapshot.js`**

In `buildSnapshot`, after `worktrees`, add:

```js
  let teamConfig = null;
  if (deps.teamConfigRegistry && typeof deps.teamConfigRegistry.getTeam === 'function') {
    try {
      teamConfig = deps.teamConfigRegistry.getTeam({ teamId }) || null;
    } catch {
      teamConfig = null;
    }
  }
```

And add `teamConfig` to the return object.

Full updated return:

```js
  return {
    teamId,
    asOf: new Date().toISOString(),
    tasks,
    taskEvents,
    runtimeEvents,
    foundryDocs,
    worktrees,
    diffsByTask,
    teamConfig,
  };
```

- [ ] **Step 4: Run tests, watch them pass**

Run: `node --no-warnings --test test/drift/buildSnapshot.test.js`
Expected: PASS — all 8 tests (6 existing + 2 new)

- [ ] **Step 5: Commit**

```bash
git add src/drift/buildSnapshot.js test/drift/buildSnapshot.test.js
git commit -m "feat(drift): enrich snapshot with teamConfig for LLM provider resolution"
```

---

## Phase 5 — Engine refactor (async checks + tier 2 orchestration)

### Task 8: Make engine `await check.fn` (async-aware)

**Files:**
- Modify: `src/drift/driftEngine.js` — `await check.fn(...)`
- Modify: `test/drift/driftEngine.test.js` — add an async-check test

- [ ] **Step 1: Add a failing async-check test**

Append to `test/drift/driftEngine.test.js`:

```js
test('DriftEngine awaits async check.fn results', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  // Custom async check that resolves with a finding after a tick.
  const asyncCheck = {
    name: 'check_async_test',
    tier: 1,
    fn: async ({ snapshot }) => {
      await new Promise((r) => setTimeout(r, 5));
      return [{
        id: 'f_async', runId: '', teamId: snapshot.teamId,
        taskId: null, category: 'risk', severity: 'low',
        checkName: 'check_async_test', title: 'Async OK',
        expected: 'e', actual: 'a', evidence: ['ev'],
        recommendedCorrection: 'r', autoFixable: false,
      }];
    },
  };
  const engine = new DriftEngine({
    deps: makeDeps(), store, checks: [asyncCheck],
  });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].title, 'Async OK');
});
```

- [ ] **Step 2: Run test — sync engine returns Promise, async check produces Promise-as-finding (red)**

Run: `node --no-warnings --test test/drift/driftEngine.test.js`
Expected: FAIL — finding is a Promise, not the async result

- [ ] **Step 3: Modify `src/drift/driftEngine.js`**

In `#runDriftInner`, change the check loop:

```js
    const findings = [];
    for (const check of this.checks) {
      try {
        const out = (await check.fn({ snapshot })) || [];
        for (const f of out) {
          findings.push({
            ...f,
            runId,
            teamId,
          });
        }
      } catch (err) {
        // ... existing catch unchanged
```

(Just the addition of `await` — rest of function body stays.)

- [ ] **Step 4: Run tests, watch them pass**

Run: `node --no-warnings --test test/drift/driftEngine.test.js`
Expected: PASS — all 5 tests (4 existing + 1 new)

- [ ] **Step 5: Commit**

```bash
git add src/drift/driftEngine.js test/drift/driftEngine.test.js
git commit -m "refactor(drift): engine awaits async check.fn (slice-2 prep)"
```

---

### Task 9: Engine tier-2 orchestration + cooldown state + `result.llm` field

**Files:**
- Modify: `src/drift/driftEngine.js` — split tier-1/tier-2 checks, gate tier 2, build `result.llm`
- Test: `test/drift/driftEngineLlm.test.js` (new — extends slice-1 tests)

- [ ] **Step 1: Write the failing engine-LLM tests**

Create `test/drift/driftEngineLlm.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DriftEngine } from '../../src/drift/driftEngine.js';
import { SqliteDriftStore } from '../../src/drift/driftStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'storage', 'schema.sql');

function bootstrapDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  db.prepare(`INSERT INTO teams (team_id, display_name, created_at)
              VALUES ('team-a', 'Team A', '2026-05-04T00:00:00Z')`).run();
  return db;
}

function makeDeps() {
  return {
    taskBoard: { listTasks: () => [], listEvents: () => [] },
    eventLog: { listEvents: () => [] },
  };
}

function tier1HighFinding() {
  return {
    id: 'f_tier1_high', runId: '', teamId: 'team-a', taskId: null,
    category: 'architecture', severity: 'critical',
    checkName: 'check_llm_semantic_t1',
    title: 'Tier-1 found something nasty',
    expected: 'e', actual: 'a', evidence: ['ev'],
    recommendedCorrection: 'r', autoFixable: false,
  };
}

test('DriftEngine: tier 2 skipped when score below threshold', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    // Tier 1 returns nothing → score 0 → below threshold
    checks: [
      { name: 'check_t1_empty', tier: 1, fn: async () => [] },
      { name: 'check_t2_should_not_run', tier: 2, fn: async () => {
        throw new Error('tier 2 should not run');
      } },
    ],
    settings: { drift: { llmTierEnabled: true, escalationThreshold: 41,
      tier2CooldownMs: 300_000, tier2ScoreDelta: 10 } },
  });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(result.llm.tier1, 'completed');
  assert.equal(result.llm.tier2, 'skipped:below_threshold');
});

test('DriftEngine: tier 2 runs when tier-1 score >= threshold', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  let tier2Called = false;
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [
      // Critical (capped to high) = 15. Need 41+ to escalate. Add 3 highs (15×3=45).
      { name: 'check_t1', tier: 1, fn: async () => [
        { ...tier1HighFinding(), id: 'a', severity: 'high', title: 'a' },
        { ...tier1HighFinding(), id: 'b', severity: 'high', title: 'b' },
        { ...tier1HighFinding(), id: 'c', severity: 'high', title: 'c' },
      ] },
      { name: 'check_t2', tier: 2, fn: async () => {
        tier2Called = true;
        return [];
      } },
    ],
    settings: { drift: { llmTierEnabled: true, escalationThreshold: 41,
      tier2CooldownMs: 300_000, tier2ScoreDelta: 10 } },
  });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(tier2Called, true, 'tier 2 should have run');
  assert.equal(result.llm.tier2, 'completed');
});

test('DriftEngine: tier 2 cooldown suppresses re-run within window', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  let tier2Calls = 0;
  const checks = [
    { name: 'check_t1', tier: 1, fn: async () => [
      { ...tier1HighFinding(), id: 'a', severity: 'high', title: 'a' },
      { ...tier1HighFinding(), id: 'b', severity: 'high', title: 'b' },
      { ...tier1HighFinding(), id: 'c', severity: 'high', title: 'c' },
    ] },
    { name: 'check_t2', tier: 2, fn: async () => { tier2Calls += 1; return []; } },
  ];
  const engine = new DriftEngine({
    deps: makeDeps(), store, checks,
    settings: { drift: { llmTierEnabled: true, escalationThreshold: 41,
      tier2CooldownMs: 300_000, tier2ScoreDelta: 10 } },
  });
  await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  await engine.runDrift({ teamId: 'team-a', trigger: 'manual' }); // immediately
  assert.equal(tier2Calls, 1, 'second run within cooldown should be skipped');
});

test('DriftEngine: tier 2 failure surfaces in result.llm.tier2', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [
      { name: 'check_t1', tier: 1, fn: async () => [
        { ...tier1HighFinding(), id: 'a', severity: 'high', title: 'a' },
        { ...tier1HighFinding(), id: 'b', severity: 'high', title: 'b' },
        { ...tier1HighFinding(), id: 'c', severity: 'high', title: 'c' },
      ] },
      { name: 'check_t2', tier: 2, fn: async () => {
        throw new Error('opus quota exhausted');
      } },
    ],
    settings: { drift: { llmTierEnabled: true, escalationThreshold: 41,
      tier2CooldownMs: 300_000, tier2ScoreDelta: 10 } },
  });
  const result = await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.ok(typeof result.llm.tier2 === 'object');
  assert.ok(result.llm.tier2.failed);
  assert.match(result.llm.tier2.failed, /opus quota/);
});

test('DriftEngine: llmTierEnabled=false skips both LLM tiers', async () => {
  const db = bootstrapDb();
  const store = new SqliteDriftStore({ db });
  let t1Called = false; let t2Called = false;
  const engine = new DriftEngine({
    deps: makeDeps(), store,
    checks: [
      { name: 'check_llm_semantic_t1', tier: 1, fn: async () => { t1Called = true; return []; } },
      { name: 'check_llm_semantic_t2', tier: 2, fn: async () => { t2Called = true; return []; } },
    ],
    settings: { drift: { llmTierEnabled: false, escalationThreshold: 41,
      tier2CooldownMs: 300_000, tier2ScoreDelta: 10 } },
  });
  await engine.runDrift({ teamId: 'team-a', trigger: 'manual' });
  assert.equal(t1Called, false);
  assert.equal(t2Called, false);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/drift/driftEngineLlm.test.js`
Expected: FAIL — engine doesn't have tier-aware orchestration yet

- [ ] **Step 3: Refactor the engine**

Replace `#runDriftInner` in `src/drift/driftEngine.js`:

```js
import { randomUUID } from 'node:crypto';
import { buildSnapshot } from './buildSnapshot.js';
import { scoreFindings } from './scoreFindings.js';
import { ALL_CHECKS } from './checks/index.js';
import { escalationGate } from './llm/escalationGate.js';

const DEFAULT_SETTINGS = Object.freeze({
  drift: Object.freeze({
    llmTierEnabled: true,
    escalationThreshold: 41,
    tier2CooldownMs: 300_000,
    tier2ScoreDelta: 10,
    tier1ModelOverride: null,
    tier2ModelOverride: null,
  }),
});

export class DriftEngine {
  #inflight = new Map();
  #tier2Cooldown = new Map(); // teamId -> { lastRunAt, lastScore }

  constructor({ deps, store, checks = ALL_CHECKS, settings = DEFAULT_SETTINGS, now = Date.now } = {}) {
    if (!deps) throw new TypeError('DriftEngine: deps required');
    if (!store || typeof store.recordRun !== 'function') {
      throw new TypeError('DriftEngine: store with recordRun required');
    }
    this.deps = deps;
    this.store = store;
    this.checks = checks;
    this.settings = settings;
    this.now = now;
  }

  async runDrift({ teamId, trigger = 'manual' } = {}) {
    if (typeof teamId !== 'string' || teamId.length === 0) {
      throw new TypeError('runDrift: teamId required');
    }
    const existing = this.#inflight.get(teamId);
    if (existing) return existing;

    const promise = this.#runDriftInner({ teamId, trigger })
      .finally(() => this.#inflight.delete(teamId));
    this.#inflight.set(teamId, promise);
    return promise;
  }

  async #runDriftInner({ teamId, trigger }) {
    const runId = `run_${randomUUID()}`;
    const snapshot = await buildSnapshot({ teamId, deps: this.deps });
    const driftSettings = this.settings.drift ?? DEFAULT_SETTINGS.drift;
    const llmEnabled = driftSettings.llmTierEnabled !== false;

    // Partition checks by tier and (for tier 1) by LLM-or-not.
    const tier1Checks = this.checks.filter((c) => c.tier === 1);
    const tier2Checks = this.checks.filter((c) => c.tier === 2);

    // Run tier 1 (deterministic + LLM tier 1 if enabled).
    const tier1Findings = [];
    let tier1Status = 'completed';
    for (const check of tier1Checks) {
      // Skip LLM checks if the tier is disabled in settings.
      if (!llmEnabled && check.name.startsWith('check_llm_')) continue;
      try {
        const out = (await check.fn({ snapshot, settings: this.settings })) || [];
        for (const f of out) tier1Findings.push({ ...f, runId, teamId });
      } catch (err) {
        tier1Findings.push(this.#metaFinding(check.name, runId, teamId, err));
      }
    }

    // Score tier 1 to decide on escalation.
    const tier1Score = scoreFindings(tier1Findings).teamScore;

    // Decide tier 2.
    let tier2Findings = [];
    let tier2Status = 'skipped:below_threshold';
    let tier2Reason = 'below_threshold';

    if (llmEnabled && tier2Checks.length > 0) {
      const cooldown = this.#tier2Cooldown.get(teamId) ?? null;
      const verdict = escalationGate({
        tier1Score,
        threshold: driftSettings.escalationThreshold,
        cooldownMs: driftSettings.tier2CooldownMs,
        scoreDelta: driftSettings.tier2ScoreDelta,
        lastT2RunAt: cooldown?.lastRunAt ?? null,
        lastT2Score: cooldown?.lastScore ?? null,
        now: this.now(),
      });
      tier2Reason = verdict.reason;
      if (verdict.escalate) {
        try {
          for (const check of tier2Checks) {
            const out = (await check.fn({
              snapshot,
              settings: this.settings,
              tier1Findings,
            })) || [];
            for (const f of out) tier2Findings.push({ ...f, runId, teamId });
          }
          tier2Status = 'completed';
          this.#tier2Cooldown.set(teamId, {
            lastRunAt: this.now(),
            lastScore: tier1Score,
          });
        } catch (err) {
          tier2Status = { failed: err && err.message ? err.message : String(err) };
          // Still update cooldown so we don't hammer a failing CLI.
          this.#tier2Cooldown.set(teamId, {
            lastRunAt: this.now(),
            lastScore: tier1Score,
          });
        }
      } else {
        tier2Status = `skipped:${tier2Reason === 'cooldown' ? 'cooldown' : 'below_threshold'}`;
      }
    } else if (!llmEnabled) {
      tier1Status = 'skipped:disabled';
      tier2Status = 'skipped:disabled';
    }

    // Combine + score.
    const allFindings = [...tier1Findings, ...tier2Findings];
    const { teamScore, status, perTaskScores, categoryScores } = scoreFindings(allFindings);

    this.store.recordRun({
      runId,
      teamId,
      asOf: snapshot.asOf,
      teamScore,
      status,
      categoryScores,
      perTaskScores,
      trigger,
      findings: allFindings,
    });

    const history = this.store.listScoreHistory({ teamId, limit: 30 })
      .map((h) => ({ runId: h.runId, teamScore: h.teamScore, createdAt: h.createdAt }));

    return {
      runId,
      asOf: snapshot.asOf,
      teamScore,
      status,
      findings: allFindings,
      categoryScores,
      perTaskScores,
      history,
      trigger,
      llm: {
        tier1: tier1Status,
        tier2: tier2Status,
      },
    };
  }

  #metaFinding(checkName, runId, teamId, err) {
    return {
      id: `f_check_error_${teamId}_${checkName}`,
      runId, teamId, taskId: null,
      category: 'risk', severity: 'medium',
      checkName,
      title: `Check ${checkName} threw during evaluation`,
      evidence: [String(err && err.message ? err.message : err)],
      expected: 'check returns DriftFinding[]',
      actual: 'check threw an exception',
      recommendedCorrection: `Inspect ${checkName}'s implementation against the snapshot it received.`,
      autoFixable: false,
    };
  }
}
```

- [ ] **Step 4: Run tests, watch them pass**

Run: `node --no-warnings --test test/drift/driftEngineLlm.test.js`
Expected: PASS — 5 tests

Also run the existing engine tests to confirm nothing broke:

Run: `node --no-warnings --test test/drift/driftEngine.test.js`
Expected: PASS — all 5 tests (4 existing + 1 from Task 8)

- [ ] **Step 5: Commit**

```bash
git add src/drift/driftEngine.js test/drift/driftEngineLlm.test.js
git commit -m "feat(drift): tier-2 LLM escalation orchestration in DriftEngine"
```

---

## Phase 6 — UI

### Task 10: `findingTier` helper + DriftRunResult.llm in useDrift

**Files:**
- Create: `ui/src/components/findingTier.ts`
- Modify: `ui/src/hooks/useDrift.ts` — extend `DriftRunResult` type with `llm` field

- [ ] **Step 1: Create `findingTier.ts`**

```ts
// ui/src/components/findingTier.ts
export type FindingTier = 'deterministic' | 'llm_t1' | 'llm_t2';

export function findingTier(checkName: string): FindingTier {
  if (checkName === 'check_llm_semantic_t1') return 'llm_t1';
  if (checkName === 'check_llm_semantic_t2') return 'llm_t2';
  return 'deterministic';
}
```

- [ ] **Step 2: Extend `DriftRunResult` type in `useDrift.ts`**

Find the `DriftRunResult` interface and add the `llm` field:

```ts
export type LlmTierStatus =
  | 'completed'
  | 'skipped:cooldown'
  | 'skipped:below_threshold'
  | 'skipped:disabled'
  | { failed: string };

export interface DriftRunResult {
  // ... all existing fields stay the same ...
  history: { runId: string; teamScore: number; createdAt: string }[];
  trigger: 'manual' | 'periodic' | 'task_event';
  /** Slice-2: LLM tier status per run. Optional for back-compat with
   *  older response payloads (the field is always present in slice 2+). */
  llm?: {
    tier1: LlmTierStatus;
    tier2: LlmTierStatus;
  };
}
```

- [ ] **Step 3: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/findingTier.ts ui/src/hooks/useDrift.ts
git commit -m "feat(drift-ui): findingTier helper + DriftRunResult.llm type"
```

---

### Task 11: Tier badges + tier-2 status banner in DriftScreen

**Files:**
- Modify: `ui/src/components/DriftScreen.tsx`

- [ ] **Step 1: Add tier badge to finding cards**

In `DriftScreen.tsx`, find where each finding is rendered (the `{filtered.map((f) => { ... })}` block). Inside the card header, add a badge after the severity pill:

```tsx
import { findingTier } from './findingTier';

// inside the finding card render, alongside the severity badge:
{(() => {
  const tier = findingTier(f.checkName);
  if (tier === 'llm_t1') {
    return (
      <span style={{
        fontSize: 9, padding: '2px 6px', borderRadius: 3,
        background: 'rgba(255,255,255,0.06)',
        color: 'var(--fg-muted)', textTransform: 'uppercase',
        letterSpacing: '0.04em', fontWeight: 600,
      }}>AI</span>
    );
  }
  if (tier === 'llm_t2') {
    return (
      <span style={{
        fontSize: 9, padding: '2px 6px', borderRadius: 3,
        background: 'var(--clay, #d97757)', color: '#fff',
        textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600,
      }}>Verified</span>
    );
  }
  return null;
})()}
```

- [ ] **Step 2: Add the tier-2 failure banner**

Near the top of `DriftScreen.tsx`'s render output (just below the header row), add:

```tsx
{data.llm && typeof data.llm.tier2 === 'object' && data.llm.tier2.failed && (
  <div style={{
    padding: '10px 14px', marginBottom: 16,
    background: 'rgba(255, 205, 102, 0.08)',
    border: '1px solid var(--warn, #ffcd66)',
    borderRadius: 6, fontSize: 12, color: 'var(--fg-muted)',
  }}>
    ⚠️ Deep-scan unavailable — {data.llm.tier2.failed}. Showing tier-1 findings only.
  </div>
)}
```

- [ ] **Step 3: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: clean

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/DriftScreen.tsx
git commit -m "feat(drift-ui): tier badges on findings + tier-2 failure banner"
```

---

## Phase 7 — Wire-up + final tests

### Task 12: Wire `teamConfigRegistry` into engine deps in dev-api-server

**Files:**
- Modify: `scripts/dev-api-server.mjs` — add `teamConfigRegistry` to `driftEngine.deps` + read `settings`

- [ ] **Step 1: Locate the existing engine wiring**

Read `scripts/dev-api-server.mjs` and find the `new DriftEngine({...})` block.

- [ ] **Step 2: Add teamConfigRegistry + settings**

Modify the engine construction:

```js
const driftEngine = new DriftEngine({
  deps: {
    taskBoard: runtime.taskBoard,
    eventLog: runtime.eventLog,
    foundryStore: runtime.foundryStore,
    worktreeManager: runtime.worktreeManager,
    teamConfigRegistry: runtime.teamConfigRegistry, // NEW
  },
  store: driftStore,
  // Read drift settings from the project's settingsStore. If unavailable
  // (no settings store wired) the engine uses DEFAULT_SETTINGS.
  settings: (() => {
    if (typeof runtime.settingsStore?.readEffective !== 'function') return undefined;
    try {
      const all = runtime.settingsStore.readEffective();
      return all && typeof all === 'object' ? all : undefined;
    } catch {
      return undefined;
    }
  })(),
});
```

- [ ] **Step 3: Smoke test syntax**

Run: `node --check scripts/dev-api-server.mjs`
Expected: silent success.

- [ ] **Step 4: Commit**

```bash
git add scripts/dev-api-server.mjs
git commit -m "feat(drift): wire teamConfigRegistry + settings into DriftEngine"
```

---

### Task 13: Extend `npm test` chain

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Append the new test files to the `test` script**

Find `"test":` in `package.json` and append (preserving the `&&` chain):

```
&& node --no-warnings --test test/drift/llm/escalationGate.test.js
&& node --no-warnings --test test/drift/llm/providerResolver.test.js
&& node --no-warnings --test test/drift/llm/llmJudge.test.js
&& node --no-warnings --test test/drift/checks/checkLlmSemantic.test.js
&& node --no-warnings --test test/drift/driftEngineLlm.test.js
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: every test passes (slice-1 tests + new slice-2 tests).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "chore(drift): wire slice-2 LLM tests into npm test chain"
```

---

### Task 14: End-to-end smoke

This task has no test file — human smoke test.

- [ ] **Step 1: Boot the desktop app**

```bash
cd ui && npm run tauri:dev
```

Wait for the workspace to load. Open the **Drift** screen.

- [ ] **Step 2: Force a tier-2 escalation manually**

Click "Run check" on the Drift screen. Watch the network tab in dev tools for `/api/call drift_run` requests. Inspect the response — confirm the `llm` field is present.

- [ ] **Step 3: Manufacture a >41 score scenario**

In the demo team, mark a few tasks `done` without going through `merge_ready` (force illegal transitions). Re-run drift. The deterministic tier should produce findings that push the score over 41. Tier 2 should fire — confirm via the "Verified" badge appearing on findings + a "Last verified by Opus at HH:MM" indicator (if you implemented that bit; otherwise just the badges).

If the user has `claude` not on PATH or no plan, expect to see the failure banner with a clear message.

- [ ] **Step 4: Commit a ship note**

```bash
git commit --allow-empty -m "ship(drift): slice 2 verified end-to-end"
```

---

## Self-review

- [x] **Spec coverage** — every section of the spec maps to a task:
  - §3 architecture / data flow → Tasks 1-9
  - §4 module layout → Tasks 1-7 (creates the modules), Task 12 (wiring)
  - §5 schema → Tasks 6 (check_name encoding), 10 (DriftRunResult.llm)
  - §6 LLM judge contract → Task 5 (judge), Tasks 3+4 (prompts)
  - §7 escalation gate → Task 1
  - §8 failure handling → Task 6 (meta-finding) + Task 9 (tier-2 status), Task 11 (UI banner)
  - §9 UI changes → Tasks 10, 11
  - §10 testing strategy → all task pairs ship a test file alongside the implementation
- [x] **Placeholder scan** — no TBD/TODO/"add error handling"; every code change ships exact code
- [x] **Type consistency** — `DriftFinding`/`DriftRunResult` shapes match across tasks; `findingTier` helper signature consistent; `escalationGate` parameters consistent across spec + tests + implementation
- [x] **Method-name consistency** — `runDrift`, `escalationGate`, `resolveProvider`, `llmJudge`, `checkLlmSemantic`, `findingTier`, `recordRun`, `listScoreHistory` are spelled the same everywhere they appear
