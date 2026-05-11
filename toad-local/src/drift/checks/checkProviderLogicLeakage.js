import { stableFindingId } from './_findingId.js';

const CHECK_NAME = 'check_provider_logic_leakage';
const CATEGORY = 'architecture';

const PROTECTED_PATH_RES = [
  /^src\/broker\//,
  /^src\/task\//,
  /^src\/team\//,
  /^src\/security\//,
  /^src\/policy\//,
  /^src\/read\//,
  /^src\/storage\//,
  /^src\/delivery\//,
];

const PROVIDER_IMPORT_RES = [
  /from\s+['"]@anthropic-ai\//,
  /require\(['"]@anthropic-ai\//,
  /from\s+['"]openai['"]/,
  /require\(['"]openai['"]/,
  /from\s+['"]@google\/generative-ai['"]/,
  /require\(['"]@google\/generative-ai['"]/,
  /from\s+['"]@lydell\/node-pty['"]/,
  /require\(['"]@lydell\/node-pty['"]/,
];

/**
 * Static path+import heuristic. The diff entry must populate
 * `fileContents[path]` for the changed file's text; skipped silently when
 * contents aren't available. buildSnapshot does NOT yet enrich fileContents
 * (slice-2 follow-up) — production runs will see zero findings until that
 * lands. The check is wired and tested today so it activates seamlessly.
 */
export function checkProviderLogicLeakage({ snapshot } = {}) {
  if (!snapshot) return [];
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const diffs = snapshot.diffsByTask ?? {};
  const findings = [];

  for (const task of tasks) {
    if (!task || !task.taskId) continue;
    const diff = diffs[task.taskId];
    if (!diff || typeof diff.fileContents !== 'object') continue;
    const changed = Array.isArray(diff.changedFiles) ? diff.changedFiles : [];
    for (const file of changed) {
      if (!PROTECTED_PATH_RES.some((re) => re.test(file))) continue;
      const text = diff.fileContents[file];
      if (typeof text !== 'string' || text.length === 0) continue;
      const matches = PROVIDER_IMPORT_RES.filter((re) => re.test(text));
      if (matches.length === 0) continue;
      const matchedSnippet = text
        .split('\n')
        .find((line) => PROVIDER_IMPORT_RES.some((re) => re.test(line)))
        ?.trim() ?? '(provider import detected)';
      findings.push({
        id: stableFindingId({
          teamId: snapshot.teamId,
          checkName: CHECK_NAME, category: CATEGORY, taskId: task.taskId,
          salient: file,
        }),
        runId: '',
        teamId: snapshot.teamId,
        taskId: task.taskId,
        category: CATEGORY,
        severity: 'medium',
        checkName: CHECK_NAME,
        title: `Provider-specific import inside neutral path: ${file}`,
        evidence: [`task ${task.taskId} touched ${file}: ${matchedSnippet}`],
        expected: `${file} stays provider-neutral; provider SDKs live under src/providers/**`,
        actual: matchedSnippet,
        recommendedCorrection: `Move the provider call into src/providers/, expose a neutral interface, and have ${file} consume that interface.`,
        autoFixable: false,
      });
    }
  }
  return findings;
}
