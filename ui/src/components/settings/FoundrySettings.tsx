import { Icon } from '../Icon';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';
import { useSectionDraft } from './useSectionDraft';
import { SaveBar, SectionMeta } from './SectionShell';

export type FoundryProvider = 'anthropic' | 'openai';

interface FoundryDraft {
  defaultProvider: FoundryProvider;
}

const DEFAULTS: FoundryDraft = {
  defaultProvider: 'anthropic',
};

const PROVIDER_OPTIONS: ReadonlyArray<{ key: FoundryProvider; label: string; hint: string }> = [
  { key: 'anthropic', label: 'Claude', hint: 'Anthropic — default planning provider.' },
  { key: 'openai', label: 'Codex', hint: 'OpenAI — alternate planning provider.' },
];

export function FoundrySettings() {
  const draft = useSectionDraft<FoundryDraft>({
    section: 'foundry',
    scope: 'global',
    defaults: DEFAULTS,
  });

  return (
    <div>
      <SettingsSectionHeader
        title="Foundry"
        description="Default planning provider for new project plans. Each plan can override this at creation."
      />
      <SectionMeta draft={draft} />

      <SettingsCard
        title="Default provider"
        description="Used when a new Foundry session is created without an explicit provider override."
      >
        <div className="seg" role="radiogroup" aria-label="Foundry default provider">
          {PROVIDER_OPTIONS.map((opt) => {
            const isActive = draft.draft.defaultProvider === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                role="radio"
                aria-checked={isActive}
                className={isActive ? 'active' : ''}
                onClick={() => draft.patch({ defaultProvider: opt.key })}
                disabled={draft.saving}
              >
                <Icon name="cpu" size={11} />
                {opt.label}
                {opt.key === 'anthropic' && (
                  <span className="dim" style={{ marginLeft: 4, fontSize: 11 }}>(default)</span>
                )}
              </button>
            );
          })}
        </div>
        <div className="field-hint">
          {PROVIDER_OPTIONS.find((o) => o.key === draft.draft.defaultProvider)?.hint}
        </div>
      </SettingsCard>

      <SaveBar draft={draft} />
    </div>
  );
}
