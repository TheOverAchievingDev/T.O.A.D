# SP1b — Gemini CLI Grounding & Adapter Correction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `GeminiExecAdapter`/`normalizeGeminiStreamLine`'s unverified gemini CLI invocation contract + event vocabulary with facts captured from the real installed gemini 0.42.0, and prove it with a scripted e2e — making the Gemini team runtime verified, not assumed.

**Architecture:** Grounding-first. Tasks 1–2 capture the real contract + event vocabulary into a committed grounding doc (`docs/superpowers/grounding/2026-05-18-gemini-cli.md`); that doc is the single source of truth the correction tasks (3–6) consume — each correction is TDD against the doc's RATIFIED sections. Spec: `docs/superpowers/specs/2026-05-18-gemini-grounding-design.md`. The Claude/Codex paths stay byte-unchanged (all changes behind the existing `providerId` seam).

**Tech Stack:** Node ESM, `node --test`, `node:child_process` (injected `spawnImpl` in tests), the existing `GeminiExecAdapter`/`normalizeGeminiStreamLine`/`geminiMcpConfig` modules, `scripts/test-suites.txt` gate.

---

## Scope

Gemini only. NOT OpenCode (SP1c), NOT the A4 MCP-visibility probe — separate later slices. No UI. Claude/Codex byte-unchanged.

## File Structure

- **Create** `docs/superpowers/grounding/2026-05-18-gemini-cli.md` — verbatim gemini 0.42.0 contract + event vocabulary + DIVERGENCE table + RATIFIED argv/events. The authority for Tasks 3–6.
- **Modify** `src/runtime/gemini/normalizeGeminiStreamLine.js` — map the *real* event shapes; pure/total/never-throws.
- **Modify** `src/runtime/GeminiExecAdapter.js` — argv (first-turn + resume), output-consumption seam, session-id capture/resume dispatch, failure paths. Preserve the BR1 batch-restore guard.
- **Modify (iff schema-divergent)** `src/mcp/geminiMcpConfig.js` — `~/.gemini/settings.json` MCP schema.
- **Create** `test/gemini/normalizeGeminiStreamLine.grounded.test.js` — grounded event fixtures.
- **Create** `test/fixtures/fake-gemini-grounded.mjs` — scripted stand-in emitting the RATIFIED vocabulary + stdio MCP.
- **Create** `test/gemini/geminiExecAdapter.grounded.test.js` — argv/lifecycle to grounded reality.
- **Create** `test/gemini/geminiGrounded.e2e.test.js` — front-loaded end-to-end proof.
- **Modify** `scripts/test-suites.txt` — wire the new suites (single-line append; no newline before `&&` — the BR-gate lesson).
- **Modify** `README.md` + `docs/ARCHITECTURE.md` — Gemini status iff proven.

---

### Task 1: Free grounding capture → contract section of the grounding doc

**Files:** Create `docs/superpowers/grounding/2026-05-18-gemini-cli.md`.

- [ ] **Step 1: Capture the free (no-quota) surface.** Run and save verbatim:
  - `gemini --version`
  - `gemini --help`
  - `gemini mcp --help`
  - `gemini mcp list 2>&1 | head -40` (MCP server registration shape)
  - `cat ~/.gemini/settings.json` (MCP-config schema actually honored)
  Determine from the help output: (a) the real structured-output mechanism — does `--output-format` exist? is `--acp` (Agent Client Protocol) the structured channel? is headless JSON line-delimited at all? (b) the real **resume/session** mechanism — does `--resume <id>` exist; if not, what is it (`/chat`, a session flag, none)? (c) the real model/approval/trust/mcp flags.

- [ ] **Step 2: Write the grounding doc contract section.** Mirror `docs/superpowers/grounding/2026-05-17-codex-cli.md` format. Sections: `## 1. Versions`, `## 2. Headless flag set (verbatim --help)`, `## 3. Structured-output mechanism` (the answer to 1a, verbatim), `## 4. Resume/session mechanism` (1b), `## 5. MCP config schema` (verbatim settings.json + `gemini mcp` shape), `## 6. DIVERGENCE vs current adapter` — a table: each current `GeminiExecAdapter`/`normalizeGeminiStreamLine` assumption (from spec §2) → CONFIRMED / WRONG (real value). End with `## 7. RATIFIED first-turn argv (provisional — event vocab confirmed in Task 2)`.

- [ ] **Step 3: Commit.**

