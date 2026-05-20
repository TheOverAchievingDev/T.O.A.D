import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RuntimeDirectory } from '../src/delivery/runtimeDirectory.js';
import { RuntimeSupervisor } from '../src/runtime/RuntimeSupervisor.js';

test('RuntimeDirectory unregisters agents and lists current registrations', () => {
  const directory = new RuntimeDirectory();
  directory.registerAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-1',
    deliveryMode: 'runtime_stdin',
    metadata: { role: 'lead' },
  });

  assert.deepEqual(directory.listAgents(), [
    {
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-1',
      deliveryMode: 'runtime_stdin',
      metadata: { role: 'lead' },
    },
  ]);

  const removed = directory.unregisterAgent({ teamId: 'team-a', agentId: 'lead' });

  assert.equal(removed, true);
  assert.equal(directory.listAgents().length, 0);
  assert.equal(
    directory.resolve({ kind: 'agent', teamId: 'team-a', agentId: 'lead' }).deliveryMode,
    'offline_queue'
  );
});

function createFakeChild({ pid = 1234 } = {}) {
  const child = new EventEmitter();
  child.pid = pid;
  child.killed = false;
  child.killCalls = [];
  child.kill = (signal = 'SIGTERM') => {
    child.killed = true;
    child.killCalls.push(signal);
    child.emit('exit', 0, signal);
    return true;
  };
  return child;
}

test('RuntimeSupervisor launches a process and registers its adapter destination', async () => {
  const directory = new RuntimeDirectory();
  const spawnCalls = [];
  const child = createFakeChild({ pid: 2468 });
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    spawnProcess(command, args, options) {
      spawnCalls.push({ command, args, options });
      return child;
    },
    createAdapter({ runtimeId, teamId, agentId, child: launchedChild }) {
      return {
        runtimeId,
        teamId,
        agentId,
        child: launchedChild,
        async sendTurn() {
          return { accepted: true, responseState: 'accepted_by_runtime' };
        },
      };
    },
  });

  const result = await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
    args: ['--output-format', 'stream-json'],
    cwd: 'C:\\Project-TOAD',
    env: { TOAD_TEAM_ID: 'team-a' },
    deliveryMode: 'runtime_stdin',
  });

  assert.equal(result.runtimeId, 'runtime-lead-1');
  assert.equal(result.status, 'running');
  assert.equal(result.pid, 2468);
  // On Windows the supervisor resolves bare command names against PATH +
  // PATHEXT so it can spawn `.cmd` shims directly without shell:true (a
  // requirement for keeping stdin/stdout pipes open for long-running
  // stream-json agents). Accept either the bare name (POSIX / unresolvable
  // on this CI host) or any path that ends in the bare name.
  const launchedCommand = spawnCalls[0].command;
  assert.ok(
    launchedCommand === 'claude'
      || /[\\/]claude(\.[a-z]+)?$/i.test(launchedCommand),
    `expected command to resolve to 'claude' (got ${launchedCommand})`,
  );
  assert.deepEqual(spawnCalls[0].args, ['--output-format', 'stream-json']);
  assert.equal(spawnCalls[0].options.cwd, 'C:\\Project-TOAD');
  assert.equal(spawnCalls[0].options.env.TOAD_TEAM_ID, 'team-a');
  assert.equal(
    directory.resolve({ kind: 'agent', teamId: 'team-a', agentId: 'lead' }).runtimeId,
    'runtime-lead-1'
  );
  assert.equal(supervisor.getAdapter('runtime-lead-1').child, child);
});

test('RuntimeSupervisor reports health and unregisters stopped runtimes', async () => {
  const directory = new RuntimeDirectory();
  const child = createFakeChild({ pid: 1357 });
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    spawnProcess() {
      return child;
    },
    createAdapter({ runtimeId }) {
      return { runtimeId };
    },
  });
  await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
  });

  assert.deepEqual(await supervisor.health('runtime-lead-1'), {
    runtimeId: 'runtime-lead-1',
    status: 'running',
    healthy: true,
    pid: 1357,
    exitCode: null,
    signal: null,
  });

  const stopped = await supervisor.stopAgent('runtime-lead-1', { signal: 'SIGTERM' });

  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(child.killCalls, ['SIGTERM']);
  assert.equal(
    directory.resolve({ kind: 'agent', teamId: 'team-a', agentId: 'lead' }).deliveryMode,
    'offline_queue'
  );
  assert.deepEqual(await supervisor.health('runtime-lead-1'), {
    runtimeId: 'runtime-lead-1',
    status: 'stopped',
    healthy: false,
    pid: 1357,
    exitCode: 0,
    signal: 'SIGTERM',
  });
});

