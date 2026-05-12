import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Icon } from './Icon';

/**
 * Phase 1 Titlebar — four-zone layout below the Menubar.
 *
 * Replaces the project-tabs strip + dense global-icon row that used
 * to live here. Per docs/specs/2026-05-11-ui-re-envisioning-design.md §5:
 *
 *   ┌──────────────────────────────────────────────────────────────┐
 *   │ Symphony / project-pill  ·  [⌘K palette]  ·  [pill][icons]   │
 *   └──────────────────────────────────────────────────────────────┘
 *
 * Three zones:
 *   - LEFT  : wordmark + project pill (active project context) +
 *             "new project" plus button.
 *   - CENTER: command palette trigger with a rotating placeholder
 *             that teaches what the palette can do.
 *   - RIGHT : FOR me / WITH me persona pill (wires
 *             tweaks.developerMode) + theme toggle + ambient icons:
 *             notifications, runtimes count, account/settings.
 *
 * Items intentionally removed from the previous Titlebar:
 *   - Project tabs strip — heavyweight projects switch via the
 *     pill's dropdown (Phase 2) or the picker screen.
 *   - Per-action icons (Approvals, Providers, Repository, Diagnostics)
 *     — these move to drawers / statusbar / Settings sub-sections per
 *     spec §3.2. Phase 5+ task list tracks each surface.
 */

export interface TitlebarProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;

  /** Persona pill — wires existing tweaks.developerMode. */
  developerMode: boolean;
  setDeveloperMode: (v: boolean) => void;

  /** Active project context for the project pill. */
  activeProjectName: string | null;
  activeProjectPath?: string | null;

  /** Click on the project pill — Phase 1 routes to the existing
   *  ProjectPicker screen; Phase 2 replaces with a real popover. */
  onOpenProjectDropdown: () => void;
  onAddProject: () => void;

  /** Center palette trigger. */
  onOpenCommandPalette?: () => void;

  /** Right-side ambient icons. */
  onOpenNotifs: () => void;
  onOpenRuntimes: () => void;
  onOpenAccount: () => void;

  /** Badge counts. */
  pendingNotifications?: number;
  liveRuntimes?: number;
  totalRuntimes?: number;

  /** Optional Tauri window controls slot. Lets the platform glue
   *  inject minimize/maximize/close at the very right edge. */
  windowControls?: ReactNode;
}

/** Rotating placeholders cycled in the command palette trigger.
 *  Teaches the user what's possible without forcing them to open it. */
const PLACEHOLDERS: Array<ReactNode> = [
  <><b>Search anything</b> · run drift · open settings · switch project</>,
  <><b>Run drift</b> · approve pending · new task · switch project</>,
  <><b>Open settings</b> · view costs · resume team · new project</>,
];

export function Titlebar({
  theme,
  onToggleTheme,
  developerMode,
  setDeveloperMode,
  activeProjectName,
  activeProjectPath,
  onOpenProjectDropdown,
  onAddProject,
  onOpenCommandPalette,
  onOpenNotifs,
  onOpenRuntimes,
  onOpenAccount,
  pendingNotifications = 0,
  liveRuntimes = 0,
  totalRuntimes = 0,
  windowControls,
}: TitlebarProps) {
  const [phIndex, setPhIndex] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => {
      setPhIndex((i) => (i + 1) % PLACEHOLDERS.length);
    }, 4200);
    return () => window.clearInterval(id);
  }, []);

  // Derive a short path prefix from the absolute project path for the
  // pill's tertiary context (e.g. "~/projects/" before "harvest").
  // Pure cosmetic — the dropdown shows the full path.
  const pathPrefix = formatPathPrefix(activeProjectPath ?? null);

  return (
    <div className="titlebar">
      <div className="title-left">
        <div className="wordmark">
          <span className="dot" aria-hidden="true" />
          Symphony
        </div>
        <span className="title-sep">/</span>
        <button
          className="project-pill"
          type="button"
          onClick={onOpenProjectDropdown}
          title={activeProjectPath ?? 'Open project picker'}
        >
          {pathPrefix && <span className="ctx">{pathPrefix}</span>}
          <span className="label">{activeProjectName ?? 'no project'}</span>
          <Icon name="chevronDown" size={12} className="chev" />
        </button>
        <button
          className="icon-btn"
          type="button"
          title="New project"
          onClick={onAddProject}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>

      <div className="title-center">
        <button
          type="button"
          className="palette"
          onClick={onOpenCommandPalette}
          title="Open command palette (⌘K / Ctrl+K)"
        >
          <Icon name="search" size={13} />
          <span className="ph">{PLACEHOLDERS[phIndex]}</span>
          <span className="k">⌘K</span>
        </button>
      </div>

      <div className="title-right">
        <div className="mode-pill" title="Persona mode">
          <button
            type="button"
            data-active={!developerMode}
            onClick={() => setDeveloperMode(false)}
          >
            FOR me
          </button>
          <button
            type="button"
            data-active={developerMode}
            onClick={() => setDeveloperMode(true)}
          >
            WITH me
          </button>
        </div>
        <button
          className="icon-btn"
          type="button"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          onClick={onToggleTheme}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={15} />
        </button>
        <button
          className="icon-btn"
          type="button"
          title="Notifications"
          onClick={onOpenNotifs}
        >
          <Icon name="bell" size={15} />
          {pendingNotifications > 0 && (
            <span className="badge">
              {pendingNotifications > 99 ? '99+' : pendingNotifications}
            </span>
          )}
        </button>
        <button
          className="icon-btn"
          type="button"
          title={`${liveRuntimes} live · ${totalRuntimes} total runtimes`}
          onClick={onOpenRuntimes}
        >
          <Icon name="users" size={16} />
          {totalRuntimes > 0 && (
            <span className="badge">{liveRuntimes}</span>
          )}
        </button>
        <button
          className="icon-btn"
          type="button"
          title="Account & settings"
          onClick={onOpenAccount}
        >
          <Icon name="settings" size={15} />
        </button>
        {windowControls}
      </div>
    </div>
  );
}

function formatPathPrefix(path: string | null): string {
  if (!path) return '';
  // Show just the parent directory name + a trailing slash. Cosmetic
  // context for the pill so it reads "projects/ harvest" rather than
  // the full absolute path. The tooltip (title attr) still shows the
  // full path for users who need it. Phase 2 may upgrade this to a
  // proper home-relative ~ replacement once a Tauri-side home resolver
  // is wired.
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  return `${parts[parts.length - 2]}/`;
}
