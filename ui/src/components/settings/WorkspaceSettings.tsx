import { Icon } from '../Icon';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';
import { useSectionDraft } from './useSectionDraft';
import { SaveBar, SectionMeta } from './SectionShell';

interface WorkspaceDraft {
  defaultProjectPath: string;
  defaultBaseBranch: string;
  worktreeOnLaunch: boolean;
  validation: {
    install: string;
    lint: string;
    typecheck: string;
    test: string;
    build: string;
    security: string;
  };
}

const DEFAULTS: WorkspaceDraft = {
  defaultProjectPath: '',
  defaultBaseBranch: 'main',
  worktreeOnLaunch: true,
  validation: {
    install: '',
    lint: '',
    typecheck: '',
    test: '',
    build: '',
    security: '',
  },
};

export function WorkspaceSettings() {
  const draft = useSectionDraft<WorkspaceDraft>({ section: 'workspace', scope: 'global', defaults: DEFAULTS });

  return (
    <div>
      <SettingsSectionHeader
        title="Workspace defaults"
        description="What every new team inherits — project path, worktree behaviour, default validation commands."
      />
      <SectionMeta draft={draft} />

      <SettingsCard title="Defaults">
        <div className="field">
          <label>Default project path</label>
          <input
            className="field-input mono"
            value={draft.draft.defaultProjectPath}
            onChange={(e) => draft.patch({ defaultProjectPath: e.target.value })}
            placeholder="C:\\code"
            disabled={draft.saving}
          />
          <div className="field-hint">New teams default to subfolders here. Override per-team in CreateTeamModal.</div>
        </div>

        <div className="field">
          <label>Default base branch</label>
          <input
            className="field-input mono"
            value={draft.draft.defaultBaseBranch}
            onChange={(e) => draft.patch({ defaultBaseBranch: e.target.value })}
            placeholder="main"
            disabled={draft.saving}
          />
        </div>

        <div
          className="toggle-row"
          onClick={() => !draft.saving && draft.patch({ worktreeOnLaunch: !draft.draft.worktreeOnLaunch })}
        >
          <div className={`toggle ${draft.draft.worktreeOnLaunch ? 'on' : ''}`} />
          <div className="toggle-label-block" style={{ flex: 1 }}>
            <div className="ti">Run agents in worktrees</div>
            <div className="sub">Each task gets its own git worktree. Recommended — isolates per-task changes from the main checkout.</div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Default validation commands"
        description="Pre-fills new tasks' validation step. Empty = skip that kind."
      >
        {(Object.keys(draft.draft.validation) as Array<keyof WorkspaceDraft['validation']>).map((kind) => (
          <div key={kind} className="field">
            <label>{kind[0].toUpperCase() + kind.slice(1)}</label>
            <input
              className="field-input mono"
              value={draft.draft.validation[kind]}
              onChange={(e) => draft.patch({ validation: { ...draft.draft.validation, [kind]: e.target.value } })}
              placeholder={kind === 'install' ? 'pnpm install' : kind === 'test' ? 'pnpm test' : `<${kind} command>`}
              disabled={draft.saving}
              style={{ fontSize: 12 }}
            />
          </div>
        ))}
      </SettingsCard>

      <SaveBar draft={draft} />
    </div>
  );
}
