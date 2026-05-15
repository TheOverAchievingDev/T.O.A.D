import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { stableFindingId } from './_findingId.js';
import { llmJudge as defaultLlmJudge } from '../llm/llmJudge.js';
import { resolveProvider } from '../llm/providerResolver.js';
import { buildTier1SystemPrompt } from '../llm/prompts/tier1.js';
import { buildTier2SystemPrompt } from '../llm/prompts/tier2.js';

/**
 * Hard budget for the brief.md the judge reads. The 2026-05-15 bug:
 * Claude --print kept rejecting drift runs with "Prompt is too long"
 * even after we moved to file-based transport. Forensic accounting on
 * a real project:
 *
 *   foundry docs (full content):   36 KB   ← dominant
 *   task diffs (recent slice):     12 KB
 *   recent events (50 each):       18 KB
 *   tasks + headers:                2 KB
 *   = ~68 KB → ~17K tokens
 *
 * Plus claude's tool descriptions (~10K tokens for the default
 * native-tool set) + system prompt + Read tool result framing,
 * the total request was hitting the model's prompt cap. Anthropic
 * counts the Read tool result against context, so even though our
 * BRIEF was "small" by file standards, the assembled prompt
 * exceeded haiku's effective limit.
 *
 * 24 KB ≈ 6K tokens — plenty for the judge's actual reasoning needs
 * (current tasks + recent activity + baseline doc highlights),
 * leaves substantial headroom for tool descriptions + Read overhead.
 * Per-section caps in buildUserPayload prevent any one section from
 * eating the budget alone.
 */
const PAYLOAD_BUDGET_BYTES = 24 * 1024;

/** Per-foundry-doc cap. Most foundry docs are 1-6 KB; tech-spec.md
 *  trends toward 10-15 KB on real projects. The judge needs the
 *  decisions and principles, not exhaustive prose — 3 KB captures
 *  the structural content (headings + ADR statements + DoD checks)
 *  on every doc we've measured. Each doc that exceeds the cap gets
 *  a "[doc continues — N chars elided]" marker so the judge knows. */
const PER_FOUNDRY_DOC_BUDGET = 3 * 1024;

function trimPayloadIfOversize(payload) {
  if (typeof payload !== 'string') return '';
  if (Buffer.byteLength(payload, 'utf-8') <= PAYLOAD_BUDGET_BYTES) return payload;
  // Drop runtime-event lines first (`## Recent runtime events`) — those
  // are the bloat on real projects (each turn_completed frame is fat).
  // Then drop task-event lines. Then drop foundry-doc tails. The
  // section headers + tasks + at least the latest few events survive.
  const lines = payload.split('\n');
  const sectionStarts = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith('## Recent runtime events')) sectionStarts.push({ kind: 'runtime', i });
    else if (lines[i].startsWith('## Recent task events')) sectionStarts.push({ kind: 'task', i });
  }
  for (const start of sectionStarts) {
    // Drop oldest event lines (closest after the header) until we fit
    // or the section is empty. Event lines begin with `- ` (markdown
    // bullet); the header line and blank lines stay.
    let cursor = start.i + 1;
    while (Buffer.byteLength(lines.join('\n'), 'utf-8') > PAYLOAD_BUDGET_BYTES) {
      if (cursor >= lines.length || !lines[cursor].startsWith('- ')) break;
      lines[cursor] = '';
      cursor += 1;
    }
    if (Buffer.byteLength(lines.join('\n'), 'utf-8') <= PAYLOAD_BUDGET_BYTES) break;
  }
  let trimmed = lines.filter((l, idx) => l !== '' || idx === 0 || lines[idx - 1] !== '').join('\n');
  if (Buffer.byteLength(trimmed, 'utf-8') > PAYLOAD_BUDGET_BYTES) {
    // Hard cap: truncate to the budget with an explicit marker so the
    // judge knows context was elided (better than mysterious truncation).
    const buf = Buffer.from(trimmed, 'utf-8').slice(0, PAYLOAD_BUDGET_BYTES - 128);
    trimmed = `${buf.toString('utf-8')}\n\n[... truncated to fit ${PAYLOAD_BUDGET_BYTES} byte budget ...]`;
  }
  return trimmed;
}

