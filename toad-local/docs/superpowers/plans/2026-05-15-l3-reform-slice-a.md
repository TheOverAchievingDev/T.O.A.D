# L3 Reform — Slice A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the paused whole-brief every-tick LLM judge with a scoped, task-boundary, L1-ambiguity-gated, Haiku→Sonnet L3 adjudicator, then un-pause it — Slice A only (the `needsSemanticReview`-flagged branch; the silent-but-significant branch is a deferred stub).

**Architecture:** Reuse `src/drift/llm/llmJudge.js`'s HOME-isolated spawn core verbatim. New focused modules: `l3Gate.js` (pure 5-step predicate + pure cache-key hashes), `buildL3Packet.js` (scoped per-task packet + enforced budget), `l3Judge.js` (Haiku→Sonnet single self-escalation over `llmJudge`), `prompts/l3.js` (scoped adjudicator prompt). The engine owns the in-memory verdict cache + rate window (same pattern as `#tier2Cooldown`/`#lastRunAt`). Tasks 1–8 are additive (no runtime behavior change — new files unwired). Task 9 is the single atomic un-pause: engine rewrite + registry collapse + `checkKinds` lockstep + dead-code deletion + `dev-api-server` flip + plumbing + lead prompt + dogfood — one commit, paused→live.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, `node:crypto` (sha1 — already used via `randomUUID`), zero new deps. Reference spec: `docs/superpowers/specs/2026-05-15-l3-reform-design.md`. Git root `C:\Project-TOAD` (commands: `git -C /c/Project-TOAD ...` with `toad-local/`-prefixed paths). Test files run `node --no-warnings --test <file>`.

---

## File Structure

**Create:**
- `src/drift/llm/l3Gate.js` — pure: `l3CacheKey({...}) → string`, `diffHash`/`specProvenanceHash`/`l1FindingSetHash`/`l3PromptHash` helpers, `silentButSignificant() → false` (Slice B stub), `l3Gate(input) → { action:'invoke'|'skip'|'serve_cached', reason }`.
- `src/drift/llm/buildL3Packet.js` — `buildL3Packet({ snapshot, boundaryTaskId, l1Signal, budgetBytes }) → { packet:string }|{ overBudget:true, bytes, fileCount }`.
- `src/drift/llm/l3Judge.js` — `l3Judge({ packet, provider, settings, llmJudgeImpl, now }) → { findings, tier, confidence }` (Haiku→one Sonnet escalation; critical-cap introduced).
- `src/drift/llm/prompts/l3.js` — `L3_PROMPT_TEMPLATE` (const string) + `buildL3SystemPrompt()`.
- Test files mirroring each.

**Modify:**
- `src/drift/checks/checkStructuralUndeclaredPresent.js` — additive `needsSemanticReview:true` on the undeclared-module finding.
- `src/drift/checks/checkConstitution.js` — additive `needsSemanticReview:true` on observe-mode rule-violation findings.
- `src/drift/checks/checkKinds.js` — drop `check_llm_semantic_t1`/`_t2`, add `check_llm_semantic`.
- `src/drift/checks/index.js` — remove the two LLM registry entries; collapse `DETERMINISTIC_CHECKS`/`ALL_CHECKS`.
- `src/drift/driftEngine.js` — boundary plumbing; new settings + maps; replace the `escalationGate`/tier-2 block with the `l3Gate`→`l3Judge` path + verdict cache + circuit breaker.
- `src/drift/driftMonitor.js` — thread `taskId`; narrow boundary set.
- `src/drift/llm/providerResolver.js` — `PROVIDER_MAP.anthropic.tier2`: `'opus'`→`'sonnet'`.
- `src/team/teamSystemPrompts.js` — lead bundles L3 finding into the review-request packet.
- `scripts/dev-api-server.mjs` — pass `event.taskId` to `notifyTaskEvent`; flip checks wiring (atomic un-pause).
- `test/drift/driftEngineLlm.test.js` — rewrite for the L3 gate path.
- `package.json` — test-script entries (remove deleted, add new).

**Delete (in the atomic un-pause, Task 9):** `src/drift/checks/checkLlmSemantic.js`, `src/drift/llm/prompts/tier1.js`, `src/drift/llm/prompts/tier2.js`, `src/drift/llm/escalationGate.js`, `test/drift/checks/checkLlmSemantic.test.js`, `test/drift/llm/escalationGate.test.js`.

---

## Task 1: PROVIDER_MAP — anthropic tier2 → sonnet

**Files:**
- Modify: `src/drift/llm/providerResolver.js`
- Test: `test/drift/llm/providerResolver.test.js` (exists)

- [ ] **Step 1: Add the failing test**

Append to `test/drift/llm/providerResolver.test.js`:

```javascript
test('anthropic tier2 resolves to sonnet (L3 doctrine: escalate to Sonnet, not Opus)', () => {
  const r = resolveProvider({ teamConfig: { lead: { providerId: 'anthropic' } }, settings: {}, tier: 2 });
  assert.equal(r.cli, 'claude');
  assert.equal(r.model, 'sonnet');
});
```

(If the file already has an `anthropic tier2 → opus` assertion, update that assertion's expected value to `'sonnet'` in the same step — the doctrine changed; do not keep a contradicting test.)

- [ ] **Step 2: Run it, verify FAIL**

Run: `node --no-warnings --test test/drift/llm/providerResolver.test.js`
Expected: FAIL — got `opus`, expected `sonnet`.

- [ ] **Step 3: Change the map**

In `src/drift/llm/providerResolver.js`, in `PROVIDER_MAP.anthropic`, change `tier2: 'opus',` to `tier2: 'sonnet',`. Update the adjacent doc-comment line that says tier-2 is Opus to say Sonnet (the §8a doctrine: "escalate to Sonnet"; the `claude` CLI accepts the `sonnet` alias per this file's own documented accepted-aliases list `haiku|sonnet|opus`).

- [ ] **Step 4: Run it, verify PASS**

Run: `node --no-warnings --test test/drift/llm/providerResolver.test.js`
Expected: PASS, all green.

- [ ] **Step 5: Commit**

```
git -C /c/Project-TOAD add toad-local/src/drift/llm/providerResolver.js toad-local/test/drift/llm/providerResolver.test.js
git -C /c/Project-TOAD commit -m "feat(drift): L3 escalation target is Sonnet, not Opus (§8a doctrine)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `needsSemanticReview` flag on L1.2b (undeclared-present)

**Files:**
- Modify: `src/drift/checks/checkStructuralUndeclaredPresent.js`
- Test: `test/drift/checks/checkStructuralUndeclaredPresent.test.js` (exists)

- [ ] **Step 1: Add the failing test**

Append to `test/drift/checks/checkStructuralUndeclaredPresent.test.js` (reuse the file's existing snapshot-builder helper; if it builds a reviewed spec + a `sourceModules` list with an undeclared module, mirror that):

```javascript
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
  // meta findings (honest-dormant) must NOT carry the flag
  const metas = findings.filter((x) => x.category === 'risk');
  for (const m of metas) assert.notEqual(m.needsSemanticReview, true);
});
```

- [ ] **Step 2: Run it, verify FAIL**

Run: `node --no-warnings --test test/drift/checks/checkStructuralUndeclaredPresent.test.js`
Expected: FAIL — `f.needsSemanticReview` is `undefined`.

- [ ] **Step 3: Add the additive field**

In `src/drift/checks/checkStructuralUndeclaredPresent.js`, in `makeFinding`'s returned object (the function at the bottom returning `{ id, runId, ... specProvenance }`), add one line before `specReviewed:`:

```javascript
    needsSemanticReview: true,
