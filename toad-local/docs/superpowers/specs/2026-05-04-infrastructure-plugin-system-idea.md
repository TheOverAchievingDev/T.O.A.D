# Infrastructure Plugin System — Future Idea

**Status:** captured 2026-05-04 + reframed 2026-05-04 from product brainstorm. Not yet implemented; design refined to the point where a real spec round can start whenever we pick this up.

## The Idea

When Symphony AI builds an app, that app often needs external infrastructure — a Postgres database, a build pipeline, a hosting target, a mobile-build service. Today, an agent has no first-class way to authenticate with those services or operate them. The user has to swap between dashboards, copy URLs into config files, run build commands by hand. That defeats the "AI does the boring parts" pitch.

The pitch: **plugins** — one per provider — that the operator authenticates once at the CLI level, and the team's agents can then use as tools. Each provider already ships a competent CLI; Symphony just wraps it in the same role-gated, risk-classified, audit-trailed tool surface agents already use. **Instead of the operator running `eas build --platform android` and watching the output, the agent runs it and the operator watches.**

## Why this is the right design (architecturally)

CLI-first is exactly the boundary Symphony is already built around:

- The orchestrator already spawns CLIs (`claude`, `codex`, `gemini`, `git`, `npm`)
- Provider plan-auth already authenticates CLIs and reads their auth files (`~/.claude/.credentials.json`, etc)
- Risk classifier already gates Bash commands by pattern — destructive infra commands auto-elevate to high risk + §14 human-approval gate
- MCP tool surface already routes role-gated tools to agents

Adding `railway`, `vercel`, `eas`, `supabase` as plugins is **the same pattern extended outward**, not a new architecture. We don't carry the burden of:

- A custom SDK per provider
- Tracking provider API deprecations
- Managing auth tokens / rate limits / quotas
- Keeping up with provider feature releases

The provider's own CLI handles all of that.

## Concrete examples

| Plugin | Purpose | What the agent gets |
|---|---|---|
| **railway** | Postgres / managed DBs | `provision_db`, `get_connection_string`, `run_migration` |
| **vercel** | Web hosting / preview deploys | `deploy_preview`, `promote_to_prod`, `get_deploy_url`, `read_deploy_logs` |
| **render** | Same space as Vercel — alt host | `deploy_service`, `read_logs`, `set_env_var` |
| **eas** (Expo Application Services) | iOS/Android builds | `build_ios`, `build_android`, `submit_to_store`, `read_build_log` |
| **netlify** | Web hosting / forms / functions | similar to Vercel |
| **aws-amplify** | Mobile + web fullstack | similar to EAS+Vercel combined |
| **supabase** | Postgres + auth + storage | `provision_project`, `apply_schema`, `get_keys` |
| **fly.io / cloudflare** | Edge compute | TBD |

## How it might work

- Each plugin registers a provider config in `~/.toad/plugins/<name>/`
- Auth follows each provider's CLI convention — `railway login`, `vercel login`, `eas login`, etc — Symphony AI shells out and observes auth file presence (same pattern as our existing provider-plan-auth helpers)
- Each plugin exposes a set of MCP tools the agents can call
- Tools are role-gated like existing tools (only certain roles can `provision_db`)
- Risk-classified: provisioning real infra is a **high** risk action that triggers the §14 human-approval gate by default
- Plugin tools land in `task.allowedTools` so the operator can scope which tasks are allowed to touch infra

## Why it matters

Without this, an agent that needs a database has to ask the human in chat, the human goes off and provisions something, copies the URL into a config file, comes back. That's a multi-step human-in-the-loop interruption every time. With plugins, the agent says "I need a Postgres DB" and the orchestrator handles auth + provisioning under the existing risk-policy gate.

It's also the natural evolution of the **provider-plan-auth** pattern Symphony AI already has for Anthropic / OpenAI / Gemini — same shape (CLI-mediated, file-based status detection, opt-in auth flow), but applied to *infrastructure* providers instead of *LLM* providers.

## Ordering

Pursue **after** drift slice 2 + 3 ship. The drift engine is the higher-priority feature for the project's current stage; infrastructure plugins are downstream of having a healthy team that's actually building things.

## Real gotchas to design through (genuinely new infrastructure)

### 1. Long-running async jobs

EAS builds take 10-30 min. Vercel deploys take 2-5 min. Railway provisioning is fast but DB migration runs are bounded by the migration size. Agents can't synchronously block on those.

We need a **background-job pattern**:
- Agent calls `eas_build_android(...)`, returns `{jobId, status: 'queued'}`
- Orchestrator stores the job in a new `plugin_jobs` table (state, started_at, updated_at, log_tail)
- Background poller streams CLI stdout/stderr into the log_tail
- Agent polls `plugin_job_status({jobId})` or subscribes to `plugin_job_*` runtime events
- UI surfaces job state on the relevant task card with live progress

