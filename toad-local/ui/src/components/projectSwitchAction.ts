/**
 * IDE-0: the titlebar project-dropdown quick-switch action.
 *
 * Mirrors App.tsx's already-correct `openRegisteredProject` switch
 * sequence (resolve project → respawn the backend sidecar via
 * `switchToProjectPath` → mark active → refresh team-scoped state) so
 * the WITH me file tree/editor follow the active project. It
 * deliberately does NOT navigate the screen — a titlebar quick-switch
 * should not move the user off whatever screen they are on.
 *
 * Pure + injected-deps so it is unit-testable without React (the
 * repo's standard `ui/src/components/*.ts` + `ui/test/*.test.mjs`
 * pattern).
 */

export interface ProjectSwitchDeps {
  /** The registry's projects (only id + path are used here). */
  projects: ReadonlyArray<{ id: string; path: string }>;
  /**
   * integrations/tauri.ts switchToProjectPath — respawns the sidecar.
   * Resolves to a truthy object on success, null/falsy when the
   * switch was aborted.
   */
  switchToProjectPath: (targetPath: string) => Promise<object | null>;
  /** useProjects().setActive. */
  setActive: (id: string) => void;
  /** App.tsx's refreshAfterProjectSwitch (clear-then-repopulate). */
  refreshAfterProjectSwitch: () => void;
  /** Optional error sink (App.tsx logs via console.error). */
  onError?: (err: unknown) => void;
}

/**
 * Returns true when the active project actually changed (sidecar
 * respawned + state refreshed), false for unknown path / aborted
 * switch / error.
 */
export async function switchToRegisteredProjectByPath(
  deps: ProjectSwitchDeps,
  targetPath: string,
): Promise<boolean> {
  const found = deps.projects.find((p) => p.path === targetPath);
  if (!found) return false;
  try {
    const switched = await deps.switchToProjectPath(targetPath);
    if (!switched) return false;
    deps.setActive(found.id);
    deps.refreshAfterProjectSwitch();
    return true;
  } catch (err) {
    deps.onError?.(err);
    return false;
  }
}
