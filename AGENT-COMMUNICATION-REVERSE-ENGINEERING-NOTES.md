# Agent Communication Reverse Engineering Notes

These notes summarize what is worth carrying forward from `claude_agent_teams_ui-main`, what should be avoided, and how those lessons should shape our own agent orchestration system.

## Core Takeaway

The project's central communication trick is not a traditional live message broker. It combines:

- Durable file-backed inboxes per team member.
- An MCP tool surface so agents can send structured messages.
- A live stdin bridge for the lead process.
- File watchers and runtime journals to observe, verify, and recover delivery.

The useful idea is the separation between "agent-readable durable state" and "process-level live control." The weak point is that the durable state is implemented with whole JSON-array rewrites and a lot of compensating logic.

## What To Take

### Per-Agent Durable Inboxes

Keep the concept of one logical inbox per agent.

Why:

- It gives every agent a stable place to receive work, replies, interrupts, and coordination messages.
- It survives process crashes and app restarts.
- It decouples sender and receiver lifetimes.
- It makes communication inspectable by humans and tools.

How we should use it:

- Use append-only event storage instead of rewriting whole JSON arrays.
- Prefer JSONL or SQLite.
- Every message must have an immutable `messageId`, `conversationId`, sender, recipient, timestamp, kind, and delivery state.

### MCP/Tool-Based Agent Command Surface

Keep the idea that agents communicate through explicit tools like `message_send`, `task_create`, `task_update`, and `cross_team_send`.

Why:

- Natural-language instructions alone are not reliable enough for orchestration.
- Tool calls create structured, auditable events.
- The lead can delegate through a stable API instead of relying on free-form text.
- The UI can show tool activity and message provenance.

How we should use it:

- Define a small command contract first.
- Keep tool names boring and explicit.
- Validate sender identity and recipient identity server-side.
- Treat agent text output as secondary; tool calls are the source of truth.

### Lead Process Stdin Bridge

Keep the idea of sending new lead turns into a live CLI process through stdin when the runtime supports it.

Why:

- The lead needs to remain a long-lived session with context.
- Starting a fresh CLI process for every command is slow and loses conversational/runtime state.
- The lead is the natural place for user commands, planning, delegation, and synthesis.

How we should use it:

- Make the lead adapter runtime-specific.
- Represent injected turns as structured envelopes.
- Track write acknowledgements, timeouts, and response boundaries.
- Never assume stdin means reliable delivery without verification.

### Idempotency And Delivery Verification

Keep message IDs, idempotency keys, delivery journals, and post-write verification.

Why:

- Multi-agent systems retry often.
- CLI runtimes crash, hang, or duplicate work.
- The UI needs to know whether a message was actually delivered.

How we should use it:

- Every command that mutates state gets an idempotency key.
- Delivery writes must be verifiable.
- Store delivery attempts and outcomes.
- Reconciliation should be a first-class background worker, not scattered fallback code.

The strongest implementation pattern in the project is the OpenCode runtime delivery service:

```text
normalize envelope
  -> check current run id
  -> journal.begin(idempotencyKey, payloadHash, destination)
  -> reject reused idempotency key with different payload
  -> verify whether destination already contains message
  -> write through destination port
  -> verify destination again
  -> journal.markCommitted()
  -> emit change event
```

That pattern is worth keeping, but the journal should live in our core database rather than another JSON file.

### Explicit Lead Versus Worker Semantics

Keep the distinction between lead and teammate communication.

Why:

- The lead often has a live process control channel.
- Workers often consume durable inbox/task state.
- Treating every agent the same caused routing bugs in this project.

How we should use it:

- The lead receives user turns directly through the lead adapter.
- Workers receive assigned work through the durable queue/inbox.
- Worker replies go through tools/events, not free-form process output.

## What Not To Take

### Whole-File JSON Array Inboxes

Do not copy the `inboxes/{member}.json` array rewrite model.

Why:

- Append requires read whole file, mutate in memory, write whole file.
- Concurrent writers can overwrite each other.
- Atomic rename prevents corrupted files, but not lost updates.
- The project needs locks, retries, and verification to compensate.

Replacement:

- Use SQLite for MVP reliability, or append-only JSONL if we want simpler files.
- If using files, one event per line and never rewrite for append.

### LLM-Based Message Relay Through The Lead

Do not route worker messages through the lead unless there is a specific policy reason.

Why:

- This project tried it and disabled it.
- The lead answered messages meant for workers.
- It created duplicate relay loops.
- It made delivery depend on the lead interpreting routing instructions correctly.

