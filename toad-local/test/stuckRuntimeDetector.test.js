import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStuckRuntimes, DEFAULT_THRESHOLD_MS } from '../src/diagnostics/stuckRuntimeDetector.js';

const NOW = '2026-05-01T22:00:00.000Z';

function rt(over) {
  return {
    runtimeId: 'r1',
    teamId: 't',
    agentId: 'a',
    taskId: 'task-1',
    status: 'running',
    startedAt: '2026-05-01T20:00:00.000Z',
    ...over,
  };
}

test('DEFAULT_THRESHOLD_MS is 15 minutes', () => {
  assert.equal(DEFAULT_THRESHOLD_MS, 15 * 60_000);
});

test('empty runtime list returns empty', () => {
  assert.deepEqual(detectStuckRuntimes({ runtimes: [], latestEventByRuntime: new Map(), now: NOW }), []);
});

test('runtime within threshold is not stuck', () => {
  const runtimes = [rt({ runtimeId: 'r1' })];
  const m = new Map([['r1', '2026-05-01T21:55:00.000Z']]); // 5min ago
  const r = detectStuckRuntimes({ runtimes, latestEventByRuntime: m, now: NOW, thresholdMs: 10 * 60_000 });
  assert.deepEqual(r, []);
});

test('runtime past threshold is flagged', () => {
  const runtimes = [rt({ runtimeId: 'r1' })];
  const m = new Map([['r1', '2026-05-01T21:30:00.000Z']]); // 30min ago
  const r = detectStuckRuntimes({ runtimes, latestEventByRuntime: m, now: NOW, thresholdMs: 10 * 60_000 });
  assert.equal(r.length, 1);
  assert.equal(r[0].runtimeId, 'r1');
  assert.equal(r[0].lastEventAt, '2026-05-01T21:30:00.000Z');
  assert.equal(r[0].silentMs, 30 * 60_000);
  assert.equal(r[0].thresholdMs, 10 * 60_000);
});

test('multiple stuck runtimes sorted by silentMs descending (most-stuck first)', () => {
  const runtimes = [rt({ runtimeId: 'r1' }), rt({ runtimeId: 'r2' }), rt({ runtimeId: 'r3' })];
  const m = new Map([
    ['r1', '2026-05-01T21:50:00.000Z'], // 10min ago — within threshold
    ['r2', '2026-05-01T21:00:00.000Z'], // 60min — most stuck
    ['r3', '2026-05-01T21:30:00.000Z'], // 30min
  ]);
  const r = detectStuckRuntimes({ runtimes, latestEventByRuntime: m, now: NOW, thresholdMs: 15 * 60_000 });
  assert.equal(r.length, 2);
  assert.equal(r[0].runtimeId, 'r2');
  assert.equal(r[1].runtimeId, 'r3');
});

test('non-running runtimes are ignored', () => {
  const runtimes = [
    rt({ runtimeId: 'stopped', status: 'stopped' }),
    rt({ runtimeId: 'exited', status: 'exited' }),
  ];
  const m = new Map([
    ['stopped', '2025-01-01T00:00:00.000Z'],
    ['exited', '2025-01-01T00:00:00.000Z'],
  ]);
  assert.deepEqual(detectStuckRuntimes({ runtimes, latestEventByRuntime: m, now: NOW }), []);
});

test('runtime with no events uses startedAt as reference', () => {
  const runtimes = [rt({ runtimeId: 'r1', startedAt: '2026-05-01T21:00:00.000Z' })]; // 60min ago
  const m = new Map(); // no events
  const r = detectStuckRuntimes({ runtimes, latestEventByRuntime: m, now: NOW, thresholdMs: 15 * 60_000 });
  assert.equal(r.length, 1);
  assert.equal(r[0].lastEventAt, '2026-05-01T21:00:00.000Z');
  assert.equal(r[0].silentMs, 60 * 60_000);
});

test('threshold defaults to DEFAULT_THRESHOLD_MS when not supplied', () => {
  const runtimes = [rt({ runtimeId: 'r1' })];
  const m = new Map([['r1', '2026-05-01T21:30:00.000Z']]); // 30min ago
  const r = detectStuckRuntimes({ runtimes, latestEventByRuntime: m, now: NOW });
  // Default 15min threshold; 30min silent → stuck
  assert.equal(r.length, 1);
  assert.equal(r[0].thresholdMs, DEFAULT_THRESHOLD_MS);
});

test('runtime exactly at threshold is NOT flagged (strict >, not >=)', () => {
  const runtimes = [rt({ runtimeId: 'r1' })];
  // 15min ago exactly
  const m = new Map([['r1', '2026-05-01T21:45:00.000Z']]);
  const r = detectStuckRuntimes({ runtimes, latestEventByRuntime: m, now: NOW, thresholdMs: 15 * 60_000 });
  assert.deepEqual(r, []);
});