This is the only meaningfully new piece of infrastructure plugins introduce.

### 2. Secret handling

Railway DB URLs contain passwords. Vercel deployments inject env vars. Agents shouldn't see those in plaintext where avoidable.

The orchestrator should mediate: agent says `plugin_get_secret({key: 'railway.prod.DATABASE_URL'})`, orchestrator returns either:
- (a) the literal value, if the agent's role + risk profile allow direct access (simpler, less safe), OR
- (b) an opaque reference like `{$secret: 'railway.prod.DATABASE_URL'}` that the agent writes into config files; the orchestrator post-processes config writes to substitute the real value at file-write time (safer, more code)

Slice 1 of plugins ships (a) with a clear "secrets surfaced to agents in plaintext, do not screenshot" warning; slice 2 adds (b) when the secret-substitution pipeline is built.

### 3. Cost tracking

Railway charges per resource-hour. Vercel charges per build minute. EAS charges per build credit. Symphony tracks LLM cost today via `turn_completed.total_cost_usd`; plugin costs should join the same accounting.

New `plugin_cost_event` runtime event with `{plugin, action, cost_usd, currency, ts}`. Cost dashboard already aggregates by event-log scan; extending it for plugins is mechanical.

### 4. Cleanup on team death

If a team is deleted, we should OFFER (not auto-execute) to deprovision any resources it created.

Workflow: `team_delete` checks `plugin_resources` table for any resources owned by this team, surfaces a confirmation modal listing them, requires the operator to type the team name (same pattern as `git branch -D`), then either runs the deprovisioning CLIs or just unlinks the resources from Symphony's tracking (operator handles cleanup themselves later).

### 5. Discoverability

How does an agent know Railway is available?

Two paths:
- (a) Operator pre-installs the plugin (sets up the CLI on PATH, runs `railway login`) and Symphony detects it
- (b) Agent calls `plugin_list_available` and sees Railway is recognized but unauthed; surfaces a `requires_human_approval: enable_railway` to the operator with a clear "your team wants to use Railway — sign in?" prompt

(b) is a much better UX. The discovery surface is itself a §14 risk-gated approval, so no plugin can secretly enable itself.

## Slice plan when we pick this up

Roughly 4 incremental slices, each shippable on its own:

| Slice | Scope | Headline demo |
|---|---|---|
| **0. Plugin infrastructure** | New `src/plugins/` module mirroring `src/providers/` shape. Plugin registry, auth-detection helper, background-job table, `plugin_*` MCP tool stubs. ZERO actual plugins. | "infrastructure exists, no plugins yet" |
| **1. Railway plugin** | Auth detection, `railway_provision_db`, `railway_get_connection_string`, `railway_run_migration`. Synchronous secret handling (gotcha #2 path a). | Agent provisions a Postgres for the team, surfaces the connection string in the task. |
| **2. EAS plugin** | First plugin to exercise the long-running-job infrastructure (gotcha #1). `eas_build_ios`, `eas_build_android`, `eas_submit_to_store`. | Agent kicks an Android build, operator watches the EAS log stream live in the UI. |
| **3. Vercel plugin** | Preview-deploy + promote-to-prod. Pairs nicely with the GitHub integration we already have. | Agent opens a PR + Vercel preview URL in the task card. |

Beyond slice 3: Render, Netlify, Supabase, Cloudflare, Fly.io. Each is a few hundred lines once the plugin spine exists.

## Original open questions (kept for traceability)

- Plugin packaging: same repo as Symphony AI, or operator-installable from npm?
- Tool registration: static (per-plugin manifest) or dynamic (plugin says "here are my tools")?
- Idempotency: what's the granularity of "I already provisioned a DB for this task"?
- Multi-environment: dev / staging / prod separation per plugin?

## Relationship to other vision docs

- `2026-05-04-symphony-ide-north-star.md` is the IDE/cockpit pivot. Plugins are complementary, not competing — plugins give *agents* more leverage; the cockpit gives *humans* more control. Both make Symphony stronger.
- `2026-05-04-drift-followups-tracker.md` Section F already lists this as the canonical "infrastructure plugin system" entry, pointing at this doc.

## Suggested ordering

Plugin slice 0 + slice 1 (Railway) is small enough to ship as the next concrete feature work — the smallest PR in the trio of "drift slice 3 / plugins / IDE Phase 2," and the highest-leverage demo. Drift slice 3 can ship in parallel; the IDE Phase 2 is bigger and benefits from MORE existing surface area to wrap around.
