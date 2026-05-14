# Symphony AI — Project specification

> **This is the non-negotiable contract.** Every contributor (human or agent) reads this at the start of every session. The rules below trump anything else — plan docs, code comments, sibling specs. When a code change appears to violate one of these rules, stop and either redesign the change or escalate to update this document. Do not silently relax an invariant.

> **🚨 Pre-rollout blocker — naming.** "Symphony" is taken in the AI/dev-tools space. Real name TBD before any public ship. See `docs/FUTURE-IDEAS.md`. References to "Symphony" / "Symphony AI" in this doc are placeholders.

---

## 1. What we are building

A **local-first multi-agent orchestrator** that lets non-developers build software by directing a team of role-bound AI agents. Desktop app (Tauri + Node sidecar + SQLite + React). The user describes what they want; agents build it; the user watches and intervenes when necessary.

The product has two halves that **must remain physically separated**:

| | Symphony app | User workspace |
|---|---|---|
| **Lives in** | `toad-local/` (this repo) | Any folder the user picks |
| **Contains** | Orchestrator code, system prompts, MCP servers, the Cockpit UI, the drift monitor, the planning Foundry | The user's actual project — their meal planner, their note-taking app, their game |
| **Touched by agents** | **NEVER** | Always — this is where they work |

Conflating these two is the most critical architectural failure mode. See §4 for the isolation contract.

## 2. Who it's for