```bash
git -C /c/Project-TOAD add toad-local/docs/superpowers/grounding/2026-05-18-gemini-cli.md
git -C /c/Project-TOAD diff --cached --name-only   # exactly that one file
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "docs(ground): gemini 0.42.0 free contract grounding — flags, output mechanism, resume, MCP schema (SP1b)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: One tiny real headless run → event-vocabulary section

**Files:** Modify `docs/superpowers/grounding/2026-05-18-gemini-cli.md`.

- [ ] **Step 1: Capture exactly one minimal real turn.** Using the structured-output mechanism grounded in Task 1, run the smallest read-only headless invocation and save stdout+stderr verbatim to a temp file. Use read-only/plan approval and a trivial prompt, e.g. (adapt the flag names to Task 1's grounded reality — do NOT assume `--output-format`):

```bash
cd /c/Project-TOAD/toad-local
# <grounded structured-output flag> + --approval-mode plan + tiny prompt; ONE turn only.
timeout 90 gemini -p "Reply with the single word: ok" --approval-mode plan <grounded-structured-output-flag> > /tmp/gemini-cap.txt 2>&1 || true
cat /tmp/gemini-cap.txt
```

If Task 1 showed gemini has no line-JSON and uses `--acp`, capture the ACP frames instead (note the transport in the doc). One turn only — do not loop.

- [ ] **Step 2: Append the event-vocabulary section + finalize RATIFIED.** Add `## 8. Verbatim structured events (one real turn)` (the captured frames), `## 9. Event → TOAD normalized mapping` (each real event type → the `assistant_text`/`tool_use`/`turn_completed`/`session_started`/`runtime_event`/`parse_error` TOAD event the normalizer must emit; note session-id source), and finalize `## 7. RATIFIED argv` (first-turn + resume) + `## 10. RATIFIED event vocabulary`. Mark every spec-§2 assumption CONFIRMED or corrected.

- [ ] **Step 3: Commit.**

```bash
git -C /c/Project-TOAD add toad-local/docs/superpowers/grounding/2026-05-18-gemini-cli.md
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "docs(ground): gemini 0.42.0 real event vocabulary (one captured turn) + RATIFIED argv/events (SP1b)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Lock `normalizeGeminiStreamLine` to the grounded event vocabulary (TDD)

**Files:** Test `test/gemini/normalizeGeminiStreamLine.grounded.test.js` (create); Modify `src/runtime/gemini/normalizeGeminiStreamLine.js`.

- [ ] **Step 1: Write failing tests from the grounding doc.** Open `docs/superpowers/grounding/2026-05-18-gemini-cli.md` §8/§9/§10. For EACH RATIFIED real event type, add a test asserting `normalizeGeminiStreamLine(verbatimLine, ctx)` returns the mapped TOAD event(s) from §9 (use the verbatim §8 frames as inputs). Add: malformed line → `parse_error`; empty/non-JSON → `[]`; never throws (wrap a garbage input in `assert.doesNotThrow`); session-id captured from the §9-designated frame → `session_started` with `sessionId`. (Mirror `test/codex/normalizeCodexExecLine.test.js` structure.)

- [ ] **Step 2: Run → RED.** `cd /c/Project-TOAD/toad-local && node --test --no-warnings test/gemini/normalizeGeminiStreamLine.grounded.test.js` — expect failures (current normalizer assumes the ungrounded `init`/`message`/`result` shapes).

- [ ] **Step 3: Correct the normalizer.** Rewrite `normalizeGeminiStreamLine.js` to map the grounded §10 vocabulary → TOAD events exactly per §9. Keep it pure/total/never-throw (try/catch JSON.parse, non-object guard, unknown type → `runtime_event`, malformed → `parse_error`). No IO, no imports beyond local.

- [ ] **Step 4: Run → GREEN** (same command, all pass) and run the pre-existing `test/gemini/normalizeGeminiStreamLine.test.js`; if it encoded the OLD ungrounded shapes, update those cases to the grounded reality (they were never real) — note this in the commit body.

- [ ] **Step 5: Commit** (`src/runtime/gemini/normalizeGeminiStreamLine.js` + both test files):

```bash
git -C /c/Project-TOAD add toad-local/src/runtime/gemini/normalizeGeminiStreamLine.js toad-local/test/gemini/normalizeGeminiStreamLine.grounded.test.js toad-local/test/gemini/normalizeGeminiStreamLine.test.js
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "fix(gemini): normalizer maps the GROUNDED gemini 0.42.0 event vocabulary (SP1b Task 3)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Correct `GeminiExecAdapter` argv + output-consumption + resume (TDD)

**Files:** Test `test/gemini/geminiExecAdapter.grounded.test.js` (create); Modify `src/runtime/GeminiExecAdapter.js`.

