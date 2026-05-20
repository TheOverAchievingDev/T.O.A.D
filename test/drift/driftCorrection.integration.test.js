import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteDriftStore } from '../../src/drift/driftStore.js';
import { createDriftCorrection } from '../../src/drift/driftCorrection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'storage', 'schema.sql');

function makeRealStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  db.prepare(`INSERT INTO teams (team_id, display_name, created_at)
              VALUES ('team-a', 'Team A', '2026-05-04T00:00:00Z')`).run();
  return { db, store: new SqliteDriftStore({ db }) };
}

function makeInMemoryTaskBoard() {
  const tasks = new Map();
  let counter = 0;
  return {
    create({ teamId, subject, description, riskLevel }) {
      counter += 1;
      const taskId = `task_${counter}`;
      const row = { taskId, teamId, subject, description, riskLevel, status: 'backlog' };
      tasks.set(taskId, row);
      return row;
    },
    getTask({ teamId: _teamId, taskId }) {
      return tasks.get(taskId) ?? null;
    },
    setStatus(taskId, status) {
      const t = tasks.get(taskId);
      if (t) t.status = status;
    },
  };
}

test('integration: emit finding -> create correction -> next reap -> mark done -> linkage cleared', async () => {
  const { store } = makeRealStore();
  const taskBoard = makeInMemoryTaskBoard();

  // Step 1: drift engine emits a finding
  const finding = {
    id: 'f1', taskId: 't_offending', category: 'lifecycle',
    severity: 'medium', checkName: 'test_check', title: 'It drifted',
    evidence: [], expected: 'X', actual: 'Y',
    recommendedCorrection: 'Do X instead', autoFixable: false,
  };
  store.recordRun({
    runId: 'r1', teamId: 'team-a', asOf: '2026-05-04T00:00:00Z',
    teamScore: 50, status: 'warning',
    categoryScores: {}, perTaskScores: {}, trigger: 'manual',
    findings: [finding],
  });

  // Step 2: operator creates a correction
  const result = await createDriftCorrection({
    teamId: 'team-a',
    findingIds: ['f1'],
    subject: 'Address f1',
    description: 'Fix it',
    riskLevel: 'medium',
    taskBoard, driftStore: store,
  });
  assert.equal(result.linkedFindingCount, 1);
  const taskId = result.taskId;

  // Step 3: linkage now visible to engine
  const linkages = store.getCorrectionLinkages({ teamId: 'team-a' });
  assert.equal(linkages.get('f1'), taskId);

  // Step 4: reap with task in_progress -> no change
  let reap = store.reapResolvedCorrections({ teamId: 'team-a', taskBoard });
  assert.equal(reap.reaped, 0);

  // Step 5: mark task done; reap clears linkage
  taskBoard.setStatus(taskId, 'done');
  reap = store.reapResolvedCorrections({ teamId: 'team-a', taskBoard });
  assert.equal(reap.reaped, 1);
  assert.equal(store.getCorrectionLinkages({ teamId: 'team-a' }).size, 0);
});

test('integration: re-stamp survives recordRun wholesale-replace', async () => {
  const { store } = makeRealStore();
  const taskBoard = makeInMemoryTaskBoard();

  // Run 1: emit + link
  const f1 = {
    id: 'f1', taskId: 't1', category: 'lifecycle', severity: 'medium',
    checkName: 'c', title: 't', evidence: [], expected: 'e', actual: 'a',
    recommendedCorrection: 'r', autoFixable: false,
  };
  store.recordRun({
    runId: 'r1', teamId: 'team-a', asOf: 'now', teamScore: 50,
    status: 'warning', categoryScores: {}, perTaskScores: {},
    trigger: 'manual', findings: [f1],
  });
  const created = await createDriftCorrection({
    teamId: 'team-a', findingIds: ['f1'],
    subject: 's', description: 'd', riskLevel: 'low',
    taskBoard, driftStore: store,
  });

  // Simulate engine re-run: read linkages, re-stamp on a fresh finding object,
  // recordRun (which deletes prior + re-inserts)
  const linkages = store.getCorrectionLinkages({ teamId: 'team-a' });
  const f1Fresh = { ...f1, correctionTaskId: linkages.get('f1') };
  store.recordRun({
    runId: 'r2', teamId: 'team-a', asOf: 'now2', teamScore: 30,
    status: 'warning', categoryScores: {}, perTaskScores: {},
    trigger: 'periodic', findings: [f1Fresh],
  });

  const after = store.getCorrectionLinkages({ teamId: 'team-a' });
  assert.equal(after.get('f1'), created.taskId, 'linkage preserved across recordRun');
});
