import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fxPath = join(here, '..', 'test', 'fixtures', 'eventNarration.events.json');
const events = JSON.parse(readFileSync(fxPath, 'utf8'));

/* ---- VERBATIM from ui/src/utils/agentStream.ts (do not edit) ---- */
function aSafeString(v) { return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v); }
function summarizeToolInput(toolName, input) {
  const short = toolName.replace(/^mcp__[^_]+__/, '');
  if (short === 'Read') return aSafeString(input?.file_path);
  if (short === 'Bash') return aSafeString(input?.command);
  if (short === 'Edit' || short === 'Write') return aSafeString(input?.file_path);
  if (short === 'Grep') return `pattern: ${aSafeString(input?.pattern)}`;
  if (short === 'Glob') return aSafeString(input?.pattern);
  if (short === 'task_create') return `${aSafeString(input?.taskId)} — ${aSafeString(input?.subject)}`;
  if (short === 'message_send') { const to = input?.to?.agentId; const text = aSafeString(input?.text); return `→ ${to || 'team'}: ${text.slice(0, 120)}`; }
  if (short === 'task_update') return `${aSafeString(input?.taskId)}`;
  if (short === 'task_plan_propose') return `Plan for ${aSafeString(input?.taskId) || 'task'}`;
  if (short === 'review_decide') return `Decision: ${aSafeString(input?.decision) || ''}`;
  if (short === 'validation_run') return `Kind: ${aSafeString(input?.kind) || ''}`;
  if (short === 'TodoWrite') { const todos = input?.todos; if (Array.isArray(todos)) return todos.map((t) => `${t.status === 'completed' ? '✓' : '·'} ${t.content}`).join(' / '); return ''; }
  return JSON.stringify(input ?? {}).slice(0, 200);
}
function eventToStreamEntry(event) {
  if (event.type === 'assistant_text') {
    const text = (typeof event.text === 'string' && event.text) || event.raw?.message?.content?.find((c) => c.type === 'text')?.text;
    if (!text) return null;
    return { kind: 'output', body: text };
  }
  if (event.type === 'tool_use') {
    const toolName = (typeof event.toolName === 'string' && event.toolName) || event.raw?.message?.content?.[0]?.name || 'tool';
    const input = event.raw?.message?.content?.[0]?.input || event.input;
    return { kind: 'tool', tool: String(toolName).replace(/^mcp__[^_]+__/, ''), body: summarizeToolInput(String(toolName), input) };
  }
  if (event.type === 'runtime_event') {
    const subtype = event.raw?.subtype; const description = event.raw?.description;
    if (subtype === 'task_started' && description) return { kind: 'system', body: description };
    if (subtype === 'post_turn_summary') { const status = event.raw?.status_detail || event.raw?.status_category; if (status) return { kind: 'thought', body: status }; }
    return null;
  }
  if (event.type === 'turn_completed') {
    const r = event.raw; if (r?.result) { const dur = r.duration_ms ? ` (${Math.round(r.duration_ms / 1000)}s)` : ''; return { kind: 'system', body: `Turn complete${dur}` }; }
    return null;
  }
  if (event.type === 'approval_request') return { kind: 'system', body: 'Approval requested' };
  return null;
}
/* ---- VERBATIM from timelineProjection.tsx bodyForStream verb map ---- */
function bodyForStreamText(entry) {
  if (!entry) return null;
  const verb = entry.kind === 'tool'
    ? (entry.tool === 'Edit' || entry.tool === 'Write' ? 'edited'
        : entry.tool === 'Read' ? 'opened'
        : entry.tool === 'Bash' ? 'ran'
        : entry.tool === 'Grep' || entry.tool === 'Glob' ? 'searched for' : 'used')
    : entry.kind === 'output' ? 'reported'
    : entry.kind === 'thought' ? 'thinking:' : 'system:';
  const toolLabel = entry.tool ?? entry.kind;
  // Plain-text rendering of the JSX <agent> <verb> [<tool>] [— body]; agent name omitted (constant per-row, not part of the narration decision).
  return `${verb}${entry.kind === 'tool' && entry.tool ? ` ${toolLabel}` : ''}${entry.body ? ` — ${entry.body}` : ''}`;
}
/* ---- VERBATIM from ui/src/hooks/useToadData.ts ---- */
function uSafe(v) { return typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v); }
function summarizeToolCall(toolName, input) {
  const short = toolName.replace(/^mcp__[^_]+__/, '');
  if (short === 'task_create') { const tid = uSafe(input?.taskId) || ''; const subj = uSafe(input?.subject) || ''; return `Created task ${tid}${subj ? ` — ${subj.slice(0, 60)}` : ''}`; }
  if (short === 'message_send') { const to = input?.to?.agentId; return `Sent message → ${to || 'team'}`; }
  if (short === 'task_update') return `Updated task ${uSafe(input?.taskId) || ''}`.trim();
  if (short === 'task_plan_propose') return `Proposed plan for ${uSafe(input?.taskId) || 'task'}`;
  if (short === 'review_decide') return `Review decided: ${uSafe(input?.decision) || ''}`;
  if (short === 'validation_run') return `Running validation: ${uSafe(input?.kind) || ''}`;
  if (short === 'Read') { const fp = uSafe(input?.file_path); const base = fp ? fp.split(/[/\\]/).pop() : ''; return `Reading ${base || 'file'}`; }
  if (short === 'Bash') { const cmd = uSafe(input?.command); return `Bash: ${cmd.slice(0, 60)}${cmd.length > 60 ? '…' : ''}`; }
  if (short === 'Edit' || short === 'Write') { const fp = uSafe(input?.file_path); const base = fp ? fp.split(/[/\\]/).pop() : ''; return `${short} ${base || 'file'}`; }
  if (short === 'Grep') return `Grep: ${uSafe(input?.pattern)?.slice(0, 60) || ''}`;
  if (short === 'Glob') return `Glob: ${uSafe(input?.pattern) || ''}`;
  if (short === 'TodoWrite') return 'Updated todos';
  return `Tool: ${short}`;
}
function deriveAgentActivity(event) {
  if (event.type === 'tool_use') {
    const toolName = (typeof event.toolName === 'string' && event.toolName) || event.raw?.message?.content?.[0]?.name || 'tool';
    const input = event.raw?.message?.content?.[0]?.input || event.input;
    const tool = String(toolName);
    return { kind: 'tool', label: summarizeToolCall(tool, input) };
  }
  if (event.type === 'assistant_text') {
    const text = (typeof event.text === 'string' && event.text) || event.raw?.message?.content?.find((c) => c.type === 'text')?.text;
    if (!text) return null;
    const one = text.replace(/\s+/g, ' ').trim();
    return { kind: 'text', label: one.length > 120 ? `${one.slice(0, 117)}…` : one };
  }
  if (event.type === 'runtime_event') {
    const subtype = event.raw?.subtype;
    if (subtype === 'task_started') return { kind: 'thinking', label: 'Working…' };
  }
  return null;
}

const feed = events.map((e) => { const se = eventToStreamEntry(e); return se === null ? null : { line: bodyForStreamText(se), kind: se.kind }; });
const card = events.map((e) => { const a = deriveAgentActivity(e); return a === null ? null : { line: a.label, kind: a.kind }; });
writeFileSync(join(here, '..', 'test', 'fixtures', 'eventNarration.feedGolden.json'), JSON.stringify(feed, null, 2) + '\n');
writeFileSync(join(here, '..', 'test', 'fixtures', 'eventNarration.cardGolden.json'), JSON.stringify(card, null, 2) + '\n');
console.log(`wrote goldens: ${feed.length} feed, ${card.length} card`);