- [ ] **Step 1: Write failing tests from the grounding doc §7/§10.** Using the injected-`spawnImpl` fake-child pattern from the existing `test/gemini/geminiExecAdapter.test.js`, assert:
  1. first-turn argv === the §7 RATIFIED first-turn argv (exact array).
  2. resume turn argv === the §7 RATIFIED resume argv (or, if grounding found no resume, that turn 2 correctly starts a fresh first-turn — assert the grounded reality).
  3. `sendTurn` resolves on the §10 RATIFIED terminal event; `events()` emitted the normalized stream.
  4. session id is captured from the §9-designated frame and drives turn-2 dispatch.
  5. non-zero exit / timeout → `turn_failed` (+ stderr cap).
  6. the BR1 pre-spawn-throw guard still restores `_pendingTexts` (port the assertion from `test/bundle/spawnThrowGuard.test.js`).

- [ ] **Step 2: Run → RED.** `node --test --no-warnings test/gemini/geminiExecAdapter.grounded.test.js` — expect argv/lifecycle mismatches.

- [ ] **Step 3: Correct the adapter.** Edit `GeminiExecAdapter.js` so first-turn/resume argv + the output-consumption mechanism + session capture + terminal-event resolution match the grounding doc. If §3 grounded that gemini has no line-delimited JSON (e.g. ACP), correct the *output-consumption seam* to the real channel (spec §4 Approach-B branch) — keep the `RuntimeAdapter` surface and the `_chain`/`_pendingTexts` FIFO+BR1 guard intact; only the IO/parse wiring changes. Do not touch Claude/Codex.

- [ ] **Step 4: Run → GREEN** + run the full gemini adapter regression: `node --test --no-warnings test/gemini/geminiExecAdapter.test.js test/gemini/geminiExecAdapter.grounded.test.js test/gemini/localToadRuntime.geminiLaunch.test.js test/bundle/spawnThrowGuard.test.js` — 0 fail. Update any pre-existing gemini adapter test that encoded the old ungrounded argv (note in commit body).

- [ ] **Step 5: Commit** (`src/runtime/GeminiExecAdapter.js` + the new/updated gemini adapter tests):

```bash
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "fix(gemini): adapter argv + output-consumption + resume corrected to GROUNDED gemini 0.42.0 (SP1b Task 4)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `geminiMcpConfig` — correct iff schema-divergent (TDD; may be a documented no-op)

**Files:** Test `test/gemini/geminiMcpConfig.test.js` (modify); Modify `src/mcp/geminiMcpConfig.js` (only if divergent).

- [ ] **Step 1: Compare.** From grounding doc §5 (real `~/.gemini/settings.json` MCP schema) vs what `geminiMcpConfig.js` writes (read it + `test/gemini/geminiMcpConfig.test.js`). Two outcomes:
  - **Match:** add one line to the grounding doc §5: "RATIFIED: geminiMcpConfig output matches the real 0.42.0 schema — no change needed." Skip Steps 2–4. (Explicit, not a placeholder.)
  - **Divergent:** continue.
- [ ] **Step 2 (divergent only): Failing test** asserting `geminiMcpConfig` emits the grounded §5 schema. Run → RED.
- [ ] **Step 3 (divergent only): Correct** `geminiMcpConfig.js` to the grounded schema. Run → GREEN + `node --test --no-warnings test/gemini/geminiMcpConfig.test.js`.
- [ ] **Step 4: Commit** (grounding-doc line if match; else config + test):

```bash
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "fix(gemini): MCP config matches grounded ~/.gemini/settings.json schema (SP1b Task 5)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Front-loaded scripted e2e proof + wire into the gate (TDD)

**Files:** Create `test/fixtures/fake-gemini-grounded.mjs`, `test/gemini/geminiGrounded.e2e.test.js`; Modify `scripts/test-suites.txt`.

- [ ] **Step 1: Write the e2e test (failing).** Mirror `test/codex/codexStage2.e2e.test.js`/`codexEndToEndProof.test.js`: a stand-in `test/fixtures/fake-gemini-grounded.mjs` that emits the grounding-doc §10 RATIFIED vocabulary for a scripted turn AND connects to TOAD's MCP server over stdio (calls `message_send`, makes a file change). The e2e test launches a `GeminiExecAdapter` with `spawnImpl` → the fake, drives one turn, and asserts the `RuntimeEventIngestor` + drift see the normalized events (assistant_text/tool_use/turn_completed) and the message landed.

