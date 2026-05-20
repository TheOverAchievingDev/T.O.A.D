import { Icon } from '../Icon';
import { useToasts, type ToastSeverity } from '../ToastSystem';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';
import { useSectionDraft } from './useSectionDraft';
import { SaveBar, SectionMeta } from './SectionShell';

const PREVIEW_SEVERITIES: ToastSeverity[] = ['info', 'success', 'warn', 'error', 'blocking'];

type Mode = 'quiet' | 'loud';

interface NotificationsDraft {
  mode: Mode;
  toastOn: {
    error: boolean;
    blockingReview: boolean;
    humanApprovalRequired: boolean;
    stuckRuntime: boolean;
    taskDone: boolean;
  };
  drawer: {
    coalesce: boolean;
    retentionDays: number;
  };
}

const DEFAULTS: NotificationsDraft = {
  mode: 'quiet',
  toastOn: {
    error: true,
    blockingReview: true,
    humanApprovalRequired: true,
    stuckRuntime: true,
    taskDone: false,
  },
  drawer: {
    coalesce: true,
    retentionDays: 14,
  },
};

export function NotificationsSettings() {
  const draft = useSectionDraft<NotificationsDraft>({ section: 'notifications', scope: 'global', defaults: DEFAULTS });
  const { toast } = useToasts();

  function toggleToast(key: keyof NotificationsDraft['toastOn']) {
    draft.patch({ toastOn: { ...draft.draft.toastOn, [key]: !draft.draft.toastOn[key] } });
  }

  function preview(severity: ToastSeverity) {
    const titles: Record<ToastSeverity, string> = {
      info: 'Info toast preview',
      success: 'Success toast preview',
      warn: 'Warning toast preview',
      error: 'Error toast preview',
      blocking: 'Blocking toast preview',
    };
    const bodies: Record<ToastSeverity, string> = {
      info: 'This is what an info-level event looks like.',
      success: 'This is what a success event (e.g. task done) looks like.',
      warn: 'This is what a warning (e.g. stuck runtime) looks like.',
      error: 'This is what an error event looks like.',
      blocking: 'This is sticky — it stays until dismissed (e.g. §14 gate).',
    };
    toast({ severity, title: titles[severity], body: bodies[severity], source: 'preview' });
  }

  return (
    <div>
      <SettingsSectionHeader
        title="Notifications"
        description="Pick which runtime events become toasts vs only land in the Notifications drawer."
      />
      <SectionMeta draft={draft} />

      <SettingsCard title="Mode">
        <div className="seg">
          {(['quiet', 'loud'] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              className={draft.draft.mode === m ? 'active' : ''}
              onClick={() => draft.patch({ mode: m })}
              disabled={draft.saving}
            >
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        <div className="field-hint">
          <strong>Quiet</strong>: only flagged severities toast (recommended). <strong>Loud</strong>: every runtime event toasts.
        </div>
      </SettingsCard>

      <SettingsCard
        title="Toast which events"
        description={draft.draft.mode === 'loud' ? 'Loud mode toasts every event regardless of these toggles.' : 'In quiet mode, these are the events that punch through.'}
      >
        {(Object.keys(draft.draft.toastOn) as Array<keyof NotificationsDraft['toastOn']>).map((key) => {
          const labelMap: Record<keyof NotificationsDraft['toastOn'], string> = {
            error: 'Errors (any runtime emits an error event)',
            blockingReview: 'Blocking review feedback (severity: blocking)',
            humanApprovalRequired: '§14 human-approval gate triggered',
            stuckRuntime: '§13 stuck-runtime detector flags an agent',
            taskDone: 'Task moves to done',
          };
          return (
            <div
              key={key}
              className="toggle-row"
              onClick={() => !draft.saving && toggleToast(key)}
              style={{ opacity: draft.draft.mode === 'loud' ? 0.6 : 1 }}
            >
              <div className={`toggle ${draft.draft.toastOn[key] ? 'on' : ''}`} />
              <div className="toggle-label-block" style={{ flex: 1 }}>
                <div className="ti">{labelMap[key]}</div>
              </div>
            </div>
          );
        })}
      </SettingsCard>

      <SettingsCard title="Drawer">
        <div
          className="toggle-row"
          onClick={() => !draft.saving && draft.patch({ drawer: { ...draft.draft.drawer, coalesce: !draft.draft.drawer.coalesce } })}
        >
          <div className={`toggle ${draft.draft.drawer.coalesce ? 'on' : ''}`} />
          <div className="toggle-label-block" style={{ flex: 1 }}>
            <div className="ti">Coalesce repeated events</div>
            <div className="sub">"5 tool calls succeeded" instead of 5 individual rows.</div>
          </div>
        </div>
        <div className="field">
          <label>Retention</label>
          <input
            type="number"
            className="field-input mono"
            min={1}
            max={365}
            value={draft.draft.drawer.retentionDays}
            onChange={(e) => draft.patch({ drawer: { ...draft.draft.drawer, retentionDays: Number(e.target.value) || 14 } })}
            disabled={draft.saving}
            style={{ fontSize: 12, width: 120 }}
          />
          <div className="field-hint">Days. After this, drawer entries are pruned.</div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Preview"
        description="Fire a sample toast at each severity to confirm styling and stack behaviour. Sticky severities (blocking) must be dismissed manually."
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {PREVIEW_SEVERITIES.map((s) => (
            <button
              key={s}
              type="button"
              className="btn btn-sm"
              onClick={() => preview(s)}
            >
              <Icon name="bell" size={11} /> {s[0].toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>
      </SettingsCard>

      <SaveBar draft={draft} />
    </div>
  );
}
