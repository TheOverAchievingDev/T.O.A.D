// Pure, browser-safe (NO node:* / fs / path / process / env imports).
// One normalized runtime event -> one operator-readable line + kind + tokens.
// The exact unified wording is reconciled via the golden agreement test
// (spec §5); this module is the single source of truth (spec §8c/§8d).

// Controller ratification (T1): Object.freeze(new Set(...)) does NOT make
// .add() throw on Node v22 (freeze guards own props, not Set internal slot).
// Seal via own throwing mutators so `NARRATION_KINDS.add('x')` throws while
// .has()/iteration/spread keep working. Version-robust.
export const NARRATION_KINDS = (() => {
  const s = new Set(['tool', 'text', 'system']);
  const seal = () => { throw new TypeError('NARRATION_KINDS is sealed'); };
  s.add = seal;
  s.delete = seal;
  s.clear = seal;
  return Object.freeze(s);
})();

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function degraded() {
  return { line: '', kind: 'system', tokens: null };
}

function basename(p) {
  const s = typeof p === 'string' ? p : '';
  const parts = s.split(/[/\\]/);
  return parts[parts.length - 1] || s;
}
function str(v) { return typeof v === 'string' ? v : v === undefined || v === null ? '' : JSON.stringify(v); }

function narrateTool(toolName, input) {
  const short = toolName.replace(/^mcp__[^_]+__/, '');
  if (short === 'Read') return `Reading ${basename(str(input && input.file_path)) || 'file'}`;
  if (short === 'Bash') { const c = str(input && input.command); return `Bash: ${c.slice(0, 60)}${c.length > 60 ? '…' : ''}`; }
  if (short === 'Edit' || short === 'Write') return `${short} ${basename(str(input && input.file_path)) || 'file'}`;
  if (short === 'MultiEdit') return `MultiEdit ${basename(str(input && input.file_path)) || 'file'}`;
  if (short === 'Grep') return `Grep: ${str(input && input.pattern).slice(0, 60)}`;
  if (short === 'Glob') return `Glob: ${str(input && input.pattern)}`;
  if (short === 'task_create') {
    const id = str(input && input.taskId); const sj = str(input && input.subject);
    return `Created task ${id}${sj ? ` — ${sj.slice(0, 60)}` : ''}`;
  }
  if (short === 'message_send') {
    const to = input && input.to && typeof input.to === 'object' ? input.to.agentId : undefined;
    return `Sent message → ${to || 'team'}`;
  }
  if (short === 'task_update') return `Updated task ${str(input && input.taskId)}`.trim();
  if (short === 'task_plan_propose') return `Proposed plan for ${str(input && input.taskId) || 'task'}`;
  if (short === 'review_decide') return `Review decided: ${str(input && input.decision)}`;
  if (short === 'validation_run') return `Running validation: ${str(input && input.kind)}`;
  if (short === 'TodoWrite') return 'Updated todos';
  return `Tool: ${short}`;
}

/**
 * @typedef {'tool' | 'text' | 'system'} NarrationKind
 * @typedef {{ line: string, kind: NarrationKind, tokens: number | null }} Narration
 * @param {unknown} event
 * @param {unknown} [_options]
 * @returns {Narration}
 */
export function narrate(event, _options) {
  try {
    if (!event || typeof event !== 'object') return degraded();
    const tokens = num(event.raw && event.raw.usage && event.raw.usage.output_tokens);
    if (event.type === 'assistant_text') {
      const t = typeof event.text === 'string' && event.text
        ? event.text
        : (event.raw && event.raw.message && Array.isArray(event.raw.message.content)
            ? (event.raw.message.content.find((c) => c && c.type === 'text') || {}).text
            : '');
      const one = typeof t === 'string' ? t.replace(/\s+/g, ' ').trim() : '';
      const line = one.length > 120 ? `${one.slice(0, 117)}…` : one;
      return { line, kind: 'text', tokens };
    }
    if (event.type === 'tool_use') {
      const rawName = typeof event.toolName === 'string' && event.toolName
        ? event.toolName
        : (event.raw && event.raw.message && Array.isArray(event.raw.message.content)
            ? (event.raw.message.content[0] || {}).name : '') || 'tool';
      const input = (event.input && typeof event.input === 'object') ? event.input
        : (event.raw && event.raw.message && Array.isArray(event.raw.message.content)
            ? (event.raw.message.content[0] || {}).input : {}) || {};
      return { line: narrateTool(String(rawName), input), kind: 'tool', tokens };
    }
    if (event.type === 'turn_completed') {
      const r = event.raw || {};
      const dur = typeof r.duration_ms === 'number' ? ` (${Math.round(r.duration_ms / 1000)}s)` : '';
      return { line: `Turn complete${dur}`, kind: 'system', tokens };
    }
    if (event.type === 'turn_failed') return { line: 'Turn failed', kind: 'system', tokens };
    if (event.type === 'compact_boundary') return { line: 'Context compacted', kind: 'system', tokens };
    if (event.type === 'api_retry') return { line: 'Retrying (API)', kind: 'system', tokens };
    if (event.type === 'approval_request') {
      const tn = typeof event.toolName === 'string' && event.toolName ? event.toolName : 'tool';
      return { line: `Awaiting approval: ${tn}`, kind: 'system', tokens };
    }
    if (event.type === 'runtime_event') {
      const st = event.raw && event.raw.subtype;
      const d = event.raw && (event.raw.status_detail || event.raw.status_category || event.raw.description);
      if (typeof d === 'string' && d) return { line: d, kind: 'system', tokens };
      return { line: st ? String(st) : 'system', kind: 'system', tokens };
    }
    return { line: '', kind: 'system', tokens };
  } catch {
    return degraded();
  }
}
