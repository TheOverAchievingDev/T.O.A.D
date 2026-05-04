import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_out_of_scope_files';
const CATEGORY = 'slice_scope';
const ACTIVE_STATUSES = new Set(['in_progress', 'review', 'testing', 'merge_ready']);

/**
 * Compares each active task's diff against its declared scope contract.
 * A change is out-of-scope when:
 *   (a) any forbiddenFiles glob matches it, OR
 *   (b) allowedFiles is non-empty AND no allowedFiles glob matches it.
 *
 * A task with both arrays empty has no scope contract — no findings.
 */
export function checkOutOfScopeFiles({ snapshot } = {}) {
  if (!snapshot) return [];
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const diffs = snapshot.diffsByTask ?? {};
  const findings = [];

  for (const task of tasks) {
    if (!task || !task.taskId) continue;
    if (!ACTIVE_STATUSES.has(task.status)) continue;
    const allowed = Array.isArray(task.allowedFiles) ? task.allowedFiles : [];
    const forbidden = Array.isArray(task.forbiddenFiles) ? task.forbiddenFiles : [];
    if (allowed.length === 0 && forbidden.length === 0) continue;

    const diff = diffs[task.taskId];
    const changed = Array.isArray(diff?.changedFiles) ? diff.changedFiles : [];

    for (const file of changed) {
      let outOfScope = false;
      if (forbidden.some((pat) => globMatch(pat, file))) outOfScope = true;
      else if (allowed.length > 0 && !allowed.some((pat) => globMatch(pat, file))) outOfScope = true;
      if (!outOfScope) continue;
      findings.push({
        id: stableFindingId({
          checkName: CHECK_NAME, category: CATEGORY, taskId: task.taskId,
          salient: file,
        }),
        runId: '',
        teamId: snapshot.teamId,
        taskId: task.taskId,
        category: CATEGORY,
        severity: 'medium',
        checkName: CHECK_NAME,
        title: `Task ${task.taskId} changed an out-of-scope file`,
        evidence: [
          `task ${task.taskId}: changed ${file}`,
          `allowed: ${allowed.length ? allowed.join(', ') : '(none)'}`,
          `forbidden: ${forbidden.length ? forbidden.join(', ') : '(none)'}`,
        ],
        expected: `changes only within: ${allowed.join(', ') || '(no contract)'}`,
        actual: `changed ${file}`,
        recommendedCorrection: `Move the change to a separate task whose scope includes "${file}", or update task ${task.taskId}'s allowedFiles.`,
        autoFixable: false,
      });
    }
  }
  return findings;
}

/**
 * Minimal glob: supports **, *, and literal segments. Same shape the
 * project's risk policy uses.
 */
function globMatch(pattern, file) {
  const re = new RegExp('^' + pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '@@DOUBLESTAR@@')
    .replace(/\*/g, '[^/]*')
    .replace(/@@DOUBLESTAR@@/g, '.*')
    + '$');
  return re.test(file);
}
