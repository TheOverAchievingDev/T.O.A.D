# Symphony AI — Project specification

> **This is the non-negotiable contract.** Every contributor (human or agent) reads this at the start of every session. The rules below trump anything else — plan docs, code comments, sibling specs. When a code change appears to violate one of these rules, stop and either redesign the change or escalate to update this document. Do not silently relax an invariant.

> **🚨 Pre-rollout blocker — naming.** "Symphony" is taken in the AI/dev-tools space. Real name TBD before any public ship. See `docs/FUTURE-IDEAS.md`. References to "Symphony" / "Symphony AI" in this doc are placeholders.

---

## 1. What we are building

A **vibe-coding IDE**. Symphony AI is a desktop app (Tauri + Node sidecar + SQLite + React) that gives vibe coders **a software team** — a lead, a developer, a reviewer, and a tester — so they can take an idea and ship real, deployed software the way a real dev team would.

The premise: no real project gets built start-to-finish by one person in any reasonable amount of time. Software takes a team. Vibe coders today have themselves, one chat window, and a Claude Pro / ChatGPT subscription — they ship demos that look real and then hit the "this isn't actually production-quality software" wall. Symphony exists to close that wall by giving them the team they were missing.

The product has two halves that **must remain physically separated**:

| | Symphony app | The user's workspace |
|---|---|---|
| **Lives in** | `toad-local/` (this repo) | Any folder the user picks |
| **Contains** | Orchestrator code, system prompts, MCP servers, the Cockpit UI, the drift monitor, the planning Foundry, the plugin layer | The user's actual project — their meal planner, their note-taking app, their game |
| **Touched by agents** | **NEVER** | Always — this is where the team works |

Conflating these two is the most critical architectural failure mode. See §4.

## 2. Who it's for

**Vibe coders** — full stop. The population, not a subset.

A vibe coder is someone who:
- Already pays for a Claude Pro / ChatGPT Plus / Gemini Pro subscription
- Is comfortable running a CLI and pasting in prompts
- **Does not actually code.** They prompt; they read AI explanations; they trust the agent to make technical decisions they cannot evaluate
- Has ideas they want to build but no team and no path from idea-to-real-app

Vibe coders fall into two flavors. Both are addressed by the same product, with the FOR me / WITH me persona toggle controlling the surface density:

| | **Novice vibe coder** (FOR me) | **Tech-savvy vibe coder** (WITH me) |
|---|---|---|
| Code understanding | Zero. Cannot read a stack trace. | A little — enough to recognize when an agent is going off the rails, not enough to write the fix |
| What they want from Symphony | The team does everything. Plain-English narration of what's happening. | Same team, but with the file tree, the editor, the test output visible so they can peek under the hood |
| Cockpit landing | Three-column observation: agent cards + plain-English event timeline + Inspector | Cursor-style: file tree + Monaco editor + bottom panel (terminal/problems/output/validations) + optional Agent Inbox |
| The bouncer test | "Do I bounce off this app within 30 seconds because there's too much code on screen?" If yes, FOR me. | "Do I bounce because there's NOT enough code on screen?" If yes, WITH me. |

**Neither persona is a professional developer.** A professional developer would use Cursor + Copilot directly and skip Symphony entirely. The product specifically does NOT target that segment.

UI decisions favor the right level of detail for the persona — calm and narrated for FOR me, dense and code-forward for WITH me — without ever assuming the user can write code themselves. Both personas need the team to do the actual building.

## 3. The economic promise

**Your subscription, not your API.**

Every agent invocation goes through the user's locally-installed CLI (`claude.exe`, `codex.exe`, `gemini.exe`). The CLI uses the user's existing subscription. Symphony **never** holds API tokens, never bills the user, and never proxies LLM calls.

This is the architectural reason every agent is spawned as a child process via `child_process.spawn`, not invoked via the Anthropic SDK. Switching to the SDK would break the subscription promise — Anthropic SDK requires an API key, which means token billing, which prices vibe coders out of the product they signed up for.

When a Symphony developer is tempted to "just use the SDK for this one thing" — stop. There's always a way to do it via CLI. See `src/foundry/providers/*FoundryAdapter.js` for the pattern: each adapter wraps a persistent CLI subprocess with stream-json IO.

