import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeDirectory } from '../src/delivery/runtimeDirectory.js';
import { SqliteRuntimeRegistry } from '../src/runtime/sqliteRuntimeRegistry.js';

function withRegistry(testFn) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-runtime-registry-'));
  const registry = new SqliteRuntimeRegistry({ filePath: join(dir, 'toad.db') });
  try {
    testFn(registry);
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SqliteRuntimeRegistry persists runtime instances', () => {
  withRegistry((registry) => {
    const saved = registry.upsertRuntime({
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      providerId: 'claude',
      command: 'claude',
      args: ['--output-format', 'stream-json'],
      cwd: 'C:\\Project-TOAD',
      env: { TOAD_TEAM_ID: 'team-a' },
      deliveryMode: 'runtime_stdin',
      pid: 2468,
      status: 'running',
      startedAt: '2026-04-29T00:00:00.000Z',
    });

    assert.equal(saved.runtimeId, 'runtime-lead-1');
    assert.equal(saved.status, 'running');
    assert.deepEqual(saved.args, ['--output-format', 'stream-json']);
    assert.equal(saved.env.TOAD_TEAM_ID, 'team-a');

    const reopened = registry.getRuntime('runtime-lead-1');
    assert.equal(reopened.providerId, 'claude');
    assert.equal(reopened.pid, 2468);
    assert.equal(registry.listRuntimes({ teamId: 'team-a' }).length, 1);
  });
});

test('SqliteRuntimeRegistry persists and hydrates agent delivery modes', () => {
  withRegistry((registry) => {
    registry.upsertRuntime({
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      providerId: 'claude',
      command: 'claude',
      deliveryMode: 'runtime_stdin',
      status: 'running',
    });
    registry.registerDeliveryMode({
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-lead-1',
      deliveryMode: 'runtime_stdin',
      metadata: { pid: 2468, providerId: 'claude' },
    });

    const modes = registry.listDeliveryModes();
    assert.equal(modes.length, 1);
    assert.equal(modes[0].runtimeId, 'runtime-lead-1');
    assert.equal(modes[0].metadata.pid, 2468);

    const directory = new RuntimeDirectory();
    registry.hydrateRuntimeDirectory(directory);

    const resolved = directory.resolve({ kind: 'agent', teamId: 'team-a', agentId: 'lead' });
    assert.equal(resolved.runtimeId, 'runtime-lead-1');
    assert.equal(resolved.deliveryMode, 'runtime_stdin');
    assert.equal(resolved.metadata.pid, 2468);
  });
});

test('SqliteRuntimeRegistry removes delivery modes when runtimes stop', () => {
  withRegistry((registry) => {
    registry.upsertRuntime({
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      providerId: 'claude',
      command: 'claude',
      deliveryMode: 'runtime_stdin',
      status: 'running',
    });
    registry.registerDeliveryMode({
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-lead-1',
      deliveryMode: 'runtime_stdin',
    });

    const stopped = registry.markRuntimeStopped({
      runtimeId: 'runtime-lead-1',
      status: 'stopped',
      exitCode: 0,
      signal: 'SIGTERM',
      stoppedAt: '2026-04-29T00:01:00.000Z',
    });

    assert.equal(stopped.status, 'stopped');
    assert.equal(stopped.exitCode, 0);
    assert.equal(registry.listDeliveryModes().length, 0);
  });
});

// --- §11 slice 1: session→task pinning ---

test('SqliteRuntimeRegistry persists taskId on upsert and surfaces it on read', () => {
  withRegistry((registry) => {
    registry.upsertRuntime({
      runtimeId: 'runtime-task-pin',
      teamId: 'team-a',
      agentId: 'dev-1',
      providerId: 'claude',
      command: 'claude',
      args: [],
      env: {},
      deliveryMode: 'runtime_stdin',
      status: 'running',
      taskId: 'task-42',
    });
    const reloaded = registry.getRuntime('runtime-task-pin');
    assert.equal(reloaded.taskId, 'task-42');
  });
});

test('SqliteRuntimeRegistry leaves taskId null when not supplied', () => {
  withRegistry((registry) => {
    registry.upsertRuntime({
      runtimeId: 'runtime-no-task',
      teamId: 'team-a',
      agentId: 'lead',
      providerId: 'claude',
      command: 'claude',
      deliveryMode: 'runtime_stdin',
      status: 'running',
    });
    const reloaded = registry.getRuntime('runtime-no-task');
    assert.equal(reloaded.taskId, null);
  });
});

test('SqliteRuntimeRegistry listRuntimes returns taskId on every row', () => {
  withRegistry((registry) => {
    registry.upsertRuntime({
      runtimeId: 'r-pinned', teamId: 'team-a', agentId: 'dev-1',
      providerId: 'claude', command: 'claude', deliveryMode: 'runtime_stdin', status: 'running', taskId: 'pinned-task',
    });
    registry.upsertRuntime({
      runtimeId: 'r-free', teamId: 'team-a', agentId: 'lead',
      providerId: 'claude', command: 'claude', deliveryMode: 'runtime_stdin', status: 'running',
    });
    const list = registry.listRuntimes({ teamId: 'team-a' });
    const byId = Object.fromEntries(list.map((r) => [r.runtimeId, r.taskId]));
    assert.equal(byId['r-pinned'], 'pinned-task');
    assert.equal(byId['r-free'], null);
  });
});

