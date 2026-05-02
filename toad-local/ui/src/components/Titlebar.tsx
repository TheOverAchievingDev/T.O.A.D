import type { Runtime } from '@/types';
import type { ProjectEntry } from '@/hooks/useProjects';
import { Icon } from './Icon';

interface TitlebarProps {
  theme: 'dark' | 'light';
  runtimes: Runtime[];
  projects: ProjectEntry[];
  activeProjectId: string | null;
  onSelectProject: (id: string) => void;
  onAddProject: () => void;
  onCloseProject?: (id: string) => void;
  onToggleTheme: () => void;
  onCreateTeam: () => void;
  onOpenProviders: () => void;
  onOpenNotifs: () => void;
  onOpenApprovals: () => void;
  onOpenDiagnostics?: () => void;
  onToggleTweaks?: () => void;
  onOpenCommandPalette?: () => void;
  pendingApprovalCount?: number;
}

export function Titlebar({
  theme, runtimes, projects, activeProjectId, onSelectProject, onAddProject, onCloseProject,
  onToggleTheme, onCreateTeam, onOpenProviders, onOpenNotifs,
  onOpenApprovals, onOpenDiagnostics, onToggleTweaks, onOpenCommandPalette,
  pendingApprovalCount = 0,
}: TitlebarProps) {
  const live = runtimes.filter((r) => r.status === 'live').length;
  const activeProject = projects.find((p) => p.id === activeProjectId) ?? projects[0] ?? null;

  return (
    <div className="titlebar">
      <div className="titlebar-left">
        <div className="titlebar-logo">T</div>
        <div className="titlebar-tabs">
          {projects.map((p) => {
            const isActive = p.id === (activeProjectId ?? activeProject?.id);
            return (
              <button
                key={p.id}
                type="button"
                className={`tab ${isActive ? 'active' : ''}`}
                onClick={() => onSelectProject(p.id)}
                title={p.path}
              >
                <span
                  className="dot"
                  style={{
                    background: isActive ? 'var(--clay, #d97757)' : 'var(--fg-dim, rgba(255,255,255,0.3))',
                  }}
                />
                {p.name}
                {projects.length > 1 && onCloseProject && (
                  <span
                    role="button"
                    aria-label={`Remove ${p.name}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseProject(p.id);
                    }}
                    style={{ opacity: 0.45, marginLeft: 4, display: 'inline-flex' }}
                  >
                    <Icon name="x" size={11} />
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            className="tab"
            style={{ color: 'var(--fg-dim)' }}
            onClick={onAddProject}
            title="Add project"
          >
            <Icon name="plus" size={11} />
          </button>
        </div>
      </div>
      <button
        type="button"
        className="titlebar-title mono"
        onClick={onOpenCommandPalette}
        title="Open command palette (⌘K / Ctrl+K)"
        style={{
          background: 'transparent',
          border: '1px solid var(--border-soft, rgba(255,255,255,0.08))',
          borderRadius: 6,
          padding: '3px 10px',
          color: 'var(--fg-muted, rgba(255,255,255,0.55))',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11.5,
        }}
      >
        <Icon name="search" size={11} />
        <span>
          TOAD{activeProject ? ` · ${activeProject.name}` : ''}
        </span>
        <span style={{
          marginLeft: 8,
          fontSize: 9.5,
          padding: '1px 4px',
          borderRadius: 3,
          background: 'rgba(255,255,255,0.06)',
          color: 'var(--fg-dim, rgba(255,255,255,0.4))',
          letterSpacing: '0.05em',
        }}>
          ⌘K
        </span>
      </button>
      <div className="titlebar-right">
        <button
          className="runtime-pill"
          title={`${live} live · ${runtimes.length} total runtimes`}
          onClick={() => window.dispatchEvent(new CustomEvent('toad:open-runtimes'))}
        >
          <span className="dot" />
          <span><span className="num">{live}</span> / {runtimes.length}</span>
          <span style={{ color: 'var(--fg-dim)' }}>runtimes</span>
        </button>
        <button className="icon-btn" onClick={onCreateTeam} title="New team"><Icon name="plus" size={14} /></button>
        <button
          className="icon-btn"
          title={`Approvals (${pendingApprovalCount} pending)`}
          onClick={onOpenApprovals}
          style={{ position: 'relative' }}
        >
          <Icon name="check" size={14} />
          {pendingApprovalCount > 0 && (
            <span
              style={{
                position: 'absolute',
                top: 2,
                right: 2,
                minWidth: 12,
                height: 12,
                padding: '0 3px',
                borderRadius: 6,
                background: 'var(--err)',
                color: '#fff',
                fontSize: 8,
                fontWeight: 700,
                lineHeight: '12px',
                textAlign: 'center',
              }}
            >
              {pendingApprovalCount}
            </span>
          )}
        </button>
        <button className="icon-btn" title="Notifications" onClick={onOpenNotifs} style={{ position: 'relative' }}>
          <Icon name="bell" size={14} />
          <span style={{ position: 'absolute', top: 4, right: 4, width: 7, height: 7, borderRadius: '50%', background: 'var(--err)' }} />
        </button>
        <button className="icon-btn" title="Members"><Icon name="users" size={14} /></button>
        <button className="icon-btn" title="Providers" onClick={onOpenProviders}><Icon name="cpu" size={14} /></button>
        <button className="icon-btn" title="Repository"><Icon name="github" size={14} /></button>
        <button className="icon-btn" onClick={onToggleTheme} title="Toggle theme">
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={14} />
        </button>
        {onOpenDiagnostics && (
          <button className="icon-btn" title="Diagnostics" onClick={onOpenDiagnostics}>
            <Icon name="info" size={14} />
          </button>
        )}
        <button
          className="icon-btn"
          title={onToggleTweaks ? 'Toggle tweaks panel' : 'Settings'}
          onClick={onToggleTweaks}
        >
          <Icon name="settings" size={14} />
        </button>
        <div className="win-controls">
          <button className="icon-btn"><Icon name="minimize" size={12} /></button>
          <button className="icon-btn"><Icon name="maxBtn" size={11} /></button>
          <button className="icon-btn close"><Icon name="close" size={12} /></button>
        </div>
      </div>
    </div>
  );
}
