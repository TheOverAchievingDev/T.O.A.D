import { useCallback } from 'react';
import { useToadEvents, type RuntimeEvent } from '@/api/events';
import { useToasts, type ToastSeverity } from '@/components/ToastSystem';

export interface NotificationsConfig {
  mode?: 'quiet' | 'loud';
  toastOn?: {
    error?: boolean;
    blockingReview?: boolean;
    humanApprovalRequired?: boolean;
    stuckRuntime?: boolean;
    taskDone?: boolean;
  };
}

export interface UseEventToastsArgs {
  /** Pulled from settings.notifications when available; falls back to the
   * built-in defaults (quiet, errors + §14 + stuck only). */
  notifications?: NotificationsConfig;
  /** Optional: when set, certain toasts get an action button that calls back
   * into the app (e.g. "Open task"). */
  onOpenTask?: (taskId: string) => void;
  onOpenApprovals?: () => void;
}

const DEFAULTS: Required<NotificationsConfig> = {
  mode: 'quiet',
  toastOn: {
    error: true,
    blockingReview: true,
    humanApprovalRequired: true,
    stuckRuntime: true,
    taskDone: false,
  },
};

interface ToastShape {
  id?: string;
  severity: ToastSeverity;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void };
  source: string;
}

/**
 * Convert a runtime SSE event into a toast description, or null when the
 * event shouldn't toast under the current notification config.
 */
function eventToToast(
  event: RuntimeEvent,
  cfg: Required<NotificationsConfig>,
  callbacks: { onOpenTask?: (taskId: string) => void; onOpenApprovals?: () => void },
): ToastShape | null {
  const type = String(event.type ?? '');
  const payload = (event.payload as Record<string, unknown> | undefined) ?? {};
  const taskId = typeof payload.taskId === 'string' ? payload.taskId : (typeof event.taskId === 'string' ? event.taskId : undefined);
  const severityField = typeof payload.severity === 'string' ? payload.severity : null;

  // §14 human-approval gate fired
  if (type === 'TASK_RISK_CLASSIFIED' && payload.requiresHumanApproval === true) {
    if (cfg.mode === 'quiet' && !cfg.toastOn.humanApprovalRequired) return null;
    return {
      id: `human-approve-${taskId ?? 'task'}`,
      severity: 'blocking',
      title: 'Human approval needed',
      body: taskId ? `${taskId} was elevated to ${payload.riskLevel ?? 'critical'} and is gated by §14.` : 'A task is gated by §14.',
      action: callbacks.onOpenApprovals
        ? { label: 'Review', onClick: callbacks.onOpenApprovals }
        : undefined,
      source: 'risk-policy',
    };
  }

  // §13 stuck runtime
  if (type === 'STUCK_RUNTIME_DETECTED' || type === 'runtime.stuck') {
    if (cfg.mode === 'quiet' && !cfg.toastOn.stuckRuntime) return null;
    const runtimeId = String(event.runtimeId ?? payload.runtimeId ?? 'runtime');
    return {
      id: `stuck-${runtimeId}`,
      severity: 'warn',
      title: 'Stuck runtime',
      body: `${runtimeId} hasn't emitted events recently — investigate or restart.`,
      source: 'stuck-detector',
    };
  }

  // Blocking review feedback
  if (type === 'REVIEW_DECIDED' && severityField === 'blocking') {
    if (cfg.mode === 'quiet' && !cfg.toastOn.blockingReview) return null;
    return {
      id: `review-block-${taskId ?? 'task'}`,
      severity: 'error',
      title: 'Blocking review feedback',
      body: taskId ? `${taskId} has blocking comments — agent must address before merge.` : 'Blocking review feedback.',
      action: taskId && callbacks.onOpenTask
        ? { label: 'Open task', onClick: () => callbacks.onOpenTask!(taskId) }
        : undefined,
      source: 'review',
    };
  }

  // Generic error events
  if (type === 'ERROR' || /\.error$/i.test(type)) {
    if (cfg.mode === 'quiet' && !cfg.toastOn.error) return null;
    const message = typeof payload.message === 'string' ? payload.message : String(payload.error ?? 'Unknown error');
    return {
      severity: 'error',
      title: 'Runtime error',
      body: message.slice(0, 240),
      source: 'runtime-error',
    };
  }

  // Task done
  if (type === 'STATUS_CHANGED' && payload.toStatus === 'done') {
    if (!cfg.toastOn.taskDone && cfg.mode === 'quiet') return null;
    return {
      id: `done-${taskId ?? 'task'}`,
      severity: 'success',
      title: 'Task done',
      body: taskId ? `${taskId} completed.` : 'A task completed.',
      action: taskId && callbacks.onOpenTask
        ? { label: 'View', onClick: () => callbacks.onOpenTask!(taskId) }
        : undefined,
      source: 'task-status',
    };
  }

  // Loud mode: surface everything else as info, but only the "interesting"
  // top-level types so we don't drown the user in tool_use noise.
  if (cfg.mode === 'loud') {
    if (
      type.startsWith('TASK_')
      || type === 'INTEGRATION_MERGED'
      || type === 'COMMENT_ADDED'
      || type === 'PLAN_PROPOSED'
      || type === 'PLAN_DECIDED'
    ) {
      return {
        severity: 'info',
        title: type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
        body: taskId ? `task ${taskId}` : undefined,
        source: 'loud',
      };
    }
  }

  return null;
}

/**
 * Subscribes to the runtime SSE stream and dispatches toasts based on the
 * currently-configured notification settings. No-op when the toast provider
 * isn't mounted.
 */
export function useEventToasts({ notifications, onOpenTask, onOpenApprovals }: UseEventToastsArgs = {}) {
  const { toast } = useToasts();
  const cfg: Required<NotificationsConfig> = {
    mode: notifications?.mode ?? DEFAULTS.mode,
    toastOn: { ...DEFAULTS.toastOn, ...(notifications?.toastOn ?? {}) },
  };

  const onEvent = useCallback((event: RuntimeEvent) => {
    const shape = eventToToast(event, cfg, { onOpenTask, onOpenApprovals });
    if (!shape) return;
    toast(shape);
  }, [toast, cfg, onOpenTask, onOpenApprovals]);

  useToadEvents({ onEvent });
}
