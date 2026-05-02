import { useEffect } from 'react';

/**
 * Listens for "?" outside of input/textarea/contenteditable contexts and
 * opens the shortcuts modal. Keeping it isolated so the trigger key can
 * change without touching App.tsx.
 */
export function useShortcutsHotkey(onOpen: () => void) {
  useEffect(() => {
    function handler(e: KeyboardEvent) {
      if (e.key !== '?') return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      e.preventDefault();
      onOpen();
    }
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onOpen]);
}
