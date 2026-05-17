import {
  CROSS_TEAM_SENT_SOURCE,
  CROSS_TEAM_SOURCE,
  parseCrossTeamPrefix,
  stripCrossTeamPrefix,
} from '../protocol/crossTeam.js';
import { detectSpans, DEFAULT_SPAN_CONFIG } from '../runtime/spanDetection/index.js';

export class LocalReadModel {
  constructor({
    broker,
    taskBoard = null,
    runtimeRegistry = null,
    eventLog = null,
    approvalBroker = null,
    narrationStore = null,
  }) {
    if (!broker || typeof broker.listMessages !== 'function') {
      throw new TypeError('broker with listMessages() is required');
    }
    this.broker = broker;
    this.taskBoard = taskBoard;
    this.runtimeRegistry = runtimeRegistry;
    this.eventLog = eventLog;
    this.approvalBroker = approvalBroker;
    this.narrationStore = narrationStore;
  }

  listTeamChat({ teamId, limit = null }) {
    const messages = this.broker.listMessages({ teamId: requireString(teamId, 'teamId'), limit });
    return messages.map((message) => ({
      type: 'message',
      id: message.messageId,
      teamId: message.teamId,
      conversationId: message.conversationId,
      messageKind: message.kind,
      direction: message.to.kind === 'user' ? 'outbound' : 'inbound',
      from: message.from,
      to: message.to,
      text: message.text,
      createdAt: message.createdAt,
      metadata: message.metadata,
    }));
  }

  listCrossTeamMessages({ teamId, limit = null }) {
    return this.listTeamChat({ teamId: requireString(teamId, 'teamId'), limit })
      .filter((message) =>
        message.metadata?.source === CROSS_TEAM_SOURCE ||
        message.metadata?.source === CROSS_TEAM_SENT_SOURCE
      )
      .map((message) => {
        const parsed = parseCrossTeamPrefix(message.text) || {};
        const direction = message.metadata.source === CROSS_TEAM_SENT_SOURCE ? 'outbound' : 'inbound';
        const sourceTeamId = direction === 'outbound'
          ? message.teamId
          : parseTeamId(parsed.from) || message.from?.teamId || null;
        const targetTeamId = direction === 'outbound'
          ? message.to?.teamId || null
          : message.teamId;
        return {
          type: 'cross_team_message',
          id: message.id,
          teamId: message.teamId,
          direction,
          sourceTeamId,
          sourceAgentId: direction === 'outbound' ? message.from?.id || null : parseAgentId(parsed.from) || message.from?.id || null,
          targetTeamId,
          targetAgentId: message.to?.agentId || null,
          conversationId:
            message.metadata?.conversationId ||
            parsed.conversationId ||
            message.conversationId,
          replyToConversationId:
            message.metadata?.replyToConversationId ||
            parsed.replyToConversationId ||
            null,
          chainDepth:
            typeof message.metadata?.chainDepth === 'number'
              ? message.metadata.chainDepth
              : parsed.chainDepth ?? 0,
          text: stripCrossTeamPrefix(message.text),
          createdAt: message.createdAt,
          metadata: message.metadata,
        };
      });
  }

  listTaskBoard({ teamId }) {
    if (!this.taskBoard || typeof this.taskBoard.listTasks !== 'function') return [];
    return this.taskBoard.listTasks({ teamId: requireString(teamId, 'teamId') });
  }

  listRuntimeProcesses({ teamId }) {
    if (!this.runtimeRegistry || typeof this.runtimeRegistry.listRuntimes !== 'function') return [];
    return this.runtimeRegistry.listRuntimes({ teamId: requireString(teamId, 'teamId') });
  }

  listRuntimeAudit({ teamId, runtimeId = null }) {
    if (!this.eventLog || typeof this.eventLog.listEvents !== 'function') return [];
    return this.eventLog.listEvents({ teamId: requireString(teamId, 'teamId'), runtimeId });
  }

  listNarratedTimeline({ teamId, runtimeId = null }) {
    if (!this.narrationStore || typeof this.narrationStore.listNarration !== 'function') return [];
    return this.narrationStore.listNarration({ teamId: requireString(teamId, 'teamId'), runtimeId });
  }

