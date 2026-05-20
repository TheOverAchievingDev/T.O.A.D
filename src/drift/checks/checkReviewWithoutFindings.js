import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_review_without_findings';
const CATEGORY = 'checklist';

/**
 * Catches "rubber-stamp" reviews — the review window opened, then closed
 * straight to testing with no review_feedback ever recorded. Severity is
 * low because some tasks legitimately need no feedback; the signal is
 * useful in aggregate but not a hard violation.
 */
export function checkReviewWithoutFindings({ snapshot } = {}) {
  if (!snapshot) return [];
  const events = Array.isArray(snapshot.taskEvents) ? snapshot.taskEvents : [];
  const findings = [];

  const byTask = new Map();
  for (const e of events) {
    if (!e.taskId) continue;
    if (!byTask.has(e.taskId)) byTask.set(e.taskId, []);
    byTask.get(e.taskId).push(e);
  }

  for (const [taskId, list] of byTask) {
    // byTask values are fresh arrays we built — sort-in-place is safe.
    list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    let enterReview = null;
    for (const ev of list) {
      if (ev.eventType !== 'task.status_changed') continue;
      const from = ev.payload?.from;
      const to = ev.payload?.to;
      if (to === 'review') enterReview = ev.createdAt;
      else if (from === 'review' && to === 'testing' && enterReview) {
        const start = enterReview;
        const end = ev.createdAt;
        const fbCount = list.filter((x) =>
          x.eventType === 'task.review_feedback' &&
          Date.parse(x.createdAt) >= Date.parse(start) &&
          Date.parse(x.createdAt) <= Date.parse(end)
        ).length;
        if (fbCount === 0) {
          findings.push({
            id: stableFindingId({
              teamId: snapshot.teamId,
              checkName: CHECK_NAME, category: CATEGORY, taskId,
              salient: `${start}->${end}`,
            }),
            runId: '',
            teamId: snapshot.teamId,
            taskId,
            category: CATEGORY,
            severity: 'low',
            checkName: CHECK_NAME,
            title: `Task ${taskId} review closed with zero feedback`,
            evidence: [`task ${taskId}: review window ${start} → ${end} produced 0 review_feedback events`],
            expected: 'at least one review_feedback (any severity) before review → testing',
            actual: 'review → testing with no feedback recorded',
            recommendedCorrection: `Confirm the review actually happened. If yes, file a "no findings" review_feedback; if no, roll task ${taskId} back to review.`,
            autoFixable: false,
          });
        }
        enterReview = null;
      }
    }
  }
  return findings;
}
