# A4 — First-Turn MCP-Tool Visibility Probe (cross-adapter) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A broken/missing `toad` MCP rail must fail loudly on the first turn (`turn_failed("TOAD tools unavailable…")`) for every session adapter (Codex/Gemini/OpenCode) instead of producing a silently mute agent.

**Architecture:** One shared pure core `src/runtime/firstTurnMcpProbe.js` (normalizer-pure-core precedent — no IO, total, never-throws): `buildProbeInstruction()` appends a tool-call+sentinel instruction to the FIRST-turn prompt only; `evaluateFirstTurnProbe(events)` is satisfied iff a first-turn `assistant_text` contains the sentinel (the only event channel grounded for all 3 providers). Each session adapter gets an identical thin first-turn hook; resume turns skip the probe; Claude is out (own `can_use_tool` duplex). Spec: `docs/superpowers/specs/2026-05-18-a4-mcp-visibility-probe-design.md`.

**Tech Stack:** Node ESM, `node --test`, injected `spawnImpl` fake-child harness, the existing `{Codex,Gemini,Opencode}ExecAdapter` + their normalizers + `src/mcp/localToolDefinitions.js`, `scripts/test-suites.txt`.

---

## Scope

3 session adapters only. Claude/`ClaudeStreamJsonAdapter`/`CodexFoundryAdapter` byte-unchanged. No grounding of any provider's `tool_use` event shape (later hardening). No SP2/3/4/UI.

## File Structure

- **Create** `src/runtime/firstTurnMcpProbe.js` — pure: `PROBE_SENTINEL` const, `buildProbeInstruction()`, `evaluateFirstTurnProbe(events)`.
- **Create** `test/runtime/firstTurnMcpProbe.test.js` — pure-core deepest coverage.
- **Modify** `src/runtime/CodexExecAdapter.js`, `src/runtime/GeminiExecAdapter.js`, `src/runtime/OpencodeExecAdapter.js` — identical first-turn hook.
- **Create** `test/codex/codexExecAdapter.a4probe.test.js`, `test/gemini/geminiExecAdapter.a4probe.test.js`, `test/opencode/opencodeExecAdapter.a4probe.test.js` — per-adapter lifecycle.
- **Create** `test/bundle/a4ProbeE2e.test.js` + extend the 3 grounded fixtures with a broken-rail mode (or add `test/fixtures/fake-*-a4.mjs` as needed).
- **Modify** `scripts/test-suites.txt` (single-line wire), `README.md`, `docs/ARCHITECTURE.md`.

---

### Task 1: The pure `firstTurnMcpProbe` core (TDD) + ground the real TOAD tool name

**Files:** Create `src/runtime/firstTurnMcpProbe.js`, `test/runtime/firstTurnMcpProbe.test.js`.

- [ ] **Step 1: Ground the tool name (free, in-codebase).** Read `src/mcp/localToolDefinitions.js`. Pick a real TOAD MCP tool that is **read-only, requires NO arguments, side-effect-free** (e.g. a project/state describe or list tool with an empty/optional schema and no idempotencyKey requirement — `localToolDefinitions.js` marks read-only tools; the existing `localMcpToolDefinitions.test.js` enumerates "read-only … without idempotencyKey"). Record the exact chosen tool name; if no zero-arg read-only tool exists, pick the read-only tool with the simplest satisfiable args and encode those args in the instruction. (Grounded contingency: the literal name is read from the real definitions, not invented.)

- [ ] **Step 2: RED — pure-core tests.** Create `test/runtime/firstTurnMcpProbe.test.js`:

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_SENTINEL, buildProbeInstruction, evaluateFirstTurnProbe } from '../../src/runtime/firstTurnMcpProbe.js';

test('buildProbeInstruction names the grounded read-only TOAD tool and the exact sentinel', () => {
  const s = buildProbeInstruction();
  assert.equal(typeof s, 'string');
  assert.ok(s.includes(PROBE_SENTINEL), 'instruction must contain the sentinel token');
  assert.ok(/<TOOLNAME>/.test(s) === false, 'no placeholder');
  assert.ok(s.includes('<GROUNDED_TOOL_NAME>'), 'instruction references the grounded tool name'); // replace literal with the Step-1 name
});

