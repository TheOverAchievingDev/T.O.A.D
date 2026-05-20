# SP1c — OpenCode CLI Grounding & Adapter Correction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `OpencodeExecAdapter`/`normalizeOpencodeStreamLine`'s unverified opencode CLI invocation contract + event vocabulary with facts captured from the real installed opencode 1.15.4, prove it with a scripted e2e — making the OpenCode team runtime verified, not assumed.

**Architecture:** Grounding-first (the proven SP1b shape). Tasks 1–2 capture the real `opencode run`/session contract + event vocabulary into a committed grounding doc (`docs/superpowers/grounding/2026-05-18-opencode-cli.md`); that doc is the single source of truth the correction tasks (3–6) consume — each correction is TDD against the doc's RATIFIED sections. Spec: `docs/superpowers/specs/2026-05-18-opencode-grounding-design.md`. Claude/Codex/Gemini stay byte-unchanged (all changes behind the existing `providerId` seam). The BR1 pre-spawn-throw batch-restore guard and BR5 shell-arg allowlist must survive.

**Tech Stack:** Node ESM, `node --test`, `node:child_process` (injected `spawnImpl` in tests), the existing `OpencodeExecAdapter`/`normalizeOpencodeStreamLine`/`opencodeMcpConfig` modules, `scripts/test-suites.txt` gate.

---

## Scope

OpenCode only. NOT the A4 cross-adapter MCP-visibility probe; NOT Gemini/Codex/Claude (byte-unchanged); no UI.

## File Structure

- **Create** `docs/superpowers/grounding/2026-05-18-opencode-cli.md` — verbatim opencode 1.15.4 contract + event vocabulary + DIVERGENCE table + RATIFIED argv/events/session model. Authority for Tasks 3–6.
- **Modify** `src/runtime/opencode/normalizeOpencodeStreamLine.js` — map the *real* event shapes; pure/total/never-throws.
- **Modify** `src/runtime/OpencodeExecAdapter.js` — argv (first-turn + resume), output-consumption seam, session/resume model, failure paths. **Preserve** the BR1 `_pendingTexts` batch-restore guard and the BR5 `normalizeOpencodeArgs` `--model/--agent/--variant` allowlist.
- **Modify (iff schema-divergent)** `src/mcp/opencodeMcpConfig.js`.
- **Create** `test/opencode/normalizeOpencodeStreamLine.grounded.test.js`, `test/opencode/opencodeExecAdapter.grounded.test.js`, `test/opencode/opencodeGrounded.e2e.test.js`, `test/fixtures/fake-opencode-grounded.mjs`.
- **Modify** `scripts/test-suites.txt` — wire the 3 new suites (single continuous line; no newline before `&&`).
- **Modify** `README.md` + `docs/ARCHITECTURE.md` — OpenCode status iff proven.

---

### Task 1: Free grounding capture → contract section

**Files:** Create `docs/superpowers/grounding/2026-05-18-opencode-cli.md`. Format reference (structure/voice): `docs/superpowers/grounding/2026-05-18-gemini-cli.md`.

