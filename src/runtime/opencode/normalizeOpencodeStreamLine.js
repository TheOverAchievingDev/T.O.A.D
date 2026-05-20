// Pure, total, never-throws translation of ONE `opencode run --format json`
// NDJSON line into TOAD's normalized runtime-event vocabulary (the same
// vocabulary ClaudeStreamJsonAdapter emits, so the ingestor / drift / risk /
// review layers consume opencode identically). React-free, own local shapes,
// no @/ import — the normalizeCodexExecLine / normalizeGeminiStreamLine
// pure-core precedent (`{ ...evBase, type, ... }` with
// `evBase = { ...base, raw: parsed }`). The adapter is the thin IO shell.
//
// RATIFIED 2026-05-18 against installed opencode-cli 1.15.4 (grounding doc
// 2026-05-18-opencode-cli.md §8/§9/§10, verbatim 1-turn DeepSeek capture).
// NDJSON on stdout, CRLF line endings, top-level envelope
// `{ type, timestamp, sessionID, part }`:
//   - `step_start`  → session_started{ sessionId: <TOP-LEVEL `sessionID`> }
//                     (capital ID, captured first sight — NOT part.*/sessionId)
//   - `text`        → assistant_text{ text: part.text }
//   - `step_finish` → turn_completed{ usage:{inputTokens,outputTokens,
//                     totalTokens,cacheRead,cacheWrite}, costUsd, stopReason }
//   - unknown top-level `type` → runtime_event (degrade, never throw).
// `tool`/`error` shapes are UNVERIFIED in the 1-turn probe (§10 marks them
// unseen) — they fall through to runtime_event; no shapes invented.
// A line that is not a `{`-prefixed JSON object (stdout noise, arrays,
// scalars) is skipped (`[]`, NOT parse_error); only a `{`-prefixed line that
// fails JSON.parse is a parse_error. Real output is CRLF, so the trailing
// `\r` / surrounding whitespace is trimmed before the JSON/skip decision.

export function normalizeOpencodeStreamLine(line, ctx) {
  const base = {
    runtimeId: ctx && ctx.runtimeId,
    teamId: ctx && ctx.teamId,
    agentId: ctx && ctx.agentId,
  };

  // Non-string, empty, or whitespace-only (incl. bare CRLF) → skip.
  if (typeof line !== 'string' || line.trim().length === 0) return [];

  // Tolerate CRLF: real output is `\r\n`-terminated. Trim before the
  // JSON/skip decision so a real `step_start\r` line still maps correctly.
  const trimmed = line.trim();

  // Non-JSON-object lines (stdout noise, arrays, scalars) are NOT errors —
  // skip silently. Only a `{`-prefixed line that fails to parse is a true
  // parse_error (the gemini precedent).
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
  const part = parsed.part && typeof parsed.part === 'object' ? parsed.part : {};

  // step_start → session_started, sessionId from the TOP-LEVEL `sessionID`
  // (capital ID), present on every event from the very first line. NOT
  // parsed.sessionId / parsed.session_id / part.sessionID.
  if (parsed.type === 'step_start') {
    return [{
      ...evBase,
      type: 'session_started',
      sessionId: typeof parsed.sessionID === 'string' ? parsed.sessionID : null,
    }];
  }

  // text → assistant_text{ text: part.text }
  if (parsed.type === 'text') {
    return [{
      ...evBase,
      type: 'assistant_text',
      text: typeof part.text === 'string' ? part.text : '',
    }];
  }

  // step_finish → turn_completed{ usage, costUsd, stopReason }. Usage rides
  // inside part.tokens; cost is part.cost; stop reason is part.reason.
  if (parsed.type === 'step_finish') {
    const tokens = part.tokens && typeof part.tokens === 'object' ? part.tokens : {};
    const cache = tokens.cache && typeof tokens.cache === 'object' ? tokens.cache : {};
    return [{
      ...evBase,
      type: 'turn_completed',
      usage: {
        inputTokens: numberOrNull(tokens.input),
        outputTokens: numberOrNull(tokens.output),
        totalTokens: numberOrNull(tokens.total),
        cacheRead: numberOrNull(cache.read),
        cacheWrite: numberOrNull(cache.write),
      },
      costUsd: numberOrNull(parsed.part && parsed.part.cost),
      stopReason: typeof part.reason === 'string' ? part.reason : null,
    }];
  }

  // Unknown top-level type (incl. UNVERIFIED `tool` / `error` — §10 marks
  // them unseen in the 1-turn probe) → runtime_event passthrough. Degrade
  // safely; do not invent shapes; never throw.
  return [{ ...evBase, type: 'runtime_event' }];
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
