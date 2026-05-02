import { Icon } from '../Icon';
import type { SectionDraft } from './useSectionDraft';

interface SectionShellProps<T extends object> {
  draft: SectionDraft<T>;
}

export function SaveBar<T extends object>({ draft }: SectionShellProps<T>) {
  return (
    <>
      {draft.error && (
        <div
          style={{
            marginTop: 12, padding: '8px 12px',
            background: 'oklch(0.30 0.08 25 / 0.4)', border: '1px solid oklch(0.55 0.18 25 / 0.4)',
            borderRadius: 6, color: 'oklch(0.85 0.10 25)', fontSize: 12,
          }}
        >
          {draft.error}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button type="button" className="btn btn-ghost" onClick={draft.revert} disabled={!draft.dirty || draft.saving}>
          Revert
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void draft.save()} disabled={!draft.dirty || draft.saving}>
          <Icon name="check" size={11} /> {draft.saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </>
  );
}

export function SectionMeta<T extends object>({ draft }: SectionShellProps<T>) {
  if (draft.loading) return <div className="dim" style={{ fontSize: 12, marginBottom: 12 }}>Loading…</div>;
  if (!draft.paths.global && !draft.paths.project) return null;
  return (
    <div className="dim mono" style={{ fontSize: 11, marginBottom: 12 }}>
      {draft.source && <>Currently from: <strong>{draft.source}</strong> · </>}
      Global: {draft.paths.global ?? 'n/a'}{draft.paths.project ? ` · Project: ${draft.paths.project}` : ''}
    </div>
  );
}
