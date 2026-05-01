# TOAD Architecture Draft

## Components

- `protocol`: message, task, runtime, delivery, approval, and command envelopes.
- `broker`: durable message and delivery journal APIs.
- `task-board`: task event stream and projections.
- `runtime-adapters`: one adapter per CLI runtime.
- `supervisor`: process lifecycle, restart policy, stale process cleanup, and liveness.
- `tools`: MCP or CLI command facade over the broker/task/runtime APIs.
- `read-model`: chat, inbox, board, approval, process, and audit projections.

## First Runtime Contract

```text
launch(input) -> launch result
stop(input) -> stop result
sendTurn(envelope) -> delivery receipt
events() -> async runtime event stream
approve(decision) -> approval answer
health(input) -> health report
```

The adapter translates between TOAD envelopes and a concrete CLI runtime. It does not own message state, task state, retries, or UI projection.

## First Broker Contract

```text
appendMessage(envelope, idempotencyKey)
listInbox(teamId, recipient)
markRead(messageId, reader)
beginDeliveryAttempt(messageId, runtimeId, destination)
commitDeliveryAttempt(attemptId, receipt)
failDeliveryAttempt(attemptId, error, retryable)
```

The broker is responsible for identity checks, idempotency, delivery journaling, and durable receipt state.

