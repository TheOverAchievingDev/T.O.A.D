# TOAD Staged Reverse Engineering And Rebuild Plan

This is the working plan for reverse engineering `claude_agent_teams_ui-main` and using the useful parts to build our own reliable multi-agent orchestration system.

Related notes:

- `AGENT-COMMUNICATION-REVERSE-ENGINEERING-NOTES.md`

## Goal

Understand the current project deeply enough to:

1. Identify the real mechanics behind team creation, agent messaging, task orchestration, runtime launch, and UI projection.
2. Separate durable concepts from accidental implementation complexity.
3. Decide which bugs are worth fixing in-place for learning and which should be avoided in our own architecture.
4. Build a cleaner orchestration core that can coordinate multiple CLI agents with one lead agent.

## Ground Rule

Treat this repository as behavioral research unless we intentionally accept AGPL-3.0 obligations. We should copy ideas, protocols, and observed behavior into our own clean implementation, not paste code wholesale.

## Stage 1 - System Map

Status: first pass complete.

Purpose:

- Build a trustworthy map of how the app ticks before changing anything.
- Identify the real data stores and control paths.

Questions to answer:

- How does the Electron app boot and construct services?
- Which service owns team state?
- Which path handles UI-to-agent messages?
- Which path handles agent-to-agent messages?
- Which path handles lead process stdin?
- Which path watches files and refreshes the UI?

Current findings:

- `src/main/index.ts` is the main service composition root.
- `initializeServices()` constructs `TeamDataService`, `TeamProvisioningService`, `CrossTeamService`, runtime adapters, backup, log tracking, review services, and scheduler services.
- `initializeIpcHandlers()` wires renderer IPC into domain handlers, including `teams.ts`.
- `ServiceContext` owns project/session parsing services and `FileWatcher`.
- `FileWatcher` watches `projects`, `todos`, `teams`, and `tasks`.
- Team-change events fan out to the renderer, HTTP SSE, message feed invalidation, relay, notifications, reconciliation, and backup.

Important files:

- `src/main/index.ts`
- `src/main/ipc/handlers.ts`
- `src/main/ipc/teams.ts`
- `src/main/services/infrastructure/ServiceContext.ts`
- `src/main/services/infrastructure/FileWatcher.ts`
- `src/main/services/team/TeamDataService.ts`
- `src/main/services/team/TeamProvisioningService.ts`

Deliverable:

- A current-system architecture map with file references and flow diagrams.

## Stage 2 - Storage And Controller Contracts

Status: first pass complete.

Purpose:

- Identify every durable file format the controller uses.
- Understand which files are source of truth versus projections/cache.

Questions to answer:

- What exact files live under `~/.claude/teams/{team}`?
- What exact files live under `~/.claude/tasks/{team}`?
- How are messages, sent messages, tasks, kanban state, reviews, processes, runtime state, and cross-team outboxes stored?
- Which writes are locked? Which are not?
- Which writes are idempotent? Which are not?

Known controller modules:

- `agent-teams-controller/src/internal/messageStore.js`
- `agent-teams-controller/src/internal/messages.js`
- `agent-teams-controller/src/internal/taskStore.js`
- `agent-teams-controller/src/internal/tasks.js`
- `agent-teams-controller/src/internal/kanbanStore.js`
- `agent-teams-controller/src/internal/reviewState.js`
- `agent-teams-controller/src/internal/processStore.js`
- `agent-teams-controller/src/internal/crossTeam.js`
- `agent-teams-controller/src/internal/runtime.js`

Deliverable:

- A storage schema document with risks and replacement design.

Current storage map:

| Store | Path | Shape | Writers | Risk |
|---|---|---|---|---|
| Team config | `~/.claude/teams/{team}/config.json` | object | runtime/bootstrap/app | canonical team metadata; many readers assume it exists |
| Member metadata | `~/.claude/teams/{team}/members.meta.json` | object with `members[]` | runtime/app | merged with config and inbox names to infer roster |
| Inboxes | `~/.claude/teams/{team}/inboxes/{member}.json` | JSON array | UI, MCP tools, runtime delivery, cross-team | high race risk because append rewrites whole array |
| Sent messages | `~/.claude/teams/{team}/sentMessages.json` | JSON array | lead/runtime/controller | high race risk; used as user-visible lead/process output |
| Cross-team outbox | `~/.claude/teams/{team}/sent-cross-team.json` | JSON array | cross-team controller | dedupe state mixed with audit log |
| Kanban state | `~/.claude/teams/{team}/kanban-state.json` | object | kanban tools/controller | duplicates task review state and can drift |
| Processes | `~/.claude/teams/{team}/processes.json` | JSON array | process tools | process liveness is derived at read time |
| Tasks | `~/.claude/tasks/{team}/{taskId}.json` | one JSON object per task | task tools/controller/app | single task rewrite; relationship updates touch multiple task files |
| Task attachments | `~/.claude/teams/{team}/task-attachments/{taskId}/...` | files plus task metadata | task attachment tools | metadata and stored file can drift |
| Control API state | `~/.claude/team-control-api.json` | object with base URL | desktop app | lets MCP/runtime tools call back into app HTTP API |

Controller path resolution:

```text
runtimeHelpers.getPaths(teamName)
  -> claudeDir
  -> teamDir = {claudeDir}/teams/{team}
  -> tasksDir = {claudeDir}/tasks/{team}
  -> kanbanPath = {teamDir}/kanban-state.json
  -> processesPath = {teamDir}/processes.json
```

Key storage evidence:

- `agent-teams-controller/src/internal/runtimeHelpers.js` resolves paths and reads `config.json` / `members.meta.json`.
- `agent-teams-controller/src/internal/messageStore.js` appends inbox and sent message rows by reading an array, pushing, and rewriting.
- `agent-teams-controller/src/internal/taskStore.js` stores each task as `{tasksDir}/{taskId}.json`.
- `agent-teams-controller/src/internal/kanbanStore.js` stores board projection in `kanban-state.json`.
- `agent-teams-controller/src/internal/processStore.js` stores process registrations in `processes.json`.
- `agent-teams-controller/src/internal/crossTeam.js` stores cross-team dedupe/audit in `sent-cross-team.json`.

Immediate TOAD replacement:

- Store messages, tasks, comments, status changes, process registrations, and delivery receipts as append-only events.
- Build current task state, inbox views, kanban columns, and process views as projections.
- Keep attachments as files, but put attachment metadata in the event store.
- Use SQLite first unless we have a strong reason to keep file-only storage.

