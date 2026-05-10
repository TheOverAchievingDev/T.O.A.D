import type { ReactNode } from 'react';
import { Icon, type IconName } from '../Icon';

export type SettingsSectionKey =
  | 'general'
  | 'providers'
  | 'foundry'
  | 'plugins'
  | 'github'
  | 'workspace'
  | 'risk'
  | 'mcp'
  | 'notifications'
  | 'advanced'
  | 'about';

export interface SettingsSection {
  key: SettingsSectionKey;
  label: string;
  icon: IconName;
  description?: string;
}

const SECTIONS: SettingsSection[] = [
  { key: 'general', label: 'General', icon: 'settings', description: 'Theme, density, locale.' },
  { key: 'providers', label: 'Providers', icon: 'cpu', description: 'Anthropic, OpenAI, OpenCode.' },
  { key: 'foundry', label: 'Foundry', icon: 'workflow', description: 'Default planning provider for new project plans.' },
  { key: 'plugins', label: 'Plugins', icon: 'layers', description: 'Railway, EAS, Vercel — infrastructure plugins.' },
  { key: 'github', label: 'GitHub', icon: 'github', description: 'Connect a GitHub account for branch + PR ops.' },
  { key: 'workspace', label: 'Workspace', icon: 'folder', description: 'Default project path, worktree behaviour.' },
  { key: 'risk', label: 'Risk policies', icon: 'info', description: 'File and command rules for §14.' },
  { key: 'mcp', label: 'MCP servers', icon: 'workflow', description: 'TOAD’s server + extras.' },
  { key: 'notifications', label: 'Notifications', icon: 'bell', description: 'Toasts, drawer entries, push.' },
  { key: 'advanced', label: 'Advanced', icon: 'terminal', description: 'DB path, port, log level, dev tools.' },
  { key: 'about', label: 'About', icon: 'info', description: 'Version, updates, license.' },
];

interface SettingsLayoutProps {
  active: SettingsSectionKey;
  onSelect: (key: SettingsSectionKey) => void;
  children: ReactNode;
  onClose?: () => void;
}

export function SettingsLayout({ active, onSelect, children, onClose }: SettingsLayoutProps) {
  const activeSection = SECTIONS.find((s) => s.key === active) ?? SECTIONS[0]!;
  return (
    <main className="ws-main settings-screen" style={{ overflow: 'hidden' }}>
      <div className="ws-main-header">
        <div className="team-title">
          <h1>Settings</h1>
          <span className="team-meta mono">· {activeSection.label}</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {onClose && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={onClose}>
              <Icon name="x" size={11} /> Close
            </button>
          )}
        </div>
      </div>

      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: 'grid',
          gridTemplateColumns: '220px 1fr',
          overflow: 'hidden',
        }}
      >
        <nav
          aria-label="Settings sections"
          style={{
            borderRight: '1px solid var(--border-soft, rgba(255,255,255,0.05))',
            padding: '14px 8px',
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 1,
          }}
        >
          {SECTIONS.map((s) => {
            const isActive = s.key === active;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => onSelect(s.key)}
                style={{
                  appearance: 'none',
                  background: isActive ? 'rgba(217, 119, 87, 0.10)' : 'transparent',
                  border: 0,
                  borderLeft: isActive ? '2px solid var(--clay, #d97757)' : '2px solid transparent',
                  color: isActive ? 'var(--fg, #fff)' : 'var(--fg-muted, rgba(255,255,255,0.55))',
                  padding: '8px 10px',
                  textAlign: 'left',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 12.5,
                  fontWeight: isActive ? 600 : 500,
                  borderRadius: '0 6px 6px 0',
                  transition: 'background 0.12s, color 0.12s',
                }}
              >
                <Icon name={s.icon} size={13} />
                <span>{s.label}</span>
              </button>
            );
          })}
        </nav>

        <div
          style={{
            overflow: 'auto',
            padding: '24px 32px 40px',
            background: 'var(--bg-canvas, transparent)',
          }}
        >
          {children}
        </div>
      </div>
    </main>
  );
}

interface SettingsSectionHeaderProps {
  title: string;
  description?: string;
  badge?: string;
}

export function SettingsSectionHeader({ title, description, badge }: SettingsSectionHeaderProps) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>{title}</h2>
        {badge && (
          <span
            className="chip"
            style={{
              fontSize: 10,
              padding: '2px 6px',
              background: 'rgba(217, 119, 87, 0.10)',
              color: 'var(--clay, #d97757)',
              borderColor: 'rgba(217, 119, 87, 0.3)',
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              fontWeight: 600,
            }}
          >
            {badge}
          </span>
        )}
      </div>
      {description && (
        <div className="dim" style={{ fontSize: 12.5, marginTop: 4, lineHeight: 1.5 }}>
          {description}
        </div>
      )}
    </div>
  );
}

interface SettingsCardProps {
  title?: string;
  description?: string;
  children: ReactNode;
}

export function SettingsCard({ title, description, children }: SettingsCardProps) {
  return (
    <div
      style={{
        marginBottom: 20,
        padding: '16px 18px',
        background: 'var(--bg-panel, rgba(255,255,255,0.02))',
        border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
        borderRadius: 10,
      }}
    >
      {title && (
        <div style={{ marginBottom: description ? 4 : 12 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg, #fff)' }}>{title}</div>
        </div>
      )}
      {description && (
        <div className="dim" style={{ fontSize: 12, marginBottom: 12, lineHeight: 1.5 }}>
          {description}
        </div>
      )}
      {children}
    </div>
  );
}

export const SETTINGS_SECTIONS = SECTIONS;
