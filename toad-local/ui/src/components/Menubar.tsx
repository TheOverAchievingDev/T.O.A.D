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
  | 'approvals:open';

type MenuItemKind = 'row' | 'sep' | 'head';

interface MenuItem {
  kind: MenuItemKind;
  label?: string;
  k?: string;        // keyboard shortcut display string
  check?: boolean;   // render as toggle with check mark when active
  action?: MenuAction;
  goto?: SidebarKey;
}

const MENUS: Record<string, MenuItem[]> = {
  File: [
    { kind: 'row', label: 'New File', k: '⌘N' },
    { kind: 'row', label: 'New Window', k: '⌘⇧N' },
    { kind: 'sep' },
    { kind: 'row', label: 'Open Project Folder…', k: '⌘O' },
    { kind: 'row', label: 'Open Recent', k: '▸' },
    { kind: 'sep' },
    { kind: 'row', label: 'Save', k: '⌘S' },
    { kind: 'row', label: 'Save As…', k: '⌘⇧S' },
    { kind: 'row', label: 'Save All', k: '⌘K S' },
    { kind: 'sep' },
    { kind: 'row', label: 'Auto Save', check: true },
    { kind: 'row', label: 'Preferences', k: '▸' },
    { kind: 'sep' },
    { kind: 'row', label: 'Close Project', k: '⌘K F' },
    { kind: 'row', label: 'Close Window', k: '⌘W' },
  ],
  Edit: [
    { kind: 'row', label: 'Undo', k: '⌘Z' },
    { kind: 'row', label: 'Redo', k: '⌘⇧Z' },
    { kind: 'sep' },
    { kind: 'row', label: 'Cut', k: '⌘X' },
    { kind: 'row', label: 'Copy', k: '⌘C' },
    { kind: 'row', label: 'Paste', k: '⌘V' },
    { kind: 'sep' },
    { kind: 'row', label: 'Find', k: '⌘F' },
    { kind: 'row', label: 'Replace', k: '⌘H' },
    { kind: 'row', label: 'Find in Files', k: '⌘⇧F' },
  ],
  Selection: [
    { kind: 'row', label: 'Select All', k: '⌘A' },
    { kind: 'row', label: 'Expand Selection', k: '⌃⇧⌘→' },
    { kind: 'row', label: 'Shrink Selection', k: '⌃⇧⌘←' },
    { kind: 'sep' },
    { kind: 'row', label: 'Add Cursor Above', k: '⌥⌘↑' },
    { kind: 'row', label: 'Add Cursor Below', k: '⌥⌘↓' },
    { kind: 'row', label: 'Add Next Occurrence', k: '⌘D' },
    { kind: 'row', label: 'Select All Occurrences', k: '⌃⇧L' },
  ],
  View: [
    { kind: 'row', label: 'Command Palette…', k: '⌘⇧P' },
    { kind: 'row', label: 'Open View…' },
    { kind: 'sep' },
    { kind: 'row', label: 'Appearance', k: '▸' },
    { kind: 'row', label: 'Editor Layout', k: '▸' },
    { kind: 'head', label: 'Screens' },
    // Screen-jumps use SidebarKey values; App.tsx's handleNavSelect
    // maps them onto setTweak('screen', …).
    { kind: 'row', label: 'Cockpit',  k: '⌘1', goto: 'workspace' },
    { kind: 'row', label: 'Foundry',  k: '⌘2', goto: 'foundry' },
    { kind: 'row', label: 'Code',     k: '⌘3', goto: 'code' },
    { kind: 'row', label: 'Tasks',    k: '⌘4', goto: 'tasks' },
    { kind: 'row', label: 'Drift',    k: '⌘5', goto: 'drift' },
    { kind: 'row', label: 'Costs',    k: '⌘6', goto: 'costs' },
    // Audit will be its own screen once Phase 2/3 lands; until then
    // 'diagnostics' is the closest existing surface.
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
    { kind: 'row', label: 'Back', k: '⌃−' },
    { kind: 'row', label: 'Forward', k: '⌃⇧−' },
    { kind: 'sep' },
    { kind: 'row', label: 'Go to File…', k: '⌘P' },
    { kind: 'row', label: 'Go to Symbol in Workspace…', k: '⌘T' },
    { kind: 'row', label: 'Go to Symbol in Editor…', k: '⌘⇧O' },
    { kind: 'sep' },
    { kind: 'row', label: 'Go to Definition', k: 'F12' },
    { kind: 'row', label: 'Go to References', k: '⇧F12' },
    // Symphony deviation — Cursor has "Add Symbol to Current/New Chat";
    // ours is "Add Symbol to Agent Inbox".
    { kind: 'row', label: 'Add Symbol to Agent Inbox', k: '⇧F12' },
    { kind: 'sep' },
    { kind: 'row', label: 'Next Problem', k: 'F8' },
    { kind: 'row', label: 'Previous Problem', k: '⇧F8' },
  ],
  Run: [
    // Symphony deviation — Cursor's Run is a debugger UI; ours is
    // Symphony team operations because agents do the work.
    { kind: 'head', label: 'Team' },
    { kind: 'row', label: 'Start / Resume Team', k: 'F5', action: 'team:resume' },
    { kind: 'row', label: 'Pause Team', k: '⇧F5', action: 'team:pause' },
    { kind: 'sep' },
    { kind: 'row', label: 'Run Drift Check', k: '⌘⇧D', action: 'drift:run' },
    { kind: 'row', label: 'Run Validations on Active Task', k: '⌘⇧V', action: 'validations:run' },
    { kind: 'row', label: 'Trigger Foundry Refinement Pass', action: 'foundry:refine' },
    { kind: 'sep' },
    { kind: 'row', label: 'Approve Pending…', k: '⌘⇧A', action: 'approvals:open' },
    { kind: 'row', label: 'End Team', action: 'team:end' },
  ],
  Terminal: [
    { kind: 'row', label: 'New Terminal', k: '⌃⇧`' },
    { kind: 'row', label: 'Split Terminal', k: '⌘⇧5' },
    { kind: 'row', label: 'Kill Active Terminal', k: '⌘⇧W' },
    { kind: 'row', label: 'Clear', k: '⌘L' },
    { kind: 'sep' },
    { kind: 'row', label: 'Run Task…' },
    { kind: 'row', label: 'Run Build Task…', k: '⌘⇧B' },
    { kind: 'sep' },
    { kind: 'row', label: 'Choose Validation Kind', k: '▸' },
  ],
  Help: [
    { kind: 'row', label: 'Show All Commands', k: '⌘⇧P' },
    { kind: 'row', label: 'Documentation' },
    { kind: 'row', label: 'Keyboard Shortcuts…', k: '⌘K ⌘S' },
    { kind: 'row', label: 'Symphony Tour' },
    { kind: 'sep' },
    { kind: 'row', label: 'Give Feedback…' },
    { kind: 'row', label: 'Report Issue…' },
    { kind: 'sep' },
    { kind: 'row', label: 'Toggle Developer Tools' },
    { kind: 'row', label: 'About Symphony' },
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
    // Auto Save is always rendered checked in the prototype — a real
    // setting binding lands in Phase 3 polish.
    if (item.label === 'Auto Save') return true;
    return false;
  };

  const handleItemClick = (item: MenuItem) => {
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
                className="row"
                role="menuitem"
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