## Stage 3 - MCP Tool Surface

Status: first pass complete.

Purpose:

- Understand the command API exposed to agents.
- Decide the minimal command set for our own system.

Questions to answer:

- Which tools are for leads only?
- Which tools are safe for teammates?
- Which tools mutate durable state?
- Which tools depend on prompt discipline?
- Which tool validations are essential?

Known tool groups:

- `task`
- `lead`
- `kanban`
- `review`
- `message`
- `process`
- `runtime`
- `crossTeam`

Important files:

- `mcp-server/src/index.ts`
- `mcp-server/src/tools/index.ts`
- `agent-teams-controller/src/mcpToolCatalog.js`

Deliverable:

- A minimal TOAD command contract.

Current MCP surface:

| Group | Tools | Role |
|---|---|---|
| `task` | `task_create`, `task_create_from_message`, `task_get`, `task_get_comment`, `task_list`, `task_set_status`, `task_restore`, `task_start`, `task_complete`, `task_set_owner`, `task_add_comment`, `task_attach_file`, `task_attach_comment_file`, `task_set_clarification`, `task_link`, `task_unlink`, `member_briefing`, `task_briefing` | Core work-board manipulation and task briefing |
| `lead` | `lead_briefing` | Lead queue/context briefing |
| `message` | `message_send` | Visible team/user messaging through inbox files |
| `crossTeam` | `cross_team_send`, `cross_team_list_targets`, `cross_team_get_outbox` | Cross-team lead-to-lead messaging |
| `process` | `process_register`, `process_list`, `process_unregister`, `process_stop` | Teammate-started background process registry |
| `kanban` | `kanban_get`, `kanban_set_column`, `kanban_clear`, `kanban_list_reviewers`, `kanban_add_reviewer`, `kanban_remove_reviewer` | Review/approval board overlay |
| `review` | `review_request`, `review_start`, `review_approve`, `review_request_changes` | Review lifecycle |
| `runtime` | `team_launch`, `team_stop`, `runtime_bootstrap_checkin`, `runtime_deliver_message`, `runtime_task_event`, `runtime_heartbeat` | Desktop-app runtime bridge and OpenCode runtime callbacks |

Important distinction:

- Most MCP tools mutate local controller files directly.
- Runtime MCP tools call back into the desktop app HTTP control API using `~/.claude/team-control-api.json` or an explicit `controlUrl`.

Design takeaways:

- Keep `message_send`, task lifecycle tools, and runtime heartbeat/checkin concepts.
- Merge separate task status/comment/review events into one event model internally.
- Treat `team_launch` and `team_stop` as privileged lead/app operations, not ordinary worker tools.
- Make cross-team delivery a broker-level addressed message, not a separate inbox/outbox mechanism.
- Require `from` for all agent-originated writes and validate it against runtime identity.

## Stage 4 - Runtime Lifecycle

Status: first pass complete.

Purpose:

- Understand how CLI agents are launched, resumed, fed messages, observed, stopped, and recovered.

Questions to answer:

- How are lead processes launched?
- How are worker processes launched?
- What is the stdin protocol?
- What stdout/stderr formats are parsed?
- What happens on compaction, rate limit, crash, auth failure, or permission request?
- What is Claude-specific, OpenCode-specific, Codex-specific, or generic?

Important files:

- `src/main/services/team/TeamProvisioningService.ts`
- `src/main/services/team/runtime/TeamRuntimeAdapter.ts`
- `src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts`
- `src/main/services/team/opencode/*`
- `src/main/services/team/ClaudeBinaryResolver.ts`
- `src/main/utils/childProcess.ts`

Deliverable:

- A runtime adapter interface for our own system.

Current runtime lifecycle map:

```text
launchTeam(request)
  -> lock by team
  -> resolve team config, previous session, provider env, member specs
  -> write deterministic bootstrap spec and launch prompt files
  -> write MCP config file
  -> validate MCP runtime
  -> spawn Claude CLI with stdin/stdout/stderr pipes
  -> attach stdout stream-json parser and stderr parser
  -> wait for stream-json result.success to finish bootstrap/reconnect
  -> keep process alive for later stdin turns
```

Lead launch arguments:

```text
--input-format stream-json
--output-format stream-json
--verbose
--setting-sources user,project,local
--mcp-config {temp mcp config}
--team-bootstrap-spec {temp bootstrap spec}
--team-bootstrap-user-prompt-file {temp prompt}
--disallowedTools {app runtime disallowed tools}
--dangerously-skip-permissions --permission-mode bypassPermissions
  or
--permission-prompt-tool stdio --permission-mode default
--resume {previousSessionId} when a valid session JSONL exists
```

Lead stdin protocol:

```json
{
  "type": "user",
  "message": {
    "role": "user",
    "content": [
      { "type": "text", "text": "message text" }
    ]
  }
}
```

Runtime stdout parser:

- Reads newline-delimited JSON from the CLI.
- Tracks `session_id` for resume.
- Handles `assistant` text blocks as live lead output.
- Tracks `tool_use` blocks to show what the lead is doing.
- Intercepts SendMessage-related tool use for UI/live state.
- Handles `control_request` for tool approvals.
- Handles `result.success` as turn completion and `result.error` as turn failure.
- Handles `system.compact_boundary` by scheduling a context reinjection turn.
- Handles `system.api_retry` and similar retry/error events for UI visibility.

Lead relay:

```text
write to inboxes/{lead}.json
  -> watcher/direct relay trigger
  -> relayLeadInboxMessages()
  -> filter noise, permission requests, already-native deliveries, duplicates
  -> build a relay prompt containing unread messages
  -> inject relay prompt through lead stdin
  -> mark relayed inbox rows read
  -> capture lead reply until result.success/timeout
  -> persist clean human-visible reply to sentMessages.json/live cache
```

Worker and mixed runtime lanes:

- OpenCode and secondary lanes are routed through runtime adapter paths instead of the legacy Claude stream-json provisioning path.
- Runtime delivery uses explicit destination ports, delivery envelopes, and a journal before/after writing.
- This is closer to the design we want than the legacy JSON inbox path, but it still lives under a large service.

Design takeaways:

- Keep long-lived lead sessions with structured stdin turns.
- Keep runtime adapters for launch, stop, send-turn, parse-output, approval, liveness, and idle detection.
- Make the lead relay a broker concern with delivery receipts, not prompt-building code buried in the runtime service.
- Separate stdout event parsing from UI projection and durable message writes.
- Treat compaction/context reinjection as a runtime adapter event.
- Treat permissions as a dedicated approval broker shared by lead and workers.

