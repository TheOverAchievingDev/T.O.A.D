import { stableFindingId } from './_findingId.js';
import { llmJudge as defaultLlmJudge } from '../llm/llmJudge.js';
import { resolveProvider } from '../llm/providerResolver.js';
import { buildTier1SystemPrompt } from '../llm/prompts/tier1.js';
import { buildTier2SystemPrompt } from '../llm/prompts/tier2.js';

/**
 * LLM semantic check. Async — calls a provider CLI in one-shot mode.
 *
 * Returns DriftFinding[] (possibly empty). On judge failure, returns
 * a single meta-finding describing the failure (engine surfaces this
 * to the UI as the tier-2 status banner).
 *
 * Tier 1 caps severity at "high" — only tier 2 is allowed to emit
 * "critical" per the spec (§11 risk).
 */
export async function checkLlmSemantic({
  snapshot,
  settings,
  tier,
  tier1Findings = [], // tier 2 only — for context in the prompt
  llmJudgeImpl,
} = {}) {
  if (!snapshot) return [];
  if (tier !== 1 && tier !== 2) {
    throw new TypeError(`checkLlmSemantic: tier must be 1 or 2 (got ${tier})`);
  }

  const judge = llmJudgeImpl || defaultLlmJudge;
  const checkName = tier === 1 ? 'check_llm_semantic_t1' : 'check_llm_semantic_t2';

  let provider;
  try {
    provider = resolveProvider({
      teamConfig: snapshot.teamConfig,
      settings,
      tier,
    });
  } catch (err) {
    return [makeMetaFinding(snapshot.teamId, checkName, 'provider_resolve_failed',
      err && err.message ? err.message : String(err))];
  }

  const systemPrompt = tier === 1
    ? buildTier1SystemPrompt(snapshot)
    : buildTier2SystemPrompt(snapshot);
  const userPayload = buildUserPayload(snapshot, tier === 2 ? tier1Findings : null);

  let result;
  try {
    result = await judge({
      cli: provider.cli,
      model: provider.model,
      systemPrompt,
      userPayload,
      timeoutMs: 30_000,
    });
  } catch (err) {
    return [makeMetaFinding(snapshot.teamId, checkName, 'judge_failed',
      err && err.message ? err.message : String(err))];
  }

  // Stamp + cap-severity-at-high for tier 1.
  return result.findings.map((f) => ({
    id: stableFindingId({
      teamId: snapshot.teamId,
      checkName, category: f.category,
      taskId: f.taskId ?? null,
      salient: f.title,
    }),
    runId: '',
    teamId: snapshot.teamId,
    taskId: f.taskId ?? null,
    category: f.category,
    severity: tier === 1 && f.severity === 'critical' ? 'high' : f.severity,
    checkName,
    title: f.title,
    evidence: f.evidence,
    expected: f.expected,
    actual: f.actual,
    recommendedCorrection: f.recommendedCorrection,
    autoFixable: false,
  }));
}

function makeMetaFinding(teamId, checkName, code, detail) {
  return {
    id: stableFindingId({
      teamId,
      checkName,
      category: 'risk',
      taskId: null,
      salient: `failed:${code}`,
    }),
    runId: '',
    teamId,
    taskId: null,
    category: 'risk',
    severity: 'medium',
    checkName,
    title: `LLM judge failed (${code})`,
    evidence: [detail],
    expected: 'judge returns DriftFinding[]',
    actual: `judge threw: ${detail}`,
    recommendedCorrection: 'Inspect logs; verify the provider CLI is installed + authenticated.',
    autoFixable: false,
  };
}

