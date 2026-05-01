import { spawnSync } from 'node:child_process';
import { COMMANDS, commandRequiresIdempotency } from '../commands/command-contract.js';
import { MESSAGE_KINDS } from '../protocol/envelopes.js';
import {
  TASK_EVENT_TYPES,
  TASK_STATUS,
} from '../task/inMemoryTaskBoard.js';
import { applyPermissionSuggestions } from '../runtime/claudeSettingsWriter.js';
import { formatCrossTeamText, CROSS_TEAM_SOURCE, CROSS_TEAM_SENT_SOURCE } from '../protocol/crossTeam.js';
import { TeamConfig } from '../team/teamConfig.js';
import { validateTaskStatusTransition } from '../task/taskLifecycle.js';
import { assertRoleCanCallTool } from '../security/roleAuthority.js';

export class LocalToolFacade {
  constructor({ broker, taskBoard, runtimeRegistry = null, approvalBroker = null, adapters = null, projectCwd = null, readModel = null, launchAgent = null, stopAgent = null, teamConfigRegistry = null, spawnValidation = null }) {
    if (!broker) throw new TypeError('broker is required');
    if (!taskBoard) throw new TypeError('taskBoard is required');
    this.broker = broker;
    this.taskBoard = taskBoard;
    this.runtimeRegistry = runtimeRegistry;
    this.approvalBroker = approvalBroker;
    this.adapters = adapters;
    this.projectCwd = projectCwd;
    this.readModel = readModel;
    this.launchAgent = typeof launchAgent === 'function' ? launchAgent : null;
    this.stopAgent = typeof stopAgent === 'function' ? stopAgent : null;
    this.teamConfigRegistry = teamConfigRegistry;
    this.spawnValidation = typeof spawnValidation === 'function' ? spawnValidation : defaultSpawnValidation;
  }

  execute(command) {
    const commandName = requireString(command.commandName, 'commandName');
    if (commandRequiresIdempotency(commandName)) {
      requireString(command.idempotencyKey, 'idempotencyKey');
    }
    const actor = normalizeActor(command.actor);
    assertRoleCanCallTool({ role: actor.role, toolName: commandName });
    const args = command.args && typeof command.args === 'object' ? command.args : {};

    switch (commandName) {
      case COMMANDS.MESSAGE_SEND:
        return this.#messageSend(actor, command.idempotencyKey, args);
      case COMMANDS.TASK_CREATE:
        return this.#taskCreate(actor, command.idempotencyKey, args);
      case COMMANDS.TASK_COMMENT:
        return this.#taskComment(actor, command.idempotencyKey, args);
      case COMMANDS.TASK_UPDATE:
        return this.#taskUpdate(actor, command.idempotencyKey, args);
      case COMMANDS.REVIEW_REQUEST:
        return this.#reviewRequest(actor, command.idempotencyKey, args);
      case COMMANDS.REVIEW_DECIDE:
        return this.#reviewDecide(actor, command.idempotencyKey, args);
      case COMMANDS.REVIEW_LIST:
        return this.#reviewList(actor);
      case COMMANDS.TASK_LIST:
        return this.taskBoard.listTasks({ teamId: actor.teamId });
      case COMMANDS.AGENT_STATUS:
        return this.#agentStatus(actor, args);
      case COMMANDS.APPROVAL_LIST:
        return this.#approvalList(actor);
      case COMMANDS.APPROVAL_RESPOND:
        return this.#approvalRespond(actor, command.idempotencyKey, args);
      case COMMANDS.TOOL_ACTIVITY:
        return this.#toolActivity(actor, args);
      case COMMANDS.HEALTH_STATUS:
        return this.#healthStatus(actor, args);
      case COMMANDS.RUNTIME_EVENTS:
        return this.#runtimeEvents(actor, args);
      case COMMANDS.CROSS_TEAM_MESSAGES:
        return this.#crossTeamMessages(actor, args);
      case COMMANDS.CROSS_TEAM_SEND:
        return this.#crossTeamSend(actor, command.idempotencyKey, args);
      case COMMANDS.AGENT_LAUNCH:
        return this.#agentLaunch(actor, args);
      case COMMANDS.AGENT_STOP:
        return this.#agentStop(actor, args);
      case COMMANDS.TEAM_CREATE:
        return this.#teamCreate(actor, args);
      case COMMANDS.TEAM_LIST:
        return this.#teamList(actor);
      case COMMANDS.TEAM_DELETE:
        return this.#teamDelete(actor, args);
      case COMMANDS.TEAM_LAUNCH:
        return this.#teamLaunch(actor, args);
      case COMMANDS.TEAM_STOP:
        return this.#teamStop(actor, args);
      case COMMANDS.RUNTIME_SEND_INPUT:
        return this.#runtimeSendInput(actor, args);
      case COMMANDS.VALIDATION_RUN:
        return this.#validationRun(actor, command.idempotencyKey, args);
      default:
        throw new Error(`unsupported command: ${commandName}`);
    }
  }