Local rebuild note:

- `toad-local` now normalizes Claude `control_request` messages with `request.subtype === "can_use_tool"` into internal `approval_request` runtime events, persists them through the shared approval broker, and projects pending approvals through the local read model. `approval_respond` writes matching Claude `control_response` payloads back to live runtime adapters. Non-tool control requests remain audit-only runtime events.

## Stage 5 - Message Delivery Deep Dive

Status: complete.

Purpose:

- Fully trace normal messages, direct messages, lead messages, cross-team messages, OpenCode runtime messages, and notification projections.

Questions to answer:

- When is an inbox write enough?
- When is relay required?
- How does the system know a message was read?
- How does it prevent duplicate delivery?
- What exactly fails when agents reply in plain text instead of tool calls?

Important files:

- `src/main/services/team/TeamInboxWriter.ts`
- `src/main/services/team/TeamInboxReader.ts`
- `src/main/services/team/TeamSentMessagesStore.ts`
- `src/main/services/team/inboxMessageIdentity.ts`
- `src/main/services/team/TeamDataService.ts`
- `src/main/services/team/TeamProvisioningService.ts`
- `src/main/services/team/CrossTeamService.ts`
- `src/main/services/team/opencode/delivery/RuntimeDeliveryService.ts`
- `src/main/services/team/opencode/delivery/RuntimeDeliveryJournal.ts`
- `src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts`
- `src/main/services/team/opencode/delivery/OpenCodePromptDeliveryWatchdog.ts`
- `src/main/ipc/teams.ts`
- `agent-teams-controller/src/internal/messageStore.js`
- `agent-teams-controller/src/internal/messages.js`
- `mcp-server/src/tools/messageTools.ts`
- `mcp-server/src/tools/runtimeTools.ts`

Deliverable:

- A TOAD message broker design with delivery semantics.

### Current delivery findings

The upstream project has three delivery mechanisms that share one user-facing message UI but have different correctness rules.

1. Legacy inbox delivery writes whole JSON arrays under `~/.claude/teams/{team}/inboxes/{member}.json`.
2. Live lead delivery writes a structured `type: "user"` stream-json object to the lead process stdin.
3. OpenCode runtime delivery uses an adapter bridge plus a delivery ledger/watchdog before marking an inbox row read.

The important design lesson is that "message exists in storage", "runtime accepted a turn", "recipient produced a sufficient reply", and "message can be marked read" are separate states. The current project often collapses or re-derives those states through file flags, in-memory sets, watchers, and prompt text. TOAD should model them directly.

### Legacy inbox and sent-message stores

Current write path:

```text
UI or MCP tool
  -> TeamDataService.sendMessage()
  -> agent-teams-controller.messages.sendMessage()
  -> messageStore.sendInboxMessage()
  -> inboxes/{member}.json
```

`TeamInboxWriter` improves the direct app write path with a file lock, inbox lock, atomic write, and post-write verification by `messageId`. The controller package still has a simpler `appendRow()` path that reads the current JSON array, pushes one row, and rewrites the file. Atomic rename prevents partial JSON, but it does not prevent lost updates when two writers read the same old array and then overwrite each other.

`TeamInboxReader` treats each inbox file as a lossy projection: it skips missing, oversized, non-regular, invalid JSON, and malformed rows. It also generates deterministic legacy IDs for rows missing `messageId` with `sha256(from + timestamp + text)`, mainly for UI keys and dedupe. That is useful for compatibility, but it is not a replacement for immutable IDs at write time.

`TeamSentMessagesStore` stores lead/user-visible outgoing rows in `sentMessages.json`, capped to the newest 200 records. It is a UI/history store, not a full event log. Cross-team sender copies and live lead replies can land here, which makes it part audit trail and part projection.

TOAD replacement:

- Keep the inbox and sent-message concepts as read models.
- Do not make JSON arrays the source of truth.
- Every durable message must be inserted once into SQLite with immutable IDs.
- Legacy imports may synthesize IDs only for old rows.

### User to live lead

When the UI targets the lead and the team process is alive, `src/main/ipc/teams.ts` routes the message directly to stdin:

```text
UI sendMessage(lead)
  -> pre-generate messageId
  -> TeamProvisioningService.sendMessageToTeam()
  -> sendMessageToRun()
  -> child.stdin.write(JSON.stringify({ type: "user", message: ... }) + "\n")
  -> TeamDataService.sendDirectToLead()
  -> sentMessages.json best-effort persistence
```

The code deliberately separates stdin delivery from persistence. If stdin succeeds but persistence fails, it does not fall back to the inbox because that would duplicate the user turn. Attachments are only supported for a live lead because they are converted into stream-json content blocks.

If stdin fails before delivery, the handler falls back to the inbox path when safe. This is a runtime adapter concern in TOAD: the broker should record the message first, then delivery attempts should say whether a live runtime write happened, failed retryably, or failed terminally.

TOAD replacement:

```text
broker.appendMessage(user -> lead)
  -> delivery worker chooses live runtime destination
  -> begin delivery_attempt(kind=runtime_stdin)
  -> adapter.sendTurn()
  -> commit/fail delivery_attempt
  -> UI projection shows message regardless of runtime state
```

### Lead inbox relay

Messages can still be written to the lead inbox by teammates, system notifications, task comment notifications, cross-team delivery, and offline paths. The live lead process does not consume that file directly, so `relayLeadInboxMessages()` converts unread lead inbox rows into a synthetic stdin prompt.

Lead relay does all of the following inside one large service method:

- Guards against stale/killed/cancelled runs.
- Scans permission-request messages even during provisioning.
- Filters idle/noise/shutdown messages and marks some read without relay.
- Dedupes with `relayedLeadInboxMessageIds`.
- Matches same-team native deliveries so messages already consumed by Claude Code are not relayed twice.
- Defers sourceless same-team messages for a grace window to give native delivery time to happen.
- Handles cross-team reply expectations and cascade/dedupe heuristics.
- Batches at most 10 actionable unread rows.
- Builds a prompt with routing instructions, provenance, task context, and cross-team reply instructions.
- Writes the prompt to lead stdin.
- Marks inbox rows read after successful write.
- Captures the lead's assistant text and persists cleaned human-visible replies to sent messages.

This explains why the lead path is brittle: relay is not just transport. It also performs filtering, dedupe, reply capture, cross-team policy, permission interception, and UI persistence.

