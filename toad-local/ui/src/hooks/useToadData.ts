import { useCallback, useEffect, useRef, useState } from 'react';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import { useToadEvents, type RuntimeEvent } from '@/api/events';
import type { Team, UiTask, Runtime, Message, RoleId, AgentStatus, TaskStatus, TaskRiskLevel, MatchedRiskRule } from '@/types';
import { SEED_TEAM, SEED_TASKS, SEED_RUNTIMES, SEED_MESSAGES } from '@/data/seed';

const POLL_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui' };

interface BackendTask {
  id: string;
  title?: string;
  status?: TaskStatus | string;
  assignedRole?: RoleId | null;
  assignee?: string;
  project?: string;
  riskLevel?: TaskRiskLevel | null;
  requiresHumanApproval?: boolean;
  matchedRules?: MatchedRiskRule[];
  humanApproved?: boolean;
}

interface BackendRuntime {
  id?: string;
  runtimeId?: string;
  status?: string;
  agentId?: string;
  provider?: string;
  model?: string;
  pid?: number;
  cpu?: number;
  mem?: number;
  uptime?: string;
  reqs?: number;
  tokensIn?: number;
  tokensOut?: number;
}

interface ToadData {
  team: Team;
  tasks: UiTask[];
  runtimes: Runtime[];
  messages: Message[];
  loading: boolean;
  error: string | null;
  liveSource: 'live' | 'seed';
  refresh: () => void;
}

const RISK_LEVELS: TaskRiskLevel[] = ['low', 'medium', 'high', 'critical'];

function normalizeTask(raw: BackendTask, fallbackProject: string): UiTask {
  const status = (raw.status as TaskStatus) ?? 'todo';
  const riskLevel = raw.riskLevel && RISK_LEVELS.includes(raw.riskLevel as TaskRiskLevel)
    ? (raw.riskLevel as TaskRiskLevel)
    : null;
  return {
    id: raw.id,
    title: raw.title ?? raw.id,
    status: ['todo', 'in-progress', 'review', 'done', 'blocked', 'rejected'].includes(status)
      ? (status as TaskStatus)
      : 'todo',
    assignee: raw.assignee ?? raw.assignedRole ?? '',
    project: raw.project ?? fallbackProject,
    riskLevel,
    requiresHumanApproval: raw.requiresHumanApproval === true,
    matchedRules: Array.isArray(raw.matchedRules) ? raw.matchedRules : undefined,
    humanApproved: raw.humanApproved === true,
  };
}

function normalizeRuntime(raw: BackendRuntime): Runtime {
  const id = raw.runtimeId ?? raw.id ?? `rt-${Math.random().toString(36).slice(2, 8)}`;
  const status = (raw.status as Runtime['status']) ?? 'idle';
  return {
    id,
    provider: raw.provider ?? 'anthropic',
    model: raw.model ?? 'unknown',
    agent: raw.agentId ?? '',
    pid: raw.pid ?? 0,
    status: ['live', 'idle', 'launching', 'stopped', 'error'].includes(status)
      ? (status as Runtime['status'])
      : 'idle',
    cpu: raw.cpu ?? 0,
    mem: raw.mem ?? 0,
    uptime: raw.uptime ?? '00:00:00',
    reqs: raw.reqs ?? 0,
    tokensIn: raw.tokensIn ?? 0,
    tokensOut: raw.tokensOut ?? 0,
  };
}

export function useToadData(): ToadData {
  const [team, setTeam] = useState<Team>(SEED_TEAM);
  const [tasks, setTasks] = useState<UiTask[]>(SEED_TASKS);
  const [runtimes, setRuntimes] = useState<Runtime[]>(SEED_RUNTIMES);
  const [messages] = useState<Message[]>(SEED_MESSAGES);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [liveSource, setLiveSource] = useState<'live' | 'seed'>('seed');
  const refreshNonceRef = useRef(0);
  const [refreshNonce, setRefreshNonce] = useState(0);

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

        const taskResult = await callTool<{ tasks?: BackendTask[] }>({
          actor: POLL_ACTOR,
          method: 'task_list',
          args: { teamId: 'default' },
          signal: ac.signal,
        });
        if (cancelled) return;
        const taskList = Array.isArray(taskResult?.tasks) ? taskResult.tasks : [];

        let runtimeList: Runtime[] = [];
        try {
          const rtResult = await callTool<{ runtimes?: BackendRuntime[] }>({
            actor: POLL_ACTOR,
            method: 'runtime_list',
            args: { teamId: 'default' },
            signal: ac.signal,
          });
          runtimeList = Array.isArray(rtResult?.runtimes)
            ? rtResult.runtimes.map(normalizeRuntime)
            : [];
        } catch {
          runtimeList = [];
        }

        if (cancelled) return;
        // Trust live data when the API is reachable, even if it's empty. The
        // surfaces render a friendly "No tasks/runtimes yet" empty state in
        // that case so the user knows the UI is talking to a real DB. Seed
        // fallback only kicks in when the API is unreachable (catch path).
        setTasks(taskList.map((t) => normalizeTask(t, team.project)));
        setRuntimes(runtimeList);
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
        setLiveSource('seed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadOnce();
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [refreshNonce, team.project]);

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
  }, [refresh]);

  useToadEvents({ onEvent: handleEvent });

  return { team, tasks, runtimes, messages, loading, error, liveSource, refresh };
}
