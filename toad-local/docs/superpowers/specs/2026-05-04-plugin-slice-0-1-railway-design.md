# Plugin Slice 0 + 1 (Railway) — Design

**Status:** approved (brainstorming session 2026-05-04)
**Author:** kaydenraquel + Claude
**Predecessor (idea note):** `2026-05-04-infrastructure-plugin-system-idea.md`

---

## 1. Problem

When Symphony AI builds an app, it needs external infrastructure — a Postgres database, a build pipeline, a hosting target. Today an agent has no first-class way to authenticate with those services or operate them. The user has to swap between dashboards, copy URLs into config files, run build commands by hand. That defeats the "AI does the boring parts" pitch.

**Pitch:** plugins — one per provider — wrap each provider's CLI in Symphony's existing role-gated, risk-classified, audit-trailed tool surface. Operator authenticates the CLI once; agents call provisioning/deploy/migration tools through Symphony.

This spec covers **slice 0** (infrastructure with zero plugins) + **slice 1** (Railway plugin, Postgres-only). Together they're shipped as one feature so the demo-grade outcome — *"agent provisioned a Postgres for me"* — lands intact.

## 2. Scope (slice 0 + 1)

**In scope:**
- New `src/plugins/` module: registry, auth helpers, jobs store
- Two new SQLite tables: `plugin_jobs` (background-job tracker, mostly unused in this slice), `plugin_resources` (provisioned-resource tracker — used immediately by Railway)
- New MCP tools (plugin-agnostic): `plugin_list_available`, `plugin_login`, `plugin_logout`, `plugin_resource_list`
- New MCP tools (Railway-specific): `railway_link`, `railway_provision_db`, `railway_get_connection_string`, `railway_run_migration`
- Role-authority grants: `lead`, `architect`, `human` get `plugin_*`. Per-tool gates inside each plugin (e.g., `railway_run_migration` is `lead`/`human` only).
- Risk-classifier auto-elevation rules for Railway tools
- Settings additions: `plugins.<id>.enabled` per-plugin
- New UI tab: `Settings → Plugins` (parallel to `Settings → Providers`)
- Audit-log redaction layer for secrets (loud warning on surface)
- Team-delete warning when plugin resources exist
- README mention so operators know the plugin system is there

