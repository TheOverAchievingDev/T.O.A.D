# Codex Team-Runtime Adapter (SP1a) — Design

**Status:** Approved (brainstorm 2026-05-17) · **RATIFIED 2026-05-17** (controller, against installed **codex-cli 0.130.0**; grounding doc `d1e58e1`). Material corrections: `--ask-for-approval` is not a `codex exec` flag → use `--sandbox workspace-write -c approval_policy="never"` (sandbox preserved; `--dangerously-bypass-approvals-and-sandbox` rejected); no `required` MCP key → first-turn visibility probe is the loud-fail guard; `turn.failed` carries a nested `error:{message}`; `turn.started` is new; project-trust is the non-interactive `~/.codex/config.toml [projects.'<cwd>']` write; happy-path `--json` items were a documented residual risk (probe usage-capped) — **VERIFIED 2026-05-18 against real codex 0.130.0; residual retired** (see §10 and grounding §9).
**Program:** This is **SP1a** of the multi-provider team-runtime program. Full decomposition (agreed 2026-05-17):

- **SP1** Multi-provider team runtime — **SP1a Codex** (this spec) → SP1b Gemini → SP1c OpenCode (incl. per-agent OpenCode-Zen / local-Qwen model selection).
- **SP2** Per-provider usage tracking (Codex `/status`, Gemini `/stats`; Claude probe exists; API spend for Zen).
- **SP3** Role→provider tiering + escalation (lead=Claude/Codex, architect=Claude/Codex, tester=Claude/Codex/Gemini-3+, dev=OpenCode unless task super-complex AND usage allows → frontier).
- **SP4** Model-capability map (researched in parallel via Claude Desktop).

Build order: SP1a → SP1b → SP1c, SP4 in parallel, then SP2, then SP3. Each gets its own brainstorm → spec → plan → implementation cycle. SP1b/SP1c reuse the seam this spec establishes.

## 1. Goal

Make a team member with `providerId: 'openai'` (Codex) function as a **full peer to a Claude teammate**: read, write, edit files, run tests/commands, call every TOAD tool (`message_send`, `task_*`, `review_request`, …), receive inbound messages, and be governed by the existing review / drift / risk gates — without changing the Claude path.

## 2. Ground truth (verified against shipped code + the current Codex CLI; re-verify at impl time per §10)

