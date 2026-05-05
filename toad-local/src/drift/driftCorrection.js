const VALID_RISK = new Set(['low', 'medium', 'high']);

/**
 * Create a correction task for one or more drift findings, then link
 * the findings to the new task. Atomicity: if task creation throws,
 * NO findings are linked (we never call linkCorrection until the task
 * exists).
 *
 * Returns { taskId, linkedFindingCount, riskLevel }.
 *
 * @param {object} args
 * @param {string} args.teamId
 * @param {string[]} args.findingIds          one or more finding IDs
 * @param {string} args.subject               1-line task subject
 * @param {string} args.description           markdown description
 * @param {'low'|'medium'|'high'} args.riskLevel
 * @param {object} args.taskBoard             must implement .create({...}) -> {taskId, ...}
 * @param {object} args.driftStore            must implement .listLatestFindings({teamId}) + .linkCorrection({findingIds, correctionTaskId})
 */
export async function createDriftCorrection({
  teamId, findingIds, subject, description, riskLevel,
  taskBoard, driftStore,
} = {}) {
  if (!teamId || typeof teamId !== 'string') {
    throw new TypeError('createDriftCorrection: teamId is required');
  }
  if (!Array.isArray(findingIds) || findingIds.length === 0) {
    throw new TypeError('createDriftCorrection: findingIds must be a non-empty array');
  }
  if (typeof subject !== 'string' || subject.trim().length === 0) {
    throw new TypeError('createDriftCorrection: subject is required');
  }
  if (!VALID_RISK.has(riskLevel)) {
    throw new TypeError(`createDriftCorrection: riskLevel must be one of ${[...VALID_RISK].join('/')}`);
  }
  if (!taskBoard || typeof taskBoard.create !== 'function') {
    throw new TypeError('createDriftCorrection: taskBoard with create() required');
  }
  if (!driftStore || typeof driftStore.linkCorrection !== 'function'
      || typeof driftStore.listLatestFindings !== 'function') {
    throw new TypeError('createDriftCorrection: driftStore with listLatestFindings + linkCorrection required');
  }

  // Cross-team linkage guard — every findingId must belong to teamId.
  const teamFindings = driftStore.listLatestFindings({ teamId });
  const teamFindingIds = new Set(teamFindings.map((f) => f.id));
  const unknown = findingIds.filter((id) => !teamFindingIds.has(id));
  if (unknown.length > 0) {
    throw new Error(`createDriftCorrection: findings not in team: ${unknown.join(',')}`);
  }

  // Create task first; only link if creation succeeded.
  const task = await taskBoard.create({
    teamId,
    subject: subject.trim(),
    description: typeof description === 'string' ? description : '',
    riskLevel,
    source: 'drift_correction',
  });
  const taskId = task.taskId ?? task.id;
  if (!taskId) {
    throw new Error('createDriftCorrection: taskBoard.create did not return a taskId');
  }

  const linkResult = driftStore.linkCorrection({ findingIds, correctionTaskId: taskId });

  return {
    taskId,
    linkedFindingCount: linkResult.linked,
    riskLevel,
  };
}