**Explicitly deferred to slice 1.5+:**
- Other Railway DB types (Redis, MongoDB, MySQL) — postgres only here
- Multi-environment (dev/staging/prod) separation per plugin
- Cost tracking (`plugin_cost_event` + dashboard integration)
- Background-job streaming UI (table exists; needed first by EAS in slice 2)
- Secret-substitution pipeline (`{$secret: ...}` references; this slice ships plaintext-with-warning per gotcha #2 path a)
- Auto-deprovision on team-delete (this slice ships a warning + manual cleanup; full auto-deprovision is slice 1.5)
- npm-installable / out-of-repo plugins

## 3. Decisions log (from brainstorming)

| # | Decision | Reasoning |
|---|---|---|
| Q1 | Slice 1 ships Postgres-only DB type | Smallest PR; other types are 2-3-line additions in slice 1.5. User approved with caveat "as long as we can add the others later" — registry is designed for trivial extension. |
| Q2 | `railway_provision_db` is idempotent — returns existing with `wasExisting: true` flag | Matches existing `team_create` idempotency pattern; agents can re-call without surprises. |
| Q3 | Plugin discovery via on-demand `plugin_list_available` tool call | Matches every other tool in the codebase. No system-prompt churn. Agents call when they need to. |
| ⚠️ | Tightened secret handling for public release | Slice 1 still ships plaintext (path a from gotcha #2), but adds redaction in `runtime_events` audit log + loud UI warning when an agent receives a secret. |
| ⚠️ | Team-delete warning landed alongside slice 1 | Auto-deprovision deferred to 1.5, but the user should never silently leak a $5/mo Postgres by hitting "End team." |

## 4. Architecture

### 4.1 Module layout

```
src/plugins/                              ← NEW
├── pluginRegistry.js          frozen registry of supported plugins
├── pluginAuth.js              file-based auth detection + manual-login flow
├── pluginJobs.js              SQLite-backed background-job tracker
├── pluginResources.js         SQLite-backed provisioned-resource tracker
└── railway/                   ← first plugin
    ├── railwayCli.js          spawn helpers (PATH/PATHEXT resolution)
    └── railwayTools.js        provision_db / get_connection_string / run_migration / link

src/storage/schema.sql         + plugin_jobs + plugin_resources tables
src/security/roleAuthority.js  + plugin_* and railway_* tool grants
src/policy/riskClassifier.js   + railway-specific command-rules
src/tools/localToolFacade.js   + plugin_* and railway_* command dispatch
src/tools/secretRedactor.js    ← NEW: redacts known secret patterns from audit log

ui/src/components/settings/PluginsSettings.tsx     ← NEW
ui/src/components/settings/SettingsLayout.tsx      modify (add 'plugins' nav entry)
ui/src/components/settings/SettingsScreen.tsx      modify (route 'plugins')
ui/src/components/CreateTeamModal.tsx              modify? (no — plugins not in modal)

scripts/dev-api-server.mjs     wire pluginRegistry + jobs/resources stores into facade

test/plugins/                  ← NEW
├── pluginRegistry.test.js
├── pluginAuth.test.js
├── pluginResources.test.js
└── railway/
    └── railwayTools.test.js
test/secretRedactor.test.js
```

### 4.2 Data flow — agent provisions a Postgres

```
Agent (lead role) calls railway_provision_db({type: 'postgres'})
   │
   ▼
LocalToolFacade
   │ (a) role check via roleAuthority — lead allowed ✓
   │ (b) idempotency: pluginResources.findByTeam({teamId, kind: 'railway/postgres'})
   │     → if exists, return {wasExisting: true, ...resource} immediately
   │ (c) risk classifier checks command — provisioning is medium, no §14 gate
   │
   ▼
railwayTools.provisionDb({teamId})
   │ (d) verify auth: pluginAuth.getAuthStatus({pluginId: 'railway'})
   │     → if !signedIn, throw 'plugin_not_authed: railway'
   │ (e) spawn `railway add --plugin postgresql --json` (or equivalent)
   │ (f) parse JSON output, extract resourceId + service URL
   │
   ▼
pluginResources.insert({
  resourceId, teamId, pluginId: 'railway',
  kind: 'postgres', externalId: <railway service id>,
  createdAt: now, metadata: { service_name, region, ... }
})
   │
   ▼
runtime_events.append({
  eventType: 'tool_call',
  payload: { toolName: 'railway_provision_db', args: {...},
             result: {<REDACTED via secretRedactor>} }
})
   │
   ▼
return {wasExisting: false, resourceId, externalId, ...}
```

The same shape for `railway_get_connection_string` (returns plaintext URL but the audit log row stores `<REDACTED>`) and `railway_run_migration` (high risk → §14 gate fires before SQL execution).

### 4.3 Wiring (dev-api-server)

```js
// new imports
import { PluginRegistry } from '../src/plugins/pluginRegistry.js';
import { SqlitePluginJobs } from '../src/plugins/pluginJobs.js';
import { SqlitePluginResources } from '../src/plugins/pluginResources.js';

// after the existing drift wiring
const pluginRegistry = new PluginRegistry();
const pluginJobs = new SqlitePluginJobs({ db: driftDb });
const pluginResources = new SqlitePluginResources({ db: driftDb });

const facade = new LocalToolFacade({
  // ...existing args...
  pluginRegistry,
  pluginJobs,
  pluginResources,
});
```

`pluginRegistry` is the static list of supported plugins (just `railway` in slice 1). `pluginJobs` + `pluginResources` are SQLite-backed; both injectable for tests.

## 5. Schema

### 5.1 `plugin_jobs` (slice 0 — minimally used in slice 1)

```sql
CREATE TABLE IF NOT EXISTS plugin_jobs (
  job_id          TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL,
  plugin_id       TEXT NOT NULL,            -- 'railway' | 'eas' | 'vercel' | ...
  action          TEXT NOT NULL,            -- e.g. 'eas_build_android'
  state           TEXT NOT NULL,            -- 'queued' | 'running' | 'success' | 'failed' | 'cancelled'
  args_json       TEXT NOT NULL,
  log_tail        TEXT,                     -- last ~64KB of stdout/stderr
  started_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  finished_at     TEXT,
  error           TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_jobs_team ON plugin_jobs(team_id);
CREATE INDEX IF NOT EXISTS idx_plugin_jobs_state ON plugin_jobs(state);
```

### 5.2 `plugin_resources` (slice 0 — actively used in slice 1)

```sql
CREATE TABLE IF NOT EXISTS plugin_resources (
  resource_id     TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL,
  plugin_id       TEXT NOT NULL,            -- 'railway' | 'eas' | ...
  kind            TEXT NOT NULL,            -- 'postgres' | 'redis' | 'vercel-project' | ...
  external_id     TEXT NOT NULL,            -- provider's own ID (Railway service ID, Vercel project ID)
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  deprovisioned_at TEXT,                    -- NULL while live; set when removed (auto- or manual-)
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_resources_team ON plugin_resources(team_id);
CREATE INDEX IF NOT EXISTS idx_plugin_resources_live
  ON plugin_resources(team_id, plugin_id, kind)
  WHERE deprovisioned_at IS NULL;
```

The partial index makes "is there a live Postgres for this team?" a single index lookup — supports the idempotency check in `railway_provision_db`.

### 5.3 Settings additions

`<projectCwd>/.toad/settings.json` gets a new `plugins` section:

```json
{
  "plugins": {
    "railway": { "enabled": true },
    "eas":     { "enabled": false },
    "vercel":  { "enabled": false }
  }
}
```

Default: all plugins disabled. Operator opts in per-plugin via the `Settings → Plugins` tab.

## 6. Plugin registry shape

```js
// src/plugins/pluginRegistry.js
export const SUPPORTED_PLUGINS = Object.freeze(['railway', 'eas', 'vercel']);

export const PLUGIN_COMMANDS = Object.freeze({
  railway: {
    label: 'Railway',
    cli: 'railway',
    statusMode: 'file',
    statusFile: '~/.config/railway/config.json',
    parseFileStatus: parseRailwayFileStatus,  // verifies token field present
    manualLogin: true,
    loginInstructions: 'Run `railway login` in a terminal. Symphony will detect the auth file once you complete the browser flow.',
    logoutArgs: ['logout'],
    supported: true,
    // Per-action risk profiles consumed by riskClassifier integration
    riskProfile: {
      provision_db:           'medium',
      get_connection_string:  'medium',
      run_migration:          'high',  // §14 human-approval gate fires
      link:                   'low',
    },
  },
  eas: { label: 'EAS', cli: 'eas', supported: false, /* slice 2 */ },
  vercel: { label: 'Vercel', cli: 'vercel', supported: false, /* slice 3 */ },
});
```

`parseRailwayFileStatus` reads the file, verifies a token exists, returns `{signedIn, user, plan}` (Railway exposes user info in the same file). Same shape as the existing `parseAnthropicFileStatus` / `parseCodexFileStatus` / `parseGeminiFileStatus`.

## 7. Plugin-agnostic MCP tools

| Tool | Args | Returns | Role |
|---|---|---|---|
| `plugin_list_available` | none | `[{pluginId, label, signedIn, supported, enabled}]` | any |
| `plugin_login` | `{pluginId}` | `{started: false, manualLogin: true, instructions}` (matches existing provider-auth shape) | `lead` `architect` `human` |
| `plugin_logout` | `{pluginId}` | `{loggedOut: true}` | `lead` `architect` `human` |
| `plugin_resource_list` | `{teamId?}` | `[{resourceId, pluginId, kind, externalId, createdAt}]` | any |

## 8. Railway-specific MCP tools

| Tool | Args | Returns | Role | Risk |
|---|---|---|---|---|
| `railway_link` | `{projectId?}` | `{teamId, projectId, linkedAt}` (creates new project if none specified) | `lead` `architect` `human` | low |
| `railway_provision_db` | `{type: 'postgres'}` (slice 1: postgres-only) | `{resourceId, externalId, wasExisting, kind}` | `lead` `architect` `human` | medium |
| `railway_get_connection_string` | `{resourceId, varName?}` (default `DATABASE_URL`) | `{value}` (plaintext, audit-redacted) | `lead` `architect` `developer` `human` | medium |
| `railway_run_migration` | `{resourceId, sql}` | `{rowsAffected, durationMs, output}` | `lead` `human` | **high** (§14 gate) |

`railway_run_migration` is the only Railway tool that fires the §14 human-approval gate. The risk classifier sees the tool name + (optionally) the SQL pattern and elevates accordingly. Operator gets the standard approval modal.

## 9. Secret redaction layer

`src/tools/secretRedactor.js` — pure function consumed by the `runtime_events` write path:

```js
export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text
    // postgres URLs: postgres://user:pass@host:port/db
    .replace(/(postgres(ql)?:\/\/[^:@\s]+):([^@\s]+)@/gi, '$1:<REDACTED>@')
    // generic auth header values
    .replace(/(authorization:\s*)([^\s,;]+)/gi, '$1<REDACTED>')
    // bearer tokens
    .replace(/(bearer\s+)([A-Za-z0-9_-]{20,})/gi, '$1<REDACTED>')
    // mongo, redis, mysql connection strings — same pattern
    .replace(/((?:mongodb|mongodb\+srv|redis|rediss|mysql):\/\/[^:@\s]+):([^@\s]+)@/gi, '$1:<REDACTED>@')
    // env-var-shaped secrets in JSON: {"DATABASE_URL": "..."} → redact
    .replace(/("(?:DATABASE_URL|API_KEY|SECRET_KEY|ACCESS_TOKEN|REFRESH_TOKEN)"\s*:\s*)"[^"]*"/gi, '$1"<REDACTED>"')
    ;
}
```

Pure, deterministic, table-driven. Tests assert against known input → known output. Used by:
- `runtime_events` writer in the audit pipeline
- `tool_call` event payload sanitizer
- The "view raw event" UI surface

The agent receives the unredacted value (per slice-1 path-a). The audit log + UI raw-event view see only `<REDACTED>`.

## 10. UI changes

### 10.1 New `Settings → Plugins` tab

Mirrors `Settings → Providers` shape. Per-plugin card:
- Plugin glyph + label (`Railway`)
- Signed-in / Not signed in pill (green / dim)
- Plan info (slice-1: just the email; slice 1.5+ adds Railway plan tier)
- "Sign in" button (disabled-with-instructions when `manualLogin: true`)
- "Sign out" button (when signed in)
- "Enable for this project" toggle (writes `plugins.<id>.enabled` to project settings)
- (When signed in) **resources card** listing live `plugin_resources` for this team:
  - resource_id, kind, external_id, created_at
  - "Deprovision" button (slice 1: opens an approval modal that just unlinks Symphony's tracking + tells the user to deprovision in Railway's dashboard. Slice 1.5: actually runs `railway remove --service <id>`.)

### 10.2 Loud secret-surface warning

When an agent calls `railway_get_connection_string` and the result is surfaced to a UI panel (e.g., the agent activity stream shows `Tool result: { value: "postgres://..." }`), the orchestrator's UI renderer detects values matching the secret patterns and:
1. Replaces the visible text with `••••••••• [click to reveal]`
2. Shows a small banner: `⚠️ A secret was surfaced to <agentId>. Plaintext exposure is intentional in this slice but will become an opaque reference in slice-2 substitution.`
3. The "click to reveal" reveals the value in a modal with a one-time `Copy` button.

### 10.3 Team-delete warning

In `team_delete` flow (UI side, when operator clicks "End team"):
1. Before showing the confirmation modal, query `plugin_resource_list({teamId})`.
2. If non-empty, the confirmation modal includes:
   - A list of live resources (Railway Postgres, etc) the team owns
   - A note: `These resources will NOT be auto-deprovisioned. They will continue to incur cost until you remove them in their respective dashboards (or via the plugin's Deprovision button before deleting the team).`
   - The standard "type the team name to confirm" gate

The team-delete itself does NOT change the resources table — the resources stay in `plugin_resources` with their `team_id` pointing at the deleted team. Slice 1.5 adds the auto-deprovisioning option.

## 11. Testing strategy

| Piece | Approach | Test file |
|---|---|---|
| `pluginRegistry` constants | Frozen-shape assertions; PROVIDER_MAP has 3 entries; railway has the right risk profile | `test/plugins/pluginRegistry.test.js` |
| `pluginAuth.getAuthStatus({pluginId})` | Inject `readFileImpl`/`statImpl` (existing pattern from `providerAuth.test.js`); test signed-in/not/file-corrupt cases | `test/plugins/pluginAuth.test.js` |
| `SqlitePluginResources` | Insert + `findByTeam` + idempotency check; `live-only` index works correctly | `test/plugins/pluginResources.test.js` |
| `secretRedactor` | Table-driven: postgres URL, mongo URL, bearer token, `DATABASE_URL` JSON, multi-line, no-secret pass-through | `test/secretRedactor.test.js` |
| `railway_provision_db` | Inject fake `spawnImpl` returning canned Railway CLI output; assert idempotency, resource row written, redacted audit | `test/plugins/railway/railwayTools.test.js` |
| `railway_get_connection_string` | Same fake-spawn pattern; assert audit-log row contains `<REDACTED>` | same file |
| `railway_run_migration` | Same; plus assert the high-risk classification fires (mock the risk classifier) | same file |
| `LocalToolFacade` integration | New tests for `plugin_list_available`, `plugin_login`, `plugin_logout`, `plugin_resource_list`, plus the four `railway_*` tools | extend `test/localToolFacade.test.js` |

TDD throughout — every new module ships with a failing test before implementation.

## 12. Risk + non-goals

- **Provisioning costs real money.** Mitigations: (i) §14 gate already fires for `medium`+ risk by default for non-lead roles; (ii) per-team cost cap is a slice-1.5 follow-up; (iii) the team-delete warning catches the common "I forgot I provisioned this" leak.
- **Plaintext secret exposure to agents.** Documented as intentional for slice 1 (path-a from gotcha #2). Audit log redaction is the safety net. Slice 2 ships the substitution pipeline.
- **CLI version skew.** Different `railway` CLI versions accept different flags. Slice 1 hardcodes the names current as of 2026-05-04; if Railway changes, operators get a clear "command failed" error from the CLI and we update the wrapper.
- **Not a SaaS broker.** Symphony does not become a billing layer or a Railway reseller. Operator's Railway account remains theirs; we just shell out to their CLI.
- **Public release in a week** is the explicit framing; we ship deliberately small + safe rather than feature-complete.

## 13. Open questions for slice 1.5+

- Cost-tracking schema: piggyback on `runtime_events` or new dedicated table?
- Auto-deprovision command: blocking (synchronous) or background-job?
- Per-plugin / per-team cost caps in settings
- Do we enable plugins by default once authed, or always require the explicit per-project toggle?
- npm-installable third-party plugins (security model: signed manifests? sandboxing? vetting?)

## 14. Relationship to other docs

- **Idea note** (`2026-05-04-infrastructure-plugin-system-idea.md`) — the original capture, now superseded for slice 0+1 implementation by this doc. Idea note remains the long-term direction (Slice 2/3/4+).
- **Drift follow-ups tracker** Section F — already lists this. Update with link to this spec when committed.
- **IDE north-star** — independent; plugins benefit BOTH the current dashboard UI AND the future cockpit. Architecture choice ("plugin tools live in the MCP surface") is intentionally compatible with both.
- **README "What's deferred"** — should mention plugins are now in flight (slice 0+1 in progress, slice 1.5+ deferred) rather than future-tense.