TOAD replacement:

- The broker owns message state and read/ack state.
- The delivery worker owns runtime delivery attempts and retry timing.
- A classifier can mark messages as noise/system/permission/actionable, but classification writes must be explicit events.
- Lead replies should be durable only when the lead calls a structured tool or the adapter emits a normalized runtime event that the broker accepts.
- Plain assistant text can be captured as diagnostics or a draft-visible reply, but it should not be the primary agent-to-agent reply channel.

### Teammate delivery

For Claude-style teammates, an inbox write is normally enough. The teammate runtime watches or polls its own inbox between turns. The project explicitly disabled `relayMemberInboxMessages()` for normal teammate DMs because relaying through the lead caused:

- The lead answering messages meant for teammates.
- Duplicate messages and relay loops.
- Prompt leakage where teammates saw "do not reply to user" relay instructions.

This is the clearest behavioral finding: same-team worker messages should go directly to the worker's durable inbox/runtime lane. The lead may be notified separately, but should not be a transport hop.

OpenCode secondary lanes are different. They do not consume the legacy inbox file directly, so the app calls `relayOpenCodeMemberInboxMessages()`. That function reads unread inbox rows, creates or resumes an OpenCode prompt-delivery ledger record, calls the runtime adapter, observes whether a response appeared, and only then marks the inbox row read when the response is semantically sufficient.

TOAD replacement:

- Worker routing should be based on a registered `deliveryMode` per runtime instance:
  - `pollable_inbox` for runtimes that read durable broker inboxes themselves.
  - `runtime_turn` for runtimes that need stdin/bridge injection.
  - `manual_only` for offline agents.
- The broker should not assume that writing the message means the runtime accepted it.
- Read/ack should be separate from runtime acceptance and response proof.

### OpenCode runtime delivery

The best reusable pattern is in `RuntimeDeliveryService`:

```text
normalize envelope
  -> verify current run id
  -> resolve destination
  -> derive deterministic destinationMessageId
  -> hash payload
  -> journal.begin(idempotencyKey, payloadHash, destination)
  -> reject reused idempotencyKey with different payload
  -> return duplicate if already committed
  -> verify destination for pre-existing write
  -> write through destination port
  -> verify destination again
  -> journal.markCommitted()
  -> emit change event
```

The destination-port abstraction is also worth keeping. Upstream ports write to `user_sent_messages`, `member_inbox`, or `cross_team_outbox`. TOAD should keep the port idea but point ports at broker destinations rather than JSON files.

OpenCode also has a second ledger, `OpenCodePromptDeliveryLedger`, for app-to-runtime prompt injection. It tracks:

- Payload hash and inbox message identity.
- Attempts, max attempts, next attempt time, and terminal failures.
- Runtime session, run, lane, and pre/post prompt cursors.
- Whether the runtime accepted the prompt.
- Whether a visible reply or non-visible progress proof was observed.
- Whether the inbox read mark was committed.

The watchdog handles pending, unobserved, permission-blocked, empty-turn, ack-only, and retryable response states. The critical idea is that "accepted by runtime" does not necessarily mean "handled by agent." TOAD should model both.

### Cross-team delivery

Current cross-team flow:

```text
cross_team_send
  -> validate source and target teams
  -> resolve target lead
  -> format cross-team text with conversation metadata
  -> append target lead inbox row
  -> append source sent-message copy
  -> best-effort relay target lead if online
```

This inherits the lead relay complexity because cross-team delivery targets the target team's lead inbox. It also has a separate `sent-cross-team.json` outbox/dedupe store plus sender copies in `sentMessages.json`.

TOAD replacement:

- Cross-team is just broker addressing: `to = { kind: "agent", teamId: targetTeam, agentId: targetLead }` or `to = { kind: "team", teamId: targetTeam }`.
- Conversation IDs and reply-to IDs are first-class message fields.
- Sender copies are projections from the same immutable event, not separate writes.
- Cascade limits are policy checks before append, not ad hoc outbox logic.

### Read and acknowledgement semantics

The upstream `read` flag means different things depending on path:

| Path | What `read: true` means |
|---|---|
| Claude teammate inbox | The teammate/runtime likely consumed the inbox row. |
| Lead relay | The app wrote a relay prompt to lead stdin; the lead may or may not have acted correctly. |
| OpenCode member relay | The app observed enough response/progress proof to commit the inbox row read. |
| Permission/noise filtering | The app decided the row should not be relayed as actionable work. |
| Sent messages | The row is an already-visible outgoing record. |

TOAD should split this into explicit states:

- `message.created`
- `delivery_attempt.started`
- `delivery_attempt.accepted_by_runtime`
- `delivery_attempt.response_observed`
- `delivery_attempt.committed`
- `delivery_attempt.failed_retryable`
- `delivery_attempt.failed_terminal`
- `message.read_by_recipient`
- `message.dismissed_as_noise`
- `message.superseded_or_duplicate`

### Duplicate prevention layers observed

The project prevents duplicates with many overlapping mechanisms:

- `messageId` and generated legacy IDs.
- `idempotencyKey` and payload hash in runtime delivery journals.
- Destination verification before and after writes.
- In-memory `relayedLeadInboxMessageIds` and `relayedMemberInboxMessageIds`.
- Same-team native delivery fingerprints and grace windows.
- Cross-team outbox dedupe and cascade guard.
- OpenCode prompt ledger record IDs derived from team/member/lane/message.
- Visible reply correlation through `relayOfMessageId`.

TOAD should collapse these into fewer durable mechanisms:

- Unique `message_id`.
- Unique `idempotency_key` for each mutating command.
- Payload hash conflict detection for reused idempotency keys.
- Unique delivery attempt IDs with destination and runtime IDs.
- Durable correlation IDs for replies and task events.
- Durable dedupe/proof records rather than in-memory relay sets.

### What fails when agents reply in plain text

Plain assistant text is ambiguous:

- It may be a user-visible answer, an internal note, or an incomplete partial stream.
- It may not identify the recipient.
- It may not reference the inbound message ID.
- It may be suppressed, stripped, duplicated, or lost during relay capture.
- It cannot reliably update task state, read state, or review state.

The upstream project compensates by capturing lead text during relay, stripping agent-only blocks, looking for OpenCode visible replies, checking `relayOfMessageId`, and applying semantic filters for ack-only replies. This is necessary for compatibility, but it is not a good core contract.

TOAD rule:

