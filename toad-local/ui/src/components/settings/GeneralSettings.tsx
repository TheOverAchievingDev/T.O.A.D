import type { Tweaks } from '@/types';
import type { SetTweak } from '../TweaksPanel';
import { Icon } from '../Icon';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';

interface GeneralSettingsProps {
  tweaks: Tweaks;
  setTweak: SetTweak;
}

export function GeneralSettings({ tweaks, setTweak }: GeneralSettingsProps) {
  return (
    <div>
      <SettingsSectionHeader
        title="General"
        description="Look-and-feel preferences for this browser. Stored locally — they don't sync across machines."
      />

      <SettingsCard title="Appearance">
        <div className="field">
          <label>Theme</label>
          <div className="seg">
            {(['dark', 'light'] as const).map((t) => (
              <button
                key={t}
                type="button"
                className={tweaks.theme === t ? 'active' : ''}
                onClick={() => setTweak('theme', t)}
              >
                <Icon name={t === 'dark' ? 'moon' : 'sun'} size={11} />
                {t[0].toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Density</label>
          <div className="seg">
            {(['comfy', 'compact'] as const).map((d) => (
              <button
                key={d}
                type="button"
                className={tweaks.density === d ? 'active' : ''}
                onClick={() => setTweak('density', d)}
              >
                {d[0].toUpperCase() + d.slice(1)}
              </button>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Default agent card style</label>
          <div className="seg">
            {(['detail', 'compact', 'terminal'] as const).map((v) => (
              <button
                key={v}
                type="button"
                className={tweaks.cardVariant === v ? 'active' : ''}
                onClick={() => setTweak('cardVariant', v)}
              >
                {v[0].toUpperCase() + v.slice(1)}
              </button>
            ))}
          </div>
          <div className="field-hint">
            Affects every agent card across the workspace and inbox.
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Layout"
        description="Workspace layout metaphor. Affects which view loads when you open a team."
      >
        <div className="field">
          <label>Workspace layout</label>
          <select
            className="field-input"
            value={tweaks.layout}
            onChange={(e) => setTweak('layout', e.target.value as Tweaks['layout'])}
          >
            <option value="org">Org chart (lead → reports)</option>
            <option value="chat">Chat-first</option>
            <option value="kanban">Kanban-first</option>
          </select>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Developer"
        description="Surface dev-only controls for visualising state."
      >
        <div
          className="toggle-row"
          onClick={() => setTweak('showTweaks', !tweaks.showTweaks)}
        >
          <div className={`toggle ${tweaks.showTweaks ? 'on' : ''}`} />
          <div className="toggle-label-block" style={{ flex: 1 }}>
            <div className="ti">Show Tweaks panel</div>
            <div className="sub">
              Floating dev panel for exercising every screen and overlay.
              Toggle anytime via the command palette (⌘K → "Show Tweaks panel").
            </div>
          </div>
        </div>
      </SettingsCard>
    </div>
  );
}
