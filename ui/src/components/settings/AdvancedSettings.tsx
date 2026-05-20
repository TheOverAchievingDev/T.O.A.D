import { useState } from 'react';
import { Icon } from '../Icon';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';
import { useSectionDraft } from './useSectionDraft';
import { SaveBar, SectionMeta } from './SectionShell';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import type { Tweaks } from '@/types';
import type { SetTweak } from '../TweaksPanel';

const DEFAULT_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };

const SETTINGS_SECTIONS = ['general', 'providers', 'github', 'workspace', 'risk', 'mcp', 'notifications', 'advanced'] as const;

type LogLevel = 'info' | 'debug' | 'trace';

interface AdvancedDraft {
  dbPathOverride: string;
  apiPort: number;
  logLevel: LogLevel;
  devToolsEnabled: boolean;
}

const DEFAULTS: AdvancedDraft = {
  dbPathOverride: '',
  apiPort: 3001,
  logLevel: 'info',
  devToolsEnabled: false,
};

type BackendResetState =
  | { kind: 'idle' }
  | { kind: 'confirm'; what: 'settings' | 'risk' }
  | { kind: 'running'; what: 'settings' | 'risk' }
  | { kind: 'done'; what: 'settings' | 'risk' }
  | { kind: 'error'; message: string };

interface AdvancedSettingsProps {
  tweaks: Tweaks;
  setTweak: SetTweak;
}

