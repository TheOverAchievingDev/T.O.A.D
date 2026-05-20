import test from 'node:test';
import assert from 'node:assert/strict';
import { SummaryMonitor } from '../src/runtime/spanSummary/summaryMonitor.js';

const noop = () => {};
const okSummarize = async () => ({ summarized: [], degraded: [], skippedRateLimited: 0 });

test('ctor throws TypeError when summarize is not a function', () => {
  assert.throws(
    () => new SummaryMonitor({ listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic' }),
    /SummaryMonitor: summarize\(\) required/,
  );
});

test('ctor throws TypeError when listLiveTeams is not a function', () => {
  assert.throws(
    () => new SummaryMonitor({ summarize: okSummarize, resolveLeadProviderId: () => 'anthropic' }),
    /SummaryMonitor: listLiveTeams\(\) required/,
  );
});

test('ctor throws TypeError when resolveLeadProviderId is not a function', () => {
  assert.throws(
    () => new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [] }),
    /SummaryMonitor: resolveLeadProviderId\(\) required/,
  );
});

test('getStatus() returns the initial idle snapshot before any tick', () => {
  const m = new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic' });
  assert.deepEqual(m.getStatus(), {
    state: 'idle',
    lastRunAt: null,
    lastDurationMs: 0,
    teamsPolled: 0,
    summarizedCount: 0,
    degradedCount: 0,
    skippedRateLimited: 0,
    lastReasons: [],
  });
});

test('getStatus() returns a fresh copy that cannot poison internal state', () => {
  const m = new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic' });
  const s1 = m.getStatus();
  s1.state = 'HACKED';
  s1.lastReasons.push('HACKED');
  assert.equal(m.getStatus().state, 'idle');
  assert.deepEqual(m.getStatus().lastReasons, []);
});

test('ctor accepts a custom intervalMs and defaults to 5 minutes', () => {
  const a = new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic' });
  assert.equal(a.intervalMs, 5 * 60 * 1000);
  const b = new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic', intervalMs: 1234 });
  assert.equal(b.intervalMs, 1234);
});

test('start() is idempotent (double-start creates one timer) and unrefs the timer', () => {
  const realSetInterval = global.setInterval;
  const created = [];
  global.setInterval = (fn, ms) => {
    const t = realSetInterval(fn, ms);
    t.__unrefCalled = false;
    const origUnref = t.unref.bind(t);
    t.unref = () => { t.__unrefCalled = true; return origUnref(); };
    created.push(t);
    return t;
  };
  try {
    const m = new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic', intervalMs: 10_000 });
    m.start();
    m.start(); // idempotent — must NOT create a second timer
    assert.equal(created.length, 1, 'exactly one setInterval');
    assert.equal(created[0].__unrefCalled, true, 'timer.unref() was called');
    m.stop();
  } finally {
    global.setInterval = realSetInterval;
  }
});

test('stop() clears the timer, is idempotent, and is safe before start()', () => {
  const m = new SummaryMonitor({ summarize: okSummarize, listLiveTeams: () => [], resolveLeadProviderId: () => 'anthropic', intervalMs: 10_000 });
  m.stop();          // safe before start()
  m.start();
  m.stop();
  m.stop();          // idempotent
  assert.ok(true);   // no throw == pass
});

test('start()/stop() drives ticks at the configured interval', async () => {
  let calls = 0;
  const m = new SummaryMonitor({
    summarize: async () => { calls++; return { summarized: [], degraded: [], skippedRateLimited: 0 }; },
    listLiveTeams: () => ['team-a'],
    resolveLeadProviderId: () => 'anthropic',
    intervalMs: 20,
  });
  m.start();
  await new Promise((r) => setTimeout(r, 70));
  m.stop();
  assert.ok(calls >= 2 && calls <= 5, `expected 2-5 ticks, got ${calls}`);
});

