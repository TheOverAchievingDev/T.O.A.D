# TOAD Local

Local-first prototype for a reliable multi-agent CLI orchestration system.

The project is now a working backend core plus a lightweight browser dashboard. SQLite/event storage is the durable source of truth; CLI processes, HTTP/SSE transport, and UI views are adapters/projections.

## Current Scope

- Durable message broker with idempotent append, inbox reads, delivery attempts, and SQLite persistence.
- Task event stream with in-memory and SQLite projections.
- Durable approval broker, approval response delivery tracking, and Claude permission/control response support.
- Runtime supervisor, runtime registry, runtime event log, and Claude stream-json adapter.
- Runtime event ingestion for assistant text, tool calls, approval requests, compaction lifecycle, API retry diagnostics, and live event publication.
- Local MCP/facade command surface for messages, tasks, reviews, runtime status, approvals, tool activity, health, and cross-team send.
- Server-Sent Events plus `/api/call` HTTP bridge in `src/transport/apiServer.js`.
- Vite React dashboard under `ui/` for runtime, task, health, and live-event visibility.

## Design Rules

- Durable event state is the truth.
- CLI process state is temporary.
- UI state is a projection.
- Tool calls create durable state; free-form model text is diagnostic unless explicitly captured as a message event.
- All mutating commands require stable identity and idempotency.

## Backend Verification

```powershell
cd C:\Project-TOAD\toad-local
npm.cmd test
```

## UI Verification

```powershell
cd C:\Project-TOAD\toad-local\ui
npm.cmd run lint
npm.cmd run build
```

## Local Dashboard

Start the backend API:

```powershell
cd C:\Project-TOAD\toad-local
npm.cmd run api:dev
```

The default API port is `3001`; override with `TOAD_API_PORT`.

By default the orchestrator persists state to `<projectCwd>/.toad/toad.db`. Override with `TOAD_DB_PATH`:

```powershell
$env:TOAD_DB_PATH='C:\path\to\toad.db'           # any file path
$env:TOAD_DB_PATH=':memory:'                     # disable persistence
```

The persisted surfaces include all five SQLite stores: messages (`broker`), tasks (`taskBoard`), approvals (`approvalBroker`), runtime registry, runtime event log, plus the side-effect delivery log. Across an orchestrator restart, prior state is visible to the new process — pending approvals are still pending, in-progress tasks still in progress, message history intact.

`.toad/` is git-ignored. The directory is auto-created on first run. Stop the orchestrator before deleting or backing up the file (SQLite holds open connections while running).

The dashboard expects:

- SSE: `http://127.0.0.1:3001/events`
- API calls: `http://127.0.0.1:3001/api/call`

If the API runs somewhere else, set the Vite base URL before starting the UI:

```powershell
$env:VITE_TOAD_API_BASE_URL='http://127.0.0.1:3001'
```

### API Token (Optional)

By default the local API has no authentication — anything that can reach the loopback port can drive the runtime. To require a shared-secret bearer token, set the same value on both sides before starting:

```powershell
$env:TOAD_API_TOKEN='<your-secret>'           # backend (api:dev / LocalToadRuntime)
$env:VITE_TOAD_API_TOKEN='<your-secret>'      # UI (Vite dev/build)
```

When `TOAD_API_TOKEN` is unset the server runs in the existing no-auth mode.

When set:

- `POST /api/call` requires `Authorization: Bearer <token>`.
- `GET /events` accepts the token via either `Authorization: Bearer <token>` (curl/tests) or `?token=<token>` (browser `EventSource`).
- The dashboard's `useToadApi` and `useToadEvents` hooks read `VITE_TOAD_API_TOKEN` and attach the token automatically.

### Side-Effect Log Retention

Every runtime tool result and post-compaction reinjection writes a durable receipt to the `side_effect_deliveries` table. On every `LocalToadRuntime.start()`:

1. `replayPendingSideEffects()` marks any orphaned `'pending'` rows as `'failed'` (they outlived their originating runtime session).
2. `pruneSideEffectLog()` deletes terminal (`'delivered'` / `'failed'`) rows older than the retention window.

The default window is **7 days**. Override with `TOAD_SIDE_EFFECT_RETENTION_DAYS`:

```powershell
$env:TOAD_SIDE_EFFECT_RETENTION_DAYS='30'
```

Pending rows are never deleted by retention — they are still potentially-replayable receipts.

### CORS Origin Allow-List

The API server echoes a specific `Access-Control-Allow-Origin` header rather than `*`. By default it accepts the Vite dev origins:

- `http://localhost:5173`
- `http://127.0.0.1:5173`

Override with `TOAD_API_ALLOWED_ORIGINS` (comma-separated). Set it to `*` to echo any origin (matches the legacy wildcard behavior):

```powershell
$env:TOAD_API_ALLOWED_ORIGINS='http://localhost:5173,http://localhost:4173'
$env:TOAD_API_ALLOWED_ORIGINS='*'   # echo any origin
```

Requests without an `Origin` header (curl, server-to-server) are unaffected — no ACAO is set, which is correct for non-browser clients.

Run the UI dev server:

```powershell
cd C:\Project-TOAD\toad-local\ui
npm.cmd run dev
```

## Claude Smoke

The smoke harness is present but depends on local Claude authentication:

```powershell
cd C:\Project-TOAD\toad-local
$env:TOAD_CLAUDE_SMOKE='1'
npm.cmd run smoke:claude
```

If Claude is not authenticated, the smoke test reaches the CLI boundary and reports the auth/rate-limit status rather than proving a full live turn.
