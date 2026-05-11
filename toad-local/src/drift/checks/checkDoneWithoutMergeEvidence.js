import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_done_without_merge_evidence';
const CATEGORY = 'architecture';

/**
 * A task is "done" but never actually merged when:
 *   - the projected task.integration is null, AND
 *   - no task.integration_merged event exists in taskEvents for the task
 */
export function checkDoneWithoutMergeEvidence({ snapshot } = {}) {
  if (!snapshot) return [];
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const events = Array.isArray(snapshot.taskEvents) ? snapshot.taskEvents : [];
  const mergedTaskIds = new Set(
    events
      .filter((e) => e.eventType === 'task.integration_merged' && e.taskId)
      .map((e) => e.taskId)
  );
  const findings = [];

  for (const task of tasks) {
    if (!task || task.status !== 'done' || !task.taskId) continue;
    if (task.integration && typeof task.integration === 'object') continue;
    if (mergedTaskIds.has(task.taskId)) continue;
    findings.push({
      id: stableFindingId({
        teamId: snapshot.teamId,
        checkName: CHECK_NAME, category: CATEGORY, taskId: task.taskId,
        salient: 'no-merge',
      }),
      runId: '',
      teamId: snapshot.teamId,
      taskId: task.taskId,
      category: CATEGORY,
      severity: 'high',
      checkName: CHECK_NAME,
      title: `Task ${task.taskId} marked done without merge evidence`,
      evidence: [
        `task ${task.taskId}: status=done, integration=null`,
        `no task.integration_merged event found in taskEvents`,
      ],
      expected: 'task.integration set to a merge commit, or a task.integration_merged event present',
      actual: 'no merge commit recorded',
      recommendedCorrection: `Investigate task ${task.taskId} — was it manually marked done? Run merge or roll back to merge_ready.`,
      autoFixable: false,
    });
  }
  return findings;
}
