import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStuckRuntimes } from '../../src/diagnostics/stuckRuntimeDetector.js';

const T0 = '2026-05-18T00:00:00.000Z';
const NOW = '2026-05-18T01:00:00.000Z'; // 60 min later
const session = (over) => ({ runtimeId: 'r-codex-1', teamId: 't1', agentId: 'dev-1', deliveryMode: 'session_turn', status: 'running', startedAt: T0, ...over });

test('idle session agent (no in-flight turn) is NEVER flagged stuck even after long silence', () => {
  const out = detectStuckRuntimes({
    runtimes: [session()],
    latestEventByRuntime: new Map(),
    sessionInFlight: new Map(),
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.deepEqual(out, []);
});

test('in-flight session turn with no progress past threshold IS flagged stuck', () => {
  const out = detectStuckRuntimes({
    runtimes: [session()],
    latestEventByRuntime: new Map(),
    sessionInFlight: new Map([['r-codex-1', T0]]),
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].runtimeId, 'r-codex-1');
  assert.ok(out[0].silentMs > 15 * 60_000);
});

test('in-flight session turn making recent progress is NOT flagged', () => {
  const out = detectStuckRuntimes({
    runtimes: [session()],
    latestEventByRuntime: new Map([['r-codex-1', '2026-05-18T00:58:00.000Z']]),
    sessionInFlight: new Map([['r-codex-1', T0]]),
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.deepEqual(out, []);
});

test('persistent (Claude) runtimes are unaffected by the session branch', () => {
  const out = detectStuckRuntimes({
    runtimes: [{ runtimeId: 'r-claude-1', teamId: 't1', agentId: 'lead', deliveryMode: 'runtime_stdin', status: 'running', startedAt: T0 }],
    latestEventByRuntime: new Map(),
    sessionInFlight: new Map(),
    now: NOW, thresholdMs: 15 * 60_000,
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].runtimeId, 'r-claude-1');
});
