# Local Orchestrator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local runtime facade that composes broker, task board, runtime supervision, delivery, ingestion, tools, and read-model access behind one API.

**Architecture:** `LocalToadRuntime` owns a shared adapter map and wires each low-level component through constructor injection. It exposes narrow methods for launching agents, sending user/team messages, ingesting runtime events, reading team state, and closing local resources.

**Tech Stack:** Node.js ESM, `node:test`, in-memory components by default, existing runtime/delivery/read-model modules.

---

### Task 1: Local Runtime Facade Tests

**Files:**
- Create: `test/localToadRuntime.test.js`
- Create: `src/app/LocalToadRuntime.js`
- Modify: `package.json`

- [x] **Step 1: Write the failing tests**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';

function createFakeChild({ pid = 4242 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdin = {
    writable: true,
    destroyed: false,
    writes: [],
    write(line, callback) {
      this.writes.push(line);
      callback();
    },
  };
  child.stdout = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal = 'SIGTERM') => {
    child.killCalls.push(signal);
    child.emit('exit', 0, signal);
    return true;
  };
  return child;
}

test('LocalToadRuntime launches an agent and sends a delivered message through its adapter', async () => {
  const child = createFakeChild();
  const runtime = new LocalToadRuntime({
    spawnProcess() {
      return child;
    },
  });

  await runtime.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
  });

  const result = await runtime.sendMessage({
    teamId: 'team-a',
    from: { kind: 'user', id: 'operator' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'Plan the next task.',
  });

  assert.equal(result.message.text, 'Plan the next task.');
  assert.equal(result.delivery.status, 'committed');
  assert.equal(JSON.parse(child.stdin.writes[0]).message.content[0].text, 'Plan the next task.');
});

test('LocalToadRuntime ingests runtime events and exposes a team overview', async () => {
  const runtime = new LocalToadRuntime();

  await runtime.ingestRuntimeEvent({
    type: 'assistant_text',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    text: 'I created a task.',
  });
  await runtime.ingestRuntimeEvent({
    type: 'tool_use',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    toolUseId: 'tool-1',
    toolName: 'task_create',
    input: {
      taskId: 'task-1',
      subject: 'Draft implementation plan',
      description: 'Write the next local slice plan.',
    },
  });

  const overview = runtime.getTeamOverview({ teamId: 'team-a' });

  assert.equal(overview.counts.messages, 1);
  assert.equal(overview.counts.tasks, 1);
  assert.equal(overview.recentMessages[0].text, 'I created a task.');
  assert.equal(overview.tasks[0].subject, 'Draft implementation plan');
  assert.equal(overview.counts.runtimeEvents, 2);
});

test('LocalToadRuntime removes adapters when a runtime is stopped', async () => {
  const child = createFakeChild();
  const runtime = new LocalToadRuntime({
    spawnProcess() {
      return child;
    },
  });
  await runtime.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
  });

  await runtime.stopAgent('runtime-lead-1');
  const result = await runtime.sendMessage({
    teamId: 'team-a',
    from: { kind: 'user', id: 'operator' },
    to: { kind: 'agent', teamId: 'team-a', agentId: 'lead' },
    text: 'Are you still there?',
  });

  assert.equal(result.delivery.status, 'committed');
  assert.equal(result.delivery.responseState, 'queued_offline');
  assert.equal(child.stdin.writes.length, 0);
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `node test/localToadRuntime.test.js`

Expected: FAIL with `Cannot find module '../src/app/LocalToadRuntime.js'`.

- [x] **Step 3: Write minimal implementation**

Create `src/app/LocalToadRuntime.js` with a constructor that builds defaults for `InMemoryBroker`, `InMemoryTaskBoard`, `RuntimeDirectory`, `RuntimeSupervisor`, `DeliveryWorker`, `LocalToolFacade`, `RuntimeEventIngestor`, and `LocalReadModel`. Implement `launchAgent()`, `stopAgent()`, `sendMessage()`, `ingestRuntimeEvent()`, `getTeamOverview()`, and `close()`.

- [x] **Step 4: Run test to verify it passes**

Run: `node test/localToadRuntime.test.js`

Expected: PASS.

- [x] **Step 5: Run full regression suite**

Run: `npm.cmd test`

Expected: PASS.