test('RuntimeSupervisor marks child exit as exited without explicit stop', async () => {
  const directory = new RuntimeDirectory();
  const child = createFakeChild({ pid: 999 });
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    spawnProcess() {
      return child;
    },
    createAdapter({ runtimeId }) {
      return { runtimeId };
    },
  });
  await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
  });

  child.emit('exit', 7, null);

  assert.equal(supervisor.getRuntime('runtime-lead-1').status, 'exited');
  assert.equal(supervisor.getRuntime('runtime-lead-1').exitCode, 7);
  assert.equal(
    directory.resolve({ kind: 'agent', teamId: 'team-a', agentId: 'lead' }).deliveryMode,
    'offline_queue'
  );
});

test('RuntimeSupervisor.launchAgent allows re-launch with the same runtimeId after the previous process exits (Resume Team)', async () => {
  // Regression: when Claude hit a usage limit mid-session the child
  // exited, leaving the supervisor's in-memory record with status
  // 'exited'. The old guard "throw if #runtimes.has(runtimeId)"
  // rejected every Resume Team relaunch with "runtime already
  // launched" — team_launch caught the error and recorded the member
  // as failed, and the UI showed every agent as idle because no new
  // runtime ever registered. Re-launching the SAME runtimeId is
  // required so prior runtime_events and message history stay
  // attached to the agent.
  const directory = new RuntimeDirectory();
  const children = [];
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    spawnProcess() {
      const child = createFakeChild({ pid: 1000 + children.length });
      children.push(child);
      return child;
    },
    createAdapter({ runtimeId }) {
      return { runtimeId };
    },
  });
  await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
  });

  // Simulate Claude hitting a usage limit and the child dying.
  children[0].emit('exit', 1, null);
  assert.equal(supervisor.getRuntime('runtime-lead-1').status, 'exited');

  // Resume Team — relaunch with the same runtimeId. Must NOT throw.
  await assert.doesNotReject(
    supervisor.launchAgent({
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-lead-1',
      command: 'claude',
    }),
  );

  // The new record overwrites the old one — status is back to running,
  // pid reflects the second spawn.
  assert.equal(supervisor.getRuntime('runtime-lead-1').status, 'running');
  assert.equal(supervisor.getRuntime('runtime-lead-1').pid, 1001);
});

test('RuntimeSupervisor.launchAgent still rejects relaunch when the previous process is alive', async () => {
  // Inverse of the Resume regression: while a runtime is actually
  // alive, double-launching the same id is a real conflict and must
  // throw. Without this, the second launchAgent would silently drop
  // the first child and leak a process.
  const directory = new RuntimeDirectory();
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    spawnProcess() {
      return createFakeChild({ pid: 2000 });
    },
    createAdapter({ runtimeId }) {
      return { runtimeId };
    },
  });
  await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-conflict',
    command: 'claude',
  });

  await assert.rejects(
    () => supervisor.launchAgent({
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-lead-conflict',
      command: 'claude',
    }),
    /runtime already launched/,
  );
});

test('RuntimeSupervisor restarts unexpected exits up to maxRestarts', async () => {
  const directory = new RuntimeDirectory();
  const children = [];
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    spawnProcess() {
      const child = createFakeChild({ pid: 1000 + children.length });
      children.push(child);
      return child;
    },
    createAdapter({ runtimeId, child }) {
      return { runtimeId, child };
    },
  });
  await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
    restartPolicy: { maxRestarts: 1 },
  });

  children[0].emit('exit', 7, null);

  assert.equal(children.length, 2);
  assert.equal(supervisor.getRuntime('runtime-lead-1').status, 'running');
  assert.equal(supervisor.getRuntime('runtime-lead-1').pid, 1001);
  assert.equal(supervisor.getRuntime('runtime-lead-1').restartCount, 1);
  assert.equal(supervisor.getAdapter('runtime-lead-1').child, children[1]);
  assert.equal(
    directory.resolve({ kind: 'agent', teamId: 'team-a', agentId: 'lead' }).runtimeId,
    'runtime-lead-1'
  );

  children[1].emit('exit', 8, null);

  assert.equal(children.length, 2);
  assert.equal(supervisor.getRuntime('runtime-lead-1').status, 'exited');
  assert.equal(supervisor.getRuntime('runtime-lead-1').exitCode, 8);
  assert.equal(
    directory.resolve({ kind: 'agent', teamId: 'team-a', agentId: 'lead' }).deliveryMode,
    'offline_queue'
  );
});

