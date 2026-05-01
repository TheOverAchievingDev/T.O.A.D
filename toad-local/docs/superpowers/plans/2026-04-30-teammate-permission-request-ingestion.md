# Teammate Permission Request Ingestion

Slice: 2026-04-30
Status: complete

## Goal

Parse teammate `permission_request` payloads received through inbox messages,
persist them as approval records, and respond by applying `permission_suggestions`
to `.claude/settings.local.json`.

## Legacy Finding

Claude Code teammate runtimes send `permission_request` JSON through the inbox
messaging protocol. The app cannot respond by writing `permission_response` back
to the teammate inbox (runtime ignores it) or by sending `control_response` via
lead stdin (request\_id doesn't match the teammate's pending prompt). The only
working response mechanism is applying `permission_suggestions` to the project's
`.claude/settings.local.json`, which the teammate CLI reads via
`--setting-sources user,project,local`.

### Suggestion types

| Type | Mode | Tools |
|---|---|---|
| `addRules` | N/A | Explicit tool names from `rules[].toolName` |
| `setMode` | `acceptEdits` | Edit, Write, NotebookEdit |
| `setMode` | `bypassPermissions` | Edit, Write, NotebookEdit, Bash, Read, Grep, Glob |

## Changes

### New files

- `src/runtime/parsePermissionRequest.js` — standalone parser for teammate
  `permission_request` JSON payloads. Validates `request_id`, `agent_id`,
  `tool_name`; preserves `permission_suggestions`, `tool_use_id`, `description`,
  `input`.

- `src/runtime/claudeSettingsWriter.js` — applies `permission_suggestions` to
  `.claude/settings.local.json`. Handles `addRules` and `setMode` suggestion
  types. Uses atomic temp+rename writes and merges without overwriting existing
  settings.

### Modified files

- `src/tools/localToolFacade.js` — extended `#approvalRespond` to detect
  teammate approvals (`metadata.source === 'teammate'` with
  `metadata.permissionSuggestions`). When approved, calls
  `applyPermissionSuggestions()`. Also sends belt-and-suspenders
  `control_response` to the lead adapter. Added `projectCwd` constructor option.

- `src/app/LocalToadRuntime.js` — added `projectCwd` constructor option and
  passes it through to `LocalToolFacade`.

### New test files

- `test/parsePermissionRequest.test.js` — 13 tests covering valid payloads,
  missing required fields, optional defaults, suggestion types, edge cases.

- `test/claudeSettingsWriter.test.js` — 13 tests covering addRules, setMode
  translation, merge behavior, deny path, no-op when nothing new.

- `test/teammatePermission.test.js` — 5 integration tests covering full flow:
  parse → persist → approve with settings write, deny without write,
  belt-and-suspenders adapter call, no-op when projectCwd missing.

## Test command

```powershell
npm.cmd test
```

All 20 test files pass (existing 17 + 3 new).