  #messageSend(actor, idempotencyKey, args) {
    return this.broker.appendMessage({
      teamId: actor.teamId,
      idempotencyKey,
      from: { kind: 'agent', id: actor.agentId },
      to: normalizeMessageRecipient(actor.teamId, args.to),
      kind: args.kind || MESSAGE_KINDS.REPLY,
      text: requireString(args.text, 'args.text'),
      taskRefs: Array.isArray(args.taskRefs) ? args.taskRefs : [],
      metadata: args.metadata || {},
      replyToMessageId: args.replyToMessageId || null,
      conversationId: args.conversationId,
    });
  }

  #taskCreate(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.CREATED,
      actorId: actor.agentId,
      payload: {
        subject: requireString(args.subject, 'args.subject'),
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
        ...(typeof args.ownerId === 'string' ? { ownerId: args.ownerId } : {}),
        status: args.status || TASK_STATUS.PENDING,
      },
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  #taskComment(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.COMMENT_ADDED,
      actorId: actor.agentId,
      payload: {
        text: requireString(args.text, 'args.text'),
        ...(typeof args.commentId === 'string' ? { commentId: args.commentId } : {}),
      },
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  #taskUpdate(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    if (typeof args.ownerId === 'string') {
      this.taskBoard.appendEvent({
        teamId: actor.teamId,
        taskId,
        idempotencyKey: `${idempotencyKey}:owner`,
        eventType: TASK_EVENT_TYPES.ASSIGNED,
        actorId: actor.agentId,
        payload: { ownerId: args.ownerId },
      });
    }
    if (typeof args.status === 'string') {
      const current = this.taskBoard.getTask({ teamId: actor.teamId, taskId });
      const fromStatus = current?.status ?? null;
      const validation = validateTaskStatusTransition({ from: fromStatus, to: args.status });
      if (!validation.ok) {
        throw new Error(`task_update: ${validation.reason}`);
      }
      // CI gate: testing → merge_ready requires a passing test verdict.
      // Implements the gate half of checklist §6 + §18 ("failed command blocks merge_ready").
      if (fromStatus === 'testing' && args.status === 'merge_ready') {
        const latestTest = current?.latestValidation?.test;
        if (!latestTest || latestTest.verdict !== 'passed') {
          const detail = latestTest ? `latest: ${latestTest.verdict}` : 'no test run';
          throw new Error(
            `task_update: testing → merge_ready requires a passing test verdict (${detail})`,
          );
        }
      }
      const payload = { status: args.status, from: fromStatus };
      if (typeof args.reason === 'string' && args.reason.length > 0) payload.reason = args.reason;
      this.taskBoard.appendEvent({
        teamId: actor.teamId,
        taskId,
        idempotencyKey: `${idempotencyKey}:status`,
        eventType: TASK_EVENT_TYPES.STATUS_CHANGED,
        actorId: actor.agentId,
        payload,
      });
    }
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  #reviewRequest(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    const payload = {};
    if (typeof args.reviewerId === 'string' && args.reviewerId.length > 0) payload.reviewerId = args.reviewerId;
    if (typeof args.summary === 'string' && args.summary.length > 0) payload.summary = args.summary;
    if (typeof args.diff === 'string' && args.diff.length > 0) payload.diff = args.diff;
    if (Array.isArray(args.files)) {
      const cleaned = args.files.filter((f) => typeof f === 'string' && f.length > 0);
      if (cleaned.length > 0) payload.files = cleaned;
    }
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.REVIEW_REQUESTED,
      actorId: actor.agentId,
      payload,
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  #reviewDecide(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    const decision = requireString(args.decision, 'args.decision');
    if (decision !== 'approved' && decision !== 'changes_requested') {
      throw new Error(`unsupported review decision: ${decision}`);
    }
    // Self-review prevention (checklist §17): the agent that requested
    // the review cannot also decide it. Applies regardless of role.
    const currentTask = this.taskBoard.getTask({ teamId: actor.teamId, taskId });
    if (currentTask?.review?.requestedBy && currentTask.review.requestedBy === actor.agentId) {
      throw new Error('review_decide: same agent cannot review own work');
    }
    const payload = { decision };
    if (typeof args.reason === 'string' && args.reason.length > 0) payload.reason = args.reason;
    if (Array.isArray(args.feedback)) {
      const cleaned = args.feedback
        .filter((f) => f && typeof f.file === 'string' && typeof f.comment === 'string')
        .map((f) => ({ file: f.file, comment: f.comment }));
      if (cleaned.length > 0) payload.feedback = cleaned;
    }
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.REVIEW_DECIDED,
      actorId: actor.agentId,
      payload,
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  #reviewList(actor) {
    const tasks = this.taskBoard.listTasks({ teamId: actor.teamId }) || [];
    return tasks.filter((t) => t && t.review && t.review.state === 'requested');
  }

  #agentStatus(actor, args) {
    if (!this.runtimeRegistry) return [];
    if (typeof args.runtimeId === 'string' && args.runtimeId.trim()) {
      const runtime = this.runtimeRegistry.getRuntime?.(args.runtimeId.trim()) || null;
      return runtime && runtime.teamId === actor.teamId ? runtime : null;
    }
    if (typeof this.runtimeRegistry.listRuntimes !== 'function') return [];
    return this.runtimeRegistry.listRuntimes({ teamId: actor.teamId });
  }

  #approvalRespond(actor, idempotencyKey, args) {
    if (!this.approvalBroker || typeof this.approvalBroker.respondApproval !== 'function') {
      throw new Error('approval broker is not configured');
    }
    const approvalId = requireString(args.approvalId, 'args.approvalId');
    const decision = requireString(args.decision, 'args.decision');
    const reason = typeof args.reason === 'string' ? args.reason : '';
    const previousApproval =
      typeof this.approvalBroker.getApproval === 'function'
        ? this.approvalBroker.getApproval(approvalId)
        : null;
    const approval = this.approvalBroker.respondApproval({
      approvalId,
      idempotencyKey,
      actor,
      decision,
      reason,
    });
    const isTeammate =
      approval?.metadata?.source === 'teammate' &&
      Array.isArray(approval?.metadata?.permissionSuggestions);

    // For teammate permissions, apply settings-file changes instead of (or in addition to)
    // sending control_response. The settings change is the primary mechanism; the
    // control_response is belt-and-suspenders that may unblock the current waiting prompt.
    let settingsResult = null;
    if (isTeammate && decision === 'approved') {
      settingsResult = this.#applyTeammatePermissionSuggestions(approval);
    }

    // If the approval has already been delivered to the adapter, do not send it again.
    // This provides durable exactly-once delivery semantics across process restarts.
    const runtimeResponse = this.#sendApprovalResponseToRuntime({
      approval,
      decision,
      reason,
      shouldSend: !approval.delivery,
    });

    const result = { ...approval };
    if (runtimeResponse) result.runtimeResponse = runtimeResponse;
    if (settingsResult) result.settingsResult = settingsResult;
    return result;
  }

  #approvalList(actor) {
    if (!this.readModel || typeof this.readModel.listApprovals !== 'function') return [];
    return this.readModel.listApprovals({ teamId: actor.teamId });
  }

  #sendApprovalResponseToRuntime({ approval, decision, reason, shouldSend }) {
    if (!shouldSend) return null;
    const runtimeId =
      approval && typeof approval.runtimeId === 'string' && approval.runtimeId.trim()
        ? approval.runtimeId.trim()
        : null;
    if (!runtimeId) return null;
    const adapter = this.adapters?.get?.(runtimeId);
    if (!adapter || typeof adapter.approve !== 'function') return null;
    
    const response = adapter.approve({
      approvalId: requireString(approval.approvalId, 'approval.approvalId'),
      decision,
      reason,
    });
    
    // Mark as durably delivered so we don't send it again on idempotency retry
    if (this.approvalBroker && typeof this.approvalBroker.markApprovalDelivered === 'function') {
      this.approvalBroker.markApprovalDelivered({
        approvalId: approval.approvalId,
        runtimeId,
      });
    }
    
    return response;
  }

  #applyTeammatePermissionSuggestions(approval) {
    const suggestions = approval?.metadata?.permissionSuggestions;
    if (!Array.isArray(suggestions) || suggestions.length === 0) return null;
    if (!this.projectCwd) return null;
    // Fire-and-forget async write — we return a promise the caller can await if needed
    return applyPermissionSuggestions({
      projectCwd: this.projectCwd,
      suggestions,
    });
  }

  #toolActivity(actor, args) {
    if (!this.readModel || typeof this.readModel.listToolCalls !== 'function') return [];
    return this.readModel.listToolCalls({
      teamId: actor.teamId,
      runtimeId: typeof args.runtimeId === 'string' ? args.runtimeId : undefined,
    });
  }

  #healthStatus(actor, args) {
    if (!this.readModel || typeof this.readModel.listApiRetries !== 'function') {
      return { retries: [], summary: { total: 0, rateLimited: 0, serverErrors: 0 } };
    }
    const retries = this.readModel.listApiRetries({
      teamId: actor.teamId,
      runtimeId: typeof args.runtimeId === 'string' ? args.runtimeId : undefined,
    });
    const rateLimited = retries.filter((r) => r.error === 'rate_limit').length;
    const serverErrors = retries.filter((r) => r.errorStatus >= 500).length;
    return {
      retries,
      summary: { total: retries.length, rateLimited, serverErrors },
    };
  }

  #runtimeEvents(actor, args) {
    if (!this.readModel || typeof this.readModel.listRuntimeAudit !== 'function') return [];
    return this.readModel.listRuntimeAudit({
      teamId: actor.teamId,
      runtimeId: typeof args.runtimeId === 'string' ? args.runtimeId : undefined,
    });
  }

  #crossTeamMessages(actor, args) {
    if (!this.readModel || typeof this.readModel.listCrossTeamMessages !== 'function') return [];
    return this.readModel.listCrossTeamMessages({
      teamId: actor.teamId,
      limit: Number.isInteger(args.limit) ? args.limit : null,
    });
  }

  #crossTeamSend(actor, idempotencyKey, args) {
    const targetTeamId = requireString(args.targetTeamId, 'args.targetTeamId');
    const text = requireString(args.text, 'args.text');
    const targetAgentId = typeof args.targetAgentId === 'string' ? args.targetAgentId.trim() || 'lead' : 'lead';
    const chainDepth = typeof args.chainDepth === 'number' ? args.chainDepth : 0;
    const conversationId = typeof args.conversationId === 'string' ? args.conversationId : undefined;
    const replyToConversationId = typeof args.replyToConversationId === 'string' ? args.replyToConversationId : undefined;

    const from = `${actor.teamId}.${actor.agentId}`;
    const formattedText = formatCrossTeamText(from, chainDepth, text, {
      conversationId,
      replyToConversationId,
    });

    // Write incoming message to target team's inbox
    const incoming = this.broker.appendMessage({
      teamId: targetTeamId,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:incoming` : undefined,
      from: { kind: 'agent', id: actor.agentId, teamId: actor.teamId },
      to: { kind: 'agent', teamId: targetTeamId, agentId: targetAgentId },
      text: formattedText,
      kind: 'instruction',
      metadata: { source: CROSS_TEAM_SOURCE, chainDepth, conversationId, replyToConversationId },
    });

    // Write sent-copy to sender team's inbox
    this.broker.appendMessage({
      teamId: actor.teamId,
      idempotencyKey: idempotencyKey ? `${idempotencyKey}:sent` : undefined,
      from: { kind: 'agent', id: actor.agentId, teamId: actor.teamId },
      to: { kind: 'agent', teamId: targetTeamId, agentId: targetAgentId },
      text: formattedText,
      kind: 'instruction',
      metadata: { source: CROSS_TEAM_SENT_SOURCE, chainDepth, conversationId, replyToConversationId },
    });

    return { ok: true, messageId: incoming.messageId, targetTeamId, targetAgentId };
  }

  async #agentLaunch(actor, args) {
    if (!this.launchAgent) {
      throw new Error('agent_launch is not configured on this facade');
    }
    const teamId = requireString(args.teamId, 'args.teamId');
    const agentId = requireString(args.agentId, 'args.agentId');
    const runtimeId = requireString(args.runtimeId, 'args.runtimeId');
    const command = requireString(args.command, 'args.command');
    const input = {
      teamId,
      agentId,
      runtimeId,
      command,
    };
    if (Array.isArray(args.args)) input.args = args.args.map(String);
    if (typeof args.cwd === 'string' && args.cwd.length > 0) input.cwd = args.cwd;
    if (args.env && typeof args.env === 'object' && !Array.isArray(args.env)) input.env = args.env;
    if (typeof args.providerId === 'string' && args.providerId.length > 0) input.providerId = args.providerId;
    return this.launchAgent(input);
  }

  async #agentStop(actor, args) {
    if (!this.stopAgent) {
      throw new Error('agent_stop is not configured on this facade');
    }
    const runtimeId = requireString(args.runtimeId, 'args.runtimeId');
    const input = { runtimeId };
    if (typeof args.signal === 'string' && args.signal.length > 0) input.signal = args.signal;
    return this.stopAgent(input);
  }

  #teamCreate(actor, args) {
    if (!this.teamConfigRegistry) {
      throw new Error('teamConfigRegistry is not configured on this facade');
    }
    const config = new TeamConfig({
      teamId: requireString(args.teamId, 'args.teamId'),
      lead: args.lead || {},
      teammates: Array.isArray(args.teammates) ? args.teammates : [],
      validation: args.validation || null,
    });
    this.teamConfigRegistry.registerTeam(config);
    return config.toJSON ? config.toJSON() : { teamId: config.teamId, lead: config.lead, teammates: config.teammates };
  }

  #teamList(actor) {
    if (!this.teamConfigRegistry) {
      throw new Error('teamConfigRegistry is not configured on this facade');
    }
    return this.teamConfigRegistry.listTeams().map((c) =>
      c.toJSON ? c.toJSON() : { teamId: c.teamId, lead: c.lead, teammates: c.teammates },
    );
  }

  #teamDelete(actor, args) {
    if (!this.teamConfigRegistry) {
      throw new Error('teamConfigRegistry is not configured on this facade');
    }
    const teamId = requireString(args.teamId, 'args.teamId');
    const deleted = this.teamConfigRegistry.deleteTeam(teamId);
    return { teamId, deleted };
  }

  async #teamLaunch(actor, args) {
    if (!this.teamConfigRegistry) {
      throw new Error('teamConfigRegistry is not configured on this facade');
    }
    if (!this.launchAgent) {
      throw new Error('launchAgent is not configured on this facade');
    }
    const teamId = requireString(args.teamId, 'args.teamId');
    const config = this.teamConfigRegistry.getTeam(teamId);
    if (!config) {
      throw new Error(`team_launch: no config for teamId ${teamId}`);
    }
    const members = [config.lead, ...config.teammates];
    const results = [];
    for (const member of members) {
      const runtimeId = `runtime-${teamId}-${member.agentId}`;
      const existing = this.runtimeRegistry?.getRuntime?.(runtimeId);
      if (existing && existing.status === 'running') {
        results.push({ runtimeId, agentId: member.agentId, status: 'already_running' });
        continue;
      }
      try {
        const launchInput = {
          teamId,
          agentId: member.agentId,
          runtimeId,
          command: member.command,
        };
        if (Array.isArray(member.args) && member.args.length > 0) launchInput.args = member.args;
        if (typeof member.cwd === 'string' && member.cwd.length > 0) launchInput.cwd = member.cwd;
        if (member.env && typeof member.env === 'object' && Object.keys(member.env).length > 0) launchInput.env = member.env;
        if (typeof member.providerId === 'string' && member.providerId.length > 0) launchInput.providerId = member.providerId;
        const runtime = await this.launchAgent(launchInput);
        results.push({ runtimeId, agentId: member.agentId, status: runtime?.status || 'starting' });
      } catch (err) {
        results.push({
          runtimeId,
          agentId: member.agentId,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { teamId, members: results };
  }

  async #validationRun(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    const kind = requireString(args.kind, 'args.kind');
    const validKinds = ['install', 'lint', 'typecheck', 'test', 'build', 'security'];
    if (!validKinds.includes(kind)) {
      throw new Error(`validation_run: unknown kind "${kind}"`);
    }
    // Resolve the command: explicit override → team config → null
    let command = typeof args.command === 'string' && args.command.length > 0 ? args.command : null;
    if (!command && this.teamConfigRegistry) {
      const team = this.teamConfigRegistry.getTeam?.(actor.teamId);
      const key = `${kind}Command`;
      const fromConfig = team?.validation?.[key];
      if (typeof fromConfig === 'string' && fromConfig.length > 0) command = fromConfig;
    }
    let payload;
    if (!command) {
      // Not configured and no override — explicit "not_run" record per checklist §18
      payload = {
        kind,
        command: null,
        exitCode: null,
        durationMs: 0,
        verdict: 'not_run',
        stdout: '',
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    } else {
      const cwd = typeof args.cwd === 'string' && args.cwd.length > 0
        ? args.cwd
        : (this.projectCwd || process.cwd());
      const result = await this.spawnValidation(command, { cwd });
      const stdoutText = typeof result.stdout === 'string' ? result.stdout : '';
      const stderrText = typeof result.stderr === 'string' ? result.stderr : '';
      payload = {
        kind,
        command,
        exitCode: Number.isFinite(result.exitCode) ? result.exitCode : null,
        durationMs: Number.isFinite(result.durationMs) ? result.durationMs : 0,
        verdict: result.exitCode === 0 ? 'passed' : 'failed',
        stdout: truncate(stdoutText, 4096),
        stderr: truncate(stderrText, 4096),
        stdoutTruncated: stdoutText.length > 4096,
        stderrTruncated: stderrText.length > 4096,
      };
    }
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.VALIDATION_RUN,
      actorId: actor.agentId,
      payload,
    });
    return payload;
  }

  async #runtimeSendInput(actor, args) {
    const runtimeId = requireString(args.runtimeId, 'args.runtimeId');
    const text = requireString(args.text, 'args.text');
    const adapter = this.adapters?.get?.(runtimeId);
    if (!adapter || typeof adapter.sendTurn !== 'function') {
      throw new Error(`runtime_send_input: no adapter for runtime ${runtimeId}`);
    }
    return adapter.sendTurn({ message: { text } });
  }

  async #teamStop(actor, args) {
    if (!this.runtimeRegistry || typeof this.runtimeRegistry.listRuntimes !== 'function') {
      throw new Error('runtimeRegistry is not configured on this facade');
    }
    if (!this.stopAgent) {
      throw new Error('stopAgent is not configured on this facade');
    }
    const teamId = requireString(args.teamId, 'args.teamId');
    const signal = typeof args.signal === 'string' && args.signal.length > 0 ? args.signal : null;
    const runtimes = this.runtimeRegistry.listRuntimes({ teamId })
      .filter((r) => r && r.status === 'running');
    const results = [];
    for (const r of runtimes) {
      try {
        const stopInput = { runtimeId: r.runtimeId };
        if (signal) stopInput.signal = signal;
        const stopped = await this.stopAgent(stopInput);
        results.push({ runtimeId: r.runtimeId, agentId: r.agentId, status: stopped?.status || 'stopped' });
      } catch (err) {
        results.push({
          runtimeId: r.runtimeId,
          agentId: r.agentId,
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { teamId, members: results };
  }
}

function truncate(value, max) {
  if (typeof value !== 'string') return '';
  return value.length <= max ? value : value.slice(0, max);
}

function defaultSpawnValidation(command, { cwd } = {}) {
  // Returns { exitCode, stdout, stderr, durationMs }. Sync via spawnSync because
  // validation runs are blocking by intent — the caller awaits the result. Tests
  // pass their own spawn fn through the LocalToolFacade `spawnValidation` option.
  const start = Date.now();
  const result = spawnSync(command, {
    cwd: cwd || process.cwd(),
    shell: true,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  return {
    exitCode: typeof result.status === 'number' ? result.status : -1,
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    stderr: typeof result.stderr === 'string' ? result.stderr : '',
    durationMs: Date.now() - start,
  };
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') {
    throw new TypeError('actor is required');
  }
  const normalized = {
    teamId: requireString(actor.teamId, 'actor.teamId'),
    agentId: requireString(actor.agentId, 'actor.agentId'),
  };
  if (typeof actor.role === 'string' && actor.role.length > 0) {
    normalized.role = actor.role;
  }
  return normalized;
}

function normalizeMessageRecipient(teamId, recipient) {
  if (!recipient || typeof recipient !== 'object') {
    throw new TypeError('args.to is required');
  }
  const kind = requireString(recipient.kind, 'args.to.kind');
  if (kind === 'user' || kind === 'system') return { kind };
  if (kind === 'team') return { kind, teamId: recipient.teamId || teamId };
  if (kind === 'agent') {
    return {
      kind,
      teamId: recipient.teamId || teamId,
      agentId: requireString(recipient.agentId, 'args.to.agentId'),
    };
  }
  throw new Error(`unsupported recipient kind: ${kind}`);
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