Replacement:

- Send directly to the target agent's durable inbox.
- Notify the lead separately only when policy requires awareness.

### Treating Free-Form Assistant Output As A Reliable Reply Channel

Do not rely on plain text output for normal agent-to-agent communication.

Why:

- Text may be partial, hidden, suppressed, duplicated, or intended only for humans.
- It is hard to attribute to a specific message or task.
- It does not provide reliable delivery metadata.

Replacement:

- Require structured tool calls for visible replies and state changes.
- Capture text output as diagnostic/contextual data only.

### Large Monolithic Runtime Service

Do not copy the giant all-in-one provisioning/runtime service shape.

Why:

- It mixes launch, delivery, retries, file watching, UI notifications, task state, parsing, approval handling, and recovery.
- It is hard to reason about correctness.
- It makes bug fixes risky because unrelated behavior is tightly coupled.

Replacement:

- Split into small services:
  - runtime adapters
  - message broker
  - task board
  - delivery journal
  - process supervisor
  - permissions/approval broker
  - UI projection/read models

### Runtime-Specific Behavior In Core Logic

Do not bake Claude/OpenCode/Codex assumptions into the orchestration core.

Why:

- Each CLI agent has different launch flags, stdin protocol, stdout events, permission handling, and session semantics.
- Runtime-specific hacks become global bugs.

Replacement:

- Define a runtime adapter interface.
- Keep core orchestration runtime-agnostic.
- Put stdin/stdout/process behavior behind adapters.

## What To Build From These Lessons

### Proposed MVP Architecture

1. `orchestrator-core`
   - Owns teams, agents, tasks, messages, delivery state, and event log.

2. `runtime-adapters`
   - One adapter per CLI agent runtime.
   - Responsibilities: launch, stop, send turn, parse output, detect idle, handle approvals.

3. `message-broker`
   - Durable append-only message store.
   - Supports inbox queries, ack/read state, retries, idempotency, and conversation threads.
   - Owns the delivery journal pattern currently seen in OpenCode delivery.

4. `task-board`
   - Durable task state with assignment, status, comments, dependencies, and provenance.

5. `lead-controller`
   - Receives user goals.
   - Converts them into tasks/messages/tool calls.
   - Coordinates workers through the broker.

6. `worker-loop`
   - Polls or subscribes to assigned work.
   - Runs the selected CLI runtime.
   - Reports progress through structured commands.

7. `ui/read-model`
   - Projects event log into team status, chat, task board, process health, and audit views.

### Minimum Message Envelope

```json
{
  "messageId": "uuid",
  "conversationId": "uuid",
  "from": "lead",
  "to": "worker-1",
  "teamId": "team-a",
  "kind": "instruction",
  "text": "Implement the parser and report blockers.",
  "createdAt": "2026-04-29T00:00:00.000Z",
  "idempotencyKey": "optional-stable-key",
  "replyToMessageId": null,
  "taskRefs": [],
  "metadata": {}
}
```

### Design Rule

Durable event state is the truth. CLI process state is temporary. UI state is a projection.

### Runtime Adapter Contract We Want

The existing `TeamRuntimeAdapter` only covers prepare/launch/reconcile/stop. TOAD needs a wider runtime contract:

```ts
interface RuntimeAdapter {
  launch(input: LaunchInput): Promise<LaunchResult>;
  stop(input: StopInput): Promise<StopResult>;
  sendTurn(input: TurnEnvelope): Promise<DeliveryReceipt>;
  events(): AsyncIterable<RuntimeEvent>;
  approve(input: ApprovalDecision): Promise<void>;
  health(input: HealthInput): Promise<HealthReport>;
}
```

The adapter should not own task state, message state, UI projection, or broker retries. It should translate between our event protocol and the CLI runtime's process/stdin/stdout/permission mechanics.

## Reverse Engineering Priorities

1. Map process launch and runtime lifecycle.
2. Map MCP tool registration and command flow.
3. Map message storage, reading, read-state, and delivery verification.
4. Map task creation, assignment, and completion flow.
5. Map UI actions to IPC to services to controller writes.
6. Identify bug-prone areas caused by coupling, races, or runtime-specific assumptions.
7. Extract the smallest reusable protocol ideas into our own design.

## Initial Verdict

This project proves the viability of durable inboxes plus tool-based coordination, but it also shows the cost of building on experimental CLI team behavior and mutable JSON files. Our system should keep the protocol discipline and durable communication model, while replacing the storage, service boundaries, and runtime abstraction.

