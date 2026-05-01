import { COMMANDS, commandRequiresIdempotency } from '../commands/command-contract.js';

const RECIPIENT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['user', 'agent', 'team', 'system'] },
    teamId: { type: 'string', minLength: 1 },
    agentId: { type: 'string', minLength: 1 },
  },
});

const TEAM_MEMBER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['agentId'],
  properties: {
    agentId: { type: 'string', minLength: 1 },
    command: { type: 'string', minLength: 1 },
    args: { type: 'array', items: { type: 'string' } },
    cwd: { type: 'string', minLength: 1 },
    env: { type: 'object', additionalProperties: { type: 'string' } },
    providerId: { type: 'string', minLength: 1 },
    prompt: { type: 'string' },
  },
});

const LOCAL_MCP_TOOL_DEFINITIONS = Object.freeze([
  makeTool({
    name: COMMANDS.AGENT_STATUS,
    title: 'Agent Status',
    description: 'List runtime status for the current team or inspect one runtime by ID.',
    required: [],
    properties: {
      runtimeId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.APPROVAL_RESPOND,
    title: 'Respond To Approval',
    description: 'Approve or deny a pending runtime approval request.',
    required: ['approvalId', 'decision'],
    properties: {
      approvalId: { type: 'string', minLength: 1 },
      decision: { type: 'string', enum: ['approved', 'denied'] },
      reason: { type: 'string' },
    },
  }),
  makeTool({
    name: COMMANDS.APPROVAL_LIST,
    title: 'List Approvals',
    description: 'List approval requests for the current team.',
    required: [],
    properties: {},
  }),
  makeTool({
    name: COMMANDS.MESSAGE_SEND,
    title: 'Send Message',
    description: 'Send a message from the current agent to a user, team, system, or another agent.',
    required: ['to', 'text'],
    properties: {
      to: RECIPIENT_SCHEMA,
      text: { type: 'string', minLength: 1 },
      kind: {
        type: 'string',
        enum: ['user_goal', 'instruction', 'reply', 'task_notification', 'review_notification', 'system'],
      },
      taskRefs: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['taskId'],
          properties: {
            taskId: { type: 'string', minLength: 1 },
          },
        },
      },
      metadata: { type: 'object' },
      replyToMessageId: { type: 'string', minLength: 1 },
      conversationId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.TASK_CREATE,
    title: 'Create Task',
    description: 'Create a task on the current team task board. Optional `baseRef` pins the task worktree to a specific commit; otherwise it defaults to HEAD at planning time. `baseBranch` records the integration target name for §19 merge workflow.',
    required: ['taskId', 'subject'],
    properties: {
      taskId: { type: 'string', minLength: 1 },
      subject: { type: 'string', minLength: 1 },
      description: { type: 'string' },
      ownerId: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
      baseRef: { type: 'string', minLength: 1 },
      baseBranch: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.TASK_UPDATE,
    title: 'Update Task',
    description: 'Update task ownership or status on the current team task board.',
    required: ['taskId'],
    properties: {
      taskId: { type: 'string', minLength: 1 },
      ownerId: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'deleted'] },
    },
  }),
  makeTool({
    name: COMMANDS.TASK_COMMENT,
    title: 'Comment On Task',
    description: 'Add a comment to a task on the current team task board.',
    required: ['taskId', 'text'],
    properties: {
      taskId: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
      commentId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.REVIEW_REQUEST,
    title: 'Request Review',
    description: 'Request review for a task. Optionally attach diff content, a summary, and the list of files touched.',
    required: ['taskId'],
    properties: {
      taskId: { type: 'string', minLength: 1 },
      reviewerId: { type: 'string', minLength: 1 },
      summary: { type: 'string' },
      diff: { type: 'string' },
      files: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
  }),
  makeTool({
    name: COMMANDS.REVIEW_DECIDE,
    title: 'Decide Review',
    description: 'Approve a task review or request changes. Optionally attach per-file feedback comments.',
    required: ['taskId', 'decision'],
    properties: {
      taskId: { type: 'string', minLength: 1 },
      decision: { type: 'string', enum: ['approved', 'changes_requested'] },
      reason: { type: 'string' },
      feedback: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['file', 'comment'],
          properties: {
            file: { type: 'string', minLength: 1 },
            comment: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  }),
  makeTool({
    name: COMMANDS.REVIEW_LIST,
    title: 'List Open Reviews',
    description: 'List tasks on the current team that have an active review request (diff content included).',
    required: [],
    properties: {},
  }),
  makeTool({
    name: COMMANDS.TASK_LIST,
    title: 'List Tasks',
    description: 'List tasks visible to the current team.',
    required: [],
    properties: {},
  }),
  makeTool({
    name: COMMANDS.RUNTIME_EVENTS,
    title: 'Runtime Events',
    description: 'List recent runtime audit events for the current team. Optionally filter by runtime.',
    required: [],
    properties: {
      runtimeId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.TOOL_ACTIVITY,
    title: 'Tool Activity',
    description: 'List recent tool calls made by agents in the current team. Optionally filter by runtime.',
    required: [],
    properties: {
      runtimeId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.HEALTH_STATUS,
    title: 'Health Status',
    description: 'List API retry events and health summary for the current team. Includes rate-limit and server error counts.',
    required: [],
    properties: {
      runtimeId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.CROSS_TEAM_MESSAGES,
    title: 'Cross-Team Messages',
    description: 'List cross-team messages visible to the current team.',
    required: [],
    properties: {
      limit: { type: 'integer', minimum: 0 },
    },
  }),
  makeTool({
    name: COMMANDS.CROSS_TEAM_SEND,
    title: 'Send Cross-Team Message',
    description: 'Send a message to an agent in another team. The message is delivered to the target team inbox and a sent-copy is kept in the sender inbox.',
    required: ['targetTeamId', 'text'],
    properties: {
      targetTeamId: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
      targetAgentId: { type: 'string', minLength: 1 },
      chainDepth: { type: 'integer', minimum: 0 },
      conversationId: { type: 'string', minLength: 1 },
      replyToConversationId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.AGENT_LAUNCH,
    title: 'Launch Agent Runtime',
    description: 'Spawn a Claude (or other) CLI runtime under the supervisor and register the adapter so the runtime joins the orchestrator event loop. When `taskId` references a task with a created worktree, `cwd` is auto-set to the worktree path; an explicit `cwd` that conflicts with the worktree is rejected.',
    required: ['teamId', 'agentId', 'runtimeId', 'command'],
    properties: {
      teamId: { type: 'string', minLength: 1 },
      agentId: { type: 'string', minLength: 1 },
      runtimeId: { type: 'string', minLength: 1 },
      command: { type: 'string', minLength: 1 },
      args: { type: 'array', items: { type: 'string' } },
      cwd: { type: 'string', minLength: 1 },
      env: { type: 'object', additionalProperties: { type: 'string' } },
      providerId: { type: 'string', minLength: 1 },
      taskId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.AGENT_STOP,
    title: 'Stop Agent Runtime',
    description: 'Stop a running agent runtime by ID. The supervisor sends the requested signal (default SIGTERM) and unregisters the adapter.',
    required: ['runtimeId'],
    properties: {
      runtimeId: { type: 'string', minLength: 1 },
      signal: { type: 'string', enum: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
    },
  }),
  makeTool({
    name: COMMANDS.TEAM_CREATE,
    title: 'Create / Update Team Config',
    description: 'Persist a team configuration (lead + teammates with their launch parameters). Upserts on teamId.',
    required: ['teamId'],
    properties: {
      teamId: { type: 'string', minLength: 1 },
      lead: TEAM_MEMBER_SCHEMA,
      teammates: {
        type: 'array',
        items: TEAM_MEMBER_SCHEMA,
      },
    },
  }),
  makeTool({
    name: COMMANDS.TEAM_LIST,
    title: 'List Team Configs',
    description: 'Return all persisted team configurations.',
    required: [],
    properties: {},
  }),
  makeTool({
    name: COMMANDS.TEAM_DELETE,
    title: 'Delete Team Config',
    description: 'Remove a team configuration. Does not stop running runtimes — call agent_stop / team_stop first.',
    required: ['teamId'],
    properties: {
      teamId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.TEAM_LAUNCH,
    title: 'Launch Team',
    description: 'Launch every member (lead + teammates) of a persisted team config. Runtime IDs are derived as runtime-<teamId>-<agentId>; members already running are skipped (idempotent re-launch).',
    required: ['teamId'],
    properties: {
      teamId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.TEAM_STOP,
    title: 'Stop Team',
    description: 'Stop every running runtime that belongs to the given team. Idempotent when no matching runtimes are running.',
    required: ['teamId'],
    properties: {
      teamId: { type: 'string', minLength: 1 },
      signal: { type: 'string', enum: ['SIGTERM', 'SIGINT', 'SIGKILL'] },
    },
  }),
  makeTool({
    name: COMMANDS.RUNTIME_SEND_INPUT,
    title: 'Send Direct Input To Runtime',
    description: 'Write text directly to a runtime\'s stdin via its adapter, bypassing the broker. Use for slash commands and ad-hoc prompts that should not appear in message history.',
    required: ['runtimeId', 'text'],
    properties: {
      runtimeId: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.VALIDATION_RUN,
    title: 'Run Validation Command',
    description: 'Run a configured validation command (install/lint/typecheck/test/build/security) for a task. The orchestrator spawns the command, captures exit code/stdout/stderr/duration, and records a structured task event. Failed test runs block testing → merge_ready.',
    required: ['taskId', 'kind'],
    properties: {
      taskId: { type: 'string', minLength: 1 },
      kind: {
        type: 'string',
        enum: ['install', 'lint', 'typecheck', 'test', 'build', 'security'],
      },
      command: { type: 'string', minLength: 1 },
      cwd: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.TASK_PLAN_PROPOSE,
    title: 'Propose Task Plan',
    description: 'Submit a structured plan before implementing a task. Required before ready → planned. Plan revisions reset the plan back to "proposed".',
    required: ['taskId'],
    properties: {
      taskId: { type: 'string', minLength: 1 },
      summary: { type: 'string', minLength: 1 },
      filesExpectedToChange: { type: 'array', items: { type: 'string', minLength: 1 } },
      approach: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      validationPlan: { type: 'array', items: { type: 'string' } },
      requiresApproval: { type: 'boolean' },
    },
  }),
  makeTool({
    name: COMMANDS.TASK_PLAN_APPROVE,
    title: 'Approve Task Plan',
    description: 'Approve a proposed plan. The proposing agent cannot approve their own plan. Restricted to lead / architect / human.',
    required: ['taskId'],
    properties: {
      taskId: { type: 'string', minLength: 1 },
      reason: { type: 'string' },
    },
  }),
  makeTool({
    name: COMMANDS.TASK_PLAN_REJECT,
    title: 'Reject Task Plan',
    description: 'Reject a proposed plan and request changes. The proposing agent cannot reject their own plan. Restricted to lead / architect / human.',
    required: ['taskId'],
    properties: {
      taskId: { type: 'string', minLength: 1 },
      reason: { type: 'string' },
    },
  }),
  makeTool({
    name: COMMANDS.DIAGNOSTICS_RUN,
    title: 'Run System Diagnostics',
    description: 'Read-only self-check. Re-runs the enforcement gates (state machine, role authority, plan/CI gates), inspects team validation wiring, probes the Claude CLI, and reports DB persistence. Returns a structured report of pass/warning/fail checks. Available to every role.',
    required: [],
    properties: {},
  }),
]);

export function listLocalMcpTools() {
  return LOCAL_MCP_TOOL_DEFINITIONS.map(cloneJson);
}

export function getLocalMcpTool(name) {
  const toolName = requireString(name, 'name');
  const tool = LOCAL_MCP_TOOL_DEFINITIONS.find((entry) => entry.name === toolName);
  if (!tool) throw new Error(`unknown local MCP tool: ${toolName}`);
  return cloneJson(tool);
}

export async function callLocalMcpTool({
  toolFacade,
  actor,
  name,
  arguments: toolArguments = {},
}) {
  if (!toolFacade || typeof toolFacade.execute !== 'function') {
    throw new TypeError('toolFacade with execute() is required');
  }
  const toolName = getLocalMcpTool(name).name;
  const args = toolArguments && typeof toolArguments === 'object' ? { ...toolArguments } : {};
  const idempotencyKey = commandRequiresIdempotency(toolName)
    ? requireString(args.idempotencyKey, 'idempotencyKey')
    : null;
  delete args.idempotencyKey;

  const result = await toolFacade.execute({
    commandName: toolName,
    idempotencyKey,
    actor,
    args,
  });

  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

function makeTool({ name, title, description, required, properties }) {
  const mutating = commandRequiresIdempotency(name);
  const schemaProperties = {
    ...(mutating
      ? { idempotencyKey: { type: 'string', minLength: 1 } }
      : {}),
    ...properties,
  };
  return Object.freeze({
    name,
    title,
    description,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: mutating ? ['idempotencyKey', ...required] : [...required],
      properties: schemaProperties,
    },
    annotations: mutating
      ? {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        }
      : {
          readOnlyHint: true,
        },
  });
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
