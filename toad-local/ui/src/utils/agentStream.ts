import type { RuntimeEvent } from '@/api/events';

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

function safeString(v: unknown): string {
  return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v);
}

function summarizeToolInput(toolName: string, input: Record<string, unknown> | undefined): string {
  const short = toolName.replace(/^mcp__[^_]+__/, '');
  if (short === 'Read') return safeString(input?.file_path);
  if (short === 'Bash') return safeString(input?.command);
  if (short === 'Edit' || short === 'Write') return safeString(input?.file_path);
  if (short === 'Grep') return `pattern: ${safeString(input?.pattern)}`;
  if (short === 'Glob') return safeString(input?.pattern);
  if (short === 'task_create') return `${safeString(input?.taskId)} — ${safeString(input?.subject)}`;
  if (short === 'message_send') {
    const to = (input?.to as { agentId?: string })?.agentId;
    const text = safeString(input?.text);
    return `→ ${to || 'team'}: ${text.slice(0, 120)}`;
  }
  if (short === 'task_update') return `${safeString(input?.taskId)}`;
  if (short === 'task_plan_propose') return `Plan for ${safeString(input?.taskId) || 'task'}`;
  if (short === 'review_decide') return `Decision: ${safeString(input?.decision) || ''}`;
  if (short === 'validation_run') return `Kind: ${safeString(input?.kind) || ''}`;
  if (short === 'TodoWrite') {
    const todos = input?.todos as Array<{ content?: string; status?: string }> | undefined;
    if (Array.isArray(todos)) return todos.map((t) => `${t.status === 'completed' ? '✓' : '·'} ${t.content}`).join(' / ');
    return '';
  }
  return JSON.stringify(input ?? {}).slice(0, 200);
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
    return { id, time, kind: 'output', body: text };
  }

  if (event.type === 'tool_use') {
    const toolName =
      (typeof (event as Record<string, unknown>).toolName === 'string' && (event as Record<string, unknown>).toolName as string)
      || ((event as { raw?: { message?: { content?: Array<{ name?: string }> } } }).raw?.message?.content?.[0]?.name)
      || 'tool';
    const input =
      ((event as { raw?: { message?: { content?: Array<{ input?: unknown }> } } }).raw?.message?.content?.[0]?.input as Record<string, unknown> | undefined)
      || (event as { input?: Record<string, unknown> }).input;
    return {
      id,
      time,
      kind: 'tool',
      tool: String(toolName).replace(/^mcp__[^_]+__/, ''),
      body: summarizeToolInput(String(toolName), input),
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
    if (result?.result) {
      const dur = result.duration_ms ? ` (${Math.round(result.duration_ms / 1000)}s)` : '';
      return { id, time, kind: 'system', body: `Turn complete${dur}` };
    }
    return null;
  }

  if (event.type === 'approval_request') {
    return { id, time, kind: 'system', body: 'Approval requested' };
  }

  return null;
}