## Current Project Map

### Top-Level Shape

The checkout is an Electron desktop app with a workspace-style split:

- `src/main` - Electron main process, IPC handlers, runtime orchestration, file watching, service layer.
- `src/renderer` - React UI.
- `src/preload` - Electron preload API exposed to the renderer.
- `agent-teams-controller` - CommonJS file-backed controller package. This is the closest thing to the orchestration kernel.
- `mcp-server` - FastMCP stdio server that exposes controller operations as tools agents can call.
- `docs/team-management` - design/research docs, including the key inbox and CLI orchestration notes.

### Main Communication Flow

User-to-member message:

```text
Renderer UI
  -> Electron IPC handler
  -> TeamDataService.sendMessage()
  -> agent-teams-controller.messages.sendMessage()
  -> messageStore.sendInboxMessage()
  -> ~/.claude/teams/{team}/inboxes/{member}.json
```

Agent-to-user or agent-to-agent message:

```text
Agent calls MCP tool message_send
  -> mcp-server/src/tools/messageTools.ts
  -> getController(teamName).messages.sendMessage()
  -> agent-teams-controller/src/internal/messages.js
  -> messageStore.sendInboxMessage()
  -> target inbox JSON file
```

Lead live-turn injection:

```text
App/provisioning service
  -> TeamProvisioningService.sendMessageToRun()
  -> child.stdin.write(JSON.stringify({ type: "user", message: ... }) + "\n")
  -> live lead CLI process
```

Lead inbox relay:

```text
Something writes inboxes/{lead}.json
  -> TeamProvisioningService.relayLeadInboxMessages()
  -> builds a new user-turn prompt from unread messages
  -> sendMessageToRun()
  -> marks relayed inbox messages read
```

### Controller Package

`agent-teams-controller/src/controller.js` composes modules around a context:

- `tasks`
- `kanban`
- `review`
- `messages`
- `processes`
- `maintenance`
- `crossTeam`
- `runtime`

`context.js` resolves all paths using `runtimeHelpers.getPaths()`. Almost every operation is a synchronous file mutation against team directories.

Important controller files:

- `messageStore.js` - builds and appends inbox/sent message rows.
- `messages.js` - validates message tool input and prevents bad routing/impersonation.
- `crossTeam.js` - sends messages into another team's lead inbox, with dedupe and cascade guard.
- `taskStore.js` / `tasks.js` - task persistence and workflow commands.
- `kanbanStore.js` / `kanban.js` - board columns and reviewer state.
- `runtime.js` - runtime tool hooks exposed through MCP.

### MCP Server

`mcp-server/src/index.ts` starts a FastMCP stdio server.

`mcp-server/src/tools/index.ts` registers tool groups from `agent-teams-controller/src/mcpToolCatalog.js`.

Tool groups:

- `task`
- `lead`
- `kanban`
- `review`
- `message`
- `process`
- `runtime`
- `crossTeam`

The MCP layer is mostly a schema/validation facade. Real mutations happen in `agent-teams-controller`.

### Runtime Layer

`src/main/services/team/TeamProvisioningService.ts` is the giant runtime coordinator. It handles:

- CLI binary resolution and launch.
- Team bootstrap.
- lead stdin turns.
- stream-json stdout parsing.
- permission/control request handling.
- relay of lead inbox messages.
- OpenCode bridge/runtime delivery.
- lifecycle state and recovery.
- emitting UI change events.

There is an adapter interface in `src/main/services/team/runtime/TeamRuntimeAdapter.ts`, but the real orchestration is still heavily concentrated in `TeamProvisioningService.ts`.

### Known Pressure Points

- Mutable JSON array inboxes require locking, atomic writes, and verification.
- Lead and teammate delivery are inconsistent by necessity: lead uses stdin, teammates use inbox/tool state.
- `TeamProvisioningService.ts` is too large and mixes many responsibilities.
- MCP tool behavior relies on prompt compliance; agents can still answer in text instead of using tools.
- Runtime-specific paths for Claude/OpenCode/Codex are not fully isolated from core team logic.
- Cross-team delivery is inbox-based and lead-targeted, which means it inherits lead relay complexity.

### Useful Extraction Target

The first clean extraction should be a small protocol package:

- `MessageEnvelope`
- `TaskEnvelope`
- `DeliveryReceipt`
- `AgentIdentity`
- `RuntimeAdapter`
- `ToolCommand`
- `EventLogRecord`

After that, implement a broker with SQLite and build adapters around it.