test('SqliteRuntimeRegistry.reconcileOrphans marks all live-status rows as stopped', () => {
  // When the sidecar process is killed without a graceful shutdown (the
  // common case during dev: `taskkill /T /F`), child claude processes die
  // but the runtime_instances rows remain at status='running'/'starting'/
  // 'live'. On the next sidecar boot those PIDs are dead but the UI's
  // runtime_list and the right-panel LIVE section still surface them as
  // alive. reconcileOrphans is the boot-time sweep that clears them.
  withRegistry((registry) => {
    registry.upsertRuntime({
      runtimeId: 'r-running', teamId: 't', agentId: 'a', providerId: 'claude',
      command: 'claude', deliveryMode: 'runtime_stdin', status: 'running', pid: 99999,
    });
    registry.upsertRuntime({
      runtimeId: 'r-starting', teamId: 't', agentId: 'b', providerId: 'claude',
      command: 'claude', deliveryMode: 'runtime_stdin', status: 'starting',
    });
    registry.upsertRuntime({
      runtimeId: 'r-live', teamId: 't', agentId: 'c', providerId: 'claude',
      command: 'claude', deliveryMode: 'runtime_stdin', status: 'live',
    });
    registry.upsertRuntime({
      runtimeId: 'r-already-stopped', teamId: 't', agentId: 'd', providerId: 'claude',
      command: 'claude', deliveryMode: 'runtime_stdin', status: 'stopped',
    });
    registry.upsertRuntime({
      runtimeId: 'r-error', teamId: 't', agentId: 'e', providerId: 'claude',
      command: 'claude', deliveryMode: 'runtime_stdin', status: 'error',
    });

    const result = registry.reconcileOrphans();

    // Three of the five rows should have been reconciled.
    assert.equal(result.reconciled, 3);
    assert.equal(registry.getRuntime('r-running').status, 'stopped');
    assert.equal(registry.getRuntime('r-starting').status, 'stopped');
    assert.equal(registry.getRuntime('r-live').status, 'stopped');
    // Already-terminal rows are untouched — we don't want to overwrite a
    // recorded 'error' status with a generic 'stopped'.
    assert.equal(registry.getRuntime('r-already-stopped').status, 'stopped');
    assert.equal(registry.getRuntime('r-error').status, 'error');
    // stopped_at should now be populated on the reconciled rows so the UI
    // can show "stopped <when>" instead of the started_at timestamp.
    assert.ok(registry.getRuntime('r-running').stoppedAt);
    // Orphan PIDs surfaced for the caller to kill. Only rows that had a
    // valid PID make it into orphanedPids — rows missing pid (starting,
    // live in this fixture) are skipped silently.
    assert.deepEqual(result.orphanedPids, [99999]);
  });
});

test('SqliteRuntimeRegistry.reconcileOrphans returns reconciled=0 and empty orphanedPids when nothing is live', () => {
  // Calling reconcileOrphans on a clean DB or after a previous sweep must
  // be a no-op; otherwise we risk reporting noisy "reconciled N runtimes
  // on boot" diagnostics every restart.
  withRegistry((registry) => {
    const result = registry.reconcileOrphans();
    assert.equal(result.reconciled, 0);
    assert.deepEqual(result.orphanedPids, []);
  });
});

test('cliSessionId defaults null, persists via setRuntimeCliSessionId, survives reopen, preserved across re-upsert', () => {
  withRegistry((registry) => {
    registry.upsertRuntime({
      runtimeId: 'r-codex-1', teamId: 'team-a', agentId: 'dev-1',
      providerId: 'openai', command: 'codex', deliveryMode: 'session_turn',
      status: 'running', startedAt: '2026-05-18T00:00:00.000Z',
    });
    assert.equal(registry.getRuntime('r-codex-1').cliSessionId, null);

    const updated = registry.setRuntimeCliSessionId({ runtimeId: 'r-codex-1', cliSessionId: 'sess-abc' });
    assert.equal(updated.cliSessionId, 'sess-abc');
    assert.equal(registry.getRuntime('r-codex-1').cliSessionId, 'sess-abc');

    registry.upsertRuntime({
      runtimeId: 'r-codex-1', teamId: 'team-a', agentId: 'dev-1',
      providerId: 'openai', command: 'codex', deliveryMode: 'session_turn',
      status: 'running', startedAt: '2026-05-18T00:00:00.000Z',
    });
    assert.equal(registry.getRuntime('r-codex-1').cliSessionId, 'sess-abc');

    assert.equal(registry.setRuntimeCliSessionId({ runtimeId: 'r-codex-1', cliSessionId: null }).cliSessionId, null);
  });
});
