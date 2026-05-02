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

const DEFAULT_PROJECTS: ProjectEntry[] = [
  {
    id: 'p_default',
    name: 'signal-ops',
    path: 'C:/Project-TOAD/toad-local',
    lastOpenedAt: new Date().toISOString(),
  },
];

function readPersisted(): PersistedShape {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { projects: DEFAULT_PROJECTS, activeId: DEFAULT_PROJECTS[0]?.id ?? null };
    }
    const parsed = JSON.parse(raw) as Partial<PersistedShape>;
    const projects = Array.isArray(parsed.projects) ? parsed.projects.filter(isProject) : [];
    if (projects.length === 0) {
      return { projects: DEFAULT_PROJECTS, activeId: DEFAULT_PROJECTS[0]?.id ?? null };
    }
    const activeId = typeof parsed.activeId === 'string' && projects.some((p) => p.id === parsed.activeId)
      ? parsed.activeId
      : projects[0]!.id;
    return { projects, activeId };
  } catch {
    return { projects: DEFAULT_PROJECTS, activeId: DEFAULT_PROJECTS[0]?.id ?? null };
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
    let created: ProjectEntry | null = null;
    setState((prev) => {
      const id = nextId(prev.projects);
      const project: ProjectEntry = {
        id,
        name: input.name,
        path: input.path,
        apiBaseUrl: input.apiBaseUrl,
        apiToken: input.apiToken,
        lastOpenedAt: new Date().toISOString(),
      };
      created = project;
      return { projects: [...prev.projects, project], activeId: id };
    });
    // The state update is synchronous from the caller's perspective for our
    // purposes; created is set inside the updater above.
    if (!created) {
      throw new Error('addProject failed to allocate id');
    }
    return created;
  }, []);

  const updateProject = useCallback<UseProjectsResult['updateProject']>((id, patch) => {
    setState((prev) => ({
      ...prev,
      projects: prev.projects.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
  }, []);

  const removeProject = useCallback<UseProjectsResult['removeProject']>((id) => {
    setState((prev) => {
      const next = prev.projects.filter((p) => p.id !== id);
      if (next.length === 0) {
        // Always keep at least one entry so the UI has a valid active.
        const fallback = DEFAULT_PROJECTS[0]!;
        return { projects: [fallback], activeId: fallback.id };
      }
      const activeId = prev.activeId === id ? next[0]!.id : prev.activeId;
      return { projects: next, activeId };
    });
  }, []);

  const active = projects.find((p) => p.id === activeId) ?? projects[0] ?? null;

  return { projects, active, activeId, setActive, addProject, updateProject, removeProject };
}
