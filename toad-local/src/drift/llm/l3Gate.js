import { createHash } from 'node:crypto';

function sha1(s) { return createHash('sha1').update(String(s)).digest('hex'); }
function norm(s) {
  // Whitespace-stable: collapse runs of horizontal whitespace and trim
  // each line, drop trailing blank lines. The judge reasons about what
  // the code says, not diff formatting — so format churn must not bust
  // the verdict cache, but a real token change must.
  return String(s ?? '')
    .split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n+$/, '');
}

/** sha1 over sorted (file, sha1(normalized content)) pairs. */
export function diffHash(files) {
  const rows = (Array.isArray(files) ? files : [])
    .map((f) => `${f.file} ${sha1(norm(f.content))}`)
    .sort();
  return sha1(rows.join(''));
}

/** sha1 over the exact cache-invalidating provenance fields. */
export function specProvenanceHash(spec) {
  const p = spec && spec.provenance ? spec.provenance : {};
  return sha1(JSON.stringify({
    version: spec ? spec.version : undefined,
    reviewed: p.reviewed === true,
    extracted_at: p.extracted_at ?? null,
    extracted_by: p.extracted_by ?? null,
  }));
}

/** Order-independent sha1 over the finding fields that affect L3 input. */
export function l1FindingSetHash(findings) {
  const rows = (Array.isArray(findings) ? findings : []).map((f) => JSON.stringify({
    checkName: f.checkName ?? null, severity: f.severity ?? null,
    file: f.file ?? null, line: f.line ?? null, ruleId: f.ruleId ?? null,
    needsSemanticReview: f.needsSemanticReview === true,
  })).sort();
  return sha1(rows.join(''));
}

export function l3PromptHash(promptTemplate) { return sha1(promptTemplate ?? ''); }

export function l3CacheKey({ diffFiles, spec, l1Findings, promptTemplate } = {}) {
  return sha1([
    diffHash(diffFiles), specProvenanceHash(spec),
    l1FindingSetHash(l1Findings), l3PromptHash(promptTemplate),
  ].join('|'));
}

/** Slice-B stub. Slice B replaces ONLY this body (design §2). */
export function silentButSignificant(/* { snapshot, boundaryTaskId } */) {
  return false;
}

const SUBMISSION = new Set(['review', 'merge_ready', 'done']);

/**
 * Pure decision. The engine owns the verdict cache + rate window
 * (in-memory, like #tier2Cooldown) and passes `cacheHasKey`. Returns
 * one of: invoke | serve_cached | skip, with a reason.
 *
 * STEP ORDERING IS DELIBERATE AND NON-NEGOTIABLE: cheapest field
 * compares first (steps 1-3), the L1-findings walk next (step 4), the
 * caller's precomputed cache lookup last (step 5). The common case
 * (periodic, no L3) rejects in a single comparison. DO NOT reorder
 * "cache first to fail-fast on hits" — that defeats the §8a cost
 * discipline by forcing hash computation on runs that step 1 rejects.
 */
export function l3Gate({
  trigger, boundaryTo, boundaryTaskId, l1FindingsForTask, cacheHasKey,
  silentSignificant = false,
} = {}) {
  if (trigger === 'periodic') return { action: 'skip', reason: 'periodic' };
  if (trigger === 'task_event' && !SUBMISSION.has(boundaryTo)) {
    return { action: 'skip', reason: 'non_submission_status' };
  }
  if (trigger !== 'manual' && trigger !== 'task_event') {
    return { action: 'skip', reason: 'untriggered' };
  }
  if (typeof boundaryTaskId !== 'string' || boundaryTaskId.length === 0) {
    return { action: 'skip', reason: 'no_boundary_task' };
  }
  const flagged = Array.isArray(l1FindingsForTask)
    && l1FindingsForTask.some((f) => f && f.needsSemanticReview === true);
  const ambiguous = flagged || silentSignificant === true;
  if (!ambiguous) return { action: 'skip', reason: 'not_ambiguous' };
  if (trigger === 'manual') return { action: 'invoke', reason: 'manual_bypass' };
  if (cacheHasKey === true) return { action: 'serve_cached', reason: 'cache_hit' };
  return { action: 'invoke', reason: 'ambiguous' };
}