test('evaluateFirstTurnProbe satisfied iff an assistant_text contains the sentinel', () => {
  const base = { runtimeId: 'r', teamId: 't', agentId: 'a' };
  assert.equal(evaluateFirstTurnProbe([{ ...base, type: 'assistant_text', text: `hi ${PROBE_SENTINEL} done` }]).satisfied, true);
  assert.equal(evaluateFirstTurnProbe([{ ...base, type: 'assistant_text', text: 'no token here' }]).satisfied, false);
  assert.equal(evaluateFirstTurnProbe([{ ...base, type: 'tool_use', toolName: 'x' }]).satisfied, false);
  assert.equal(evaluateFirstTurnProbe([]).satisfied, false);
});

test('evaluateFirstTurnProbe is total — never throws on garbage', () => {
  for (const bad of [null, undefined, 42, 'x', [null], [{}], [{ type: 'assistant_text' }], { not: 'array' }]) {
    assert.doesNotThrow(() => evaluateFirstTurnProbe(bad));
    assert.equal(evaluateFirstTurnProbe(bad).satisfied, false);
  }
});
```

Replace `<GROUNDED_TOOL_NAME>` with the Step-1 tool name. Run `cd /c/Project-TOAD/toad-local && node --test --no-warnings test/runtime/firstTurnMcpProbe.test.js` → FAIL (module missing).

- [ ] **Step 3: GREEN.** Create `src/runtime/firstTurnMcpProbe.js`:

```javascript
// A4: first-turn MCP-tool visibility probe (shared pure core). No IO,
// total, never-throws. Consumed by the 3 session adapters' first turn.
export const PROBE_SENTINEL = '⟦TOAD_MCP_OK⟧';

// <GROUNDED_TOOL_NAME> = the real read-only, no-arg, side-effect-free TOAD
// MCP tool grounded from src/mcp/localToolDefinitions.js (Task 1 Step 1).
const PROBE_TOOL = '<GROUNDED_TOOL_NAME>';

export function buildProbeInstruction() {
  return [
    'TOAD MCP CONNECTIVITY CHECK (do this first, once):',
    `Before anything else, call the read-only TOAD MCP tool \`${PROBE_TOOL}\` (no arguments).`,
    `ONLY if that tool call returns successfully, include the exact token ${PROBE_SENTINEL} verbatim somewhere in your reply this turn.`,
    `If you cannot see or call that tool, do NOT emit the token. Then continue with the task normally.`,
  ].join(' ');
}

export function evaluateFirstTurnProbe(events) {
  if (!Array.isArray(events)) return { satisfied: false, reason: 'no events' };
  for (const ev of events) {
    if (ev && ev.type === 'assistant_text' && typeof ev.text === 'string' && ev.text.includes(PROBE_SENTINEL)) {
      return { satisfied: true, reason: 'sentinel observed in assistant_text' };
    }
  }
  return { satisfied: false, reason: 'sentinel not observed in any first-turn assistant_text' };
}
```

Replace `<GROUNDED_TOOL_NAME>` with the Step-1 tool name (and add args to the instruction if Step 1 found no zero-arg tool).

- [ ] **Step 4:** `node --test --no-warnings test/runtime/firstTurnMcpProbe.test.js` → all pass.
- [ ] **Step 5: Commit** exactly `src/runtime/firstTurnMcpProbe.js` + `test/runtime/firstTurnMcpProbe.test.js`. `git -C /c/Project-TOAD diff --cached --name-only` == those 2. Message `feat(runtime): shared first-turn MCP-tool visibility probe pure core (A4 Task 1)` + trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` via `git -C /c/Project-TOAD -c commit.gpgsign=false commit`.

---

### Task 2: Codex adapter first-turn hook (TDD)

**Files:** Modify `src/runtime/CodexExecAdapter.js`; Create `test/codex/codexExecAdapter.a4probe.test.js`.

