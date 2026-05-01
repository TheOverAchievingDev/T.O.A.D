# Runtime Identity Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent runtime-originated events from appending messages or executing tools unless the event identity matches the registered runtime identity.

**Architecture:** Add a small `RuntimeIdentityValidator` that checks `runtimeId`, `teamId`, `agentId`, and running status against the runtime registry when one is available. `RuntimeEventIngestor` calls the validator before writing assistant messages or dispatching tool calls, while audit-only events still get logged for forensics.

**Tech Stack:** Node.js ESM, `node:test`, existing runtime registry and event ingestor modules.

---

### Task 1: Runtime Identity Validator

**Files:**
- Create: `src/runtime/RuntimeIdentityValidator.js`
- Modify: `src/runtime/RuntimeEventIngestor.js`
- Modify: `test/runtimeEventIngestor.test.js`

- [x] **Step 1: Write failing tests**

Add tests proving that:

```js
test('RuntimeEventIngestor rejects assistant messages from mismatched runtime identity', async () => {
  const broker = new InMemoryBroker();
  const eventLog = new InMemoryRuntimeEventLog();
  const runtimeRegistry = {
    getRuntime(runtimeId) {
      assert.equal(runtimeId, 'runtime-lead-1');
      return {
        runtimeId,
        teamId: 'team-a',
        agentId: 'lead',
        status: 'running',
      };
    },
  };
  const ingestor = new RuntimeEventIngestor({ broker, eventLog, runtimeRegistry });

  await assert.rejects(
    () =>
      ingestor.ingest({
        type: 'assistant_text',
        runtimeId: 'runtime-lead-1',
        teamId: 'team-a',
        agentId: 'impostor',
        text: 'spoofed',
      }),
    /runtime identity mismatch/
  );
  assert.equal(broker.listMessages({ teamId: 'team-a' }).length, 0);
  assert.equal(eventLog.events.length, 1);
});

test('RuntimeEventIngestor rejects tool dispatch from stopped runtimes', async () => {
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const toolFacade = new LocalToolFacade({ broker, taskBoard });
  const runtimeRegistry = {
    getRuntime() {
      return {
        runtimeId: 'runtime-lead-1',
        teamId: 'team-a',
        agentId: 'lead',
        status: 'stopped',
      };
    },
  };
  const ingestor = new RuntimeEventIngestor({ broker, toolFacade, runtimeRegistry });

  await assert.rejects(
    () =>
      ingestor.ingest({
        type: 'tool_use',
        runtimeId: 'runtime-lead-1',
        teamId: 'team-a',
        agentId: 'lead',
        toolUseId: 'tool-1',
        toolName: 'task_create',
        input: { taskId: 'task-1', subject: 'Do not create' },
      }),
    /runtime is not running/
  );
  assert.equal(taskBoard.listTasks({ teamId: 'team-a' }).length, 0);
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `node test/runtimeEventIngestor.test.js`

Expected: FAIL because `RuntimeEventIngestor` does not accept `runtimeRegistry` and does not validate event identity.

- [x] **Step 3: Implement validator and integration**

Create `RuntimeIdentityValidator` with `assertCanWrite(event)` and integrate it into `RuntimeEventIngestor`. The validator should be a no-op when no registry is provided, preserve existing tests, and reject mismatched or non-running registered runtimes.

- [x] **Step 4: Run targeted tests**

Run: `node test/runtimeEventIngestor.test.js`

Expected: PASS.

- [x] **Step 5: Run full regression suite**

Run: `npm.cmd test`

Expected: PASS.
