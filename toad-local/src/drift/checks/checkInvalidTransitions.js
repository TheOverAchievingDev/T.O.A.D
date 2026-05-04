import { validateTaskStatusTransition } from '../../task/taskLifecycle.js';
import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_invalid_transitions';
const CATEGORY = 'architecture';

/**
 * Replay each task's status_changed events and flag any pair the lifecycle
 * doesn't allow. One finding per illegal transition (not per task), so a
 * task with two bad jumps produces two findings.
 */
export function checkInvalidTransitions({ snapshot } = {}) {
  if (!snapshot) return [];
  const events = Array.isArray(snapshot.taskEvents) ? snapshot.taskEvents : [];
  const findings = [];

  // Group status_changed events by task.
  const byTask = new Map();
  for (const e of events) {
    if (e.eventType !== 'task.status_changed') continue;
    if (!e.taskId) continue;
    if (!byTask.has(e.taskId)) byTask.set(e.taskId, []);
    byTask.get(e.taskId).push(e);
  }

  for (const [taskId, list] of byTask) {
    list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    for (const ev of list) {
      const from = ev.payload?.from;
      const to = ev.payload?.to;
      if (typeof from !== 'string' || typeof to !== 'string') continue;
      const verdict = validateTaskStatusTransition({ from, to });
      if (verdict.ok) continue;
      findings.push({
        id: stableFindingId({
          checkName: CHECK_NAME, category: CATEGORY, taskId,
          salient: `${from}->${to}@${ev.createdAt}`,
        }),
        runId: '',
        teamId: snapshot.teamId,
        taskId,
        category: CATEGORY,
        severity: 'high',
        checkName: CHECK_NAME,
        title: `Task ${taskId} took an illegal lifecycle transition`,
        evidence: [`task ${taskId}: ${from} → ${to} at ${ev.createdAt}`],
        expected: `legal transition out of "${from}" (${verdict.reason ?? 'see taskLifecycle.ALLOWED_TRANSITIONS'})`,
        actual: `${from} → ${to}`,
        recommendedCorrection: `Roll task ${taskId} back to "${from}" or to a legal next state.`,
        autoFixable: false,
      });
    }
  }
  return findings;
}