- [ ] **Step 1: Capture the free (no-spend) surface.** From `C:\Project-TOAD\toad-local`, run and save verbatim: `opencode --version`; `opencode --help`; `opencode run --help`; `opencode session --help`; `opencode mcp --help`; `opencode mcp list 2>&1 | head -40`; `opencode auth list 2>&1 | head` (or `opencode providers --help`); `cat ~/.local/share/opencode/auth.json` (the grounded auth path; redact secret values — record only key NAMES/shape, never token values); locate + `cat` the opencode MCP/config file (`opencode mcp --help` / `opencode mcp add --help` reveal where; do NOT run a model). Do NOT run `opencode run <message>` (that is Task 2).
- [ ] **Step 2: Determine + record** (a) the real **structured-output mechanism** for headless: does `opencode run` accept `--format json`/`--output-format`? is it NDJSON, or only via `opencode acp`/`opencode serve`? Quote exact help lines. (b) the real **session/resume model**: does `opencode run` accept `--session <id>`? what does `opencode session` expose (list/continue)? how is a session id obtained + resumed? (c) real model/permissions/mcp flags on `opencode run` (`--model`, a permissions/`--dangerously-*` flag, mcp-allowlist).
- [ ] **Step 3: Write the doc** sections: `## 1. Versions`; `## 2. Headless command + flag set` (verbatim `opencode run --help`); `## 3. Structured-output mechanism` (2a, verbatim); `## 4. Session/resume model` (2b, verbatim); `## 5. MCP config schema` (verbatim config + `opencode mcp` shape); `## 6. DIVERGENCE vs current adapter` — read `src/runtime/OpencodeExecAdapter.js` + `src/runtime/opencode/normalizeOpencodeStreamLine.js`; table row per assumption [`run`, `--format json`, `--dangerously-skip-permissions`, `--session <id>`, `--model/--agent/--variant` (BR5), the `step_start`/`step_finish`/`part`/`part.tokens`/`text` event shapes] → Real (verbatim) → CONFIRMED / WRONG; `## 7. RATIFIED first-turn argv (provisional — event vocab confirmed in Task 2)`.
- [ ] **Step 4: Commit** exactly that one file:
```
git -C /c/Project-TOAD add toad-local/docs/superpowers/grounding/2026-05-18-opencode-cli.md
git -C /c/Project-TOAD diff --cached --name-only
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "docs(ground): opencode 1.15.4 free contract grounding — run flags, output mechanism, session model, MCP schema (SP1c Task 1)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
Report: STATUS, SHA, verbatim `opencode --version` + `opencode run --help` + `opencode session --help` (for controller verification), and one-line §3/§4 conclusions.

---

### Task 2: One tiny real run → event-vocabulary section

**Files:** Modify `docs/superpowers/grounding/2026-05-18-opencode-cli.md`.

- [ ] **Step 1: Capture exactly ONE minimal real turn** (smallest prompt, no edits, cheapest selectable model), raw stdout+stderr to a file. Adapt flags to Task-1 grounded reality (do NOT assume `--format json`):
```
cd /c/Project-TOAD/toad-local
timeout 120 opencode run "Reply with exactly: ok" <grounded-structured-output-flags> > /tmp/opencode-cap.txt 2>&1 || true
wc -c /tmp/opencode-cap.txt && cat /tmp/opencode-cap.txt
```
One turn only — no retry on model-content grounds. If structured output is ACP/serve-only per Task 1, capture that channel's real frames instead and note the transport. Leave `/tmp/opencode-cap.txt` for controller verification (do not paraphrase captured output anywhere).
- [ ] **Step 2: Append** `## 8. Verbatim structured events (one real turn)` (exact file contents, every line, byte count, exit behavior); `## 9. Event → TOAD normalized mapping` (each real event → `session_started{sessionId}` / `assistant_text` / `tool_use` / `turn_completed` / `turn_failed` / `runtime_event` / skip / `parse_error`; state the session-identity field + format); `## 10. RATIFIED event vocabulary + session model` (definitive event list; the RATIFIED first-turn + resume argv arrays + how a session is established/resumed — proven by evidence; explicitly flag anything not proven, do NOT fabricate certainty). Finalize `## 7`.
- [ ] **Step 3: Commit** the one doc:
```
git -C /c/Project-TOAD add toad-local/docs/superpowers/grounding/2026-05-18-opencode-cli.md
git -C /c/Project-TOAD -c commit.gpgsign=false commit -m "docs(ground): opencode 1.15.4 real event vocabulary (one captured turn) + RATIFIED session model (SP1c Task 2)" -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```
Report: STATUS, SHA, exact byte count of `/tmp/opencode-cap.txt`, first ~15 + last ~5 lines verbatim, §10 RATIFIED session model (2-3 lines), and explicitly whether the adapter's current `--session <id>` model is correct or what it must become.

---

### Task 3: Lock `normalizeOpencodeStreamLine` to the grounded vocabulary (TDD)

**Files:** Create `test/opencode/normalizeOpencodeStreamLine.grounded.test.js`; Modify `src/runtime/opencode/normalizeOpencodeStreamLine.js`.

