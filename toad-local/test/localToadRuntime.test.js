import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  await runtime.ingestRuntimeEvent({
    type: 'approval_request',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    sessionId: 'session-1',
    approvalId: 'approval-1',
    prompt: 'Approve Write',
    toolName: 'Write',
    input: {
      file_path: 'README.md',
    },
  });

  const overview = runtime.getTeamOverview({ teamId: 'team-a' });

  assert.equal(overview.counts.messages, 1);
  assert.equal(overview.counts.tasks, 1);
  assert.equal(overview.recentMessages[0].text, 'I created a task.');
  assert.equal(overview.tasks[0].subject, 'Draft implementation plan');
  assert.equal(overview.counts.runtimeEvents, 3);
  assert.equal(overview.counts.approvals, 1);
  assert.equal(overview.counts.pendingApprovals, 1);
  assert.equal(overview.pendingApprovals[0].approvalId, 'approval-1');
});

test('LocalToadRuntime auto-consumes adapter events on launch (no manual ingestRuntimeEvent needed)', async () => {
  // Reproduces the Level-2 wiring bug. The adapter emits stream-json events;
  // the runtime should pull them through eventIngestor.ingestFrom without the
  // caller having to wire it up.
  const child = createFakeChild();
  let resolveEmit;
  const emitted = new Promise((r) => { resolveEmit = r; });

  // A controllable async-iterable adapter. After launch, we push one event
  // through the queue and assert the runtime persisted it.
  const events = [];
  let push;
  let pushDone = false;
  const queue = [];
  const adapter = {
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    providerId: 'claude',
    async sendTurn() { return { accepted: true, responseState: 'accepted_by_runtime' }; },
    async stop() {},
    events() {
      return (async function* () {
        // simple buffered async iterator backed by the queue
        while (true) {
          if (queue.length > 0) {
            yield queue.shift();
          } else if (pushDone) {
            return;
          } else {
            await new Promise((r) => { push = r; });
          }
        }
      })();
    },
    push(ev) {
      queue.push(ev);
      if (push) { push(); push = null; }
    },
    end() {
      pushDone = true;
      if (push) { push(); push = null; }
    },
  };

  const runtime = new LocalToadRuntime({
    spawnProcess() { return child; },
    createAdapter() { return adapter; },
  });

  await runtime.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
  });

  // Push an event AFTER launch — it should flow through ingestFrom and land
  // in eventLog without manual intervention.
  adapter.push({
    type: 'assistant_text',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    text: 'Auto-consumed!',
  });

  // Give the consumer loop a tick to process
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 10));
    if (runtime.eventLog.listEvents({ runtimeId: 'runtime-lead-1' }).length >= 1) break;
  }

  const persisted = runtime.eventLog.listEvents({ runtimeId: 'runtime-lead-1' });
  assert.equal(persisted.length, 1, 'auto-consumer should have persisted the event');
  assert.equal(persisted[0].eventType, 'assistant_text');
  assert.equal(persisted[0].payload.text, 'Auto-consumed!');

  // Cleanup
  adapter.end();
  await runtime.stopAgent('runtime-lead-1');
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

test('LocalToadRuntime.replayPendingSideEffects marks pending receipts failed', () => {
  const runtime = new LocalToadRuntime();
  assert.ok(runtime.sideEffectLog, 'expected sideEffectLog to be wired from default SQLite registry');

  runtime.sideEffectLog.markPending({
    deliveryId: 'del-tool-1',
    idempotencyKey: 'tool-result:abc',
    kind: 'tool_result',
    runtimeId: 'runtime-lead-1',
  });
  runtime.sideEffectLog.markPending({
    deliveryId: 'del-compact-1',
    idempotencyKey: 'compaction-reinjection:runtime-lead-1:session-1',
    kind: 'compaction_reinjection',
    runtimeId: 'runtime-lead-1',
  });

  const result = runtime.replayPendingSideEffects();

  assert.equal(result.dropped, 2);
  assert.equal(runtime.sideEffectLog.get('tool-result:abc').status, 'failed');
  assert.equal(
    runtime.sideEffectLog.get('compaction-reinjection:runtime-lead-1:session-1').status,
    'failed'
  );
});