  listSpans({ teamId, runtimeId = null }) {
    return detectSpans(
      this.listNarratedTimeline({ teamId, runtimeId }),
      DEFAULT_SPAN_CONFIG,
    );
  }

  listApprovals({ teamId }) {
    if (!this.approvalBroker || typeof this.approvalBroker.listApprovals !== 'function') return [];
    return this.approvalBroker.listApprovals({ teamId: requireString(teamId, 'teamId') });
  }

  listToolCalls({ teamId, runtimeId = null }) {
    if (!this.eventLog || typeof this.eventLog.listEvents !== 'function') return [];
    const events = this.eventLog.listEvents({ teamId: requireString(teamId, 'teamId'), runtimeId });
    return events
      .filter((event) => event.eventType === 'tool_use')
      .map((event) => {
        const payload = event.payload || {};
        return {
          type: 'tool_call',
          id: event.eventId,
          teamId: event.teamId,
          agentId: event.agentId,
          runtimeId: event.runtimeId,
          toolName: typeof payload.toolName === 'string' ? payload.toolName : 'unknown',
          toolUseId: typeof payload.toolUseId === 'string' ? payload.toolUseId : null,
          input: payload.input && typeof payload.input === 'object' ? payload.input : {},
          createdAt: event.createdAt,
        };
      });
  }

  listApiRetries({ teamId, runtimeId = null }) {
    if (!this.eventLog || typeof this.eventLog.listEvents !== 'function') return [];
    const events = this.eventLog.listEvents({ teamId: requireString(teamId, 'teamId'), runtimeId });
    return events
      .filter((event) => event.eventType === 'api_retry')
      .map((event) => {
        const payload = event.payload || {};
        return {
          type: 'api_retry',
          id: event.eventId,
          teamId: event.teamId,
          agentId: event.agentId,
          runtimeId: event.runtimeId,
          attempt: typeof payload.attempt === 'number' ? payload.attempt : null,
          maxRetries: typeof payload.maxRetries === 'number' ? payload.maxRetries : null,
          errorStatus: typeof payload.errorStatus === 'number' ? payload.errorStatus : null,
          error: typeof payload.error === 'string' ? payload.error : null,
          errorMessage: typeof payload.errorMessage === 'string' ? payload.errorMessage : null,
          retryDelayMs: typeof payload.retryDelayMs === 'number' ? payload.retryDelayMs : null,
          createdAt: event.createdAt,
        };
      });
  }

  getTeamOverview({ teamId }) {
    const id = requireString(teamId, 'teamId');
    const recentMessages = this.listTeamChat({ teamId: id });
    const tasks = this.listTaskBoard({ teamId: id });
    const runtimes = this.listRuntimeProcesses({ teamId: id });
    const runtimeEvents = this.listRuntimeAudit({ teamId: id });
    const approvals = this.listApprovals({ teamId: id });
    const pendingApprovals = approvals.filter((approval) => approval.status === 'pending');
    const toolCalls = this.listToolCalls({ teamId: id });
    const apiRetries = this.listApiRetries({ teamId: id });
    return {
      teamId: id,
      counts: {
        messages: recentMessages.length,
        tasks: tasks.length,
        runtimes: runtimes.length,
        runtimeEvents: runtimeEvents.length,
        approvals: approvals.length,
        pendingApprovals: pendingApprovals.length,
        toolCalls: toolCalls.length,
        apiRetries: apiRetries.length,
      },
      recentMessages,
      tasks,
      activeRuntimes: runtimes.filter((runtime) => runtime.status === 'running'),
      recentRuntimeEvents: runtimeEvents,
      approvals,
      pendingApprovals,
    };
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseTeamId(value) {
  if (typeof value !== 'string') return null;
  const [teamId] = value.split('.');
  return teamId || null;
}

function parseAgentId(value) {
  if (typeof value !== 'string') return null;
  const [, agentId] = value.split('.');
  return agentId || null;
}
