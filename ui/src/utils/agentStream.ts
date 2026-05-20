import type { RuntimeEvent } from '@/api/events';
import { narrate } from '../../../src/runtime/eventNarration/index.js';

export interface StreamEntry {
  /** Stable key for React rendering. Derived from event uuid + index. */
  id: string;
  /** Pre-formatted HH:MM:SS time string. */
  time: string;
  kind: 'thought' | 'tool' | 'output' | 'system';
  /** Tool name (without MCP namespace prefix), only set when kind === 'tool'. */
  tool?: string;
  /** Human-readable body. */
  body: string;
}

/** Per-agent ring buffer cap. Older entries are dropped when this is exceeded. */
export const MAX_STREAM_PER_AGENT = 500;

function formatTime(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return '--:--:--';
  return d.toTimeString().slice(0, 8);
}

function streamKind(k: 'tool' | 'text' | 'system'): StreamEntry['kind'] {
  switch (k) {
    case 'tool': return 'tool';
    case 'text': return 'output';
    case 'system': return 'system';
    default: { const _exhaustive: never = k; return _exhaustive; }
  }
}

/**
 * Map a raw runtime SSE event into a stream entry. Returns null when the
 * event is too low-signal to display (internal hook lifecycle, etc.).
 *
 * `idx` is appended to the id so two events at the same timestamp produce
 * unique React keys.
 */
export function eventToStreamEntry(event: RuntimeEvent, idx: number): StreamEntry | null {
  const time = formatTime(event.createdAt);
  const uuid = (event as { uuid?: string }).uuid;
  const id = `${event.runtimeId ?? 'unknown'}-${uuid ?? idx}-${event.createdAt ?? Date.now()}`;

  if (event.type === 'assistant_text') {
    const text =
      (typeof (event as Record<string, unknown>).text === 'string' && (event as Record<string, unknown>).text as string)
      || ((event as { raw?: { message?: { content?: Array<{ type?: string; text?: string }> } } }).raw?.message?.content?.find((c) => c.type === 'text')?.text);
    if (!text) return null;
    const n = narrate(event);
    return { id, time, kind: streamKind(n.kind), body: n.line };
  }

  if (event.type === 'tool_use') {
    const toolName =
      (typeof (event as Record<string, unknown>).toolName === 'string' && (event as Record<string, unknown>).toolName as string)
      || ((event as { raw?: { message?: { content?: Array<{ name?: string }> } } }).raw?.message?.content?.[0]?.name)
      || 'tool';
    const n = narrate(event);
    return {
      id,
      time,
      kind: streamKind(n.kind),
      tool: String(toolName).replace(/^mcp__[^_]+__/, ''),
      body: n.line,
    };
  }

  if (event.type === 'runtime_event') {
    const subtype = (event as { raw?: { subtype?: string; description?: string } }).raw?.subtype;
    const description = (event as { raw?: { description?: string } }).raw?.description;
    if (subtype === 'task_started' && description) {
      return { id, time, kind: 'system', body: description };
    }
    if (subtype === 'post_turn_summary') {
      const status = (event as { raw?: { status_detail?: string; status_category?: string } }).raw?.status_detail
        || (event as { raw?: { status_category?: string } }).raw?.status_category;
      if (status) return { id, time, kind: 'thought', body: status };
    }
    return null;
  }

  if (event.type === 'turn_completed') {
    const result = (event as { raw?: { result?: string; duration_ms?: number; num_turns?: number } }).raw;
    if (!result?.result) return null;
    const n = narrate(event);
    return { id, time, kind: streamKind(n.kind), body: n.line };
  }

  if (event.type === 'approval_request') {
    const n = narrate(event);
    return { id, time, kind: streamKind(n.kind), body: n.line };
  }

  return null;
}