- [ ] **Step 1: RED.** Read grounding doc §8/§9/§10, `src/runtime/codex/normalizeCodexExecLine.js` + `src/runtime/gemini/normalizeGeminiStreamLine.js` (TOAD-event shape precedents — match field names/shapes exactly), and the existing `test/opencode/normalizeOpencodeStreamLine.test.js` (may encode OLD ungrounded shapes — those were never real; correct them, note in commit body). Create the grounded test: one case per §9 row using the VERBATIM §8 frames as input; non-JSON/notice → skip `[]`; JSON-shaped-but-broken → `parse_error`; null/number/garbage/huge → `[]` + `assert.doesNotThrow`; session-id captured per §9. Run `node --test --no-warnings test/opencode/normalizeOpencodeStreamLine.grounded.test.js` → must fail for the right reason.
- [ ] **Step 2: GREEN.** Rewrite `normalizeOpencodeStreamLine.js` to satisfy §9 exactly, pure/total/never-throw, no IO, matching the codex/gemini normalizer TOAD-event shapes.
- [ ] **Step 3:** both `node --test --no-warnings test/opencode/normalizeOpencodeStreamLine.grounded.test.js test/opencode/normalizeOpencodeStreamLine.test.js` green.
- [ ] **Step 4: Commit** exactly `src/runtime/opencode/normalizeOpencodeStreamLine.js` + the 2 test files (the existing one only if changed). Message `fix(opencode): normalizer maps the GROUNDED opencode 1.15.4 event vocabulary (SP1c Task 3)` + trailer; `git -C /c/Project-TOAD -c commit.gpgsign=false commit`.

---

### Task 4: Correct `OpencodeExecAdapter` argv + output-consumption + session model (TDD)

**Files:** Create `test/opencode/opencodeExecAdapter.grounded.test.js`; Modify `src/runtime/OpencodeExecAdapter.js`.

- [ ] **Step 1: RED.** Read grounding doc §7/§10; the existing `test/opencode/opencodeExecAdapter.test.js` (injected-`spawnImpl` fake-child harness); `test/bundle/spawnThrowGuard.test.js` (BR1 — must still pass); `test/bundle/opencodeArgInjection.test.js` (BR5 allowlist — must still pass); `src/runtime/CodexExecAdapter.js` first-turn-vs-resume dispatch precedent. Create the grounded test asserting: (a) first-turn argv === §7 RATIFIED array; (b) resume argv === §7 RATIFIED array and uses the grounded resume mechanism (NOT a wrong `--session <uuid>` if §10 says otherwise); (c) `sendTurn` resolves on the grounded terminal event; (d) session id captured per §9 drives dispatch but is used only as grounding §10 ratifies; (e) non-zero exit/timeout → `turn_failed`; (f) BR1 pre-spawn-throw `_pendingTexts` restore intact; (g) BR5 `--model`/`--agent`/`--variant` allowlist still drops shell-metacharacter values. Run → RED for the right reasons.
- [ ] **Step 2: GREEN.** Edit `OpencodeExecAdapter.js`: first-turn/resume argv + output-consumption mechanism + session/resume per §7/§10. If §3 grounded no line-JSON (ACP/serve), correct the output-consumption seam to the real channel (spec §4 Approach-B branch) — keep the `RuntimeAdapter` surface, the `_chain`/`_pendingTexts` FIFO + BR1 guard, and `normalizeOpencodeArgs`+BR5 allowlist intact. Do not touch codex/claude/gemini.
- [ ] **Step 3:** `node --test --no-warnings test/opencode/opencodeExecAdapter.test.js test/opencode/opencodeExecAdapter.grounded.test.js test/opencode/localToadRuntime.opencodeLaunch.test.js test/bundle/spawnThrowGuard.test.js test/bundle/opencodeArgInjection.test.js test/opencode/normalizeOpencodeStreamLine.grounded.test.js` → 0 fail. Correct any pre-existing test that encoded the old ungrounded argv (note why it was never real in the commit body).
- [ ] **Step 4: Commit** exactly the changed file(s). Message `fix(opencode): adapter argv + session/output-consumption model corrected to GROUNDED opencode 1.15.4 (SP1c Task 4)` + trailer.