test('LocalToadRuntime.replayPendingSideEffects does not affect already-delivered receipts', () => {
  const runtime = new LocalToadRuntime();

  runtime.sideEffectLog.markPending({
    deliveryId: 'del-1',
    idempotencyKey: 'tool-result:done',
    kind: 'tool_result',
    runtimeId: 'runtime-lead-1',
  });
  runtime.sideEffectLog.markDelivered('tool-result:done');
  runtime.sideEffectLog.markPending({
    deliveryId: 'del-2',
    idempotencyKey: 'tool-result:still-pending',
    kind: 'tool_result',
    runtimeId: 'runtime-lead-1',
  });

  const result = runtime.replayPendingSideEffects();

  assert.equal(result.dropped, 1, 'only the still-pending record should be dropped');
  assert.equal(runtime.sideEffectLog.get('tool-result:done').status, 'delivered');
  assert.equal(runtime.sideEffectLog.get('tool-result:still-pending').status, 'failed');
});

test('LocalToadRuntime.replayPendingSideEffects is a no-op when sideEffectLog is null', () => {
  const stubRegistry = {
    getRuntime: () => null,
    listRuntimes: () => [],
    upsertRuntime: () => {},
    setRuntimeStatus: () => {},
    setDeliveryMode: () => {},
    getDeliveryMode: () => null,
    getRuntimeByAgent: () => null,
    close: () => {},
  };
  const stubEventLog = {
    appendEvent: () => ({ inserted: false, event: null }),
    listEvents: () => [],
    listEventsByRuntime: () => [],
    close: () => {},
  };
  const runtime = new LocalToadRuntime({
    runtimeRegistry: stubRegistry,
    eventLog: stubEventLog,
  });
  assert.equal(runtime.sideEffectLog, null, 'sideEffectLog should be null when no SQLite handle is available');

  const result = runtime.replayPendingSideEffects();

  assert.deepEqual(result, { dropped: 0 });
});

test('LocalToadRuntime.pruneSideEffectLog deletes terminal rows older than the retention window', () => {
  const runtime = new LocalToadRuntime({ sideEffectRetentionDays: 7 });
  runtime.sideEffectLog.markPending({
    deliveryId: 'd-old',
    idempotencyKey: 'tool-result:old',
    kind: 'tool_result',
    runtimeId: 'r1',
  });
  runtime.sideEffectLog.markDelivered('tool-result:old');
  // Move it to 30 days in the past
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  runtime.runtimeRegistry.db
    .prepare(`UPDATE side_effect_deliveries SET delivered_at = ? WHERE idempotency_key = 'tool-result:old'`)
    .run(longAgo);

  runtime.sideEffectLog.markPending({
    deliveryId: 'd-recent',
    idempotencyKey: 'tool-result:recent',
    kind: 'tool_result',
    runtimeId: 'r1',
  });
  runtime.sideEffectLog.markDelivered('tool-result:recent');

  const result = runtime.pruneSideEffectLog();
  assert.equal(result.deleted, 1);
  assert.equal(runtime.sideEffectLog.get('tool-result:old'), null);
  assert.ok(runtime.sideEffectLog.get('tool-result:recent'));
});

test('LocalToadRuntime.pruneSideEffectLog accepts an explicit olderThan override', () => {
  const runtime = new LocalToadRuntime({ sideEffectRetentionDays: 365 });
  runtime.sideEffectLog.markPending({
    deliveryId: 'd1',
    idempotencyKey: 'tr:1',
    kind: 'tool_result',
    runtimeId: 'r1',
  });
  runtime.sideEffectLog.markDelivered('tr:1');

  // The default (365 days) would not match this row, but an explicit cutoff in the future does.
  const result = runtime.pruneSideEffectLog({ olderThan: new Date(Date.now() + 60_000) });
  assert.equal(result.deleted, 1);
});

test('LocalToadRuntime.pruneSideEffectLog is a no-op when sideEffectLog is null', () => {
  const stubRegistry = {
    getRuntime: () => null,
    listRuntimes: () => [],
    upsertRuntime: () => {},
    setRuntimeStatus: () => {},
    setDeliveryMode: () => {},
    getDeliveryMode: () => null,
    getRuntimeByAgent: () => null,
    close: () => {},
  };
  const stubEventLog = {
    appendEvent: () => ({ inserted: false, event: null }),
    listEvents: () => [],
    listEventsByRuntime: () => [],
    close: () => {},
  };
  const runtime = new LocalToadRuntime({ runtimeRegistry: stubRegistry, eventLog: stubEventLog });
  assert.deepEqual(runtime.pruneSideEffectLog(), { deleted: 0 });
});