test('RuntimeSupervisor does not restart explicitly stopped runtimes', async () => {
  const directory = new RuntimeDirectory();
  const children = [];
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    spawnProcess() {
      const child = createFakeChild({ pid: 2000 + children.length });
      children.push(child);
      return child;
    },
    createAdapter({ runtimeId, child }) {
      return { runtimeId, child };
    },
  });
  await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
    restartPolicy: { maxRestarts: 1 },
  });

  await supervisor.stopAgent('runtime-lead-1');

  assert.equal(children.length, 1);
  assert.equal(supervisor.getRuntime('runtime-lead-1').status, 'stopped');
});

test('RuntimeSupervisor persists runtime lifecycle through a registry', async () => {
  const directory = new RuntimeDirectory();
  const child = createFakeChild({ pid: 8642 });
  const calls = [];
  const runtimeRegistry = {
    upsertRuntime(input) {
      calls.push({ method: 'upsertRuntime', input });
    },
    registerDeliveryMode(input) {
      calls.push({ method: 'registerDeliveryMode', input });
    },
    markRuntimeStopped(input) {
      calls.push({ method: 'markRuntimeStopped', input });
    },
  };
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    runtimeRegistry,
    spawnProcess() {
      return child;
    },
    createAdapter() {
      return { providerId: 'claude' };
    },
  });

  await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
    args: ['--output-format', 'stream-json'],
    deliveryMode: 'runtime_stdin',
  });
  await supervisor.stopAgent('runtime-lead-1', { signal: 'SIGTERM' });

  assert.equal(calls[0].method, 'upsertRuntime');
  assert.equal(calls[0].input.runtimeId, 'runtime-lead-1');
  assert.equal(calls[0].input.providerId, 'claude');
  assert.equal(calls[0].input.pid, 8642);
  assert.equal(calls[1].method, 'registerDeliveryMode');
  assert.equal(calls[1].input.deliveryMode, 'runtime_stdin');
  assert.equal(calls[2].method, 'markRuntimeStopped');
  assert.equal(calls[2].input.runtimeId, 'runtime-lead-1');
  assert.equal(calls[2].input.status, 'stopped');
  assert.equal(calls[2].input.signal, 'SIGTERM');
});

test('RuntimeSupervisor.launchAgent threads taskId into registry.upsertRuntime (§11)', async () => {
  const directory = new RuntimeDirectory();
  const child = createFakeChild({ pid: 1234 });
  const calls = [];
  const runtimeRegistry = {
    upsertRuntime(input) { calls.push({ method: 'upsertRuntime', input }); },
    registerDeliveryMode() {},
    markRuntimeStopped() {},
  };
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    runtimeRegistry,
    spawnProcess() { return child; },
    createAdapter() { return { providerId: 'claude' }; },
  });
  await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'dev-1',
    runtimeId: 'runtime-pin',
    command: 'claude',
    deliveryMode: 'runtime_stdin',
    taskId: 'task-42',
  });
  const upsert = calls.find((c) => c.method === 'upsertRuntime');
  assert.equal(upsert.input.taskId, 'task-42');
});

test('RuntimeSupervisor.launchAgent passes null taskId to registry when caller omits it', async () => {
  const directory = new RuntimeDirectory();
  const child = createFakeChild({ pid: 1235 });
  const calls = [];
  const runtimeRegistry = {
    upsertRuntime(input) { calls.push({ method: 'upsertRuntime', input }); },
    registerDeliveryMode() {},
    markRuntimeStopped() {},
  };
  const supervisor = new RuntimeSupervisor({
    runtimeDirectory: directory,
    runtimeRegistry,
    spawnProcess() { return child; },
    createAdapter() { return { providerId: 'claude' }; },
  });
  await supervisor.launchAgent({
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-no-pin',
    command: 'claude',
    deliveryMode: 'runtime_stdin',
  });
  const upsert = calls.find((c) => c.method === 'upsertRuntime');
  assert.equal(upsert.input.taskId, null);
});