- Tool calls and normalized runtime events create durable state.
- Plain text is a stream artifact unless wrapped in a structured reply event by the runtime adapter.
- Agents should be prompted to use `message_send`, `task_comment`, `task_update`, or `review_decide` for durable work.

### Approaches considered for TOAD

Recommended approach: SQLite broker as the source of truth, with runtime-specific delivery workers.

- Pros: strongest correctness, simpler retries, clean UI projections, runtime-agnostic core.
- Cons: requires adapter work before fully replacing legacy inbox behavior.

Alternative: keep JSON inboxes but add stronger file locking and retries.

- Pros: fastest compatibility with Claude Code's existing team behavior.
- Cons: still exposed to whole-file rewrite races, schema drift, and watcher-dependent correctness.

Alternative: runtime-native delivery only, no inbox/read model.

- Pros: lower storage complexity and more live behavior.
- Cons: weak crash recovery, poor auditability, and inconsistent behavior across CLIs.

Decision: use SQLite/event storage as canonical, then expose compatibility inbox projections only where a specific runtime needs them.

TOAD broker direction:

- One durable message table/event stream for all messages.
- One delivery-attempt table for every runtime write.
- Receiver read/ack state separate from immutable message content.
- Direct addressing for same-team, cross-team, lead, worker, user, and system recipients.
- Inbox views are projections, not source files.
- Watchers/subscribers trigger projection refresh and retry workers, not core correctness.
- Runtime adapters expose delivery modes and normalized response/progress events.
- Delivery workers decide where to send a message, not UI handlers or file watchers.
- Idempotency and payload hash conflict detection happen before side effects.
- Delivery attempts are only committed after destination verification or runtime receipt proof.

### TOAD message broker design

Minimum tables/events already reflected in `toad-local`:

- `messages`: immutable content, sender, recipient, conversation, reply-to, metadata.
- `message_task_refs`: normalized task references.
- `message_reads`: recipient/read state.
- `delivery_attempts`: runtime/destination/status/receipt/error.

Needed next:

- `delivery_attempts.idempotency_key` or a separate delivery idempotency table.
- `delivery_attempts.payload_hash` to reject key reuse with different payload.
- `delivery_attempts.response_state` for accepted/responded/pending distinctions.
- `runtime_instances` for current run/session/lane identity.
- `agent_delivery_modes` so the worker can choose `runtime_stdin`, `runtime_bridge`, `pollable_inbox`, or `offline_queue`.
- `message_events` or audit rows for dismissed/noise/superseded states.

Recommended delivery worker contract:

```text
deliverPending({ teamId, recipient })
  -> load unread/undelivered broker messages
  -> resolve recipient runtime instance and delivery mode
  -> beginDeliveryAttempt(messageId, runtimeId, destination, idempotencyKey, payloadHash)
  -> if duplicate committed, return existing receipt
  -> call adapter/send projection writer
  -> verify runtime/destination acceptance
  -> commit or fail attempt
  -> optionally mark read only when recipient/runtime proof is sufficient
```

For a live lead:

```text
message(user/team/system -> lead)
  -> runtime_stdin attempt
  -> adapter writes stream-json user turn
  -> commit accepted_by_runtime when stdin write succeeds
  -> wait for structured reply/tool events separately
```

For a pollable worker:

```text
message(lead/user/system -> worker)
  -> broker append is enough for durable queue
  -> optional inbox projection for compatibility
  -> mark delivered_to_queue, not read
  -> worker tool call or adapter event marks read/handled
```

For an OpenCode-style worker:

```text
message(lead/user/system -> worker)
  -> runtime_bridge attempt
  -> adapter sends message to lane/session
  -> observe response/progress proof
  -> commit read only when proof is sufficient
```

### Stage 5 conclusion

The durable idea worth keeping is not "write JSON inbox files." It is "every agent has an addressable durable inbox and all coordination happens through explicit command/event records." The upstream system proves this pattern works, but its correctness is spread across mutable files, runtime-specific relay prompts, watchers, and large service methods. TOAD should put the broker in the middle, make delivery attempts first-class, and treat runtime adapters as replaceable transports.

## Stage 6 - Task And Work Coordination

Status: first pass complete.

Purpose:

- Understand how tasks are created, assigned, updated, commented, reviewed, and linked to logs/code changes.

Questions to answer:

- Which task fields are required?
- How does ownership work?
- How do task comments notify agents?
- How do task logs map back to tasks?
- How are reviews requested and applied?

Important files:

- `agent-teams-controller/src/internal/tasks.js`
- `agent-teams-controller/src/internal/taskStore.js`
- `src/main/services/team/TeamTaskReader.ts`
- `src/main/services/team/TeamTaskWriter.ts`
- `src/main/services/team/taskLogs/*`
- `src/main/services/team/ReviewApplierService.ts`

Deliverable:

- A TOAD task-board model and task/event workflow.

Current task workflow:

```text
task_create(owner)
  -> board lock
  -> write ~/.claude/tasks/{team}/{taskId}.json
  -> update dependency/related task files
  -> maybeNotifyAssignedOwner()
  -> message_send(system_notification) to owner inbox
```

```text
task_set_owner(owner)
  -> board lock
  -> update task owner
  -> if owner changed, send assignment notification to owner inbox
```

```text
task_add_comment(from, text)
  -> board lock
  -> append comment to task file
  -> if inserted and commenter is not owner, send comment notification to owner inbox
```

```text
task_complete()
  -> set status completed
  -> inspect tasks blocked by this task
  -> add stable system comments to newly unblocked tasks
  -> those comments can notify owners
```

Task persistence facts:

- One task is one JSON file under `~/.claude/tasks/{team}`.
- Task comments are embedded arrays inside the task file.
- Task status changes append `historyEvents` inside the task file.
- Dependencies are duplicated: a task has `blockedBy`, and dependency tasks have `blocks`.
- Assignment and comment notifications are not just UI behavior; they write inbox messages.
- `withTeamBoardLock()` protects board operations inside the controller, but message notification writes happen through the message layer afterward.

TOAD task model direction:

- Use immutable task events: `task.created`, `task.assigned`, `task.status_changed`, `task.comment_added`, `task.linked`, `task.unlinked`, `task.review_requested`, `task.review_decided`.
- Build task records, comments, dependencies, and board columns as projections.
- Emit notification events from task events in a notification worker.
- Deliver notifications through the broker with stable idempotency keys.
- Keep "task comment is the durable deliverable" as a product rule, but enforce it structurally where possible instead of prompt-only instructions.

