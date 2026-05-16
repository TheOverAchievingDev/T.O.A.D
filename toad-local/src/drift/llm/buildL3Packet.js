/**
 * Scoped L3 packet (PROJECT.md §8a; design §4.1). Replaces the paused
 * whole-team 24KB brief with: ONE task's diff + the whole spec.json
 * (compact canonical machine contract — NOT prose foundry docs) + the
 * L1 signal being adjudicated.
 *
 * Enforced budget: if assembled bytes exceed the budget we return an
 * overBudget signal — NEVER a truncated packet. Truncation is exactly
 * what recreated the 2026-05-15 prompt-cap cascade; the caller emits
 * an honest meta + skips the spawn instead.
 */
export const L3_PACKET_BUDGET_BYTES = 32 * 1024;

export function buildL3Packet({ snapshot, boundaryTaskId, l1Signal, budgetBytes = L3_PACKET_BUDGET_BYTES } = {}) {
  const lines = [];
  lines.push(`# L3 scoped adjudication — team ${snapshot?.teamId ?? '?'} task ${boundaryTaskId}`);
  lines.push('');

  lines.push('## The change (this task only)');
  const d = snapshot?.diffsByTask?.[boundaryTaskId] || null;
  if (!d || (typeof d.diff !== 'string' && !Array.isArray(d.changedFiles))) {
    lines.push('(no diff available for this task)');
  } else {
    const files = Array.isArray(d.changedFiles) ? d.changedFiles : [];
    if (files.length > 0) lines.push(`Changed files: ${files.join(', ')}`);
    if (d.error) lines.push(`Diff error: ${d.error}`);
    const body = typeof d.diff === 'string' ? d.diff : '';
    lines.push('```diff');
    lines.push(body.length > 0 ? body : '(no diff content)');
    lines.push('```');
  }
  lines.push('');

  lines.push('## The contract (spec.json — the machine-checkable projection)');
  lines.push('```json');
  lines.push(JSON.stringify(snapshot?.spec ?? null, null, 2));
  lines.push('```');
  lines.push('');

  lines.push('## The deterministic L1 signal to adjudicate');
  lines.push('```json');
  lines.push(JSON.stringify(l1Signal ?? null, null, 2));
  lines.push('```');

  const packet = lines.join('\n');
  const bytes = Buffer.byteLength(packet, 'utf-8');
  if (bytes > budgetBytes) {
    const fileCount = Array.isArray(d?.changedFiles) ? d.changedFiles.length : 0;
    return { overBudget: true, bytes, fileCount };
  }
  return { packet, bytes };
}