test('tickOnce() with no live teams → status idle, summarize never called', async () => {
  let called = 0;
  const m = new SummaryMonitor({
    summarize: async () => { called++; return { summarized: [], degraded: [], skippedRateLimited: 0 }; },
    listLiveTeams: () => [],
    resolveLeadProviderId: () => 'anthropic',
  });
  await m.tickOnce();
  assert.equal(called, 0);
  const s = m.getStatus();
  assert.equal(s.state, 'idle');
  assert.equal(s.teamsPolled, 0);
  assert.equal(typeof s.lastRunAt, 'number');
  assert.equal(typeof s.lastDurationMs, 'number');
});

test('tickOnce() one team → resolveLeadProviderId + summarize({teamId,leadProviderId}) + status reflects report', async () => {
  const seen = [];
  const m = new SummaryMonitor({
    summarize: async (a) => { seen.push(a); return { summarized: [{ spanId: 's1', model: 'm', cli: 'c' }], degraded: [], skippedRateLimited: 0 }; },
    listLiveTeams: () => ['team-a'],
    resolveLeadProviderId: (t) => (t === 'team-a' ? 'codex' : 'x'),
  });
  await m.tickOnce();
  assert.deepEqual(seen, [{ teamId: 'team-a', leadProviderId: 'codex' }]);
  const s = m.getStatus();
  assert.equal(s.state, 'idle');
  assert.equal(s.teamsPolled, 1);
  assert.equal(s.summarizedCount, 1);
  assert.equal(s.degradedCount, 0);
});

test('tickOnce() multi-team accumulates counts + dedups degraded reasons across teams', async () => {
  const m = new SummaryMonitor({
    summarize: async ({ teamId }) => (teamId === 'team-a'
      ? { summarized: [{ spanId: 'a1' }], degraded: [{ spanId: 'a2', reason: 'timeout' }], skippedRateLimited: 0 }
      : { summarized: [], degraded: [{ spanId: 'b1', reason: 'timeout' }, { spanId: 'b2', reason: 'spawn_failed' }], skippedRateLimited: 0 }),
    listLiveTeams: () => ['team-a', 'team-b'],
    resolveLeadProviderId: () => 'anthropic',
  });
  await m.tickOnce();
  const s = m.getStatus();
  assert.equal(s.teamsPolled, 2);
  assert.equal(s.summarizedCount, 1);
  assert.equal(s.degradedCount, 3);
  assert.equal(s.state, 'degraded');
  assert.deepEqual([...s.lastReasons].sort(), ['spawn_failed', 'timeout']);
});

test('tickOnce() state machine: rate-limited only when skipped>0 AND summarized==0', async () => {
  const rl = new SummaryMonitor({
    summarize: async () => ({ summarized: [], degraded: [], skippedRateLimited: 4 }),
    listLiveTeams: () => ['t'], resolveLeadProviderId: () => 'anthropic',
  });
  await rl.tickOnce();
  assert.equal(rl.getStatus().state, 'rate-limited');
  assert.equal(rl.getStatus().skippedRateLimited, 4);

  const idle = new SummaryMonitor({
    summarize: async () => ({ summarized: [{ spanId: 's' }], degraded: [], skippedRateLimited: 4 }),
    listLiveTeams: () => ['t'], resolveLeadProviderId: () => 'anthropic',
  });
  await idle.tickOnce();
  assert.equal(idle.getStatus().state, 'idle', 'progress beats throttle: summarized>0 → idle');
});