## Stage 7 - Bug And Failure Inventory

Status: first pass complete.

Purpose:

- Identify what makes this system brittle and prioritize what our design must avoid.

Initial suspects:

- Whole JSON-array rewrites for inboxes and tasks.
- Runtime-specific behavior in the central service.
- Lead relay complexity.
- Tool-call compliance failures.
- Recursive `fs.watch` fragility, especially on Windows.
- UI notification state inferred from message counts.
- Large service classes with many coupled responsibilities.

Deliverable:

- Bug/failure inventory with severity, reproduction path where possible, and replacement strategy.

First bug/design inventory:

| Risk | Severity | Evidence | TOAD replacement |
|---|---:|---|---|
| Lost inbox updates from whole-array rewrites | high | controller `messageStore.appendRow()` reads array, pushes, rewrites; app `TeamInboxWriter` adds locks/verification but controller writes are separate | SQLite append-only message/event writes with unique idempotency keys |
| Watcher side effects become correctness paths | high | file watcher fanout calls relay/reconcile/notifications/backups from file changes | explicit broker events and background jobs; watcher only for external import/projection refresh |
| Lead delivery depends on prompt compliance | high | lead inbox relay asks lead to process messages and use MCP tools correctly | broker routes messages directly; lead tool calls create events; text is secondary |
| Runtime service owns too many concerns | high | `TeamProvisioningService.ts` handles launch, parsing, relay, approvals, compaction, OpenCode bridge, UI events, recovery | split runtime adapters, broker, approval broker, supervisor, projection service |
| Plain-text replies are ambiguous | medium | lead relay captures assistant text with timeout/idle heuristics and strips agent blocks | require structured reply events for durable messages; keep text stream as diagnostics |
| Cross-team messaging is lead-inbox based | medium | cross-team controller writes into target lead inbox and then relies on lead relay | broker-level team addressing with conversation IDs and delivery receipts |
| Permission approval path is split | medium | lead uses stream-json `control_request`; teammates send parsed permission messages through inbox | one approval broker API, adapter-specific input parsers |
| Kanban/review projection can drift | medium | task files and `kanban-state.json` both hold workflow state | derive board/review view from task/workflow events |

Review/kanban-specific drift:

```text
review_request()
  -> set kanban column review
  -> append task history event review_requested
  -> set task.reviewState = review
  -> send system_notification to reviewer inbox
```

```text
review_approve()
  -> set kanban column approved
  -> append task history event review_approved
  -> set task.reviewState = approved
  -> add review comment
  -> optionally notify owner inbox
```

```text
review_request_changes()
  -> append task history event review_changes_requested
  -> set task.reviewState = needsFix
  -> clear kanban entry
  -> set task status pending
  -> add review comment
  -> notify owner inbox
```

The project has a helper that derives effective review state from task history first, then falls back to `task.reviewState`, then falls back to kanban entry. That is a clue that drift was observed or expected. TOAD should store one review event stream and derive board columns from it.

## Stage 8 - TOAD Architecture Proposal

Status: draft started, local scaffold created.

Purpose:

- Convert research into a buildable architecture.

Expected components:

- `toad-core`
- `toad-broker`
- `toad-runtime-adapters`
- `toad-tools`
- `toad-ui`
- `toad-supervisor`

Expected storage:

- SQLite for durable state.
- Append-only event log semantics.
- Derived read models for UI.

Deliverable:

- Initial implementation blueprint and scaffold plan.

Draft staged build approach:

1. Protocol package
   - Define `AgentIdentity`, `MessageEnvelope`, `TaskEvent`, `DeliveryAttempt`, `RuntimeEvent`, `ApprovalRequest`, and tool command schemas.

2. Durable core
   - SQLite event store.
   - Message append/read/ack APIs.
   - Task append/projection APIs.
   - Idempotency and delivery receipt tables.

3. Runtime adapter shell
   - Start with one adapter for Claude-style stream-json.
   - Interface: `launch`, `stop`, `sendTurn`, `events`, `approve`, `health`.
   - Parse stdout into normalized runtime events.

4. Broker and worker loop
   - Route user/lead/worker/cross-team messages through core.
   - Deliver to live lead through adapter.
   - Deliver to workers through adapter or pollable inbox.
   - Retry failed delivery attempts with backoff.

5. MCP/tool server
   - Expose minimal commands: `message_send`, `task_create`, `task_update`, `task_comment`, `task_list`, `agent_status`, `runtime_events`, `approval_list`, `approval_respond`, `cross_team_messages`, `cross_team_send`.
   - Validate all sender identities against current runtime/session.

6. Supervisor
   - Own process lifecycle, restart policy, stale process cleanup, liveness, and stop semantics.

7. UI/read model
   - Project events into team chat, task board, process status, approvals, and audit log.

8. Compatibility/import tools
   - Optional importer for existing `~/.claude/teams` files so we can study/replay old runs without adopting their storage model.

Local scaffold:

