import { useCallback, useEffect, useState } from 'react';
import type { Tweaks } from '@/types';

const STORAGE_KEY = 'toad.tweaks';

export const TWEAK_DEFAULTS: Tweaks = {
  theme: 'dark',
  density: 'comfy',
  layout: 'org',
  cardVariant: 'detail',
  screen: 'cockpit',
  agentInbox: '',
  showProviders: false,
  showNotifs: false,
  showApprovals: false,
  showRuntimes: false,
  showDiagnostics: false,
  showTweaks: false,
  developerMode: false,
};

function readStored(): Partial<Tweaks> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as Partial<Tweaks>;
  } catch {
    /* ignore */
  }
  return {};
}

export function useTweaks(initial: Tweaks = TWEAK_DEFAULTS) {
  const [tweaks, setTweaks] = useState<Tweaks>(() => ({ ...initial, ...readStored() }));

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tweaks));
    } catch {
      /* ignore quota errors */
    }
  }, [tweaks]);

  const setTweak = useCallback(<K extends keyof Tweaks>(key: K, value: Tweaks[K]) => {
    setTweaks((prev) => ({ ...prev, [key]: value }));
  }, []);

  return [tweaks, setTweak] as const;
}
