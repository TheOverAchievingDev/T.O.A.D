import { createHash } from 'node:crypto';
import { MESSAGE_KINDS } from '../protocol/envelopes.js';
import { RuntimeIdentityValidator } from './RuntimeIdentityValidator.js';

const DEFAULT_ALLOWED_TOOL_NAMES = Object.freeze([
  'message_send',
  'task_create',
  'task_update',
  'task_comment',
]);

export class RuntimeEventIngestor {
  constructor({
    broker,
    eventLog = null,
    toolFacade = null,
    approvalBroker = null,
    allowedToolNames = DEFAULT_ALLOWED_TOOL_NAMES,
    adapters = new Map(),
    runtimeRegistry = null,
    identityValidator = null,
    compactionHandler = null,
    eventBus = null,
    sideEffectLog = null,
  }) {
    if (!broker || typeof broker.appendMessage !== 'function') {
      throw new TypeError('broker with appendMessage() is required');
    }
    this.broker = broker;
    this.eventLog = eventLog;
    this.toolFacade = toolFacade;
    this.approvalBroker = approvalBroker;
    this.allowedToolNames = new Set(allowedToolNames);
    this.adapters = adapters;
    this.compactionHandler = compactionHandler;
    this.eventBus = eventBus;
    this.sideEffectLog = sideEffectLog;
    this.identityValidator =
      identityValidator || new RuntimeIdentityValidator({ runtimeRegistry });
  }

  async ingest(event) {
    const normalized = normalizeRuntimeEvent(event);
    const eventHash = hashStableJson(normalized);
    const eventResult = this.eventLog
      ? this.eventLog.appendEvent({
          idempotencyKey: `runtime-event:${eventHash}`,
          runtimeId: normalized.runtimeId,
          teamId: normalized.teamId,
          agentId: normalized.agentId,
          eventType: normalized.type,
          sessionId: normalized.sessionId,
          payload: normalized,
          createdAt: normalized.createdAt,
        })
      : null;

    // Publish to event bus for live streaming
    this.#publishEvent(normalized);

    if (normalized.type === 'tool_use') {
      this.identityValidator.assertCanWrite(normalized);
      const tool = await this.#dispatchToolUse(normalized, eventHash);
      return { event: eventResult, message: null, ...tool };
    }

    if (normalized.type === 'approval_request') {
      this.identityValidator.assertCanWrite(normalized);
      const approval = this.#requestApproval(normalized, eventHash);
      return { event: eventResult, message: null, tool: null, approval };
    }

    if (normalized.type !== 'assistant_text') {
      // Dispatch compaction lifecycle events
      this.#dispatchCompactionLifecycle(normalized);
      return { event: eventResult, message: null, tool: null };
    }

    this.identityValidator.assertCanWrite(normalized);

    const message = this.broker.appendMessage({
      teamId: normalized.teamId,
      idempotencyKey: `runtime-message:${eventHash}`,
      from: { kind: 'agent', id: normalized.agentId },
      to: { kind: 'user' },
      kind: MESSAGE_KINDS.REPLY,
      text: requireString(normalized.text, 'event.text'),
      metadata: {
        runtimeId: normalized.runtimeId,
        sessionId: normalized.sessionId,
        runtimeEventType: normalized.type,
      },
    });

    return { event: eventResult, message, tool: null };
  }

  async ingestFrom(asyncIterable) {
    if (!asyncIterable || typeof asyncIterable[Symbol.asyncIterator] !== 'function') {
      throw new TypeError('async iterable runtime events are required');
    }
    const summary = { events: 0, messages: 0 };
    for await (const event of asyncIterable) {
      const result = await this.ingest(event);
      summary.events += 1;
      if (result.message) summary.messages += 1;
    }
    return summary;
  }

  async #dispatchToolUse(event, eventHash) {
    const toolName = requireString(event.toolName, 'event.toolName');
    if (!this.toolFacade || typeof this.toolFacade.execute !== 'function') {
      return { tool: null, toolResult: null };
    }
    if (!this.allowedToolNames.has(toolName)) {
      return { tool: null, toolResult: null };
    }