- `toad-local/package.json`
- `toad-local/README.md`
- `toad-local/docs/ARCHITECTURE.md`
- `toad-local/src/approval/inMemoryApprovalBroker.js`
- `toad-local/src/approval/sqliteApprovalBroker.js`
- `toad-local/src/protocol/envelopes.js`
- `toad-local/src/app/LocalToadRuntime.js`
- `toad-local/src/broker/inMemoryBroker.js`
- `toad-local/src/mcp/localMcpServer.js`
- `toad-local/src/mcp/localToolDefinitions.js`
- `toad-local/src/mcp/stdioServer.js`
- `toad-local/src/broker/sqliteBroker.js`
- `toad-local/src/runtime/RuntimeAdapter.js`
- `toad-local/src/runtime/ClaudeStreamJsonAdapter.js`
- `toad-local/src/runtime/RuntimeSupervisor.js`
- `toad-local/src/runtime/RuntimeEventIngestor.js`
- `toad-local/src/runtime/RuntimeIdentityValidator.js`
- `toad-local/src/runtime/sqliteRuntimeRegistry.js`
- `toad-local/src/runtime/sqliteRuntimeEventLog.js`
- `toad-local/src/runtime/parsePermissionRequest.js`
- `toad-local/src/runtime/claudeSettingsWriter.js`
- `toad-local/src/runtime/CompactionHandler.js`
- `toad-local/src/runtime/RuntimeEventBus.js`
- `toad-local/src/commands/command-contract.js`
- `toad-local/src/delivery/runtimeDirectory.js`
- `toad-local/src/delivery/deliveryWorker.js`
- `toad-local/src/protocol/crossTeam.js`
- `toad-local/src/read/LocalReadModel.js`
- `toad-local/src/team/teamConfig.js`
- `toad-local/src/tools/localToolFacade.js`
- `toad-local/src/transport/apiServer.js`
- `toad-local/scripts/dev-api-server.mjs`
- `toad-local/src/storage/sqlite.js`
- `toad-local/src/storage/schema.sql`
- `toad-local/src/task/inMemoryTaskBoard.js`
- `toad-local/src/task/sqliteTaskBoard.js`
- `toad-local/ui/`
- `toad-local/test/broker.test.js`
- `toad-local/test/taskBoard.test.js`
- `toad-local/test/approvalBroker.test.js`
- `toad-local/test/sqliteApprovalBroker.test.js`
- `toad-local/test/sqliteBroker.test.js`
- `toad-local/test/sqliteTaskBoard.test.js`
- `toad-local/test/localToolFacade.test.js`
- `toad-local/test/localMcpToolDefinitions.test.js`
- `toad-local/test/localMcpServer.test.js`
- `toad-local/test/deliveryWorker.test.js`
- `toad-local/test/claudeStreamJsonAdapter.test.js`
- `toad-local/test/claudeCliSmoke.test.js`
- `toad-local/test/runtimeSupervisor.test.js`
- `toad-local/test/sqliteRuntimeRegistry.test.js`
- `toad-local/test/runtimeEventIngestor.test.js`
- `toad-local/test/sqliteRuntimeEventLog.test.js`
- `toad-local/test/localReadModel.test.js`
- `toad-local/test/localToadRuntime.test.js`
- `toad-local/test/parsePermissionRequest.test.js`
- `toad-local/test/claudeSettingsWriter.test.js`
- `toad-local/test/teammatePermission.test.js`
- `toad-local/test/compactionHandler.test.js`
- `toad-local/test/crossTeam.test.js`
- `toad-local/test/runtimeEventBus.test.js`
- `toad-local/test/teamConfig.test.js`
- `toad-local/test/apiServer.test.js`
- `toad-local/test/sideEffectLog.test.js`

Current verification:

```powershell
cd C:\Project-TOAD\toad-local
npm.cmd test
cd ui
npm.cmd run lint
npm.cmd run build
```

The tests cover message append, inbox projection, idempotent append, delivery attempt commit, broker message listing, broker delivery idempotency and payload-hash conflicts, SQLite broker persistence, task event projection, review-state projection, SQLite task event persistence, idempotent task events, in-memory and SQLite approval request/response state plus durable approval delivery receipts, the local command facade for `message_send`, `task_create`, `task_update`, `task_comment`, `review_request`, `review_decide`, `agent_status`, `runtime_events`, `approval_list`, `approval_respond`, `tool_activity`, `health_status`, `cross_team_messages`, and `cross_team_send`, MCP-shaped local tool definitions and call adaptation, a dependency-free local MCP request handler, and the broker runtime delivery worker. Broker runtime delivery worker tests cover runtime adapter delivery, pollable inbox queue commits, retryable adapter failures, and committed replay idempotency. Claude stream-json adapter tests cover stdin turn serialization, non-writable stdin failures, assistant/result event normalization, malformed stdout handling, tool-use normalization, `control_request` to approval-request normalization, approved/denied `control_response` serialization, compact-boundary metadata, API retry normalization, tool-result serialization, and delivery-worker integration. Runtime supervisor tests cover directory unregister/list behavior, process launch registration, adapter lookup, child exit projection, stop-time unregister, health reporting, bounded unexpected-exit restarts, and explicit-stop restart suppression. SQLite runtime registry tests cover durable runtime instance rows, delivery-mode mapping persistence, runtime-directory hydration, and stop-time mapping cleanup. Runtime event ingestion tests cover durable runtime event logging, event bus publication, idempotent event append, assistant text promotion to broker replies, approval-request persistence, audit-only runtime events, compaction lifecycle dispatch, async runtime event stream consumption, allowlisted tool dispatch through the local command facade, command idempotency keys, unsupported tool audit-only behavior, successful tool-result return after dispatch, error-result return when tool execution throws, runtime identity mismatch rejection, and stopped-runtime tool dispatch rejection. Local read-model tests cover team chat projection, task/process/audit/approval/tool-call/API-retry/cross-team projection, and team overview counts. Local orchestrator tests cover process launch plus adapter registration, delivered user-to-agent messages, runtime event ingestion into read-model projections, tool-created task visibility, approval-request visibility, approval-response delivery, and offline queue fallback after runtime stop. Additional tests cover teammate permission parsing/settings application, compaction reinjection, cross-team protocol and dual-write delivery, runtime event bus behavior, team config registry behavior, the HTTP/SSE API server (including SSE clients, `/api/call` routing, malformed JSON `400`, invalid envelope `400`, oversized body `413`, missing/wrong/correct Bearer token, OPTIONS preflight pass-through, `/events` token via `?token=` query string, origin-restricted CORS echo for allow-listed origins, ACAO omission for disallowed origins, default `localhost:5173`/`127.0.0.1:5173` allow-list, and `*` wildcard mode), the durable side-effect delivery log (`SideEffectLog` markPending/markDelivered/markFailed/get/getPending/pruneOlderThan plus integration tests for tool-result and compaction-reinjection receipt lifecycles), `LocalToadRuntime.replayPendingSideEffects()` (drops pending receipts on restart, leaves delivered/failed receipts untouched, no-ops when no SQLite handle is available), `LocalToadRuntime.pruneSideEffectLog()` (deletes terminal rows older than the retention window, accepts an explicit `olderThan` override, runs from `start()`), `LocalToadRuntime.start()`/`close()` lifecycle (port-0 binding, HTTP smoke against `/api/call`, SSE-client disconnect on shutdown verified via re-bind probe, and safe `close()` without prior `start()`), and restart housekeeping telemetry (`start()` emits `side_effects_dropped_on_restart` and `side_effects_pruned` `runtime_event`s when the corresponding pass did non-zero work, and stays silent on a clean log), live Claude CLI smoke (verified end-to-end against `claude-opus-4-7`; the harness intentionally omits `--bare` so it works against subscription OAuth rather than requiring an API key), persistent storage configuration (data written through one `LocalToadRuntime` against a real `dbPath` survives into a second `LocalToadRuntime` against the same path; auto-creates parent directory; close-leak fix for the approval broker SQLite connection so `rmSync` cleanups work on Windows), broker/taskBoard durability swap (default broker is now `SqliteBroker` and default taskBoard is `SqliteTaskBoard`; messages and task events survive restart alongside approvals), VACUUM on retention (`vacuumDatabase()` runs `VACUUM` after a non-zero `pruneSideEffectLog()` and emits a `database_vacuumed` runtime event with freelistBefore/freelistAfter counts; freelist drops to 0 verified end-to-end on a real DB; `:memory:` and stub-injected setups skip with explicit reason codes), and API token on disk (`resolveApiToken({ explicit, projectCwd })` checks `explicit > env > <projectCwd>/.toad/api-token > null`; `npm run token:generate` writes a 256-bit hex token to disk and prints PowerShell/bash exports for the UI). The UI currently passes `npm.cmd run lint` and `npm.cmd run build`, including configurable API/SSE URLs through `VITE_TOAD_API_BASE_URL`, the approval-resolution panel, runtime detail drawer, and cross-team chat panel that call read-only projections through `/api/call`.