- [ ] **Step 1: Read** `src/runtime/CodexExecAdapter.js` `#runTurn`/`#attemptTurn` — the first-turn-vs-resume dispatch (`isResume`), where `systemPrompt`/prompt is built, where the terminal `turn_completed` resolves the accepted result, and the existing single-source `turn_failed` (`__failError`) path; `test/codex/codexExecAdapter.grounded.test.js` (injected-spawnImpl fake-child harness) and `test/bundle/spawnThrowGuard.test.js` (BR1 — must still pass).

- [ ] **Step 2: RED** — `test/codex/codexExecAdapter.a4probe.test.js` (fake-child harness from the grounded test). Assert: (a) on the FIRST turn the spawned prompt/stdin contains `buildProbeInstruction()`'s text (and `PROBE_SENTINEL`); (b) a first turn whose normalized stream has NO `assistant_text` sentinel → result is `turn_failed` (responseState not accepted) with message containing `TOAD tools unavailable`, and a `turn_failed` event with that text was pushed; (c) a first turn whose `assistant_text` contains `PROBE_SENTINEL` → accepted as normal; (d) a RESUME turn (sessionStore has an id) → instruction NOT in argv/prompt AND accepted even with no sentinel (probe skipped); (e) BR1 pre-spawn-throw `_pendingTexts` restore still holds (port the assertion shape from `spawnThrowGuard.test.js`). Run → RED for the right reasons.

- [ ] **Step 3: GREEN** — in `CodexExecAdapter.js`: `import { buildProbeInstruction, evaluateFirstTurnProbe } from './firstTurnMcpProbe.js';`. In `#runTurn`, when `!isResume`, append `\n\n${buildProbeInstruction()}` to the first-turn prompt (after the systemPrompt prepend, before send). Collect the turn's normalized events (the adapter already iterates them for `session_started`/`turn_completed` — push each into a local `const turnEvents = []`). On the terminal `turn_completed` for a first turn, if `evaluateFirstTurnProbe(turnEvents).satisfied !== true`, convert the result to the adapter's terminal-failure (`__failError = 'TOAD tools unavailable: codex agent could not confirm the toad MCP rail on the first turn'`; push the single-source `turn_failed`; return the not-accepted receipt) instead of the accepted result. Resume turns: do not append the instruction, do not evaluate. Keep BR1/`_chain`/session-loss-fallback paths unchanged (the probe-fail is a normal terminal `turn_failed`, NOT an `UNKNOWN_SESSION_RE` trigger).

- [ ] **Step 4:** `node --test --no-warnings test/codex/codexExecAdapter.a4probe.test.js test/codex/codexExecAdapter.grounded.test.js test/codex/codexExecAdapter.test.js test/codex/codexExecAdapter.resume.test.js test/codex/codexExecAdapter.sessionLoss.test.js test/codex/codexExecAdapter.fifo.test.js test/bundle/spawnThrowGuard.test.js test/codex/codexStage2.e2e.test.js test/codex/codexEndToEndProof.test.js` → 0 fail. Any pre-existing codex test asserting an exact first-turn prompt/argv that now legitimately includes the probe instruction: update it to expect the appended block, note in commit body (the probe is the intended new first-turn behavior).

- [ ] **Step 5: Commit** exactly `src/runtime/CodexExecAdapter.js` + `test/codex/codexExecAdapter.a4probe.test.js` (+ any pre-existing codex test corrected). Message `feat(codex): first-turn MCP-visibility probe — broken toad rail fails loudly, not silently (A4 Task 2)` + trailer.

---

### Task 3: Gemini adapter first-turn hook (TDD)

**Files:** Modify `src/runtime/GeminiExecAdapter.js`; Create `test/gemini/geminiExecAdapter.a4probe.test.js`.

- [ ] **Step 1: Read** `src/runtime/GeminiExecAdapter.js` `#runTurn`/`#attemptTurn` — gemini's first-turn-vs-resume (the `--session-id` first turn / `--resume latest` resume from SP1b; `isResume` derived from sessionStore), where the prompt is built (systemPrompt prefix on first turn, stdin), terminal `turn_completed`, single-source `turn_failed`/`__failError`; `test/gemini/geminiExecAdapter.grounded.test.js`; `test/bundle/spawnThrowGuard.test.js`.

