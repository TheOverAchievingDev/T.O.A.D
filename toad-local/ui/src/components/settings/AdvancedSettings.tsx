import { useState } from 'react';
import { Icon } from '../Icon';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';
import { useSectionDraft } from './useSectionDraft';
import { SaveBar, SectionMeta } from './SectionShell';

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

export function AdvancedSettings() {
  const draft = useSectionDraft<AdvancedDraft>({ section: 'advanced', scope: 'global', defaults: DEFAULTS });
  const [resetConfirm, setResetConfirm] = useState(false);

  return (
    <div>
      <SettingsSectionHeader
        title="Advanced"
        description="Things you'll rarely need to touch. Most are read by the orchestrator at startup."
      />
      <SectionMeta draft={draft} />

      <SettingsCard
        title="DB path override"
        description="Where TOAD opens its SQLite file. Leaving this blank uses .toad/toad.db inside the active project. Changes apply on next API restart."
      >
        <div className="field">
          <label>Path</label>
          <input
            className="field-input mono"
            value={draft.draft.dbPathOverride}
            onChange={(e) => draft.patch({ dbPathOverride: e.target.value })}
            placeholder="e.g. C:\\toad\\db\\shared.db"
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

      <SaveBar draft={draft} />
    </div>
  );
}
