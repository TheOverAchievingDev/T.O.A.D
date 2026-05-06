import { useCallback, useEffect, useRef, useState } from 'react';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import { useToadEvents, type RuntimeEvent } from '@/api/events';
import { eventToStreamEntry, MAX_STREAM_PER_AGENT, type StreamEntry } from '@/utils/agentStream';
import type {
  Agent,
  AgentActivity,
  Team,
  UiTask,
  Runtime,
  Message,
  RoleId,
  AgentStatus,
  TaskStatus,
  RuntimeStatus,
  TaskRiskLevel,
  MatchedRiskRule,
  UiValidationRun,
  ValidationKind,
  ValidationVerdict,
} from '@/types';

// No-data baseline used until the API returns. We deliberately do NOT render
// fake teams/members/tasks because that masks "API not running" or "no project
// loaded" with a misleading workspace.
const EMPTY_TEAM: Team = {
  name: '',
  description: '',
  status: 'idle',
  uptime: '00:00:00',
  project: '',
  branch: '',
  members: [],
};

const POLL_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui' };

interface BackendTask {
  // Backend's task projection uses `taskId` + `subject`; older code paths
  // and tests sometimes synthesize `id` + `title`. Accept both so the UI
  // doesn't render an empty kanban card just because the field name shifted.
  id?: string;
  taskId?: string;
  title?: string;
  subject?: string;
  status?: TaskStatus | string;
  assignedRole?: string | null;
  assignee?: string;
  project?: string;
  riskLevel?: TaskRiskLevel | null;
  requiresHumanApproval?: boolean;
  matchedRules?: MatchedRiskRule[];
  // Backend writes `humanApproval: { approved: true, approvedBy, ... }` after
  // task_human_approve fires. Older fixtures used a flat boolean — accept both.
  humanApproval?: { approved?: boolean; approvedBy?: string; approvedAt?: string; reason?: string };
  humanApproved?: boolean;
  worktree?: {
    status?: string;
    path?: string;
    branch?: string | null;
  } | null;
  testCommands?: string[];
  validations?: BackendValidationRun[];
  latestValidation?: Partial<Record<string, BackendValidationRun>>;
}

interface BackendValidationRun {
  kind?: string;
  command?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  verdict?: string;
  stdout?: string;
  stderr?: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  actorId?: string;
  createdAt?: string;
}

interface BackendTeamMember {
  agentId?: string;
  command?: string;
  cwd?: string | null;
  providerId?: string;
  role?: string | null;
}

interface BackendTeamConfig {
  teamId: string;
  lead?: BackendTeamMember;
  teammates?: BackendTeamMember[];
}

interface BackendRuntime {
  id?: string;
  runtimeId?: string;
  status?: string;
  agentId?: string;
  provider?: string;
  providerId?: string;
  model?: string;
  pid?: number;
  cpu?: number;
  mem?: number;
  uptime?: string;
  startedAt?: string;
  reqs?: number;
  tokensIn?: number;
  tokensOut?: number;
}

interface BackendMessage {
  messageId: string;
  conversationId?: string;
  teamId?: string;
  from?: { kind?: string; id?: string };
  to?: { kind?: string; teamId?: string; agentId?: string };
  kind?: string;
  text?: string;
  createdAt?: string;
}

function normalizeMessage(raw: BackendMessage): Message {
  // The backend Message has nested {kind,id} / {kind,agentId}; the UI's
  // Message uses flat strings. Map agent-targeted to/from to plain ids,
  // user/system fall back to the kind string ("user", "system") so the
  // UI can still render those rows.
  const fromId = raw.from?.kind === 'agent' ? (raw.from?.id ?? '') : (raw.from?.kind ?? '');
  const toId = raw.to?.kind === 'agent'
    ? (raw.to?.agentId ?? '')
    : (raw.to?.kind ?? '');
  const time = raw.createdAt
    ? new Date(raw.createdAt).toTimeString().slice(0, 5)
    : '';
  return {
    id: raw.messageId,
    from: fromId,
    to: toId,
    time,
    body: raw.text ?? '',
    isToolCall: raw.kind === 'task_notification' || raw.kind === 'review_notification',
  };
}

