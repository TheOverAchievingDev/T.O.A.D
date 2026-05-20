import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteNarrationStore } from '../src/runtime/sqliteNarrationStore.js';

function withStore(testFn) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-narration-'));
  const store = new SqliteNarrationStore({ filePath: join(dir, 'toad.db') });
  try {
    testFn(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('SqliteNarrationStore creates the narrated_lines table on open', () => {
  withStore((store) => {
    const cols = store.db.prepare("PRAGMA table_info(narrated_lines)").all().map((c) => c.name);
    assert.deepEqual(
      cols.sort(),
      ['agent_id', 'created_at', 'event_id', 'event_type', 'idempotency_key', 'kind', 'line', 'narration_id', 'runtime_id', 'session_id', 'team_id', 'tokens'].sort(),
    );
  });
});

const base = (over = {}) => ({
  idempotencyKey: 'narration:h1',
  eventId: 'ev-1',
  runtimeId: 'rt-1',
  teamId: 'team-a',
  agentId: 'lead',
  sessionId: 's-1',
  eventType: 'tool_use',
  createdAt: '2026-05-16T00:00:00.000Z',
  line: 'lead ran Read — foo.js',
  kind: 'tool',
  tokens: null,
  ...over,
});

test('appendNarration inserts a row and ensures the team (FK satisfied)', () => {
  withStore((store) => {
    const r = store.appendNarration(base());
    assert.equal(r.inserted, true);
    assert.equal(r.row.line, 'lead ran Read — foo.js');
    assert.equal(r.row.kind, 'tool');
    assert.equal(r.row.tokens, null);
    assert.equal(r.row.teamId, 'team-a');
    const teamRow = store.db.prepare('SELECT team_id FROM teams WHERE team_id = ?').get('team-a');
    assert.equal(teamRow.team_id, 'team-a'); // #ensureTeam ran (no FK throw)
  });
});

test('appendNarration is idempotent by idempotency_key', () => {
  withStore((store) => {
    const a = store.appendNarration(base());
    const b = store.appendNarration(base({ line: 'DIFFERENT' }));
    assert.equal(a.inserted, true);
    assert.equal(b.inserted, false);
    const rows = store.listNarration({ teamId: 'team-a' });
    assert.equal(rows.length, 1, 'no duplicate row');
    assert.equal(rows[0].line, 'lead ran Read — foo.js', 'first write wins');
  });
});

test('appendNarration persists a numeric tokens value', () => {
  withStore((store) => {
    store.appendNarration(base({ idempotencyKey: 'narration:h2', eventType: 'turn_completed', kind: 'system', line: 'Turn complete', tokens: 1234 }));
    const rows = store.listNarration({ teamId: 'team-a' });
    assert.equal(rows[0].tokens, 1234);
  });
});

test('listNarration orders chronologically and scopes by team then runtime', () => {
  withStore((store) => {
    store.appendNarration(base({ idempotencyKey: 'k1', runtimeId: 'rt-1', createdAt: '2026-05-16T00:00:02.000Z', line: 'second' }));
    store.appendNarration(base({ idempotencyKey: 'k2', runtimeId: 'rt-1', createdAt: '2026-05-16T00:00:01.000Z', line: 'first' }));
    store.appendNarration(base({ idempotencyKey: 'k3', runtimeId: 'rt-2', teamId: 'team-a', createdAt: '2026-05-16T00:00:03.000Z', line: 'other-rt' }));
    store.appendNarration(base({ idempotencyKey: 'k4', teamId: 'team-b', runtimeId: 'rt-9', createdAt: '2026-05-16T00:00:00.000Z', line: 'other-team' }));
    const team = store.listNarration({ teamId: 'team-a' }).map((r) => r.line);
    assert.deepEqual(team, ['first', 'second', 'other-rt']);
    const rt1 = store.listNarration({ teamId: 'team-a', runtimeId: 'rt-1' }).map((r) => r.line);
    assert.deepEqual(rt1, ['first', 'second']);
  });
});
