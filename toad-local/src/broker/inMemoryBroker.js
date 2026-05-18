import { randomUUID } from 'node:crypto';
import { createMessageEnvelope } from '../protocol/envelopes.js';

export class InMemoryBroker {
  #messages = new Map();
  #idempotency = new Map();
  #readReceipts = new Map();
  #deliveryAttempts = new Map();
  #subscribers = new Set();

  /**
   * Register a subscriber that fires AFTER each successfully-inserted
   * message. Mirrors SqliteTaskBoard.subscribe's contract verbatim:
   * does NOT fire on idempotent dedup hits; subscriber exceptions are
   * caught + logged so they cannot break the broker write path.
   *
   * Durability contract: fires synchronously after the message is
   * recorded; the message is queryable via this broker on the same
   * connection from within the handler. No stronger cross-process
   * disk-durability guarantee is made.
   */
  subscribe(fn) {
    if (typeof fn !== 'function') {
      throw new TypeError('InMemoryBroker.subscribe: fn must be a function');
    }
    this.#subscribers.add(fn);
    return () => { this.#subscribers.delete(fn); };
  }

  appendMessage(input) {
    const envelope = createMessageEnvelope(input);
    if (envelope.idempotencyKey) {
      const existingId = this.#idempotency.get(envelope.idempotencyKey);
      if (existingId) {
        return {
          inserted: false,
          message: this.#messages.get(existingId),
        };
      }
      this.#idempotency.set(envelope.idempotencyKey, envelope.messageId);
    }
    this.#messages.set(envelope.messageId, envelope);
    this.#fireSubscribers(envelope);
    return { inserted: true, message: envelope };
  }

  #fireSubscribers(message) {
    for (const fn of this.#subscribers) {
      try {
        fn(message);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('[broker] subscriber threw:', err && err.message ? err.message : err);
      }
    }
  }

  getMessage(messageId) {
    return this.#messages.get(messageId) || null;
  }

  listInbox({ teamId, recipient }) {
    return [...this.#messages.values()]
      .filter((message) => message.teamId === teamId)
      .filter((message) => {
        if (recipient.kind !== message.to.kind) return false;
        if (recipient.kind === 'user' || recipient.kind === 'system') return true;
        if (recipient.kind === 'team') return recipient.teamId === message.to.teamId;
        return recipient.teamId === message.to.teamId && recipient.agentId === message.to.agentId;
      })
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
  }

  listMessages({ teamId, conversationId = null, limit = null } = {}) {
    let messages = [...this.#messages.values()];
    if (teamId) {
      messages = messages.filter((message) => message.teamId === teamId);
    }
    if (conversationId) {
      messages = messages.filter((message) => message.conversationId === conversationId);
    }
    messages = messages.sort((left, right) => {
      const timeDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
      return timeDelta || left.messageId.localeCompare(right.messageId);
    });
    if (Number.isInteger(limit) && limit >= 0) {
      return messages.slice(0, limit);
    }
    return messages;
  }

  markRead({ messageId, readerId, readAt = new Date().toISOString() }) {
    if (!this.#messages.has(messageId)) {
      throw new Error(`unknown message: ${messageId}`);
    }
    const key = `${messageId}:${readerId}`;
    this.#readReceipts.set(key, { messageId, readerId, readAt });
    return this.#readReceipts.get(key);
  }

  beginDeliveryAttempt({
    messageId,
    runtimeId,
    destination,
    idempotencyKey = null,
    payloadHash = null,
    deliveryKind = 'unknown',
    responseState = null,
  }) {
    if (!this.#messages.has(messageId)) {
      throw new Error(`unknown message: ${messageId}`);
    }
    if (idempotencyKey) {
      const existing = [...this.#deliveryAttempts.values()].find(
        (attempt) => attempt.idempotencyKey === idempotencyKey
      );
      if (existing) {
        if (existing.payloadHash && payloadHash && existing.payloadHash !== payloadHash) {
          throw new Error(`delivery idempotency conflict: ${idempotencyKey}`);
        }
        return this.#deliveryAttemptResult(false, existing);
      }
    }
    const attempt = {
      attemptId: randomUUID(),
      idempotencyKey,
      payloadHash,
      messageId,
      runtimeId,
      deliveryKind,
      destination,
      status: 'pending',
      responseState,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      receipt: null,
      error: null,
    };
    this.#deliveryAttempts.set(attempt.attemptId, attempt);
    return this.#deliveryAttemptResult(true, attempt);
  }

  commitDeliveryAttempt({ attemptId, receipt, responseState = null }) {
    const attempt = this.#deliveryAttempts.get(attemptId);
    if (!attempt) throw new Error(`unknown delivery attempt: ${attemptId}`);
    const next = {
      ...attempt,
      status: 'committed',
      responseState: responseState ?? attempt.responseState,
      receipt: receipt || {},
      updatedAt: new Date().toISOString(),
    };
    this.#deliveryAttempts.set(attemptId, next);
    return next;
  }

  failDeliveryAttempt({ attemptId, error, retryable = true, responseState = null }) {
    const attempt = this.#deliveryAttempts.get(attemptId);
    if (!attempt) throw new Error(`unknown delivery attempt: ${attemptId}`);
    const next = {
      ...attempt,
      status: retryable ? 'failed_retryable' : 'failed_terminal',
      responseState: responseState ?? attempt.responseState,
      error: String(error || 'unknown delivery failure'),
      updatedAt: new Date().toISOString(),
    };
    this.#deliveryAttempts.set(attemptId, next);
    return next;
  }

  // SP1a Stage 2 (whole-impl W1) — claim a delivery attempt in-flight before
  // a long session turn (mirrors SqliteBroker). Session-scoped use only.
  markDeliveryInFlight({ attemptId }) {
    const attempt = this.#deliveryAttempts.get(attemptId);
    if (!attempt) throw new Error(`unknown delivery attempt: ${attemptId}`);
    const next = {
      ...attempt,
      status: 'committed',
      responseState: 'delivering',
      updatedAt: new Date().toISOString(),
    };
    this.#deliveryAttempts.set(attemptId, next);
    return next;
  }

  #deliveryAttemptResult(inserted, attempt) {
    return { inserted, attempt, ...attempt };
  }
}
