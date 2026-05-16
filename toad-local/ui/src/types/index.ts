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
  contextStale?: boolean;
  contextSource?: 'precise' | 'coarse' | 'unknown';
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
  /** Task type: 'feature' (default) or 'bug'. Bug tasks bypass the
   *  plan-propose-approve cycle in agent behavior. Legacy tasks without
   *  the field render as feature. */
  type?: 'feature' | 'bug';
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
  /** Phase 3d Task 13 — file-scope contract. When an editor opens a
   *  file in this list, the editor header shows an "in scope for t_42"
   *  chip so the user knows the task is the authoritative reason
   *  this file is being edited. Optional; legacy tasks omit it. */
  allowedFiles?: string[];
  forbiddenFiles?: string[];
  validations?: UiValidationRun[];
  latestValidation?: Partial<Record<ValidationKind, UiValidationRun>>;
  review?: UiTaskReview | null;
}

export interface UiTaskReview {
  summary?: string | null;
  diff?: string | null;
  files: string[];
  scopeDrift: string[];
  noOpDiff: boolean;
  reviewerId?: string | null;
  requestedBy?: string;
  requestedAt?: string;
  decision?: string | null;
  reason?: string | null;
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
  contextUsage?: {
    used: number | null; total: number | null; percentage: number | null;
    model: string | null; provider: string; lastUpdatedAt: string | null;
    stale: boolean; source: 'precise' | 'coarse' | 'unknown';
  } | null;
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
  /** Phase 2 panel toggles. */
  showSidebar: boolean;
  showBottomPanel: boolean;
  showRightPanel: boolean;
  /** Phase 2 bottom-panel active tab. */
  bottomPanelTab: 'terminal' | 'problems' | 'output' | 'validations';
  /** Phase 3b — Tasks screen group-by selector. Persists so the
   *  operator returns to the same view. */
  tasksGroupBy: 'status' | 'assignee' | 'type' | 'risk';
  /** Phase 3b Task 8 — saved filter chip applied on top of grouping.
   *  'all' = no filter; default. */
  tasksFilter: 'all' | 'active' | 'needsApproval' | 'blocked' | 'review';
  /** Phase 2 right-panel agent selection — which agent the Agent Inbox
   *  is currently talking to. null = use the lead. Persists across
   *  sessions so the operator returns to the same conversation. */
  rightPanelAgent: string | null;
  /** Developer mode opt-in — reveals power-user surfaces. Default false. */
  developerMode: boolean;
  /** First-run flag — false until the user sends their first Foundry
   *  message or dismisses the welcome banner. Persisted in localStorage
   *  via useTweaks. Used by App.tsx to route brand-new users directly
   *  to Foundry chat instead of the project picker. */
  firstRunComplete: boolean;
}