export function AdvancedSettings({ tweaks, setTweak }: AdvancedSettingsProps) {
  const draft = useSectionDraft<AdvancedDraft>({ section: 'advanced', scope: 'global', defaults: DEFAULTS });
  const [resetConfirm, setResetConfirm] = useState(false);
  const [backendReset, setBackendReset] = useState<BackendResetState>({ kind: 'idle' });

  async function clearSettingsFile(scope: 'global' | 'project') {
    setBackendReset({ kind: 'running', what: 'settings' });
    try {
      // Overwrite each section with an empty object. Atomic-per-section but
      // covers the surface — alternative would be a single "settings_clear"
      // backend tool, deferred until we see the need.
      for (const section of SETTINGS_SECTIONS) {
        await callTool({
          actor: DEFAULT_ACTOR,
          method: 'settings_set',
          args: { scope, section, value: {} },
          idempotencyKey: `settings-clear-${scope}-${section}-${Date.now()}`,
        });
      }
      setBackendReset({ kind: 'done', what: 'settings' });
      draft.revert();
    } catch (err) {
      const message = err instanceof ToadApiError ? err.message
        : err instanceof Error ? err.message
        : 'Reset failed';
      setBackendReset({ kind: 'error', message });
    }
  }

  async function clearRiskPolicy() {
    setBackendReset({ kind: 'running', what: 'risk' });
    try {
      await callTool({
        actor: DEFAULT_ACTOR,
        method: 'risk_policy_set',
        args: { rules: [], commandRules: [] },
        idempotencyKey: `risk-clear-${Date.now()}`,
      });
      setBackendReset({ kind: 'done', what: 'risk' });
    } catch (err) {
      const message = err instanceof ToadApiError ? err.message
        : err instanceof Error ? err.message
        : 'Reset failed';
      setBackendReset({ kind: 'error', message });
    }
  }

  return (
    <div>
      <SettingsSectionHeader
        title="Advanced"
        description="Things you'll rarely need to touch. Most are read by the orchestrator at startup."
      />
      <SectionMeta draft={draft} />

      <SettingsCard
        title="Developer mode"
        description="Reveals power-user surfaces: integrated terminal/test runner in cockpit, code-first cockpit default. More controls as future slices ship."
      >
        <div className="field" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <input
            id="developer-mode-toggle"
            type="checkbox"
            checked={tweaks.developerMode === true}
            onChange={(e) => setTweak('developerMode', e.target.checked)}
            style={{ width: 16, height: 16 }}
          />
          <label htmlFor="developer-mode-toggle" style={{ fontSize: 12 }}>
            {tweaks.developerMode ? 'Developer mode is ON' : 'Developer mode is OFF'}
          </label>
        </div>
      </SettingsCard>

      <SettingsCard
        title="DB path override"
        description="Where Symphony opens its SQLite file. Leaving this blank uses .toad/toad.db inside the active project. Changes apply on next API restart."
      >
        <div className="field">
          <label>Path</label>
          <input
            className="field-input mono"
            value={draft.draft.dbPathOverride}
            onChange={(e) => draft.patch({ dbPathOverride: e.target.value })}
            placeholder="e.g. C:\\symphony\\db\\shared.db"
            disabled={draft.saving}
            style={{ fontSize: 12 }}
          />
        </div>
      </SettingsCard>

      <SettingsCard title="API server">
        <div className="field">
          <label>Port</label>
          <input
            type="number"
            className="field-input mono"
            min={1024}
            max={65535}
            value={draft.draft.apiPort}
            onChange={(e) => draft.patch({ apiPort: Number(e.target.value) || 3001 })}
            disabled={draft.saving}
            style={{ fontSize: 12, width: 140 }}
          />
          <div className="field-hint">Default 3001. Restart api:dev for the change to take effect.</div>
        </div>
      </SettingsCard>

      <SettingsCard title="Logging">
        <div className="field">
          <label>Log level</label>
          <div className="seg">
            {(['info', 'debug', 'trace'] as LogLevel[]).map((lv) => (
              <button
                key={lv}
                type="button"
                className={draft.draft.logLevel === lv ? 'active' : ''}
                onClick={() => draft.patch({ logLevel: lv })}
                disabled={draft.saving}
              >
                {lv}
              </button>
            ))}
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Developer tools"
        description="Extra keyboard shortcuts and overlay panels. Off by default."
      >
        <div
          className="toggle-row"
          onClick={() => !draft.saving && draft.patch({ devToolsEnabled: !draft.draft.devToolsEnabled })}
        >
          <div className={`toggle ${draft.draft.devToolsEnabled ? 'on' : ''}`} />
          <div className="toggle-label-block" style={{ flex: 1 }}>
            <div className="ti">Enable developer tools</div>
            <div className="sub">Adds the Tweaks panel + extra console commands. Toggle anytime via Settings or ⌘K.</div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Reset local UI state"
        description="Clears local-only browser state (Tweaks, project registry, command-palette history). Does not touch the backend DB or settings file."
      >
        {!resetConfirm && (
          <button type="button" className="btn" onClick={() => setResetConfirm(true)} disabled={draft.saving}>
            <Icon name="trash" size={11} /> Reset…
          </button>
        )}
        {resetConfirm && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span style={{ fontSize: 12 }}>This wipes localStorage. Sure?</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                try {
                  window.localStorage.clear();
                  window.location.reload();
                } catch {
                  /* ignore */
                }
              }}
            >
              Yes, wipe and reload
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setResetConfirm(false)}>
              Cancel
            </button>
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="Reset backend state"
        description="Clears server-side artifacts. Settings reset wipes every section in settings.json (provider keys, GitHub creds, workspace defaults, etc). Risk policy reset empties .toad/risk-policy.json. Both are irreversible — back up first if you've configured anything you'd rather keep."
      >
        {backendReset.kind === 'error' && (
          <div
            style={{
              marginBottom: 10,
              padding: '8px 10px',
              background: 'oklch(0.30 0.08 25 / 0.4)',
              border: '1px solid oklch(0.55 0.18 25 / 0.4)',
              borderRadius: 6,
              color: 'oklch(0.85 0.10 25)',
              fontSize: 12,
            }}
          >
            {backendReset.message}
          </div>
        )}
        {backendReset.kind === 'done' && (
          <div
            style={{
              marginBottom: 10,
              padding: '8px 10px',
              background: 'oklch(0.30 0.08 145 / 0.4)',
              border: '1px solid oklch(0.55 0.18 145 / 0.4)',
              borderRadius: 6,
              color: 'oklch(0.85 0.10 145)',
              fontSize: 12,
            }}
          >
            <Icon name="check" size={11} /> Cleared {backendReset.what === 'settings' ? 'settings.json sections' : '.toad/risk-policy.json'}.
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {backendReset.kind === 'idle' || backendReset.kind === 'done' || backendReset.kind === 'error' ? (
            <>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setBackendReset({ kind: 'confirm', what: 'settings' })}
              >
                <Icon name="trash" size={11} /> Reset all settings…
              </button>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setBackendReset({ kind: 'confirm', what: 'risk' })}
              >
                <Icon name="trash" size={11} /> Reset risk policy…
              </button>
            </>
          ) : null}

          {backendReset.kind === 'confirm' && backendReset.what === 'settings' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>
                This wipes every section in <span className="mono">settings.json</span> (global scope). Sure?
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void clearSettingsFile('global')}
              >
                Yes, clear settings
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setBackendReset({ kind: 'idle' })}
              >
                Cancel
              </button>
            </div>
          )}

          {backendReset.kind === 'confirm' && backendReset.what === 'risk' && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>
                This empties <span className="mono">.toad/risk-policy.json</span>. Sure?
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => void clearRiskPolicy()}
              >
                Yes, clear policy
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => setBackendReset({ kind: 'idle' })}
              >
                Cancel
              </button>
            </div>
          )}

          {backendReset.kind === 'running' && (
            <div className="dim" style={{ fontSize: 12 }}>
              Clearing {backendReset.what === 'settings' ? 'settings.json' : '.toad/risk-policy.json'}…
            </div>
          )}
        </div>
      </SettingsCard>

      <SaveBar draft={draft} />
    </div>
  );
}