## 4. The agent isolation contract — INVARIANT

**Agents NEVER access files outside their assigned workspace.**

The workspace is whatever directory the user picked when creating the project. The Symphony app's own code (this repo, `toad-local/`) is not the workspace. The user's home directory is not the workspace. The OS root is not the workspace.

### Constraints on the fix

This rule must be enforced **without breaking autonomy**. Vibe coders are not going to approve every tool call — that's the entire reason they're using Symphony instead of Claude Code directly. So the fix cannot remove `--dangerously-skip-permissions` or otherwise reintroduce interactive permission prompts. The user-experience cost of "click yes to every Edit" is fatal to the product.

This rule must also be enforced **without disabling the CLI's native tools**. Native Read / Edit / Write / Bash / Grep / Glob are the entire productivity story — without them agents can't `npm install`, run tests, or grep the code. We don't disable them; we constrain them.

### The enforcement mechanism: three layered defenses

The isolation contract is enforced at three separate points in the spawn flow. Each defense covers a different failure mode; any one of them holding prevents the leak.

#### Defense 1 — Hard refusal at team_launch (PRIMARY)

Before any agent in a team spawns, `#teamLaunch` in `localToolFacade.js` calls `assertWorkspaceIsolated({ projectCwd, installDir })` (in `src/runtime/claudeSettingsWriter.js`). The assertion throws — refusing the launch — when any of these hold:

- `projectCwd` is missing/empty (no workspace picked yet).
- `installDir` is missing/empty (the sidecar couldn't resolve Symphony's own location).
- Either path is not absolute.
- `projectCwd === installDir` (the exact bug the user hit: sidecar booted with `projectCwd = toad-local`).
- `projectCwd` is inside `installDir`.
- `installDir` is inside `projectCwd`.

Comparison is case-insensitive on Windows and case-sensitive on POSIX, with backslash → slash normalization. Sibling paths sharing a prefix (`/opt/symphony-data` vs `/opt/symphony`) do NOT trip the check.

This is the primary guarantee: **if the workspace and install dir can see each other, agents do not spawn — full stop.**

#### Defense 2 — Mandatory explicit cwd at launchAgent

`LocalToadRuntime.launchAgent` refuses to spawn when `input.cwd` is missing/empty, because Node's `child_process.spawn` with `cwd: undefined` inherits the parent's `process.cwd()`. The sidecar's `process.cwd()` on a dev checkout IS `toad-local/` — exactly Symphony's install dir. Without an explicit cwd, every agent would inherit it.

This catches a different failure than Defense 1: even with a validated workspace, a stale team config with no `member.cwd` (and a `teamCwd` that normalized to `.`) used to spawn the agent with no cwd at all. Refuse.

The check is conditional on both `projectCwd` and `installDir` being configured — unit tests with neither set keep working without threading paths through.

#### Defense 3 — Env scrubbing

Every spawn passes through `buildScrubbedAgentEnv` (in `claudeSettingsWriter.js`). The sidecar's `process.env` is a billboard for Symphony's location:

- `TOAD_PROJECT_CWD`, `TOAD_INSTALL_DIR`, `TOAD_DB_PATH`, `TOAD_API_PORT`
- `SYMPHONY_FOUNDRY_DB_PATH`
- `PWD`, `INIT_CWD` (point to wherever npm/the shell launched the sidecar from)
- `npm_package_name`, `npm_config_local_prefix`, `npm_lifecycle_script`, ... (npm injects ~20 vars exposing the package layout)

