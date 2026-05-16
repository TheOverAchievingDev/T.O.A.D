import test from 'node:test';
import assert from 'node:assert/strict';
import { getContextUsage } from '../src/runtime/contextUsage/index.js';

function fakeRegistry(rows) {
  return { listRuntimes: () => rows };
}
function fakeEventLog(byRuntime) {
  return { listEvents: ({ runtimeId }) => byRuntime[runtimeId] || [] };
}
function rf(createdAt, usage, model = 'claude-sonnet-4-20250514') {
  return { eventType: 'turn_completed', createdAt, payload: { raw: { type: 'result', subtype: 'success', model, usage } } };
}

test('resolves the agent\'s current runtime and computes precise usage', () => {
  const reg = fakeRegistry([
    { runtimeId: 'rt-old', agentId: 'dev', providerId: 'claude', status: 'stopped', startedAt: '2026-05-16T00:00:00Z' },
    { runtimeId: 'rt-now', agentId: 'dev', providerId: 'claude', status: 'running', startedAt: '2026-05-16T01:00:00Z' },
  ]);
  const log = fakeEventLog({ 'rt-now': [rf('2026-05-16T01:05:00.000Z', { input_tokens: 100, output_tokens: 50 })] });
  const r = getContextUsage('dev', { teamId: 'team-a', runtimeRegistry: reg, eventLog: log, settings: { runtime: { contextStaleness: 60_000 } }, now: Date.parse('2026-05-16T01:05:10Z') });
  assert.equal(r.used, 150);
  assert.equal(r.provider, 'claude');
  assert.equal(r.source, 'precise');
});
test('no runtime for agent → degraded shape, never throws', () => {
  const r = getContextUsage('ghost', { teamId: 'team-a', runtimeRegistry: fakeRegistry([]), eventLog: fakeEventLog({}), settings: {}, now: Date.now() });
  assert.equal(r.used, null); assert.equal(r.total, null); assert.equal(r.percentage, null);
  assert.equal(r.stale, true); assert.equal(r.source, 'unknown');
});
test('empty-slot safety: codex/gemini provider → degraded shape, never throws (deferred slots)', () => {
  for (const providerId of ['codex', 'gemini', 'openai', 'anything']) {
    const reg = fakeRegistry([{ runtimeId: 'rt', agentId: 'a', providerId, status: 'running', startedAt: '2026-05-16T00:00:00Z' }]);
    const r = getContextUsage('a', { teamId: 'team-a', runtimeRegistry: reg, eventLog: fakeEventLog({ rt: [] }), settings: {}, now: Date.now() });
    assert.equal(r.provider, providerId);
    assert.equal(r.source, 'unknown');
    assert.equal(r.used, null);
    assert.equal(r.stale, true);
  }
});
test('staleness window read from settings.runtime.contextStaleness, default 60000', () => {
  const reg = fakeRegistry([{ runtimeId: 'rt', agentId: 'a', providerId: 'claude', status: 'running', startedAt: '2026-05-16T00:00:00Z' }]);
  const log = fakeEventLog({ rt: [rf('2026-05-16T00:00:00.000Z', { input_tokens: 1, output_tokens: 1 })] });
  // 90s later: stale under default 60s, fresh under a configured 120s
  const def = getContextUsage('a', { teamId: 'team-a', runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.parse('2026-05-16T00:01:30Z') });
  assert.equal(def.stale, true);
  const cfg = getContextUsage('a', { teamId: 'team-a', runtimeRegistry: reg, eventLog: log, settings: { runtime: { contextStaleness: 120_000 } }, now: Date.parse('2026-05-16T00:01:30Z') });
  assert.equal(cfg.stale, false);
});
test('missing deps → degraded, never throws', () => {
  assert.equal(getContextUsage('a', {}).source, 'unknown');
  assert.equal(getContextUsage(null, { runtimeRegistry: fakeRegistry([]) }).source, 'unknown');
  assert.equal(getContextUsage('a', { teamId: 't' }).source, 'unknown');
});
test('REQUIRED teamId: missing/empty teamId → degraded (never cross-team-guess)', () => {
  const reg = fakeRegistry([{ runtimeId: 'rt', agentId: 'lead', teamId: 'A', providerId: 'claude', status: 'running', startedAt: '2026-05-16T00:00:00Z' }]);
  const log = fakeEventLog({ rt: [rf('2026-05-16T00:00:01Z', { input_tokens: 1, output_tokens: 1 })] });
  assert.equal(getContextUsage('lead', { runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.now() }).source, 'unknown', 'no teamId → degraded');
  assert.equal(getContextUsage('lead', { teamId: '', runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.now() }).source, 'unknown', 'empty teamId → degraded');
});
test('cross-team agentId collision: scoping by teamId picks the RIGHT team’s runtime', () => {
  // A real registry would filter by teamId; emulate that in the fake.
  const rowsByTeam = {
    A: [{ runtimeId: 'rtA', agentId: 'lead', teamId: 'A', providerId: 'claude', status: 'running', startedAt: '2026-05-16T00:00:00Z' }],
    B: [{ runtimeId: 'rtB', agentId: 'lead', teamId: 'B', providerId: 'claude', status: 'running', startedAt: '2026-05-16T02:00:00Z' }],
  };
  const reg = { listRuntimes: ({ teamId }) => rowsByTeam[teamId] || [] };
  const log = fakeEventLog({
    rtA: [rf('2026-05-16T00:00:01Z', { input_tokens: 100, output_tokens: 0 })],
    rtB: [rf('2026-05-16T02:00:01Z', { input_tokens: 999, output_tokens: 0 })],
  });
  const a = getContextUsage('lead', { teamId: 'A', runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.parse('2026-05-16T00:00:05Z') });
  const b = getContextUsage('lead', { teamId: 'B', runtimeRegistry: reg, eventLog: log, settings: {}, now: Date.parse('2026-05-16T02:00:05Z') });
  assert.equal(a.used, 100, 'team A lead resolves team A runtime');
  assert.equal(b.used, 999, 'team B lead resolves team B runtime — no cross-team bleed');
});
