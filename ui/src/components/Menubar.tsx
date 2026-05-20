import { useEffect, useRef, useState } from 'react';
import type { SidebarKey } from './SidebarNav';
import { Icon } from './Icon';

/**
 * Phase 1 Menubar — sits as the topmost row of the app.
 *
 * Modeled on Cursor's menu structure with the Symphony deviations
 * called out in docs/specs/2026-05-11-ui-re-envisioning-design.md §4:
 *   - View menu surfaces Symphony screens (Cockpit ⌘1 .. Audit ⌘7),
 *     not VS Code-style panel toggles (Explorer, Search, etc.).
 *   - Run menu surfaces team operations (Start/Pause Team, Run Drift,
 *     Approve Pending), not debugger UI (Symphony agents do the work).
 *   - Go menu has "Add Symbol to Agent Inbox" replacing Cursor's
 *     "Add Symbol to Chat".
 *
 * Item-list contents ported from the Claude Design mockup at
 * Reference material/Claude Design Mockup/chrome.jsx so the rendered
 * menus match the approved prototype exactly.
 *
 * Phase 1 scope:
 *   - Screen-jump items (View → Cockpit, View → Foundry, …) call
 *     onNav with a SidebarKey; App.tsx routes them.
 *   - Panel-toggle items (Toggle Sidebar/Bottom/Right Panel) and the
 *     Developer Mode toggle call onAction with a stable action key.
 *   - Items without goto/action are still rendered but no-op on click
 *     (typically text-editing items meaningful only on the Code
 *     screen, which is wired in Phase 2).
 *
 * Click outside the menubar or any open menu closes the menu. Mouse-
 * enter on another menubar item while a menu is open switches the
 * open menu — same pattern as Cursor / VS Code.
 */

export type MenuAction =
  // Panel toggles (View menu)
  | 'sidebar'
  | 'bottom'
  | 'right'
  | 'devmode'
  // Team operations (Run menu)
  | 'team:resume'
  | 'team:pause'
  | 'team:end'
  | 'drift:run'
  | 'validations:run'
  | 'foundry:refine'
  | 'approvals:open'
  // Terminal
  | 'terminal:new'
  // Help
  | 'help:shortcuts'
  | 'help:docs'
  | 'help:feedback'
  | 'help:issue'
  | 'help:about'
  // General
  | 'palette:open'
  | 'goto:picker';

type MenuItemKind = 'row' | 'sep' | 'head';

interface MenuItem {
  kind: MenuItemKind;
  label?: string;
  k?: string;        // keyboard shortcut display string
  check?: boolean;   // render as toggle with check mark when active
  action?: MenuAction;
  goto?: SidebarKey;
  disabled?: boolean; // grayed out, not clickable — visible roadmap
}

const MENUS: Record<string, MenuItem[]> = {
  File: [
    { kind: 'row', label: 'New File', k: '⌘N', disabled: true },
    { kind: 'sep' },
    { kind: 'row', label: 'Open Project Folder…', k: '⌘O', action: 'goto:picker' },
    { kind: 'sep' },
    { kind: 'row', label: 'Save', k: '⌘S', disabled: true },
    { kind: 'row', label: 'Save All', k: '⌘K S', disabled: true },
    { kind: 'sep' },
    { kind: 'row', label: 'Preferences', k: '⌘,', goto: 'settings' },
  ],
  View: [
    { kind: 'row', label: 'Command Palette…', k: '⌘⇧P', action: 'palette:open' },
    { kind: 'sep' },
    { kind: 'head', label: 'Screens' },
    { kind: 'row', label: 'Cockpit',  k: '⌘1', goto: 'workspace' },
    { kind: 'row', label: 'Foundry',  k: '⌘2', goto: 'foundry' },
    { kind: 'row', label: 'Code',     k: '⌘3', goto: 'code' },
    { kind: 'row', label: 'Tasks',    k: '⌘4', goto: 'tasks' },
    { kind: 'row', label: 'Drift',    k: '⌘5', goto: 'drift' },
    { kind: 'row', label: 'Costs',    k: '⌘6', goto: 'costs' },
    { kind: 'row', label: 'Audit',    k: '⌘7', goto: 'diagnostics' },
    { kind: 'row', label: 'Settings', k: '⌘,', goto: 'settings' },
    { kind: 'sep' },
    { kind: 'row', label: 'Toggle Sidebar',      k: '⌘B',   action: 'sidebar' },
    { kind: 'row', label: 'Toggle Bottom Panel', k: '⌘J',   action: 'bottom' },
    { kind: 'row', label: 'Toggle Right Panel',  k: '⌘⌥I', action: 'right' },
    { kind: 'sep' },
    { kind: 'row', label: 'Developer Mode', check: true, action: 'devmode' },
  ],
  Go: [
    { kind: 'row', label: 'Go to File…', k: '⌘P', action: 'palette:open' },
    { kind: 'row', label: 'Go to Symbol in Workspace…', k: '⌘T', disabled: true },
    { kind: 'sep' },
    { kind: 'row', label: 'Go to Definition', k: 'F12', disabled: true },
    { kind: 'row', label: 'Go to References', k: '⇧F12', disabled: true },
    { kind: 'sep' },
    { kind: 'row', label: 'Add Symbol to Agent Inbox', disabled: true },
    { kind: 'sep' },
    { kind: 'row', label: 'Next Problem', k: 'F8', disabled: true },
    { kind: 'row', label: 'Previous Problem', k: '⇧F8', disabled: true },
  ],
  Run: [
    { kind: 'head', label: 'Team' },
    { kind: 'row', label: 'Start / Resume Team', k: 'F5', action: 'team:resume' },
    { kind: 'row', label: 'Pause Team', k: '⇧F5', action: 'team:pause' },
    { kind: 'sep' },
    { kind: 'row', label: 'Run Drift Check', k: '⌘⇧D', action: 'drift:run' },
    { kind: 'row', label: 'Run Validations on Active Task', k: '⌘⇧V', action: 'validations:run' },
    { kind: 'row', label: 'Open Foundry', action: 'foundry:refine' },
    { kind: 'sep' },
    { kind: 'row', label: 'Approve Pending…', k: '⌘⇧A', action: 'approvals:open' },
    { kind: 'row', label: 'End Team', action: 'team:end' },
  ],
  Terminal: [
    { kind: 'row', label: 'New Terminal', k: '⌃⇧`', action: 'terminal:new' },
    { kind: 'sep' },
    { kind: 'row', label: 'Kill Active Terminal', disabled: true },
    { kind: 'row', label: 'Clear', disabled: true },
  ],
  Help: [
    { kind: 'row', label: 'Show All Commands', k: '⌘⇧P', action: 'palette:open' },
    { kind: 'row', label: 'Keyboard Shortcuts…', k: '⌘K ⌘S', action: 'help:shortcuts' },
    { kind: 'sep' },
    { kind: 'row', label: 'Documentation', action: 'help:docs' },
    { kind: 'row', label: 'Give Feedback…', action: 'help:feedback' },
    { kind: 'row', label: 'Report Issue…', action: 'help:issue' },
    { kind: 'sep' },
    { kind: 'row', label: 'Toggle Developer Tools', disabled: true },
    { kind: 'row', label: 'About Symphony', action: 'help:about' },
  ],
};

