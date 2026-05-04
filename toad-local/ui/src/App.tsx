import { useCallback, useEffect, useMemo, useState } from 'react';
import { Titlebar } from '@/components/Titlebar';
import { SidebarNav, type SidebarKey } from '@/components/SidebarNav';
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
import { OnboardingScreen } from '@/components/OnboardingScreen';
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
import { ShortcutsModal } from '@/components/ShortcutsModal';
import { useShortcutsHotkey } from '@/hooks/useShortcutsHotkey';
import {
  TweaksPanel,
  TweakSection,
  TweakRadio,
  TweakSelect,
  TweakToggle,
} from '@/components/TweaksPanel';
import { useTweaks } from '@/hooks/useTweaks';
import { useToadData } from '@/hooks/useToadData';
import { useSettings } from '@/hooks/useSettings';
import { useCommandActions } from '@/hooks/useCommandActions';
import { useCommandPaletteHotkey } from '@/hooks/useCommandPaletteHotkey';
import { useEventToasts, type NotificationsConfig } from '@/hooks/useEventToasts';
import { pickAndSwitchProjectFolder, getSavedProjectPath, clearSavedProjectPath } from '@/integrations/tauri';
import { callTool as callToadApi } from '@/api/client';

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
  const projectRegistry = useProjects();

  const pickProjectFolder = useCallback(async () => {
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
    setTweak('screen', 'workspace');
    refresh();
  }, [projectRegistry, refresh, setTweak]);

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

  // First-run UX: when no project has been opened yet, force the picker
  // screen. Without this the user lands on the workspace with no real
  // data and no obvious "where do I start" affordance.
  useEffect(() => {
    if (projectRegistry.projects.length === 0 && tweaks.screen !== 'picker' && tweaks.screen !== 'create' && tweaks.screen !== 'settings' && tweaks.screen !== 'foundry' && tweaks.screen !== 'drift') {
      setTweak('screen', 'picker');
    }
  }, [projectRegistry.projects.length, tweaks.screen, setTweak]);

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
    setTweak('screen', 'workspace');
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
    if (tweaks.screen === 'costs') return 'costs';
    if (tweaks.screen === 'drift') return 'drift';
    if (tweaks.screen === 'tasks') return 'tasks';
    return 'workspace';
  }, [tweaks]);

  function handleNavSelect(key: SidebarKey) {
    switch (key) {
      case 'workspace':
        setTweak('screen', 'workspace');
        return;
      case 'tasks':
        setTweak('screen', 'tasks');
        return;
      case 'foundry':
        setTweak('screen', 'foundry');
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

  const isOverlayScreen =
    tweaks.screen === 'empty' ||
    tweaks.screen === 'onboarding' ||
    tweaks.screen === 'picker';

  return (
    <div className="win">
      <Titlebar
        theme={tweaks.theme}
        runtimes={runtimes}
        projects={projectRegistry.projects}
        activeProjectId={projectRegistry.activeId}
        onSelectProject={projectRegistry.setActive}
        onAddProject={() => setAddProjectOpen(true)}
        onCloseProject={projectRegistry.removeProject}
        onToggleTheme={() => setTweak('theme', tweaks.theme === 'dark' ? 'light' : 'dark')}
        onCreateTeam={() => setTweak('screen', 'create')}
        onOpenProviders={() => setTweak('showProviders', true)}
        onOpenNotifs={() => setTweak('showNotifs', true)}
        onOpenApprovals={() => setTweak('showApprovals', true)}
        onOpenDiagnostics={() => setTweak('showDiagnostics', true)}
        onToggleTweaks={() => setTweak('screen', 'settings')}
        onOpenCommandPalette={togglePalette}
        pendingApprovalCount={pendingApprovals}
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
        <SidebarNav
          active={activeNav}
          onSelect={handleNavSelect}
          pendingApprovals={pendingApprovals}
        />

        <div className="app-main">
          {/* Primary screen — workspace or one of the alt screens. */}
          {tweaks.screen === 'empty' && (
            <EmptyWorkspace onCreateTeam={() => setTweak('screen', 'create')} />
          )}
          {tweaks.screen === 'onboarding' && (
            <OnboardingScreen onDone={() => setTweak('screen', 'workspace')} />
          )}
          {tweaks.screen === 'picker' && (
            <ProjectPicker
              projects={projectRegistry.projects}
              activeId={projectRegistry.activeId}
              onOpenProject={(id) => {
                projectRegistry.setActive(id);
                setTweak('screen', 'workspace');
              }}
              onCreateTeam={() => setTweak('screen', 'create')}
              onSelectFolder={pickProjectFolder}
              onStartNewProject={() => setTweak('screen', 'foundry')}
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
            />
          )}
          {tweaks.screen === 'foundry' && (
            <FoundryScreen
              teamId={team.name || activeTeamId || 'foundry'}
              hasActiveProject={projectRegistry.activeId !== null}
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
                setTweak('screen', 'workspace');
              }}
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
                setTweak('screen', 'workspace');
              }}
              onCancel={() => {
                setLaunchingTeamId(null);
                setTweak('screen', 'workspace');
              }}
            />
          )}
          {tweaks.screen === 'settings' && (
            <SettingsScreen
              tweaks={tweaks}
              setTweak={setTweak}
              onClose={() => setTweak('screen', 'workspace')}
            />
          )}
          {(tweaks.screen === 'workspace' || tweaks.screen === 'create' || tweaks.screen === 'task') && !isOverlayScreen && (
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
            />
          )}
        </div>
      </div>

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
            setTweak('screen', 'workspace');
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
            setTweak('screen', 'workspace');
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
            const created = projectRegistry.addProject(input);
            projectRegistry.setActive(created.id);
            refresh();
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
                { value: 'workspace', label: 'Workspace' },
                { value: 'tasks', label: 'Tasks' },
                { value: 'foundry', label: 'Foundry' },
                { value: 'settings', label: 'Settings' },
                { value: 'costs', label: 'Cost dashboard' },
                { value: 'audit', label: 'Audit log' },
                { value: 'drift', label: 'Drift monitor' },
                { value: 'picker', label: 'Project picker' },
                { value: 'empty', label: 'Empty workspace' },
                { value: 'onboarding', label: 'Onboarding' },
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
        </TweaksPanel>
      )}
    </div>
  );
}
