// Pure translation of one OpenCode `run --format json` line into TOAD's
// normalized runtime event vocabulary.

export function normalizeOpencodeStreamLine(line, ctx) {
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

  const raw = withUsageAlias(parsed);
  const evBase = { ...base, raw };
  const part = parsed.part && typeof parsed.part === 'object' ? parsed.part : {};
  const sessionId = pickString(parsed.sessionID, parsed.sessionId, part.sessionID, part.sessionId);

  if (parsed.type === 'step_start' || part.type === 'step-start') {
    return [{ ...evBase, type: 'session_started', sessionId }];
  }

  if (parsed.type === 'text' || part.type === 'text') {
    return [{ ...evBase, type: 'assistant_text', text: typeof part.text === 'string' ? part.text : '' }];
  }

  if (parsed.type === 'tool' || part.type === 'tool') {
    const state = part.state && typeof part.state === 'object' ? part.state : null;
    if (state) return [{ ...evBase, type: 'runtime_event' }];
    return [{
      ...evBase,
      type: 'tool_use',
      toolName: pickString(part.tool, part.name, part.id) || 'opencode_tool',
      input: { ...part },
    }];
  }

  if (parsed.type === 'step_finish' || part.type === 'step-finish') {
    const reason = typeof part.reason === 'string' ? part.reason : '';
    if (reason === 'error' || reason === 'failed' || reason === 'cancelled') {
      return [{ ...evBase, type: 'turn_failed', error: extractError(part, 'OpenCode turn failed') }];
    }
    return [{ ...evBase, type: 'turn_completed' }];
  }

  if (parsed.type === 'error') {
    return [{ ...evBase, type: 'turn_failed', error: extractError(parsed, 'OpenCode stream error') }];
  }

  return [{ ...evBase, type: 'runtime_event' }];
}

function withUsageAlias(parsed) {
  const part = parsed.part && typeof parsed.part === 'object' ? parsed.part : {};
  const tokens = part.tokens && typeof part.tokens === 'object' ? part.tokens : null;
  if (!tokens) return parsed;
  return {
    ...parsed,
    usage: {
      input_tokens: numberOrNull(tokens.input),
      output_tokens: numberOrNull(tokens.output),
    },
  };
}

function extractError(value, fallback) {
  if (typeof value.error === 'string' && value.error.length > 0) return value.error;
  if (typeof value.message === 'string' && value.message.length > 0) return value.message;
  if (value.error && typeof value.error === 'object' && typeof value.error.message === 'string') {
    return value.error.message;
  }
  return fallback;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}
