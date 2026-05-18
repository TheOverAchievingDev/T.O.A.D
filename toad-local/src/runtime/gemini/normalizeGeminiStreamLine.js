// Pure, total, never-throws translation of one Gemini CLI
// `--output-format stream-json` line into TOAD's normalized runtime-event
// vocabulary.
//
// RATIFIED 2026-05-18 against installed gemini-cli 0.42.0 (grounding doc
// 2026-05-18-gemini-cli.md §8–§10): `init` with `session_id` UUID →
// session_started; `message` role:user → skip; `message` role:assistant +
// `content` → assistant_text; `result` status:success + `stats` →
// turn_completed {usage}; `result` status:non-success → turn_failed
// {status,usage}; non-JSON stdout lines (warnings/notices) → skip (NOT
// parse_error — only lines that start with `{` but fail to parse → parse_error);
// unknown type → runtime_event; never throws on any input.

export function normalizeGeminiStreamLine(line, ctx) {
  const base = {
    runtimeId: ctx && ctx.runtimeId,
    teamId: ctx && ctx.teamId,
    agentId: ctx && ctx.agentId,
  };

  // Non-string, empty string, or whitespace → skip
  if (typeof line !== 'string' || line.trim().length === 0) return [];

  const trimmed = line.trim();

  // Non-JSON-shaped lines (not starting with '{') are stdout noise (warnings,
  // notices) — skip silently. Only brace-prefixed lines that fail to parse
  // are true parse errors.
  if (!trimmed.startsWith('{')) return [];

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [{ ...base, type: 'parse_error', raw: line }];
  }

  if (!parsed || typeof parsed !== 'object') {
    return [{ ...base, type: 'runtime_event', raw: parsed }];
  }

  const evBase = { ...base, raw: parsed };

  // init → session_started
  if (parsed.type === 'init') {
    return [{
      ...evBase,
      type: 'session_started',
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
    }];
  }

  // message/user → skip (user-echo, not agent output)
  if (parsed.type === 'message') {
    if (parsed.role === 'user') return [];
    if (parsed.role === 'assistant') {
      return [{
        ...evBase,
        type: 'assistant_text',
        text: typeof parsed.content === 'string' ? parsed.content : '',
      }];
    }
    // unknown role → runtime_event
    return [{ ...evBase, type: 'runtime_event' }];
  }

  // result/success → turn_completed with usage = parsed.stats
  // result/non-success → turn_failed with status + usage
  if (parsed.type === 'result') {
    const usage = parsed.stats && typeof parsed.stats === 'object' ? parsed.stats : undefined;
    if (parsed.status === 'success') {
      return [{ ...evBase, type: 'turn_completed', usage }];
    }
    return [{
      ...evBase,
      type: 'turn_failed',
      status: parsed.status,
      usage,
      error: extractError(parsed, 'Gemini turn failed'),
    }];
  }

  // error event → turn_failed (shape unverified in 0.42.0 probe; preserved
  // from prior impl as a safe degradation)
  if (parsed.type === 'error') {
    return [{ ...evBase, type: 'turn_failed', error: extractError(parsed, 'Gemini stream error') }];
  }

  // tool_use (shape unverified in 0.42.0 probe; preserved from prior impl)
  if (parsed.type === 'tool_use') {
    const toolName = typeof parsed.name === 'string' && parsed.name.length > 0
      ? parsed.name
      : 'gemini_tool';
    return [{ ...evBase, type: 'tool_use', toolName, input: { ...parsed } }];
  }

  // Unknown type → runtime_event (degrade gracefully, do not throw)
  return [{ ...evBase, type: 'runtime_event' }];
}

function extractError(parsed, fallback) {
  if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message;
  if (typeof parsed.error === 'string' && parsed.error.length > 0) return parsed.error;
  if (parsed.error && typeof parsed.error === 'object' && typeof parsed.error.message === 'string') {
    return parsed.error.message;
  }
  return fallback;
}