export function buildUserPayload(snapshot, tier1Findings) {
  const lines = [];
  lines.push(`# Team: ${snapshot.teamId}`);
  lines.push(`# As-of: ${snapshot.asOf}`);
  lines.push('');

  // Tasks (cap to 20 most-recent in full schema; older summarized)
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const recent = tasks.slice(0, 20);
  const older = tasks.slice(20);
  lines.push(`## Tasks (${recent.length} of ${tasks.length} shown)`);
  for (const t of recent) {
    lines.push(`- ${t.taskId} [${t.status}] "${t.subject ?? ''}"`);
    if (t.allowedFiles?.length) lines.push(`  allowedFiles: ${t.allowedFiles.join(', ')}`);
    if (t.forbiddenFiles?.length) lines.push(`  forbiddenFiles: ${t.forbiddenFiles.join(', ')}`);
    if (t.testCommands?.length) lines.push(`  testCommands: ${t.testCommands.join(' ; ')}`);
    if (t.acceptanceCriteria?.length) lines.push(`  acceptanceCriteria: ${JSON.stringify(t.acceptanceCriteria)}`);
  }
  if (older.length > 0) {
    const counts = {};
    for (const t of older) counts[t.status] = (counts[t.status] || 0) + 1;
    lines.push(`(older: ${JSON.stringify(counts)})`);
  }
  lines.push('');

  // Recent task events (last 50)
  const taskEvents = Array.isArray(snapshot.taskEvents) ? snapshot.taskEvents : [];
  const recentTaskEvents = taskEvents.slice(-50);
  lines.push(`## Recent task events (last ${recentTaskEvents.length})`);
  for (const e of recentTaskEvents) {
    const t = e.createdAt?.slice(11, 16) ?? '';
    lines.push(`- ${t} ${e.taskId ?? ''} ${e.eventType} ${JSON.stringify(e.payload ?? {})}`);
  }
  lines.push('');

  // Recent runtime events (last 50)
  const runtimeEvents = Array.isArray(snapshot.runtimeEvents) ? snapshot.runtimeEvents : [];
  const recentRuntimeEvents = runtimeEvents.slice(-50);
  lines.push(`## Recent runtime events (last ${recentRuntimeEvents.length})`);
  for (const e of recentRuntimeEvents) {
    const t = e.createdAt?.slice(11, 16) ?? '';
    lines.push(`- ${t} ${e.eventType} ${JSON.stringify(e.payload ?? {})}`);
  }
  lines.push('');

  // Baseline section: branches on snapshot shape.
  // When buildSnapshot ran in current_state mode it populates
  // snapshot.currentStateContext; foundry_docs mode leaves it null
  // and populates snapshot.foundryDocs instead.
  if (snapshot.currentStateContext) {
    const ctx = snapshot.currentStateContext;
    lines.push('## Current codebase context');
    const commits = Array.isArray(ctx.recentCommits) ? ctx.recentCommits : [];
    if (commits.length > 0) {
      lines.push(`### Recent commits (newest first, last ${commits.length})`);
      for (const c of commits) lines.push(`- ${c}`);
      lines.push('');
    }
    const projectDocs = ctx.projectDocs || {};
    const docNames = Object.keys(projectDocs);
    if (docNames.length > 0) {
      lines.push('### Project documentation');
      for (const [name, content] of Object.entries(projectDocs)) {
        if (typeof content !== 'string' || content.length === 0) continue;
        lines.push(`#### ${name}`);
        lines.push(content);
        lines.push('');
      }
    }
  } else {
    // Foundry docs (full content) — original behavior
    lines.push('## Foundry docs');
    for (const [key, content] of Object.entries(snapshot.foundryDocs ?? {})) {
      if (typeof content !== 'string' || content.length === 0) continue;
      lines.push(`### ${key}.md`);
      lines.push(content);
      lines.push('');
    }
  }

  // Tier-2 only: include tier-1 findings as baseline
  if (Array.isArray(tier1Findings) && tier1Findings.length > 0) {
    lines.push('## Tier-1 findings (your baseline — confirm/refute/augment)');
    for (const f of tier1Findings) {
      lines.push(`- [${f.severity}] ${f.checkName}: ${f.title}`);
      lines.push(`  expected: ${f.expected}`);
      lines.push(`  actual: ${f.actual}`);
      if (f.evidence?.length) lines.push(`  evidence: ${f.evidence.join(' | ')}`);
    }
  }

  return lines.join('\n');
}
