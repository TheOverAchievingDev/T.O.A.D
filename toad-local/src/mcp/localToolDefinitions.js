import { COMMANDS, commandRequiresIdempotency } from '../commands/command-contract.js';
import { TASK_RISK_LEVELS } from '../task/inMemoryTaskBoard.js';

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
    role: {
      type: 'string',
      enum: ['lead', 'developer', 'reviewer', 'researcher', 'debugger', 'qa', 'architect', 'designer'],
    },
    prompt: { type: 'string' },
    skipPermissions: { type: 'boolean' },
  },
});

const STRING_LIST_SCHEMA = Object.freeze({
  type: 'array',
  items: { type: 'string', minLength: 1 },
});

const IDE_SOURCE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['project', 'task_worktree'] },
    taskId: { type: 'string', minLength: 1 },
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
      allowedFiles: STRING_LIST_SCHEMA,
      forbiddenFiles: STRING_LIST_SCHEMA,
      acceptanceCriteria: STRING_LIST_SCHEMA,
      riskLevel: { type: 'string', enum: TASK_RISK_LEVELS },
      requiresHumanApproval: { type: 'boolean' },
      priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
      assignedRole: { type: 'string', enum: ['lead', 'architect', 'developer', 'reviewer', 'tester', 'human'] },
      testCommands: STRING_LIST_SCHEMA,
      expectedDeliverables: STRING_LIST_SCHEMA,
      dependencyTaskIds: STRING_LIST_SCHEMA,
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
    description: 'Approve a task review or request changes. Optionally attach per-file feedback comments. Each feedback item can carry an optional severity (nit/minor/major/blocking) to help prioritize follow-up work.',
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
            severity: { type: 'string', enum: ['nit', 'minor', 'major', 'blocking'] },
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
    name: COMMANDS.IDE_TREE_LIST,
    title: 'IDE Tree List',
    description: 'Read-only. Lists files under the selected project root or task worktree for the Code view.',
    required: [],
    properties: {
      source: IDE_SOURCE_SCHEMA,
      maxEntries: { type: 'integer', minimum: 1, maximum: 10000 },
    },
  }),
  makeTool({
    name: COMMANDS.IDE_READ_FILE,
    title: 'IDE Read File',
    description: 'Read-only. Reads a UTF-8 text file from the selected project root or task worktree for the Code view.',
    required: ['relativePath'],
    properties: {
      source: IDE_SOURCE_SCHEMA,
      relativePath: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.IDE_WRITE_FILE,
    title: 'IDE Write File',
    description: 'Mutating. Writes a UTF-8 text file under the selected project root or task worktree for the Code view.',
    required: ['relativePath', 'content'],
    properties: {
      source: IDE_SOURCE_SCHEMA,
      relativePath: { type: 'string', minLength: 1 },
      content: { type: 'string' },
      expectedSha256: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.IDE_GET_STATUS,
    title: 'IDE Get Status',
    description: 'Read-only. Returns git status for files in the selected project root or task worktree.',
    required: [],
    properties: {
      source: IDE_SOURCE_SCHEMA,
    },
  }),
  makeTool({
    name: COMMANDS.IDE_GET_DIFF,
    title: 'IDE Get Diff',
    description: 'Read-only. Returns the unified git diff for a specific file (or all modified files if relativePath is omitted).',
    required: [],
    properties: {
      source: IDE_SOURCE_SCHEMA,
      relativePath: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.IDE_SEARCH_FILES,
    title: 'IDE Search Files',
    description: 'Read-only. Searches for text across files in a project or task worktree. Uses case-insensitive regex matching natively through git grep.',
    required: ['query'],
    properties: {
      source: IDE_SOURCE_SCHEMA,
      query: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.IDE_CHECKPOINT_TASK,
    title: 'IDE Checkpoint Task',
    description: 'Mutating. Creates a formal git commit on the task worktree branch for all current modifications. Restricted to lead and human roles.',
    required: ['message'],
    properties: {
      source: IDE_SOURCE_SCHEMA,
      message: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.IDE_APPLY_PATCH,
    title: 'IDE Apply Patch',
    description: 'Mutating. Reverts or applies a specific hunk patch to the task worktree using git apply. Restricted to lead and human roles.',
    required: ['patchContent'],
    properties: {
      source: IDE_SOURCE_SCHEMA,
      patchContent: { type: 'string', minLength: 1 },
      reverse: { type: 'boolean' },
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
      role: { type: 'string', enum: ['lead', 'architect', 'developer', 'reviewer', 'tester', 'human'] },
      skipPermissions: { type: 'boolean' },
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
    name: COMMANDS.EAS_PROJECT_INFO,
    title: 'EAS Project Info',
    description: 'Get EAS (Expo Application Services) project configuration and ID.',
    required: [],
    properties: {
      cwd: { type: 'string', description: 'Directory containing app.json / eas.json. Defaults to project root.' },
    },
  }),
  makeTool({
    name: COMMANDS.EAS_BUILD,
    title: 'EAS Build',
    description: 'Trigger a mobile app build on EAS. Returns a jobId immediately; build runs in background.',
    required: ['platform'],
    properties: {
      platform: { type: 'string', enum: ['android', 'ios', 'all'], description: 'Target platform.' },
      profile: { type: 'string', description: 'Build profile from eas.json (e.g. production, development). Defaults to production.' },
      cwd: { type: 'string', description: 'Directory containing app.json / eas.json.' },
    },
  }),
  makeTool({
    name: COMMANDS.EAS_UPDATE,
    title: 'EAS Update',
    description: 'Trigger an Over-The-Air (OTA) update on EAS. Returns a jobId immediately; update runs in background.',
    required: ['branch', 'message'],
    properties: {
      branch: { type: 'string', description: 'EAS branch to publish to.' },
      message: { type: 'string', description: 'Update message / release notes.' },
      cwd: { type: 'string', description: 'Directory containing app.json / eas.json.' },
    },
  }),
  makeTool({
    name: COMMANDS.PLUGIN_JOB_GET,
    title: 'Get Plugin Job',
    description: 'Get the current status and log tail for a background plugin job (e.g. an EAS build).',
    required: ['jobId'],
    properties: {
      jobId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.PLUGIN_JOB_LIST,
    title: 'List Plugin Jobs',
    description: 'List recent background jobs for the team.',
    required: [],
    properties: {
      state: { type: 'string', enum: ['pending', 'running', 'finished', 'error'] },
      limit: { type: 'integer', minimum: 1, maximum: 500 },
    },
  }),
  makeTool({
    name: COMMANDS.VERCEL_LINK,
    title: 'Vercel Link',
    description: 'Sync local development with Vercel (vercel link --yes). Connects a directory to a project.',
    required: [],
    properties: {
      cwd: { type: 'string', description: 'Directory to link.' },
    },
  }),
  makeTool({
    name: COMMANDS.VERCEL_ENV_PULL,
    title: 'Vercel Env Pull',
    description: 'Pull environment variables from Vercel (vercel env pull .env.local --yes).',
    required: [],
    properties: {
      cwd: { type: 'string', description: 'Directory containing .env.local.' },
    },
  }),
  makeTool({
    name: COMMANDS.VERCEL_DEPLOY,
    title: 'Vercel Deploy',
    description: 'Trigger a Vercel deployment. Returns a jobId immediately; deployment runs in background.',
    required: [],
    properties: {
      prod: { type: 'boolean', description: 'Deploy to production.' },
      cwd: { type: 'string', description: 'Project directory.' },
    },
  }),
  makeTool({
    name: COMMANDS.VERCEL_LS,
    title: 'Vercel List Deployments',
    description: 'List recent Vercel deployments.',
    required: [],
    properties: {
      cwd: { type: 'string', description: 'Project directory.' },
    },
  }),
  makeTool({
    name: COMMANDS.TEAM_CREATE,
    title: 'Create / Update Team Config',
    description: 'Persist a team configuration (lead + teammates with their launch parameters). Upserts on teamId. Optional `validation` block sets the team\'s default install/lint/typecheck/test/build/security commands — new tasks pre-fill from these unless overridden per-task.',
    required: ['teamId'],
    properties: {
      teamId: { type: 'string', minLength: 1 },
      lead: TEAM_MEMBER_SCHEMA,
      teammates: {
        type: 'array',
        items: TEAM_MEMBER_SCHEMA,
      },
      validation: {
        type: 'object',
        additionalProperties: false,
        properties: {
          installCommand: { type: 'string', minLength: 1 },
          lintCommand: { type: 'string', minLength: 1 },
          typecheckCommand: { type: 'string', minLength: 1 },
          testCommand: { type: 'string', minLength: 1 },
          buildCommand: { type: 'string', minLength: 1 },
          securityCommand: { type: 'string', minLength: 1 },
        },
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
  makeTool({
    name: COMMANDS.DRIFT_CORRECTION_CREATE,
    title: 'Create Drift Correction Task',
    description: 'Create a correction task linked to one or more drift findings. The task lands in backlog with the offending evidence in its description; the linked findings are excluded from drift score until the correction task hits done/rejected.',
    required: ['findingIds', 'subject', 'riskLevel'],
    properties: {
      findingIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: 'One or more drift finding IDs to link.',
      },
      subject: { type: 'string', description: '1-line task subject.' },
      description: { type: 'string', description: 'Markdown description (caller pre-aggregates if multi-finding).' },
      riskLevel: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Risk classification.' },
      teamId: { type: 'string', description: 'Optional team ID; defaults to actor.teamId.' },
    },
  }),
  makeTool({
    name: COMMANDS.DRIFT_RUN,
    title: 'Run Drift Engine',
    description: 'Read-only. Trigger a drift engine run for the current team. Returns the full finding list and per-task scores.',
    required: [],
    properties: {},
  }),
  makeTool({
    name: COMMANDS.FOUNDRY_SESSION_CREATE,
    title: 'Create Foundry Session',
    description: 'Create a persisted Foundry planning session. Foundry sessions capture project discovery chat and produce repo-exportable planning artifacts for TOAD teams.',
    required: ['title'],
    properties: {
      sessionId: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1 },
      projectPath: { type: 'string', minLength: 1 },
      metadata: { type: 'object' },
      provider: {
        type: 'string',
        enum: ['anthropic', 'openai'],
        description: 'Which CLI provider to use for planning. Defaults to anthropic.',
      },
    },
  }),
  makeTool({
    name: COMMANDS.FOUNDRY_SESSION_LIST,
    title: 'List Foundry Sessions',
    description: 'List persisted Foundry planning sessions with message and artifact counts.',
    required: [],
    properties: {},
  }),
  makeTool({
    name: COMMANDS.PROJECT_STATE_DESCRIBE,
    title: 'Describe Project State',
    description: 'Read-only inspection of the loaded project. Returns one of three states (fresh / half_foundried / has_team) plus a reopenContext block when a team exists. Used by the UI to decide whether to route reopen to Cockpit or Foundry.',
    required: [],
    properties: {},
  }),
  makeTool({
    name: COMMANDS.FOUNDRY_SESSION_GET,
    title: 'Get Foundry Session',
    description: 'Read one Foundry session, including captured messages and generated artifacts.',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.FOUNDRY_MESSAGE_ADD,
    title: 'Add Foundry Message',
    description: 'Append a user, assistant, or system note to a Foundry planning session.',
    required: ['sessionId', 'text'],
    properties: {
      messageId: { type: 'string', minLength: 1 },
      sessionId: { type: 'string', minLength: 1 },
      role: { type: 'string', enum: ['user', 'assistant', 'system'] },
      text: { type: 'string', minLength: 1 },
      metadata: { type: 'object' },
    },
  }),
  makeTool({
    name: COMMANDS.FOUNDRY_CHAT_TURN,
    title: 'Run Foundry Chat Turn',
    description: 'Append an operator message, dispatch to the session\'s configured CLI agent (Claude or Codex per session.provider), and store the assistant reply in the Foundry session.',
    required: ['sessionId', 'text'],
    properties: {
      sessionId: { type: 'string', minLength: 1 },
      text: { type: 'string', minLength: 1 },
      model: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.FOUNDRY_ARTIFACT_UPSERT,
    title: 'Upsert Foundry Artifact',
    description: 'Create or update one Foundry artifact. Reusing an artifactId increments its version.',
    required: ['sessionId', 'kind', 'title', 'content'],
    properties: {
      artifactId: { type: 'string', minLength: 1 },
      sessionId: { type: 'string', minLength: 1 },
      kind: { type: 'string', minLength: 1 },
      title: { type: 'string', minLength: 1 },
      content: { type: 'string' },
      targetPath: { type: 'string', minLength: 1 },
      status: { type: 'string', enum: ['draft', 'approved', 'exported'] },
      metadata: { type: 'object' },
    },
  }),
  makeTool({
    name: COMMANDS.FOUNDRY_ARTIFACT_GENERATE,
    title: 'Generate Foundry Artifacts',
    description: 'Generate deterministic first-draft planning artifacts from a Foundry session: product brief, technical spec, roadmap, Prisma schema draft, and TOAD task breakdown.',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.FOUNDRY_ARTIFACT_EXPORT,
    title: 'Export Foundry Artifacts',
    description: 'Write Foundry artifacts to repo files under their targetPath values. Export is constrained to the configured project root.',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string', minLength: 1 },
      artifactIds: { type: 'array', items: { type: 'string', minLength: 1 } },
      rootDir: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.FOUNDRY_PROJECT_MATERIALIZE,
    title: 'Materialize Foundry Project',
    description: 'Convert a Foundry planning session into a working Symphony AI project package. Mode "apply" (default) exports docs, creates the team, and seeds starter tasks end-to-end. Mode "plan" only exports docs and returns a suggested team config + task list — used by the UI to seed the CreateTeamModal so the user can craft the team before launch. Restricted to lead/human/architect roles.',
    required: ['sessionId'],
    properties: {
      sessionId: { type: 'string', minLength: 1 },
      teamId: { type: 'string', minLength: 1 },
      rootDir: { type: 'string', minLength: 1 },
      cwd: { type: 'string', minLength: 1 },
      validation: { type: 'object' },
      mode: { type: 'string', enum: ['plan', 'apply'] },
    },
  }),
  makeTool({
    name: COMMANDS.FOUNDRY_PROJECT_SEED_TASKS,
    title: 'Seed Foundry Tasks',
    description: 'Seed starter tasks from a Foundry session into an existing team. Used by the UI flow that creates the team via CreateTeamModal first, then attaches Foundry-derived tasks afterwards. Restricted to lead/human/architect roles.',
    required: ['sessionId', 'teamId'],
    properties: {
      sessionId: { type: 'string', minLength: 1 },
      teamId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.TASK_HISTORY_EXPORT,
    title: 'Export Task History',
    description: 'Read-only audit export. Returns the task projection, every task_event in chronological order (CREATED, STATUS_CHANGED, COMMENT_ADDED, REVIEW_*, VALIDATION_RUN, PLAN_*, WORKTREE_*), and runtime_events whose runtime was pinned to this task. Available to every role.',
    required: ['taskId'],
    properties: {
      taskId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.TASK_HUMAN_APPROVE,
    title: 'Human-Approve Task',
    description: 'Record an explicit human approval on a task. Required to clear the §14 human-approval gate before merge_ready → done when the task has requiresHumanApproval=true (set by operator at task_create or auto-elevated by the risk-policy classifier on review_request). Restricted to lead and human roles.',
    required: ['taskId'],
    properties: {
      taskId: { type: 'string', minLength: 1 },
      reason: { type: 'string' },
    },
  }),
  makeTool({
    name: COMMANDS.STUCK_RUNTIME_LIST,
    title: 'List Stuck Runtimes',
    description: 'Read-only. Returns running runtimes whose runtime_events stream has been silent past `thresholdMs` (default 15 minutes). Useful for catching agents stuck in tool loops, waiting on permissions, or zombie processes. Available to every role.',
    required: [],
    properties: {
      thresholdMs: { type: 'integer', minimum: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.SETTINGS_GET,
    title: 'Get Settings',
    description: '§3 Read TOAD settings. Defaults to the merged effective view (project overrides global). Pass scope: "global" or "project" to read a single tier. Settings are split into top-level sections: general, providers, github, workspace, risk, mcp, notifications, advanced.',
    required: [],
    properties: {
      scope: { type: 'string', enum: ['global', 'project', 'effective'] },
    },
  }),
  makeTool({
    name: COMMANDS.SETTINGS_SET,
    title: 'Set Settings Section',
    description: '§3 Write a single settings section to the chosen scope. Existing sections in the same file are preserved. Restricted to lead and human roles. Global writes go to %APPDATA%/toad/settings.json (Windows) or ~/.config/toad/settings.json (Unix). Project writes go to <projectCwd>/.toad/settings.json.',
    required: ['scope', 'section', 'value'],
    properties: {
      scope: { type: 'string', enum: ['global', 'project'] },
      section: { type: 'string', minLength: 1 },
      value: { type: 'object' },
    },
  }),
  makeTool({
    name: COMMANDS.GITHUB_DEVICE_START,
    title: 'Start GitHub Device Flow',
    description: '§3c Step 1 of GitHub OAuth Device Flow. Returns a device_code, user_code, and verification URL. The UI shows the user_code to the operator, opens the verification URL in their browser, and polls github_device_poll until the user authorizes. Restricted to lead and human roles.',
    required: [],
    properties: {
      clientId: { type: 'string', minLength: 1 },
      scopes: { type: 'array', items: { type: 'string', minLength: 1 } },
    },
  }),
  makeTool({
    name: COMMANDS.GITHUB_DEVICE_POLL,
    title: 'Poll GitHub Device Flow',
    description: '§3c Step 2 of GitHub OAuth Device Flow. Exchanges the device_code for an access token. Returns { status: "granted", user, scopes } on success or { status: "pending", reason } while the operator is still authorizing. On grant, persists creds to settings.github automatically.',
    required: ['deviceCode'],
    properties: {
      deviceCode: { type: 'string', minLength: 1 },
      clientId: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.GITHUB_PAT_VERIFY,
    title: 'Verify GitHub Personal Access Token',
    description: '§3c PAT fallback. Verifies the supplied token by calling /user, captures profile + scopes, and persists creds to settings.github. Restricted to lead and human roles.',
    required: ['token'],
    properties: {
      token: { type: 'string', minLength: 1 },
    },
  }),
  makeTool({
    name: COMMANDS.GITHUB_DISCONNECT,
    title: 'Disconnect GitHub',
    description: '§3c Clears stored GitHub credentials (token, user, scopes) from settings.github. Preserves clientId. Restricted to lead and human roles.',
    required: [],
    properties: {},
  }),
  makeTool({
    name: COMMANDS.GITHUB_STATUS,
    title: 'GitHub Connection Status',
    description: '§3c Read-only. Returns the current GitHub connection state without exposing the token: { status: "connected" | "disconnected", source, user, scopes, connectedAt, clientIdConfigured }.',
    required: [],
    properties: {},
  }),
  makeTool({
    name: COMMANDS.GITHUB_GET_REPOSITORY,
    title: 'Get GitHub Repository',
    description: '§3c Read-only. Calls GET /repos/{owner}/{repo} with the stored access token and returns normalized metadata (defaultBranch, visibility, license, permissions, etc.). Returns { ok: false, status } on 401/403/404 instead of throwing. Errors with "not connected" if no token is stored.',
    required: ['owner', 'repo'],
    properties: {
      owner: { type: 'string', minLength: 1, description: 'Repo owner (user or organization).' },
      repo: { type: 'string', minLength: 1, description: 'Repo name.' },
    },
  }),
  makeTool({
    name: COMMANDS.GITHUB_GET_BRANCH_PROTECTION,
    title: 'Get GitHub Branch Protection',
    description: '§3c Read-only. Calls GET /repos/{owner}/{repo}/branches/{branch}/protection and returns a normalized "what would block a direct push" view: { protected, requiresPullRequest, requiredApprovingReviewCount, requiresStatusChecks, requiredStatusCheckContexts, enforceAdmins, allowForcePushes, allowDeletions, requiresLinearHistory, hasPushRestrictions }. GitHub returns 404 for unprotected branches — this tool maps that to { ok: true, protected: false } so callers don\'t have to special-case. Real auth failures still surface as { ok: false, status }.',
    required: ['owner', 'repo', 'branch'],
    properties: {
      owner: { type: 'string', minLength: 1, description: 'Repo owner.' },
      repo: { type: 'string', minLength: 1, description: 'Repo name.' },
      branch: { type: 'string', minLength: 1, description: 'Branch name (URL-encoded automatically).' },
    },
  }),
  makeTool({
    name: COMMANDS.GITHUB_ORIGIN_REMOTE,
    title: 'Get GitHub Origin Remote',
    description: '§3c Read-only. Reads `git remote get-url origin` from the project working directory and returns the parsed { ok: true, owner, repo } when origin is a github.com URL. Soft-fails with { ok: false, reason: "no_origin_remote"|"origin_not_github"|"no_project_cwd" } for non-GitHub or missing-remote setups so the UI can hide GitHub-specific affordances.',
    required: [],
    properties: {},
  }),
  makeTool({
    name: COMMANDS.GITHUB_CREATE_PULL_REQUEST,
    title: 'Create GitHub Pull Request',
    description: '§3c MUTATING. Calls POST /repos/{owner}/{repo}/pulls to open a PR from `head` (task branch, optionally `owner:branch` for cross-fork) into `base`. Returns { ok: true, pr: { number, htmlUrl, state, head, base, ... } } on success, or { ok: false, status: 422, message, errors } on GitHub validation failures (PR already exists, head branch not pushed, etc.) so the UI can show the actual reason. Restricted to lead and human roles. Requires an idempotencyKey on the envelope.',
    required: ['owner', 'repo', 'head', 'base', 'title'],
    properties: {
      owner: { type: 'string', minLength: 1, description: 'Repo owner.' },
      repo: { type: 'string', minLength: 1, description: 'Repo name.' },
      head: { type: 'string', minLength: 1, description: 'Source branch (use "owner:branch" for cross-fork PRs).' },
      base: { type: 'string', minLength: 1, description: 'Target branch — typically the repo default branch.' },
      title: { type: 'string', minLength: 1, description: 'PR title.' },
      body: { type: 'string', description: 'PR description body (Markdown). Optional.' },
      draft: { type: 'boolean', description: 'Open as draft PR. Defaults to false.' },
    },
  }),
  makeTool({
    name: COMMANDS.GITHUB_CREATE_REPOSITORY,
    title: 'Create GitHub Repository',
    description: 'MUTATING. Calls POST /user/repos to create a new repository on GitHub under the authenticated user. Returns { ok: true, repo: { name, fullName, htmlUrl, cloneUrl, sshUrl, private, defaultBranch } }. 422 means the name is taken or invalid. Used by the new-project flow to create + connect a remote in one click. Restricted to lead and human roles. Requires an idempotencyKey.',
    required: ['name'],
    properties: {
      name: { type: 'string', minLength: 1, description: 'Repository name (becomes the path segment, e.g. `my-project`).' },
      description: { type: 'string', description: 'Repo description.' },
      private: { type: 'boolean', description: 'Defaults to true.' },
      autoInit: { type: 'boolean', description: 'When true, GitHub initializes the repo with an empty README. Leave false if you\'re going to push existing local commits.' },
    },
  }),
  makeTool({
    name: COMMANDS.GIT_INIT_LOCAL,
    title: 'Initialize Local Git Repo',
    description: 'MUTATING. Runs `git init --initial-branch <branch>` in the project working directory. Idempotent — returns `{ ok: true, alreadyInitialized: true }` if `.git` already exists. Used by the new-project flow before connecting a GitHub remote. Restricted to lead and human roles.',
    required: [],
    properties: {
      cwd: { type: 'string', minLength: 1, description: 'Override the project working dir (rarely needed).' },
      initialBranch: { type: 'string', minLength: 1, description: 'Initial branch name. Defaults to `main`.' },
    },
  }),
  makeTool({
    name: COMMANDS.GIT_SET_REMOTE,
    title: 'Set Git Remote URL',
    description: 'MUTATING. Adds or updates a git remote (default name: `origin`). Used after `github_create_repository` to wire the new GitHub repo as the local repo\'s origin. Restricted to lead and human roles.',
    required: ['url'],
    properties: {
      url: { type: 'string', minLength: 1, description: 'The remote URL (https://… or git@…).' },
      name: { type: 'string', minLength: 1, description: 'Remote name. Defaults to `origin`.' },
      cwd: { type: 'string', minLength: 1, description: 'Override the project working dir.' },
    },
  }),
  makeTool({
    name: COMMANDS.RISK_POLICY_GET,
    title: 'Get Risk Policy',
    description: '§3d Read .toad/risk-policy.json. Returns { rules, commandRules, path, exists, malformed } so the editor can populate from a clean slate when missing or surface a parse error.',
    required: [],
    properties: {},
  }),
  makeTool({
    name: COMMANDS.RISK_POLICY_SET,
    title: 'Set Risk Policy',
    description: '§3d Replace .toad/risk-policy.json with the supplied rules + commandRules. Restricted to lead and human roles. Each rule must specify pattern (string) + at least one of riskLevel ("low"|"medium"|"high"|"critical") or requiresHumanApproval=true.',
    required: [],
    properties: {
      rules: { type: 'array', items: { type: 'object' } },
      commandRules: { type: 'array', items: { type: 'object' } },
    },
  }),
  makeTool({
    name: COMMANDS.RISK_POLICY_PREVIEW,
    title: 'Preview Risk Policy',
    description: '§3d Run the supplied (or current on-disk) policy against a list of files + commands and return the §14 classifier verdict — riskLevel, requiresHumanApproval, matchedRules. Useful for the live-preview pane in the editor.',
    required: [],
    properties: {
      files: { type: 'array', items: { type: 'string', minLength: 1 } },
      commands: { type: 'array', items: { type: 'string', minLength: 1 } },
      policy: { type: 'object' },
    },
  }),
  makeTool({
    name: COMMANDS.PROVIDER_AUTH_STATUS,
    title: 'Provider Plan-Auth Status',
    description: '§3c.2 Read the current subscription/plan auth status for a provider by shelling out to its CLI (e.g. `claude auth status --json`). Returns { signedIn, user, plan, subscriptionType, authMethod } when supported, or { supported: false, reason } when the CLI auth surface for that provider isn’t wired yet.',
    required: ['providerId'],
    properties: {
      providerId: { type: 'string', enum: ['anthropic', 'openai', 'gemini', 'opencode'] },
    },
  }),
  makeTool({
    name: COMMANDS.PROVIDER_AUTH_LOGIN,
    title: 'Trigger Provider Plan-Auth Login',
    description: '§3c.2 Spawn the provider CLI’s `auth login` command (detached) so it can open a browser tab. Returns immediately with { started, pid }. Restricted to lead and human roles. The UI polls provider_auth_status until signedIn flips true.',
    required: ['providerId'],
    properties: {
      providerId: { type: 'string', enum: ['anthropic', 'openai', 'gemini', 'opencode'] },
    },
  }),
  makeTool({
    name: COMMANDS.PROVIDER_AUTH_LOGOUT,
    title: 'Trigger Provider Plan-Auth Logout',
    description: '§3c.2 Spawn the provider CLI’s `auth logout` command synchronously. Restricted to lead and human roles.',
    required: ['providerId'],
    properties: {
      providerId: { type: 'string', enum: ['anthropic', 'openai', 'gemini', 'opencode'] },
    },
  }),
  makeTool({
    name: COMMANDS.AUDIT_LOG_QUERY,
    title: 'Query Audit Log',
    description: '§20 Returns a chronologically-sorted (newest first) merge of task events + runtime events for the actor’s team. Each event carries a _source tag (`task` or `runtime`). Supports `limit` (default 200, max 1000) and optional `sinceMs` filter. Read-only; available to every role.',
    required: [],
    properties: {
      limit: { type: 'integer', minimum: 1, maximum: 1000 },
      sinceMs: { type: 'integer', minimum: 0 },
    },
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