- [ ] **Step 2: RED** — `test/gemini/geminiExecAdapter.a4probe.test.js` (gemini fake-child harness). Same five assertions as Task 2 Step 2 (a–e), gemini-specific: first-turn prompt contains the probe instruction; first turn w/o sentinel → `turn_failed("TOAD tools unavailable: gemini agent could not confirm the toad MCP rail on the first turn")`; with sentinel → accepted; resume turn → probe skipped + accepted; BR1 holds. Run → RED.

- [ ] **Step 3: GREEN** — in `GeminiExecAdapter.js`: `import { buildProbeInstruction, evaluateFirstTurnProbe } from './firstTurnMcpProbe.js';`. First turn (`!isResume`): append `\n\n${buildProbeInstruction()}` to the first-turn prompt (where SP1b prefixes systemPrompt). Collect normalized `turnEvents`; on first-turn terminal `turn_completed`, if `!evaluateFirstTurnProbe(turnEvents).satisfied` → terminal `turn_failed` with the gemini message via the existing `__failError`/single-source path; return not-accepted. Resume: skip. BR1/`_chain`/session-loss unchanged.

- [ ] **Step 4:** `node --test --no-warnings test/gemini/geminiExecAdapter.a4probe.test.js test/gemini/geminiExecAdapter.grounded.test.js test/gemini/geminiExecAdapter.test.js test/gemini/geminiGrounded.e2e.test.js test/gemini/localToadRuntime.geminiLaunch.test.js test/bundle/spawnThrowGuard.test.js` → 0 fail. Correct any pre-existing gemini test asserting an exact first-turn prompt to expect the probe block (note in commit body).

- [ ] **Step 5: Commit** exactly `src/runtime/GeminiExecAdapter.js` + `test/gemini/geminiExecAdapter.a4probe.test.js` (+ any corrected pre-existing gemini test). Message `feat(gemini): first-turn MCP-visibility probe — broken toad rail fails loudly (A4 Task 3)` + trailer.

---

### Task 4: Opencode adapter first-turn hook (TDD)

**Files:** Modify `src/runtime/OpencodeExecAdapter.js`; Create `test/opencode/opencodeExecAdapter.a4probe.test.js`.

- [ ] **Step 1: Read** `src/runtime/OpencodeExecAdapter.js` `#runTurn`/`#attemptTurn` — opencode's first-turn-vs-resume (SP1c: message = final POSITIONAL argv arg, first turn prefixes systemPrompt, resume adds `--session <id>`; `isResume` from sessionStore), terminal `turn_completed`, single-source `turn_failed`/`__failError`; `test/opencode/opencodeExecAdapter.grounded.test.js`; `test/bundle/spawnThrowGuard.test.js` (opencode branch asserts the recovered batch in the positional argv — the probe instruction is appended to the first-turn message which is that positional arg, so confirm the BR1 test still matches `/alpha[\s\S]*beta/` since the probe text is appended, not replacing the batch).

- [ ] **Step 2: RED** — `test/opencode/opencodeExecAdapter.a4probe.test.js` (opencode fake-child harness). Same five assertions (a–e), opencode-specific: the first-turn POSITIONAL message arg contains the probe instruction; first turn w/o sentinel → `turn_failed("TOAD tools unavailable: opencode agent could not confirm the toad MCP rail on the first turn")`; with sentinel → accepted; resume → skipped + accepted; BR1 holds (recovered batch still in positional argv, probe text additive). Run → RED.

- [ ] **Step 3: GREEN** — in `OpencodeExecAdapter.js`: `import { buildProbeInstruction, evaluateFirstTurnProbe } from './firstTurnMcpProbe.js';`. First turn (`!isResume`): append `\n\n${buildProbeInstruction()}` to the `message` that becomes the final positional arg (SP1c first-turn systemPrompt-prefixed path). Collect normalized `turnEvents`; on first-turn terminal `turn_completed`, if `!evaluateFirstTurnProbe(turnEvents).satisfied` → terminal `turn_failed` via the existing single-source path; not-accepted. Resume: skip. BR1/`_chain`/session-loss unchanged.

