# A4 — First-Turn MCP-Tool Visibility Probe (cross-adapter) — Design

**Status:** Approved (brainstorm 2026-05-18). Origin: the bundle whole-impl
review (`docs/superpowers/2026-05-18-bundle-whole-impl-review-and-fixes.md`)
deferred finding **A4**, and SP1a design §6/§8 which **RATIFIED** the
first-turn MCP-tool visibility probe as the PRIMARY loud-fail guard (codex
0.130 has no `required` MCP-config key). SP1a/SP1b/SP1c shipped the session
adapters but none implements the probe — a broken `toad` MCP rail today
produces a *silently mute agent* (it runs, but can never call
`message_send`/`task_*` and just looks idle). This slice closes that hole
across all session adapters.

**Program:** Cross-cutting A4 of the multi-provider runtime program (SP1a
Codex, SP1b Gemini, SP1c OpenCode all shipped + grounded). After A4: a
broken TOAD rail fails loudly on the first turn instead of silently. SP2
(usage tracking), SP3 (tiering), SP4 (capability map) remain out of scope.

## 1. Goal

A broken/missing `toad` MCP rail must surface as a loud first-turn
`turn_failed("TOAD tools unavailable…")` — never a silent, useless agent —
for every session-lifecycle adapter (`CodexExecAdapter`,
`GeminiExecAdapter`, `OpencodeExecAdapter`). Realize the SP1a-§6/§8-ratified
"first-turn prompt instructs the agent to confirm the `toad` tools are
visible; absent ⇒ `turn_failed`" intent, using a detection signal that is
**grounded for all three providers**.

## 2. Ground truth / why the signal is a text sentinel

The SP1a-literal signal was "assert an early `mcp_tool_call`/`tool_use` from
`--json`." But only **Codex's** tool-event shape is grounded (codex 0.130
grounding §9: `mcp_tool_call` flows the generic `item.completed`→`tool_use`
branch). **Gemini's** `tool_use` branch is explicitly *"shape unverified in
0.42.0 probe"* (`normalizeGeminiStreamLine.js`); **OpenCode's**
`normalizeOpencodeStreamLine` has *no* tool mapping (SP1c grounding captured
only a trivial `step_start`/`text`/`step_finish` turn; `tool`/`error`
degrade to `runtime_event`). A probe waiting on a normalized `tool_use`
would therefore *loud-false-fail Gemini/OpenCode even when tools work*.

`assistant_text` IS grounded for all three (codex `agent_message`→
`assistant_text`; gemini `message`/assistant→`assistant_text`; opencode
`text`→`assistant_text`). So the probe uses a **text sentinel**: the
first-turn prompt instructs the agent to call a designated read-only `toad`
MCP tool and, ONLY if it returns successfully, include a fixed token in its
reply; the probe asserts that token in the first turn's `assistant_text`.

**Honest residual (documented, not overstated):** the sentinel proves a
*compliant* agent that successfully invoked the tool; a non-compliant model
could emit the token without a successful tool call. This is strictly safer
than today's silent-mute failure and is the SP1a-ratified posture — recorded
as a residual, mirroring the SP1b/SP1c honesty precedent. (A future
hardening could add the grounded-`tool_use` signal per provider once their
tool-event shapes are grounded — explicitly out of A4 scope.)

## 3. Architecture (Approach A — shared pure core + thin per-adapter hook)

New pure unit **`src/runtime/firstTurnMcpProbe.js`** (the normalizer-pure-
core / shared-helper precedent — no IO, total, never-throws, own local
types, standalone-testable):

- `buildProbeInstruction()` → a short instruction block appended to the
  **first-turn** prompt only: "Before doing anything else, call the
  read-only TOAD MCP tool `<TOOL>` (no arguments). ONLY if it returns
  successfully, include the exact token `⟦TOAD_MCP_OK⟧` somewhere in your
  reply. If you cannot see or call that tool, do not emit the token."
  `<TOOL>` = a real read-only, no-argument, side-effect-free TOAD MCP tool —
  grounded at impl from `src/mcp/localToolDefinitions.js` (grounded
  contingency: the mechanism is fully specified; the literal tool name is
  read from the real tool list, not invented). The sentinel constant is
  exported.
- `evaluateFirstTurnProbe(events) → { satisfied: boolean, reason: string }`
  — pure: `satisfied` iff any event is `type:'assistant_text'` whose `text`
  contains the sentinel. Total on any input (`[]`/garbage → not satisfied,
  never throws).

