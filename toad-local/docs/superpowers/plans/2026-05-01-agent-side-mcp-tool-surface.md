# Agent-Side MCP Tool Surface

## Goal

Align launched Claude agents with upstream's core behavior: an agent process must receive an MCP config at launch so it can call TOAD tools from inside its own tool loop. The MCP server must connect to the same SQLite database and project root as the orchestrator, not a private in-memory runtime.

## Current Gap

- `src/mcp/stdioServer.js` creates a default `LocalToadRuntime`, which means `:memory:` state.
- `LocalToadRuntime.launchAgent()` spawns Claude without `--mcp-config`.
- Launched agents can stream text/events, but cannot call TOAD tools against the live task board.

## Plan

1. [x] Add tests for MCP config JSON generation and launch-time `--mcp-config` injection.
2. [x] Add tests for stdio MCP runtime creation from `TOAD_DB_PATH`, `TOAD_PROJECT_CWD`, and actor env.
3. [x] Implement a small config writer under `src/mcp/`.
4. [x] Wire `stdioServer.js` through env-backed runtime helpers.
5. [x] Inject generated MCP config only for Claude launches that do not already provide `--mcp-config`.
6. [x] Pass an explicit agent role into the MCP server env so launched agents do not fall back to `human`.
7. [x] Run targeted tests and the full local regression suite.

## Result

Completed 2026-05-01. `npm.cmd test` passes after adding the agent-side MCP config path. Level-3 real-agent smoke confirmed Claude loads the generated MCP config and calls TOAD tools mid-turn.

## Follow-Up

The Level-3 smoke confirmed the MCP wiring works: a real Claude agent discovered `toad-local`, called `task_comment`, received the orchestrator response, and mutated live task state. One permission issue surfaced: `--permission-mode acceptEdits` still asks for approval on MCP tools. TOAD now matches upstream's managed-runtime default by adding `--dangerously-skip-permissions --permission-mode bypassPermissions` for generated Claude MCP launches, replacing `acceptEdits` when present. `skipPermissions: false` remains available as an explicit opt-out.

Full real-agent file-edit smoke also passed: the agent wrote `SMOKE.md`, committed it in the task worktree, called `validation_run`, then called `review_request` without supplying diff/files. TOAD computed `git diff baseRef..HEAD`, captured `review.files = ['SMOKE.md']`, `scopeDrift = []`, `noOpDiff = false`, and the real unified diff. Operator then drove `review -> testing -> merge_ready -> done`; the CI and merge gates fired, worktree cleanup ran, branch was preserved, and `task_history_export` joined 8 task events + 26 runtime events.

## Acceptance

- A Claude launch from `LocalToadRuntime` with a persistent DB and project root gets `--mcp-config <path>`.
- The generated config starts `src/mcp/stdioServer.js` with env for DB, project cwd, team, agent, role, and task id.
- Existing caller-provided `--mcp-config` is preserved.
- Non-Claude commands are not modified.
- The stdio MCP server can reopen the shared SQLite database and see existing task state.