```

Do NOT touch the `meta(...)` helper — honest-dormant metas are not judgment calls. `makeFinding` is used only for the real undeclared-module finding, so every such finding gets the flag and no meta does.

- [ ] **Step 4: Run it, verify PASS + characterization**

Run: `node --no-warnings --test test/drift/checks/checkStructuralUndeclaredPresent.test.js`
Expected: PASS, all green (the additive field doesn't break any existing assertion — they don't assert exact object equality).

- [ ] **Step 5: Commit**

```
git -C /c/Project-TOAD add toad-local/src/drift/checks/checkStructuralUndeclaredPresent.js toad-local/test/drift/checks/checkStructuralUndeclaredPresent.test.js
git -C /c/Project-TOAD commit -m "feat(drift): flag L1.2b undeclared-present findings needsSemanticReview

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `needsSemanticReview` flag on L1.3 observe-mode constitution hits

**Files:**
- Modify: `src/drift/checks/checkConstitution.js`
- Test: `test/drift/checks/checkConstitution.test.js` (exists)

- [ ] **Step 1: Add the failing test**

Append to `test/drift/checks/checkConstitution.test.js`:

```javascript
test('observe-mode rule-violation findings carry needsSemanticReview; gate-mode + metas do not', () => {
  const snapshot = {
    teamId: 't',
    spec: {
      version: 1,
      provenance: { reviewed: true, extracted_by: 'h', source_docs: ['docs/foundry/steering.md'] },
      constitution: { rules: [
        { id: 'obs', description: 'o', detector: { type: 'grep', pattern: 'X' }, severity: 'medium', mode: 'observe' },
        { id: 'gat', description: 'g', detector: { type: 'grep', pattern: 'Y' }, severity: 'critical', mode: 'gate' },
      ] },
    },
    constitutionHits: [
      { ruleId: 'obs', file: 'src/a.rs', line: 3, snippet: 'X' },
      { ruleId: 'gat', file: 'src/b.rs', line: 7, snippet: 'Y' },
    ],
    constitutionUnsupported: [],
    constitutionError: null,
  };
  const findings = checkConstitution({ snapshot });
  const obs = findings.find((f) => f.title.includes('obs'));
  const gat = findings.find((f) => f.title.includes('gat'));
  assert.equal(obs.needsSemanticReview, true, 'observe-mode hit is a judgment call');
  assert.notEqual(gat.needsSemanticReview, true, 'gate-mode is deterministic — no L3');
});
```

- [ ] **Step 2: Run it, verify FAIL**

Run: `node --no-warnings --test test/drift/checks/checkConstitution.test.js`
Expected: FAIL — `obs.needsSemanticReview` is `undefined`.

- [ ] **Step 3: Add the additive field, observe-mode only**

In `src/drift/checks/checkConstitution.js`, in the per-hit `findings.push({ ... })` object (the one with `constitutionMode: mode,` at the end), add immediately before `constitutionMode: mode,`:

```javascript
      ...(mode === 'observe' ? { needsSemanticReview: true } : {}),
```

`mode` is already computed in that loop as `const mode = rule.mode === 'gate' ? 'gate' : 'observe';`. Gate-mode hits are deterministically enforced by the merge gate (doctrinal — see spec §5: L3 over a gate-mode hit is redundant-or-contradictory); only observe-mode is a judgment call. The `meta(...)` helper is untouched (metas aren't judgment calls).

- [ ] **Step 4: Run it, verify PASS + characterization**

Run: `node --no-warnings --test test/drift/checks/checkConstitution.test.js`
Expected: PASS, all 10+ green (additive; no existing exact-object assertion).

- [ ] **Step 5: Commit**

```
git -C /c/Project-TOAD add toad-local/src/drift/checks/checkConstitution.js toad-local/test/drift/checks/checkConstitution.test.js
git -C /c/Project-TOAD commit -m "feat(drift): flag L1.3 observe-mode constitution hits needsSemanticReview

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Finding-schema snapshot test (lock the contract)

**Files:**
- Create: `test/drift/findingSchema.test.js`

- [ ] **Step 1: Write the snapshot test**

Create `test/drift/findingSchema.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStructuralUndeclaredPresent } from '../../src/drift/checks/checkStructuralUndeclaredPresent.js';

// Locks the finding-shape contract that l3Gate (l1FindingSetHash) and
// the lead's review-packet rendering depend on. A schema drift here
// (renamed field, dropped flag) breaks this snapshot — the tripwire
// to re-review l3Gate's hash + the lead prompt (design §6, §3.3).

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
```

- [ ] **Step 2: Run it, verify PASS**

Run: `node --no-warnings --test test/drift/findingSchema.test.js`
Expected: PASS (Tasks 2's field already shipped). If the key-set assertion fails, the finding shape diverged from the spec contract — reconcile (fix the check, not the test) before proceeding.

- [ ] **Step 3: Commit**

```
git -C /c/Project-TOAD add toad-local/test/drift/findingSchema.test.js
git -C /c/Project-TOAD commit -m "test(drift): snapshot-lock the L1 finding schema (l3Gate/lead-prompt tripwire)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `prompts/l3.js` — scoped adjudicator prompt

**Files:**
- Create: `src/drift/llm/prompts/l3.js`
- Test: `test/drift/llm/prompts/l3.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/drift/llm/prompts/l3.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { L3_PROMPT_TEMPLATE, buildL3SystemPrompt } from '../../../../src/drift/llm/prompts/l3.js';

test('template is a stable non-empty constant string (hashed into the cache key)', () => {
  assert.equal(typeof L3_PROMPT_TEMPLATE, 'string');
  assert.ok(L3_PROMPT_TEMPLATE.length > 100);
});

test('prompt is a scoped adjudicator, not a whole-team scanner', () => {
  const p = buildL3SystemPrompt();
  assert.match(p, /adjudicat|is this (a )?genuine|verdict/i);
  assert.match(p, /"verdict"\s*:\s*"drift"\|"clean"|verdict.*drift.*clean/i);
  assert.match(p, /"confidence"\s*:\s*"high"\|"low"|confidence.*high.*low/i);
  // Must NOT instruct a whole-team / foundry-doc scan (that was the old model).
  assert.doesNotMatch(p, /scan the team|foundry docs|whole.*brief/i);
});
```

- [ ] **Step 2: Run it, verify FAIL** (module not found):
`node --no-warnings --test test/drift/llm/prompts/l3.test.js`

- [ ] **Step 3: Create the prompt module**

Create `src/drift/llm/prompts/l3.js`:

```javascript
/**
 * Scoped L3 adjudicator prompt (PROJECT.md §8a Layer 3). The judge is
 * NOT a whole-team drift scanner (that was the paused model). It is
 * given ONE task's change, the machine-checkable spec.json, and the
 * deterministic L1 signal, and asked a single adjudication question.
 *
 * The template is a STABLE constant — its sha1 is part of the L3
 * verdict cache key (design §3.3 l3PromptHash), so editing this text
 * deliberately invalidates stale cached verdicts.
 */
export const L3_PROMPT_TEMPLATE = `You are a scoped drift adjudicator for one task in a multi-agent coding team.

You are given exactly three things in the brief: (1) ONE task's code diff, (2) the project's machine-checkable contract (spec.json — declared dependencies, module/endpoint structure, contracts, constitution rules, provenance), and (3) the deterministic L1 signal for this task (either a flagged L1 finding to adjudicate, or a note that L1 was silent).

Your job is NOT to scan for new drift. It is to answer ONE question: given this change and the contract, is the L1 signal a genuine spec violation the operator must act on, or is it contextually fine?

CRITICAL: Output JSON ONLY. No prose, no markdown fences. Exactly:
{ "verdict": "drift" | "clean",
  "confidence": "high" | "low",
  "findings": [
    { "category": "architecture|checklist|slice_scope|test_truth|risk",
      "severity": "info|low|medium|high|critical",
      "title": "<one short sentence>",
      "expected": "<what the contract requires>",
      "actual": "<what the change does>",
      "evidence": ["<exact diff line or spec.json path>", ...],
      "recommendedCorrection": "<concrete next step>",
      "taskId": "<the task id from the brief>" } ] }

Rules:
- "clean" → findings MUST be []. "drift" → at least one finding with quoted evidence (a diff line or a spec.json path). Findings without evidence are useless.
- "confidence":"low" means YOU cannot resolve this with the scoped context given — you are genuinely unsure. Use it honestly: low confidence triggers a second opinion from a stronger model. Do not use "low" to hedge a clear answer.
- Reason only from the provided brief. Do not speculate about code or docs you were not given.`;

export function buildL3SystemPrompt() {
  return L3_PROMPT_TEMPLATE;
}
```

