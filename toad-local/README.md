# Symphony Engine

This directory contains the local engine behind Symphony AI.

The product is now branded as **Symphony AI**. The `toad-local` directory name, `TOAD_*` environment variables, and several internal class names remain for compatibility while the project is renamed in stages.

## What Lives Here

- `src/app/LocalToadRuntime.js` composes the local runtime.
- `src/transport/apiServer.js` exposes the HTTP API and SSE event stream used by the UI.
- `src/mcp/stdioServer.js` exposes the agent-facing MCP tool server.
- `src/tools/localToolFacade.js` is the shared enforcement point for UI calls and agent tool calls.
- `src/task/` owns tasks, lifecycle transitions, worktrees, diff capture, and merge gates.
- `src/runtime/` owns CLI process supervision and runtime event ingestion.
- `src/foundry/` owns Foundry planning sessions and generated project docs.
- `src/drift/` owns deterministic and semantic drift detection.
- `src/plugins/` owns infrastructure plugin registration, auth, resources, jobs, and provider-specific tools.
- `ui/` contains the React + Tauri desktop workspace.

## Design Rules

- Durable event state is the source of truth.
- CLI process state is temporary.
- UI state is a projection.
- Agent tools and UI calls go through the same facade.
- Mutating commands require stable identity and idempotency.
- Risky changes are controlled by policy and human approval gates.

## Architecture

```mermaid
flowchart TD
  UI["React + Tauri desktop UI"] -->|"POST /api/call · GET /events (SSE)"| API["apiServer.js"]
  API --> Facade["localToolFacade.js<br/>(shared enforcement point)"]
  MCP["Agent-facing MCP tool server<br/>(stdioServer.js)"] --> Facade
  Facade --> Broker["broker<br/>(durable messages + delivery journal)"]
  Facade --> Board["task-board<br/>(tasks, lifecycle, worktrees, diff, merge gates)"]
  Facade --> Drift["drift<br/>(deterministic + L3 semantic)"]
  Facade --> Supervisor["RuntimeSupervisor<br/>(process lifecycle + event ingestion)"]
  Supervisor --> AFP["adapterForProvider()"]
  AFP --> Claude["ClaudeStreamJsonAdapter<br/>persistent child · working"]
  AFP --> Codex["CodexExecAdapter<br/>session / per-turn · working"]
  AFP --> Gemini["GeminiExecAdapter<br/>session / per-turn · unverified"]
  AFP --> Opencode["OpencodeExecAdapter<br/>session / per-turn · unverified"]
  Broker --> DB[("SQLite · .toad/toad.db")]
  Board --> DB
```

## Provider Runtimes

Team agents run through a provider-keyed adapter seam (`adapterForProvider()`);
every adapter implements the same `RuntimeAdapter` contract.

| Provider | Adapter | Lifecycle | Status |
| --- | --- | --- | --- |
| Anthropic (Claude) | `ClaudeStreamJsonAdapter` | persistent child | **Working** — whole-impl reviewed, full suite green |
| OpenAI (Codex) | `CodexExecAdapter` | session / per-turn (`codex exec [resume]`) | **Working** — SP1a Stage 1+2 reviewed, grounded against codex-cli 0.130 |
| Google (Gemini) | `GeminiExecAdapter` | session / per-turn (`--session-id` / `--resume latest`) | **Grounded (gemini 0.42.0)** — SP1b: contract + stream-JSON vocabulary captured from the real CLI, adapter/normalizer corrected, scripted e2e green in the root gate. Residuals below. |
| OpenCode | `OpencodeExecAdapter` | session / per-turn (`run … --session <id>`) | **Grounded (opencode 1.15.4)** — SP1c: contract + `--format json` vocabulary captured from the real CLI, a real stdin→positional-arg defect fixed, adapter/normalizer corrected, scripted e2e green in the root gate. Residuals below. |