- [ ] **Step 2: Run → RED** `node --test --no-warnings test/gemini/geminiGrounded.e2e.test.js`.

- [ ] **Step 3: Make it pass** (fixes land in Tasks 3–4; this task adds the fixture + test only — if RED reveals a real adapter/normalizer gap, fix it minimally in the owning module and note it).

- [ ] **Step 4: Wire into the gate.** Append to `scripts/test-suites.txt` as a SINGLE continuous line (no newline before `&&` — the prior gate-break lesson). Append: `test/gemini/normalizeGeminiStreamLine.grounded.test.js`, `test/gemini/geminiExecAdapter.grounded.test.js`, `test/gemini/geminiGrounded.e2e.test.js`:

```bash
cd /c/Project-TOAD/toad-local
node -e "const fs=require('fs');const f='scripts/test-suites.txt';let s=fs.readFileSync(f,'utf8').replace(/\r?\n/g,' ').replace(/\s+/g,' ').trim();for(const t of ['test/gemini/normalizeGeminiStreamLine.grounded.test.js','test/gemini/geminiExecAdapter.grounded.test.js','test/gemini/geminiGrounded.e2e.test.js'])s+=' && node --no-warnings --test '+t;fs.writeFileSync(f,s+'\n')"
bash -n -c "$(cat scripts/test-suites.txt)" && echo "test-suites.txt parses OK"
```

- [ ] **Step 5: Commit** (`test/fixtures/fake-gemini-grounded.mjs`, `test/gemini/geminiGrounded.e2e.test.js`, `scripts/test-suites.txt`):

```bash
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "test(gemini): grounded front-loaded e2e proof + wire gemini grounded suites into the root gate (SP1b Task 6)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Whole-impl review + full root gate + honest status update

**Files:** Modify `README.md`, `docs/ARCHITECTURE.md` (+ memory note out-of-band).

- [ ] **Step 1: Whole-impl two-stage review.** Dispatch the mandatory review (spec-compliance vs `2026-05-18-gemini-grounding-design.md` + code-quality) over `git diff <pre-Task-1>..HEAD -- toad-local/`. Fix any Critical/Important TDD. Confirm Claude/Codex/OpenCode + `normalizeCodexExecLine` byte-unchanged (out-of-scope diff EMPTY).
- [ ] **Step 2: Full root gate.** From `toad-local/`: `bash -c "$(cat scripts/test-suites.txt)" ; echo "EXIT=$?"`. Confirm `EXIT=0`, summed `# fail 0`, 0 `not ok`, and the new gemini grounded suites ran.
- [ ] **Step 3: Honest status update.** If e2e + gate prove Gemini works against the grounded contract: update `README.md` + `docs/ARCHITECTURE.md` provider table — Gemini → **Working (grounded against gemini 0.42.0)**. If grounding revealed a real limitation that can't be fully closed in this slice, document it precisely instead (no overstatement). Commit `docs(...)`.
- [ ] **Step 4:** `superpowers:finishing-a-development-branch`.

---

## Self-Review (writing-plans checklist)

**1. Spec coverage:** spec §3 grounding (free + 1 run) → Tasks 1–2. §4 correction (adapter/normalizer/mcp, ACP contingency) → Tasks 3,4,5 (Task 4 Step 3 explicitly carries the spec-§4 Approach-B output-seam branch). §5 testing (pure normalizer deepest, injected-spawn lifecycle, scripted e2e, gate) → Tasks 3,4,6. §6 scope boundary (Gemini only, no OpenCode/A4/UI) → Scope section + Task 7 out-of-scope-empty check. §7 conventions → every task's commit block. ✓

**2. Placeholder scan:** No "TBD/TODO/handle edge cases". Grounding-dependent values are not placeholders: the *mechanism* (consume grounding-doc §N RATIFIED section, test against the verbatim captured frames) is fully specified — literal argv/event strings are intentionally determined by Tasks 1–2 because inventing them is the exact defect this slice fixes. Task 5's "no-op if match" is an explicit specified outcome, not a placeholder.

**3. Type consistency:** grounding-doc section numbers (§7 RATIFIED argv, §9 mapping, §10 RATIFIED vocabulary) referenced consistently across Tasks 2→3→4→6. `normalizeGeminiStreamLine` / `GeminiExecAdapter` / `geminiMcpConfig` names + the injected-`spawnImpl` test pattern + BR1 guard reference consistent with the existing codebase.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-gemini-grounding.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between tasks, controller independently verifies every DONE + the full root gate; same rigor as SP1a.

**2. Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, batched with checkpoints.

Which approach?