- [ ] **Step 4: Run it, verify PASS** (3/3):
`node --no-warnings --test test/drift/llm/prompts/l3.test.js`

- [ ] **Step 5: Commit**

```
git -C /c/Project-TOAD add toad-local/src/drift/llm/prompts/l3.js toad-local/test/drift/llm/prompts/l3.test.js
git -C /c/Project-TOAD commit -m "feat(drift): scoped L3 adjudicator prompt (verdict+confidence schema)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `buildL3Packet.js` — scoped packet + enforced budget

**Files:**
- Create: `src/drift/llm/buildL3Packet.js`
- Test: `test/drift/llm/buildL3Packet.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/drift/llm/buildL3Packet.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildL3Packet, L3_PACKET_BUDGET_BYTES } from '../../../src/drift/llm/buildL3Packet.js';

const SNAP = {
  teamId: 't',
  spec: { version: 1, provenance: { reviewed: true }, constitution: { rules: [{ id: 'r' }] } },
  diffsByTask: {
    'T-1': { changedFiles: ['src/a.rs'], diff: 'diff --git a/src/a.rs\n+fn x() {}\n', error: null },
  },
};
const SIGNAL = { kind: 'flagged', finding: { checkName: 'check_constitution', title: 'rule obs', file: 'src/a.rs', line: 1 } };

