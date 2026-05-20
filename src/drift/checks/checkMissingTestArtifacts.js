import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_missing_test_artifacts';
const CATEGORY = 'test_truth';

const FALLBACK_TEST_PATTERNS = [
  /\b(npm|pnpm|yarn)\s+(test|run\s+test)\b/i,
  /\bpytest\b/i,
  /\bcargo\s+test\b/i,
  /\bgo\s+test\b/i,
  /\bnode\s+--test\b/i,
];

/**
 * For each task that transitioned testing → merge_ready, check whether a
 * Bash tool_call ran during the testing window. If the task declared
 * testCommands, look for an exact substring match. Otherwise fall back to
 * the generic test-runner regex set.
 */
export function checkMissingTestArtifacts({ snapshot } = {}) {
  if (!snapshot) return [];
  const events = Array.isArray(snapshot.taskEvents) ? snapshot.taskEvents : [];
  const tools = Array.isArray(snapshot.runtimeEvents) ? snapshot.runtimeEvents : [];
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const findings = [];

  const taskById = new Map();
  for (const t of tasks) if (t && t.taskId) taskById.set(t.taskId, t);

  // For each task, find pairs (enterTesting, leaveToMergeReady).
  const byTask = new Map();
  for (const e of events) {
    if (e.eventType !== 'task.status_changed') continue;
    if (!e.taskId) continue;
    if (!byTask.has(e.taskId)) byTask.set(e.taskId, []);
    byTask.get(e.taskId).push(e);
  }

  for (const [taskId, list] of byTask) {
    // byTask values are fresh arrays we built — sort-in-place is safe.
    list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    let enterTesting = null;
    for (const ev of list) {
      const from = ev.payload?.from;
      const to = ev.payload?.to;
      if (to === 'testing') enterTesting = ev.createdAt;
      else if (from === 'testing' && to === 'merge_ready' && enterTesting) {
        const start = enterTesting;
        const end = ev.createdAt;
        const declared = Array.isArray(taskById.get(taskId)?.testCommands)
          ? taskById.get(taskId).testCommands
          : [];
        const ran = ranTestCommand(tools, start, end, declared);
        if (!ran) {
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
            severity: 'high',
            checkName: CHECK_NAME,
            title: `Task ${taskId} reached merge_ready without running tests`,
            evidence: [
              `task ${taskId}: testing window ${start} → ${end}`,
              `declared testCommands: ${declared.length ? declared.join(', ') : '(none — falling back to runner regex)'}`,
            ],
            expected: declared.length
              ? `Bash tool_call running one of: ${declared.join(', ')}`
              : 'Bash tool_call matching a known test runner (npm/pnpm/yarn test, pytest, cargo test, go test, node --test)',
            actual: 'no matching Bash tool_call in the testing window',
            recommendedCorrection: `Roll task ${taskId} back to "testing" and require a real test run.`,
            autoFixable: false,
          });
        }
        enterTesting = null;
      }
    }
  }
  return findings;
}

function ranTestCommand(toolEvents, startISO, endISO, declared) {
  const startMs = Date.parse(startISO);
  const endMs = Date.parse(endISO);
  for (const e of toolEvents) {
    if (e.eventType !== 'tool_call') continue;
    if (e.payload?.toolName !== 'Bash') continue;
    const ms = Date.parse(e.createdAt);
    if (Number.isNaN(ms) || ms < startMs || ms > endMs) continue;
    const cmd = String(e.payload?.input?.command ?? '');
    if (declared.length > 0) {
      if (declared.some((d) => cmd.includes(d))) return true;
    } else {
      if (FALLBACK_TEST_PATTERNS.some((re) => re.test(cmd))) return true;
    }
  }
  return false;
}
