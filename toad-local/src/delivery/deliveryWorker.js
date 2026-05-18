import { createHash } from 'node:crypto';

const RUNTIME_DELIVERY_MODES = new Set(['runtime_stdin', 'runtime_bridge']);
const SESSION_DELIVERY_MODES = new Set(['session_turn']);

export class DeliveryWorker {
  constructor({ broker, runtimeDirectory, adapters }) {
    if (!broker) throw new TypeError('broker is required');
    if (!runtimeDirectory) throw new TypeError('runtimeDirectory is required');
    this.broker = broker;
    this.runtimeDirectory = runtimeDirectory;
    this.adapters = adapters || new Map();
  }

  async deliverMessage(messageId) {
    const message = this.broker.getMessage(messageId);
    if (!message) {
      throw new Error(`unknown message: ${messageId}`);
    }

    const resolved = this.runtimeDirectory.resolve(message.to);
    const begin = this.broker.beginDeliveryAttempt({
      messageId: message.messageId,
      runtimeId: resolved.runtimeId,
      destination: resolved.destination,
      idempotencyKey: buildDeliveryIdempotencyKey(message, resolved),
      payloadHash: hashDeliveryPayload({ message, resolved }),
      deliveryKind: resolved.deliveryMode,
    });
    if (!begin.inserted && begin.attempt.status === 'committed') {
      return begin.attempt;
    }

    try {
      if (RUNTIME_DELIVERY_MODES.has(resolved.deliveryMode)) {
        const adapter = this.adapters.get(resolved.runtimeId);
        if (!adapter || typeof adapter.sendTurn !== 'function') {
          throw new Error(`runtime adapter not registered: ${resolved.runtimeId}`);
        }

        const receipt = await adapter.sendTurn({
          runtimeId: resolved.runtimeId,
          deliveryMode: resolved.deliveryMode,
          destination: resolved.destination,
          message,
        });
        if (!receipt || receipt.accepted !== true) {
          throw new Error(receipt?.reason || 'runtime did not accept message');
        }

        return this.broker.commitDeliveryAttempt({
          attemptId: begin.attempt.attemptId,
          receipt: {
            deliveryMode: resolved.deliveryMode,
            responseState: receipt.responseState || 'accepted_by_runtime',
            ...(receipt.receipt && typeof receipt.receipt === 'object' ? receipt.receipt : {}),
          },
          responseState: receipt.responseState || 'accepted_by_runtime',
        });
      }

      if (SESSION_DELIVERY_MODES.has(resolved.deliveryMode)) {
        const adapter = this.adapters.get(resolved.runtimeId);
        if (adapter && typeof adapter.sendTurn === 'function') {
          // Wake-on-message: the adapter's FIFO + resume logic handles
          // idle-wake vs mid-turn batching transparently (spec §5).
          const receipt = await adapter.sendTurn({
            runtimeId: resolved.runtimeId,
            deliveryMode: resolved.deliveryMode,
            destination: resolved.destination,
            message,
          });
          if (!receipt || receipt.accepted !== true) {
            throw new Error(receipt?.reason || 'session runtime did not accept message');
          }
          return this.broker.commitDeliveryAttempt({
            attemptId: begin.attempt.attemptId,
            receipt: {
              deliveryMode: resolved.deliveryMode,
              responseState: receipt.responseState || 'accepted_by_runtime',
              ...(receipt.receipt && typeof receipt.receipt === 'object' ? receipt.receipt : {}),
            },
            responseState: receipt.responseState || 'accepted_by_runtime',
          });
        }
        // No live adapter (agent parked / not yet launched): fall through to
        // the durable queued commit below — the broker is durable, so the
        // boot reconciliation pass (Task 9) re-delivers on relaunch.
      }

      return this.broker.commitDeliveryAttempt({
        attemptId: begin.attempt.attemptId,
        receipt: {
          queued: true,
          deliveryMode: resolved.deliveryMode,
          destination: resolved.destination,
        },
        responseState:
          resolved.deliveryMode === 'offline_queue' ? 'queued_offline' : 'queued_for_recipient',
      });
    } catch (error) {
      return this.broker.failDeliveryAttempt({
        attemptId: begin.attempt.attemptId,
        error,
        retryable: true,
        responseState: 'delivery_failed',
      });
    }
  }
}

export function buildDeliveryIdempotencyKey(message, resolved) {
  return ['delivery', message.messageId, resolved.runtimeId, resolved.deliveryMode].join(':');
}

export function hashDeliveryPayload(value) {
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