> **Gemini (SP1b, grounded 2026-05-18):** the CLI invocation contract and
> `--output-format stream-json` event vocabulary are now grounded against the
> real gemini 0.42.0 (grounding doc `docs/superpowers/grounding/2026-05-18-gemini-cli.md`),
> the adapter's broken `--resume <uuid>` model was corrected to the ratified
> `--session-id <uuid>` (first turn) / `--resume latest` model, and a
> front-loaded scripted e2e proves the real adapter→normalizer→ingestor→broker
> seam. **Documented residuals (not yet live-proven):** cross-process-restart
> resume; `tool_use`/`error` event shapes (preserved as safe degradation —
> not observed in the single grounding turn); and there is still no first-turn
> MCP-tool visibility probe across session adapters (cross-cutting A4, deferred).
>
> **OpenCode (SP1c, grounded 2026-05-18):** the `opencode run --format json`
> contract + NDJSON event vocabulary are grounded against the real opencode
> 1.15.4 (grounding doc `docs/superpowers/grounding/2026-05-18-opencode-cli.md`).
> A real defect was found and fixed: the prompt was written to stdin, but
> `opencode run` has no stdin path — it is now passed as the final positional
> arg. Session id is captured from the top-level `sessionID` (line-1
> `step_start`) and resumed via `--session <id>` (`--continue` fallback); a
> front-loaded scripted e2e proves the real adapter→normalizer→ingestor→broker
> seam. **Documented residuals (not yet live-proven):** multi-event streaming
> of long replies; `tool`/`error` event shapes (unseen in the single grounding
> turn — degrade to `runtime_event`); error-path JSON-vs-stderr format;
> cross-process-restart resume; and the cross-cutting A4 first-turn MCP-tool
> visibility probe (deferred, applies to all session adapters).
>
> Use Claude or Codex for the highest-assurance team runs; Gemini and OpenCode
> are usable with their residuals understood.

## Screenshots

Captured from the `family-meal-planner` demo scenario. Full gallery (34 views):
**[docs/SCREENSHOTS.md](docs/SCREENSHOTS.md)**.

| Cockpit (FOR me) | Tasks board |
| --- | --- |
| ![Cockpit FOR me](demo/screenshots/family-meal-planner-full/00-cockpit-for-me.png) | ![Tasks board](demo/screenshots/family-meal-planner-full/07-tasks-board.png) |

| Foundry discovery | Drift monitor |
| --- | --- |
| ![Foundry discovery](demo/screenshots/family-meal-planner-full/03-foundry-discovery.png) | ![Drift monitor](demo/screenshots/family-meal-planner-full/09-drift-monitor.png) |

## Backend Verification

```powershell
cd C:\path\to\symphony-ai\toad-local
npm.cmd test
```

## UI Verification

```powershell
cd C:\path\to\symphony-ai\toad-local\ui
npm.cmd run typecheck
npm.cmd run build
```

## Local Development

Start the backend API:

```powershell
cd C:\path\to\symphony-ai\toad-local
npm.cmd run api:dev
```

Start the UI in a second terminal:

```powershell
cd C:\path\to\symphony-ai\toad-local\ui
npm.cmd run dev
```

For the full desktop shell:

```powershell
cd C:\path\to\symphony-ai\toad-local\ui
npm.cmd run tauri:dev
```

The default API port is `3001`; override with `TOAD_API_PORT`.

By default Symphony persists project state to `<projectCwd>/.toad/toad.db`. Override with `TOAD_DB_PATH`:

```powershell
$env:TOAD_DB_PATH='C:\path\to\toad.db'
$env:TOAD_DB_PATH=':memory:'
```

`.toad/` is git-ignored. Stop the runtime before deleting or backing up the SQLite file.

## API Token

Generate and persist a local API token:

```powershell
npm.cmd run token:generate
```

Or set it per shell:

```powershell
$env:TOAD_API_TOKEN='<your-secret>'
$env:VITE_TOAD_API_TOKEN='<your-secret>'
```

When set, `POST /api/call` and `GET /events` require the token.

## Claude Smoke

The live Claude smoke test depends on local Claude authentication:

```powershell
cd C:\path\to\symphony-ai\toad-local
$env:TOAD_CLAUDE_SMOKE='1'
npm.cmd run smoke:claude
```

If Claude is not authenticated, the smoke test reaches the CLI boundary and reports the auth or rate-limit status instead of proving a full live turn.
