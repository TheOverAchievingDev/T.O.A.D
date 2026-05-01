import { COMMANDS, commandRequiresIdempotency } from '../commands/command-contract.js';
import { MESSAGE_KINDS } from '../protocol/envelopes.js';
import {
  TASK_EVENT_TYPES,
  TASK_STATUS,
} from '../task/inMemoryTaskBoard.js';
import { applyPermissionSuggestions } from '../runtime/claudeSettingsWriter.js';
import { formatCrossTeamText, CROSS_TEAM_SOURCE, CROSS_TEAM_SENT_SOURCE } from '../protocol/crossTeam.js';

export class LocalToolFacade {
  constructor({ broker, taskBoard, runtimeRegistry = null, approvalBroker = null, adapters = null, projectCwd = null, readModel = null, launchAgent = null, stopAgent = null }) {
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
  }

  execute(command) {
    const commandName = requireString(command.commandName, 'commandName');
    if (commandRequiresIdempotency(commandName)) {
      requireString(command.idempotencyKey, 'idempotencyKey');
    }
    const actor = normalizeActor(command.actor);
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
      this.taskBoard.appendEvent({
        teamId: actor.teamId,
        taskId,
        idempotencyKey: `${idempotencyKey}:status`,
        eventType: TASK_EVENT_TYPES.STATUS_CHANGED,
        actorId: actor.agentId,
        payload: { status: args.status },
      });
    }
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  #reviewRequest(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.REVIEW_REQUESTED,
      actorId: actor.agentId,
      payload: {
        ...(typeof args.reviewerId === 'string' ? { reviewerId: args.reviewerId } : {}),
      },
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
  }

  #reviewDecide(actor, idempotencyKey, args) {
    const taskId = requireString(args.taskId, 'args.taskId');
    const decision = requireString(args.decision, 'args.decision');
    if (decision !== 'approved' && decision !== 'changes_requested') {
      throw new Error(`unsupported review decision: ${decision}`);
    }
    this.taskBoard.appendEvent({
      teamId: actor.teamId,
      taskId,
      idempotencyKey,
      eventType: TASK_EVENT_TYPES.REVIEW_DECIDED,
      actorId: actor.agentId,
      payload: {
        decision,
        ...(typeof args.reason === 'string' ? { reason: args.reason } : {}),
      },
    });
    return this.taskBoard.getTask({ teamId: actor.teamId, taskId });
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
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') {
    throw new TypeError('actor is required');
  }
  return {
    teamId: requireString(actor.teamId, 'actor.teamId'),
    agentId: requireString(actor.agentId, 'actor.agentId'),
  };
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
