import { useMemo, useState } from 'react';
import { roleStyle } from '@/data/roles';
import { Icon } from '@/components/Icon';
import type { Team } from '@/types';

interface RecentProject {
  id: string;
  name: string;
  path: string;
  color: string;
  glyph: string;
  members: string[];
  done: number;
  pending: number;
  progress: number;
  lastActive: string;
  branch: string;
  teams: number;
}

export interface ProjectPickerProps {
  team: Team;
  onOpenTeam?: (projectId: string) => void;
  onCreateTeam: () => void;
  onSelectFolder?: () => void;
}

const RECENT_PROJECTS: RecentProject[] = [
  {
    id: 'ide-test',
    name: 'ide-test',
    path: '~/code/ide-test',
    color: 'oklch(0.68 0.13 45)',
    glyph: 'I',
    members: ['lead', 'alice', 'tom', 'quinn'],
    done: 12,
    pending: 4,
    progress: 0.75,
    lastActive: '2m ago',
    branch: 'feature/transcribe-v2',
    teams: 1,
  },
  {
    id: 'nimbus',
    name: 'nimbus-api',
    path: '~/code/nimbus-api',
    color: 'oklch(0.70 0.13 195)',
    glyph: 'N',
    members: ['lead', 'alice', 'rex'],
    done: 28,
    pending: 2,
    progress: 0.93,
    lastActive: '1h ago',
    branch: 'main',
    teams: 1,
  },
  {
    id: 'atlas',
    name: 'atlas-web',
    path: '~/code/atlas-web',
    color: 'oklch(0.65 0.18 295)',
    glyph: 'A',
    members: ['lead', 'tom', 'quinn', 'dee'],
    done: 6,
    pending: 11,
    progress: 0.35,
    lastActive: 'yesterday',
    branch: 'feature/billing-v3',
    teams: 2,
  },
  {
    id: 'kestrel',
    name: 'kestrel-cli',
    path: '~/work/kestrel-cli',
    color: 'oklch(0.72 0.15 145)',
    glyph: 'K',
    members: ['lead', 'alice'],
    done: 4,
    pending: 0,
    progress: 1,
    lastActive: '3d ago',
    branch: 'main',
    teams: 0,
  },
  {
    id: 'quartz',
    name: 'quartz-docs',
    path: '~/code/quartz-docs',
    color: 'oklch(0.78 0.14 80)',
    glyph: 'Q',
    members: ['lead', 'rex'],
    done: 2,
    pending: 5,
    progress: 0.3,
    lastActive: '5d ago',
    branch: 'feature/diataxis',
    teams: 1,
  },
  {
    id: 'ember',
    name: 'ember-mobile',
    path: '~/code/ember-mobile',
    color: 'oklch(0.65 0.20 25)',
    glyph: 'E',
    members: ['lead', 'tom'],
    done: 0,
    pending: 8,
    progress: 0,
    lastActive: 'just imported',
    branch: 'main',
    teams: 0,
  },
];

