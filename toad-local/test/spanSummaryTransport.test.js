import test from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, commandRequiresIdempotency } from '../src/commands/command-contract.js';

test('command-contract: span-summary commands exist and are not idempotency-gated', () => {
  assert.equal(COMMANDS.SPAN_SUMMARY_LIST, 'span_summary_list');
  assert.equal(COMMANDS.SPAN_SUMMARY_STATUS, 'span_summary_status');
  assert.equal(commandRequiresIdempotency('span_summary_list'), false);
  assert.equal(commandRequiresIdempotency('span_summary_status'), false);
});

import { LocalToolFacade } from '../src/tools/localToolFacade.js';

function makeFacade(extra = {}) {
  return new LocalToolFacade({
    broker: { listMessages: () => [], sendMessage: () => {} },
    taskBoard: { listTasks: () => [] },
    runtimeRegistry: null,
    approvalBroker: null,
    ...extra,
  });
}

const ACTOR = { teamId: 'team-a', agentId: 'lead' };

test('span_summary_list: injected readModel → {summaries} scoped to actor.teamId', () => {
  const calls = [];
  const facade = makeFacade({
    readModel: {
      listSpanSummaries: (q) => { calls.push(q); return [{ spanId: 's1', summaryText: 'did a thing' }]; },
    },
  });
  const r = facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: ACTOR, args: {} });
  assert.deepEqual(r, { summaries: [{ spanId: 's1', summaryText: 'did a thing' }] });
  assert.deepEqual(calls, [{ teamId: 'team-a', runtimeId: null }]);
});

test('span_summary_list: args.runtimeId string is forwarded; non-string → null', () => {
  const calls = [];
  const facade = makeFacade({
    readModel: { listSpanSummaries: (q) => { calls.push(q); return []; } },
  });
  facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: ACTOR, args: { runtimeId: 'rt-9' } });
  facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: ACTOR, args: { runtimeId: 123 } });
  assert.deepEqual(calls, [
    { teamId: 'team-a', runtimeId: 'rt-9' },
    { teamId: 'team-a', runtimeId: null },
  ]);
});

test('span_summary_list: missing readModel → {summaries:[]} (never throws)', () => {
  const facade = makeFacade();
  const r = facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: ACTOR, args: {} });
  assert.deepEqual(r, { summaries: [] });
});

test('span_summary_list: actor with missing/empty teamId → {summaries:[]} (never reaches readModel)', () => {
  let reached = false;
  const facade = makeFacade({
    readModel: { listSpanSummaries: () => { reached = true; return [{ spanId: 'x' }]; } },
  });
  const r1 = facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: { agentId: 'lead' }, args: {} });
  const r2 = facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: { teamId: '', agentId: 'lead' }, args: {} });
  assert.deepEqual(r1, { summaries: [] });
  assert.deepEqual(r2, { summaries: [] });
  assert.equal(reached, false);
});

test('span_summary_status: injected summaryMonitor → getStatus() verbatim', () => {
  const status = {
    state: 'degraded', lastRunAt: 123, lastDurationMs: 9, teamsPolled: 2,
    summarizedCount: 1, degradedCount: 1, skippedRateLimited: 0, lastReasons: ['timeout'],
  };
  const facade = makeFacade();
  facade.summaryMonitor = { getStatus: () => status };
  const r = facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_STATUS, actor: ACTOR, args: {} });
  assert.deepEqual(r, status);
});

test('span_summary_status: no summaryMonitor → frozen honest unavailable object (never throws)', () => {
  const facade = makeFacade();
  const r = facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_STATUS, actor: ACTOR, args: {} });
  assert.deepEqual(r, {
    state: 'unavailable', lastRunAt: null, lastDurationMs: 0,
    teamsPolled: 0, summarizedCount: 0, degradedCount: 0,
    skippedRateLimited: 0, lastReasons: [],
  });
  assert.ok(Object.isFrozen(r), 'unavailable status must be frozen (mutation-proof shared const)');
  assert.ok(Object.isFrozen(r.lastReasons), 'nested lastReasons must also be deep-frozen');
});

test('span_summary_status: ignores args, never throws', () => {
  const facade = makeFacade();
  assert.doesNotThrow(() =>
    facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_STATUS, actor: ACTOR, args: { junk: true } }));
});

test('span-summary commands: early-dispatch still enforces role authority (unknown role rejected)', () => {
  const facade = makeFacade();
  assert.throws(
    () => facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_LIST, actor: { teamId: 'team-a', agentId: 'x', role: 'attacker' }, args: {} }),
    /role authority: unknown role: attacker/,
  );
  assert.throws(
    () => facade.execute({ commandName: COMMANDS.SPAN_SUMMARY_STATUS, actor: { teamId: 'team-a', agentId: 'x', role: 'attacker' }, args: {} }),
    /role authority: unknown role: attacker/,
  );
});
