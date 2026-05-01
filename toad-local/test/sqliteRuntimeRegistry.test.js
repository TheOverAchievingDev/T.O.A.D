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
