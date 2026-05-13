import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Titlebar } from '@/components/Titlebar';
import { Menubar, type MenuAction } from '@/components/Menubar';
import { SidebarNav, type SidebarKey } from '@/components/SidebarNav';
import { Statusbar } from '@/components/Statusbar';
import { CockpitScreenV2 } from '@/components/cockpit/CockpitScreenV2';
import { Workspace } from '@/components/Workspace';
import { TasksScreen } from '@/components/TasksScreen';
import { CreateTeamModal } from '@/components/CreateTeamModal';
import { TaskDetailModal } from '@/components/TaskDetailModal';
import { TeamSettingsDrawer } from '@/components/TeamSettingsDrawer';
import { TaskCreationModal } from '@/components/TaskCreationModal';
import { TeamLaunchingScreen } from '@/components/TeamLaunchingScreen';
import { AddProjectModal } from '@/components/AddProjectModal';
import { useProjects } from '@/hooks/useProjects';
import { ApprovalsDrawer } from '@/components/ApprovalsDrawer';
import { EmptyWorkspace } from '@/components/EmptyWorkspace';
import { ProjectPicker } from '@/components/ProjectPicker';
import { SetupProjectDialog } from '@/components/SetupProjectDialog';
import { ProvidersModal } from '@/components/ProvidersModal';
import { NotificationsDrawer } from '@/components/NotificationsDrawer';
import { RuntimeDrawer } from '@/components/RuntimeDrawer';
import { DiagnosticsDrawer } from '@/components/DiagnosticsDrawer';
import { CommandPalette } from '@/components/CommandPalette';
import { SettingsScreen } from '@/components/settings/SettingsScreen';
import { ToastProvider } from '@/components/ToastSystem';
import { LogViewerDrawer } from '@/components/LogViewerDrawer';
import { CostsScreen } from '@/components/CostsScreen';
import { AuditLogScreen } from '@/components/AuditLogScreen';
import { DriftScreen } from '@/components/DriftScreen';
import { FoundryScreen } from '@/components/FoundryScreen';
import { CodeScreen } from '@/components/CodeScreen';
// Phase 2 retired the old CockpitScreen monolith — its replacement
// is CockpitScreenV2 below. The file ui/src/components/CockpitScreen.tsx
// is deleted in this same commit so dead code doesn't linger.
import { ShortcutsModal } from '@/components/ShortcutsModal';
import { useShortcutsHotkey } from '@/hooks/useShortcutsHotkey';
import {
  TweaksPanel,
  TweakSection,
  TweakRadio,
  TweakSelect,
  TweakToggle,
} from '@/components/TweaksPanel';
import type { Tweaks } from '@/types';
import { useTweaks } from '@/hooks/useTweaks';
import { useToadData } from '@/hooks/useToadData';
import { useSettings } from '@/hooks/useSettings';
import { useCommandActions } from '@/hooks/useCommandActions';
import { useCommandPaletteHotkey } from '@/hooks/useCommandPaletteHotkey';
import { useEventToasts, type NotificationsConfig } from '@/hooks/useEventToasts';
import {
  pickAndSwitchProjectFolder,
  getSavedProjectPath,
  clearSavedProjectPath,
  switchToProjectPath,
} from '@/integrations/tauri';
import { callTool as callToadApi } from '@/api/client';
import { useDrift } from '@/hooks/useDrift';

type ProjectOpenScreen = Extract<Tweaks['screen'], 'cockpit' | 'workspace' | 'code'>;

interface ReopenContext {
  teamId: string;
  teamName: string;
  isRunning: boolean;
  lastActiveAt: string | null;
  lastTask?: { taskId: string; subject: string; status: string };
  lastDriftScore?: { teamScore: number; status: string; runId: string; createdAt: string };
  lastCommit?: { sha: string; message: string; authoredAt: string | null };
}

export default function App() {
  return (
    <ToastProvider max={6}>
      <AppInner />
    </ToastProvider>
  );
}