**Per-adapter hook** (identical shape in all 3 session adapters, behind the
first-turn branch only):

- First turn (NOT resume): append `buildProbeInstruction()` to the prompt
  the adapter already prepends/sends.
- While consuming the turn's normalized events, collect them (the adapters
  already iterate normalized events for `session_started`/`turn_completed`).
- On the terminal event (`turn_completed`): if `evaluateFirstTurnProbe`
  is **not** satisfied, the turn result becomes
  `turn_failed("TOAD tools unavailable: <provider> agent could not confirm
  the toad MCP rail on the first turn")` instead of the accepted result
  (push the `turn_failed` event + return the not-accepted receipt), reusing
  each adapter's existing single-source terminal-failure path / `__failError`
  convention.
- **Resume turns: the probe is skipped entirely** (no instruction appended,
  no evaluation) — continuity is on disk; re-probing every turn would waste
  tokens and risk false-fails.
- Must compose cleanly with the existing **BR1** pre-spawn-throw
  `_pendingTexts` batch-restore, the session-loss fallback (a
  probe-failed first turn is a normal `turn_failed`, NOT a session-reset
  trigger), and the `_chain` FIFO. No change to any non-first-turn path.

The `RuntimeAdapter` surface, the normalizers, `RuntimeEventIngestor`, and
the **Claude path are byte-unchanged**. Claude (`ClaudeStreamJsonAdapter`,
persistent child) is **out of scope** — it has the Claude-Code
`can_use_tool` duplex (SP1a §7); the probe concern is the session adapters
that lack the `required`-key guarantee.

## 4. Scope boundary

**In scope:** `src/runtime/firstTurnMcpProbe.js` (new pure core); the
first-turn hook in `CodexExecAdapter`, `GeminiExecAdapter`,
`OpencodeExecAdapter`; tests + scripted broken-rail e2e per provider; gate
wiring; honest README/ARCHITECTURE status (the silent-mute residual closed;
the compliant-agent residual documented).

**Out of scope:** Claude/`ClaudeStreamJsonAdapter`; the
`CodexFoundryAdapter`; grounding any provider's `tool_use` event shape (a
later hardening); SP2 usage tracking; SP3 tiering; SP4 capability map; any
UI. Claude/Codex/Gemini/OpenCode non-first-turn behavior must be provably
unchanged except the intended first-turn-prompt addition + the probe-fail
path.

## 5. Testing strategy

- **TDD throughout** (red→green), subagent-driven, two-stage review per
  task, controller-verified.
- **Pure core `firstTurnMcpProbe` — deepest coverage:** sentinel present
  (single/multi `assistant_text`, sentinel split is NOT required — it must
  appear within one `assistant_text`), sentinel absent → not satisfied,
  empty/garbage/non-array → not satisfied + never throws; the instruction
  text contains the grounded tool name + the exact sentinel constant;
  mutation-kill on the satisfied predicate.
- **Per-adapter lifecycle** (injected `spawnImpl`, no real CLI): first turn
  whose stream lacks the sentinel → `turn_failed("TOAD tools unavailable…")`
  and NOT an accepted receipt; first turn whose `assistant_text` carries the
  sentinel → accepted; a **resume** turn → probe skipped (no instruction in
  argv/prompt, accepted even with no sentinel); BR1 pre-spawn-throw guard
  still holds; session-loss fallback unaffected.
- **Front-loaded scripted e2e per provider:** extend the existing
  `fake-{codex,gemini,opencode}` fixtures with a "broken-rail" mode (emits a
  normal turn WITHOUT the sentinel) → assert the real
  adapter→normalizer→ingestor path yields `turn_failed`; and a
  "healthy-rail" mode (sentinel in the grounded `assistant_text`) → accepted.
  Must genuinely bite. Wired single-line into `scripts/test-suites.txt`
  (no newline before `&&`).
- Controller re-runs the full root gate (EXIT=0, fail 0, 0 not-ok, the new
  A4 suites ran) before wrap; out-of-scope diff EMPTY (Claude/foundry/
  normalizers byte-unchanged).

## 6. Conventions

Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed
paths, `git -c commit.gpgsign=false`, trailer
`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
One commit per task; the pure `firstTurnMcpProbe` core is the epicenter;
the designated TOAD tool name is grounded from the real
`localToolDefinitions` before the hook that depends on it; mandatory final
whole-impl review + full root gate before wrap; honest residual wording
(no overstatement — match the SP1b/SP1c status precedent).
