import { useCallback, useEffect, useState } from 'react';

export interface ProjectEntry {
  /** Stable client-side id; doubles as React key. */
  id: string;
  /** Display name shown in the titlebar tab. */
  name: string;
  /** Filesystem path the orchestrator opened (informational; the running API
   * already has its DB pinned via TOAD_DB_PATH). */
  path: string;
  /** Optional override base URL; when omitted the global VITE_TOAD_API_BASE_URL is used. */
  apiBaseUrl?: string;
  /** Optional bearer token override for this project. */
  apiToken?: string;
  /** When the user last opened this project. ISO timestamp. */
  lastOpenedAt: string;
}

interface PersistedShape {
  projects: ProjectEntry[];
  activeId: string | null;
}

const STORAGE_KEY = 'toad.projects';

/** Returns true if the entry is the legacy hardcoded default that earlier
 *  builds of useProjects seeded — should be auto-purged on next launch. */
function isLegacyDefault(p: ProjectEntry): boolean {
  return (
    p.id === 'p_default'
    && p.name === 'signal-ops'
    && (p.path === 'C:/Project-TOAD/toad-local' || p.path === 'C:\\Project-TOAD\\toad-local')
  );
}

function readPersisted(): PersistedShape {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { projects: [], activeId: null };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    const allProjects = Array.isArray(parsed.projects) ? parsed.projects.filter(isProject) : [];
    // Migration: strip the legacy `p_default` / `signal-ops` entry that
    // earlier builds hardcoded as a starter project. Once removed, the
    // welcome screen empty-state takes over.
    const projects = allProjects.filter((p) => !isLegacyDefault(p));
    if (projects.length === 0) {
      return { projects: [], activeId: null };
    }
    const activeId = typeof parsed.activeId === 'string' && projects.some((p) => p.id === parsed.activeId)
      ? parsed.activeId
      : projects[0]!.id;
    return { projects, activeId };
  } catch {
    return { projects: [], activeId: null };
  }
}

function isProject(value: unknown): value is ProjectEntry {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.path === 'string';
}

function nextId(existing: ProjectEntry[]): string {
  let n = existing.length + 1;
  while (existing.some((p) => p.id === `p_${n}`)) n += 1;
  return `p_${n}`;
}

export interface UseProjectsResult {
  projects: ProjectEntry[];
  active: ProjectEntry | null;
  activeId: string | null;
  setActive: (id: string) => void;
  addProject: (input: { name: string; path: string; apiBaseUrl?: string; apiToken?: string }) => ProjectEntry;
  updateProject: (id: string, patch: Partial<Omit<ProjectEntry, 'id'>>) => void;
  removeProject: (id: string) => void;
}

/**
 * Local-storage-backed registry of TOAD projects the user has opened. Each
 * project corresponds to one `.toad/toad.db` and (optionally) its own running
 * API instance — switching projects swaps the active id in state, and consumer
 * code can re-point its API client base URL accordingly.
 *
 * In Phase 2 we don't actually swap the running API yet; that's Phase 3 work.
 * The registry lays the groundwork: titlebar tabs become real, add/remove
 * persists, and the active selection is durable.
 */
export function useProjects(): UseProjectsResult {
  const [{ projects, activeId }, setState] = useState<PersistedShape>(() => readPersisted());

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ projects, activeId }));
    } catch {
      /* ignore quota errors */
    }
  }, [projects, activeId]);

  const setActive = useCallback((id: string) => {
    setState((prev) => {
      if (!prev.projects.some((p) => p.id === id)) return prev;
      return {
        ...prev,
        activeId: id,
        projects: prev.projects.map((p) =>
          p.id === id ? { ...p, lastOpenedAt: new Date().toISOString() } : p,
        ),
      };
    });
  }, []);

  const addProject = useCallback<UseProjectsResult['addProject']>((input) => {
    // Compute the new entry against the *latest* projects list synchronously
    // by reading from a setState callback BUT also build it outside so we
    // can return the value from this call. The functional setState may not
    // run synchronously under React 18+ batching/strict mode, so capturing
    // `created` from inside the updater is unreliable.
    //
    // Instead: pull a snapshot, allocate the id, then schedule the state
    // update with the same value. Multiple back-to-back calls within the
    // same render tick still get unique ids because nextId reads from
    // both the snapshot and any pending entries via the array length
    // monotone — the worst case is two adds in one tick produce p_2 + p_2
    // collisions, which we resolve in the updater by re-allocating if a
    // conflict is detected.
    const snapshot = projects;
    const baseId = nextId(snapshot);
    const project: ProjectEntry = {
      id: baseId,
      name: input.name,
      path: input.path,
      apiBaseUrl: input.apiBaseUrl,
      apiToken: input.apiToken,
      lastOpenedAt: new Date().toISOString(),
    };
    setState((prev) => {
      // Resolve id conflicts on the actual latest state (in case another
      // addProject just landed in the same tick).
      const id = prev.projects.some((p) => p.id === project.id) ? nextId(prev.projects) : project.id;
      const finalProject: ProjectEntry = { ...project, id };
      return { projects: [...prev.projects, finalProject], activeId: id };
    });
    return project;
  }, [projects]);

  const updateProject = useCallback<UseProjectsResult['updateProject']>((id, patch) => {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
  }, []);

  const removeProject = useCallback<UseProjectsResult['removeProject']>((id) => {
    setState((prev) => {
      const next = prev.projects.filter((p) => p.id !== id);
      const activeId =
        next.length === 0
          ? null
          : (prev.activeId === id ? next[0]!.id : prev.activeId);
      return { projects: next, activeId };
    });
  }, []);

  const active = projects.find((p) => p.id === activeId) ?? projects[0] ?? null;

  return { projects, active, activeId, setActive, addProject, updateProject, removeProject };
}
