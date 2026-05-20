/**
 * Manages the context compaction → reinjection lifecycle per runtime.
 *
 * When Claude CLI compacts its context window, the agent loses its system prompt,
 * team identity, task board state, and behavioral rules. This handler schedules
 * a reinjection turn on the next idle (turn_completed) after a compact_boundary.
 *
 * Lifecycle:
 *   compact_boundary → mark pending
 *   turn_completed   → inject reinjection prompt if pending, then clear
 *   turn_failed      → clear pending (strict drop, matching legacy)
 *
 * Legacy reference: TeamProvisioningService.ts injectPostCompactReminder
 */
export class CompactionHandler {
  /** @type {Map<string, { teamId: string, agentId: string }>} */
  #pending = new Map();

  constructor({ adapters, taskBoard = null, sideEffectLog = null }) {
    this.adapters = adapters;
    this.taskBoard = taskBoard;
    this.sideEffectLog = sideEffectLog;
  }

  /**
   * Called when a compact_boundary event is received from the runtime.
   * Marks this runtime as needing context reinjection on next idle.
   */
  onCompactBoundary(event) {
    const idempotencyKey = this.sideEffectLog
      ? `compaction-reinjection:${event.runtimeId}:${event.sessionId || event.createdAt}`
      : null;

    this.#pending.set(event.runtimeId, {
      teamId: event.teamId,
      agentId: event.agentId,
      idempotencyKey,
    });

    if (this.sideEffectLog && idempotencyKey) {
      this.sideEffectLog.markPending({
        deliveryId: idempotencyKey,
        idempotencyKey,
        kind: 'compaction_reinjection',
        runtimeId: event.runtimeId,
      });
    }
  }

  /**
   * Called when a turn_completed event is received (runtime is idle).
   * If a compaction is pending for this runtime, injects the reinjection prompt.
   */
  async onTurnCompleted(event) {
    const pendingState = this.#pending.get(event.runtimeId);
    if (!pendingState) return;

    // Consume immediately — strict one-shot policy
    this.#pending.delete(event.runtimeId);

    const adapter = this.adapters?.get?.(event.runtimeId);
    if (!adapter || typeof adapter.sendTurn !== 'function') return;

    const prompt = this.#buildReinjectionPrompt(pendingState);

    try {
      await adapter.sendTurn({
        message: {
          messageId: `compact-reinject-${event.runtimeId}-${Date.now()}`,
          text: prompt,
          metadata: { source: 'compaction_handler', type: 'post_compact_reinjection' },
        },
      });
      if (this.sideEffectLog && pendingState.idempotencyKey) {
        this.sideEffectLog.markDelivered(pendingState.idempotencyKey);
      }
    } catch {
      if (this.sideEffectLog && pendingState.idempotencyKey) {
        this.sideEffectLog.markFailed(pendingState.idempotencyKey);
      }
      // Strict drop-after-attempt — do not re-arm
    }
  }

  /**
   * Called when a turn_failed event is received.
   * Clears pending state without injecting (strict drop policy, matching legacy).
   */
  onTurnFailed(event) {
    const pendingState = this.#pending.get(event.runtimeId);
    this.#pending.delete(event.runtimeId);
    if (this.sideEffectLog && pendingState?.idempotencyKey) {
      this.sideEffectLog.markFailed(pendingState.idempotencyKey);
    }
  }

  /** Returns whether a reinjection is pending for the given runtimeId. */
  isPending(runtimeId) {
    return this.#pending.has(runtimeId);
  }

  #buildReinjectionPrompt(state) {
    const parts = [
      'Context reminder (post-compaction) — your context was compacted. Here are your standing rules and current state:',
      '',
      `You are an agent in team "${state.teamId}".`,
      'You are running in a non-interactive CLI session. Do not ask questions.',
      'CRITICAL: Use structured tool calls (message_send, task_create, task_update) for all coordination. Do not rely on free-form text output for inter-agent communication.',
    ];

    // Task board snapshot
    const taskBlock = this.#buildTaskBoardSnapshot(state.teamId);
    if (taskBlock) {
      parts.push('', '## Current Task Board', '', taskBlock);
    }

    parts.push(
      '',
      'This is a context-only reminder. Do NOT start new work or execute tasks in this turn. Reply with a single word: "OK".'
    );

    return parts.join('\n');
  }

  #buildTaskBoardSnapshot(teamId) {
    if (!this.taskBoard || typeof this.taskBoard.listTasks !== 'function') return '';
    try {
      const tasks = this.taskBoard.listTasks({ teamId });
      if (!Array.isArray(tasks) || tasks.length === 0) return '';
      return tasks
        .map((task) => {
          const status = task.status || 'unknown';
          const owner = task.ownerId ? ` (owner: ${task.ownerId})` : '';
          return `- [${task.taskId}] ${task.subject} — ${status}${owner}`;
        })
        .join('\n');
    } catch {
      return '';
    }
  }
}
