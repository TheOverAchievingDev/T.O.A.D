# SP1b — Gemini CLI Grounding & Adapter Correction — Design

**Status:** Approved (brainstorm 2026-05-18). Origin: the bundle whole-impl
review (`docs/superpowers/2026-05-18-bundle-whole-impl-review-and-fixes.md`)
deferred finding **A3** — SP1b/SP1c CLI invocation contracts + stream-JSON
event vocabularies were committed as *ungrounded assumptions*. This spec
grounds and corrects **Gemini only**.

**Program:** SP1b of the multi-provider runtime program (SP1a Codex shipped +
grounded; SP1c OpenCode and the cross-adapter A4 MCP-visibility probe are
separate follow-on slices — explicitly out of scope here).

## 1. Goal

Make the `gemini` team runtime **verified**, not assumed: replace
`GeminiExecAdapter`'s and `normalizeGeminiStreamLine`'s unverified CLI
invocation contract + event vocabulary with facts captured from the real
installed **gemini 0.42.0**, exactly as SP1a did for codex-cli 0.130
(`docs/superpowers/grounding/2026-05-17-codex-cli.md`). After this slice,
Gemini is production-trustworthy for team runs (or its real limitations are
documented honestly).

## 2. Ground truth to verify (the unverified assumptions today)

Reviewer A (bundle review) flagged these as ungrounded in `GeminiExecAdapter.js`
/ `normalizeGeminiStreamLine.js`:

- **Argv:** `--output-format stream-json --approval-mode yolo --skip-trust
  --allowed-mcp-server-names toad-local --resume <id> -p`.
- **Event vocabulary:** `init` / `message` / `result` JSON shapes the
  normalizer maps to TOAD events.
- **Auth/session:** resume mechanism (`--resume <id>`), session-id capture.

Free `gemini --help` (captured during brainstorm, 0.42.0) already shows:
`-p/--prompt` (headless; "appended to input on stdin"), `--approval-mode
{default,auto_edit,yolo,plan}`, `-y/--yolo`, `--skip-trust`,
`--allowed-mcp-server-names`, `-m/--model`, `-s/--sandbox`, `--acp`
(Agent Client Protocol). **`--output-format` and `--resume` are NOT in the
visible flag list** — strongly suggesting the adapter's structured-output
and resume assumptions are wrong for 0.42.0. This is the central risk.

## 3. Grounding methodology

**3a. Free (no model quota):** full `gemini --help`, `gemini mcp --help`,
`gemini --help` for the default subcommand, the `~/.gemini/settings.json`
MCP-config schema, model-selection flags, and the real structured-output
mechanism (`--output-format` vs `--acp` vs other). Determine the real
resume/session mechanism. Capture verbatim.

**3b. One tiny real run (bounded quota):** the smallest possible headless
invocation in **read-only `--approval-mode plan`** (no edits, minimal
tokens) to capture the **verbatim structured-event JSON** the CLI actually
emits for a trivial turn. One turn only. If 0.42.0 uses ACP/another channel
rather than line-delimited JSON, capture that channel's real frames instead.

**3c. Output:** all of the above committed to
`docs/superpowers/grounding/2026-05-18-gemini-cli.md` (SP1a grounding-doc
format: verbatim commands, verbatim output, a "DIVERGENCE vs adapter
assumptions" table, and explicit RATIFIED argv).

## 4. Correction scope

Driven by §3 findings, **minimally** correct:

- `GeminiExecAdapter` — argv (first-turn + resume), the structured-output
  consumption mechanism, session-id capture/resume dispatch, timeout/auth
  failure paths. If grounding shows no line-delimited stream-JSON (e.g. ACP),
  correct the *output-consumption seam* to the real channel — the spec
  explicitly accommodates this branch (brainstorm Approach B contingency).
- `normalizeGeminiStreamLine` (or its replacement) — map the **real** event
  shapes to TOAD's normalized vocabulary; remain pure/total/never-throw
  (the `normalizeCodexExecLine` precedent).
- `geminiMcpConfig` / `~/.gemini/settings.json` writer — only if grounding
  shows the MCP-config schema differs from what's written.

**Governance posture:** mirror the SP1a ratified stance — autonomous within
the per-task worktree + the TOAD gate stack; the exact sandbox/approval
flags (`--approval-mode` value, `-s/--sandbox`) are *set from grounded
reality*, not assumed, with the same "bounded-write, never danger-full"
intent as SP1a §7. The Claude/Codex paths stay byte-unchanged; all changes
remain behind the existing `providerId`-keyed seam.

## 5. Testing strategy

- **TDD throughout** (red→green), project discipline.
- **Pure normalizer core** — deepest coverage against the *grounded* event
  fixtures (every real event type → expected TOAD event; malformed → 
  `parse_error`; empty/edge), mutation-kill, never-throws.
- **Adapter lifecycle** with injected `spawnImpl` (no real `gemini` spawn in
  CI): first-turn vs resume argv per grounded reality, session capture,
  resolves on the grounded terminal event, `turn_failed` on non-zero/timeout,
  the BR1 pre-spawn-throw batch-restore guard preserved.
- **Front-loaded scripted e2e proof:** a stand-in `fake-gemini` emitting the
  **grounded** vocabulary (+ connecting to TOAD's MCP server over stdio),
  asserting the ingestor/drift read the normalized events — wired into
  `scripts/test-suites.txt` (SP1a §9). No real `gemini` in CI.
- Controller re-runs the full root gate (EXIT=0, fail 0) before wrap.

## 6. Scope boundary

**In scope:** gemini 0.42.0 grounding doc; `GeminiExecAdapter` +
`normalizeGeminiStreamLine` (+ `geminiMcpConfig` iff schema-divergent)
corrected to grounded reality; scripted e2e; gate wiring; README/status
update (Gemini → working iff the e2e + gate prove it).

**Out of scope (own later slices):** SP1c OpenCode grounding; the A4
first-turn MCP-tool visibility probe across session adapters; provider
usage tracking (SP2); role→provider tiering (SP3); any UI.

## 7. Conventions

Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed
paths, `git -c commit.gpgsign=false`, trailer
`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
One commit per task; the pure normalizer core is the epicenter; grounding
doc committed before the correction it justifies; mandatory whole-impl
review + full root gate before wrap.
