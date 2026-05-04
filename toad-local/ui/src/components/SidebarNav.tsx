import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export type SidebarKey =
  | 'workspace'
  | 'foundry'
  | 'tasks'
  | 'runtimes'
  | 'approvals'
  | 'drift'
  | 'costs'
  | 'diagnostics'
  | 'settings';

export interface SidebarNavItem {
  key: SidebarKey;
  label: string;
  icon: IconName;
  badge?: number;
}

interface SidebarNavProps {
  active: SidebarKey;
  onSelect: (key: SidebarKey) => void;
  pendingApprovals?: number;
  topItems?: SidebarNavItem[];
  bottomItems?: SidebarNavItem[];
  /** Optional content rendered at the very top, above the nav (e.g. logo). */
  header?: ReactNode;
}

const DEFAULT_TOP: SidebarNavItem[] = [
  { key: 'workspace', label: 'Workspace', icon: 'layers' },
  { key: 'foundry', label: 'Foundry', icon: 'sparkle' },
  { key: 'tasks', label: 'Tasks', icon: 'kanban' },
  { key: 'runtimes', label: 'Runtimes', icon: 'cpu' },
  { key: 'approvals', label: 'Approvals', icon: 'check' },
  { key: 'drift', label: 'Drift', icon: 'eye' },
  { key: 'costs', label: 'Costs', icon: 'sparkle' },
  { key: 'diagnostics', label: 'Diagnostics', icon: 'info' },
];

const DEFAULT_BOTTOM: SidebarNavItem[] = [
  { key: 'settings', label: 'Settings', icon: 'settings' },
];

export function SidebarNav({
  active,
  onSelect,
  pendingApprovals = 0,
  topItems = DEFAULT_TOP,
  bottomItems = DEFAULT_BOTTOM,
  header,
}: SidebarNavProps) {
  const renderItem = (item: SidebarNavItem) => {
    const isActive = item.key === active;
    const badge = item.key === 'approvals' && pendingApprovals > 0
      ? pendingApprovals
      : item.badge;
    return (
      <button
        key={item.key}
        type="button"
        title={item.label}
        className={`sb-nav-item ${isActive ? 'active' : ''}`}
        onClick={() => onSelect(item.key)}
      >
        <span className="sb-nav-icon">
          <Icon name={item.icon} size={16} />
          {badge !== undefined && badge > 0 && (
            <span className="sb-nav-badge">{badge > 99 ? '99+' : badge}</span>
          )}
        </span>
        <span className="sb-nav-label">{item.label}</span>
      </button>
    );
  };

  return (
    <nav className="sb-nav" aria-label="Main navigation">
      {header && <div className="sb-nav-header">{header}</div>}
      <div className="sb-nav-group">{topItems.map(renderItem)}</div>
      <div className="sb-nav-spacer" />
      <div className="sb-nav-group">{bottomItems.map(renderItem)}</div>
    </nav>
  );
}
