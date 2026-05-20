import type { ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Phase 1 SidebarNav — primary navigation, regrouped per spec §6.
 *
 * Sections (rendered top-to-bottom with thin dividers between):
 *   Build    — Cockpit / Foundry / Code / Tasks
 *   Watch    — Drift / Costs
 *   Inspect  — Audit
 *   (Power)  — Terminal / Events  ← only when developerMode is true
 * Bottom pin — Settings
 *
 * Removed from the previous flat list (Runtimes, Approvals,
 * Diagnostics):
 *   - Runtimes and Approvals move to drawers per spec §3.2 — they're
 *     "glance, dismiss" surfaces, not "live in" screens.
 *   - Diagnostics-the-screen has been renamed to "Audit" in the UI
 *     (spec §8.7). The underlying SidebarKey stays 'diagnostics' for
 *     Phase 1 to avoid cascading rename across the routing layer;
 *     Phase 2 or 3 can rename when the new Audit screen lands.
 *
 * Pip badges visible on Tasks (count) and Drift (score%, clay-tinted).
 * Settings shows ⌘, as its kbd hint instead of a pip.
 *
 * Power section (Terminal / Events) is gated behind developerMode
 * but Phase 1 does NOT add Terminal/Events as actual screens — the
 * Phase 1 plan defers those to Phase 2. So the Power section is
 * declared in the type system but not populated yet; renderGroup
 * skips empty sections so nothing renders. Phase 2 fills it in.
 */

export type SidebarKey =
  | 'workspace'    // = Cockpit screen
  | 'foundry'
  | 'code'
  | 'tasks'
  | 'runtimes'    // legacy — no longer in sidebar; kept in union for
  | 'approvals'   // back-compat with handleNavSelect's old cases.
  | 'drift'
  | 'costs'
  | 'diagnostics' // routed to from "Audit" label per the note above.
  | 'settings';

export interface SidebarNavItem {
  key: SidebarKey;
  label: string;
  icon: IconName;
  /** Optional inline shortcut hint shown right-aligned. */
  kbd?: string;
  /** Optional pip badge text (e.g. "12" or "31%"). */
  pip?: string;
  /** Optional pip color class (e.g. "clay"). */
  pipClass?: 'clay' | 'green' | 'amber' | 'red';
}

export interface SidebarSection {
  /** Visible header above the items. */
  heading: string;
  items: SidebarNavItem[];
  /** When true, this section only shows when developerMode is true. */
  devModeOnly?: boolean;
}

interface SidebarNavProps {
  active: SidebarKey;
  onSelect: (key: SidebarKey) => void;
  developerMode?: boolean;
  /** Pip on the Tasks item — passes the live task count. */
  taskCount?: number;
  /** Pip on the Drift item — passes the live drift score (0-100). */
  driftScore?: number | null;
  /** Optional override of the default grouped sections. */
  sections?: SidebarSection[];
  /** Optional pinned-bottom items (defaults to Settings only). */
  bottomItems?: SidebarNavItem[];
  /** Optional content rendered at the very top, above the nav. */
  header?: ReactNode;
}

const DEFAULT_SECTIONS_BASE: SidebarSection[] = [
  {
    heading: 'Build',
    items: [
      { key: 'workspace', label: 'Cockpit', icon: 'layers', kbd: '⌘1' },
      { key: 'foundry',   label: 'Foundry', icon: 'sparkle', kbd: '⌘2' },
      { key: 'code',      label: 'Code',    icon: 'code',    kbd: '⌘3' },
      { key: 'tasks',     label: 'Tasks',   icon: 'kanban',  kbd: '⌘4' },
    ],
  },
  {
    heading: 'Watch',
    items: [
      { key: 'drift', label: 'Drift', icon: 'eye',       kbd: '⌘5' },
      // 'workflow' is a placeholder for Costs — Icon set doesn't have
      // a dedicated dollar/cost glyph yet. Phase 3 polish can add one.
      { key: 'costs', label: 'Costs', icon: 'workflow', kbd: '⌘6' },
    ],
  },
  {
    heading: 'Inspect',
    items: [
      // Label is "Audit" per spec §6 even though the underlying screen
      // key is 'diagnostics' until Phase 2 renames it.
      { key: 'diagnostics', label: 'Audit', icon: 'info', kbd: '⌘7' },
    ],
  },
  {
    heading: 'Power',
    devModeOnly: true,
    // Empty in Phase 1 — Terminal and Events screens land in Phase 2.
    // renderGroup() skips sections with no items so this stays
    // invisible until populated.
    items: [],
  },
];

const DEFAULT_BOTTOM: SidebarNavItem[] = [
  { key: 'settings', label: 'Settings', icon: 'settings', kbd: '⌘,' },
];

export function SidebarNav({
  active,
  onSelect,
  developerMode = false,
  taskCount,
  driftScore,
  sections,
  bottomItems = DEFAULT_BOTTOM,
  header,
}: SidebarNavProps) {
  // Inject runtime-derived pip values (task count, drift score) into
  // the default sections without mutating the constant. Caller-supplied
  // sections opt out of this magic — they're expected to wire their
  // own pip values directly.
  const renderedSections: SidebarSection[] = sections ?? DEFAULT_SECTIONS_BASE.map((section) => ({
    ...section,
    items: section.items.map((item) => {
      if (item.key === 'tasks' && typeof taskCount === 'number' && taskCount > 0) {
        return { ...item, pip: String(taskCount) };
      }
      if (item.key === 'drift' && typeof driftScore === 'number' && driftScore >= 0) {
        return { ...item, pip: `${Math.round(driftScore)}%`, pipClass: 'clay' };
      }
      return item;
    }),
  }));

  const renderItem = (item: SidebarNavItem) => {
    const isActive = item.key === active;
    return (
      <button
        key={item.key}
        type="button"
        title={item.label}
        className="side-item"
        data-active={isActive || undefined}
        onClick={() => onSelect(item.key)}
      >
        <Icon name={item.icon} size={14} />
        <span className="side-label">{item.label}</span>
        {item.pip ? (
          <span className={`pip ${item.pipClass ?? ''}`}>{item.pip}</span>
        ) : item.kbd ? (
          <span className="kbd">{item.kbd}</span>
        ) : null}
      </button>
    );
  };

  const renderSection = (section: SidebarSection, idx: number) => {
    if (section.devModeOnly && !developerMode) return null;
    if (section.items.length === 0) return null;
    return (
      <div key={section.heading} className="side-section">
        {idx > 0 && <div className="side-divider" />}
        <div className="side-head">{section.heading}</div>
        {section.items.map(renderItem)}
      </div>
    );
  };

  return (
    <aside className="sidebar" aria-label="Main navigation">
      {header && <div className="side-header">{header}</div>}
      <div className="side-body">
        {renderedSections.map(renderSection)}
      </div>
      <div className="side-bottom">
        {bottomItems.map(renderItem)}
      </div>
    </aside>
  );
}
