# Persistent Team Config + CRUD Tools

Slice: 2026-04-30
Status: complete

## Goal

The next-most-load-bearing legacy gap is team-as-a-unit lifecycle. The legacy app exposes `TEAM_CREATE` / `TEAM_LAUNCH` / `TEAM_STOP` / `TEAM_DELETE` / `TEAM_LIST`. TOAD has individual `agent_launch` / `agent_stop` plus a stub `TeamConfig` / `TeamConfigRegistry` that lives only in memory and is unused outside its own test.

This slice does the foundation work for team lifecycle: extend the `TeamConfig` schema to include actual launch parameters (so a team config is enough to spawn its members), add a SQLite-backed `SqliteTeamConfigRegistry`, wire it into `LocalToadRuntime`, and expose the three CRUD MCP tools (`team_create`, `team_list`, `team_delete`). The orchestration pair (`team_launch`, `team_stop`) is intentionally a separate follow-up slice — it depends on this one but adds new failure-mode considerations (partial launches, idempotency across multiple agent_launch calls) that deserve their own design pass.

## Schema

### `TeamConfig` member shape

Each team has a lead and zero or more teammates. Both share the same shape so the orchestration layer treats them uniformly:

```
TeamMember {
  agentId:     string (required)
  command:     string (default: "claude")
  args:        string[] (default: [])
  cwd:         string | null
  env:         object<string,string> (default: {})
  providerId:  string (default: "claude")
  prompt:      string (default: "")  // optional system prompt / initial message
}
```

`runtimeId` is **not** stored on the member — it is derived at launch time as `runtime-<teamId>-<agentId>` so re-launching a team produces predictable IDs.

### SQLite

```sql
CREATE TABLE IF NOT EXISTS team_configs (
  team_id    TEXT PRIMARY KEY,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

The whole config is JSON-blobbed. Future schema changes can be handled with `JSON_EXTRACT` queries or by reading and rewriting; we don't need column-per-field for the current query patterns (always read by `team_id`, list all).

`team_configs` joins the existing five storage tables (broker, taskBoard, approvalBroker, runtimeRegistry, eventLog) plus side_effect_deliveries in the shared `<projectCwd>/.toad/toad.db`.

## Tool surface

- `team_list` — read-only, returns all configs.
- `team_create` — mutating; accepts a full TeamConfig payload; upserts on `teamId` (matches the legacy app's "save and overwrite" pattern; lets operators iterate on config without a separate delete-then-create dance).
- `team_delete` — mutating; removes the config. Does NOT stop running runtimes (that comes from the upcoming `team_stop`); operators who want to wipe a team should `team_stop` first, then `team_delete`. The plan doc captures this ordering.

All three are wired through `LocalToolFacade` via a new `teamConfigRegistry` injection.

## Changes

- `src/team/teamConfig.js` — `TeamConfig` schema extended with the new member fields. Backward-compatible defaults so existing callers (none in src/, just the test) keep working.
- `src/team/sqliteTeamConfigRegistry.js` — new SQLite-backed registry with `registerTeam`, `getTeam`, `listTeams`, `deleteTeam`, `close`. Mirrors the existing SqliteBroker / SqliteTaskBoard / SqliteApprovalBroker shape (constructor `{ filePath, db }`, default `:memory:`, schema applied via `openToadDatabase`).
- `src/storage/schema.sql` — new `team_configs` table.
- `src/commands/command-contract.js` — `TEAM_CREATE`, `TEAM_LIST`, `TEAM_DELETE`. Create and Delete are mutating.
- `src/mcp/localToolDefinitions.js` — three new tool defs.
- `src/tools/localToolFacade.js` — accepts `teamConfigRegistry`; routes the three commands.
- `src/app/LocalToadRuntime.js` — constructs `SqliteTeamConfigRegistry({ filePath: dbPath })` by default; passes it to the facade.
- `test/teamConfig.test.js` — extended assertions on the new fields.
- `test/sqliteTeamConfigRegistry.test.js` — NEW. Persistence test (write through one instance, read through another against the same file), plus the standard CRUD coverage.
- `test/localToolFacade.test.js` — 3 new tests for the routing of the three commands.
- `test/localMcpToolDefinitions.test.js` — 3 new tools in the expected names list and the mutating-tools assertion (create + delete are mutating; list is read-only).
- `package.json` — adds `node test/sqliteTeamConfigRegistry.test.js` to the test chain.

## Verification

```powershell
node test/teamConfig.test.js
node test/sqliteTeamConfigRegistry.test.js
node test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
npm.cmd test
```

All 28 backend test files pass.

## Out Of Scope

- `team_launch` / `team_stop` orchestration — next slice.
- Team naming, descriptions, color, icons — pure metadata; add when the UI consumes them.
- Team membership changes (add / remove a teammate from a running team). The model is currently "stop the team, edit the config, start the team again". Live membership is a much larger design.
- Foreign keys from `runtime_instances.team_id` to `team_configs.team_id`. The current data model is loose — runtimes can exist for a `team_id` that is not in `team_configs`. Tightening that is an integrity follow-up, not part of this slice.
