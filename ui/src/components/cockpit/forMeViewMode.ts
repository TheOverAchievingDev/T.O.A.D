export type ForMeViewMode = 'timeline' | 'flow';

export const DEFAULT_FOR_ME_VIEW_MODE: ForMeViewMode = 'timeline';
export const FOR_ME_VIEW_MODE_STORAGE_KEY = 'cockpit.forMe.viewMode';

export function normalizeForMeViewMode(value: unknown): ForMeViewMode {
  return value === 'flow' || value === 'timeline' ? value : DEFAULT_FOR_ME_VIEW_MODE;
}
