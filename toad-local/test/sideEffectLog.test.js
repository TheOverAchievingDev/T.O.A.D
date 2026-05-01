import test from 'node:test';
import assert from 'node:assert/strict';
import { openToadDatabase } from '../src/storage/sqlite.js';
import { SideEffectLog } from '../src/delivery/sideEffectLog.js';

function makeLog() {
  const db = openToadDatabase(':memory:');
  const log = new SideEffectLog(db);
  return { db, log };
}

test('SideEffectLog.markPending inserts a pending record', () => {
  const { log, db } = makeLog();
  log.markPending({
    deliveryId: 'del-1',
    idempotencyKey: 'tool-result:abc',
    kind: 'tool_result',
    runtimeId: 'runtime-1',
  });
  const record = log.get('tool-result:abc');
  assert.ok(record);
  assert.equal(record.idempotencyKey, 'tool-result:abc');
  assert.equal(record.kind, 'tool_result');
  assert.equal(record.runtimeId, 'runtime-1');
  assert.equal(record.status, 'pending');
  assert.equal(record.deliveredAt, null);
  db.close();
});

test('SideEffectLog.markPending is idempotent (ON CONFLICT DO NOTHING)', () => {
  const { log, db } = makeLog();
  log.markPending({ deliveryId: 'del-1', idempotencyKey: 'key-1', kind: 'tool_result', runtimeId: 'runtime-1' });
  // Should not throw
  log.markPending({ deliveryId: 'del-2', idempotencyKey: 'key-1', kind: 'tool_result', runtimeId: 'runtime-1' });
  const record = log.get('key-1');
  assert.equal(record.deliveryId, 'del-1'); // first write wins
  db.close();
});

test('SideEffectLog.markDelivered updates status and sets deliveredAt', () => {
  const { log, db } = makeLog();
  log.markPending({ deliveryId: 'del-1', idempotencyKey: 'key-1', kind: 'tool_result', runtimeId: 'runtime-1' });
  log.markDelivered('key-1');
  const record = log.get('key-1');
  assert.equal(record.status, 'delivered');
  assert.ok(record.deliveredAt);
  db.close();
});

test('SideEffectLog.markFailed updates status to failed', () => {
  const { log, db } = makeLog();
  log.markPending({ deliveryId: 'del-1', idempotencyKey: 'key-1', kind: 'tool_result', runtimeId: 'runtime-1' });
  log.markFailed('key-1');
  const record = log.get('key-1');
  assert.equal(record.status, 'failed');
  db.close();
});

test('SideEffectLog.getPending returns only pending records', () => {
  const { log, db } = makeLog();
  log.markPending({ deliveryId: 'del-1', idempotencyKey: 'key-1', kind: 'tool_result', runtimeId: 'runtime-1' });
  log.markPending({ deliveryId: 'del-2', idempotencyKey: 'key-2', kind: 'compaction_reinjection', runtimeId: 'runtime-2' });
  log.markPending({ deliveryId: 'del-3', idempotencyKey: 'key-3', kind: 'tool_result', runtimeId: 'runtime-1' });
  log.markDelivered('key-3');

  const allPending = log.getPending();
  assert.equal(allPending.length, 2);
  assert.ok(allPending.every(r => r.status === 'pending'));
  db.close();
});

test('SideEffectLog.getPending filters by kind', () => {
  const { log, db } = makeLog();
  log.markPending({ deliveryId: 'del-1', idempotencyKey: 'key-1', kind: 'tool_result', runtimeId: 'runtime-1' });
  log.markPending({ deliveryId: 'del-2', idempotencyKey: 'key-2', kind: 'compaction_reinjection', runtimeId: 'runtime-2' });

  const toolResultPending = log.getPending('tool_result');
  assert.equal(toolResultPending.length, 1);
  assert.equal(toolResultPending[0].kind, 'tool_result');
  db.close();
});

test('SideEffectLog.get returns null for unknown key', () => {
  const { log, db } = makeLog();
  assert.equal(log.get('nonexistent'), null);
  db.close();
});

test('SideEffectLog.pruneOlderThan deletes failed rows older than the cutoff using created_at', () => {
  const { log, db } = makeLog();
  log.markPending({ deliveryId: 'd1', idempotencyKey: 'old-fail', kind: 'tool_result', runtimeId: 'r1' });
  log.markFailed('old-fail');

  // Force the row's created_at into the past (delivered_at is NULL for failed)
  db.prepare(`UPDATE side_effect_deliveries SET created_at = ? WHERE idempotency_key = 'old-fail'`)
    .run('2020-01-01T00:00:00.000Z');

  const deleted = log.pruneOlderThan(new Date('2024-01-01T00:00:00.000Z'));
  assert.equal(deleted, 1);
  assert.equal(log.get('old-fail'), null);
  db.close();
});

test('SideEffectLog.pruneOlderThan keeps pending rows regardless of age', () => {
  const { log, db } = makeLog();
  log.markPending({ deliveryId: 'd1', idempotencyKey: 'old-pending', kind: 'tool_result', runtimeId: 'r1' });

  db.prepare(`UPDATE side_effect_deliveries SET created_at = ? WHERE idempotency_key = 'old-pending'`)
    .run('2020-01-01T00:00:00.000Z');

  const deleted = log.pruneOlderThan(new Date('2024-01-01T00:00:00.000Z'));
  assert.equal(deleted, 0);
  assert.equal(log.get('old-pending').status, 'pending');
  db.close();
});

test('SideEffectLog.pruneOlderThan keeps terminal rows newer than the cutoff', () => {
  const { log, db } = makeLog();
  log.markPending({ deliveryId: 'd1', idempotencyKey: 'recent', kind: 'tool_result', runtimeId: 'r1' });
  log.markDelivered('recent');

  const cutoff = new Date(Date.now() - 60 * 1000); // 60 seconds ago
  const deleted = log.pruneOlderThan(cutoff);
  assert.equal(deleted, 0);
  assert.ok(log.get('recent'));
  db.close();
});

test('SideEffectLog.pruneOlderThan rejects an invalid cutoff Date', () => {
  const { log, db } = makeLog();
  assert.throws(() => log.pruneOlderThan('not a date'), /must be a valid Date/);
  assert.throws(() => log.pruneOlderThan(new Date('invalid')), /must be a valid Date/);
  db.close();
});

test('SideEffectLog.pruneOlderThan deletes delivered rows older than the cutoff', () => {
  const { log, db } = makeLog();
  log.markPending({ deliveryId: 'd1', idempotencyKey: 'old', kind: 'tool_result', runtimeId: 'r1' });
  log.markDelivered('old');

  // Force the row's delivered_at into the past
  db.prepare(`UPDATE side_effect_deliveries SET delivered_at = ? WHERE idempotency_key = 'old'`)
    .run('2020-01-01T00:00:00.000Z');

  log.markPending({ deliveryId: 'd2', idempotencyKey: 'new', kind: 'tool_result', runtimeId: 'r1' });
  log.markDelivered('new');

  const cutoff = new Date('2024-01-01T00:00:00.000Z');
  const deleted = log.pruneOlderThan(cutoff);

  assert.equal(deleted, 1);
  assert.equal(log.get('old'), null);
  assert.ok(log.get('new'), 'recent row should be retained');
  db.close();
});