- **The team runtime is Claude-only today.** `RuntimeSupervisor.createAdapter()` unconditionally returns `new ClaudeStreamJsonAdapter(...)` ([RuntimeSupervisor.js:410](../../../src/runtime/RuntimeSupervisor.js)). The agentic launch unconditionally builds Claude-specific stream-json flags (`--verbose --input-format stream-json --output-format stream-json`, `--mcp-config`, `--append-system-prompt`) and spawns one persistent child ([LocalToadRuntime.js:~697-725](../../../src/app/LocalToadRuntime.js)). `RuntimeAdapter` is abstract (`launch/stop/sendTurn/sendToolResult/events/approve/health`); `ClaudeStreamJsonAdapter` is the only concrete team adapter. `openai`/`gemini`/`opencode` are *enumerated* (UI seed, MCP enum, `providerAuth`, `PROVIDER_COMMANDS`) but a non-Claude team agent would be fed Claude's protocol and would not function.
- **The adapter is a translation boundary.** `RuntimeEventIngestor`, the timeline, drift monitor, risk guards, review gates, and span-summary consume TOAD's *normalized event vocabulary* + task/board/side-effect state — none read the wire protocol. Provider-agnosticism is therefore achievable purely by faithful normalization in the adapter.
- **Codex headless reality (CLI ≥ v0.130, 2026-05-08):** `codex exec` runs non-interactively, one turn per process, then exits; multi-turn continuity is Codex's **disk-persisted session** (`codex exec resume <session_id>`, sessions under `~/.codex/sessions/`). `--json` emits JSONL items including `agent_message`, `command_execution`, `file_change`, `mcp_tool_call`, `reasoning`, `plan_update`, plus `thread.started` (carries `thread_id`) and `turn.completed`. Event vocabulary grounded historically in `CodexFoundryAdapter` (`thread.started`/`item.completed`/`turn.completed`, pinned codex-cli 0.117.0 @ 2026-04-19) — **must be re-grounded against the installed codex at impl time** (§10).
- **Codex consumes MCP servers in `exec`.** Configured via `config.toml` `[mcp_servers.<name>]`; **project-scoped `.codex/config.toml`** works for *trusted* projects without touching `~/.codex/config.toml`'s servers. `--json` emits `mcp_tool_call` items, confirming MCP tools are usable during `exec`. **RATIFIED 2026-05-17 (controller, grounding doc `d1e58e1`, codex-cli 0.130.0):** there is **no `required` key** in codex 0.130's MCP config schema — the "loud-fail if the rail can't init" guarantee CANNOT rely on `required=true`. It moves entirely to the **first-turn MCP-tool visibility probe** (now the PRIMARY guard, not a backstop): the adapter/first-turn asserts TOAD tools are visible and fails loudly if absent. The MCP `[mcp_servers.<name>]` schema is `command`, `args`, an `env` subtable of **static literals** (TOAD's env values are concrete literals → correct), optional `enabled`/`startup_timeout_sec`/`tool_timeout_sec`; env pass-through (unused here) is a separate `env_vars=[...]` list.
- **Codex governance flags (RATIFIED 2026-05-17, grounding `d1e58e1`, 0.130.0):** `codex exec` accepts `-s/--sandbox read-only|workspace-write|danger-full-access`, `--skip-git-repo-check`, `-C/--cd <path>`, `--json`, `--ephemeral`, repeatable `-c/--config <dotted.key>=<TOML value>`, and `--dangerously-bypass-approvals-and-sandbox`. **`--ask-for-approval` is NOT a `codex exec` flag** (it exists only on the top-level interactive `codex` as `-a`; passing it to `exec` → exit 2). The approval policy is the config key **`approval_policy`** (values `untrusted|on-request|never`; `on-failure` deprecated), set non-interactively via `-c approval_policy="never"`. **`--dangerously-bypass-approvals-and-sandbox` is REJECTED for SP1a** — it *removes the sandbox*, violating §7's bounded-write intent.
- **Auth:** `providerAuth.js` already models `openai` → cli `codex`, file-based status `~/.codex/auth.json`, `parseCodexFileStatus`, ChatGPT-plan (manualLogin). The file is the source of truth (no token-probe like Claude's `--print`).
- **`CodexFoundryAdapter`** ([src/foundry/providers/CodexFoundryAdapter.js](../../../src/foundry/providers/CodexFoundryAdapter.js)) proves the `codex exec [resume] --json` machinery: argv shapes, the `-` stdin sentinel, Windows `resolveCli` + `shell:true` for `.cmd` (CVE-2024-27980), stderr capture (8 KB cap), timeout/SIGTERM. It is the *foundry one-shot* path and stays **untouched**; SP1a adds a new *team* adapter that reuses its proven invocation knowledge.
- **Decision: Approach A (`codex exec [resume] --json`, process-per-turn).** Chosen on the user's stated criterion — *full functionality (real coding + all TOAD tool-rails) at the lowest risk*. It reuses the proven, version-grounded `exec` machinery and adds the minimum new seam (a session/spawn-per-turn adapter behind the unchanged `RuntimeAdapter` contract) that SP1b/SP1c reuse. Approach B (`codex app-server`, WebSocket) and Approach C (`codex` as stdio MCP-server) are persistent but newer/less-proven and were deferred as later enhancements once the seam exists. The user explicitly delegated the run-mode choice on the full-functionality criterion.

## 3. Architecture & the provider-routing seam (§1)

Two adapter **lifecycle shapes** behind the **unchanged** `RuntimeAdapter` contract:

1. **Persistent-child** (existing, Claude): unchanged.
2. **Session / spawn-per-turn** (new, Codex): the adapter owns a *logical* runtime (cwd + system prompt + a persisted `cliSessionId`); no child is pre-spawned.

Seam changes (the reusable part SP1b/SP1c inherit), all behind a `providerId === 'anthropic'` default branch — **Claude path byte-unchanged**:

- **Adapter factory becomes provider-keyed.** `RuntimeSupervisor.createAdapter()` → `adapterForProvider(providerId)`: `anthropic → ClaudeStreamJsonAdapter` (with held `child`, unchanged); `openai → CodexExecAdapter` (with cwd + session-id store, **no** `child`). A small registry is the extension point for SP1b/SP1c.
- **Launch routing becomes provider-gated.** For `providerId !== 'anthropic'`, `LocalToadRuntime` does **not** build Claude stream-json flags or pre-spawn a persistent child — it registers a *logical runtime* (cwd, system prompt, providerId, empty `cliSessionId`).
- The `RuntimeAdapter` surface, `RuntimeEventIngestor`, the event vocabulary, beast-mode per-member `providerId`, and the supervisor public API are all unchanged. The supervisor learns one additional, simpler internal lifecycle; it does not lose the Claude one.

## 4. `CodexExecAdapter` internals (§2)

Constructor `{ runtimeId, teamId, agentId, cwd, systemPrompt, sessionStore, spawnImpl, resolveCliImpl }` — no held `child`.

- **Session continuity:** the runtime registry ([sqliteRuntimeRegistry](../../../src/runtime/sqliteRuntimeRegistry.js)) gains a **nullable `cliSessionId`** column. `null` ⇒ next turn is a *first* turn; a value ⇒ *resume*. Disk-backed; survives a TOAD restart (parallels Codex's own session store).
- **`sendTurn(input)`** (reuses `CodexFoundryAdapter` argv shapes):
  - *First turn* (no `cliSessionId`): **RATIFIED argv (0.130.0):** `codex exec --json --skip-git-repo-check -C <cwd> --sandbox workspace-write -c approval_policy="never" -`; stdin = `systemPrompt\n\nuserMessage` (`codex exec` has no append-system-prompt flag — prepend on turn 1; persistent conventions live in `AGENTS.md`). (`-c approval_policy="never"` keeps the workspace-write sandbox AND runs non-interactively — NOT `--dangerously-bypass-approvals-and-sandbox`, which would strip the sandbox.)
  - *Resume*: `codex exec resume --json --skip-git-repo-check <cliSessionId> -`; stdin = `userMessage` only (prior convo+instructions on disk). **VERIFIED 2026-05-18 (real codex 0.130, grounding §10):** the `-` stdin sentinel is accepted on resume (exit 0; the historical foundry `code=2` was 0.117-era); resume **rejects `-C`/`--cd` and `--sandbox`** (locked at session creation — process is spawned with `cwd=<worktree>`, the session-stored cwd is authoritative) but **accepts `--skip-git-repo-check`** (required — worktrees/temp dirs may not be git repos); `thread.started` is re-emitted carrying the **same** `thread_id` (idempotent `cliSessionId` persist); resume `--json` vocabulary is identical to first-turn and real session continuity is confirmed.
  - Windows: `resolveCli('codex')` + `shell:true` for `.cmd`. Spawn → write stdin → `end()` (EOF starts Codex) → consume `--json` → resolve on `turn.completed`. Returns `{accepted:true, responseState:'accepted_by_runtime', receipt:{runtimeId}}`.
- **`--json` → TOAD event normalization** extracted as a **pure, total `normalizeCodexExecLine(line, ctx)` module** (the `flowCanvasModel`/`spanSummary` pure-core precedent; the adapter is a thin IO shell):
  - `thread.started` → capture `thread_id`; persist as `cliSessionId` (makes turn N+1 a resume).
  - `item.completed`/`agent_message` → `assistant_text`.
  - `item.completed` of `command_execution`/`file_change`/`mcp_tool_call`/`reasoning`/`plan_update` → `tool_use`-shaped timeline events (execution is Codex-internal/MCP-direct; TOAD does not broker it).
  - `turn.completed` → `turn_completed` (resolves the turn). Exit / `error` / exit-before-completed → `turn_failed` + captured stderr (8 KB cap, self-diagnosing). Unparseable line → `parse_error` (mirrors the Claude adapter); non-JSON warning lines dropped.
- **`events()`** — one lifelong async-iterable, *fed per-turn* (queue/waiter like `createRuntimeEventIterable`, written across successive turn children rather than one persistent stdout). `RuntimeEventIngestor` sees the identical vocabulary, unaware it is per-turn.
- **`sendToolResult` / `approve`** — structured *not-applicable* (Codex calls TOAD's MCP tools directly during the turn; no Claude-style duplex). `approve()` returns `{accepted:false, responseState:'approval_not_applicable_codex', reason:'gate-governed, not per-tool'}`.
- **`stop()`** — SIGTERM the in-flight turn child if any; the session is disk-persisted so "stopped" is a status flag; idempotent.
- **`health()`** — no long-lived child; health = codex-on-PATH + last-turn-not-failed.
- **Concurrency** — turns **serialized per agent** (FIFO, one in-flight `codex exec resume` per `runtimeId`): overlapping resume on one disk session corrupts continuity.

## 5. Inbound messaging — the wake-on-message model (§3)

The Codex *session* is durable on disk; only the *process* is ephemeral. "Contacting a dead Codex agent" = spawning a resume turn carrying the queued message(s); Codex rehydrates full prior context.

`DeliveryWorker` ([deliveryWorker.js:35](../../../src/delivery/deliveryWorker.js) already resolves the recipient adapter) becomes **adapter-shape-aware**:

- **Persistent recipient (Claude):** unchanged — write to the live process.
- **Session recipient (Codex), idle:** the message is durably enqueued in the recipient's inbox (TOAD's existing SQLite broker is durable), then the worker **wakes** it — spawns a `codex exec resume` turn carrying the pending message(s). Event-driven (`message_send` is the trigger; no polling).
- **Session recipient, mid-turn:** enqueue; the in-flight turn finishes; the next turn **drains the inbox** — multiple queued messages **batch into one resume turn** (saves Codex plan-usage; coherent context).
- **Crash safety:** message survives a TOAD crash (durable broker). On restart, a reconciliation pass: any session agent with a non-empty inbox and no in-flight turn → spawn a resume turn. No lost messages.
- **Session-loss fallback:** `cliSessionId` null/pruned ⇒ resume degrades to a fresh first-turn carrying the message + re-materialized system prompt (loses in-conversation memory; re-grounds from `AGENTS.md` + board/messages via MCP). A lost session = degraded continuity, never a lost message; emit a `runtime_event` "codex session reset".
- **Rhythm:** a Codex `exec` turn is a *full autonomous agentic run* (the agent works the delegated task to completion — many internal edits/commands/tool calls/messages — until `turn.completed`), not one chat reply. Inter-agent messages are the coordination seams *between* task-grained work; a brief wake (cold-start) latency there is the one inherent Approach-A trade-off.

## 6. Tool rails & MCP injection (§4)

- TOAD writes a per-agent project-local **`.codex/config.toml`** into the agent's worktree cwd with `[mcp_servers.toad]` pointing at the **same** TOAD MCP server Claude uses (reusing `buildToadMcpConfig`). **RATIFIED 2026-05-17:** no `required` key in 0.130 — the loud-fail guarantee is the **first-turn MCP-tool visibility probe** (the adapter/first-turn asserts the `toad` tools are visible; absent ⇒ `turn_failed("TOAD tools unavailable")`, never a silent mute agent). Mirrors the existing per-agent `.claude/settings.local.json` writer pattern, Codex's TOML format.
- **Trust setup (RATIFIED 2026-05-17, grounded):** project-scoped `.codex/config.toml` loads only for *trusted* projects. Trust is set **non-interactively** by writing `~/.codex/config.toml` `[projects.'<cwd>'] trust_level = "trusted"` (a `markCodexProjectTrusted(cwd)` step at launch). `C:\Project-TOAD` is already trusted; the per-agent worktree path is trusted explicitly. No interactive prompt is required.
- **Self-check:** the first-turn prompt instructs the agent to confirm the `toad` tools are visible; the adapter asserts an early `mcp_tool_call` capability from `--json` — a broken rail fails with a clear "TOAD tools not available to Codex agent", never a quiet useless agent.
- **`AGENTS.md`** materialized into the worktree alongside `CLAUDE.md` (same vision/conventions/stack content, Codex's format) — read at session start, survives compaction + resume.
- **First-turn system prompt:** TOAD's per-agent system prompt (team manifest, peers, message/task/review rails, role) prepended to the first turn's stdin (no append-system-prompt flag in `exec`); resume turns don't re-send it (on disk).

## 7. Governance, approval & auth (§5)

- **Sandbox policy (RATIFIED 2026-05-17, codex 0.130.0):** team-Codex launches with `--sandbox workspace-write -c approval_policy="never"` — autonomous within the per-task worktree, cannot write outside it, no interactive pause, **sandbox preserved**. **Not** `danger-full-access`, **not** `--dangerously-bypass-approvals-and-sandbox` (both strip the bounded-write guarantee). (`--ask-for-approval` is invalid on `codex exec`; `approval_policy="never"` is the config-key equivalent. Per-team override is a later knob — out of SP1a scope.)
- **The TOAD gate stack applies fully** — a Codex dev is governed by per-task worktree isolation, the drift monitor (reads normalized file-change/task-transition events), risk guards (task/side-effect data, provider-agnostic), the review_request gate (a reviewer must approve before merge_ready), and the lead's orchestration. A TOAD-gated Codex is *more* contained than a raw one — the gates are why non-frontier devs are acceptable.
- **The one Claude-only gap, precisely scoped:** no live per-tool `can_use_tool` popup for Codex (Claude-Code-only duplex). Workflow/task-level approval gates (review approvals, human-approval-required tasks via the approval broker) are TOAD-level and **still apply to Codex unchanged**. Only the per-keystroke CLI prompt (ill-fitting for headless multi-agent) is absent, by design.
- **Auth:** ChatGPT-plan via `codex` login; `providerAuth.parseCodexFileStatus` detects signed-in state from `~/.codex/auth.json`. Launch does a **lightweight file-based auth preflight** for Codex: if unauthenticated, the runtime **fails fast** ("Codex not authenticated — run `codex login`"), never a doomed silent spawn.
- **Plan-usage boundary:** SP1a only needs to *not crash* on a usage-exhausted Codex — a quota-failed turn surfaces as `turn_failed` with the reason. Usage tracking + escalation is SP2/SP3.

## 8. Error handling & edge cases (§6)

- **codex not installed / off PATH:** ENOENT → clean runtime-failed state, not a crash.
- **Turn timeout:** generous + configurable per-turn cap (team turns are long autonomous work, far above foundry's 5-min planning default); on cap → SIGTERM → `turn_failed(timeout)`. The session-aware stuck-monitor is the real backstop.
- **Stale/lost/missing `cliSessionId`:** detect resume non-zero "unknown session" → fall back to fresh first-turn carrying pending message(s) + re-materialized system prompt; emit `runtime_event` "codex session reset". Never a lost message or wedged agent.
- **Non-zero exit before `turn.completed`:** capture stderr (8 KB cap) → `turn_failed` with stderr suffix (self-diagnosing). Quota exhaustion surfaces honestly here.
- **Stuck-runtime monitor — required session-adapter path (or broken day one):** `stuckRuntimeMonitor` assumes a persistent child. For session adapters, idle-no-process between turns is *normal*; "stuck" = an **in-flight turn** exceeding the cap with no `--json` progress. The monitor must consult adapter shape. SP1a must include this.
- **MCP rail failed to load (RATIFIED — no `required` key in 0.130):** the **first-turn MCP-tool visibility probe is the primary guard** — the adapter asserts the `toad` MCP tools are visible early in the first turn (via the `mcp_tool_call` capability / a tool-list assertion); absent ⇒ `turn_failed("TOAD tools unavailable")`. Never a silent mute agent.
- **Empty/no-op turn:** a turn with file_change/command/mcp items but no chat text is **legitimate** (not a failure, unlike the stricter foundry adapter). A truly empty turn → `runtime_event` warning, not a hard fail.
- **Stop mid-turn:** SIGTERM in-flight child, mark stopped, hold inbox; later messages queue but don't wake a stopped agent (delivered if relaunched).
- **TOAD crash mid-turn:** Codex's on-disk session is the last *committed* state; the killed turn's partial work may be lost (partial worktree edits — true of any crashed agent; drift/review catches incoherence). On restart, reconciliation re-delivers the inbox via fresh resume. Surface honestly; don't pretend the crash was clean.

## 9. Testing strategy (§7)

TDD throughout (project discipline). Backend-only — **no UI in SP1a** (the provider is already pickable; UI surfacing is later). `CodexFoundryAdapter` untouched.

- **Pure normalization core** `normalizeCodexExecLine(line, ctx)` — pure/total/never-throws, own local types, standalone-testable (`spanSummary`/`flowCanvasModel` precedent). The epicenter (it is *why* drift/risk/review work unchanged) → deepest coverage + a mutation-kill check: every `--json` item type → expected TOAD event; `thread.started` → session-id capture; malformed/non-JSON → `parse_error`/dropped; empty/edge.
- **Adapter lifecycle** with injected `spawnImpl` (the `CodexFoundryAdapter` test pattern, no real `codex` spawn): first-turn vs resume argv, session-id capture+persist, `sendTurn` resolves on `turn.completed`, `turn_failed` on non-zero/timeout/stderr, stale-session→first-turn fallback, per-agent concurrency serialization, `stop()` kills the child.
- **Supervisor provider-routing:** `openai → CodexExecAdapter`, `anthropic → ClaudeStreamJsonAdapter`; launch-gating emits no Claude stream-json flags for codex; **all existing Claude tests stay green** (byte-unchanged invariant — additive only).
- **DeliveryWorker session-shape:** deliver to idle session agent → enqueue + wake (resume turn); deliver mid-turn → batched into next; crash-reconciliation drains the inbox.
- **Stuck-monitor session path:** idle session agent (no child) is **not** flagged stuck; in-flight turn with no `--json` progress **is**.
- **Front-loaded end-to-end proof:** a scripted stand-in `codex` (a node script emitting the real `--json` vocabulary + actually connecting to TOAD's MCP server over stdio): agent "boots", calls `message_send`, makes a file change; assert the ingestor + drift read the normalized events. Validates the riskiest seam **before** the full wake-on-message build; no real `codex` binary in CI.
- Root backend suite stays green.

## 10. Scope boundary & §8d grounding pins

**In scope (SP1a):** Codex functioning as a team agent in *any* role — `CodexExecAdapter` + provider-routing seam + per-agent `.codex/config.toml` MCP rail + trust setup + `AGENTS.md` materialization + first-turn system prompt + file-based auth preflight + wake-on-message delivery + session-aware stuck-monitor path + full tests.

**Out of scope (other sub-projects):** Gemini/OpenCode adapters (SP1b/SP1c — reuse this seam); usage tracking & quota-aware escalation (SP2); the role→provider tiering policy / beast-preset (SP3); the model-capability map (SP4); provider-aware *compaction thresholds* (SP2-adjacent/follow-up — SP1a must only *not regress* existing compaction; Codex's own auto-compaction + `AGENTS.md`-survives-compaction handles within-turn); configurable per-team sandbox policy; any UI change.

**§8d grounding pins — RESOLVED for 0.130.0 by the committed grounding doc `docs/superpowers/grounding/2026-05-17-codex-cli.md` (`d1e58e1`); re-verify only if the installed `codex` changes:**

- ✅ RATIFIED argv (0.130.0): `codex exec --json --skip-git-repo-check -C <cwd> --sandbox workspace-write -c approval_policy="never" -`. `--ask-for-approval` is NOT a `codex exec` flag (top-level `-a` only; → exit 2 on exec). `--dangerously-bypass-approvals-and-sandbox` exists but is REJECTED (strips the sandbox).
- ✅ **`--json` vocabulary — FULLY VERIFIED (2026-05-18 real-codex smoke; residual retired):** `thread.started`+`thread_id`, `turn.started` (NEW → `runtime_event`), `error`=`{type:'error',message}`, `turn.failed`=`{type:'turn.failed',error:{message}}` (nested) were grounded at probe time. The previously-unobserved happy-path items are now **confirmed against real codex 0.130.0**: `item.completed`/`agent_message`+`text` → `assistant_text`; `turn.completed` → `turn_completed` (now also carries a `usage` object — **SP2-relevant**, per-turn tokens in-stream); generic `item.completed`/`<type>` → `tool_use` (`command_execution` observed; on **Windows file edits surface as `command_execution`**, not `file_change`; `mcp_tool_call` flows the identical generic branch — structurally covered). A previously-undocumented **`item.started`** (`status:"in_progress"`, before each `item.completed`) was observed and correctly degrades to `runtime_event` (no double-counted tool call) — locked by a characterization test. **No adapter/normalizer code change required.** Full verbatim shapes: grounding §9.
- ✅ project-scoped `.codex/config.toml [mcp_servers.toad]` honored by `codex exec` for *trusted* projects; **no `required` key** (loud-fail = first-turn visibility probe); trust set non-interactively via `~/.codex/config.toml [projects.'<cwd>'] trust_level="trusted"`.
- The real `RuntimeAdapter` contract + `ClaudeStreamJsonAdapter` shapes + `RuntimeSupervisor.createAdapter` call sites + `LocalToadRuntime` launch construction + `DeliveryWorker`/broker inbox API + `sqliteRuntimeRegistry` schema + `stuckRuntimeMonitor` assumptions + `providerAuth.parseCodexFileStatus`, each re-read before the step that touches it. The Claude path must be **provably byte-unchanged** (every change behind a non-`anthropic` branch).
- **RATIFIED 2026-05-17 (whole-impl code-quality Important):** launch/adapter
  dispatch prefers the authoritative `input.providerId`; it falls back to
  exact-match `providerForCommand(command)` only when providerId is absent.
  Residual (no providerId AND a non-canonical command, e.g. an operator
  custom binary path) still command-derives — fully providerId-first
  dispatch across all sites is Stage-2 / provider-plumbing scope.

## 11. Conventions

Commit directly to `main`: `git -C /c/Project-TOAD`, `toad-local/`-prefixed paths, `git -c commit.gpgsign=false`, trailer `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`. Subagent-driven execution: fresh implementer per task, two-stage review (spec-compliance then code-quality), controller independently verifies every DONE; the pure `normalizeCodexExecLine` core is the epicenter; mandatory whole-impl review before the final commit; front-load the end-to-end proof to de-risk the MCP-rail + wake-on-message seams early.