test('packet contains the task diff, the whole spec.json, and the L1 signal — no prose docs', () => {
  const r = buildL3Packet({ snapshot: SNAP, boundaryTaskId: 'T-1', l1Signal: SIGNAL });
  assert.ok(!r.overBudget);
  assert.match(r.packet, /src\/a\.rs/);
  assert.match(r.packet, /"version": ?1|"version":1/);          // spec.json embedded
  assert.match(r.packet, /check_constitution|rule obs/);          // L1 signal embedded
  assert.doesNotMatch(r.packet, /foundryDocs|## Foundry docs|product-brief/); // NO prose
});

test('default budget is 32 KB and is exported', () => {
  assert.equal(L3_PACKET_BUDGET_BYTES, 32 * 1024);
});

test('over-budget task → overBudget signal, NOT a truncated packet', () => {
  const huge = 'x'.repeat(40 * 1024);
  const snap = { ...SNAP, diffsByTask: { 'T-1': { changedFiles: ['big.rs'], diff: huge, error: null } } };
  const r = buildL3Packet({ snapshot: snap, boundaryTaskId: 'T-1', l1Signal: SIGNAL });
  assert.equal(r.overBudget, true);
  assert.equal(typeof r.bytes, 'number');
  assert.ok(r.bytes > L3_PACKET_BUDGET_BYTES);
  assert.equal(r.packet, undefined, 'must NOT return a truncated packet');
});

test('missing diff for the task → still builds (spec + signal), not over budget', () => {
  const r = buildL3Packet({ snapshot: { ...SNAP, diffsByTask: {} }, boundaryTaskId: 'T-1', l1Signal: SIGNAL });
  assert.ok(!r.overBudget);
  assert.match(r.packet, /\(no diff/i);
});

test('configurable budget override is honored', () => {
  const r = buildL3Packet({ snapshot: SNAP, boundaryTaskId: 'T-1', l1Signal: SIGNAL, budgetBytes: 10 });
  assert.equal(r.overBudget, true);
});
```

- [ ] **Step 2: Run it, verify FAIL** (module not found):
`node --no-warnings --test test/drift/llm/buildL3Packet.test.js`

- [ ] **Step 3: Create the module**

Create `src/drift/llm/buildL3Packet.js`:

```javascript
/**
 * Scoped L3 packet (PROJECT.md §8a; design §4.1). Replaces the paused
 * whole-team 24KB brief with: ONE task's diff + the whole spec.json
 * (compact canonical machine contract — NOT prose foundry docs) + the
 * L1 signal being adjudicated.
 *
 * Enforced budget: if assembled bytes exceed the budget we return an
 * overBudget signal — NEVER a truncated packet. Truncation is exactly
 * what recreated the 2026-05-15 prompt-cap cascade; the caller emits
 * an honest meta + skips the spawn instead.
 */
export const L3_PACKET_BUDGET_BYTES = 32 * 1024;

export function buildL3Packet({ snapshot, boundaryTaskId, l1Signal, budgetBytes = L3_PACKET_BUDGET_BYTES } = {}) {
  const lines = [];
  lines.push(`# L3 scoped adjudication — team ${snapshot?.teamId ?? '?'} task ${boundaryTaskId}`);
  lines.push('');

  lines.push('## The change (this task only)');
  const d = snapshot?.diffsByTask?.[boundaryTaskId] || null;
  if (!d || (typeof d.diff !== 'string' && !Array.isArray(d.changedFiles))) {
    lines.push('(no diff available for this task)');
  } else {
    const files = Array.isArray(d.changedFiles) ? d.changedFiles : [];
    if (files.length > 0) lines.push(`Changed files: ${files.join(', ')}`);
    if (d.error) lines.push(`Diff error: ${d.error}`);
    const body = typeof d.diff === 'string' ? d.diff : '';
    lines.push('```diff');
    lines.push(body.length > 0 ? body : '(no diff content)');
    lines.push('```');
  }
  lines.push('');

  lines.push('## The contract (spec.json — the machine-checkable projection)');
  lines.push('```json');
  lines.push(JSON.stringify(snapshot?.spec ?? null, null, 2));
  lines.push('```');
  lines.push('');

  lines.push('## The deterministic L1 signal to adjudicate');
  lines.push('```json');
  lines.push(JSON.stringify(l1Signal ?? null, null, 2));
  lines.push('```');

  const packet = lines.join('\n');
  const bytes = Buffer.byteLength(packet, 'utf-8');
  if (bytes > budgetBytes) {
    const fileCount = Array.isArray(d?.changedFiles) ? d.changedFiles.length : 0;
    return { overBudget: true, bytes, fileCount };
  }
  return { packet, bytes };
}
```

- [ ] **Step 4: Run it, verify PASS** (5/5):
`node --no-warnings --test test/drift/llm/buildL3Packet.test.js`

- [ ] **Step 5: Commit**

```
git -C /c/Project-TOAD add toad-local/src/drift/llm/buildL3Packet.js toad-local/test/drift/llm/buildL3Packet.test.js
git -C /c/Project-TOAD commit -m "feat(drift): buildL3Packet — scoped per-task packet + enforced 32KB budget

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `l3Gate.js` — pure predicate + pure cache-key hashes

**Files:**
- Create: `src/drift/llm/l3Gate.js`
- Test: `test/drift/llm/l3Gate.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/drift/llm/l3Gate.test.js`:

```javascript
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

// ── predicate ordering / decisions ──────────────────────────────────
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
test('silentButSignificant is a Slice-B stub returning false', () => {
  assert.equal(silentButSignificant({}), false);
});
test('ambiguity also true when an L1 finding is needsSemanticReview even with cache miss', () => {
  assert.equal(l3Gate(BASE).action, 'invoke');
});

// ── hash stability (design §3.3 + the +3 review assertions) ──────────
test('diffHash: stable to whitespace/format churn, changes on real content change', () => {
  const a = diffHash([{ file: 'x.rs', content: 'fn a(){}\n' }]);
  const b = diffHash([{ file: 'x.rs', content: 'fn a(){}   \n' }]); // trailing ws
  const c = diffHash([{ file: 'x.rs', content: 'fn b(){}\n' }]);     // real change
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
```

- [ ] **Step 2: Run it, verify FAIL** (module not found):
`node --no-warnings --test test/drift/llm/l3Gate.test.js`

- [ ] **Step 3: Create the module**

Create `src/drift/llm/l3Gate.js`:

```javascript
import { createHash } from 'node:crypto';

function sha1(s) { return createHash('sha1').update(String(s)).digest('hex'); }
function norm(s) {
  // Whitespace-stable: collapse runs of horizontal whitespace and trim
  // each line, drop trailing blank lines. The judge reasons about what
  // the code says, not diff formatting — so format churn must not bust
  // the verdict cache, but a real token change must.
  return String(s ?? '')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n+$/, '');
}

/** sha1 over sorted (file, sha1(normalized content)) pairs. */
export function diffHash(files) {
  const rows = (Array.isArray(files) ? files : [])
    .map((f) => `${f.file} ${sha1(norm(f.content))}`)
    .sort();
  return sha1(rows.join(''));
}

/** sha1 over the exact cache-invalidating provenance fields. */
export function specProvenanceHash(spec) {
  const p = spec && spec.provenance ? spec.provenance : {};
  return sha1(JSON.stringify({
    version: spec ? spec.version : undefined,
    reviewed: p.reviewed === true,
    extracted_at: p.extracted_at ?? null,
    extracted_by: p.extracted_by ?? null,
  }));
}

/** Order-independent sha1 over the finding fields that affect L3 input. */
export function l1FindingSetHash(findings) {
  const rows = (Array.isArray(findings) ? findings : []).map((f) => JSON.stringify({
    checkName: f.checkName ?? null, severity: f.severity ?? null,
    file: f.file ?? null, line: f.line ?? null, ruleId: f.ruleId ?? null,
    needsSemanticReview: f.needsSemanticReview === true,
  })).sort();
  return sha1(rows.join(''));
}

export function l3PromptHash(promptTemplate) { return sha1(promptTemplate ?? ''); }

export function l3CacheKey({ diffFiles, spec, l1Findings, promptTemplate } = {}) {
  return sha1([
    diffHash(diffFiles), specProvenanceHash(spec),
    l1FindingSetHash(l1Findings), l3PromptHash(promptTemplate),
  ].join('|'));
}

/** Slice-B stub. Slice B replaces ONLY this body (design §2). */
export function silentButSignificant(/* { snapshot, boundaryTaskId } */) {
  return false;
}

const SUBMISSION = new Set(['review', 'merge_ready', 'done']);

/**
 * Pure decision. The engine owns the verdict cache + rate window
 * (in-memory, like #tier2Cooldown) and passes `cacheHasKey`. Returns
 * one of: invoke | serve_cached | skip, with a reason.
 *
 * STEP ORDERING IS DELIBERATE AND NON-NEGOTIABLE: cheapest field
 * compares first (steps 1–3), the L1-findings walk next (step 4), the
 * caller's precomputed cache lookup last (step 5). The common case
 * (periodic, no L3) rejects in a single comparison. DO NOT reorder
 * "cache first to fail-fast on hits" — that defeats the §8a cost
 * discipline by forcing hash computation on runs that step 1 rejects.
 */
export function l3Gate({
  trigger, boundaryTo, boundaryTaskId, l1FindingsForTask, cacheHasKey,
  silentSignificant = false,
} = {}) {
  if (trigger === 'periodic') return { action: 'skip', reason: 'periodic' };
  if (trigger === 'task_event' && !SUBMISSION.has(boundaryTo)) {
    return { action: 'skip', reason: 'non_submission_status' };
  }
  if (trigger !== 'manual' && trigger !== 'task_event') {
    return { action: 'skip', reason: 'untriggered' };
  }
  if (typeof boundaryTaskId !== 'string' || boundaryTaskId.length === 0) {
    return { action: 'skip', reason: 'no_boundary_task' };
  }
  const flagged = Array.isArray(l1FindingsForTask)
    && l1FindingsForTask.some((f) => f && f.needsSemanticReview === true);
  const ambiguous = flagged || silentSignificant === true;
  if (!ambiguous) return { action: 'skip', reason: 'not_ambiguous' };
  if (trigger === 'manual') return { action: 'invoke', reason: 'manual_bypass' };
  if (cacheHasKey === true) return { action: 'serve_cached', reason: 'cache_hit' };
  return { action: 'invoke', reason: 'ambiguous' };
}
```

- [ ] **Step 4: Run it, verify PASS** (all green):
`node --no-warnings --test test/drift/llm/l3Gate.test.js`

- [ ] **Step 5: Commit**

```
git -C /c/Project-TOAD add toad-local/src/drift/llm/l3Gate.js toad-local/test/drift/llm/l3Gate.test.js
git -C /c/Project-TOAD commit -m "feat(drift): l3Gate pure predicate + cache-key hashes (Slice B stub wired)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `l3Judge.js` — Haiku→Sonnet single self-escalation

**Files:**
- Create: `src/drift/llm/l3Judge.js`
- Test: `test/drift/llm/l3Judge.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/drift/llm/l3Judge.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { l3Judge } from '../../../src/drift/llm/l3Judge.js';

// llmJudge is reused verbatim; we inject a fake judge to assert the
// Haiku→Sonnet single-escalation control flow + critical cap.
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
    { findings: [], rawText: '{}' },                                  // haiku, low
    { findings: [{ category: 'risk', severity: 'critical', title: 't', expected: 'e', actual: 'a', recommendedCorrection: 'c', evidence: [] }], rawText: '{}' }, // sonnet
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
```

- [ ] **Step 2: Run it, verify FAIL** (module not found):
`node --no-warnings --test test/drift/llm/l3Judge.test.js`

- [ ] **Step 3: Create the module**

Create `src/drift/llm/l3Judge.js`. Reuses `llmJudge` verbatim (HOME-isolated temp-brief spawn). `confidenceOf(callIndex, result)` extracts the model's self-reported confidence (default reads `result.rawText` JSON's `confidence`); injectable so the unit test drives the control flow deterministically. Caller (engine, Task 9) writes the packet to the temp brief + passes `briefPath`/`cwd`/`isolateHome` exactly as the old `checkLlmSemantic` did — those mechanics are reused, not reinvented.

```javascript
import { llmJudge as defaultLlmJudge } from './llmJudge.js';
import { buildL3SystemPrompt } from './prompts/l3.js';

function defaultConfidenceOf(_i, result) {
  try {
    const parsed = JSON.parse(String(result?.rawText ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    return parsed && parsed.confidence === 'low' ? 'low' : 'high';
  } catch { return 'high'; }
}

function capHaiku(findings) {
  return (Array.isArray(findings) ? findings : []).map((f) =>
    (f && f.severity === 'critical' ? { ...f, severity: 'high' } : f));
}

/**
 * Haiku-first; ONE Sonnet escalation iff Haiku self-reports
 * confidence:'low'. Never loops (exactly one escalation max). Haiku-
 * tier criticals capped to high — the tier-1-can't-emit-critical
 * invariant is INTRODUCED here (it previously lived only in the
 * deleted checkLlmSemantic.js:257; verified during spec review).
 * Throws on judge failure — the engine converts that to a
 * non-blocking meta and does NOT cache it.
 */
export async function l3Judge({
  packet, provider, systemPrompt, briefPath = null, cwd = null,
  isolateHome = false, timeoutMs = 30_000,
  llmJudgeImpl, confidenceOf = defaultConfidenceOf,
} = {}) {
  const judge = llmJudgeImpl || defaultLlmJudge;
  const sys = systemPrompt || buildL3SystemPrompt();

  const haiku = await judge({
    cli: provider.cli, model: provider.tier1, systemPrompt: sys,
    userPayload: packet, briefPath, cwd, isolateHome, timeoutMs,
  });
  if (confidenceOf(0, haiku) !== 'low') {
    return { findings: capHaiku(haiku.findings), tier: 'haiku', confidence: 'high', rawText: haiku.rawText };
  }
  // exactly one escalation — same packet, stronger model
  const sonnet = await judge({
    cli: provider.cli, model: provider.tier2, systemPrompt: sys,
    userPayload: packet, briefPath, cwd, isolateHome, timeoutMs,
  });
  const sonnetLow = confidenceOf(1, sonnet) === 'low';
  return {
    findings: sonnet.findings, // sonnet MAY emit critical (not capped)
    tier: 'sonnet-escalated',
    confidence: sonnetLow ? 'low' : 'high',
    rawText: sonnet.rawText,
  };
}
```

- [ ] **Step 4: Run it, verify PASS** (5/5):
`node --no-warnings --test test/drift/llm/l3Judge.test.js`

- [ ] **Step 5: Commit**

```
git -C /c/Project-TOAD add toad-local/src/drift/llm/l3Judge.js toad-local/test/drift/llm/l3Judge.test.js
git -C /c/Project-TOAD commit -m "feat(drift): l3Judge — Haiku→Sonnet single self-escalation, critical cap

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Atomic un-pause — engine rewrite + registry collapse + taxonomy + dead-code deletion + plumbing + lead prompt + dogfood

> This is intentionally one large task culminating in **one atomic commit** (design §8). All prior tasks were additive (new files unwired). This task wires them in, removes the dead path, and flips paused→live. Steps are bite-sized but the COMMIT is single (after the dogfood step passes).

**Files:**
- Modify: `src/drift/checks/checkKinds.js`, `src/drift/checks/index.js`, `src/drift/driftEngine.js`, `src/drift/driftMonitor.js`, `scripts/dev-api-server.mjs`, `src/team/teamSystemPrompts.js`, `test/drift/driftEngineLlm.test.js`, `package.json`
- Delete: `src/drift/checks/checkLlmSemantic.js`, `src/drift/llm/prompts/tier1.js`, `src/drift/llm/prompts/tier2.js`, `src/drift/llm/escalationGate.js`, `test/drift/checks/checkLlmSemantic.test.js`, `test/drift/llm/escalationGate.test.js`

- [ ] **Step 1: `checkKinds.js` taxonomy lockstep**

In `src/drift/checks/checkKinds.js` `CHECK_KIND`, delete the two lines `check_llm_semantic_t1: 'drift',` and `check_llm_semantic_t2: 'drift',`; add `check_llm_semantic: 'drift',` in their place. In `test/drift/checks/checkKinds.test.js`, update any assertion enumerating the drift names accordingly (replace the two `_t1`/`_t2` expectations with `check_llm_semantic`). Run `node --no-warnings --test test/drift/checks/checkKinds.test.js` → green.

- [ ] **Step 2: Registry collapse (`checks/index.js`)**

Remove the two lines:
```javascript
  { name: 'check_llm_semantic_t1', tier: 1, fn: (args) => checkLlmSemantic({ ...args, tier: 1 }) },
  { name: 'check_llm_semantic_t2', tier: 2, fn: (args) => checkLlmSemantic({ ...args, tier: 2 }) },
```
and the now-unused `import { checkLlmSemantic } from './checkLlmSemantic.js';`. `ALL_CHECKS` is now the deterministic L1 set only. Replace the `DETERMINISTIC_CHECKS`/`ALL_CHECKS` back-compat split with a single export — keep BOTH names as aliases of the one frozen list so existing imports don't break:

```javascript
// One check set: L3 is gate-invoked by the engine, NOT a registry
// tier entry (design §4.4/§8). Both names retained as aliases so
// existing import sites keep working without churn.
export const DETERMINISTIC_CHECKS = ALL_CHECKS;
```
(Delete the old `.filter((c) => c.tier === 1 && !c.name.startsWith('check_llm_'))` definition.) `withKind` still runs over every entry; the `kindForCheck` guard now never sees an LLM tier entry.

- [ ] **Step 3: Engine — boundary plumbing + settings + maps**

In `src/drift/driftEngine.js`:
- `DEFAULT_SETTINGS.drift`: remove `escalationThreshold`, `tier2CooldownMs`, `tier2ScoreDelta` (escalationGate is deleted); keep `tier1ModelOverride`/`tier2ModelOverride`/`llmTierEnabled`/`periodicCooldownMs`; add `l3RateCapPerHour: 30,` and `l3PacketBudgetBytes: 32 * 1024,`.
- Replace `import { escalationGate } from './llm/escalationGate.js';` with:
  ```javascript
  import { l3Gate, l3CacheKey } from './llm/l3Gate.js';
  import { buildL3Packet } from './llm/buildL3Packet.js';
  import { l3Judge } from './llm/l3Judge.js';
  import { resolveProvider } from './llm/providerResolver.js';
  import { L3_PROMPT_TEMPLATE } from './llm/prompts/l3.js';
  import os from 'node:os'; import fs from 'node:fs'; import path from 'node:path';
  ```
- Replace the `#tier2Cooldown` field with: `#l3VerdictCache = new Map(); // teamId -> Map(key -> verdict)` and `#l3RateWindow = new Map(); // teamId -> number[] (this.now() timestamps)`.
- `runDrift({ teamId, trigger='manual', boundaryTaskId=null, boundaryTo=null })` — add the two optional params; a doc-comment: *"boundaryTaskId/boundaryTo are populated iff the run is task-event-or-manual-scoped; their absence signals 'not a transition event'."* Thread them into `#runDriftInner({ teamId, trigger, boundaryTaskId, boundaryTo })` and onto the snapshot (`buildSnapshot` already returns an object — set `snapshot.boundaryTaskId = boundaryTaskId; snapshot.boundaryTo = boundaryTo;` right after it's built, before checks run, so `diffsByTask` etc. are present for the packet).

- [ ] **Step 4: Engine — replace the escalationGate/tier-2 block with the L3 gate path**

In `#runDriftInner`, replace the entire `// Decide tier 2.` … through the end of the `} else if (tier2Checks.length > 0) { … }` block (the `escalationGate` block, ~lines 178–229) with the L3 path below. (`tier1Checks`/`tier1Findings`/`tier1Score` stay — L1 deterministic checks are unchanged; `tier2Checks` partition is removed since no registry entry is tier 2 anymore.)

```javascript
    // ── L3: scoped, task-boundary, ambiguity-gated adjudication ──────
    let l3Findings = [];
    let l3Status = 'skipped:not_invoked';
    if (llmEnabled) {
      const taskFindings = tier1Findings.filter((f) => f.taskId === boundaryTaskId);
      const decision = l3Gate({
        trigger,
        boundaryTo,
        boundaryTaskId,
        l1FindingsForTask: taskFindings,
        cacheHasKey: false, // refined just below only if we get that far
        silentSignificant: false, // Slice B fills this
      });
      if (decision.action !== 'skip') {
        const spec = snapshot.spec ?? null;
        const d = snapshot.diffsByTask?.[boundaryTaskId] || null;
        const diffFiles = d && Array.isArray(d.changedFiles)
          ? d.changedFiles.map((file) => ({ file, content: typeof d.diff === 'string' ? d.diff : '' }))
          : [];
        const key = l3CacheKey({ diffFiles, spec, l1Findings: taskFindings, promptTemplate: L3_PROMPT_TEMPLATE });
        const teamCache = this.#l3VerdictCache.get(teamId) || new Map();
        const cached = teamCache.get(key) || null;

        if (trigger !== 'manual' && cached) {
          l3Findings = cached.findings;
          l3Status = `served_cached:${cached.tier}`;
        } else {
          // Circuit breaker (config-tunable; observer-severity on trip).
          const capPerHour = typeof driftSettings.l3RateCapPerHour === 'number' ? driftSettings.l3RateCapPerHour : 30;
          const windowMs = 60 * 60 * 1000;
          const nowТs = this.now();
          const win = (this.#l3RateWindow.get(teamId) || []).filter((t) => nowТs - t < windowMs);
          if (win.length >= capPerHour) {
            this.#l3RateWindow.set(teamId, win);
            l3Findings = [this.#l3Meta(runId, teamId, 'observer', 'rate_cap',
              `L3 rate cap hit (${capPerHour}/h) — investigate the drift system; deterministic L1 findings still apply`)];
            l3Status = 'skipped:rate_cap';
          } else {
            const built = buildL3Packet({
              snapshot, boundaryTaskId,
              l1Signal: { kind: 'flagged', findings: taskFindings.filter((f) => f.needsSemanticReview === true) },
              budgetBytes: driftSettings.l3PacketBudgetBytes,
            });
            if (built.overBudget) {
              l3Findings = [this.#l3Meta(runId, teamId, 'info', 'over_budget',
                `L3 packet over budget for task ${boundaryTaskId} (${built.bytes}B, ${built.fileCount} files) — semantic adjudication skipped; deterministic L1 findings still apply`)];
              l3Status = 'skipped:over_budget';
            } else {
              // Temp brief + HOME-isolated spawn — reuse the proven
              // mechanics from the deleted checkLlmSemantic verbatim.
              const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-l3-'));
              const briefPath = path.join(dir, 'brief.md');
              let isolateHome = false;
              try {
                fs.writeFileSync(briefPath, built.packet, 'utf-8');
                const realCreds = path.join(os.homedir(), '.claude', '.credentials.json');
                if (fs.existsSync(realCreds)) {
                  const cdir = path.join(dir, '.claude');
                  fs.mkdirSync(cdir, { recursive: true });
                  fs.copyFileSync(realCreds, path.join(cdir, '.credentials.json'));
                  isolateHome = true;
                }
              } catch { /* fall back to inline */ }
              try {
                const provider = resolveProvider({ teamConfig: snapshot.teamConfig, settings: this.settings, tier: 1 });
                const verdict = await l3Judge({
                  packet: built.packet,
                  provider: { cli: provider.cli, tier1: provider.model,
                    tier2: resolveProvider({ teamConfig: snapshot.teamConfig, settings: this.settings, tier: 2 }).model },
                  briefPath, cwd: dir, isolateHome, timeoutMs: 30_000,
                });
                l3Findings = verdict.findings.map((f) => ({
                  id: `f_l3_${teamId}_${boundaryTaskId}_${f.title}`.slice(0, 200),
                  runId, teamId, taskId: boundaryTaskId,
                  category: f.category, severity: f.severity,
                  checkName: 'check_llm_semantic',
                  kind: kindForCheck('check_llm_semantic'),
                  title: f.title, evidence: f.evidence,
                  expected: f.expected, actual: f.actual,
                  recommendedCorrection: f.recommendedCorrection,
                  autoFixable: false,
                }));
                teamCache.set(key, { findings: l3Findings, tier: verdict.tier });
                this.#l3VerdictCache.set(teamId, teamCache);
                this.#l3RateWindow.set(teamId, [...win, nowТs]);
                l3Status = `completed:${verdict.tier}`;
              } catch (err) {
                // Failure → non-blocking meta, NOT cached (transient → retry next boundary).
                l3Findings = [this.#l3Meta(runId, teamId, 'medium', 'judge_failed',
                  err && err.message ? err.message : String(err))];
                l3Status = 'failed';
                this.#l3RateWindow.set(teamId, [...win, nowТs]);
              } finally {
                try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
              }
            }
          }
        }
      } else {
        l3Status = `skipped:${decision.reason}`;
      }
    } else {
      l3Status = 'skipped:disabled';
    }
```

> NOTE on the `nowТs` identifier above: that is a transcription guard — when implementing, use a plain ASCII name `nowTs`. (The plan author flags this so the engineer types `nowTs`, not a homoglyph.)

> **Controller ratification (2026-05-16) — code-quality review, two Important fixes. SUPERSEDES the gate/cache structure shown in the Step-4 code block above.**
>
> **Fix A — `l3Gate` is the single decision authority (design §3); the `cacheHasKey: false` placeholder + the post-gate `if (trigger !== 'manual' && cached)` are a defect.** The block above calls the gate with `cacheHasKey: false` and a comment "refined just below" that never refines, then re-implements serve-vs-invoke after the gate. That makes the gate's `serve_cached` branch dead and forks the decision authority (a Slice-B hazard — Slice B builds on `decision.action`). But naïvely "compute the key before the gate" would hash `sha1(scoped-diff + whole spec.json + L1 + prompt)` on **every periodic tick**, defeating the gate's deliberate hash-last ordering (`l3Gate.js` step-ordering comment) and the reform's cost ethos. Implement the **two-phase** structure instead — replace everything from `const decision = l3Gate({` down to and including the `if (trigger !== 'manual' && cached) { … } else {` line with:
>
> ```javascript
>       // Phase-1 gate (cacheHasKey:false): cheap steps 1–4 + manual.
>       // Periodic/non-submission/not-ambiguous skip here WITHOUT paying
>       // the cache-key hash (design §3 gate-ordering discipline).
>       const gate1 = l3Gate({
>         trigger, boundaryTo, boundaryTaskId,
>         l1FindingsForTask: taskFindings,
>         cacheHasKey: false,
>         silentSignificant: false, // Slice B fills this
>       });
>       if (gate1.action === 'skip') {
>         l3Status = `skipped:${gate1.reason}`;
>       } else {
>         const spec = snapshot.spec ?? null;
>         const d = snapshot.diffsByTask?.[boundaryTaskId] || null;
>         const diffFiles = d && Array.isArray(d.changedFiles)
>           ? d.changedFiles.map((file) => ({ file, content: typeof d.diff === 'string' ? d.diff : '' }))
>           : [];
>         const key = l3CacheKey({ diffFiles, spec, l1Findings: taskFindings, promptTemplate: L3_PROMPT_TEMPLATE });
>         const teamCache = this.#l3VerdictCache.get(teamId) || new Map();
>         // Phase-2: authoritative serve_cached vs invoke. manual already
>         // short-circuited to invoke/manual_bypass in gate1 (its
>         // cacheHasKey is irrelevant) — reuse gate1, don't re-call.
>         const decision = gate1.reason === 'manual_bypass'
>           ? gate1
>           : l3Gate({
>               trigger, boundaryTo, boundaryTaskId,
>               l1FindingsForTask: taskFindings,
>               cacheHasKey: teamCache.has(key),
>               silentSignificant: false,
>             });
>         if (decision.action === 'serve_cached') {
>           const cached = teamCache.get(key);
>           l3Findings = cached.findings;
>           l3Status = `served_cached:${cached.tier}`;
>         } else {
> ```
>
> The middle (circuit breaker → `buildL3Packet` → HOME-isolated spawn → `l3Judge` → cache `set`) is **unchanged**. The OLD trailing `} else { l3Status = \`skipped:${decision.reason}\`; }` that closed `if (decision.action !== 'skip')` is **removed** — the skip is now the leading `if (gate1.action === 'skip')` and `decision` is block-scoped to the non-skip branch; the brace structure (one outer if/else, one inner if/else) is otherwise preserved, with the inner `else` remaining the circuit-breaker/judge path and the outer `} else { l3Status = 'skipped:disabled'; }` for `if (llmEnabled)` unchanged. Outcomes are identical to the old code on every path (gate1 reproduces the old skip reasons; manual_bypass reproduces the old `trigger !== 'manual'` bypass; serve_cached reproduces the old `cached` serve) so `l3Gate.test.js`, `driftEngineLlm.test.js`, the full suite, and the Reaper dogfood all stay green.
>
> **Fix B — `observer` severity taxonomy lockstep (the severity analogue of the Step-1 `checkKinds` *kind* lockstep, which the plan omitted).** The circuit-breaker trip emits `severity: 'observer'` (design §3.4, user-ratified). `observer` is net-new and absent from the severity taxonomy, so the operator alert NaNs the DriftScreen sort and renders an invisible badge. Propagate `observer` in lockstep (do NOT downgrade to `info` — that violates the ratified design):
> - `src/drift/scoreFindings.js` `SEVERITY_WEIGHT`: add `observer: 0` (explicit; `weightOf` already defaults unknown→0, so score-neutral — observer is surfaced-but-never-scored/blocking by design). Add/extend a `scoreFindings` test asserting an `observer` finding contributes 0 to the score and is retained in output.
> - `ui/src/hooks/useDrift.ts` (`severity:` union, ~line 10): add `'observer'`.
> - `ui/src/components/DriftScreen.tsx`: `SEVERITY_ORDER` add `observer: -1` (sorts below `info`); `SEVERITY_COLOR` add `observer: 'var(--accent, #7aa2f7)'` (distinct operator tone); the severity filter list (`['critical','high','medium','low','info']`, ~line 176) add `'observer'`.
> No engine/severity-string change; `driftEngine.js` keeps emitting `'observer'`.
>
> **Fix C — CRITICAL (T9 final whole-implementation review): the un-pause is inert without a whole-tree-finding-aware boundary filter.** The Step-4 line `const taskFindings = tier1Findings.filter((f) => f.taskId === boundaryTaskId);` drops 100% of the real L1→L3 signal: both production `needsSemanticReview` producers (`check_structural_undeclared_present`, `check_constitution` observe-mode) emit `taskId: null` (whole-tree scanners — see design §5 ratified note). With a real non-null `boundaryTaskId` the filter yields `[]` → `l3Gate` → `not_ambiguous` → L3 never fires. Replace that line with:
> ```javascript
>       const taskFindings = tier1Findings.filter(
>         (f) => f.taskId === boundaryTaskId
>           || (f.taskId === null && f.needsSemanticReview === true),
>       );
> ```
> (Safe on every path: l3Gate's `no_boundary_task` skip fires before the ambiguity check, so a null/empty `boundaryTaskId` still skips even though the first clause would match `taskId:null`; periodic skips at step 1; cache key includes per-task `diffHash` so team-level flagged findings don't collide across tasks.) **Mandatory companion fix:** `test/drift/driftEngineLlm.test.js`'s `flaggingCheck` currently emits `taskId` = the boundary id, which *masked* this bug — change it to emit `taskId: null` (mirroring the real checks) so the contract is regression-locked; the run still passes `boundaryTaskId:'task-1'` and the resulting L3 finding is still stamped `taskId: boundaryTaskId` (engine line ~287), so the existing assertions hold. Also fix the stale `escalationGate` mention in `src/drift/checks/index.js`'s registry doc-comment (the path is deleted). The `ui/src/components/findingTier.ts` stale `_t1/_t2` badge mapping is a non-blocking cosmetic follow-up (tracked separately), out of this atomic commit.

Then change the findings-combine to fold `l3Findings` in place of `tier2Findings`:
```javascript
    const findingsById = new Map();
    for (const f of [...tier1Findings, ...l3Findings]) {
      if (f && typeof f.id === 'string') findingsById.set(f.id, f);
    }
```
And in the returned `DriftRunResult`, replace the `llm: { tier1, tier2 }` field with `l3: { status: l3Status }` (update `test/drift/driftEngineLlm.test.js` accordingly in Step 7). Add the private helper:
```javascript
  #l3Meta(runId, teamId, severity, code, detail) {
    return {
      id: `f_l3_${code}_${teamId}`, runId, teamId, taskId: null,
      category: 'risk', severity,
      checkName: 'check_llm_semantic', kind: 'drift',
      title: `L3 ${code.replace(/_/g, ' ')}`,
      evidence: [detail], expected: 'L3 adjudication available',
      actual: detail,
      recommendedCorrection: code === 'rate_cap'
        ? 'Investigate the drift trigger/cache/ambiguity predicate for a loop.'
        : 'Transient/infrastructure — usually clears next boundary.',
      autoFixable: false,
    };
  }
```
Remove the `let tier2Findings`/`tier2Status` declarations and the `tier2Checks` partition line (`const tier2Checks = this.checks.filter((c) => c.tier === 2);`) — nothing is tier 2 now.

- [ ] **Step 5: driftMonitor — thread taskId, narrow boundary set**

In `src/drift/driftMonitor.js`: change `TRIGGER_TRANSITIONS` from `['review','testing','merge_ready','done']` to `['review','merge_ready','done']` (drop `testing` — design §3.2). Change `notifyTaskEvent({ teamId, eventType, payload })` to also accept `taskId`, and the `runDrift` call to `await this.engine.runDrift({ teamId, trigger: 'task_event', boundaryTaskId: taskId, boundaryTo: payload?.to })`. Update `test/drift/driftMonitor.test.js`: the mock-engine assertions for the dropped `testing` transition (now a no-op) and the new `boundaryTaskId`/`boundaryTo` args; run it green.

- [ ] **Step 6: dev-api-server — pass taskId + flip the wiring (THE un-pause)**

In `scripts/dev-api-server.mjs`: in the `runtime.taskBoard.subscribe(...)` handler add `taskId: event.taskId` to the `notifyTaskEvent({...})` call. Change the import line 9 from `import { DETERMINISTIC_CHECKS } from '../src/drift/checks/index.js';` to `import { ALL_CHECKS } from '../src/drift/checks/index.js';` and the engine `checks: DETERMINISTIC_CHECKS,` to `checks: ALL_CHECKS,`. Update the 2026-05-15 "LLM judge paused" comment block to a one-liner: *"L3 is gate-invoked by the engine (design 2026-05-15-l3-reform); ALL_CHECKS is the single deterministic set + L3 fires only at task boundaries on L1 ambiguity."* (manual Run-Drift already passes `trigger:'manual'` via the facade `drift_run` path — no facade change needed; verify by reading `localToolFacade.js`'s `drift_run` handler and confirm it forwards `trigger` and, for manual, that `boundaryTaskId` is null which the gate treats as `no_boundary_task` → skip unless a task-scoped manual is later added; manual with no boundary task is an acceptable no-op for Slice A and documented in §3.2).

- [ ] **Step 7: Lead prompt + driftEngineLlm test rewrite + dead-code deletion**

(a) `src/team/teamSystemPrompts.js` lead guidance — add one sentence (match the file's array/string convention used by the merge-gate line added earlier): *"When a task is in review and an L3 semantic-drift finding exists for it, bundle that finding's title/expected/actual/recommendedCorrection and its confidence into the review-request message you send the reviewer — one coherent review packet, not a separate message; do not wait for merge_ready."*
(b) Rewrite `test/drift/driftEngineLlm.test.js` to exercise the L3 path: a `task_event` run with a `needsSemanticReview` L1 finding + an injected `l3Judge`/`llmJudge` → L3 findings merged, verdict cached; a second `task_event` same key → served from cache (no second judge call); `manual` → bypasses cache; `periodic` → L3 never invoked; over-budget → meta + skip; judge failure → meta, not cached; rate-cap → observer meta. (Use the existing `bootstrapDb`/`makeDeps`/`SqliteDriftStore` harness from `driftEngine.test.js`; inject the judge via the engine's `checks`? No — L3 is engine-internal now; expose an injectable `l3JudgeImpl` on the `DriftEngine` constructor for tests, defaulting to the real `l3Judge`, and thread it into the Step-4 `l3Judge({...})` call. Add that constructor option + default in Step 3's constructor edit.)
(c) Delete the dead files: `git -C /c/Project-TOAD rm toad-local/src/drift/checks/checkLlmSemantic.js toad-local/src/drift/llm/prompts/tier1.js toad-local/src/drift/llm/prompts/tier2.js toad-local/src/drift/llm/escalationGate.js toad-local/test/drift/checks/checkLlmSemantic.test.js toad-local/test/drift/llm/escalationGate.test.js`
(d) `package.json` test script: remove the entries `&& node --no-warnings --test test/drift/checks/checkLlmSemantic.test.js` and `&& node --no-warnings --test test/drift/llm/escalationGate.test.js`; add `&& node --no-warnings --test test/drift/llm/prompts/l3.test.js && node --no-warnings --test test/drift/llm/buildL3Packet.test.js && node --no-warnings --test test/drift/llm/l3Gate.test.js && node --no-warnings --test test/drift/llm/l3Judge.test.js && node --no-warnings --test test/drift/findingSchema.test.js` adjacent to the other drift entries.

- [ ] **Step 8: Full suite green**

Run: `cd /c/Project-TOAD/toad-local && npm test 2>&1 | grep -E "^# (fail|pass)" | awk '{a[$2]+=$3} END {for (k in a) print k, a[k]}'`
Expected: `fail 0`. Fix any breakage from the engine refactor / deleted-module imports before proceeding. Do not commit yet.

- [ ] **Step 9: Dogfood on real Reaper (gate before the commit)**

Run this one-off (no repo mutation) — exercises the real gate + packet + a stubbed judge against the real Reaper spec:

```bash
cd /c/Project-TOAD/toad-local && node --input-type=module -e '
import { l3Gate, l3CacheKey } from "./src/drift/llm/l3Gate.js";
import { buildL3Packet } from "./src/drift/llm/buildL3Packet.js";
import { loadProjectSpec } from "./src/drift/spec/loadProjectSpec.js";
const projectCwd = "C:/Users/Nova_/Downloads/New folder (6)";
const { spec } = loadProjectSpec({ projectCwd });
const flagged = [{ checkName:"check_constitution", severity:"medium", file:"src/win/procs.rs", line:1, ruleId:"no-sedebug-privilege", needsSemanticReview:true }];
// periodic → never
console.log("periodic:", JSON.stringify(l3Gate({ trigger:"periodic", boundaryTo:"review", boundaryTaskId:"T1", l1FindingsForTask:flagged, cacheHasKey:false })));
// review + flagged → invoke
console.log("review+flagged:", JSON.stringify(l3Gate({ trigger:"task_event", boundaryTo:"review", boundaryTaskId:"T1", l1FindingsForTask:flagged, cacheHasKey:false })));
// review + no flag → skip
console.log("review+clean:", JSON.stringify(l3Gate({ trigger:"task_event", boundaryTo:"review", boundaryTaskId:"T1", l1FindingsForTask:[{checkName:"x",severity:"low",file:"a",line:1,ruleId:null}], cacheHasKey:false })));
const built = buildL3Packet({ snapshot:{ teamId:"reaper", spec, diffsByTask:{ T1:{ changedFiles:["src/win/procs.rs"], diff:"+ enable(SeDebugPrivilege);\n", error:null } } }, boundaryTaskId:"T1", l1Signal:{ kind:"flagged", findings:flagged } });
console.log("packet inBudget:", built.overBudget !== true, "bytes:", built.bytes, "hasSpec:", /\"version\"/.test(built.packet||""), "noProse:", !/^#{1,2}\s+(Product Brief|Foundry|Goals|Non-Goals|Requirements|EARS)\b/mi.test(built.packet||""));
console.log("cacheKey stable:", l3CacheKey({diffFiles:[{file:"a",content:"x"}],spec,l1Findings:flagged,promptTemplate:"P"}) === l3CacheKey({diffFiles:[{file:"a",content:"x"}],spec,l1Findings:flagged,promptTemplate:"P"}));
'
```
Expected: `periodic:{...skip,periodic}`, `review+flagged:{...invoke,ambiguous}`, `review+clean:{...skip,not_ambiguous}`, `packet inBudget: true`, `hasSpec: true`, `noProse: true`, `cacheKey stable: true`. If any line is wrong, fix before the commit.

> **Controller ratification (2026-05-16) — harness-only reconciliation, engine is correct.** The original Step-9 one-liner asserted `built.overBudget === false` and `!/product-brief|## Foundry/`. Both were *verification-harness defects* contradicting frozen, already-shipped Task 1–8 contracts — corrected above with **zero engine/T6/src/test change**:
> 1. `buildL3Packet` (T6) returns `{packet,bytes}` with **no `overBudget` key** on the success path (only `{overBudget:true,...}` when over budget). So in-budget ⇒ `built.overBudget === undefined`, never the literal `false`. The engine's `if (built.overBudget)` correctly treats `undefined` as falsy. The harness now asserts `built.overBudget !== true` ("in budget" = absence of the over-budget signal).
> 2. The L3 packet embeds the **whole `spec.json` including `spec.provenance.source_docs`** — this is ratified design §4.1 ("the whole spec.json") and is what `specProvenanceHash` hashes. A real spec's provenance legitimately *names* `docs/foundry/product-brief.md` as a source filename, so the blunt `product-brief` substring regex false-positived even though the packet contains **zero brief prose** (verified: single occurrence, inside the JSON `source_docs` array; no `## Foundry`, no EARS body, 5.1 KB scoped packet — not a whole-brief dump). The corrected `noProse` regex targets brief-prose **headings** (`# Product Brief`, `## Goals`, `## EARS …`), which is the actual doctrinal invariant ("never the brief prose"), not foundry filename strings inside the machine-checkable spec. **Do NOT strip `provenance` from the packet or alter `buildL3Packet`'s return shape to satisfy the old harness — that would break the frozen T6 contract and `specProvenanceHash` cache semantics.**

- [ ] **Step 10: The single atomic un-pause commit**

```
git -C /c/Project-TOAD add -A toad-local/src/drift toad-local/scripts/dev-api-server.mjs toad-local/src/team/teamSystemPrompts.js toad-local/test/drift toad-local/package.json
git -C /c/Project-TOAD commit -m "$(cat <<'EOF'
feat(drift): un-pause L3 — scoped task-boundary judge, gate-invoked

Atomic paused→live flip (design §8). Engine replaces the
escalationGate/tier-2 block with l3Gate→buildL3Packet→l3Judge
(Haiku→Sonnet single self-escalation), per-team in-memory verdict
cache (ETag-style key incl. l3PromptHash), config observer-severity
rate cap, over-budget→meta+skip, failure→meta-not-cached. Registry
collapses to one set (DETERMINISTIC_CHECKS aliases ALL_CHECKS);
check_llm_semantic_t1/_t2 + checkLlmSemantic + tier1/tier2 prompts +
escalationGate deleted; checkKinds updated in lockstep. driftMonitor
narrowed to review|merge_ready|done + threads taskId; dev-api-server
flipped to ALL_CHECKS + passes event.taskId; lead bundles L3 into the
review packet. Dogfooded on real Reaper (periodic→skip, review+flagged
→invoke, review+clean→skip, packet in-budget/spec-embedded/no-prose,
cache key stable). Suite green.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review (plan author)

**1. Spec coverage:** §2 2-slice (Slice A here; B = `silentButSignificant` stub T7) ✓. §3.1 plumbing (T9 S3/S5/S6) ✓. §3.2 5-step predicate + ordering comment (T7) ✓. §3.3 four hashes incl. l3PromptHash (T7) ✓. §3.4 config observer-severity circuit breaker + no-cache-pollution-on-skip (T9 S4) ✓. §4.1 scoped packet + enforced budget→meta+skip (T6, T9 S4) ✓. §4.2 scoped prompt (T5) ✓. §4.3 Haiku→Sonnet one-escalation + critical cap INTRODUCED (T8) ✓. §4.4 engine integration + taxonomy passthrough + checkKinds lockstep (T9 S1/S2/S4) ✓. §4.5 failure→meta-not-cached (T8, T9 S4) ✓. §5 two flagged classes (T2, T3) ✓. §6 lead review-packet bundling (T9 S7a) ✓. §7 TDD incl. hash-stability +3 + schema snapshot (T7, T4) ✓. §8 atomic un-pause (T9 S10) ✓. §9 non-goals respected (no Slice B, no non-submission statuses, providerResolver kept). Appendix A deferred — not in plan ✓.

**2. Placeholder scan:** none — every step has full code or exact edit instructions with the literal strings. The `nowТs`→`nowTs` homoglyph is explicitly flagged as a transcription guard, not a placeholder.

**3. Type consistency:** `l3Gate` returns `{action,reason}` (T7) consumed identically in T9 S4. `buildL3Packet` returns `{packet,bytes}|{overBudget,bytes,fileCount}` (T6) consumed exactly in T9 S4. `l3Judge` returns `{findings,tier,confidence,rawText}` (T8) consumed in T9 S4. `l3CacheKey({diffFiles,spec,l1Findings,promptTemplate})` (T7) called with exactly those keys in T9 S4. `checkName:'check_llm_semantic'` consistent across T1-config (none), T9 S1 (checkKinds), T9 S4 (engine stamping), `kindForCheck('check_llm_semantic')` returns `'drift'` (T9 S1). `needsSemanticReview:true` shape identical T2/T3/T4/T7. Boundary param names `boundaryTaskId`/`boundaryTo` identical across T9 S3/S5/S6 and `l3Gate` input.

---