## Current System Map - First Pass

### Boot And Service Wiring

```text
Electron app ready
  -> initializeServices()
    -> create ServiceContextRegistry / local ServiceContext
    -> create TeamDataService
    -> create TeamProvisioningService
    -> set runtime adapter registry
    -> create CrossTeamService
    -> connect CrossTeamService to TeamProvisioningService
    -> create TeamTaskStallMonitor / log trackers / review services / backup
    -> set teamChangeEmitter
    -> initialize IPC handlers
  -> createWindow()
  -> renderer did-finish-load
    -> start FileWatcher
    -> warmup TeamProvisioningService
    -> start TeamDataService process health polling
```

Key evidence:

- `src/main/index.ts` constructs `TeamDataService` and `TeamProvisioningService`.
- `src/main/index.ts` creates `CrossTeamService` and injects it into provisioning.
- `src/main/ipc/handlers.ts` registers `teams.ts` and all other domain IPC modules.

### File Watcher Fanout

```text
FileWatcher emits team-change
  -> renderer TEAM_CHANGE event
  -> HTTP SSE team-change
  -> TeamDataService.invalidateMessageFeed()
  -> reconcileTeamArtifacts()
  -> relayInboxFileToLiveRecipient()
  -> desktop notifications
  -> task start/comment notification checks
  -> backup scheduling
```

This means a single file write can trigger many side effects. That is useful for UI freshness but dangerous for correctness if relay/reconcile actions are not idempotent.

### IPC Boundary

`initializeIpcHandlers()` receives service instances and registers domain handlers. This keeps renderer access behind IPC, but the `teams.ts` handler is very large and contains meaningful orchestration logic instead of only validation/routing.

### First Design Judgment

For TOAD, we should make file watching or event subscription a projection mechanism only. Durable writes should directly enqueue explicit events for relay/reconcile/notification work. That prevents watcher timing from becoming part of correctness.

## Active Work Queue

1. Recommended next product slice: subscription quota / plan-usage indicator (PARKED — user is independently investigating a reliable data source). After that, candidates are VACUUM-on-retention (now meaningful since `dbPath` is a real file), token-on-disk for `TOAD_API_TOKEN` ergonomics, in-memory broker/taskBoard durability swap, and Codex provider integration as a much larger scoped slice.
2. Live Claude CLI smoke is verified end-to-end: `npm.cmd run smoke:claude` with `TOAD_CLAUDE_SMOKE=1` produces an `assistant_text: "TOAD-SMOKE"` against `claude-opus-4-7` and a `result.success` summary in ~15 s. Do NOT reintroduce `--bare` to the harness without first confirming an Anthropic API key — `--bare` rejects the subscription OAuth that the operator's machine uses. Run sparingly: each invocation consumes ~334k cache-creation tokens against the user's plan quota (the CLI reports an API-equivalent dollar figure that does not bill subscription users).
3. Dashboard now surfaces housekeeping events: a "System Housekeeping" panel between the top stats and Pending Approvals shows the most recent `side_effects_dropped_on_restart` and `side_effects_pruned` counts plus relative timestamps. Pure UI consumer over the existing SSE stream — no backend changes.
4. Persistence is now real and complete across all five SQLite-backed storage surfaces: `LocalToadRuntime` accepts a `dbPath` constructor option (default `:memory:` so tests stay clean), and `scripts/dev-api-server.mjs` defaults to `<projectCwd>/.toad/toad.db` (override with `TOAD_DB_PATH`). The directory is auto-created. The five durable stores — broker (messages), taskBoard (tasks), approvalBroker, runtimeRegistry, eventLog — all open against the shared `dbPath` by default. Across an `npm run api:dev` restart, prior messages, tasks, approvals, runtime audit, and side-effect receipts are visible to the next process. A close-leak in the approval broker was uncovered and fixed during the prior persistence slice.
3. Loopback HTTP bridge hardening is layered: bearer token resolution `explicit > TOAD_API_TOKEN env > <projectCwd>/.toad/api-token > null` with `crypto.timingSafeEqual` comparison and a `npm run token:generate` rotation command, origin-restricted CORS (`TOAD_API_ALLOWED_ORIGINS`, default `http://localhost:5173,http://127.0.0.1:5173`, `*` reproduces the legacy wildcard), and lifecycle test coverage with a real bug fix in `apiServer.stop()` so SSE clients no longer prevent clean shutdown. The server still binds to `127.0.0.1` only.
4. Side-effect delivery receipts cover `tool_result` and `compaction_reinjection` end-to-end: pending → delivered/failed write paths are wired through `RuntimeEventIngestor` and `CompactionHandler`. `LocalToadRuntime.start()` now does two housekeeping passes — `replayPendingSideEffects()` drops orphaned `'pending'` rows, and `pruneSideEffectLog()` deletes terminal rows older than the retention window (default 7 days, env `TOAD_SIDE_EFFECT_RETENTION_DAYS`).
5. Restart housekeeping telemetry now flows on the SSE bus: `side_effects_dropped_on_restart`, `side_effects_pruned`, and `database_vacuumed` events are emitted from `LocalToadRuntime.start()` whenever the corresponding pass did non-zero work. The dashboard's System Housekeeping panel consumes all three.
6. Smaller follow-ups: an optional `--bare` smoke path for users on API-key auth, and an `agent_launch` MCP tool + dashboard form to close the gap between observing runtimes and creating them from the UI.