The scrubber builds a fresh env containing only an allow-listed set: `PATH`, `HOME`, locale, terminal info, OS paths (Windows: `APPDATA`/`LOCALAPPDATA`/`USERPROFILE`/etc; POSIX: `XDG_*`/`DISPLAY`/`SSH_AUTH_SOCK`/etc), and provider auth tokens (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`) the CLI needs to authenticate. Anything else is dropped. The caller's `input.env` overrides the allow-list (explicit-intent escape hatch).

#### Defense 4 — permissions.deny rules (DEFENSE IN DEPTH)

Symphony writes a workspace-scoped `.claude/settings.local.json` at team_launch time. The file contains `permissions.deny` patterns naming `installDir/**` + OS system paths + caller-supplied extras, expanded over every path-aware tool (`Read`, `Edit`, `Write`, `NotebookEdit`, `Grep`, `Glob`, `Bash`). If Claude Code's permission engine honors deny patterns under `--dangerously-skip-permissions`, this is a redundant catch-net for anything that gets past Defenses 1-3. If it doesn't honor them, Defenses 1-3 still hold.

Symphony's `src/runtime/claudeSettingsWriter.js` is the surface for all of the above.

### Empirical work required for Defense 4

The interaction between `--dangerously-skip-permissions` and `permissions.deny` rules needs verification before relying on it. Three possible outcomes:

1. **Best case**: deny rules fire even under skip-permissions. Defense 4 is fully effective.
2. **Middle case**: skip-permissions overrides deny. We switch to a different permission mode (`acceptEdits` instead of `bypassPermissions`) that respects deny rules without prompting on allowed actions.
3. **Worst case**: no permission mode gives us "no prompts + enforced deny rules." Defense 4 is decorative; Defenses 1-3 carry the contract alone. OS-level sandboxing (AppContainer, chroot, Linux namespaces) is the heavier fallback if a path through Defenses 1-3 emerges.

Defenses 1-3 do NOT depend on the outcome of this investigation. They run regardless.

### Install location guidance

`projectCwd === installDir` is the failure mode that triggered this contract being written. To minimize the chance of operator confusion:

- **Dev checkouts** should NOT live in a path that looks like a workspace. Avoid `C:\Projects\symphony\`, `~/dev/symphony/`, etc. — those are paths users typically pick for their workspaces. Prefer `C:\Symphony\` or `~/.local/share/symphony/` (clearly not user content).
- **Packaged builds** install to standard application directories: `%LOCALAPPDATA%\Symphony\` on Windows, `/Applications/Symphony.app/` on macOS, `/opt/symphony/` or `~/.local/share/symphony/` on Linux. These are never workspace candidates.
- **The bat launchers** (`start-desktop.bat`, `restart-desktop.bat`) must NOT spawn the Node API server directly. The Tauri shell spawns it with the correct `TOAD_PROJECT_CWD` env var derived from the user's saved active-project. Bat-spawned API servers race Tauri's spawn for port 3001 and often win — with the wrong `projectCwd`. This was the trigger for the user's bug report; the bat scripts now only launch Tauri.

### What's enforced vs what's social

Symphony's own MCP file tools (`ide_read_file`, `ide_write_file`, `ide_tree_list` in `src/ide/ideFileTools.js`) are already sandboxed: absolute paths rejected, `..` traversal blocked, realpathSync used. That's good but insufficient — those tools are optional from the agent's perspective. The CLI's built-in tools are the dominant path and must be the enforcement point.

Bottom line: **the workspace and install dir are disjoint paths, the agent's cwd is the workspace, the agent's env doesn't leak Symphony's location, and the deny rules backstop the whole thing.**

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

The vibe coder interacts with Symphony through five touchpoints, in roughly this order during a typical session:

1. **Foundry chat** — Capture the idea. A planning AI (Claude / Codex / Gemini per user choice) helps the vibe coder articulate what they want into 7 docs: `product_brief`, `tech_spec`, `roadmap`, `task_breakdown`, plus optional `steering`, `design_decisions`, `definition_of_done`. The vibe coder describes their idea in their own words; Foundry asks the architect-y questions they don't know to ask (do you need a database? auth? deployed where?) and writes everything down.
2. **Materialize** — Turn the Foundry plan into a real team. Creates the team config (`team_create`), seeds starter tasks (`foundry_project_seed_tasks`), copies the Foundry docs into the workspace at `docs/foundry/*.md`. The team's system prompts reference these docs — they're the contract that keeps agents on-track.
3. **Cockpit** — Watch the team build. The signature surface. FOR me shows the agent cards + timeline. WITH me adds the editor + file tree.
4. **Agent Inbox** — Talk to a specific agent. Pick lead / dev / reviewer / tester from the dropdown, Ask / Delegate / Interrupt. This is the primary intervention mechanism for both personas.
5. **Approvals + Drift** — Quality gates. Approvals block destructive changes pending human OK. Drift surfaces process violations (task closed without merge evidence, role permission violations, etc.). Plugins (Railway / Vercel / EAS) deploy the result.

What vibe coders **do not** do in the typical flow:
- Write code themselves. (Even WITH me users CAN, but typically don't — they observe.)
- Manually trigger agent prompts via raw CLI calls.
- Edit the Foundry-generated docs after materialize (the agents own them now; re-Foundry if you need to redraft).

## 7. Process lifecycle invariants

The supervisor + runtime registry coordinate the lifecycle of every agent process. The rules:

1. **Every running agent has a registry row.** No "ghost" processes that aren't tracked. The reconcile-on-boot path (`sqliteRuntimeRegistry.reconcileOrphans`) marks any stale rows stopped and reports orphaned PIDs the supervisor can taskkill.
2. **`agent_stop` is idempotent.** Calling it on an already-stopped runtime is a no-op. The Stop-all-agents button relies on this.
3. **Resume preserves history.** `team_launch` against an existing team relaunches the agents with the same `runtime-<teamId>-<agentId>` ids; messages, tasks, events from the prior session remain intact.
4. **End deletes the team but not the data.** `team_delete` removes the team config; tasks, messages, drift findings, foundry artifacts all stay in SQLite. The team can be re-created (different config) later in the same workspace.
5. **Stale `running` rows must be cleared before re-spawn.** If a sidecar restart leaves a registry row marked `running` with no live adapter, `team_launch` marks it `stopped` before spawning the replacement. Otherwise the §13 stuck-runtime monitor false-flags. (Bug 4 fix, commit `51e65e6`.)
6. **Multi-team scenarios are real.** A user can have multiple teams running simultaneously (especially after a "start new project" that doesn't end the prior team). The Stop-all-agents button sweeps every live runtime regardless of which team owns it.

## 8. Quality gates

Three orthogonal mechanisms keep the team honest. Two terms that were
historically conflated and are now **deliberately separated** (naming
matters — improvements to one looked like regressions in the other):

- **Conformance / process invariants** (`src/drift/checks/check*.js`,
  the 7 deterministic checks). "Did the *agents* follow the right
  *process*?" — lifecycle transitions valid, review had findings,
  done has merge evidence, role permissions respected, test artifacts
  present, scope contract honored. These are behavioral audits of
  agent conduct. They keep their own findings stream + UI pip.
- **Drift** (the L1/L2/L3 layered system, under construction). "Does
  the *artifact* match the *spec*?" — code-vs-spec alignment. This is
  a different product from conformance and gets its own surface.
- **Validations** (`validation_run`). Per-task lint/typecheck/test/
  build. Agents fire them; results land on the task; the merge gate
  checks them. (This is where *type* correctness lives — drift
  deliberately does not re-implement a type system.)
- **Risk policy + approvals**. `requiresHumanApproval: true` blocks at
  the human gate; `src/policy/riskClassifier.js` auto-tags sensitive
  paths.

None of these are the agent isolation contract (§4). They are behavior
gates, not security boundaries.

### 8a. The layered drift model

Drift detection is three layers of increasing cost, each filtering
work for the next. Design + rationale: `docs/superpowers/specs/
2026-05-15-spec-yaml-schema.md`.

- **Layer 1 — deterministic checks** (raw parse/AST/grep, milliseconds,
  no LLM). Reads `docs/foundry/spec.json` — the machine-checkable
  projection of the seven prose foundry docs. Four staged checks:
  dependency drift → structural drift → constitution-grep → contract
  drift. Highest signal, lowest cost; most real drift lives here.
- **Layer 2 — embedding similarity** (cheap math, no LLM inference).
  Mid-level semantic drift with no clean rule. Deferred until L1/L3
  are stable.
- **Layer 3 — LLM judgment, sparingly**. Fires only at task
  boundaries AND only when L1/L2 surfaced ambiguity. Sees a *scoped*
  payload (relevant spec section + the specific diff + the L1/L2
  flag), never the whole brief. Haiku for the common case; escalate
  to Sonnet only when Haiku itself flags ambiguity.

`spec.json` is the contract every L1 check reads. Foundry emits it on
materialize; `foundry_extract_spec` bootstraps existing prose-only
projects. It is a *projection* of the prose docs, not a replacement —
the prose stays for humans and the L3 judge.

### 8b. The broker is the drift vantage point — ARCHITECTURAL ADVANTAGE

This is a first-class structural property of Symphony, not an
implementation detail. **Every meaningful inter-agent action —
`message_send`, `task_update`, `validation_run`, `review_request` —
flows through the SQLite broker (`src/broker/sqliteBroker.js`), code
Symphony fully controls.** Most multi-agent systems have agents talk
to each other through opaque channels (direct API calls, shared
memory, framework message buses) and can only audit *after* the fact
by reading artifacts. Symphony can observe every inter-agent action
continuously — and at the right boundary, block a merge that
introduces a spec violation.

Concrete consequence: when the lead tells a worker "implement OAuth,"
the broker sees that message — every meaningful inter-agent action
flows through it. Today drift runs at the periodic + task-event
cadence and surfaces findings; the broker observer seam (Slice 2,
deferred) will additionally enable post-`appendMessage` observation.
ENFORCEMENT, already shipped, happens at the merge boundary: the
`merge_ready → done` constitution gate refuses to land code that
introduces a `mode:'gate'` constitution-rule violation. The work was
visible the whole time; the gate closes the exit.

Three enforcement tiers, declared per-rule:

- **info**: unreviewed spec or low confidence (ruling #4 clamp). Logged
  for human review; never sent to the lead.
- **observer**: real drift, reviewed spec. Surfaced as drift findings
  in the drift stream/UI; the broker observer seam (Slice 2, deferred)
  will additionally route these to the lead in-session. Does **not**
  block delivery or merge.
- **gate**: `mode:'gate'` constitution rule, reviewed spec, **and** the
  violation is introduced by this merge (diff-scoped vs trunk).
  Blocks `merge_ready → done` until resolved.

Gate properties worth keeping in mind:

- **Diff-scoped.** Only violations *this* merge introduces are
  gate-eligible. Pre-existing trunk violations are observer-mode and
  never block.
- **Two-key.** A merge is blocked only if the rule has `mode:'gate'`
  **and** `spec.provenance.reviewed === true`. An unreviewed spec
  clamps to info and never blocks.
- **Fail-open.** A scan or git error never wedges a merge — it emits
  a loud high-severity observer finding and the merge proceeds.

The broker observer seam (`subscribe()` on `SqliteBroker`) is a
separate, later slice that ships the seam substrate for observe-mode
message-level drift findings. It is not yet wired to a consumer and
does not gate anything — that remains the merge gate's job. The
doctrine stands regardless: **do not route agent communication around
the broker. The broker's universality is the drift system's power.**

### 8c. Shared-helper-over-reimplementation — INVARIANT

When a check (or any drift layer) needs to ask the same logical
question another check already answers, the answer is a **single
shared helper**, never a parallel reimplementation. Established
instances: `evalConstitutionRule` (merge-gate), `judgeSpawn` (L3
reform), `isFileDeclaredByModule` (L3 Slice B — "is this file part of
this declared module?", consumed by both L1.2b and L3's
`touchesDeclaredSurface`). Every such extraction ships with a
**lockstep-agreement test** that fails if a future edit re-inlines or
diverges either consumer. Cost of the invariant: one extraction
commit per case. Cost of violating it: silent layer-divergence bugs
that are near-undiagnosable. Reviewers must reject a second
implementation of an existing cross-layer decision.

### 8d. Grounding-first & settings-namespace — INVARIANTS

**Ground brainstorm rounds against current code before answering**
whenever the topic touches an existing surface. Captured design prose
(appendices, deferred notes) is the *plan*, not *current state*;
reality moves. Repeatedly material (Slice-B contracts/evidence
reality; Sub-project-B's Claude-only-runtime reality + the
existing-meter wrongness). Every Appendix-A sub-project (and similar)
opens with a grounding pass against the code, not the doc.

**Settings namespace is governed by what the setting controls, not by
chronological proximity to prior settings.** `settings.drift.*` =
drift-monitor behavior; `settings.runtime.*` = runtime-supervisor
behavior (context staleness; the future C/D/E compaction / rotation /
routing knobs). Co-location of work in one sub-project never justifies
cross-namespacing a setting. (Origin: a reviewer-pinned
`settings.drift.contextStaleness` was caught in spec review as a
category error and corrected to `settings.runtime.contextStaleness`.)

## 9. Provider architecture

Symphony supports three CLI providers, each with its own adapter:

- **`claude.exe`** (Anthropic). Primary provider. Uses `--mcp-config`, `--input-format stream-json`, `--output-format stream-json`. Lives at `~/.local/bin/claude.exe` (Windows) or `/usr/local/bin/claude` (Unix). User installs separately.
- **`codex.exe`** (OpenAI). Persistent session via `codex exec resume <id>`. Uses `-` stdin sentinel for prompt transport (avoids Windows cmd.exe 8KB argv cap).
- **`gemini.exe`** (Google). Stub today; F.2.5 future slice will properly adapter-ify it.

All three are invoked via `child_process.spawn` with the user's installation path. **None are bundled with Symphony.** If the user doesn't have the CLI installed, agents can't run; the UI should detect this and guide them through install.

`src/foundry/providers/resolveCli.js` walks PATH for `.cmd` / `.exe` / `.bat` on Windows because Node's spawn doesn't honor PATHEXT. Without that helper, npm-installed CLI wrappers (which ship as `.cmd` files) wouldn't be found. Bug history: Windows spawn ENOENT, ENAMETOOLONG, EINVAL (CVE-2024-27980) — see `7f0755e` drift hardening commit for the hardened pattern.

## 10. The plugin layer — idea-to-app bridge

Vibe coders ship apps, not localhost demos. Real apps need real third-party services: a Postgres database somewhere, a deploy target, push notifications for mobile, OAuth providers, etc. Vibe coders know they need these things but don't know how to set them up.

The **plugin layer** is Symphony's bridge from "the agent wrote the code" to "the app is deployed and the user can use it." Each plugin wraps a third-party service and exposes its operations as MCP tools the agents can call. Examples:

- **Railway** — Postgres provisioning, app deploy, connection-string injection into agent env. So when an agent needs a database for the project, it calls `railway_provision_db`, gets a real Postgres instance, gets the connection string written to the project's env file. Vibe coder never typed "I need Postgres" — the dev agent figured it out from the Foundry spec.
- **Vercel** — Web deploys, preview URLs, env-var sync. The reviewer or lead agent calls `vercel_deploy` when a task hits merge_ready and there's a preview URL the human-in-the-loop can click.
- **EAS (Expo)** — Mobile builds + over-the-air updates for React Native projects. Same pattern.
- **GitHub** — Repo creation, PR opening, branch protection. Agents can `github_create_repository` for the project at materialize time.

Plugins live in `src/plugins/` under per-vendor subdirectories. Each plugin owns:
- **Authentication** — store + refresh the vendor's OAuth tokens or API keys. Plugin login UI in Settings → Plugins.
- **Capability registration** — MCP tool definitions exposed to agents. Agents only see plugin tools the user has authenticated with.
- **Cost telemetry** — every plugin call reports to the cost ledger so the Costs screen sees vendor spend, not just LLM spend.

The plugin layer is what makes Symphony a real **vibe-coding IDE** instead of "ChatGPT but with more tabs." Without plugins, agents produce code in a folder. With plugins, agents produce **a real running app** at a real URL the user can give to their household.

## 11. UI persona model

Two flavors of vibe coder, one codebase. Selected via `tweaks.developerMode` boolean, surfaced as the FOR me / WITH me pill in the Titlebar. See §2 for who each persona is.

- **FOR me** (default). Calm observation for the novice vibe coder. Cockpit shows agent cards (left) + plain-English timeline (center) + Inspector (right). No file tree, no editor, no terminal. Foundry chat is the primary input surface. Costs render as estimates ("you've spent about $2.40 today"). Audit log hidden behind a "this is dense — flip to WITH me if you actually need it" cushion.
- **WITH me** (opt-in). Code-first power mode for the tech-savvy vibe coder. Cockpit switches to file tree + Monaco editor + bottom panel (terminal / problems / output / validations) + optional Agent Inbox right panel. Foundry adds inline doc editing. Costs shows per-call breakdown. Audit becomes a full event log table.

Both personas share the same backend; the toggle only changes default surfaces. No persona-only MCP methods, no persona-locked routes. A WITH me user can still use Foundry; a FOR me user can still trigger drift runs.

Neither persona assumes the user writes code. WITH me surfaces the editor because tech-savvy vibe coders want to **see** what's happening — they're peeking, not driving.

## 12. What this project deliberately is not

- **Not a chatbot wrapper.** Foundry is the only chat-shaped surface; the rest is event-driven observation of autonomous work.
- **Not Cursor.** Cursor is for professional developers who write code. Symphony is for vibe coders who direct agents. Different audience, different value proposition.
- **Not a cloud service** (yet). All data lives in `.toad/toad.db` in the workspace. Symphony Cloud is a future workstream (`docs/FUTURE-IDEAS.md`).
- **Not a model provider.** Symphony picks the user's existing CLI subscriptions; it doesn't host models or sell tokens.
- **Not VS Code.** The View menu surfaces Symphony's screens, not VS-Code-style panel toggles. The sidebar groups by intent (Build / Watch / Inspect), not by data type.
- **Not a coding tutor.** We do not explain the code to the user — that's the agents' job (via the timeline narration). Symphony surfaces what the team is doing, not why each line of code works.

## 13. Glossary

- **Vibe coder** — The user. Pays for Claude Pro / ChatGPT Plus / Gemini Pro. Doesn't code professionally. Has ideas, wants real software, needs a team.
- **Vibe coding** — Building software by prompting AI agents and reading their output, without writing the code yourself. The dominant mode of solo software creation among non-developers.
- **Workspace** — The user's chosen project directory. Where agents operate.
- **Sidecar** — The Node process at `scripts/dev-api-server.mjs`. Hosts the MCP server, runtime supervisor, and HTTP+SSE bridge to the UI.
- **Foundry** — The planning chat phase. Produces 7 markdown docs. Sessions live in `~/.symphony/foundry.db`, distinct from per-workspace data.
- **Materialize** — The step that converts a Foundry plan into a real team + tasks + workspace files.
- **Cockpit** — The vibe coder's primary surface for watching the team. Two personas (FOR me / WITH me).
- **Agent Inbox** — The right-side panel for talking to a specific agent. Three modes: Ask (no work taken), Delegate (work taken), Interrupt (urgent pre-empt).
- **Drift** — The process-violation monitor. Periodic + event-triggered. Slice 2 added an LLM judge for semantic drift.
- **Runtime** — A single CLI subprocess. One per agent per team. Identified by `runtime-<teamId>-<agentId>`.
- **Adapter** — The JS class that wraps a CLI subprocess and translates between Symphony's protocol and the CLI's stream-json. One per provider.
- **MCP** — Model Context Protocol. The transport agents use to call Symphony's tools (task_create, message_send, validation_run, etc.).
- **Plugin** — A third-party-service wrapper (Railway, Vercel, EAS, GitHub) that exposes vendor capabilities as MCP tools. The bridge from idea to deployed app.
- **Permission rules** — Claude Code's `.claude/settings.json` allow/deny semantics that scope what tools can touch. Symphony's agent isolation contract (§4) is enforced through these rules.

## 14. Document maintenance

This file is meta to the codebase. Update it when:
- An architectural rule changes (§4-§7 invariants).
- A new persona, screen, or major surface lands.
- A pre-rollout blocker (like the naming question) resolves.
- A new provider lands or an existing one retires.
- A plugin category is added (a new third-party service vertical, not a new plugin in an existing vertical).

Do **not** update it for:
- Bug fixes that don't change invariants.
- UI polish.
- Per-task plan documents (those live in `docs/plans/`).
- Per-slice specs (those live in `docs/specs/`).
- New plugin within an existing vertical (e.g. adding Fly.io alongside Railway is not a PROJECT.md edit).

When in doubt, ask: "does a future contributor need this rule to avoid breaking the product?" If yes, it goes here. If no, it goes in a sibling doc.
