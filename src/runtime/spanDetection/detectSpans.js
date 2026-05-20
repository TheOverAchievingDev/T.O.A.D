// Pure span detection (Readability Layer-2 P2b). Zero imports, JSX-free,
// server-importable — the eventNarration/timelineComposition pure-core
// discipline. Groups the persisted narrated stream into single-agent
// activity spans for P3's summarizer. Span is a GROUPING, not a
// transformation: narrated line text is reused verbatim (no re-narration).

// Sealed reason set. Object.freeze(new Set(...)) does NOT make .add()
// throw on Node v22 (freeze guards own props, not the Set internal
// slot) — seal via own throwing mutators, exactly as eventNarration's
// NARRATION_KINDS. .has()/iteration/spread keep working.
export const SPAN_BOUNDARY_REASONS = (() => {
  const s = new Set(['system', 'agent-change', 'runtime-change', 'time-gap', 'size-cap']);
  const seal = () => { throw new TypeError('SPAN_BOUNDARY_REASONS is sealed'); };
  s.add = seal;
  s.delete = seal;
  s.clear = seal;
  return Object.freeze(s);
})();

export const DEFAULT_SPAN_CONFIG = Object.freeze({ gapMs: 300000, maxRows: 40, maxTokens: 6000 });

function tokenSum(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function isActivity(kind) {
  return kind === 'tool' || kind === 'text';
}

// The exact 7-field narrated-row subset a span embeds (by reference, not
// re-narrated). The narration store already normalizes line→string and
// tokens→number|null; eventId may be null.
function pickRow(r) {
  return {
    narrationId: r.narrationId,
    eventId: r.eventId ?? null,
    eventType: r.eventType,
    kind: r.kind,
    line: r.line,
    tokens: r.tokens,
    createdAt: r.createdAt,
  };
}

/**
 * @param {Array<object>} rows narrated-stream rows ordered created_at ASC,
 *   narration_id ASC (as listNarration returns) — NOT re-sorted here.
 * @param {{gapMs:number,maxRows:number,maxTokens:number}} [config]
 * @returns {Array<object>} Span[]
 */
export function detectSpans(rows, config) {
  const cfg = config && typeof config === 'object' ? config : DEFAULT_SPAN_CONFIG;
  const gapMs = typeof cfg.gapMs === 'number' ? cfg.gapMs : DEFAULT_SPAN_CONFIG.gapMs;
  const maxRows = typeof cfg.maxRows === 'number' ? cfg.maxRows : DEFAULT_SPAN_CONFIG.maxRows;
  const maxTokens = typeof cfg.maxTokens === 'number' ? cfg.maxTokens : DEFAULT_SPAN_CONFIG.maxTokens;
  const list = Array.isArray(rows) ? rows : [];

  const spans = [];
  let open = null;

  const finalize = (span, boundary) => {
    const last = span.rows[span.rows.length - 1];
    spans.push({
      spanId: `span-${span.rows[0].narrationId}`,
      agentId: span.agentId,
      runtimeId: span.runtimeId,
      teamId: span.teamId,
      sessionId: span.sessionId ?? null,
      startedAt: span.rows[0].createdAt,
      endedAt: last.createdAt,
      closed: boundary !== null,
      boundary,
      rowCount: span.rows.length,
      tokens: span.tokens,
      rows: span.rows,
    });
  };

  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const agentId = typeof r.agentId === 'string' ? r.agentId : '';
    const runtimeId = typeof r.runtimeId === 'string' ? r.runtimeId : '';

    // 1. system row: closes any open span (consumed as boundary, never
    //    inside / never its own span). No open span => simply skipped.
    if (!isActivity(r.kind)) {
      if (open) {
        finalize(open, { reason: 'system', systemEventType: r.eventType });
        open = null;
      }
      continue;
    }

    // First matching trigger in order wins: agent-change > runtime-change
    // > time-gap. (system handled above.)
    if (open) {
      if (agentId !== open.agentId) {
        finalize(open, { reason: 'agent-change' });
        open = null;
      } else if (runtimeId !== open.runtimeId) {
        finalize(open, { reason: 'runtime-change' });
        open = null;
      } else {
        const prev = open.rows[open.rows.length - 1];
        const a = Date.parse(prev.createdAt);
        const b = Date.parse(r.createdAt);
        if (!Number.isNaN(a) && !Number.isNaN(b) && b - a > gapMs) {
          finalize(open, { reason: 'time-gap' });
          open = null;
        }
      }
    }

    if (!open) {
      open = {
        agentId,
        runtimeId,
        teamId: r.teamId, // snapshot from span-opener; assumed stable within a span (not a boundary like agentId/runtimeId)
        sessionId: r.sessionId ?? null, // ditto
        rows: [],
        tokens: 0,
      };
    }
    open.rows.push(pickRow(r));
    open.tokens += tokenSum(r.tokens);

    // size-cap: eager close AFTER appending the row.
    if (open.rows.length >= maxRows || open.tokens >= maxTokens) {
      finalize(open, { reason: 'size-cap' });
      open = null;
    }
  }

  if (open) finalize(open, null); // trailing span: open, no boundary

  return spans;
}
