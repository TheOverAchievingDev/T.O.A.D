import test from 'node:test';
import assert from 'node:assert/strict';
import { createDriftCorrection } from '../../src/drift/driftCorrection.js';

function makeFakes() {
  const taskBoard = {
    created: [],
    create({ subject, description, riskLevel, teamId }) {
      const taskId = `task_${this.created.length + 1}`;
      const row = { taskId, teamId, subject, description, riskLevel, status: 'backlog' };
      this.created.push(row);
      return row;
    },
  };
  const driftStore = {
    linked: [],
    findingsByTeam: new Map(),
    setFindings(teamId, findings) { this.findingsByTeam.set(teamId, findings); },
    listLatestFindings({ teamId }) { return this.findingsByTeam.get(teamId) ?? []; },
    linkCorrection({ findingIds, correctionTaskId }) {
      this.linked.push({ findingIds, correctionTaskId });
      return { linked: findingIds.length };
    },
  };
  return { taskBoard, driftStore };
}

test('createDriftCorrection: creates task + links findings', async () => {
  const { taskBoard, driftStore } = makeFakes();
  driftStore.setFindings('team-a', [{ id: 'f1' }, { id: 'f2' }]);

  const result = await createDriftCorrection({
    teamId: 'team-a',
    findingIds: ['f1', 'f2'],
    subject: 'Fix lifecycle drift',
    description: 'Two findings need addressing',
    riskLevel: 'medium',
    taskBoard, driftStore,
  });

  assert.equal(result.taskId, 'task_1');
  assert.equal(result.linkedFindingCount, 2);
  assert.equal(result.riskLevel, 'medium');
  assert.equal(taskBoard.created.length, 1);
  assert.equal(taskBoard.created[0].subject, 'Fix lifecycle drift');
  assert.deepEqual(driftStore.linked[0].findingIds, ['f1', 'f2']);
  assert.equal(driftStore.linked[0].correctionTaskId, 'task_1');
});

test('createDriftCorrection: rejects empty findingIds', async () => {
  const { taskBoard, driftStore } = makeFakes();
  await assert.rejects(
    () => createDriftCorrection({
      teamId: 'team-a', findingIds: [], subject: 's', description: 'd',
      riskLevel: 'low', taskBoard, driftStore,
    }),
    /findingIds must be a non-empty array/i,
  );
});

test('createDriftCorrection: rejects bad riskLevel', async () => {
  const { taskBoard, driftStore } = makeFakes();
  driftStore.setFindings('team-a', [{ id: 'f1' }]);
  await assert.rejects(
    () => createDriftCorrection({
      teamId: 'team-a', findingIds: ['f1'], subject: 's', description: 'd',
      riskLevel: 'urgent', taskBoard, driftStore,
    }),
    /riskLevel must be/i,
  );
});

test('createDriftCorrection: rejects missing subject', async () => {
  const { taskBoard, driftStore } = makeFakes();
  driftStore.setFindings('team-a', [{ id: 'f1' }]);
  await assert.rejects(
    () => createDriftCorrection({
      teamId: 'team-a', findingIds: ['f1'], subject: '', description: 'd',
      riskLevel: 'low', taskBoard, driftStore,
    }),
    /subject is required/i,
  );
});

test('createDriftCorrection: rejects findingIds that don\'t belong to the team', async () => {
  const { taskBoard, driftStore } = makeFakes();
  driftStore.setFindings('team-a', [{ id: 'f1' }]);  // only f1 exists for team-a
  await assert.rejects(
    () => createDriftCorrection({
      teamId: 'team-a',
      findingIds: ['f1', 'f_unknown'],
      subject: 's', description: 'd', riskLevel: 'low',
      taskBoard, driftStore,
    }),
    /findings not in team|unknown finding/i,
  );
});

test('createDriftCorrection: does not link if task creation throws', async () => {
  const { taskBoard, driftStore } = makeFakes();
  driftStore.setFindings('team-a', [{ id: 'f1' }]);
  taskBoard.create = () => { throw new Error('task creation failed'); };

  await assert.rejects(
    () => createDriftCorrection({
      teamId: 'team-a', findingIds: ['f1'], subject: 's', description: 'd',
      riskLevel: 'low', taskBoard, driftStore,
    }),
    /task creation failed/,
  );
  assert.equal(driftStore.linked.length, 0);  // no linkage recorded
});
