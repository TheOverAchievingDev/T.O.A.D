import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import type { ProjectEntry } from '@/hooks/useProjects';

export interface ProjectPickerProps {
  projects: ProjectEntry[];
  activeId: string | null;
  onOpenProject: (projectId: string) => void;
  onCreateTeam: () => void;
  onSelectFolder?: () => void;
  /** "Create new project" — routes to the Foundry screen so the user can
   *  draft founding docs with the AI before picking a folder. The folder
   *  picker happens later inside the Foundry "Create team" flow. */
  onStartNewProject?: () => void;
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const diff = Date.now() - then;
  const s = Math.max(1, Math.round(diff / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

function pickGlyph(name: string): string {
  const s = name.trim();
  return s.length > 0 ? s[0].toUpperCase() : '?';
}

export function ProjectPicker({
  projects,
  activeId,
  onOpenProject,
  onCreateTeam,
  onSelectFolder,
  onStartNewProject,
}: ProjectPickerProps) {
  const [query, setQuery] = useState('');

  const sorted = useMemo(() => {
    return [...projects].sort((a, b) =>
      (b.lastOpenedAt || '').localeCompare(a.lastOpenedAt || ''),
    );
  }, [projects]);

  const filtered = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return sorted;
    const lowered = trimmed.toLowerCase();
    return sorted.filter((project) => (
      project.name.toLowerCase().includes(lowered) || project.path.toLowerCase().includes(lowered)
    ));
  }, [query, sorted]);

  const empty = projects.length === 0;

  return (
    <div className="picker">
      <div className="picker-hero">
        <div className="picker-eyebrow">Workspace</div>
        <h1>{empty ? 'Welcome to Symphony AI' : 'Where shall we work today?'}</h1>
        <p className="picker-lede">
          {empty
            ? 'Open a folder to point Symphony AI at the codebase you want to work in. We\'ll create a `.toad/` directory there to track tasks, teams, and runs.'
            : 'Pick a recent project, open a folder, or spin up a fresh team. Teams pin to the left tab strip once running.'}
        </p>
        <div className="picker-search-row">
          {!empty && (
            <div className="picker-search">
              <Icon name="search" size={14} className="picker-search-icon" />
              <input
                className="picker-search-input"
                placeholder="Search projects or paths..."
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <span className="picker-search-kbd">
                <span className="kbd">Ctrl</span><span className="kbd">K</span>
              </span>
            </div>
          )}
          {onStartNewProject && (
            <button className="btn btn-primary" onClick={onStartNewProject}>
              <Icon name="sparkle" size={13} /> Create new project
            </button>
          )}
          <button
            className={onStartNewProject ? 'btn' : 'btn btn-primary'}
            onClick={onSelectFolder}
          >
            <Icon name="folder" size={13} /> {empty ? 'Open existing folder' : 'Open folder'}
          </button>
          {!empty && (
            <button className="btn" onClick={onCreateTeam}>
              <Icon name="plus" size={13} /> New team
            </button>
          )}
        </div>
      </div>

      {empty ? (
        <div
          className="picker-section"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
            paddingTop: 32,
            color: 'var(--fg-muted)',
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 12,
              background: 'rgba(255,255,255,0.04)',
              border: '1px dashed var(--border-soft, rgba(255,255,255,0.10))',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <Icon name="folder" size={24} />
          </div>
          <div style={{ fontSize: 13, textAlign: 'center', maxWidth: 520, lineHeight: 1.5 }}>
            <strong style={{ color: 'var(--accent)' }}>Create new project</strong> takes you to the Foundry —
            chat with the AI to draft a brief, tasks, and architecture, then pick a folder to materialize
            the project into.
            <br /><br />
            <strong>Open existing folder</strong> points Symphony AI at a codebase you already have.
            The folder becomes the orchestrator's working directory — tasks, teams, and runtime events
            live in <span className="mono">.toad/toad.db</span> inside it.
          </div>
        </div>
      ) : (
        <div className="picker-section">
          <div className="picker-section-head">
            <h2>Recent projects</h2>
            <div className="picker-section-tools">
              <span className="dim mono" style={{ fontSize: 11 }}>
                {filtered.length} of {sorted.length}
              </span>
            </div>
          </div>

          <div className="picker-grid">
            <button className="picker-card picker-card-add" onClick={onSelectFolder}>
              <div className="picker-card-add-icon"><Icon name="folder" size={20} /></div>
              <div>
                <div className="picker-card-h">Open folder…</div>
                <div className="picker-card-sub">Add another project root</div>
              </div>
            </button>

            {filtered.map((project) => {
              const isActive = project.id === activeId;
              return (
                <button
                  key={project.id}
                  className={`picker-card${isActive ? ' picker-card-active' : ''}`}
                  onClick={() => onOpenProject(project.id)}
                >
                  <div className="picker-card-head">
                    <div
                      className="picker-card-glyph"
                      style={{
                        background: 'rgba(255,255,255,0.04)',
                        color: 'var(--accent)',
                        borderColor: 'var(--border-soft, rgba(255,255,255,0.10))',
                      }}
                    >
                      {pickGlyph(project.name)}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="picker-card-name">{project.name}</div>
                      <div className="picker-card-path mono">{project.path}</div>
                    </div>
                    {isActive && (
                      <span className="chip" style={{ fontSize: 10 }}>active</span>
                    )}
                  </div>
                  <div className="picker-card-stats">
                    <span style={{ color: 'var(--fg-dim)', marginLeft: 'auto' }}>
                      Last opened {relativeTime(project.lastOpenedAt)}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