interface ToadData {
  team: Team;
  tasks: UiTask[];
  runtimes: Runtime[];
  messages: Message[];
  loading: boolean;
  error: string | null;
  liveSource: 'live' | 'empty';
  refresh: () => void;
  /**
   * Per-agent activity streams accumulated from SSE events. Survives
   * AgentInbox unmount/remount when the operator switches between agents,
   * so the live feed stays continuous instead of resetting on every
   * agent-card click. Capped per agent at MAX_STREAM_PER_AGENT entries.
   */
  agentStreams: Record<string, StreamEntry[]>;
}

const RISK_LEVELS: TaskRiskLevel[] = ['low', 'medium', 'high', 'critical'];
const ROLE_IDS: RoleId[] = ['lead', 'developer', 'reviewer', 'researcher', 'debugger', 'qa', 'architect', 'designer'];
const VALIDATION_KINDS: ValidationKind[] = ['install', 'lint', 'typecheck', 'test', 'build', 'security'];
const VALIDATION_VERDICTS: ValidationVerdict[] = ['passed', 'failed', 'not_run'];

function normalizeRole(role: string | null | undefined, fallback: RoleId): RoleId {
  if (role === 'tester') return 'qa';
  return ROLE_IDS.includes(role as RoleId) ? (role as RoleId) : fallback;
}

function normalizeRuntimeStatus(status: string | undefined): RuntimeStatus {
  switch (status) {
    case 'running':
    case 'live':
      return 'live';
    case 'starting':
    case 'launching':
      return 'launching';
    case 'stopped':
    case 'exited':
      return 'stopped';
    case 'error':
    case 'failed':
      return 'error';
    default:
      return 'idle';
  }
}

function normalizeAgentStatus(status: RuntimeStatus | undefined): AgentStatus {
  switch (status) {
    case 'live':
      return 'live';
    case 'launching':
      return 'launching';
    case 'error':
      return 'error';
    default:
      return 'idle';
  }
}

function avatarFor(agentId: string): string {
  const cleaned = agentId.trim();
  return (cleaned[0] ?? '?').toUpperCase();
}