- [ ] **Step 4:** `node --test --no-warnings test/opencode/opencodeExecAdapter.a4probe.test.js test/opencode/opencodeExecAdapter.grounded.test.js test/opencode/opencodeExecAdapter.test.js test/opencode/opencodeGrounded.e2e.test.js test/opencode/localToadRuntime.opencodeLaunch.test.js test/bundle/spawnThrowGuard.test.js test/bundle/opencodeArgInjection.test.js` → 0 fail. Correct any pre-existing opencode test asserting an exact first-turn argv/message to expect the probe block (note in commit body); BR5 `opencodeArgInjection.test.js` must stay byte-unchanged-in-behavior.

- [ ] **Step 5: Commit** exactly `src/runtime/OpencodeExecAdapter.js` + `test/opencode/opencodeExecAdapter.a4probe.test.js` (+ any corrected pre-existing opencode test). Message `feat(opencode): first-turn MCP-visibility probe — broken toad rail fails loudly (A4 Task 4)` + trailer.

---

### Task 5: Front-loaded scripted broken-rail/healthy-rail e2e + wire gate (TDD)

**Files:** Create `test/bundle/a4ProbeE2e.test.js`; Create/extend `test/fixtures/fake-{codex,gemini,opencode}-a4.mjs` (or add a mode flag to the existing grounded fixtures — read them first); Modify `scripts/test-suites.txt`.

- [ ] **Step 1: Read** `test/fixtures/fake-codex-stage2.mjs`, `test/fixtures/fake-gemini-grounded.mjs`, `test/fixtures/fake-opencode-grounded.mjs` + `test/codex/codexStage2.e2e.test.js` / `test/gemini/geminiGrounded.e2e.test.js` / `test/opencode/opencodeGrounded.e2e.test.js` (the proven e2e patterns). Decide minimal-diff: add an env/argv-driven mode to each fixture — `healthy` (the grounded turn WITH the `PROBE_SENTINEL` embedded in the assistant text/agent_message) vs `broken` (the grounded turn WITHOUT the sentinel).

- [ ] **Step 2: RED** — `test/bundle/a4ProbeE2e.test.js`: for each of the 3 adapters, real adapter (spawnImpl→its fake in `broken` mode) → real normalizer → real `RuntimeEventIngestor`; assert the FIRST turn yields `turn_failed` carrying `TOAD tools unavailable`; then `healthy` mode → first turn accepted, sentinel-bearing `assistant_text` surfaced normally. Run `node --test --no-warnings test/bundle/a4ProbeE2e.test.js` → RED.

- [ ] **Step 3: GREEN** — implement the fixture modes (sentinel injected only in `healthy`). The adapter/probe logic already shipped (Tasks 1–4); if RED reveals a real integration gap fix it minimally in the owning A4 module/adapter (note in commit body). Re-run → all pass. Independently bite-test: flip one adapter's fixture `healthy`→omit-sentinel and confirm that adapter's e2e flips to `turn_failed`; restore.

- [ ] **Step 4: Wire gate** — append the new A4 suites as a SINGLE continuous line (no newline before `&&`):
```
cd /c/Project-TOAD/toad-local
node -e "const fs=require('fs');const f='scripts/test-suites.txt';let s=fs.readFileSync(f,'utf8').replace(/\r?\n/g,' ').replace(/\s+/g,' ').trim();for(const t of ['test/runtime/firstTurnMcpProbe.test.js','test/codex/codexExecAdapter.a4probe.test.js','test/gemini/geminiExecAdapter.a4probe.test.js','test/opencode/opencodeExecAdapter.a4probe.test.js','test/bundle/a4ProbeE2e.test.js'])if(!s.includes(t))s+=' && node --no-warnings --test '+t;fs.writeFileSync(f,s+'\n')"
bash -n -c "$(cat scripts/test-suites.txt)" && echo "test-suites.txt parses OK"
```

- [ ] **Step 5: Commit** exactly the new e2e test + fixture file(s) + `scripts/test-suites.txt` (+ any minimal A4 fix). `git -C /c/Project-TOAD diff --cached --name-only` == only those. Message `test(a4): scripted broken/healthy-rail e2e for all 3 session adapters + wire A4 suites into the root gate (A4 Task 5)` + trailer.

---

