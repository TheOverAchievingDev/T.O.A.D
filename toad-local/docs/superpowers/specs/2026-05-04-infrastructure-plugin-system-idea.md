# Infrastructure Plugin System — Future Idea

**Status:** captured 2026-05-04, not yet brainstormed or designed.

## The Idea

When Symphony AI builds an app, that app often needs external infrastructure — a Postgres database, a build pipeline, a hosting target, a mobile-build service. Today, an agent has no first-class way to authenticate with those services or operate them.

The pitch: **plugins** — one per provider — that the operator authenticates once at the CLI level, and the team's agents can then use as tools.

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

## Open questions to brainstorm when we pick this up

- Plugin packaging: same repo as Symphony AI, or operator-installable from npm?
- Tool registration: static (per-plugin manifest) or dynamic (plugin says "here are my tools")?
- Idempotency: what's the granularity of "I already provisioned a DB for this task"?
- Cleanup: when a project is deleted, do we offer to deprovision its infra?
- Cost dashboard: roll plugin costs into the existing cost-cap system?
- Multi-environment: dev / staging / prod separation per plugin?
