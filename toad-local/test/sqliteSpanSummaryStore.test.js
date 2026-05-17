import test from 'node:test';
import assert from 'node:assert/strict';
import { SqliteSpanSummaryStore } from '../src/runtime/sqliteSpanSummaryStore.js';

function baseInput(o = {}) {
  return {
    spanId: 'span-n1', teamId: 'team-a', runtimeId: 'rt-1', agentId: 'dev-1',
    sessionId: 's1', summaryText: 'agent read a.js then ran tests',
    model: 'haiku', cli: 'claude',
    spanStartedAt: '2026-05-16T00:00:00.000Z', spanEndedAt: '2026-05-16T00:00:30.000Z',
    rowCount: 3, tokens: 42, ...o,
  };
}

test('appendSummary inserts and listSummaries returns it', () => {
  const s = new SqliteSpanSummaryStore();
  const { inserted, row } = s.appendSummary(baseInput());
  assert.equal(inserted, true);
  assert.equal(row.spanId, 'span-n1');
  assert.equal(typeof row.summaryId, 'string');
  const list = s.listSummaries({ teamId: 'team-a' });
  assert.equal(list.length, 1);
  assert.equal(list[0].spanId, 'span-n1');
  assert.equal(list[0].summaryText, 'agent read a.js then ran tests');
  assert.equal(list[0].model, 'haiku');
  assert.equal(list[0].cli, 'claude');
  assert.equal(list[0].rowCount, 3);
  assert.equal(list[0].tokens, 42);
  s.close();
});

test('appendSummary is idempotent by spanId: first-write-wins, never overwrites', () => {
  const s = new SqliteSpanSummaryStore();
  const first = s.appendSummary(baseInput({ summaryText: 'ORIGINAL' }));
  assert.equal(first.inserted, true);
  const second = s.appendSummary(baseInput({ summaryText: 'DIFFERENT — must be ignored', model: 'sonnet' }));
  assert.equal(second.inserted, false);
  assert.equal(second.row.summaryText, 'ORIGINAL');
  assert.equal(second.row.model, 'haiku');
  const list = s.listSummaries({ teamId: 'team-a' });
  assert.equal(list.length, 1);
  assert.equal(list[0].summaryText, 'ORIGINAL');
  assert.equal(list[0].model, 'haiku');
  s.close();
});

test('#ensureTeam: append without pre-creating the team succeeds (FK satisfied)', () => {
  const s = new SqliteSpanSummaryStore();
  const { inserted } = s.appendSummary(baseInput({ teamId: 'brand-new-team' }));
  assert.equal(inserted, true);
  assert.equal(s.listSummaries({ teamId: 'brand-new-team' }).length, 1);
  s.close();
});

test('listSummaries scopes by runtimeId and orders created_at ASC, summary_id ASC', () => {
  const s = new SqliteSpanSummaryStore();
  s.appendSummary(baseInput({ spanId: 'span-a', runtimeId: 'rt-1', createdAt: '2026-05-16T00:00:01.000Z' }));
  s.appendSummary(baseInput({ spanId: 'span-b', runtimeId: 'rt-2', createdAt: '2026-05-16T00:00:02.000Z' }));
  s.appendSummary(baseInput({ spanId: 'span-c', runtimeId: 'rt-1', createdAt: '2026-05-16T00:00:03.000Z' }));
  assert.deepEqual(s.listSummaries({ teamId: 'team-a' }).map((r) => r.spanId), ['span-a', 'span-b', 'span-c']);
  assert.deepEqual(s.listSummaries({ teamId: 'team-a', runtimeId: 'rt-1' }).map((r) => r.spanId), ['span-a', 'span-c']);
  s.close();
});

test('required fields rejected with TypeError; optionals null-tolerant; createdAt defaults', () => {
  const s = new SqliteSpanSummaryStore();
  for (const bad of ['spanId', 'teamId', 'runtimeId', 'agentId', 'summaryText', 'spanStartedAt', 'spanEndedAt']) {
    assert.throws(() => s.appendSummary(baseInput({ [bad]: '' })), TypeError, `empty ${bad} must throw`);
  }
  assert.throws(() => s.appendSummary(baseInput({ rowCount: 'three' })), TypeError, 'non-number rowCount must throw');
  const { row } = s.appendSummary(baseInput({ spanId: 'span-opt', sessionId: null, model: null, cli: null, tokens: null }));
  assert.equal(row.sessionId, null);
  assert.equal(row.model, null);
  assert.equal(row.cli, null);
  assert.equal(row.tokens, null);
  assert.equal(typeof row.createdAt, 'string');
  assert.ok(row.createdAt.length > 0);
  s.close();
});

test('rowCount: 0 is a valid non-negative integer and round-trips as 0 (not null)', () => {
  const s = new SqliteSpanSummaryStore();
  const { inserted, row } = s.appendSummary(baseInput({ spanId: 'span-zero', rowCount: 0 }));
  assert.equal(inserted, true);
  assert.equal(row.rowCount, 0);
  assert.equal(s.listSummaries({ teamId: 'team-a' })[0].rowCount, 0);
  assert.throws(() => s.appendSummary(baseInput({ spanId: 'span-neg', rowCount: -1 })), TypeError);
  assert.throws(() => s.appendSummary(baseInput({ spanId: 'span-flt', rowCount: 3.7 })), TypeError);
  s.close();
});
