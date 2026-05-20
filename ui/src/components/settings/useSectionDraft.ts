import { useEffect, useMemo, useState } from 'react';
import { useSettings, type SettingsPayload } from '@/hooks/useSettings';

export type SettingsScope = 'global' | 'project';

export interface SectionDraft<T extends object> {
  draft: T;
  setDraft: (next: T) => void;
  patch: (partial: Partial<T>) => void;
  dirty: boolean;
  save: () => Promise<void>;
  revert: () => void;
  loading: boolean;
  saving: boolean;
  error: string | null;
  source?: 'global' | 'project';
  paths: { global: string | null; project: string | null };
}

interface UseSectionDraftArgs<T extends object> {
  /** Top-level key in the settings file (e.g. 'workspace', 'notifications'). */
  section: string;
  /** Where saves go. */
  scope: SettingsScope;
  /** Defaults applied on top of whatever is on disk. */
  defaults: T;
}

/** Generic "edit one settings section" hook. Handles load → draft → save. */
export function useSectionDraft<T extends object>({
  section, scope, defaults,
}: UseSectionDraftArgs<T>): SectionDraft<T> {
  const { settings, paths, loading, error: loadError, setSection } = useSettings();
  const [draft, setDraftState] = useState<T>(defaults);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  const persisted = useMemo<T>(() => {
    const remote = (settings as SettingsPayload)[section];
    if (remote && typeof remote === 'object' && !Array.isArray(remote)) {
      return { ...defaults, ...(remote as Partial<T>) };
    }
    return defaults;
    // we deliberately don't depend on `defaults` ref-identity (object literal at call site)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, section]);

  // Sync the persisted value into the local draft only on first load (or
  // when the source changes). After that, user edits stay in the draft until
  // they revert or save.
  useEffect(() => {
    if (loading) return;
    if (!hydrated) {
      setDraftState(persisted);
      setHydrated(true);
    }
  }, [loading, persisted, hydrated]);

  const dirty = useMemo(
    () => JSON.stringify(persisted) !== JSON.stringify(draft),
    [persisted, draft],
  );

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await setSection({ scope, section, value: draft as Record<string, unknown> });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save');
      throw err;
    } finally {
      setSaving(false);
    }
  }

  function revert() {
    setDraftState(persisted);
    setSaveError(null);
  }

  function patch(partial: Partial<T>) {
    setDraftState((prev) => ({ ...prev, ...partial }));
  }

  return {
    draft,
    setDraft: setDraftState,
    patch,
    dirty,
    save,
    revert,
    loading,
    saving,
    error: saveError ?? loadError,
    source: settings._sources?.[section],
    paths,
  };
}
