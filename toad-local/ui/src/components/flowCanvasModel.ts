// Readability/cockpit — pure model for the For-Me Flow canvas.
// Agent-pivot: lead + members in pipeline order, each with its assigned
// active tasks. Deterministic, React-free, total (never throws). The
// drift-elevation predicate is INJECTED so the model stays pure and the
// threshold stays consistent with the rest of the UI (DriftBadge).

export type FlowStatus = 'todo' | 'in-progress' | 'review' | 'done' | 'blocked' | 'rejected';

export interface FlowMember {
  id: string;
  name: string;
  role: string;
  avatar: string;
  status: string;
  activity?: { label?: string } | null;
}
export interface FlowTask {
  id: string;
  title: string;
  status: FlowStatus;
  assignee: string;
  type?: string;
  riskLevel?: string | null;
  requiresHumanApproval?: boolean;
  humanApproved?: boolean;
  matchedRules?: unknown;
}
export interface FlowRuntimeLite { agent: string; status: string }
export interface FlowDrift { teamScore: number; perTaskScores: Record<string, number> }
export interface FlowTeam { members?: FlowMember[] }

export interface FlowTicker {
  live: number; open: number; inReview: number;
  blocked: number; done: number; driftPct: number | null;
}
export interface FlowLead {
  member: FlowMember; runtimeStatus: string; activity: string; coordinating: number;
}
export interface FlowAgent {
  member: FlowMember; runtimeStatus: string; statusLabel: string;
  activity: string; tasks: FlowTask[]; taskCount: number;
}
export interface FlowWarning {
  id: string; kind: 'approval' | 'drift';
  title: string; sub: string; desc: string; taskId?: string;
}
export interface FlowCanvasModel {
  ticker: FlowTicker;
  lead: FlowLead | null;
  agents: FlowAgent[];
  doneBucket: { count: number; recent: FlowTask[] };
  warnings: FlowWarning[];
}

const PIPELINE_RANK: Record<string, number> = {
  architect: 0, researcher: 1, developer: 2, debugger: 3,
  reviewer: 4, qa: 5, designer: 6,
};

function activityLabel(m: FlowMember | null | undefined): string {
  return m && m.activity && typeof m.activity.label === 'string' ? m.activity.label : '';
}
function isActive(status: string): boolean {
  return status !== 'done' && status !== 'rejected';
}

export function buildFlowCanvas(input: {
  team?: FlowTeam;
  tasks?: FlowTask[];
  runtimes?: FlowRuntimeLite[];
  drift?: FlowDrift | null;
  isDriftElevated?: (score: number) => boolean;
} = {}): FlowCanvasModel {
  const members: FlowMember[] = Array.isArray(input?.team?.members) ? input.team!.members! : [];
  const tasks: FlowTask[] = Array.isArray(input?.tasks) ? input.tasks! : [];
  const runtimes: FlowRuntimeLite[] = Array.isArray(input?.runtimes) ? input.runtimes! : [];
  const drift: FlowDrift | null = input?.drift && typeof input.drift === 'object' ? input.drift : null;
  const isDriftElevated = typeof input?.isDriftElevated === 'function' ? input.isDriftElevated : () => false;

  const runtimeByAgent = new Map<string, string>();
  for (const r of runtimes) {
    if (r && typeof r.agent === 'string') runtimeByAgent.set(r.agent, r.status);
  }

  const lead: FlowMember | null =
    members.find((m) => m && m.role === 'lead') ?? members[0] ?? null;
  const nonLead = members.filter((m) => m && m !== lead);

  const ordered = nonLead
    .map((m, i) => ({ m, i, rank: PIPELINE_RANK[m.role] ?? 99 }))
    .sort((a, b) => (a.rank - b.rank) || (a.i - b.i))
    .map((x) => x.m);

  const agents: FlowAgent[] = ordered.map((m) => {
    const myTasks = tasks.filter((t) => t && t.assignee === m.id && isActive(t.status));
    const rs = runtimeByAgent.get(m.id) ?? m.status;
    return {
      member: m,
      runtimeStatus: rs,
      statusLabel: String(rs),
      activity: activityLabel(m),
      tasks: myTasks,
      taskCount: myTasks.length,
    };
  });

  const doneTasks = tasks.filter((t) => t && t.status === 'done');
  const ticker: FlowTicker = {
    live: runtimes.filter((r) => r && (r.status === 'live' || r.status === 'launching')).length,
    open: tasks.filter((t) => t && isActive(t.status)).length,
    inReview: tasks.filter((t) => t && t.status === 'review').length,
    blocked: tasks.filter((t) => t && t.status === 'blocked').length,
    done: doneTasks.length,
    driftPct: drift && typeof drift.teamScore === 'number' ? drift.teamScore : null,
  };

  const warnings: FlowWarning[] = [];
  for (const t of tasks) {
    if (t && t.requiresHumanApproval && !t.humanApproved) {
      warnings.push({
        id: `approval-${t.id}`, kind: 'approval',
        title: 'Approval needed', sub: t.id, desc: t.title, taskId: t.id,
      });
    }
  }
  if (drift && drift.perTaskScores && typeof drift.perTaskScores === 'object') {
    for (const [id, score] of Object.entries(drift.perTaskScores)) {
      if (typeof score === 'number' && isDriftElevated(score)) {
        warnings.push({
          id: `drift-${id}`, kind: 'drift',
          title: `Drift on ${id}`, sub: 'spec ≠ build',
          desc: 'Build approach diverged; review suggested.', taskId: id,
        });
      }
    }
  }

  return {
    ticker,
    lead: lead
      ? {
          member: lead,
          runtimeStatus: runtimeByAgent.get(lead.id) ?? lead.status,
          activity: activityLabel(lead),
          coordinating: nonLead.length,
        }
      : null,
    agents,
    doneBucket: { count: doneTasks.length, recent: doneTasks.slice(-5) },
    warnings,
  };
}
