// Pure, total translation of one Gemini CLI `--output-format stream-json`
// line into TOAD's normalized runtime event vocabulary.

export function normalizeGeminiStreamLine(line, ctx) {
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

  if (parsed.type === 'init') {
    return [{
      ...evBase,
      type: 'session_started',
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
    }];
  }

  if (parsed.type === 'message') {
    if (parsed.role === 'assistant') {
      return [{ ...evBase, type: 'assistant_text', text: typeof parsed.content === 'string' ? parsed.content : '' }];
    }
    return [{ ...evBase, type: 'runtime_event' }];
  }

  if (parsed.type === 'tool_use') {
    const toolName = typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : 'gemini_tool';
    return [{ ...evBase, type: 'tool_use', toolName, input: { ...parsed } }];
  }

  if (parsed.type === 'tool_result') {
    return [{ ...evBase, type: 'runtime_event' }];
  }

  if (parsed.type === 'result') {
    if (parsed.status === 'success') return [{ ...evBase, type: 'turn_completed' }];
    return [{ ...evBase, type: 'turn_failed', error: extractError(parsed, 'Gemini turn failed') }];
  }

  if (parsed.type === 'error') {
    return [{ ...evBase, type: 'turn_failed', error: extractError(parsed, 'Gemini stream error') }];
  }

  return [{ ...evBase, type: 'runtime_event' }];
}

function withUsageAlias(parsed) {
  const stats = parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : null;
  if (!stats) return parsed;
  const usage = {
    input_tokens: numberOrNull(stats.input_tokens),
    output_tokens: numberOrNull(stats.output_tokens),
  };
  return { ...parsed, usage };
}

function extractError(parsed, fallback) {
  if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message;
  if (typeof parsed.error === 'string' && parsed.error.length > 0) return parsed.error;
  if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') {
    return parsed.error.message;
  }
  return fallback;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
