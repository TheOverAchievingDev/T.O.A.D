// P3c-2 — pure projection of persisted span summaries into FlowTimeline
// rows. React-free, total, NEVER throws. Standalone `tsc`-compilable
// (its own local types; NO `@/` / FlowTimeline import) so the .mjs test
// can compile it in isolation (the flowCanvasModel.ts precedent).

export interface SpanSummaryRow {
  spanId: string;
  teamId?: string;
  runtimeId?: string;
  agentId?: string;
  sessionId?: string;
  summaryText: string;
  model?: string | null;
  cli?: string | null;
  spanStartedAt?: string;
  spanEndedAt?: string;
  rowCount?: number;
  tokens?: number | null;
  createdAt?: string;
}

// Structurally compatible with FlowTimeline's exported TimelineEvent
// ({ id, when, dot, expanded?, body }); body is a plain string (a valid
// ReactNode) — the pure helper emits no JSX.
export interface SpanSummaryEvent {
  id: string;
  when: string;
  dot: 'violet';
  body: string;
}

function toEpoch(value: unknown): number | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function relativeWhen(ts: number, now: number): string {
  const sec = Math.max(0, Math.round((now - ts) / 1000));
  if (sec < 30) return 'just now';
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

export function projectSpanSummaryEvents(
  rows: SpanSummaryRow[] | null | undefined,
  now: number,
): SpanSummaryEvent[] {
  if (!Array.isArray(rows)) return [];
  const ref = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();

  const items: Array<{ ev: SpanSummaryEvent; ts: number; i: number }> = [];
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    if (!r || typeof r !== 'object') continue;
    const text = (r as SpanSummaryRow).summaryText;
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    const spanId = typeof (r as SpanSummaryRow).spanId === 'string' && (r as SpanSummaryRow).spanId
      ? (r as SpanSummaryRow).spanId
      : `idx-${i}`;
    const ts =
      toEpoch((r as SpanSummaryRow).spanEndedAt) ??
      toEpoch((r as SpanSummaryRow).createdAt) ??
      ref;
    const model = (r as SpanSummaryRow).model;
    const body =
      typeof model === 'string' && model.trim().length > 0
        ? `${text.trim()} · ${model.trim()}`
        : text.trim();
    items.push({
      ev: { id: `summary-${spanId}`, when: relativeWhen(ts, ref), dot: 'violet', body },
      ts,
      i,
    });
  }

  // Newest first; stable for equal ts (preserve input order via index).
  items.sort((a, b) => (b.ts - a.ts) || (a.i - b.i));
  return items.map((it) => it.ev);
}