/**
 * Cap a single foundry doc to PER_FOUNDRY_DOC_BUDGET. The judge needs
 * the structural content (heading hierarchy + ADR statements) more
 * than the prose around them, so we keep the start (which usually
 * carries the most-important framing) and append an explicit marker.
 *
 * If the doc is small enough, returns it unchanged. We don't try to
 * be smart about WHERE to cut — Claude's reasoning tolerates a hard
 * truncation marker better than mid-sentence chops.
 */
function trimFoundryDoc(content) {
  if (typeof content !== 'string' || content.length === 0) return '';
  const bytes = Buffer.byteLength(content, 'utf-8');
  if (bytes <= PER_FOUNDRY_DOC_BUDGET) return content;
  const buf = Buffer.from(content, 'utf-8').slice(0, PER_FOUNDRY_DOC_BUDGET - 64);
  return `${buf.toString('utf-8')}\n\n[doc continues — ${bytes - PER_FOUNDRY_DOC_BUDGET} bytes elided to fit brief budget]`;
}

/**
 * Write the brief to a fresh tempdir and return the dir + brief path.
 * The judge's CLI process gets this dir as its cwd so any unintended
 * filesystem access is bounded to the brief itself.
 */
function writeBriefToTempDir(payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'symphony-drift-'));
  const briefPath = path.join(dir, 'brief.md');
  fs.writeFileSync(briefPath, payload, 'utf-8');
  return { dir, briefPath };
}

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
  const fullPayload = buildUserPayload(snapshot, tier === 2 ? tier1Findings : null);
  const userPayload = trimPayloadIfOversize(fullPayload);

  // File-based transport: write the trimmed payload to a tempdir and
  // tell the CLI to Read it. Sidesteps the "Prompt is too long" error
  // we used to hit when the user payload exceeded the CLI's stdin
  // prompt limit (Claude tripped this at ~20KB on real projects).
  // Tempdir is the judge's cwd so blast radius is bounded if
  // --dangerously-skip-permissions enables the Read tool.
  let briefDir = null;
  let briefPath = null;
  try {
    const written = writeBriefToTempDir(userPayload);
    briefDir = written.dir;
    briefPath = written.briefPath;
  } catch (err) {
    // Couldn't write the brief — fall back to inline stdin. The
    // judge may still hit "Prompt is too long" but at least we try.
    // eslint-disable-next-line no-console
    console.warn('[drift] could not write brief file, falling back to inline transport:', err?.message || err);
  }

  let result;
  try {
    result = await judge({
      cli: provider.cli,
      model: provider.model,
      systemPrompt,
      userPayload,
      briefPath,
      cwd: briefDir,
      timeoutMs: 30_000,
    });
  } catch (err) {
    return [makeMetaFinding(snapshot.teamId, checkName, 'judge_failed',
      err && err.message ? err.message : String(err))];
  } finally {
    // Best-effort cleanup. The tempdir is small (a few KB to ~80KB)
    // so leaving it on a failure path isn't a problem, but tidying is
    // polite and avoids cluttering /tmp on long-running operators.
    if (briefDir) {
      try { fs.rmSync(briefDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
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

  // Task diffs (current work vs baseRef per worktree).
  //
  // THIS is the section that makes the drift judge a real drift judge.
  // Without it, the judge only sees descriptions of what agents claim
  // to be doing — it can't compare CODE against the spec, only narrative
  // against the spec. The 2026-05-15 alignment fix: snapshot.diffsByTask
  // is already computed by buildSnapshot from each task's worktree;
  // we just need to feed it to the judge.
  //
  // Per-file content is truncated to keep the brief bounded (the soft
  // 80 KB trim later still drops oldest events if we overshoot). The
  // judge can ask for more detail in evidence cites that name files.
  const diffsByTask = snapshot.diffsByTask && typeof snapshot.diffsByTask === 'object'
    ? snapshot.diffsByTask
    : {};
  const tasksWithDiffs = recent.filter((t) => diffsByTask[t.taskId]);
  if (tasksWithDiffs.length > 0) {
    lines.push(`## Task diffs (current work vs base ref — ${tasksWithDiffs.length} task${tasksWithDiffs.length === 1 ? '' : 's'} with changes)`);
    lines.push('Compare each diff against the relevant Foundry doc (steering / tech_spec / design_decisions) and the task\'s declared allowedFiles + acceptanceCriteria. Flag drift where the code diverges from the spec.');
    for (const task of tasksWithDiffs) {
      const d = diffsByTask[task.taskId];
      lines.push('');
      lines.push(`### ${task.taskId} [${task.status}] "${task.subject ?? ''}"`);
      const changedFiles = Array.isArray(d.changedFiles) ? d.changedFiles : [];
      if (changedFiles.length > 0) {
        const fileList = changedFiles.length > 30
          ? `${changedFiles.slice(0, 30).join(', ')}, … (+${changedFiles.length - 30} more)`
          : changedFiles.join(', ');
        lines.push(`Changed files (${changedFiles.length}): ${fileList}`);
      }
      if (d.error) {
        lines.push(`Diff error: ${d.error}`);
        continue;
      }
      const diffBody = typeof d.diff === 'string' ? d.diff : '';
      if (diffBody.length === 0) {
        lines.push('(no diff content)');
        continue;
      }
      // Per-task diff cap: 1500 chars ≈ 375 tokens. Tighter than
      // initially shipped (was 4000) because the 24 KB total brief
      // budget needs room for foundry docs + events + multiple tasks.
      // 1500 chars still captures several changed-line contexts;
      // for tasks with huge diffs the judge gets a truncation marker
      // and can cite filepaths in evidence to request a deeper look
      // (future agentic-judge path).
      const cap = 1500;
      if (diffBody.length <= cap) {
        lines.push('```diff');
        lines.push(diffBody);
        lines.push('```');
      } else {
        lines.push('```diff');
        lines.push(diffBody.slice(0, cap));
        lines.push(`… (truncated, ${diffBody.length - cap} chars elided — ask for a specific file by name to see more)`);
        lines.push('```');
      }
    }
    lines.push('');
  }

  // Recent task events (last 20). Was 50; reduced 2026-05-15 to fit
  // the tighter 24KB brief budget. Most drift signal comes from the
  // very latest transitions anyway — by event 20 we're well past the
  // current state. Each event line is also capped at 240 chars so a
  // single fat payload (e.g. a long plan body) can't blow the section
  // budget on its own.
  const taskEvents = Array.isArray(snapshot.taskEvents) ? snapshot.taskEvents : [];
  const recentTaskEvents = taskEvents.slice(-20);
  lines.push(`## Recent task events (last ${recentTaskEvents.length})`);
  for (const e of recentTaskEvents) {
    const t = e.createdAt?.slice(11, 16) ?? '';
    const payloadJson = JSON.stringify(e.payload ?? {});
    const payloadTrimmed = payloadJson.length > 240
      ? `${payloadJson.slice(0, 240)}…(+${payloadJson.length - 240})`
      : payloadJson;
    lines.push(`- ${t} ${e.taskId ?? ''} ${e.eventType} ${payloadTrimmed}`);
  }
  lines.push('');

  // Recent runtime events (last 20). Same reduction as task events.
  // Each turn_completed frame can be 5-10KB raw; even 20 of them
  // would exceed the budget without per-line trimming. 240 chars
  // captures the event type + summary without the full stream-json
  // body, which the judge rarely needs for drift detection.
  const runtimeEvents = Array.isArray(snapshot.runtimeEvents) ? snapshot.runtimeEvents : [];
  const recentRuntimeEvents = runtimeEvents.slice(-20);
  lines.push(`## Recent runtime events (last ${recentRuntimeEvents.length})`);
  for (const e of recentRuntimeEvents) {
    const t = e.createdAt?.slice(11, 16) ?? '';
    const payloadJson = JSON.stringify(e.payload ?? {});
    const payloadTrimmed = payloadJson.length > 240
      ? `${payloadJson.slice(0, 240)}…(+${payloadJson.length - 240})`
      : payloadJson;
    lines.push(`- ${t} ${e.eventType} ${payloadTrimmed}`);
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
    // Foundry docs — each capped at PER_FOUNDRY_DOC_BUDGET (3 KB).
    // Real foundry docs trend large: tech-spec.md ran 12 KB on a
    // measured project, product-brief was 6 KB. Stuffing all 7 docs
    // full-fat (~36 KB total) blew the brief budget and caused the
    // 2026-05-15 "Prompt is too long" failures even with file-based
    // transport. The per-doc trim keeps the structural content (the
    // first ~3 KB of each, which carries the headings + ADR statements
    // + DoD items) and appends an explicit elision marker.
    lines.push('## Foundry docs');
    for (const [key, content] of Object.entries(snapshot.foundryDocs ?? {})) {
      if (typeof content !== 'string' || content.length === 0) continue;
      lines.push(`### ${key}.md`);
      lines.push(trimFoundryDoc(content));
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
