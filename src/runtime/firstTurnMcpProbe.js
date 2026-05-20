// A4: first-turn MCP-tool visibility probe (shared pure core). No IO,
// total, never-throws. Consumed by the 3 session adapters' first turn.
export const PROBE_SENTINEL = '\u27E6TOAD_MCP_OK\u27E7';

// Grounded from src/mcp/localToolDefinitions.js (Task 1 Step 1):
// agent_status is read-only (readOnlyHint:true), no required args,
// no idempotencyKey. The optional runtimeId property is harmless if omitted.
const PROBE_TOOL = 'agent_status';

export function buildProbeInstruction() {
  return [
    'TOAD MCP CONNECTIVITY CHECK (do this first, once):',
    `Before anything else, call the read-only TOAD MCP tool \`${PROBE_TOOL}\` (no arguments).`,
    `ONLY if that tool call returns successfully, include the exact token ${PROBE_SENTINEL} verbatim somewhere in your reply this turn.`,
    'If you cannot see or call that tool, do NOT emit the token. Then continue with the task normally.',
  ].join(' ');
}

export function evaluateFirstTurnProbe(events) {
  if (!Array.isArray(events)) return { satisfied: false, reason: 'no events' };
  for (const ev of events) {
    if (ev && ev.type === 'assistant_text' && typeof ev.text === 'string' && ev.text.includes(PROBE_SENTINEL)) {
      return { satisfied: true, reason: 'sentinel observed in assistant_text' };
    }
  }
  return { satisfied: false, reason: 'sentinel not observed in any first-turn assistant_text' };
}