### Task 6: Final whole-impl review + full root gate + honest status

**Files:** Modify `README.md`, `docs/ARCHITECTURE.md`.

- [ ] **Step 1: Final whole-impl two-stage review** over `git -C /c/Project-TOAD diff 2fbb1ba2..HEAD -- toad-local/` (spec-compliance vs `2026-05-18-a4-mcp-visibility-probe-design.md` + code-quality). Fix Critical/Important TDD. Confirm out-of-scope diff EMPTY: `git -C /c/Project-TOAD diff 2fbb1ba2..HEAD --stat -- toad-local/src/runtime/ClaudeStreamJsonAdapter.js toad-local/src/foundry/ toad-local/src/runtime/codex/normalizeCodexExecLine.js toad-local/src/runtime/gemini/normalizeGeminiStreamLine.js toad-local/src/runtime/opencode/normalizeOpencodeStreamLine.js` is empty (Claude/foundry/all 3 normalizers byte-unchanged — the probe is adapter-layer only).
- [ ] **Step 2: Full root gate** from `toad-local/`: `bash -c "$(cat scripts/test-suites.txt)" ; echo "EXIT=$?"` → `EXIT=0`, summed `# fail 0`, 0 `not ok`, the new A4 suites ran. (If non-A4 uncommitted WIP is dirty, scoped-stash it for an attributable gate then restore — the SP1b/SP1c Task-7 precedent; NEVER commit the parallel ide/ui workstream's files.)
- [ ] **Step 3: Honest status update.** `README.md` + `docs/ARCHITECTURE.md`: the silent-mute failure mode is CLOSED for all 3 session adapters (first-turn probe → loud `turn_failed`); document the residual honestly (the sentinel proves a compliant agent that called the tool; a non-compliant model could emit it without success — strictly safer than before; grounded-`tool_use` hardening is future work). No overstatement; mirror the SP1b/SP1c status wording. Commit docs only (`docs(status): … (A4 Task 6)` + trailer).
- [ ] **Step 4:** `superpowers:finishing-a-development-branch`.

---

## Self-Review (writing-plans checklist)

**1. Spec coverage:** §1 goal (loud first-turn fail) → Tasks 2–4 + 5. §2 text-sentinel signal (grounded for all 3) → Task 1 `evaluateFirstTurnProbe` on `assistant_text`. §3 architecture: shared pure core → Task 1; identical thin per-adapter first-turn hook + resume-skip + BR1/session-loss composition → Tasks 2,3,4 (full hook code repeated per task, adapted to each adapter's first-turn branch); Claude out → Scope + Task 6 out-of-scope-empty check. §4 scope boundary → Scope + Task 6. §5 testing: pure-core deepest (Task 1), per-adapter lifecycle incl. resume-skip + BR1 (Tasks 2–4), scripted broken/healthy e2e + bite-test + gate (Task 5). §6 conventions → every task commit block. ✓

**2. Placeholder scan:** No "TBD/handle edge cases". `<GROUNDED_TOOL_NAME>` is an explicit grounded-contingency: Task 1 Step 1 fully specifies the mechanism (read `localToolDefinitions.js`, pick the real read-only no-arg tool; if none, simplest-args variant) — the literal is read from real definitions, not invented (SP1b/SP1c-blessed). The per-adapter hook code is repeated in full in Tasks 2/3/4 (not "similar to Task N"), adapted to each adapter's first-turn branch.

**3. Type consistency:** `PROBE_SENTINEL` / `buildProbeInstruction()` / `evaluateFirstTurnProbe(events)→{satisfied,reason}` identical across Tasks 1→2→3→4→5. `turnEvents` collection + the existing single-source `__failError`/`turn_failed` path + `isResume` dispatch referenced consistently with the SP1a/b/c adapter structure. The `turn_failed` message format `TOAD tools unavailable: <provider> agent could not confirm the toad MCP rail on the first turn` consistent across Tasks 2/3/4 + e2e (Task 5).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-a4-mcp-visibility-probe.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec then quality) between tasks, controller independently verifies every DONE + the full root gate; same rigor as SP1a/SP1b/SP1c.

**2. Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, batched with checkpoints.

Which approach?