export interface MenubarProps {
  openMenu: string | null;
  setOpenMenu: (m: string | null) => void;
  onNav: (key: SidebarKey) => void;
  onAction: (a: MenuAction) => void;
  devMode: boolean;
  /** Optional override of the right-side window subtitle. Defaults to a
   *  generic wordmark; later phases can pass the active project label. */
  subtitle?: string;
  /** When true, render the macOS-style traffic-light dots on the left
   *  edge of the menubar. Hidden on Tauri Windows builds where the
   *  window controls live in the Titlebar's right side instead. */
  showTrafficLights?: boolean;
}

export function Menubar({
  openMenu,
  setOpenMenu,
  onNav,
  onAction,
  devMode,
  subtitle = 'Symphony',
  showTrafficLights = false,
}: MenubarProps) {
  const itemRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Click outside the menubar / open menu closes it.
  useEffect(() => {
    if (!openMenu) return undefined;
    const close = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.menu-pop') || target.closest('.menubar-item')) return;
      setOpenMenu(null);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [openMenu, setOpenMenu]);

  const isItemChecked = (item: MenuItem): boolean => {
    if (item.action === 'devmode') return devMode;
    return false;
  };

  const handleItemClick = (item: MenuItem) => {
    if (item.disabled) return;
    if (item.goto) onNav(item.goto);
    if (item.action) onAction(item.action);
    setOpenMenu(null);
  };

  const openEl = openMenu ? itemRefs.current[openMenu] : null;

  return (
    <div className="menubar" role="menubar">
      {showTrafficLights && (
        <div className="menubar-traffic" aria-hidden="true">
          <span /><span /><span />
        </div>
      )}
      {Object.keys(MENUS).map((name) => (
        <div
          key={name}
          ref={(el) => { itemRefs.current[name] = el; }}
          className="menubar-item"
          role="menuitem"
          data-open={openMenu === name}
          onMouseDown={(e) => {
            e.stopPropagation();
            setOpenMenu(openMenu === name ? null : name);
          }}
          onMouseEnter={() => {
            // While any menu is open, hover switches which one shows —
            // matches the Cursor / VS Code pattern. If no menu is
            // open, hover alone doesn't open one (avoids surprise pops).
            if (openMenu) setOpenMenu(name);
          }}
        >
          {name}
        </div>
      ))}
      <div className="menubar-spacer" />
      <div className="menubar-title mono">{subtitle}</div>

      {openMenu && openEl && (
        <div
          className="menu-pop"
          role="menu"
          style={{ left: openEl.offsetLeft }}
        >
          {(MENUS[openMenu] ?? []).map((item, i) => {
            if (item.kind === 'sep') return <div key={i} className="sep" />;
            if (item.kind === 'head') return <div key={i} className="head">{item.label}</div>;
            const checked = item.check ? isItemChecked(item) : false;
            return (
              <div
                key={i}
                className={`row${item.disabled ? ' disabled' : ''}`}
                role="menuitem"
                aria-disabled={item.disabled || undefined}
                onClick={() => handleItemClick(item)}
              >
                <span className="check">
                  {item.check && checked ? <Icon name="check" size={12} /> : ''}
                </span>
                <span>{item.label}</span>
                <span className="kbd">{item.k ?? ''}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
