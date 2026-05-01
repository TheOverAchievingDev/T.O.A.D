# Team Configuration / Provisioning

Slice: 2026-04-30
Status: complete

## Goal

Add a `TeamConfig` and `TeamConfigRegistry` module to formalize team creation, membership, and configuration. Currently, teams are implicit via the event stream. This slice establishes a configuration model that defines a team's members and their respective prompts/roles.

## Changes

### New files

- `src/team/teamConfig.js` — `TeamConfig` and `TeamConfigRegistry` classes
- `test/teamConfig.test.js` — 5 tests

### Behavior

- `TeamConfig`
  - Requires `teamId`.
  - Defines a `lead` member with optional `agentId` and `prompt`.
  - Defines an array of `teammates`, each with optional `agentId` and `prompt`.
- `TeamConfigRegistry`
  - In-memory map of registered team configs.
  - `registerTeam(config)` stores a team (throws on duplicate).
  - `getTeam(teamId)` retrieves a team configuration.
  - `listTeams()` lists all registered teams.

## Test command

```powershell
npm.cmd test
```

All 24 test files pass.