function AppInner() {
  const [tweaks, setTweak] = useTweaks();
  const [activeTeamId, setActiveTeamId] = useState<string | null>(null);
  const { team, tasks, runtimes, messages, loading, error, liveSource, refresh, agentStreams } = useToadData(activeTeamId);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [taskCreateOpen, setTaskCreateOpen] = useState(false);
  const [showTeamSettings, setShowTeamSettings] = useState(false);
  // Plan/quota usage no longer lives at the App level — PlanUsagePanel
  // polls usage_summary itself, and is rendered inside ProvidersSettings
  // and CreateTeamModal where the operator actually needs it.
  // When the user clicks "Create team" in Foundry, we run materialize in
  // plan mode (which exports docs and returns a suggestion without
  // creating the team) and stash the plan here so CreateTeamModal can
  // pre-fill from it. After team_create succeeds, foundry_project_seed_tasks
  // attaches the suggested starter tasks to the new team.
  const [foundryPlan, setFoundryPlan] = useState<import('@/components/FoundryScreen').FoundryPlanResult | null>(null);
  // Holds the picked-folder context + a resolver that the SetupProjectDialog
  // calls when the user finishes (or skips). Used by the Foundry "Create
  // team" flow to insert a "git init? GitHub repo?" step between the
  // folder-pick (sidecar respawn) and the CreateTeamModal hand-off.
  const [setupDialog, setSetupDialog] = useState<
    | null
    | { projectName: string; projectPath: string; resolve: (ok: boolean) => void }
  >(null);
  const [launchingTeamId, setLaunchingTeamId] = useState<string | null>(null);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [logRuntimeId, setLogRuntimeId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [reopenContext, setReopenContext] = useState<ReopenContext | null>(null);
  // Phase 1 — which top-level Menubar menu is currently open (File/Edit/…),
  // or null when none. Lifted into App.tsx so keyboard shortcuts and other
  // surfaces could close it; today only the Menubar reads/writes it.
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const projectRegistry = useProjects();
  // Single drift polling loop for the whole app — lifted from
  // Workspace + TasksScreen + DriftScreen so we don't triple-poll.
  // Each consumer gets the slice it needs as a prop.
  const drift = useDrift({ teamId: team.name || activeTeamId });
  const perTaskDrift = drift.data?.perTaskScores ?? {};

  const refreshAfterProjectSwitch = useCallback(() => {
    refresh();
    window.setTimeout(refresh, 800);
  }, [refresh]);

  const openRegisteredProject = useCallback(async (projectId: string, nextScreen: ProjectOpenScreen = 'cockpit') => {
    const project = projectRegistry.projects.find((p) => p.id === projectId);
    if (!project) return;
    try {
      const switched = await switchToProjectPath(project.path);
      if (!switched) return;
      projectRegistry.setActive(project.id);
      setTweak('screen', nextScreen);
      refreshAfterProjectSwitch();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('switch_project failed:', err);
    }
  }, [projectRegistry, refreshAfterProjectSwitch, setTweak]);

  const pickProjectFolder = useCallback(async (nextScreen: ProjectOpenScreen = 'cockpit') => {
    const picked = await pickAndSwitchProjectFolder();
    if (!picked) return;
    // Reuse an existing entry that points at the same path (case-insensitive
    // on Windows would be nicer, but this is fine for the desktop case).
    const existing = projectRegistry.projects.find((p) => p.path === picked.path);
    if (existing) {
      projectRegistry.setActive(existing.id);
    } else {
      const created = projectRegistry.addProject({ name: picked.name, path: picked.path });
      projectRegistry.setActive(created.id);
    }
    setTweak('screen', nextScreen);
    refreshAfterProjectSwitch();
  }, [projectRegistry, refreshAfterProjectSwitch, setTweak]);

  // Team-control handlers wired into the Workspace's Pause/End buttons.
  // Both end with refresh() so the UI immediately reflects the new state
  // (runtimes flip to stopped, kanban stays, team disappears on End).
  const handlePauseTeam = useCallback(async () => {
    const teamId = team.name || activeTeamId;
    if (!teamId) return;
    try {
      await callToadApi({
        actor: { teamId, agentId: 'ui-client', role: 'human' },
        method: 'team_stop',
        args: { teamId },
        idempotencyKey: `team-pause-${teamId}-${Date.now()}`,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('team_stop failed:', err);
    } finally {
      refresh();
    }
  }, [team.name, activeTeamId, refresh]);

  const handleEndTeam = useCallback(async () => {
    const teamId = team.name || activeTeamId;
    if (!teamId) return;

    // Slice-1 plugin warning: check live resources before delete.
    // The resources are NOT auto-deprovisioned in slice 1 — operator must
    // remove them in the plugin's dashboard.
    let pluginResources: { resourceId: string; pluginId: string; kind: string; externalId: string }[] = [];
    try {
      const r = await callToadApi({
        actor: { teamId, agentId: 'ui-client', role: 'human' },
        method: 'plugin_resource_list',
        args: { teamId },
      }) as { resources: typeof pluginResources };
      pluginResources = r.resources ?? [];
    } catch {
      // Best-effort: if the plugin tool isn't registered or the call fails,
      // fall through to the normal delete flow.
    }

    if (pluginResources.length > 0) {
      const list = pluginResources.map((r) => `  • ${r.pluginId}/${r.kind} (${r.externalId})`).join('\n');
      const proceed = window.confirm(
        `This team has ${pluginResources.length} live plugin resource${pluginResources.length === 1 ? '' : 's'}:\n\n${list}\n\n`
        + `These will NOT be auto-deprovisioned. They will continue to incur cost until you remove them in their respective dashboards.\n\n`
        + `Continue with team deletion?`,
      );
      if (!proceed) return;
    }

    try {
      // Stop runtimes first so we don't leak orphan claude processes.
      await callToadApi({
        actor: { teamId, agentId: 'ui-client', role: 'human' },
        method: 'team_stop',
        args: { teamId },
        idempotencyKey: `team-end-stop-${teamId}-${Date.now()}`,
      }).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('team_stop during End failed (proceeding to delete):', err);
      });
      await callToadApi({
        actor: { teamId, agentId: 'ui-client', role: 'human' },
        method: 'team_delete',
        args: { teamId },
        idempotencyKey: `team-end-delete-${teamId}-${Date.now()}`,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('team_delete failed:', err);
    } finally {
      refresh();
    }
  }, [team.name, activeTeamId, refresh]);

  useShortcutsHotkey(() => setShortcutsOpen(true));

  // Sync the registry with the Tauri shell's persisted active-project on
  // mount. If the desktop app has a saved path, make sure that path is
  // present in the registry and marked active. This keeps the localStorage
  // registry and the Rust-side `active-project.txt` in agreement after a
  // restart or first install.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const saved = await getSavedProjectPath();
      if (cancelled || !saved) return;
      // Migration: if the Rust shell has the legacy hardcoded path saved
      // (from an earlier build that auto-pointed at toad-local itself),
      // clear it so the user lands on the welcome screen instead of being
      // teleported back to a directory they didn't choose.
      const legacyPaths = new Set([
        'C:/Project-TOAD/toad-local',
        'C:\\Project-TOAD\\toad-local',
      ]);
      if (legacyPaths.has(saved)) {
        await clearSavedProjectPath();
        return;
      }
      const existing = projectRegistry.projects.find((p) => p.path === saved);
      if (existing) {
        if (projectRegistry.activeId !== existing.id) projectRegistry.setActive(existing.id);
      } else {
        const created = projectRegistry.addProject({
          name: saved.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || 'project',
          path: saved,
        });
        projectRegistry.setActive(created.id);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // First-run redirect — runs ONCE on initial mount via the ref guard.
  // Brand-new users (firstRunComplete === false, no projects) get
  // routed to Foundry so the welcome banner can do its job. After
  // mount, the user can navigate freely; the picker redirect below
  // takes over once they've engaged (firstRunComplete flips).
  //
  // The ref-guard pattern matters: putting tweaks.screen in the deps
  // creates a re-route loop when the user clicks the sidebar — the
  // screen change re-triggers the effect, which re-routes back to
  // Foundry, blinking the UI.
  const firstRunRedirectDone = useRef(false);
  useEffect(() => {
    if (firstRunRedirectDone.current) return;
    firstRunRedirectDone.current = true;
    void (async () => {
      try {
        const state = await callToadApi({
          actor: { teamId: 'system', agentId: 'ui-client', role: 'human' },
          method: 'project_state_describe',
        }) as { state: 'has_team' | 'half_foundried' | 'fresh'; reopenContext?: ReopenContext };
        setReopenContext(state.reopenContext ?? null);
        if (state.state === 'has_team' && state.reopenContext) {
          setActiveTeamId(state.reopenContext.teamId);
          if (tweaks.screen !== 'settings') setTweak('screen', 'cockpit');
        } else if (state.state === 'half_foundried') {
          if (tweaks.screen !== 'settings') setTweak('screen', 'foundry');
        } else if (!tweaks.firstRunComplete) {
          // fresh + first-run user → Foundry with welcome banner
          if (tweaks.screen !== 'foundry' && tweaks.screen !== 'settings') {
            setTweak('screen', 'foundry');
          }
        }
        // Otherwise: fresh + returning user → respect last-stored screen.
      } catch (err) {
        // Sidecar offline / call failed — fall back to existing first-run
        // behaviour so the UI doesn't soft-lock.
        // eslint-disable-next-line no-console
        console.warn('[app] project_state_describe failed; falling back to first-run logic:', err);
        if (!tweaks.firstRunComplete && projectRegistry.projects.length === 0) {
          if (tweaks.screen !== 'foundry' && tweaks.screen !== 'settings') {
            setTweak('screen', 'foundry');
          }
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Picker redirect — for returning users who've completed first-run
  // and have an empty registry (e.g. they deleted all projects). Skips
  // entirely while firstRunComplete is false so first-run users can
  // explore the sidebar without being yanked to picker before they've
  // engaged with the welcome banner. Also skips when reopenContext is
  // set: the reopen flow's routing is authoritative — if we know there's
  // a team to work with, we should never bounce the user to the project
  // picker just because the localStorage registry is empty (e.g. browser
  // mode without Tauri shell persisting the project).
  useEffect(() => {
    if (!tweaks.firstRunComplete) return;
    if (reopenContext) return; // Reopen flow has authoritative routing; don't override.
    if (projectRegistry.projects.length === 0 && tweaks.screen !== 'picker' && tweaks.screen !== 'create' && tweaks.screen !== 'settings' && tweaks.screen !== 'foundry' && tweaks.screen !== 'code' && tweaks.screen !== 'drift') {
      setTweak('screen', 'picker');
    }
  }, [projectRegistry.projects.length, tweaks.screen, tweaks.firstRunComplete, setTweak, reopenContext]);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', tweaks.theme);
    document.documentElement.setAttribute('data-density', tweaks.density);
  }, [tweaks.theme, tweaks.density]);

  const togglePalette = useCallback(() => setPaletteOpen((v) => !v), []);
  useCommandPaletteHotkey(togglePalette);

  const openTaskFromPalette = useCallback((id: string) => {
    setSelectedTaskId(id);
    setTweak('screen', 'task');
  }, [setTweak]);

  const openAgentFromPalette = useCallback((id: string) => {
    setTweak('screen', 'cockpit');
    setTweak('agentInbox', id);
  }, [setTweak]);

  // Wire SSE runtime events to toasts. Notification config is read from the
  // backend settings store; falls back to defaults if the API is offline or
  // the user hasn't configured it.
  const { settings: backendSettings } = useSettings();
  const notificationsConfig: NotificationsConfig | undefined =
    backendSettings.notifications && typeof backendSettings.notifications === 'object'
      ? (backendSettings.notifications as NotificationsConfig)
      : undefined;
  useEventToasts({
    notifications: notificationsConfig,
    onOpenTask: openTaskFromPalette,
    onOpenApprovals: () => setTweak('showApprovals', true),
  });

  const commandActions = useCommandActions({
    team, tasks, runtimes, tweaks, setTweak,
    onOpenTask: openTaskFromPalette,
    onOpenAgent: openAgentFromPalette,
    onCreateTeam: () => setTweak('screen', 'create'),
    onCreateTask: () => setTaskCreateOpen(true),
    onRefresh: refresh,
    onOpenLogs: (runtimeId) => setLogRuntimeId(runtimeId),
    onShowShortcuts: () => setShortcutsOpen(true),
  });

  // Bridge legacy global window events some components emit (titlebar runtime
  // pill dispatches `toad:open-runtimes`, etc).
  useEffect(() => {
    const onRuntimes = () => setTweak('showRuntimes', true);
    const onProviders = () => setTweak('showProviders', true);
    const onNotifs = () => setTweak('showNotifs', true);
    window.addEventListener('toad:open-runtimes', onRuntimes);
    window.addEventListener('toad:open-providers', onProviders);
    window.addEventListener('toad:open-notifs', onNotifs);
    return () => {
      window.removeEventListener('toad:open-runtimes', onRuntimes);
      window.removeEventListener('toad:open-providers', onProviders);
      window.removeEventListener('toad:open-notifs', onNotifs);
    };
  }, [setTweak]);

  // §14 pending-approval badge count: tasks that the risk-classifier (or
  // the operator at task_create) flagged as requiring human approval AND
  // which have not yet been approved. Most-relevant when the task has
  // reached merge_ready — that's the gate point — but we count any
  // un-cleared gate so the user can see the queue building up earlier in
  // the lifecycle too.
  const pendingApprovalItems = useMemo(() => {
    // Translate task-gate approvals (set by §14 risk policy or task_human_approve
    // requirements) into the shape the ApprovalsDrawer renders. Without this
    // pass, the drawer shows "0 pending" while the sidebar badge says N — the
    // badge counts task gates, the drawer expects an external prop that was
    // never populated.
    return tasks
      .filter((t) => t.requiresHumanApproval === true && t.humanApproved !== true)
      .map((t) => {
        const member = team.members.find((m) => m.id === t.assignee || m.role === t.assignee);
        const risk: 'low' | 'med' | 'high' = t.riskLevel === 'critical' || t.riskLevel === 'high'
          ? 'high'
          : t.riskLevel === 'medium'
            ? 'med'
            : 'low';
        const reason = Array.isArray(t.matchedRules) && t.matchedRules.length > 0
          ? `Matched ${t.matchedRules.length} risk rule${t.matchedRules.length === 1 ? '' : 's'}: ${t.matchedRules.map((r) => r.pattern).join(', ')}`
          : 'Task gated for human approval before merge.';
        return {
          id: `task-gate-${t.id}`,
          agentId: member?.id ?? (t.assignee || 'lead'),
          tool: 'task-gate',
          input: t.title,
          requestedAgo: 'now',
          taskId: t.id,
          risk,
          reason,
          scope: 'task-gate' as const,
        };
      });
  }, [tasks, team.members]);
  const pendingApprovals = pendingApprovalItems.length;

  // The sidebar key reflects the active nav target. Drawer nav items don't
  // change `tweaks.screen` — they toggle the corresponding drawer instead.
  const activeNav: SidebarKey = useMemo(() => {
    if (tweaks.showApprovals) return 'approvals';
    if (tweaks.showDiagnostics) return 'diagnostics';
    if (tweaks.showRuntimes) return 'runtimes';
    if (tweaks.screen === 'settings') return 'settings';
    if (tweaks.screen === 'foundry') return 'foundry';
    if (tweaks.screen === 'code') return 'code';
    if (tweaks.screen === 'costs') return 'costs';
    if (tweaks.screen === 'drift') return 'drift';
    if (tweaks.screen === 'tasks') return 'tasks';
    return 'workspace';
  }, [tweaks]);

  function handleNavSelect(key: SidebarKey) {
    switch (key) {
      case 'workspace':
        setTweak('screen', 'cockpit');
        return;
      case 'tasks':
        setTweak('screen', 'tasks');
        return;
      case 'foundry':
        setTweak('screen', 'foundry');
        return;
      case 'code':
        setTweak('screen', 'code');
        return;
      case 'runtimes':
        setTweak('showRuntimes', true);
        return;
      case 'approvals':
        setTweak('showApprovals', true);
        return;
      case 'costs':
        setTweak('screen', 'costs');
        return;
      case 'drift':
        setTweak('screen', 'drift');
        return;
      case 'diagnostics':
        setTweak('showDiagnostics', true);
        return;
      case 'settings':
        setTweak('screen', 'settings');
        return;
    }
  }

  // Phase 2 Task 3 — full Menubar action dispatcher. All four panel
  // toggles wire to real tweaks; Run menu items wire to the existing
  // handlers where they exist, or stub with a helpful console.warn
  // where the real handler belongs to a screen (Validations, End Team,
  // Foundry Refinement) that hasn't yet exposed it as a top-level API.
  function handleMenuAction(a: MenuAction) {
    switch (a) {
      case 'devmode':
        setTweak('developerMode', !(tweaks.developerMode === true));
        return;
      case 'sidebar':
        setTweak('showSidebar', !(tweaks.showSidebar !== false));
        return;
      case 'bottom':
        setTweak('showBottomPanel', !(tweaks.showBottomPanel !== false));
        return;
      case 'right':
        setTweak('showRightPanel', !(tweaks.showRightPanel === true));
        return;
      case 'team:resume': {
        // Reuses the same team_launch path the Cockpit's Resume Team
        // button uses (App.tsx wires it on the CockpitScreen prop).
        // From the menu we don't have the reopenContext snapshot, so
        // we use whatever team the user is currently looking at.
        const teamId = team.name || activeTeamId;
        if (!teamId) {
          // eslint-disable-next-line no-console
          console.warn('[menu] team:resume — no active team to resume');
          return;
        }
        void callToadApi({
          actor: { teamId, agentId: 'ui-client', role: 'human' },
          method: 'team_launch',
          args: { teamId },
          idempotencyKey: `menu-resume-${teamId}-${Date.now()}`,
        })
          .then(() => refresh())
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.warn('[menu] team_launch failed:', err);
          });
        return;
      }
      case 'team:pause':
        // team_pause MCP method isn't wired today — stub with a hint
        // for the operator. Phase 3 polish adds the real handler.
        // eslint-disable-next-line no-console
        console.warn('[menu] Pause Team — coming in Phase 3 (team_pause MCP method not yet exposed)');
        return;
      case 'team:end':
        // Destructive — needs a confirm dialog. Phase 3 wires the real
        // tear-down via team_delete + confirmation modal.
        // eslint-disable-next-line no-console
        console.warn('[menu] End Team — coming in Phase 3 (destructive action needs confirm UX)');
        return;
      case 'drift:run':
        // Manual drift trigger — reuses the existing drift.refresh()
        // path that the Drift screen's Refresh button uses.
        void drift.refresh();
        return;
      case 'validations:run':
        // Validations need the active task's id, which lives in the
        // Cockpit's selectedTask state. Phase 2c (CockpitWithMe) will
        // wire a bus from this menu to the active validation runner.
        // eslint-disable-next-line no-console
        console.warn('[menu] Run Validations on Active Task — coming in Phase 2c');
        return;
      case 'foundry:refine':
        // Foundry refinement passes are per-session; the menu needs to
        // know which session is "active" which is a Phase 3 IA decision.
        // eslint-disable-next-line no-console
        console.warn('[menu] Trigger Foundry Refinement — coming in Phase 3');
        return;
      case 'approvals:open':
        setTweak('showApprovals', true);
        return;
    }
  }

  // Phase 1 + Phase 2 Task 3 — keyboard shortcuts for screen jumps +
  // panel toggles. Ctrl/Cmd+1..7 hit Cockpit, Foundry, Code, Tasks,
  // Drift, Costs, Audit in order; Ctrl/Cmd+, opens Settings; Ctrl+B
  // toggles the sidebar; Ctrl+J toggles the bottom panel; Ctrl+Alt+I
  // toggles the right Agent Inbox panel. Matches the Menubar's View
  // menu and the mockup's behavior.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      // Avoid hijacking input fields — let the browser handle ⌘C / ⌘V
      // etc. inside inputs and the command palette.
      const tag = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable) {
        return;
      }
      // Panel toggles first — these take precedence over screen jumps
      // because Ctrl+B / Ctrl+J / Ctrl+Alt+I never collide with the
      // digit / comma jumps.
      if (e.key === 'b' && !e.altKey) {
        e.preventDefault();
        handleMenuAction('sidebar');
        return;
      }
      if (e.key === 'j' && !e.altKey) {
        e.preventDefault();
        handleMenuAction('bottom');
        return;
      }
      if (e.key === 'i' && e.altKey) {
        e.preventDefault();
        handleMenuAction('right');
        return;
      }
      const map: Record<string, SidebarKey> = {
        '1': 'workspace',
        '2': 'foundry',
        '3': 'code',
        '4': 'tasks',
        '5': 'drift',
        '6': 'costs',
        // Audit will be its own SidebarKey in Phase 2/3; route to
        // diagnostics for now to keep the shortcut alive.
        '7': 'diagnostics',
        ',': 'settings',
      };
      if (map[e.key]) {
        handleNavSelect(map[e.key]);
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // handleNavSelect + handleMenuAction are stable within this
    // component; including them in deps would force a re-attach every
    // render with no benefit. tweaks.* are accessed indirectly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isOverlayScreen =
    tweaks.screen === 'empty' ||
    tweaks.screen === 'picker';

  return (
    <div className="win">
      <Menubar
        openMenu={openMenu}
        setOpenMenu={setOpenMenu}
        onNav={handleNavSelect}
        onAction={handleMenuAction}
        devMode={tweaks.developerMode === true}
      />
      <Titlebar
        theme={tweaks.theme}
        onToggleTheme={() => setTweak('theme', tweaks.theme === 'dark' ? 'light' : 'dark')}
        developerMode={tweaks.developerMode === true}
        setDeveloperMode={(v) => setTweak('developerMode', v)}
        activeProjectName={projectRegistry.active?.name ?? null}
        activeProjectPath={projectRegistry.active?.path ?? null}
        // Phase 1: clicking the project pill routes to the existing
        // picker screen. Phase 2 swaps in a real popover dropdown.
        onOpenProjectDropdown={() => setTweak('screen', 'picker')}
        onAddProject={() => setAddProjectOpen(true)}
        onOpenCommandPalette={togglePalette}
        onOpenNotifs={() => setTweak('showNotifs', true)}
        onOpenRuntimes={() => setTweak('showRuntimes', true)}
        // Phase 1: account/settings gear routes to Settings. Phase 2
        // builds an AccountMenu popover with Plan & quota / Theme /
        // Sign out etc. and routes settings via a sub-action.
        onOpenAccount={() => setTweak('screen', 'settings')}
        pendingNotifications={0}
        liveRuntimes={runtimes.filter((r) => r.status === 'live').length}
        totalRuntimes={runtimes.length}
      />

      {error && (
        <div
          className="banner banner-warn"
          style={{
            padding: '6px 14px',
            background: 'oklch(0.30 0.06 60)',
            color: 'oklch(0.92 0.06 80)',
            fontSize: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span>API not reachable - live workspace data unavailable. {error}</span>
          <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={refresh}>
            Retry
          </button>
        </div>
      )}

      {liveSource === 'empty' && !error && loading && (
        <div style={{ padding: '4px 14px', fontSize: 11, color: 'var(--fg-dim)' }}>Loading…</div>
      )}

      <div className="app-body">
        {tweaks.showSidebar !== false && (
          <SidebarNav
            active={activeNav}
            onSelect={handleNavSelect}
            developerMode={tweaks.developerMode === true}
            taskCount={tasks.length}
            driftScore={drift.data?.teamScore ?? null}
          />
        )}

        <div className="app-main">
          {/* Primary screen — workspace or one of the alt screens. */}
          {tweaks.screen === 'empty' && (
            <EmptyWorkspace onCreateTeam={() => setTweak('screen', 'create')} />
          )}
          {tweaks.screen === 'picker' && (
            <ProjectPicker
              projects={projectRegistry.projects}
              activeId={projectRegistry.activeId}
              onOpenProject={(id) => {
                void openRegisteredProject(id, 'cockpit');
              }}
              onCreateTeam={() => setTweak('screen', 'create')}
              onSelectFolder={pickProjectFolder}
              onStartNewProject={async () => {
                // Bug 2 fix — "Start new project" was just switching the
                // screen to Foundry, which then reused whatever project
                // was already loaded as the materialize destination.
                // Force a folder pick first so the new project actually
                // gets its own directory. In web view the picker falls
                // back to a window.prompt() for an absolute path; in
                // the desktop shell (start-desktop.bat) the native
                // folder picker pops. If the user cancels, stay on
                // the picker — don't drop them into Foundry against
                // the wrong project.
                const picked = await pickAndSwitchProjectFolder();
                if (!picked) return;
                const existing = projectRegistry.projects.find((p) => p.path === picked.path);
                if (existing) {
                  projectRegistry.setActive(existing.id);
                } else {
                  const created = projectRegistry.addProject({ name: picked.name, path: picked.path });
                  projectRegistry.setActive(created.id);
                }
                refresh();
                await new Promise((r) => setTimeout(r, 800));
                setTweak('screen', 'foundry');
              }}
            />
          )}
          {tweaks.screen === 'tasks' && (
            <TasksScreen
              team={team}
              tasks={tasks}
              onOpenTask={(id) => {
                setSelectedTaskId(id);
                setTweak('screen', 'task');
              }}
              onCreateTask={() => setTaskCreateOpen(true)}
              perTaskDrift={perTaskDrift}
            />
          )}
          {tweaks.screen === 'foundry' && (
            <FoundryScreen
              teamId={team.name || activeTeamId || 'foundry'}
              hasActiveProject={projectRegistry.activeId !== null}
              firstRun={!tweaks.firstRunComplete}
              onFirstRunDismiss={() => setTweak('firstRunComplete', true)}
              onPickProjectFolder={async () => {
                // Foundry "Create team" pre-flight when no project is
                // loaded: pops the native folder picker, respawns the
                // sidecar against the chosen path (Foundry sessions
                // survive because the store lives at ~/.symphony/foundry.db),
                // then opens the SetupProjectDialog so the user can
                // optionally `git init` + create a GitHub repo before the
                // team is crafted.
                const picked = await pickAndSwitchProjectFolder();
                if (!picked) return false;
                const existing = projectRegistry.projects.find((p) => p.path === picked.path);
                if (existing) {
                  projectRegistry.setActive(existing.id);
                } else {
                  const created = projectRegistry.addProject({ name: picked.name, path: picked.path });
                  projectRegistry.setActive(created.id);
                }
                refresh();
                // Wait for sidecar to come back up before talking to it.
                await new Promise((r) => setTimeout(r, 800));
                // Open the setup dialog and wait for the user to either
                // finish or skip. Returns true either way — the next step
                // (materialize) doesn't depend on git/GitHub being set up.
                await new Promise<void>((resolve) => {
                  setSetupDialog({
                    projectName: picked.name,
                    projectPath: picked.path,
                    resolve: () => resolve(),
                  });
                });
                return true;
              }}
              onMaterializePlan={(plan) => {
                // Foundry exported docs + suggested team. Open
                // CreateTeamModal pre-filled so the user can craft the
                // team before launch. Tasks get seeded after team_create
                // via foundry_project_seed_tasks.
                setFoundryPlan(plan);
                setTweak('screen', 'create');
              }}
              onMaterialized={(teamId) => {
                setActiveTeamId(teamId);
                refresh();
                setTweak('screen', 'cockpit');
              }}
            />
          )}
          {(tweaks.screen === 'cockpit' || tweaks.screen === 'create' || tweaks.screen === 'task') && (
            // Phase 2 Task 11 — CockpitScreenV2 replaces the old 1132-line
            // CockpitScreen at this mount point. V2's prop shape is tighter
            // (no projects/activeProject/onSelectFolder/onOpenLogs etc.),
            // routing those through the new Phase 1 Titlebar's project pill
            // and the existing drawer toggles. Task 12 retires the old file.
            <CockpitScreenV2
              team={team}
              tasks={tasks}
              runtimes={runtimes}
              messages={messages}
              agentStreams={agentStreams}
              actor={{
                teamId: team.name || activeTeamId || 'system',
                agentId: 'ui-client',
                agentName: 'ui',
                role: 'human',
              }}
              drift={drift.data}
              developerMode={tweaks.developerMode === true}
              showBottomPanel={tweaks.showBottomPanel !== false}
              showRightPanel={tweaks.showRightPanel === true}
              bottomPanelTab={tweaks.bottomPanelTab ?? 'terminal'}
              rightPanelAgent={tweaks.rightPanelAgent ?? null}
              setTweak={setTweak}
              reopenContext={reopenContext}
              onCreateTask={() => setTaskCreateOpen(true)}
              onRefreshDrift={async () => { await drift.refresh(); }}
              onOpenTaskDetail={(id) => {
                setSelectedTaskId(id);
                setTweak('screen', 'task');
              }}
              onOpenDriftScreen={() => setTweak('screen', 'drift')}
              onMessageSent={refresh}
              onResumeTeam={() => {
                if (!reopenContext?.teamId) return;
                void callToadApi({
                  actor: { teamId: reopenContext.teamId, agentId: 'ui-client', role: 'human' },
                  method: 'team_launch',
                  args: { teamId: reopenContext.teamId },
                  idempotencyKey: `resume-${reopenContext.teamId}-${Date.now()}`,
                })
                  .then(() => refresh())
                  .catch((err) => {
                    // eslint-disable-next-line no-console
                    console.warn('[app] team_launch (resume) failed:', err);
                  });
              }}
            />
          )}
          {tweaks.screen === 'code' && (
            <CodeScreen
              teamId={team.name || activeTeamId}
              tasks={tasks}
              projects={projectRegistry.projects}
              activeProject={projectRegistry.active}
              onSelectProject={(id) => {
                void openRegisteredProject(id, 'code');
              }}
              onSelectFolder={() => {
                void pickProjectFolder('code');
              }}
              actor={{
                teamId: team.name || activeTeamId || 'system',
                agentId: 'ui-client',
                agentName: 'ui',
                role: 'human',
              }}
              driftData={drift.data}
              runtimes={runtimes}
            />
          )}
          {tweaks.screen === 'costs' && (
            <CostsScreen team={team} runtimes={runtimes} />
          )}
          {tweaks.screen === 'audit' && (
            <AuditLogScreen
              team={team}
              onOpenTask={openTaskFromPalette}
              onOpenLogs={(id) => setLogRuntimeId(id)}
            />
          )}
          {tweaks.screen === 'drift' && (
            <DriftScreen
              teamId={team.name || activeTeamId}
              data={drift.data}
              loading={drift.loading}
              error={drift.error}
              refresh={drift.refresh}
              onOpenTask={(id) => {
                setSelectedTaskId(id);
                setTweak('screen', 'task');
              }}
            />
          )}
          {tweaks.screen === 'launching' && (
            <TeamLaunchingScreen
              team={team}
              runtimes={runtimes}
              launchingTeamId={launchingTeamId ?? team.name}
              onContinue={() => {
                setLaunchingTeamId(null);
                setTweak('screen', 'cockpit');
              }}
              onCancel={() => {
                setLaunchingTeamId(null);
                setTweak('screen', 'cockpit');
              }}
            />
          )}
          {tweaks.screen === 'settings' && (
            <SettingsScreen
              tweaks={tweaks}
              setTweak={setTweak}
              onClose={() => setTweak('screen', 'cockpit')}
            />
          )}
          {tweaks.screen === 'workspace' && !isOverlayScreen && (
            <Workspace
              team={team}
              tasks={tasks}
              runtimes={runtimes}
              messages={messages}
              cardVariant={tweaks.cardVariant}
              layout={tweaks.layout}
              agentInbox={tweaks.agentInbox}
              onCreateTeam={() => setTweak('screen', 'create')}
              onCreateTask={() => setTaskCreateOpen(true)}
              onOpenTask={(id) => {
                setSelectedTaskId(id);
                setTweak('screen', 'task');
              }}
              onOpenAgent={(id) => setTweak('agentInbox', id)}
              onCloseAgent={() => setTweak('agentInbox', '')}
              onOpenLogs={(id) => setLogRuntimeId(id)}
              onPauseTeam={handlePauseTeam}
              onEndTeam={handleEndTeam}
              agentStreams={agentStreams}
              pendingApprovals={pendingApprovals}
              onOpenApprovals={() => setTweak('showApprovals', true)}
              erroredRuntimes={runtimes.filter((r) => r.status === 'error').length}
              composerActor={{
                teamId: team.name || activeTeamId || 'default',
                agentId: 'ui-client',
                agentName: 'ui',
                role: 'human',
              }}
              onComposerSent={refresh}
              onOpenTeamSettings={() => setShowTeamSettings(true)}
              perTaskDrift={perTaskDrift}
            />
          )}
        </div>
      </div>

      <Statusbar
        driftScore={drift.data?.teamScore ?? null}
        driftStatus={(() => {
          // Drift's DriftRunResult uses healthy/watch/warning/critical
          // while the Statusbar uses healthy/watch/breach. Warning and
          // critical both signal "bad enough to interrupt"; collapse
          // them to 'breach' so the pulse + red dot fire.
          const s = drift.data?.status;
          if (s === 'critical' || s === 'warning') return 'breach';
          if (s === 'watch') return 'watch';
          return 'healthy';
        })()}
        onOpenDrift={() => setTweak('screen', 'drift')}
        liveRuntimes={runtimes.filter((r) => r.status === 'live').length}
        totalRuntimes={runtimes.length}
        onOpenRuntimes={() => setTweak('showRuntimes', true)}
        costToday={null}
        onOpenCosts={() => setTweak('screen', 'costs')}
        gitBranch="main"
        gitClean
        developerMode={tweaks.developerMode === true}
        pendingApprovals={pendingApprovals}
        onOpenApprovals={() => setTweak('showApprovals', true)}
      />

      {setupDialog && (
        <SetupProjectDialog
          defaultRepoName={setupDialog.projectName}
          projectPath={setupDialog.projectPath}
          onComplete={() => {
            const r = setupDialog.resolve;
            setSetupDialog(null);
            r(true);
          }}
          onCancel={() => {
            const r = setupDialog.resolve;
            setSetupDialog(null);
            r(false);
          }}
        />
      )}

      {tweaks.screen === 'create' && (
        <CreateTeamModal
          seed={
            foundryPlan
              ? {
                  teamName: foundryPlan.suggestedTeam.teamId,
                  leadPrompt: foundryPlan.suggestedTeam.leadPrompt,
                  leadProvider: foundryPlan.suggestedTeam.lead.providerId,
                  projectPath: foundryPlan.suggestedTeam.cwd,
                  members: foundryPlan.suggestedTeam.teammates.map((m) => ({
                    name: m.agentId,
                    // Cast through unknown — backend roles match the
                    // RoleId set with 'lead' excluded for teammates.
                    role: m.role as Exclude<import('@/types').RoleId, 'lead'>,
                    provider: m.providerId,
                    model: 'Default',
                  })),
                }
              : undefined
          }
          onClose={() => {
            setFoundryPlan(null);
            setTweak('screen', 'cockpit');
          }}
          onCreated={async (teamId) => {
            setActiveTeamId(teamId);
            // If the team was created from a Foundry session, attach the
            // suggested starter tasks now that the team exists.
            if (foundryPlan) {
              try {
                await callToadApi({
                  actor: { teamId, agentId: 'ui-client', agentName: 'ui', role: 'human' },
                  method: 'foundry_project_seed_tasks',
                  args: { sessionId: foundryPlan.sessionId, teamId },
                  idempotencyKey: `foundry-seed-${foundryPlan.sessionId}-${Date.now()}`,
                });
              } catch (err) {
                // Non-blocking — the team is already real, tasks are best-effort.
                // eslint-disable-next-line no-console
                console.warn('foundry_project_seed_tasks failed:', err);
              }
              setFoundryPlan(null);
            }
            refresh();
            setLaunchingTeamId(teamId);
            setTweak('screen', 'launching');
          }}
        />
      )}

      {tweaks.screen === 'task' && (
        <TaskDetailModal
          team={team}
          taskId={selectedTaskId ?? undefined}
          task={selectedTaskId ? tasks.find((t) => t.id === selectedTaskId) : undefined}
          onClose={() => {
            setTweak('screen', 'cockpit');
            setSelectedTaskId(null);
          }}
        />
      )}

      {paletteOpen && (
        <CommandPalette actions={commandActions} onClose={() => setPaletteOpen(false)} />
      )}

      {addProjectOpen && (
        <AddProjectModal
          onClose={() => setAddProjectOpen(false)}
          onAdd={(input) => {
            void (async () => {
              try {
                await switchToProjectPath(input.path);
                const created = projectRegistry.addProject(input);
                projectRegistry.setActive(created.id);
                refreshAfterProjectSwitch();
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('switch_project failed:', err);
              }
            })();
          }}
        />
      )}

      {taskCreateOpen && (
        <TaskCreationModal
          team={team}
          existingTasks={tasks}
          actor={{
            teamId: team.name || activeTeamId || 'default',
            agentId: 'ui-client',
            agentName: 'ui',
            role: 'human',
          }}
          onClose={() => setTaskCreateOpen(false)}
          onCreated={() => refresh()}
        />
      )}

      {tweaks.showApprovals && (
        <ApprovalsDrawer
          team={team}
          onClose={() => setTweak('showApprovals', false)}
          approvals={pendingApprovalItems}
          actor={{ teamId: team.name || activeTeamId || 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' }}
          onDecided={refresh}
        />
      )}
      {showTeamSettings && team.members.length > 0 && (
        <TeamSettingsDrawer
          team={team}
          actor={{ teamId: team.name || activeTeamId || 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' }}
          onClose={() => setShowTeamSettings(false)}
          onSaved={refresh}
        />
      )}
      {logRuntimeId && (
        <LogViewerDrawer
          runtimeId={logRuntimeId}
          title={runtimes.find((r) => r.id === logRuntimeId)?.agent}
          runtime={runtimes.find((r) => r.id === logRuntimeId)}
          onClose={() => setLogRuntimeId(null)}
          actor={{
            teamId: team.name || activeTeamId || 'default',
            agentId: 'ui-client',
            agentName: 'ui',
            role: 'human',
          }}
          onAfterAction={refresh}
        />
      )}
      {shortcutsOpen && <ShortcutsModal onClose={() => setShortcutsOpen(false)} />}
      {tweaks.showNotifs && (
        <NotificationsDrawer team={team} onClose={() => setTweak('showNotifs', false)} />
      )}
      {tweaks.showProviders && (
        <ProvidersModal
          onClose={() => setTweak('showProviders', false)}
          onOpenSettings={() => setTweak('screen', 'settings')}
        />
      )}
      {tweaks.showRuntimes && (
        <RuntimeDrawer team={team} onClose={() => setTweak('showRuntimes', false)} />
      )}
      {tweaks.showDiagnostics && (
        <DiagnosticsDrawer onClose={() => setTweak('showDiagnostics', false)} />
      )}

      {tweaks.showTweaks && (
        <TweaksPanel tweaks={tweaks} setTweak={setTweak} title="Tweaks">
          <TweakSection label="Look & feel">
            <TweakRadio
              label="Theme"
              value={tweaks.theme}
              options={[
                { value: 'dark', label: 'Dark' },
                { value: 'light', label: 'Light' },
              ]}
              onChange={(v) => setTweak('theme', v)}
            />
            <TweakRadio
              label="Density"
              value={tweaks.density}
              options={[
                { value: 'comfy', label: 'Comfy' },
                { value: 'compact', label: 'Compact' },
              ]}
              onChange={(v) => setTweak('density', v)}
            />
            <TweakRadio
              label="Agent card"
              value={tweaks.cardVariant}
              options={[
                { value: 'detail', label: 'Detail' },
                { value: 'compact', label: 'Compact' },
                { value: 'terminal', label: 'Terminal' },
              ]}
              onChange={(v) => setTweak('cardVariant', v)}
            />
            <TweakSelect
              label="Layout"
              value={tweaks.layout}
              options={[
                { value: 'org', label: 'Org chart' },
                { value: 'chat', label: 'Chat-first' },
                { value: 'kanban', label: 'Kanban-first' },
              ]}
              onChange={(v) => setTweak('layout', v)}
            />
          </TweakSection>
          <TweakSection label="Navigation">
            <TweakSelect
              label="Screen"
              value={tweaks.screen}
              options={[
                { value: 'cockpit', label: 'Cockpit' },
                { value: 'workspace', label: 'Workspace' },
                { value: 'tasks', label: 'Tasks' },
                { value: 'foundry', label: 'Foundry' },
                { value: 'code', label: 'Code' },
                { value: 'settings', label: 'Settings' },
                { value: 'costs', label: 'Cost dashboard' },
                { value: 'audit', label: 'Audit log' },
                { value: 'drift', label: 'Drift monitor' },
                { value: 'picker', label: 'Project picker' },
                { value: 'empty', label: 'Empty workspace' },
                { value: 'create', label: 'Create team' },
                { value: 'launching', label: 'Team launching' },
                { value: 'task', label: 'Task detail' },
              ]}
              onChange={(v) => setTweak('screen', v)}
            />
          </TweakSection>
          <TweakSection label="Overlays">
            <TweakToggle
              label="Providers modal"
              value={tweaks.showProviders}
              onChange={(v) => setTweak('showProviders', v)}
            />
            <TweakToggle
              label="Notifications drawer"
              value={tweaks.showNotifs}
              onChange={(v) => setTweak('showNotifs', v)}
            />
            <TweakToggle
              label="Approvals drawer"
              value={tweaks.showApprovals}
              onChange={(v) => setTweak('showApprovals', v)}
            />
            <TweakToggle
              label="Runtime drawer"
              value={tweaks.showRuntimes}
              onChange={(v) => setTweak('showRuntimes', v)}
            />
            <TweakToggle
              label="Diagnostics drawer"
              value={tweaks.showDiagnostics}
              onChange={(v) => setTweak('showDiagnostics', v)}
            />
          </TweakSection>
          <TweakSection label="Onboarding">
            <TweakToggle
              label="First-run complete"
              value={tweaks.firstRunComplete}
              onChange={(v) => setTweak('firstRunComplete', v)}
            />
            <button
              type="button"
              className="btn btn-sm"
              style={{ alignSelf: 'flex-start', marginTop: 6 }}
              onClick={() => {
                setTweak('firstRunComplete', false);
                setTweak('screen', 'foundry');
              }}
            >
              Reset & re-show welcome banner
            </button>
          </TweakSection>
        </TweaksPanel>
      )}
    </div>
  );
}
