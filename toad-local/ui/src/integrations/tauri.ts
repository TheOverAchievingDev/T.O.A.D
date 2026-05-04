/**
 * Thin wrapper around Tauri APIs. Falls back to no-op behavior when running
 * in a plain browser (e.g. `npm run dev` outside the Tauri shell) so the UI
 * keeps working — the user just won't see native folder pickers.
 */

import { open } from '@tauri-apps/plugin-dialog';
import { open as openExternal } from '@tauri-apps/plugin-shell';
import { invoke } from '@tauri-apps/api/core';

function isTauri(): boolean {
  // Tauri 2 exposes a runtime marker on window.
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export interface PickedProject {
  path: string;
  name: string;
}

/**
 * Open a native folder picker and tell the Rust shell to swap the
 * orchestrator over to the selected directory. Returns the picked folder
 * info on success, null when the user cancels or we're not in Tauri.
 */
export async function pickAndSwitchProjectFolder(): Promise<PickedProject | null> {
  if (!isTauri()) {
    // Browser dev mode — fall back to a prompt() so contributors can still
    // exercise the registry path without booting Tauri.
    const path = window.prompt(
      'Tauri folder picker is only available in the desktop shell. Paste an absolute project path here:',
      '',
    );
    if (!path || !path.trim()) return null;
    return { path: path.trim(), name: deriveName(path.trim()) };
  }

  const selected = await open({
    directory: true,
    multiple: false,
    title: 'Select a project folder',
  });
  if (!selected || typeof selected !== 'string') return null;

  await invoke<string>('switch_project', { projectPath: selected });
  return { path: selected, name: deriveName(selected) };
}

/** Read the saved active-project path from the Tauri shell, if any. */
export async function getSavedProjectPath(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const result = await invoke<string | null>('get_active_project');
    return typeof result === 'string' && result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

/** Clear the Tauri-saved active-project path (used by the legacy
 *  signal-ops migration). */
export async function clearSavedProjectPath(): Promise<void> {
  if (!isTauri()) return;
  try {
    await invoke('switch_project', { projectPath: '' });
  } catch {
    // not in Tauri or already cleared — non-fatal
  }
}

/** Open a URL in the user's default browser. Uses the Tauri shell plugin
 *  in the desktop app; falls back to window.open in plain browser dev. */
export async function openUrlInBrowser(url: string): Promise<void> {
  if (isTauri()) {
    try {
      await openExternal(url);
      return;
    } catch {
      // fall through to window.open as a last resort
    }
  }
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

function deriveName(path: string): string {
  // Pick the last non-empty path segment as a default project name.
  const cleaned = path.replace(/[\\/]+$/, '');
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}