---

### Task 5: `opencodeMcpConfig` — correct iff schema-divergent (TDD; may be a documented no-op)

**Files:** Test `test/opencode/opencodeMcpConfig.test.js`; Modify `src/mcp/opencodeMcpConfig.js` (only if divergent).

- [ ] **Step 1: Compare** grounding §5 (real opencode MCP-config schema) vs what `opencodeMcpConfig.js` writes (read it + its test). If §5 was ambiguous (no MCP section to compare), ground the exact schema for free via `opencode mcp add --help` and a throwaway `opencode mcp add` against a temp dir you remove (SP1b Task 5 precedent), and append that to §5 (commit the doc).
  - **MATCH:** append to §5 `**RATIFIED (Task 5):** opencodeMcpConfig output matches the real opencode 1.15.4 schema — no code change.`; commit just the doc; done.
  - **DIVERGENT:** continue.
- [ ] **Step 2 (divergent): RED** test asserting the grounded §5 schema. **Step 3 (divergent): GREEN** correct `opencodeMcpConfig.js`; `node --test --no-warnings test/opencode/opencodeMcpConfig.test.js test/opencode/localToadRuntime.opencodeLaunch.test.js` → 0 fail.
- [ ] **Step 4: Commit** the doc-line (match) or config+test (divergent). Message `docs(ground): RATIFIED opencodeMcpConfig matches real opencode 1.15.4 schema — no change (SP1c Task 5)` or `fix(opencode): MCP config matches grounded schema (SP1c Task 5)` + trailer.

---

### Task 6: Front-loaded scripted e2e proof + wire into the gate (TDD)

**Files:** Create `test/fixtures/fake-opencode-grounded.mjs`, `test/opencode/opencodeGrounded.e2e.test.js`; Modify `scripts/test-suites.txt`.

- [ ] **Step 1:** Read `test/fixtures/fake-gemini-grounded.mjs` + `test/gemini/geminiGrounded.e2e.test.js` (the proven SP1b e2e pattern) + the final `OpencodeExecAdapter`/`normalizeOpencodeStreamLine`. Create `test/fixtures/fake-opencode-grounded.mjs` emitting the grounding §8/§10 RATIFIED vocabulary for a scripted turn (echo back any grounded session identity from its argv), matching the SP1b fixture's depth.
- [ ] **Step 2: RED.** Create `test/opencode/opencodeGrounded.e2e.test.js` mirroring `geminiGrounded.e2e.test.js`: real `OpencodeExecAdapter` (spawnImpl→fake) → real `normalizeOpencodeStreamLine` → real `RuntimeEventIngestor` → real `InMemoryBroker`; one `sendTurn`; assert grounded events ordered, `sendTurn` accepted, the grounded `assistant_text` becomes a delivered broker reply (SP1b honest-equivalent message proof). The seam is built (Tasks 3–4) so it may pass first-run: drive RED by transiently breaking one real link (e.g. normalizer assistant→text), confirm it fails, restore, re-pass (TDD Iron Law for proof tests).
- [ ] **Step 3: GREEN** (fixture+test; if RED exposes a real adapter/normalizer gap fix it minimally in the owning opencode module, note in commit body — do not touch codex/claude/gemini/shared).
- [ ] **Step 4: Wire the gate** — append the 3 opencode grounded suites as a SINGLE continuous line (no newline before `&&`):
```
cd /c/Project-TOAD/toad-local
node -e "const fs=require('fs');const f='scripts/test-suites.txt';let s=fs.readFileSync(f,'utf8').replace(/\r?\n/g,' ').replace(/\s+/g,' ').trim();for(const t of ['test/opencode/normalizeOpencodeStreamLine.grounded.test.js','test/opencode/opencodeExecAdapter.grounded.test.js','test/opencode/opencodeGrounded.e2e.test.js'])if(!s.includes(t))s+=' && node --no-warnings --test '+t;fs.writeFileSync(f,s+'\n')"
bash -n -c "$(cat scripts/test-suites.txt)" && echo "test-suites.txt parses OK"
```
- [ ] **Step 5: Commit** exactly `test/fixtures/fake-opencode-grounded.mjs`, `test/opencode/opencodeGrounded.e2e.test.js`, `scripts/test-suites.txt` (+ any minimal opencode-module fix). Message `test(opencode): grounded front-loaded e2e proof + wire opencode grounded suites into the root gate (SP1c Task 6)` + trailer.