The **bouncer-givers-up** — people priced out of professional dev tools (Cursor at $20/mo, Devin at $500/mo, Claude Code itself if you don't know to set up an Anthropic subscription). They have ideas, some tech-adjacent skills, and a Claude Pro / Codex Plus / Gemini Pro subscription. They want to ship `meal-planner` for their household of four without learning React.

This audience is NOT:
- Professional developers with Cursor + Copilot subscriptions
- AI/ML engineers building model integrations
- Enterprise teams (yet — that's "Symphony Cloud" later, see `docs/FUTURE-IDEAS.md`)

UX decisions favor calm, observable behavior over power-user density. The default ("FOR me") landing is the Cockpit screen with agent cards and a plain-English event timeline. The "WITH me" power mode adds Cursor-style code surfaces but is opt-in via a Settings toggle.

## 3. The economic promise

**Your subscription, not your API.**

Every agent invocation goes through the user's locally-installed CLI (`claude.exe`, `codex.exe`, `gemini.exe`). The CLI uses the user's existing subscription. Symphony **never** holds API tokens, never bills the user, and never proxies LLM calls.

This is the architectural reason every agent is spawned as a child process via `child_process.spawn`, not invoked via the Anthropic SDK. Switching to the SDK would break the subscription promise — Anthropic SDK requires an API key, which means token billing, which prices out the audience.

When a Symphony developer is tempted to "just use the SDK for this one thing" — stop. There's always a way to do it via CLI. See `src/foundry/providers/*FoundryAdapter.js` for the pattern: each adapter wraps a persistent CLI subprocess with stream-json IO.

## 4. The agent isolation contract — INVARIANT

**Agents NEVER access files outside their assigned workspace.**

The workspace is whatever directory the user picked when creating the project. The Symphony app's own code (this repo, `toad-local/`) is not the workspace. The user's home directory is not the workspace. The OS root is not the workspace.

### Enforcement

Isolation is enforced by **scoping the CLI's native tools to the workspace path**, NOT by disabling them. Native CLI tools (Read, Edit, Write, Bash, Grep, Glob) stay enabled because they're the entire productivity story — without them agents can't `npm install`, run tests, or grep the code. Instead:

1. The supervisor spawns the CLI with `cwd` set to the absolute workspace path.
2. The supervisor writes a workspace-scoped `.claude/settings.json` (or equivalent for codex/gemini) with allow-rules that constrain file operations to the workspace.
3. The CLI's own permission system enforces the boundary at every tool call.
4. **Do not pass `--dangerously-skip-permissions` or `--permission-mode bypassPermissions`** — those flags disable the very system that enforces isolation. Symphony's existing spawn args currently DO pass these; removing them is part of the agent-isolation slice tracked separately.

For docs/instructions agents need (Foundry-generated steering, ADRs, definition-of-done, etc.), Symphony copies them **into the workspace at `docs/foundry/*.md`** at materialize time. Agents read from there. They never read from the app's own source.

### What's enforced vs what's social

Symphony's own MCP file tools (`ide_read_file`, `ide_write_file`, `ide_tree_list` in `src/ide/ideFileTools.js`) are already sandboxed: absolute paths rejected, `..` traversal blocked, realpathSync used. That's good but insufficient — those tools are optional from the agent's perspective. The CLI's built-in tools are the dominant path and must be the enforcement point.

Bottom line: **trust the CLI's permission model, configure it correctly, remove the dangerous-skip flags.** Don't reinvent the sandbox; use the one the CLI vendor already built.

## 5. The two-cwd model — INVARIANT

Three "current directories" exist in this system. They mean different things. Confusing them causes bugs (see Bug 2 from 2026-05-12 triage where a seeded `lead.cwd: '.'` made agents operate in the wrong place).

| Term | What it is | Example |
|---|---|---|
| **Sidecar cwd** | The Node process's cwd. Set by however the user launched (`start-dev.bat`, `start-desktop.bat`, manual `node` invocation). Stored as `this.projectCwd` in `localToolFacade.js`. | `C:\Users\Nova_\projects\meal-planner` (after `switch_project` fired) or `C:\Project-TOAD\toad-local` (default when launched from the repo) |
| **Workspace** | The directory the user picked as their project root. Should equal sidecar cwd after the `switch_project` flow runs. | `C:\Users\Nova_\projects\meal-planner` |
| **Agent cwd** | The cwd the supervisor passes to `child_process.spawn`. **Must be** the workspace, expressed as an absolute path. | `C:\Users\Nova_\projects\meal-planner` |

Rules:
- Never store relative paths (`.`, `..`, `./sub`) in a team config's `lead.cwd` or `teammates[N].cwd`. Resolve to absolute before persistence.
- Sidecar cwd MUST equal workspace before any agent spawns. The "Start new project" flow calls Tauri's `switch_project` which respawns the sidecar against the new path — without that, all agents inherit the wrong cwd.
- In web view (no Tauri), `switch_project` cannot respawn the sidecar. The "new project" flow must either error out, prompt for manual sidecar restart, or block until a desktop-shell launch.

## 6. The interaction model

Operators interact with Symphony through five touchpoints, in roughly this order during a typical session:

1. **Foundry chat** — Plan the project. A separate AI (Claude / Codex / Gemini per user choice) helps draft 7 docs: `product_brief`, `tech_spec`, `roadmap`, `task_breakdown`, plus optional `steering`, `design_decisions`, `definition_of_done`. Foundry sessions are short-lived; they end when the user clicks Materialize.
2. **Materialize** — Take the Foundry plan and create (a) a team config (`team_create`), (b) starter tasks (`foundry_project_seed_tasks`), (c) the `docs/foundry/*.md` files in the workspace.
3. **Cockpit** — Watch the agents work. The signature surface. FOR-me mode shows agent cards + plain-English event timeline + inspector. WITH-me mode adds file tree + Monaco editor + bottom panel.
4. **Agent Inbox** — The right-side panel. Pick an agent, Ask / Delegate / Interrupt. Persistent conversation per agent. This is the primary intervention mechanism.
5. **Approvals + Drift** — Quality gates. Approvals block destructive changes pending human OK. Drift surfaces process violations (task closed without merge evidence, role permission violations, etc.).

What operators **do not** do in the typical flow:
- Write code themselves. (Power-user mode allows it; FOR-me mode hides the editor.)
- Manually trigger agent prompts via raw CLI calls.
- Edit the Foundry-generated docs after materialize (the agents own them now; the operator can re-Foundry if they need to redraft).

## 7. Process lifecycle invariants

The supervisor + runtime registry coordinate the lifecycle of every agent process. The rules:

1. **Every running agent has a registry row.** No "ghost" processes that aren't tracked. The reconcile-on-boot path (`sqliteRuntimeRegistry.reconcileOrphans`) marks any stale rows stopped and reports orphaned PIDs the supervisor can taskkill.
2. **`agent_stop` is idempotent.** Calling it on an already-stopped runtime is a no-op. The Stop-all-agents button relies on this.
3. **Resume preserves history.** `team_launch` against an existing team relaunches the agents with the same `runtime-<teamId>-<agentId>` ids; messages, tasks, events from the prior session remain intact.
4. **End deletes the team but not the data.** `team_delete` removes the team config; tasks, messages, drift findings, foundry artifacts all stay in SQLite. The team can be re-created (different config) later in the same workspace.
5. **Stale `running` rows must be cleared before re-spawn.** If a sidecar restart leaves a registry row marked `running` with no live adapter, `team_launch` marks it `stopped` before spawning the replacement. Otherwise the §13 stuck-runtime monitor false-flags. (Bug 4 fix, commit `51e65e6`.)

## 8. Quality gates

Three orthogonal mechanisms keep agents honest:

- **Drift monitor** (`src/drift/`). Periodic (5min) + event-triggered checks. 8 deterministic checks + 1 LLM judge. Emits findings the operator sees in the Drift screen. Finds: tasks marked done without merge evidence, role permission violations, missing test artifacts, invalid lifecycle transitions, semantic drift from steering docs.
- **Validations** (`validation_run`). Per-task lint/typecheck/test/build runs. Agents fire them; results land on the task; the merge gate checks them.
- **Risk policy + approvals**. Tasks with `requiresHumanApproval: true` block at the human-gate step. Risk classification (`src/policy/riskClassifier.js`) auto-tags tasks touching sensitive paths.

These three are **not** the agent isolation contract. They're behavior gates, not security boundaries. Even with all three passing, a misbehaving agent could still try to read outside the workspace — which is why §4 must be enforced at the CLI permission layer.

## 9. Provider architecture

Symphony supports three CLI providers, each with its own adapter:

- **`claude.exe`** (Anthropic). Primary provider. Uses `--mcp-config`, `--input-format stream-json`, `--output-format stream-json`. Lives at `~/.local/bin/claude.exe` (Windows) or `/usr/local/bin/claude` (Unix). User installs separately.
- **`codex.exe`** (OpenAI). Persistent session via `codex exec resume <id>`. Uses `-` stdin sentinel for prompt transport (avoids Windows cmd.exe 8KB argv cap).
- **`gemini.exe`** (Google). Stub today; F.2.5 future slice will properly adapter-ify it.

All three are invoked via `child_process.spawn` with the user's installation path. **None are bundled with Symphony.** If the user doesn't have the CLI installed, agents can't run; the UI should detect this and guide them through install.

`src/foundry/providers/resolveCli.js` walks PATH for `.cmd` / `.exe` / `.bat` on Windows because Node's spawn doesn't honor PATHEXT. Without that helper, npm-installed CLI wrappers (which ship as `.cmd` files) wouldn't be found. Bug history: Windows spawn ENOENT, ENAMETOOLONG, EINVAL (CVE-2024-27980) — see `7f0755e` drift hardening commit for the hardened pattern.

## 10. UI persona model

Two personas, one codebase. Selected via `tweaks.developerMode` boolean, surfaced as the FOR me / WITH me pill in the Titlebar.

- **FOR me** (default). Calm observation. Cockpit shows agent cards (left) + plain-English timeline (center) + Inspector (right). No file tree, no editor, no terminal. Foundry chat is the primary input surface. Costs render as estimates. Audit log hidden.
- **WITH me** (opt-in). Code-first power mode. Cockpit switches to file tree + Monaco editor + bottom panel (terminal / problems / output / validations) + optional Agent Inbox right panel. Foundry adds inline doc editing. Costs shows per-call breakdown. Audit becomes a full event log table.

Both personas share the same backend; the toggle only changes default surfaces. No persona-only MCP methods, no persona-locked routes. A WITH-me user can still use Foundry; a FOR-me user can still trigger drift runs.

## 11. What this project deliberately is not

- **Not a chatbot wrapper.** Foundry is the only chat-shaped surface; the rest is event-driven observation of autonomous work.
- **Not a Cursor replacement** for professional developers (although it can be used that way in WITH-me mode).
- **Not a cloud service** (yet). All data lives in `.toad/toad.db` in the workspace. Symphony Cloud is a future workstream (`docs/FUTURE-IDEAS.md`).
- **Not a model provider.** Symphony picks the user's existing CLI subscriptions; it doesn't host models or sell tokens.
- **Not VS Code.** The View menu surfaces Symphony's screens, not VS-Code-style panel toggles. The sidebar groups by intent (Build / Watch / Inspect), not by data type.

## 12. Glossary

- **Workspace** — the user's chosen project directory. Where agents operate.
- **Sidecar** — the Node process at `scripts/dev-api-server.mjs`. Hosts the MCP server, runtime supervisor, and HTTP+SSE bridge to the UI.
- **Foundry** — the planning chat phase. Produces 7 markdown docs. Sessions live in `~/.symphony/foundry.db`, distinct from per-workspace data.
- **Materialize** — the step that converts a Foundry plan into a real team + tasks + workspace files.
- **Cockpit** — the operator's primary surface for watching the team. Two personas (FOR me / WITH me).
- **Agent Inbox** — the right-side panel for talking to a specific agent. Three modes: Ask (no work taken), Delegate (work taken), Interrupt (urgent pre-empt).
- **Drift** — the process-violation monitor. Periodic + event-triggered. Slice 2 added an LLM judge for semantic drift.
- **Runtime** — a single CLI subprocess. One per agent per team. Identified by `runtime-<teamId>-<agentId>`.
- **Adapter** — the JS class that wraps a CLI subprocess and translates between Symphony's protocol and the CLI's stream-json. One per provider.
- **MCP** — Model Context Protocol. The transport agents use to call Symphony's tools (task_create, message_send, validation_run, etc.).
- **Skill / Hookify / Subagent** — terms from the broader Claude Code ecosystem; Symphony does not depend on or implement these directly.

## 13. Document maintenance

This file is meta to the codebase. Update it when:
- An architectural rule changes (§4-§7 invariants).
- A new persona, screen, or major surface lands.
- A pre-rollout blocker (like the naming question) resolves.
- A new provider lands or an existing one retires.

Do **not** update it for:
- Bug fixes that don't change invariants.
- UI polish.
- Per-task plan documents (those live in `docs/plans/`).
- Per-slice specs (those live in `docs/specs/`).

When in doubt, ask: "does a future contributor need this rule to avoid breaking the product?" If yes, it goes here. If no, it goes in a sibling doc.
