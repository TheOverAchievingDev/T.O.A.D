export type RoleId =
  | 'lead'
  | 'developer'
  | 'reviewer'
  | 'researcher'
  | 'debugger'
  | 'qa'
  | 'architect'
  | 'designer';

export interface RoleMeta {
  label: string;
  short: string;
  var: string;
  bg: string;
}

export type AgentStatus = 'thinking' | 'live' | 'idle' | 'launching' | 'error';

export type AgentActivityKind = 'text' | 'tool' | 'thinking' | 'idle';

export interface AgentActivity {
  kind: AgentActivityKind;
  /** Short human-readable label (e.g. "Reading product-brief.md", "Created task CP-001"). */
  label: string;
  /** Raw tool name when kind is "tool"; used for compact verb-form UI labels. */
  tool?: string;
  /** ISO timestamp the activity was observed. */
  at: string;
}

export interface Agent {
  id: string;
  name: string;
  role: RoleId;
  avatar: string;
  status: AgentStatus;
  task: string | null;
  tokens: number;
  tokenLimit: number;
  provider: string;
  model: string;
  tasksDone: number;
  /** Live signal of what this agent is doing right now, derived from SSE
   *  runtime events (tool_use, assistant_text, etc.). null when no event
   *  has been observed yet for this runtime. */
  activity?: AgentActivity | null;
}

export type TeamStatus = 'running' | 'launching' | 'idle' | 'stopped';

export interface Team {
  name: string;
  description: string;
  status: TeamStatus;
  uptime: string;
  project: string;
  branch: string;
  members: Agent[];
}

export interface Message {
  id: number | string;
  from: string;
  to: string;
  time: string;
  body: string;
  isToolCall?: boolean;
}

export type TaskStatus =
  | 'todo'
  | 'in-progress'
  | 'review'
  | 'done'
  | 'blocked'
  | 'rejected';

export type TaskRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface MatchedRiskRule {
  /** Pattern that matched (file glob or command substring). */
  pattern: string;
  /** Risk level the rule contributed. */
  riskLevel?: TaskRiskLevel;
  /** True when the rule forces human approval. */
  requiresHumanApproval?: boolean;
  /** Whether the rule matched files or bash commands. */
  appliesTo?: 'files' | 'commands';
  /** Optional human-readable reason. */
  reason?: string;
}

export interface UiTask {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string;
  project: string;
  riskLevel?: TaskRiskLevel | null;
  requiresHumanApproval?: boolean;
  matchedRules?: MatchedRiskRule[];
  /** True after a human has responded to the §14 gate. */
  humanApproved?: boolean;
  worktree?: {
    status?: string;
    path?: string;
    branch?: string | null;
  } | null;
  testCommands?: string[];
  validations?: UiValidationRun[];
  latestValidation?: Partial<Record<ValidationKind, UiValidationRun>>;
}

export type ValidationKind = 'install' | 'lint' | 'typecheck' | 'test' | 'build' | 'security';
export type ValidationVerdict = 'passed' | 'failed' | 'not_run';

export interface UiValidationRun {
  kind: ValidationKind;
  command: string | null;
  exitCode: number | null;
  durationMs: number | null;
  verdict: ValidationVerdict;
  stdout: string;
  stderr: string;
  stdoutTruncated?: boolean;
  stderrTruncated?: boolean;
  actorId?: string;
  createdAt?: string;
}

export interface Provider {
  id: string;
  label: string;
  models: string[];
}

export type RuntimeStatus = 'live' | 'idle' | 'launching' | 'stopped' | 'error';

export interface Runtime {
  id: string;
  provider: string;
  model: string;
  agent: string;
  pid: number;
  status: RuntimeStatus;
  cpu: number;
  mem: number;
  uptime: string;
  reqs: number;
  tokensIn: number;
  tokensOut: number;
}

export interface Tweaks {
  theme: 'dark' | 'light';
  density: 'comfy' | 'compact';
  layout: 'org' | 'chat' | 'kanban';
  cardVariant: 'detail' | 'compact' | 'terminal';
  screen:
    | 'cockpit'
    | 'workspace'
    | 'tasks'
    | 'settings'
    | 'foundry'
    | 'code'
    | 'costs'
    | 'audit'
    | 'drift'
    | 'picker'
    | 'empty'
    | 'onboarding'
    | 'create'
    | 'launching'
    | 'task';
  agentInbox: string;
  showProviders: boolean;
  showNotifs: boolean;
  showApprovals: boolean;
  showRuntimes: boolean;
  showDiagnostics: boolean;
  showTweaks: boolean;
}