test('LocalToadRuntime.replayPendingSideEffects is idempotent on a clean log', () => {
  const runtime = new LocalToadRuntime();

  const first = runtime.replayPendingSideEffects();
  const second = runtime.replayPendingSideEffects();

  assert.deepEqual(first, { dropped: 0 });
  assert.deepEqual(second, { dropped: 0 });
});

test('LocalToadRuntime.start() emits side_effects_dropped_on_restart when pending rows existed', async () => {
  const runtime = new LocalToadRuntime({ port: 0 });
  runtime.sideEffectLog.markPending({
    deliveryId: 'd1',
    idempotencyKey: 'tool-result:tel-drop',
    kind: 'tool_result',
    runtimeId: 'r1',
  });

  const seen = [];
  const unsubscribe = runtime.eventBus.subscribe('runtime_event', (event) => seen.push(event));

  try {
    await runtime.start();
    const dropEvents = seen.filter((e) => e.type === 'side_effects_dropped_on_restart');
    assert.equal(dropEvents.length, 1);
    assert.equal(dropEvents[0].count, 1);
    assert.match(dropEvents[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    unsubscribe();
    await runtime.close();
  }
});

test('LocalToadRuntime.start() emits side_effects_pruned when terminal rows were deleted', async () => {
  const runtime = new LocalToadRuntime({ port: 0, sideEffectRetentionDays: 7 });
  runtime.sideEffectLog.markPending({
    deliveryId: 'd-old',
    idempotencyKey: 'tool-result:tel-prune',
    kind: 'tool_result',
    runtimeId: 'r1',
  });
  runtime.sideEffectLog.markDelivered('tool-result:tel-prune');
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  runtime.runtimeRegistry.db
    .prepare(`UPDATE side_effect_deliveries SET delivered_at = ? WHERE idempotency_key = 'tool-result:tel-prune'`)
    .run(longAgo);

  const seen = [];
  const unsubscribe = runtime.eventBus.subscribe('runtime_event', (event) => seen.push(event));

  try {
    await runtime.start();
    const pruneEvents = seen.filter((e) => e.type === 'side_effects_pruned');
    assert.equal(pruneEvents.length, 1);
    assert.equal(pruneEvents[0].count, 1);
    assert.match(pruneEvents[0].createdAt, /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    unsubscribe();
    await runtime.close();
  }
});

test('LocalToadRuntime.start() emits no housekeeping events on a clean log', async () => {
  const runtime = new LocalToadRuntime({ port: 0 });
  const seen = [];
  const unsubscribe = runtime.eventBus.subscribe('runtime_event', (event) => seen.push(event));

  try {
    await runtime.start();
    const housekeeping = seen.filter(
      (e) => e.type === 'side_effects_dropped_on_restart' || e.type === 'side_effects_pruned'
    );
    assert.equal(housekeeping.length, 0);
  } finally {
    unsubscribe();
    await runtime.close();
  }
});

test('LocalToadRuntime.start() prunes terminal side-effect rows older than the retention window', async () => {
  const runtime = new LocalToadRuntime({ port: 0, sideEffectRetentionDays: 7 });
  runtime.sideEffectLog.markPending({
    deliveryId: 'd-old',
    idempotencyKey: 'tool-result:start-prune-old',
    kind: 'tool_result',
    runtimeId: 'r1',
  });
  runtime.sideEffectLog.markDelivered('tool-result:start-prune-old');
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  runtime.runtimeRegistry.db
    .prepare(`UPDATE side_effect_deliveries SET delivered_at = ? WHERE idempotency_key = 'tool-result:start-prune-old'`)
    .run(longAgo);

  await runtime.start();
  try {
    assert.equal(runtime.sideEffectLog.get('tool-result:start-prune-old'), null);
  } finally {
    await runtime.close();
  }
});

test('LocalToadRuntime.start() binds the API server and serves /api/call', async () => {
  const runtime = new LocalToadRuntime({ port: 0 });
  await runtime.start();
  try {
    const port = runtime.apiServer.getPort();
    assert.ok(port > 0, 'expected a bound port after start()');

    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        `http://127.0.0.1:${port}/api/call`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        resolve
      );
      req.on('error', reject);
      req.write(JSON.stringify({
        actor: { teamId: 'team-a', agentId: 'operator' },
        method: 'agent_status',
        args: { teamId: 'team-a' },
      }));
      req.end();
    });

    assert.equal(res.statusCode, 200);
    res.resume();
  } finally {
    await runtime.close();
  }
});

