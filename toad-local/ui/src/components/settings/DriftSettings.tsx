import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';
import { useSectionDraft } from './useSectionDraft';
import { SaveBar, SectionMeta } from './SectionShell';

export type DriftCompareAgainst = 'foundry_docs' | 'current_state';

interface DriftDraft {
  compareAgainst: DriftCompareAgainst;
}

const DEFAULTS: DriftDraft = {
  compareAgainst: 'foundry_docs',
};

const COMPARE_OPTIONS: ReadonlyArray<{ key: DriftCompareAgainst; label: string; hint: string }> = [
  {
    key: 'foundry_docs',
    label: 'Foundry spec docs',
    hint: 'Compare against the original architecture / steering / design-decisions docs.',
  },
  {
    key: 'current_state',
    label: 'Current codebase',
    hint: 'Compare against recent commits + README/AGENTS/CLAUDE/CONTRIBUTING docs.',
  },
];

function normalizeCompareAgainst(value: unknown): DriftCompareAgainst {
  return value === 'current_state' ? 'current_state' : 'foundry_docs';
}

export function DriftSettings() {
  const draft = useSectionDraft<DriftDraft>({
    section: 'drift',
    scope: 'global',
    defaults: DEFAULTS,
  });

  const compareAgainst = normalizeCompareAgainst(draft.draft.compareAgainst);

  return (
    <div>
      <SettingsSectionHeader
        title="Drift"
        description="How drift compares your team's work against a baseline."
      />
      <SectionMeta draft={draft} />

      <SettingsCard
        title="Comparison baseline"
        description={
          'Pick "Current codebase" once your project has shipped past its original brief — ' +
          'drift uses recent commits + README/AGENTS/CLAUDE/CONTRIBUTING docs as the baseline ' +
          'instead of the (possibly stale) Foundry docs.'
        }
      >
        <div className="seg" role="radiogroup" aria-label="Drift comparison baseline">
          {COMPARE_OPTIONS.map((opt) => {
            const isActive = compareAgainst === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                role="radio"
                aria-checked={isActive}
                className={isActive ? 'active' : ''}
                onClick={() => draft.patch({ compareAgainst: opt.key })}
                disabled={draft.saving}
              >
                {opt.label}
                {opt.key === 'foundry_docs' && (
                  <span className="dim" style={{ marginLeft: 4, fontSize: 11 }}>(default)</span>
                )}
              </button>
            );
          })}
        </div>
        <div className="field-hint">
          {COMPARE_OPTIONS.find((o) => o.key === compareAgainst)?.hint}
        </div>
      </SettingsCard>

      <SaveBar draft={draft} />
    </div>
  );
}