test('tickOnce() state machine: degraded outranks rate-limited', async () => {
  const m = new SummaryMonitor({
    summarize: async () => ({ summarized: [], degraded: [{ spanId: 'x', reason: 'persist_failed' }], skippedRateLimited: 9 }),
    listLiveTeams: () => ['t'], resolveLeadProviderId: () => 'anthropic',
  });
  await m.tickOnce();
  assert.equal(m.getStatus().state, 'degraded');
});

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('inFlight guard: a second tickOnce() while the first is pending is skipped + logged', async () => {
  const gate = deferred();
  let calls = 0;
  const warns = [];
  const m = new SummaryMonitor({
    summarize: async () => { calls++; await gate.promise; return { summarized: [], degraded: [], skippedRateLimited: 0 }; },
    listLiveTeams: () => ['team-a'],
    resolveLeadProviderId: () => 'anthropic',
    logger: { warn: (...a) => warns.push(a.join(' ')) },
  });
  const first = m.tickOnce();           // enters, summarize pending on the gate
  await Promise.resolve();              // let the first tick reach `await gate.promise`
  await m.tickOnce();                   // second call: must be skipped immediately
  assert.equal(calls, 1, 'summarize called exactly once (second tick skipped)');
  assert.ok(warns.some((w) => /tick skipped: previous in flight/.test(w)));
  gate.resolve();
  await first;
});

test('inFlight cleared in finally even when a team throws — a later tick proceeds', async () => {
  let calls = 0;
  const m = new SummaryMonitor({
    summarize: async () => { calls++; throw new Error('boom'); },
    listLiveTeams: () => ['team-a'],
    resolveLeadProviderId: () => 'anthropic',
    logger: { warn() {} },
  });
  await m.tickOnce();                   // team throws, swallowed; #inFlight cleared in finally
  await m.tickOnce();                   // proves the flag did not leak
  assert.equal(calls, 2);
  assert.equal(m.getStatus().state, 'idle'); // no degraded report (throw != degraded[])
});

test('per-team isolation: one team throwing does not stop the others; tickOnce never throws', async () => {
  const m = new SummaryMonitor({
    summarize: async ({ teamId }) => {
      if (teamId === 'bad') throw new Error('bad team');
      return { summarized: [{ spanId: `${teamId}-1` }], degraded: [], skippedRateLimited: 0 };
    },
    listLiveTeams: () => ['good-1', 'bad', 'good-2'],
    resolveLeadProviderId: () => 'anthropic',
    logger: { warn() {} },
  });
  await assert.doesNotReject(() => m.tickOnce());
  const s = m.getStatus();
  assert.equal(s.teamsPolled, 3);
  assert.equal(s.summarizedCount, 2, 'both good teams summarized despite the bad one');
});

test('tickOnce never throws when listLiveTeams throws', async () => {
  const m = new SummaryMonitor({
    summarize: async () => ({ summarized: [], degraded: [], skippedRateLimited: 0 }),
    listLiveTeams: () => { throw new Error('registry down'); },
    resolveLeadProviderId: () => 'anthropic',
    logger: { warn() {} },
  });
  await assert.doesNotReject(() => m.tickOnce());
  assert.equal(m.getStatus().state, 'idle');
  assert.equal(m.getStatus().teamsPolled, 0);
});

test('tickOnce never throws when resolveLeadProviderId throws (isolated per team)', async () => {
  let summarizeCalls = 0;
  const m = new SummaryMonitor({
    summarize: async () => { summarizeCalls++; return { summarized: [], degraded: [], skippedRateLimited: 0 }; },
    listLiveTeams: () => ['team-a'],
    resolveLeadProviderId: () => { throw new Error('teamConfig miss'); },
    logger: { warn() {} },
  });
  await assert.doesNotReject(() => m.tickOnce());
  assert.equal(summarizeCalls, 0, 'summarize not reached when resolveLeadProviderId throws');
  assert.equal(m.getStatus().state, 'idle');
});

test('getStatus() overlays "summarizing" while a tick is in flight', async () => {
  const gate = deferred();
  const m = new SummaryMonitor({
    summarize: async () => { await gate.promise; return { summarized: [{ spanId: 's' }], degraded: [], skippedRateLimited: 0 }; },
    listLiveTeams: () => ['team-a'],
    resolveLeadProviderId: () => 'anthropic',
  });
  const p = m.tickOnce();
  await Promise.resolve();
  assert.equal(m.getStatus().state, 'summarizing', 'inFlight overlay');
  gate.resolve();
  await p;
  assert.equal(m.getStatus().state, 'idle', 'settled classification after the tick');
});
