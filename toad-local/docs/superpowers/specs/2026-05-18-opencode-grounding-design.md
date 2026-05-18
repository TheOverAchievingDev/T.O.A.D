# SP1c — OpenCode CLI Grounding & Adapter Correction — Design

**Status:** Approved (brainstorm 2026-05-18). Origin: the bundle whole-impl
review (`docs/superpowers/2026-05-18-bundle-whole-impl-review-and-fixes.md`)
deferred finding **A3** — SP1b/SP1c CLI invocation contracts + event
vocabularies were committed as *ungrounded assumptions*. SP1b (Gemini)
shipped + grounded (`docs/superpowers/grounding/2026-05-18-gemini-cli.md`,
origin/main `c2bf7b09`). This spec grounds and corrects **OpenCode only**,
following the exact SP1b grounding-first pattern.

**Program:** SP1c of the multi-provider runtime program (SP1a Codex shipped
+ grounded; SP1b Gemini shipped + grounded). The cross-cutting **A4**
first-turn MCP-visibility probe across all session adapters remains a
separate later slice — explicitly out of scope here.

## 1. Goal

Make the `opencode` team runtime **verified**, not assumed: replace
`OpencodeExecAdapter`'s and `normalizeOpencodeStreamLine`'s unverified CLI
invocation contract + event vocabulary with facts captured from the real
installed **opencode 1.15.4**, exactly as SP1a (codex 0.130) and SP1b
(gemini 0.42.0) did. After this slice, OpenCode is production-trustworthy
for team runs (or its real limitations are documented honestly).

## 2. Ground truth to verify (the unverified assumptions today)

Reviewer A (bundle review) flagged these as ungrounded in
`OpencodeExecAdapter.js` / `normalizeOpencodeStreamLine.js`:

- **Argv:** `run --format json --dangerously-skip-permissions --session <id>`.
- **Event vocabulary:** `step_start` / `step_finish` / `part`/`part.tokens` /
  `text` shapes the normalizer maps.
- **Session/auth:** `--session <id>` resume model; auth-file location.

Free context already captured (opencode 1.15.4, no cost): the headless
subcommand is **`opencode run [message..]`** ("run opencode with a
message"); there are also `opencode acp` (Agent Client Protocol server),
`opencode serve` (headless server), `opencode session` (manage sessions),
`opencode stats` (token usage), `opencode models`, `opencode providers`
(aliased `auth`). Auth on this machine is present at the **legacy**
`~/.local/share/opencode/auth.json` (NOT `%APPDATA%`) — already handled by
the BR6 multi-candidate `resolveOpencodeAuthFile`. The real `run` flags
(`--format`? `--session`? `--model`? a permissions flag?), the real
structured-output mechanism, and the real session/resume model are on
`opencode run --help` / `opencode session --help` and are the central
unknowns. The central risk (SP1b precedent): the assumed argv/session/event
shapes may be wrong; `opencode run` may emit no line-delimited JSON and
structured output may only exist via `acp`/`serve`.

## 3. Grounding methodology

**3a. Free (no API spend):** `opencode run --help`, `opencode session
--help`, `opencode mcp --help`, `opencode auth/providers` + `opencode
models` surface, the real `auth.json` + MCP-config schema, the structured-
output mechanism (`--format json` vs `acp` vs `serve`), and the real
session/resume model. Verbatim capture.

**3b. One tiny real run (bounded, metered API spend):** the smallest
possible `opencode run` invocation — trivial prompt, no edits, cheapest
selectable model — to capture the **verbatim structured events** for one
turn. One turn only. If 1.15.4 emits no line-delimited JSON (ACP/serve
only), capture that channel's real frames instead and note the transport.

**3c. Output:** committed to
`docs/superpowers/grounding/2026-05-18-opencode-cli.md` (SP1b grounding-doc
format: verbatim commands + output, a DIVERGENCE-vs-adapter table, RATIFIED
argv + RATIFIED event vocabulary + RATIFIED session model).

## 4. Correction scope

Driven by §3 findings, **minimally** correct:

- `OpencodeExecAdapter` — first-turn + resume argv, the structured-output
  consumption mechanism, session-id capture/resume dispatch, timeout/auth
  failure paths. If grounding shows no line-delimited JSON (e.g. ACP/serve),
  correct the *output-consumption seam* to the real channel — the spec
  explicitly accommodates this branch (Approach B contingency). **Preserve
  the BR1 pre-spawn-throw `_pendingTexts` batch-restore guard and the BR5
  `--model/--agent/--variant` shell-arg allowlist** (both shipped in the
  bundle-review fixes) unless grounding proves a flag name wrong.
- `normalizeOpencodeStreamLine` — map the **real** event shapes to TOAD's
  normalized vocabulary; pure/total/never-throws (the
  `normalizeCodexExecLine`/`normalizeGeminiStreamLine` precedent).
- `opencodeMcpConfig` — only if grounding shows the MCP-config schema
  differs from what is written (SP1b Task 5 pattern: documented no-op if it
  matches, grounded by a real `opencode mcp add`).

**Governance posture:** mirror the SP1a/SP1b ratified stance — autonomous
within the per-task worktree + the TOAD gate stack; the exact
permissions/approval flags are *set from grounded reality*, not assumed,
with the same bounded-write intent. Claude/Codex/Gemini paths stay
byte-unchanged; all changes behind the existing `providerId`-keyed seam.

## 5. Testing strategy

- **TDD throughout** (red→green), subagent-driven, two-stage review per
  task, controller-verified grounding (independently re-run the real CLI;
  never trust a subagent's capture).
- **Pure normalizer core** — deepest coverage against the *verbatim
  grounded* event fixtures (every real event type → expected TOAD event;
  malformed → `parse_error`; non-JSON/empty → skip/`[]`; never throws).
- **Adapter lifecycle** with injected `spawnImpl` (no real `opencode`
  spawn in CI): first-turn vs resume argv per grounded reality, session
  capture, resolves on the grounded terminal event, `turn_failed` on
  non-zero/timeout, BR1 guard + BR5 allowlist preserved.
- **Front-loaded scripted e2e proof:** a stand-in `fake-opencode` emitting
  the grounded vocabulary + exercising the real
  adapter→normalizer→`RuntimeEventIngestor`→broker seam (the SP1b e2e
  pattern); must genuinely bite (RED by breaking a real link). Wired
  single-line into `scripts/test-suites.txt` (no newline before `&&`).
- Controller re-runs the full root gate (EXIT=0, fail 0, 0 not-ok, the new
  opencode grounded suites ran) before wrap.

## 6. Scope boundary

**In scope:** opencode 1.15.4 grounding doc; `OpencodeExecAdapter` +
`normalizeOpencodeStreamLine` (+ `opencodeMcpConfig` iff schema-divergent)
corrected to grounded reality; scripted e2e; gate wiring; honest
README/ARCHITECTURE status update (OpenCode → grounded-against-1.15.4 with
documented residuals iff the e2e + gate prove it).

**Out of scope (own later slices):** the **A4** first-turn MCP-tool
visibility probe across all session adapters; provider usage tracking
(SP2); role→provider tiering (SP3); model-capability map (SP4); any UI;
Gemini/Codex/Claude changes.

## 7. Conventions

Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed
paths, `git -c commit.gpgsign=false`, trailer
`Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
One commit per task; the pure normalizer core is the epicenter; grounding
doc committed before the correction it justifies; mandatory final
whole-impl review + full root gate before wrap; honest residuals
(no overstatement — match the SP1b status-update precedent).
