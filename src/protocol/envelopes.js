import { randomUUID } from 'node:crypto';

export const RECIPIENT_KINDS = Object.freeze({
  USER: 'user',
  AGENT: 'agent',
  TEAM: 'team',
  SYSTEM: 'system',
});

export const MESSAGE_KINDS = Object.freeze({
  USER_GOAL: 'user_goal',
  INSTRUCTION: 'instruction',
  REPLY: 'reply',
  TASK_NOTIFICATION: 'task_notification',
  REVIEW_NOTIFICATION: 'review_notification',
  SYSTEM: 'system',
});

export function nowIso() {
  return new Date().toISOString();
}

export function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeRecipient(value) {
  if (!value || typeof value !== 'object') {
    throw new TypeError('recipient must be an object');
  }

  const kind = assertNonEmptyString(value.kind, 'recipient.kind');
  if (!Object.values(RECIPIENT_KINDS).includes(kind)) {
    throw new TypeError(`unsupported recipient kind: ${kind}`);
  }

  if (kind === RECIPIENT_KINDS.USER || kind === RECIPIENT_KINDS.SYSTEM) {
    return { kind };
  }

  if (kind === RECIPIENT_KINDS.AGENT) {
    return {
      kind,
      teamId: assertNonEmptyString(value.teamId, 'recipient.teamId'),
      agentId: assertNonEmptyString(value.agentId, 'recipient.agentId'),
    };
  }

  return {
    kind,
    teamId: assertNonEmptyString(value.teamId, 'recipient.teamId'),
  };
}

export function createMessageEnvelope(input) {
  const teamId = assertNonEmptyString(input.teamId, 'teamId');
  const from = {
    kind: assertNonEmptyString(input.from?.kind, 'from.kind'),
    id: assertNonEmptyString(input.from?.id, 'from.id'),
    teamId,
  };
  const kind = input.kind || MESSAGE_KINDS.INSTRUCTION;
  if (!Object.values(MESSAGE_KINDS).includes(kind)) {
    throw new TypeError(`unsupported message kind: ${kind}`);
  }

  return Object.freeze({
    messageId: input.messageId || randomUUID(),
    conversationId: input.conversationId || randomUUID(),
    idempotencyKey: input.idempotencyKey || null,
    teamId,
    from,
    to: normalizeRecipient(input.to),
    kind,
    text: assertNonEmptyString(input.text, 'text'),
    createdAt: input.createdAt || nowIso(),
    replyToMessageId: input.replyToMessageId || null,
    taskRefs: Array.isArray(input.taskRefs) ? [...input.taskRefs] : [],
    metadata: input.metadata && typeof input.metadata === 'object' ? { ...input.metadata } : {},
  });
}

