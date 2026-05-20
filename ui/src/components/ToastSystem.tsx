import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Icon, type IconName } from './Icon';

export type ToastSeverity = 'info' | 'success' | 'warn' | 'error' | 'blocking';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastInput {
  /** Stable id; if omitted, one is generated. Use this when the same logical
   * event might fire multiple times — passing the same id replaces the
   * existing toast instead of stacking. */
  id?: string;
  severity?: ToastSeverity;
  title: string;
  body?: string;
  /** Auto-dismiss delay in ms. 0 or negative = sticky. Default depends on severity. */
  durationMs?: number;
  action?: ToastAction;
  /** Free-form tag the producer can use to filter/group later. */
  source?: string;
}

interface Toast extends Required<Omit<ToastInput, 'action' | 'source' | 'durationMs'>> {
  durationMs: number;
  action?: ToastAction;
  source?: string;
  createdAt: number;
}

interface ToastContextValue {
  toast: (input: ToastInput) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const DEFAULT_DURATIONS: Record<ToastSeverity, number> = {
  info: 4000,
  success: 4000,
  warn: 7000,
  error: 9000,
  blocking: 0, // sticky — must be dismissed by user or replaced
};

const SEVERITY_META: Record<ToastSeverity, { color: string; bg: string; bd: string; icon: IconName }> = {
  info: {
    color: 'oklch(0.85 0.10 245)',
    bg: 'oklch(0.30 0.06 245 / 0.55)',
    bd: 'oklch(0.55 0.10 245 / 0.40)',
    icon: 'info',
  },
  success: {
    color: 'oklch(0.85 0.15 145)',
    bg: 'oklch(0.30 0.08 145 / 0.55)',
    bd: 'oklch(0.55 0.15 145 / 0.40)',
    icon: 'check',
  },
  warn: {
    color: 'oklch(0.88 0.14 80)',
    bg: 'oklch(0.32 0.10 80 / 0.55)',
    bd: 'oklch(0.65 0.14 80 / 0.40)',
    icon: 'info',
  },
  error: {
    color: 'oklch(0.86 0.18 25)',
    bg: 'oklch(0.32 0.12 25 / 0.55)',
    bd: 'oklch(0.62 0.18 25 / 0.45)',
    icon: 'x',
  },
  blocking: {
    color: 'oklch(0.92 0.20 25)',
    bg: 'oklch(0.40 0.18 25 / 0.55)',
    bd: 'oklch(0.70 0.22 25 / 0.55)',
    icon: 'info',
  },
};

let counter = 0;
function makeId() {
  counter += 1;
  return `t_${Date.now().toString(36)}_${counter.toString(36)}`;
}

interface ToastProviderProps {
  children: ReactNode;
  /** Cap the on-screen stack. Older toasts are evicted when more arrive. */
  max?: number;
}

export function ToastProvider({ children, max = 5 }: ToastProviderProps) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const handle = timers.current.get(id);
    if (handle) {
      clearTimeout(handle);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback<ToastContextValue['toast']>((input) => {
    const id = input.id ?? makeId();
    const severity: ToastSeverity = input.severity ?? 'info';
    const durationMs = input.durationMs ?? DEFAULT_DURATIONS[severity];
    const next: Toast = {
      id,
      severity,
      title: input.title,
      body: input.body ?? '',
      durationMs,
      action: input.action,
      source: input.source,
      createdAt: Date.now(),
    };

    setToasts((prev) => {
      const without = prev.filter((t) => t.id !== id);
      const trimmed = without.length >= max ? without.slice(without.length - max + 1) : without;
      return [...trimmed, next];
    });

    // Reset auto-dismiss timer (in case we're replacing).
    const existing = timers.current.get(id);
    if (existing) clearTimeout(existing);
    if (durationMs > 0) {
      const handle = setTimeout(() => dismiss(id), durationMs);
      timers.current.set(id, handle);
    } else {
      timers.current.delete(id);
    }
    return id;
  }, [dismiss, max]);

  const clear = useCallback(() => {
    setToasts([]);
    timers.current.forEach((h) => clearTimeout(h));
    timers.current.clear();
  }, []);

  // On unmount, clear all timers.
  useEffect(() => () => {
    timers.current.forEach((h) => clearTimeout(h));
    timers.current.clear();
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toast, dismiss, clear }), [toast, dismiss, clear]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToasts(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToasts must be used inside <ToastProvider>');
  }
  return ctx;
}

interface ToastViewportProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

function ToastViewport({ toasts, onDismiss }: ToastViewportProps) {
  if (toasts.length === 0) return null;
  return (
    <div className="toast-viewport" aria-live="polite">
      {toasts.map((t) => <ToastView key={t.id} toast={t} onDismiss={onDismiss} />)}
    </div>
  );
}

function ToastView({ toast, onDismiss }: { toast: Toast; onDismiss: (id: string) => void }) {
  const meta = SEVERITY_META[toast.severity];
  return (
    <div
      role="status"
      className="toast"
      style={{
        background: meta.bg,
        borderColor: meta.bd,
        color: 'var(--fg, #fff)',
      }}
    >
      <span className="toast-icon" style={{ color: meta.color }}>
        <Icon name={meta.icon} size={14} />
      </span>
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.body && <div className="toast-text">{toast.body}</div>}
      </div>
      {toast.action && (
        <button
          type="button"
          className="toast-action"
          onClick={(e) => {
            e.stopPropagation();
            try {
              toast.action!.onClick();
            } finally {
              onDismiss(toast.id);
            }
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="toast-close"
        aria-label="Dismiss"
        onClick={() => onDismiss(toast.id)}
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  );
}
