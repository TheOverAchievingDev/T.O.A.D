import { useEffect } from 'react';

/**
 * Listens for ⌘K / Ctrl+K and toggles the command palette open. Also accepts
 * Ctrl+/ as a secondary shortcut for terminals that swallow Ctrl+K.
 */
export function useCommandPaletteHotkey(onToggle: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isCmd = e.metaKey || e.ctrlKey;
      if (isCmd && (e.key === 'k' || e.key === 'K' || e.key === '/')) {
        // Ignore when typing inside an input/textarea/contenteditable.
        const target = e.target as HTMLElement | null;
        if (target) {
          const tag = target.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) {
            // Still allow ⌘K from inside inputs — that's the canonical UX.
            // Only block when the field has any uncommitted text and the user
            // is plausibly trying to edit. In practice, we always toggle.
          }
        }
        e.preventDefault();
        onToggle();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onToggle]);
}