---

### Task 7: Final whole-impl review + full root gate + honest status

**Files:** Modify `README.md`, `docs/ARCHITECTURE.md`.

- [ ] **Step 1: Final whole-impl two-stage review** over `git diff 627c6b67..HEAD -- toad-local/` (spec-compliance vs `2026-05-18-opencode-grounding-design.md` + code-quality). Fix Critical/Important TDD. Confirm out-of-scope diff EMPTY: `git -C /c/Project-TOAD diff 627c6b67..HEAD --stat -- toad-local/src/runtime/CodexExecAdapter.js toad-local/src/runtime/ClaudeStreamJsonAdapter.js toad-local/src/runtime/GeminiExecAdapter.js toad-local/src/runtime/codex/normalizeCodexExecLine.js toad-local/src/runtime/gemini/` must be empty (Claude/Codex/Gemini byte-unchanged).
- [ ] **Step 2: Full root gate** from `toad-local/`: `bash -c "$(cat scripts/test-suites.txt)" ; echo "EXIT=$?"` → `EXIT=0`, summed `# fail 0`, 0 `not ok`, the new opencode grounded suites ran. (If non-SP1c uncommitted WIP is dirty, scoped-stash it for an attributable gate, then restore — the SP1b Task-7 precedent.)
- [ ] **Step 3: Honest status update.** If e2e + gate prove it: `README.md` + `docs/ARCHITECTURE.md` OpenCode → **Grounded (opencode 1.15.4)** with documented residuals (mirror the SP1b Gemini status wording; no overstatement). Else document the real limitation precisely. Commit docs only (`docs(status): ... (SP1c Task 7)` + trailer).
- [ ] **Step 4:** `superpowers:finishing-a-development-branch`.

---

## Self-Review (writing-plans checklist)

**1. Spec coverage:** spec §3 grounding (free + 1 run) → Tasks 1–2. §4 correction (adapter/normalizer/mcp, ACP/serve contingency, preserve BR1+BR5) → Tasks 3,4,5 (Task 4 Step 2 carries the spec-§4 Approach-B branch + the explicit BR1/BR5 preserve). §5 testing (pure normalizer deepest, injected-spawn lifecycle, scripted e2e, gate, controller-verified grounding) → Tasks 3,4,6 + Task 1/2 report-back controller-verify hooks. §6 scope boundary (OpenCode only, A4/Gemini/Codex/Claude out) → Scope + Task 7 out-of-scope-empty check. §7 conventions → every task commit block. ✓

**2. Placeholder scan:** No "TBD/handle edge cases". Grounding-dependent values are grounded-contingencies, not placeholders: the mechanism (consume grounding-doc §N RATIFIED section; test against verbatim §8 frames) is fully specified — literal argv/event strings are intentionally determined by Tasks 1–2 because inventing them is the exact defect this slice fixes (SP1b-blessed). Task 5 "no-op if match" is a specified outcome.

**3. Type consistency:** grounding-doc section numbers (§7 argv, §9 mapping, §10 RATIFIED) referenced consistently Tasks 2→3→4→6. `normalizeOpencodeStreamLine`/`OpencodeExecAdapter`/`opencodeMcpConfig`/`normalizeOpencodeArgs` names + injected-`spawnImpl` pattern + BR1 (`_pendingTexts` restore) + BR5 (arg allowlist) referenced consistently with the existing codebase + the SP1b plan precedent.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-18-opencode-grounding.md`. Two execution options:

**1. Subagent-Driven (recommended)** — fresh subagent per task, two-stage review (spec then quality) between tasks, controller independently verifies every grounding capture + the full root gate; same rigor as SP1a/SP1b.

**2. Inline Execution** — execute tasks in this session via `superpowers:executing-plans`, batched with checkpoints.

Which approach?