test('LocalToadRuntime.close() disconnects pending SSE clients and unbinds the port', async () => {
  const runtime = new LocalToadRuntime({ port: 0 });
  await runtime.start();
  const port = runtime.apiServer.getPort();

  // The IncomingMessage emits 'close' when the underlying TCP socket
  // is destroyed; that is a more reliable signal than 'end' since
  // closeAllConnections destroys without emitting a clean HTTP end.
  const sseRes = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/events`, resolve);
    req.on('error', reject);
  });
  assert.equal(sseRes.statusCode, 200);
  // Drain the stream so the 'close' event will fire when the server destroys
  // the underlying socket — without resume() the IncomingMessage stays paused.
  sseRes.resume();
  const sseClosed = new Promise((resolve) => sseRes.on('close', resolve));

  // Wait briefly for the client to register on the server side.
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(runtime.apiServer.getClientCount(), 1, 'SSE client should be registered');

  await runtime.close();
  await sseClosed;
  assert.equal(runtime.apiServer.getClientCount(), 0);

  // The port should be free after close — re-binding a fresh server to the
  // same port confirms it was released.
  const probe = http.createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => probe.close(resolve));
});

test('LocalToadRuntime.close() does not throw when start() was never called', async () => {
  const runtime = new LocalToadRuntime({ port: 0 });
  await runtime.close();
});

test('LocalToadRuntime.vacuumDatabase reduces freelist_count to 0 on a real DB', async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'toad-vacuum-'));
  const dbPath = join(tmpDir, 'toad.db');
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const runtime = new LocalToadRuntime({ port: 0, dbPath });
  // Seed enough rows that deletion produces freelist pages.
  for (let i = 0; i < 200; i++) {
    runtime.sideEffectLog.markPending({
      deliveryId: `d-${i}`,
      idempotencyKey: `tool-result:vacuum-${i}`,
      kind: 'tool_result',
      runtimeId: 'r1',
    });
    runtime.sideEffectLog.markDelivered(`tool-result:vacuum-${i}`);
  }
  // Delete them so pages move to the freelist.
  runtime.runtimeRegistry.db.exec(`DELETE FROM side_effect_deliveries`);

  const freelistBefore = runtime.runtimeRegistry.db
    .prepare('PRAGMA freelist_count')
    .get();
  assert.ok(freelistBefore.freelist_count > 0, 'freelist must contain pages after deletes');

  const result = runtime.vacuumDatabase();

  assert.equal(result.vacuumed, true);
  assert.equal(result.reason, 'success');
  const freelistAfter = runtime.runtimeRegistry.db
    .prepare('PRAGMA freelist_count')
    .get();
  assert.equal(freelistAfter.freelist_count, 0, 'VACUUM must release freelist pages');
  await runtime.close();
});

test('LocalToadRuntime.vacuumDatabase is a no-op when dbPath is :memory:', () => {
  const runtime = new LocalToadRuntime({ port: 0 });
  const result = runtime.vacuumDatabase();
  assert.equal(result.vacuumed, false);
  assert.equal(result.reason, 'in_memory');
});

test('LocalToadRuntime.start() emits database_vacuumed when prune did non-zero work', async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'toad-vac-emit-'));
  const dbPath = join(tmpDir, 'toad.db');
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const runtime = new LocalToadRuntime({ port: 0, dbPath, sideEffectRetentionDays: 7 });
  runtime.sideEffectLog.markPending({
    deliveryId: 'd1',
    idempotencyKey: 'tool-result:vac-emit',
    kind: 'tool_result',
    runtimeId: 'r1',
  });
  runtime.sideEffectLog.markDelivered('tool-result:vac-emit');
  const longAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  runtime.runtimeRegistry.db
    .prepare(`UPDATE side_effect_deliveries SET delivered_at = ? WHERE idempotency_key = 'tool-result:vac-emit'`)
    .run(longAgo);

  const seen = [];
  const unsubscribe = runtime.eventBus.subscribe('runtime_event', (event) => seen.push(event));
  try {
    await runtime.start();
    const vacuumEvents = seen.filter((event) => event.type === 'database_vacuumed');
    assert.equal(vacuumEvents.length, 1);
    assert.equal(vacuumEvents[0].deleted, 1);
  } finally {
    unsubscribe();
    await runtime.close();
  }
});

test('LocalToadRuntime persists messages and tasks across construction when dbPath is a real file', async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'toad-msg-task-'));
  const dbPath = join(tmpDir, 'toad.db');
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const runtimeA = new LocalToadRuntime({ port: 0, dbPath });
  runtimeA.broker.appendMessage({
    teamId: 'team-persist',
    idempotencyKey: 'persist-msg-1',
    from: { kind: 'user', id: 'operator' },
    to: { kind: 'agent', teamId: 'team-persist', agentId: 'lead' },
    text: 'Persisted message',
  });
  runtimeA.taskBoard.appendEvent({
    teamId: 'team-persist',
    taskId: 'task-persist-1',
    idempotencyKey: 'persist-task-1',
    eventType: 'task.created',
    actorId: 'lead',
    payload: { subject: 'Persisted task', status: 'in_progress' },
  });
  await runtimeA.close();

  const runtimeB = new LocalToadRuntime({ port: 0, dbPath });
  try {
    const messages = runtimeB.broker.listMessages({ teamId: 'team-persist' });
    assert.equal(messages.length, 1, 'message must survive into runtime B');
    assert.equal(messages[0].text, 'Persisted message');

    const tasks = runtimeB.taskBoard.listTasks({ teamId: 'team-persist' });
    assert.equal(tasks.length, 1, 'task must survive into runtime B');
    assert.equal(tasks[0].subject, 'Persisted task');
  } finally {
    await runtimeB.close();
  }
});

test('LocalToadRuntime persists data across construction when dbPath is a real file', async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'toad-persist-'));
  const dbPath = join(tmpDir, 'nested', 'toad.db');  // nested to also exercise auto-mkdir
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const runtimeA = new LocalToadRuntime({ port: 0, dbPath });
  runtimeA.approvalBroker.requestApproval({
    approvalId: 'persisted-approval-1',
    teamId: 'team-persist',
    runtimeId: 'runtime-persist-1',
    agentId: 'lead',
    prompt: 'Approve Write',
    metadata: { toolName: 'Write', input: { file_path: 'README.md' }, sessionId: 'sess-1' },
  });
  await runtimeA.close();

  const runtimeB = new LocalToadRuntime({ port: 0, dbPath });
  try {
    const approvals = runtimeB.approvalBroker.listApprovals({ teamId: 'team-persist' });
    assert.equal(approvals.length, 1, 'approval written by runtime A must survive into runtime B');
    assert.equal(approvals[0].approvalId, 'persisted-approval-1');
    assert.equal(approvals[0].prompt, 'Approve Write');
    assert.equal(approvals[0].status, 'pending');
  } finally {
    await runtimeB.close();
  }
});

test('LocalToadRuntime returns approval responses to a live Claude runtime adapter', async () => {
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
  await runtime.ingestRuntimeEvent({
    type: 'approval_request',
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    approvalId: 'approval-1',
    prompt: 'Approve Write',
    toolName: 'Write',
    input: { file_path: 'README.md' },
  });

  const result = runtime.toolFacade.execute({
    commandName: 'approval_respond',
    idempotencyKey: 'approval-response-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {
      approvalId: 'approval-1',
      decision: 'approved',
      reason: 'Looks safe.',
    },
  });

  assert.equal(result.status, 'approved');
  assert.equal(result.runtimeResponse.accepted, true);
  const payload = JSON.parse(child.stdin.writes[0]);
  assert.deepEqual(payload, {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'approval-1',
      response: { behavior: 'allow', updatedInput: {} },
    },
  });
});
