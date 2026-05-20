// Pure (Readability Layer-2 P3b-1). span -> {systemPrompt,userPayload}.
// Reuses P1's already-narrated row `line` verbatim — NEVER re-narrates.
// Total: missing/odd input degrades, never throws.
import { SUMMARIZER_SYSTEM_PROMPT } from './summarizerSystemPrompt.js';

export function buildSummaryPrompt(span) {
  const s = span && typeof span === 'object' ? span : {};
  const agentId = typeof s.agentId === 'string' ? s.agentId : 'unknown';
  const runtimeId = typeof s.runtimeId === 'string' ? s.runtimeId : 'unknown';
  const startedAt = typeof s.startedAt === 'string' ? s.startedAt : '';
  const endedAt = typeof s.endedAt === 'string' ? s.endedAt : '';
  const rows = Array.isArray(s.rows) ? s.rows : [];
  const lines = rows
    .map((r) => `- ${r && r.line != null ? String(r.line) : ''}`)
    .join('\n');
  const header = `Agent ${agentId} on runtime ${runtimeId}, ${startedAt} – ${endedAt}:`;
  return {
    systemPrompt: SUMMARIZER_SYSTEM_PROMPT,
    userPayload: lines ? `${header}\n${lines}` : header,
  };
}
