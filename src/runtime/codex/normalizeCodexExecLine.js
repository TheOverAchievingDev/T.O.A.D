// Pure, total, never-throws translation of ONE `codex exec --json`
// line into TOAD's existing normalized event vocabulary (the same
// vocabulary ClaudeStreamJsonAdapter emits, so the ingestor / drift /
// risk / review layers consume Codex identically). React-free, own
// local shapes, no @/ import — the flowCanvasModel/spanSummary
// pure-core precedent. The adapter is the thin IO shell around this.
//
// RATIFIED 2026-05-17 against installed codex-cli 0.130.0 (grounding
// doc d1e58e1): `thread.started`+`thread_id` confirmed; `turn.started`
// is new (→ runtime_event); `error` = {type:'error',message:'..'} and
// `turn.failed` = {type:'turn.failed',error:{message:'..'}} (NESTED
// OBJECT). Happy-path items (agent_message / turn.completed /
// command_execution / file_change / mcp_tool_call) are the documented
// 0.117 assumption (probe usage-capped); unknown `type` degrades
// safely to runtime_event.

export function normalizeCodexExecLine(line, ctx) {
  const base = {
    runtimeId: ctx && ctx.runtimeId,
    teamId: ctx && ctx.teamId,
    agentId: ctx && ctx.agentId,
  };
  if (typeof line !== 'string' || line.trim().length === 0) return [];

  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    return [{ ...base, type: 'parse_error', raw: line }];
  }
  if (!parsed || typeof parsed !== 'object') {
    return [{ ...base, type: 'runtime_event', raw: parsed }];
  }

  const evBase = { ...base, raw: parsed };

  if (parsed.type === 'thread.started') {
    return [{
      ...evBase,
      type: 'session_started',
      sessionId: typeof parsed.thread_id === 'string' ? parsed.thread_id : null,
    }];
  }

  if (parsed.type === 'item.completed') {
    const item = parsed.item && typeof parsed.item === 'object' ? parsed.item : {};
    if (item.type === 'agent_message') {
      return [{ ...evBase, type: 'assistant_text', text: typeof item.text === 'string' ? item.text : '' }];
    }
    if (typeof item.type === 'string' && item.type.length > 0) {
      return [{ ...evBase, type: 'tool_use', toolName: item.type, input: { ...item } }];
    }
    return [{ ...evBase, type: 'runtime_event' }];
  }

  if (parsed.type === 'turn.completed') {
    return [{ ...evBase, type: 'turn_completed' }];
  }

  if (parsed.type === 'turn.failed' || parsed.type === 'error') {
    // RATIFIED (0.130.0, grounding d1e58e1): `error` is
    // {type:'error',message:'..'} (string); `turn.failed` is
    // {type:'turn.failed',error:{message:'..'}} (NESTED OBJECT).
    const nested = parsed.error && typeof parsed.error === 'object' && parsed.error !== null
      ? parsed.error.message
      : null;
    return [{
      ...evBase,
      type: 'turn_failed',
      error: typeof parsed.message === 'string'
        ? parsed.message
        : (typeof nested === 'string' ? nested
          : (typeof parsed.error === 'string' ? parsed.error : 'codex exec turn failed')),
    }];
  }

  return [{ ...evBase, type: 'runtime_event' }];
}