export function ProjectPicker({ team, onOpenTeam, onCreateTeam, onSelectFolder }: ProjectPickerProps) {
  const [query, setQuery] = useState('');
  const [launchBanner, setLaunchBanner] = useState(true);

  const filtered = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return RECENT_PROJECTS;
    const lowered = trimmed.toLowerCase();
    return RECENT_PROJECTS.filter((project) => (
      project.name.toLowerCase().includes(lowered) || project.path.toLowerCase().includes(lowered)
    ));
  }, [query]);

  return (
    <div className="picker">
      {launchBanner && (
        <div className="picker-banner">
          <div className="picker-banner-left">
            <span className="status-dot live" style={{ marginRight: 8 }} />
            <div>
              <div className="picker-banner-title">Provisioning <strong>signal-ops</strong></div>
              <div className="picker-banner-sub mono">members joining - 3 of 5 ready - 14s elapsed</div>
            </div>
          </div>
          <div className="picker-banner-progress">
            <div className="picker-banner-bar"><span style={{ width: '62%' }} /></div>
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="btn btn-sm btn-ghost" onClick={() => onOpenTeam?.('signal-ops')}>
              Open workspace
            </button>
            <button className="icon-btn" onClick={() => setLaunchBanner(false)} title="Dismiss">
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>
      )}

      <div className="picker-hero">
        <div className="picker-eyebrow">Workspace</div>
        <h1>Where shall we work today?</h1>
        <p className="picker-lede">
          Pick a recent project, open a folder, or spin up a fresh team. Teams pin to the left tab
          strip once running.
        </p>
        <div className="picker-search-row">
          <div className="picker-search">
            <Icon name="search" size={14} className="picker-search-icon" />
            <input
              className="picker-search-input"
              placeholder="Search projects, teams, or paths..."
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <span className="picker-search-kbd">
              <span className="kbd">Ctrl</span><span className="kbd">K</span>
            </span>
          </div>
          <button className="btn" onClick={onSelectFolder}>
            <Icon name="folder" size={13} /> Select folder
          </button>
          <button className="btn btn-primary" onClick={onCreateTeam}>
            <Icon name="plus" size={13} /> New team
          </button>
        </div>
      </div>

      <div className="picker-section">
        <div className="picker-section-head">
          <h2>Recent projects</h2>
          <div className="picker-section-tools">
            <span className="dim mono" style={{ fontSize: 11 }}>
              {filtered.length} of {RECENT_PROJECTS.length}
            </span>
            <div className="seg" style={{ marginLeft: 8 }}>
              <button className="active">Recent</button>
              <button>Active</button>
              <button>All</button>
            </div>
          </div>
        </div>

        <div className="picker-grid">
          <button className="picker-card picker-card-add" onClick={onSelectFolder}>
            <div className="picker-card-add-icon"><Icon name="folder" size={20} /></div>
            <div>
              <div className="picker-card-h">Select folder...</div>
              <div className="picker-card-sub">Add another project root</div>
            </div>
          </button>

          {filtered.map((project) => (
            <button key={project.id} className="picker-card" onClick={() => onOpenTeam?.(project.id)}>
              <div className="picker-card-head">
                <div
                  className="picker-card-glyph"
                  style={{
                    background: `color-mix(in oklch, ${project.color} 22%, var(--bg-panel))`,
                    color: project.color,
                    borderColor: `color-mix(in oklch, ${project.color} 40%, transparent)`,
                  }}
                >
                  {project.glyph}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="picker-card-name">{project.name}</div>
                  <div className="picker-card-path mono">{project.path}</div>
                </div>
                {project.teams > 0 && (
                  <span className="chip" style={{ fontSize: 10 }}>
                    {project.teams} team{project.teams !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              <div className="picker-card-stats">
                <span><span className="mono" style={{ color: 'var(--ok)' }}>{project.done}</span> done</span>
                <span style={{ color: 'var(--fg-dim)' }}>/</span>
                <span>
                  <span className="mono" style={{ color: project.pending > 0 ? 'var(--warn)' : 'var(--fg-dim)' }}>
                    {project.pending}
                  </span>
                  {' '}pending
                </span>
                <span style={{ color: 'var(--fg-dim)', marginLeft: 'auto' }}>{project.lastActive}</span>
              </div>

              <div className="picker-card-bar">
                <span style={{ width: `${project.progress * 100}%`, background: project.color }} />
              </div>

              <div className="picker-card-foot">
                <div className="picker-card-members">
                  {project.members.slice(0, 4).map((memberId, index) => {
                    const member = team.members.find((candidate) => candidate.id === memberId);
                    return member ? (
                      <span
                        key={memberId}
                        className="picker-member-avatar"
                        style={{ ...roleStyle(member.role), zIndex: 10 - index }}
                      >
                        {member.avatar}
                      </span>
                    ) : null;
                  })}
                  {project.members.length > 4 && (
                    <span className="picker-member-avatar picker-member-overflow">
                      +{project.members.length - 4}
                    </span>
                  )}
                </div>
                <span className="mono dim" style={{ fontSize: 10.5, marginLeft: 'auto' }}>
                  <Icon name="git" size={10} /> {project.branch}
                </span>
              </div>
            </button>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 24 }}>
          <button className="btn btn-ghost">Load more</button>
        </div>
      </div>
    </div>
  );
}