function formatElapsedSince(iso: string | undefined): string {
  if (!iso) return '00:00:00';
  const started = Date.parse(iso);
  if (!Number.isFinite(started)) return '00:00:00';
  const totalSeconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function normalizeTask(raw: BackendTask, fallbackProject: string): UiTask {
  // Backend status uses 'pending'/'in_progress'/'completed' phrasing; the
  // UI's TaskStatus union uses 'todo'/'in-progress'/etc. Map the known
  // backend values to UI vocab so the kanban places the task in the
  // correct column instead of dumping everything into "todo".
  const rawStatus = (raw.status as string) ?? 'pending';
  const statusMap: Record<string, TaskStatus> = {
    pending: 'todo',
    todo: 'todo',
    in_progress: 'in-progress',
    'in-progress': 'in-progress',
    review: 'review',
    completed: 'done',
    done: 'done',
    rejected: 'rejected',
    blocked: 'blocked',
  };
  const status: TaskStatus = statusMap[rawStatus] ?? 'todo';
  const riskLevel = raw.riskLevel && RISK_LEVELS.includes(raw.riskLevel as TaskRiskLevel)
    ? (raw.riskLevel as TaskRiskLevel)
    : null;
  // Field-name compatibility: backend returns `taskId` + `subject`; some
  // historical test fixtures use `id` + `title`. Read both.
  const id = raw.taskId ?? raw.id ?? '';
  const title = raw.subject ?? raw.title ?? id;
  // Apply the same role mapping that we use for agents (`tester` → `qa`)
  // so task.assignee can match agent.role on the agent cards. Without this
  // mapping, every tester-assigned task looks "unassigned" because the
  // agent shows role=qa while the task shows assignee=tester.
  const rawAssignee = (raw.assignee ?? raw.assignedRole ?? '') as string;
  const assignee = rawAssignee === 'tester' ? 'qa' : rawAssignee;
  const validations = Array.isArray(raw.validations)
    ? raw.validations.map(normalizeValidationRun).filter((run): run is UiValidationRun => run !== null)
    : [];
  return {
    id,
    title,
    status,
    assignee,
    project: raw.project ?? fallbackProject,
    riskLevel,
    requiresHumanApproval: raw.requiresHumanApproval === true,
    matchedRules: Array.isArray(raw.matchedRules) ? raw.matchedRules : undefined,
    // Read from either shape — backend writes the nested object after
    // task_human_approve, but legacy/test fixtures use the flat bool.
    humanApproved: raw.humanApproval?.approved === true || raw.humanApproved === true,
    testCommands: Array.isArray(raw.testCommands)
      ? raw.testCommands.filter((command) => typeof command === 'string')
      : undefined,
    validations,
    latestValidation: normalizeLatestValidation(raw.latestValidation),
    worktree: raw.worktree && typeof raw.worktree === 'object'
      ? {
          status: raw.worktree.status,
          path: raw.worktree.path,
          branch: raw.worktree.branch ?? null,
        }
      : null,
  };
}

function normalizeValidationRun(raw: BackendValidationRun): UiValidationRun | null {
  const kind = VALIDATION_KINDS.includes(raw.kind as ValidationKind) ? (raw.kind as ValidationKind) : null;
  if (!kind) return null;
  const verdict = VALIDATION_VERDICTS.includes(raw.verdict as ValidationVerdict)
    ? (raw.verdict as ValidationVerdict)
    : 'not_run';
  return {
    kind,
    command: typeof raw.command === 'string' ? raw.command : null,
    exitCode: typeof raw.exitCode === 'number' && Number.isFinite(raw.exitCode) ? raw.exitCode : null,
    durationMs: typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? raw.durationMs : null,
    verdict,
    stdout: typeof raw.stdout === 'string' ? raw.stdout : '',
    stderr: typeof raw.stderr === 'string' ? raw.stderr : '',
    stdoutTruncated: raw.stdoutTruncated === true,
    stderrTruncated: raw.stderrTruncated === true,
    actorId: typeof raw.actorId === 'string' ? raw.actorId : undefined,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : undefined,
  };
}

function normalizeLatestValidation(raw: BackendTask['latestValidation']): UiTask['latestValidation'] {
  if (!raw || typeof raw !== 'object') return undefined;
  const latest: UiTask['latestValidation'] = {};
  for (const [kind, value] of Object.entries(raw)) {
    if (!VALIDATION_KINDS.includes(kind as ValidationKind)) continue;
    const normalized = normalizeValidationRun(value ?? {});
    if (normalized) latest[kind as ValidationKind] = normalized;
  }
  return Object.keys(latest).length > 0 ? latest : undefined;
}

function normalizeRuntime(raw: BackendRuntime): Runtime {
  const id = raw.runtimeId ?? raw.id ?? `rt-${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    provider: raw.provider ?? raw.providerId ?? 'unknown',
    model: raw.model ?? 'unknown',
    agent: raw.agentId ?? '',
    pid: raw.pid ?? 0,
    status: normalizeRuntimeStatus(raw.status),
    cpu: raw.cpu ?? 0,
    mem: raw.mem ?? 0,
    uptime: raw.uptime ?? formatElapsedSince(raw.startedAt),
    reqs: raw.reqs ?? 0,
    tokensIn: raw.tokensIn ?? 0,
    tokensOut: raw.tokensOut ?? 0,
  };
}

/**
 * Map a raw SSE runtime event into a short, human-readable activity blurb
 * for the agent's card. Returns null when the event isn't worth surfacing
 * (e.g. internal hook lifecycle messages).
 *
 * The shapes here match what RuntimeEventIngestor emits — the full
 * normalized event passes through SSE verbatim, including nested `raw`
 * objects from the underlying claude stream-json output.
 */
function deriveAgentActivity(event: RuntimeEvent): AgentActivity | null {
  const at = (typeof event.createdAt === 'string' && event.createdAt) || new Date().toISOString();
  if (event.type === 'tool_use') {
    // Tool name lives in event.toolName for our normalized shape; for raw
    // claude payloads we fall back to event.raw.message.content[0].name.
    const toolName =
      (typeof (event as Record<string, unknown>).toolName === 'string' && (event as Record<string, unknown>).toolName as string)
      || ((event as { raw?: { message?: { content?: Array<{ name?: string }> } } }).raw?.message?.content?.[0]?.name)
      || 'tool';
    const input =
      ((event as { raw?: { message?: { content?: Array<{ input?: unknown }> } } }).raw?.message?.content?.[0]?.input as Record<string, unknown> | undefined)
      || (event as { input?: Record<string, unknown> }).input;
    const tool = String(toolName);
    const summary = summarizeToolCall(tool, input);
    return { kind: 'tool', label: summary, tool: tool.replace(/^mcp__[^_]+__/, ''), at };
  }
  if (event.type === 'assistant_text') {
    const text =
      (typeof (event as Record<string, unknown>).text === 'string' && (event as Record<string, unknown>).text as string)
      || ((event as { raw?: { message?: { content?: Array<{ type?: string; text?: string }> } } }).raw?.message?.content?.find((c) => c.type === 'text')?.text);
    if (!text) return null;
    const oneLine = text.replace(/\s+/g, ' ').trim();
    const truncated = oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
    return { kind: 'text', label: truncated, at };
  }
  // Hook events / system events — show "Thinking…" so the user knows the
  // agent is doing work even when no tool/text has arrived yet.
  if (event.type === 'runtime_event') {
    const subtype = (event as { raw?: { subtype?: string } }).raw?.subtype;
    if (subtype === 'task_started') return { kind: 'thinking', label: 'Working…', at };
  }
  return null;
}

function summarizeToolCall(toolName: string, input: Record<string, unknown> | undefined): string {
  const safe = (v: unknown) => (typeof v === 'string' ? v : v === undefined ? '' : JSON.stringify(v));
  // Strip MCP namespace prefix to keep the label tight on the card.
  const short = toolName.replace(/^mcp__[^_]+__/, '');
  if (short === 'task_create') {
    const tid = safe(input?.taskId) || '';
    const subj = safe(input?.subject) || '';
    return `Created task ${tid}${subj ? ` — ${subj.slice(0, 60)}` : ''}`;
  }
  if (short === 'message_send') {
    const to = (input?.to as { agentId?: string })?.agentId;
    return `Sent message → ${to || 'team'}`;
  }
  if (short === 'task_update') {
    return `Updated task ${safe(input?.taskId) || ''}`.trim();
  }
  if (short === 'task_plan_propose') {
    return `Proposed plan for ${safe(input?.taskId) || 'task'}`;
  }
  if (short === 'review_decide') {
    return `Review decided: ${safe(input?.decision) || ''}`;
  }
  if (short === 'validation_run') {
    return `Running validation: ${safe(input?.kind) || ''}`;
  }
  if (short === 'Read') {
    const fp = safe(input?.file_path);
    const base = fp ? fp.split(/[/\\]/).pop() : '';
    return `Reading ${base || 'file'}`;
  }
  if (short === 'Bash') {
    const cmd = safe(input?.command);
    return `Bash: ${cmd.slice(0, 60)}${cmd.length > 60 ? '…' : ''}`;
  }
  if (short === 'Edit' || short === 'Write') {
    const fp = safe(input?.file_path);
    const base = fp ? fp.split(/[/\\]/).pop() : '';
    return `${short} ${base || 'file'}`;
  }
  if (short === 'Grep') {
    return `Grep: ${safe(input?.pattern)?.slice(0, 60) || ''}`;
  }
  if (short === 'Glob') {
    return `Glob: ${safe(input?.pattern) || ''}`;
  }
  if (short === 'TodoWrite') {
    return 'Updated todos';
  }
  return `Tool: ${short}`;
}

function normalizeTeam(
  config: BackendTeamConfig | null,
  runtimes: Runtime[],
  tasks: UiTask[],
  activityByAgent: Record<string, AgentActivity>,
): Team {
  if (!config) return EMPTY_TEAM;

  const lead = config.lead ?? { agentId: 'lead', role: 'lead' };
  const rawMembers = [lead, ...(Array.isArray(config.teammates) ? config.teammates : [])];
  const members: Agent[] = rawMembers.map((raw, index) => {
    const agentId = raw.agentId?.trim() || (index === 0 ? 'lead' : `worker-${index}`);
    const role = normalizeRole(raw.role, index === 0 ? 'lead' : 'developer');
    const runtime = runtimes.find((candidate) => candidate.agent === agentId);
    const activeTask = tasks.find((task) => (
      task.status !== 'done'
      && task.status !== 'rejected'
      && (task.assignee === agentId || task.assignee === role)
    ));
    return {
      id: agentId,
      name: agentId,
      role,
      avatar: avatarFor(agentId),
      status: normalizeAgentStatus(runtime?.status),
      task: activeTask?.title ?? null,
      tokens: (runtime?.tokensIn ?? 0) + (runtime?.tokensOut ?? 0),
      tokenLimit: 200_000,
      provider: runtime?.provider ?? raw.providerId ?? 'unknown',
      model: runtime?.model ?? 'Default',
      tasksDone: tasks.filter((task) => (
        task.status === 'done' && (task.assignee === agentId || task.assignee === role)
      )).length,
      activity: activityByAgent[agentId] ?? null,
    };
  });

  const liveRuntimes = runtimes.filter((runtime) => runtime.status === 'live' || runtime.status === 'launching');
  const status: Team['status'] =
    liveRuntimes.some((runtime) => runtime.status === 'launching') ? 'launching'
      : liveRuntimes.length > 0 ? 'running'
        : 'idle';
  const cwd = rawMembers.find((member) => typeof member.cwd === 'string' && member.cwd.length > 0)?.cwd ?? '';
  const longestUptime = liveRuntimes.find((runtime) => runtime.uptime !== '00:00:00')?.uptime ?? '00:00:00';

  return {
    name: config.teamId,
    description: `${members.length} member${members.length === 1 ? '' : 's'} configured`,
    status,
    uptime: longestUptime,
    project: cwd,
    branch: '',
    members,
  };
}

export function useToadData(preferredTeamId: string | null = null): ToadData {
  const [team, setTeam] = useState<Team>(EMPTY_TEAM);
  const [tasks, setTasks] = useState<UiTask[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveSource, setLiveSource] = useState<'live' | 'empty'>('empty');
  const refreshNonceRef = useRef(0);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Live activity stream: derived from SSE runtime events. Maps agentId →
  // most recent visible activity. Used to populate Agent.activity so the
  // operator can see what each agent is doing in real time on its card,
  // not just a green status dot.
  const [activityByAgent, setActivityByAgent] = useState<Record<string, AgentActivity>>({});
  // Per-agent activity stream accumulator. Captures every relevant SSE
  // event for every agent on every team, so the AgentInbox can render a
  // continuous history regardless of which agent is currently selected.
  // Bounded per agent (MAX_STREAM_PER_AGENT) so a long-lived session does
  // not grow this unbounded.
  const [agentStreams, setAgentStreams] = useState<Record<string, StreamEntry[]>>({});
  const streamCounterRef = useRef(0);

  const refresh = useCallback(() => {
    refreshNonceRef.current += 1;
    setRefreshNonce(refreshNonceRef.current);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();

    async function loadOnce() {
      try {
        setLoading(true);
        setError(null);

        let teamConfigs: BackendTeamConfig[] = [];
        try {
          const teamResult = await callTool<BackendTeamConfig[]>({
            actor: POLL_ACTOR,
            method: 'team_list',
            args: {},
            signal: ac.signal,
          });
          teamConfigs = Array.isArray(teamResult) ? teamResult : [];
        } catch {
          teamConfigs = [];
        }

        const selectedTeamConfig =
          teamConfigs.find((candidate) => candidate.teamId === preferredTeamId)
          ?? teamConfigs[0]
          ?? null;
        const teamId = selectedTeamConfig?.teamId ?? POLL_ACTOR.teamId;
        const actor = { ...POLL_ACTOR, teamId };

        const taskResult = await callTool<BackendTask[] | { tasks?: BackendTask[] }>({
          actor,
          method: 'task_list',
          args: { teamId },
          signal: ac.signal,
        });
        if (cancelled) return;
        // Backend's task_list returns the raw array (this.taskBoard.listTasks(...))
        // while other list endpoints (runtime_list) wrap in { runtimes: [] }.
        // Accept both shapes so we don't silently render an empty kanban
        // when the lead has actually been creating tasks.
        const taskList: BackendTask[] = Array.isArray(taskResult)
          ? taskResult
          : (Array.isArray(taskResult?.tasks) ? taskResult.tasks : []);

        let runtimeList: Runtime[] = [];
        try {
          const rtResult = await callTool<{ runtimes?: BackendRuntime[] }>({
            actor,
            method: 'runtime_list',
            args: { teamId },
            signal: ac.signal,
          });
          runtimeList = Array.isArray(rtResult?.runtimes)
            ? rtResult.runtimes.map(normalizeRuntime)
            : [];
        } catch {
          runtimeList = [];
        }

        let messageList: Message[] = [];
        try {
          const msgResult = await callTool<{ messages?: BackendMessage[] }>({
            actor,
            method: 'message_list',
            args: { teamId },
            signal: ac.signal,
          });
          messageList = Array.isArray(msgResult?.messages)
            ? msgResult.messages.map(normalizeMessage)
            : [];
        } catch {
          messageList = [];
        }

        if (cancelled) return;
        // Trust live data when the API is reachable, even if it's empty. The
        // surfaces render a friendly "No tasks/runtimes yet" empty state in
        // that case so the user knows the UI is talking to a real DB. Seed
        // fallback only kicks in when the API is unreachable (catch path).
        const normalizedTasks = taskList.map((t) => normalizeTask(t, selectedTeamConfig?.lead?.cwd ?? ''));
        setTasks(normalizedTasks);
        setRuntimes(runtimeList);
        setMessages(messageList);
        setTeam(normalizeTeam(selectedTeamConfig, runtimeList, normalizedTasks, activityByAgent));
        setLiveSource('live');
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ToadApiError) {
          setError(`API error: ${err.message}`);
        } else if (err instanceof Error) {
          setError(err.message);
        } else {
          setError('Unknown error loading data');
        }
        setLiveSource('empty');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadOnce();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [preferredTeamId, refreshNonce]);

  const handleEvent = useCallback((event: RuntimeEvent) => {
    if (!event?.type) return;
    if (event.type.startsWith('runtime.') || event.type.startsWith('runtime_')) {
      setRuntimes((prev) => prev.map((r) => {
        if (r.id !== event.runtimeId) return r;
        const status = (event.payload as { status?: AgentStatus })?.status;
        if (!status) return r;
        return { ...r, status: status as Runtime['status'] };
      }));
    }
    if (event.type.startsWith('task.') || event.type.startsWith('task_')) {
      refresh();
    }
    // The backend currently emits no first-class "task.created" event on the
    // SSE bus — task_events are only persisted to SQLite by the facade.
    // But every MCP tool the lead calls (task_create, message_send,
    // task_update, etc.) does fire a 'tool_use' runtime event. Triggering
    // a refresh on tool_use means the kanban + task list update within a
    // second of the lead actually doing something, which is the visible
    // signal the operator wants. Cheap — task_list returns ~hundreds of
    // rows max for a real team.
    if (event.type === 'tool_use') {
      refresh();
    }
    // Live activity feed for the agent cards. Mapped from event types to a
    // short label so the operator can see "Reading product-brief.md",
    // "Created task CP-001", etc. without diving into the raw event log.
    const agentId = typeof event.agentId === 'string' ? event.agentId : null;
    if (agentId) {
      const activity = deriveAgentActivity(event);
      if (activity) {
        setActivityByAgent((prev) => ({ ...prev, [agentId]: activity }));
      }
      // Per-agent stream accumulation. Done here (not in AgentInbox) so the
      // history survives when the operator switches between agent cards.
      streamCounterRef.current += 1;
      const entry = eventToStreamEntry(event, streamCounterRef.current);
      if (entry) {
        setAgentStreams((prev) => {
          const existing = prev[agentId] ?? [];
          // De-dup on entry id — SSE retries can re-emit the same event.
          if (existing.length > 0 && existing[existing.length - 1].id === entry.id) return prev;
          const next = [...existing, entry];
          const trimmed = next.length > MAX_STREAM_PER_AGENT
            ? next.slice(next.length - MAX_STREAM_PER_AGENT)
            : next;
          return { ...prev, [agentId]: trimmed };
        });
      }
    }
  }, [refresh]);

  // Re-derive team membership when activity stream updates so cards show
  // the latest activity even if no fetch happened.
  useEffect(() => {
    setTeam((prev) => {
      if (!prev || prev === EMPTY_TEAM) return prev;
      return {
        ...prev,
        members: prev.members.map((m) => ({ ...m, activity: activityByAgent[m.id] ?? m.activity ?? null })),
      };
    });
  }, [activityByAgent]);

  useToadEvents({ onEvent: handleEvent });

  return { team, tasks, runtimes, messages, loading, error, liveSource, refresh, agentStreams };
}