    try {
      const tool = this.toolFacade.execute({
        commandName: toolName,
        idempotencyKey: `runtime-tool:${eventHash}`,
        actor: {
          teamId: event.teamId,
          agentId: event.agentId,
        },
        args: event.input && typeof event.input === 'object' ? event.input : {},
      });
      const toolResult = await this.#sendToolResult(event, eventHash, { result: tool, error: null });
      return { tool, toolResult };
    } catch (error) {
      const toolError = error instanceof Error ? error.message : String(error);
      const toolResult = await this.#sendToolResult(event, eventHash, { result: null, error: toolError });
      return { tool: null, toolError, toolResult };
    }
  }

  #requestApproval(event, eventHash) {
    if (!this.approvalBroker || typeof this.approvalBroker.requestApproval !== 'function') {
      return null;
    }
    const toolName = typeof event.toolName === 'string' && event.toolName.trim()
      ? event.toolName.trim()
      : 'Unknown';
    return this.approvalBroker.requestApproval({
      approvalId:
        typeof event.approvalId === 'string' && event.approvalId.trim()
          ? event.approvalId.trim()
          : `runtime-approval:${eventHash}`,
      teamId: event.teamId,
      agentId: event.agentId,
      runtimeId: event.runtimeId,
      prompt:
        typeof event.prompt === 'string' && event.prompt.trim()
          ? event.prompt.trim()
          : `Approve ${toolName}`,
      requestedAt: event.createdAt,
      metadata: {
        sessionId: event.sessionId,
        runtimeEventType: event.type,
        toolName,
        input: event.input && typeof event.input === 'object' ? { ...event.input } : {},
      },
    });
  }

  async #sendToolResult(event, eventHash, { result, error }) {
    const adapter = this.adapters?.get?.(event.runtimeId);
    if (!adapter || typeof adapter.sendToolResult !== 'function') return null;

    const idempotencyKey = `tool-result:${eventHash}`;

    // Idempotency guard: skip if already delivered
    if (this.sideEffectLog) {
      const existing = this.sideEffectLog.get(idempotencyKey);
      if (existing?.status === 'delivered') return null;
      this.sideEffectLog.markPending({
        deliveryId: `${idempotencyKey}-${event.runtimeId}`,
        idempotencyKey,
        kind: 'tool_result',
        runtimeId: event.runtimeId,
      });
    }

    try {
      const receipt = await adapter.sendToolResult({
        toolUseId: requireString(event.toolUseId, 'event.toolUseId'),
        result,
        error,
      });
      if (this.sideEffectLog) this.sideEffectLog.markDelivered(idempotencyKey);
      return receipt;
    } catch (err) {
      if (this.sideEffectLog) this.sideEffectLog.markFailed(idempotencyKey);
      throw err;
    }
  }

  #dispatchCompactionLifecycle(event) {
    if (!this.compactionHandler) return;
    if (event.type === 'compact_boundary') {
      this.compactionHandler.onCompactBoundary(event);
    } else if (event.type === 'turn_completed') {
      // Fire-and-forget — the handler manages its own error policy
      void this.compactionHandler.onTurnCompleted(event);
    } else if (event.type === 'turn_failed') {
      this.compactionHandler.onTurnFailed(event);
    }
  }

  #publishEvent(normalized) {
    if (!this.eventBus || typeof this.eventBus.emit !== 'function') return;
    this.eventBus.emit('runtime_event', normalized);
    if (normalized.type) {
      this.eventBus.emit(normalized.type, normalized);
    }
  }
}

function normalizeRuntimeEvent(event) {
  if (!event || typeof event !== 'object') {
    throw new TypeError('event must be an object');
  }
  return {
    ...event,
    type: requireString(event.type, 'event.type'),
    runtimeId: requireString(event.runtimeId, 'event.runtimeId'),
    teamId: requireString(event.teamId, 'event.teamId'),
    agentId: requireString(event.agentId, 'event.agentId'),
    sessionId:
      typeof event.sessionId === 'string' && event.sessionId.trim() ? event.sessionId.trim() : null,
    createdAt: event.createdAt || new Date().toISOString(),
  };
}

function hashStableJson(value) {
  return `sha256:${createHash('sha256').update(stableJsonStringify(value)).digest('hex')}`;
}

function stableJsonStringify(value) {
  return JSON.stringify(normalizeStableJson(value));
}

function normalizeStableJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeStableJson);

  const output = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] !== undefined) {
      output[key] = normalizeStableJson(value[key]);
    }
  }
  return output;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}
