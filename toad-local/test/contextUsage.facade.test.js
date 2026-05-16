import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { InMemoryTaskBoard } from '../src/task/inMemoryTaskBoard.js';
import { COMMANDS } from '../src/commands/command-contract.js';
import { LocalToolFacade } from '../src/tools/localToolFacade.js';

test('runtime_list: contextUsage.used is the latest-turn occupancy, not Σ; spend retained', async () => {
  // Two turn_completed result frames. The FIRST is 100+50=150, the SECOND (latest)
  // is 120+5000+0+60=5180. contextUsage.used must be 5180 (latest snapshot),
  // while tokensIn/tokensOut must be the lifetime sum (220 / 110).
  const fakeRegistry = {
    listRuntimes({ teamId }) {
      return [
        {
          runtimeId: 'rt1',
          teamId,
          agentId: 'dev',
          providerId: 'claude',
          status: 'running',
          startedAt: '2026-05-16T00:00:00.000Z',
        },
      ];
    },
    getRuntime() { return null; },
  };

  const makeEvent = (createdAt, usage) => ({
    runtimeId: 'rt1',
    teamId: 'team-a',
    agentId: 'dev',
    eventType: 'turn_completed',
    createdAt,
    payload: {
      raw: {
        type: 'result',
        subtype: 'success',
        model: 'claude-sonnet-4-20250514',
        usage,
        total_cost_usd: 0.01,
      },
    },
  });

  const fakeEventLog = {
    appendEvent() {},
    listEvents() {
      return [
        makeEvent('2026-05-16T00:00:10.000Z', { input_tokens: 100, output_tokens: 50 }),
        makeEvent('2026-05-16T00:00:20.000Z', { input_tokens: 120, output_tokens: 60, cache_read_input_tokens: 5000 }),
      ];
    },
  };

  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    runtimeRegistry: fakeRegistry,
    eventLog: fakeEventLog,
    // No settingsStore — facade falls back to default stalenessMs = 60_000.
  });

  const result = await facade.execute({
    commandName: COMMANDS.RUNTIME_LIST,
    idempotencyKey: 'ctx-usage-facade-1',
    actor: { teamId: 'team-a', agentId: 'op', role: 'human' },
    args: { teamId: 'team-a' },
  });

  const rt = result.runtimes.find((r) => r.runtimeId === 'rt1');
  assert.ok(rt, 'runtime row rt1 must be present');
  assert.ok(rt.contextUsage, 'runtime row carries contextUsage');
  // Latest turn only: 120 (input) + 5000 (cache_read) + 0 (cache_create) + 60 (output)
  assert.equal(rt.contextUsage.used, 120 + 5000 + 0 + 60);
  // claude-sonnet-4-20250514 → 200_000 window
  assert.equal(rt.contextUsage.total, 200_000);
  assert.equal(rt.contextUsage.source, 'precise');
  // Lifetime spend retained (NOT the occupancy signal): both turns summed.
  // tokensIn accumulates input_tokens from both result frames.
  assert.equal(rt.tokensIn, 220);  // 100 + 120
  assert.equal(rt.tokensOut, 110); // 50 + 60
  assert.ok(typeof rt.costUsd === 'number');
});

test('runtime_list: settings.runtime.contextStaleness is honored (provably live, not inert)', async () => {
  const fakeRegistry = {
    listRuntimes({ teamId }) {
      return [{ runtimeId: 'rt1', teamId, agentId: 'dev', providerId: 'claude', status: 'running', startedAt: '2026-05-16T00:00:00.000Z' }];
    },
    getRuntime() { return null; },
  };
  const ev = {
    runtimeId: 'rt1', teamId: 'team-a', agentId: 'dev', eventType: 'turn_completed',
    createdAt: '2026-05-16T00:00:00.000Z',
    payload: { raw: { type: 'result', subtype: 'success', model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 } },
  };
  const fakeEventLog = { appendEvent() {}, listEvents() { return [ev]; } };
  const NOW = Date.parse('2026-05-16T00:01:30.000Z'); // 90s after the only result frame
  const origNow = Date.now;
  Date.now = () => NOW;
  try {
    const f1 = new LocalToolFacade({ broker: new InMemoryBroker(), taskBoard: new InMemoryTaskBoard(), runtimeRegistry: fakeRegistry, eventLog: fakeEventLog });
    const r1 = await f1.execute({ commandName: COMMANDS.RUNTIME_LIST, idempotencyKey: 'cs-default', actor: { teamId: 'team-a', agentId: 'op', role: 'human' }, args: { teamId: 'team-a' } });
    assert.equal(r1.runtimes.find((r) => r.runtimeId === 'rt1').contextUsage.stale, true, 'default 60s -> 90s idle is stale');
    const f2 = new LocalToolFacade({ broker: new InMemoryBroker(), taskBoard: new InMemoryTaskBoard(), runtimeRegistry: fakeRegistry, eventLog: fakeEventLog, settingsStore: { readEffective: async () => ({ runtime: { contextStaleness: 120_000 } }) } });
    const r2 = await f2.execute({ commandName: COMMANDS.RUNTIME_LIST, idempotencyKey: 'cs-cfg', actor: { teamId: 'team-a', agentId: 'op', role: 'human' }, args: { teamId: 'team-a' } });
    assert.equal(r2.runtimes.find((r) => r.runtimeId === 'rt1').contextUsage.stale, false, 'configured 120s window -> 90s idle NOT stale (setting is live, not inert)');
  } finally {
    Date.now = origNow;
  }
});
