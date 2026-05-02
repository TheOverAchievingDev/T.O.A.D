import { useCallback, useEffect, useMemo, useState } from 'react';
import { Titlebar } from '@/components/Titlebar';
import { SidebarNav, type SidebarKey } from '@/components/SidebarNav';
import { Workspace } from '@/components/Workspace';
import { TasksScreen } from '@/components/TasksScreen';
import { CreateTeamModal } from '@/components/CreateTeamModal';
import { TaskDetailModal } from '@/components/TaskDetailModal';
import { TaskCreationModal } from '@/components/TaskCreationModal';
import { TeamLaunchingScreen } from '@/components/TeamLaunchingScreen';
import { AddProjectModal } from '@/components/AddProjectModal';
import { useProjects } from '@/hooks/useProjects';
import { ApprovalsDrawer } from '@/components/ApprovalsDrawer';
import { EmptyWorkspace } from '@/components/EmptyWorkspace';
import { OnboardingScreen } from '@/components/OnboardingScreen';
import { ProjectPicker } from '@/components/ProjectPicker';
import { ProvidersModal } from '@/components/ProvidersModal';
import { NotificationsDrawer } from '@/components/NotificationsDrawer';
import { RuntimeDrawer } from '@/components/RuntimeDrawer';
import { DiagnosticsDrawer } from '@/components/DiagnosticsDrawer';
import { CommandPalette } from '@/components/CommandPalette';
import { SettingsScreen } from '@/components/settings/SettingsScreen';
import { ToastProvider } from '@/components/ToastSystem';
import { LogViewerDrawer } from '@/components/LogViewerDrawer';
import { CostsScreen } from '@/components/CostsScreen';
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

export default function App() {
  return (
    <ToastProvider max={6}>
      <AppInner />
    </ToastProvider>
  );
}

function AppInner() {
  const [tweaks, setTweak] = useTweaks();
  const { team, tasks, runtimes, messages, loading, error, liveSource, refresh } = useToadData();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [taskCreateOpen, setTaskCreateOpen] = useState(false);
  const [launchingTeamId, setLaunchingTeamId] = useState<string | null>(null);
  const [addProjectOpen, setAddProjectOpen] = useState(false);
  const [logRuntimeId, setLogRuntimeId] = useState<string | null>(null);
  const projectRegistry = useProjects();

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

  // Pending-approval count (seed-derived for now — Phase 3 will wire to a
  // real `approvals_list` query).
  const pendingApprovals = 4;

  // The sidebar key reflects the active nav target. Drawer nav items don't
  // change `tweaks.screen` — they toggle the corresponding drawer instead.
  const activeNav: SidebarKey = useMemo(() => {
    if (tweaks.showApprovals) return 'approvals';
    if (tweaks.showDiagnostics) return 'diagnostics';
    if (tweaks.showRuntimes) return 'runtimes';
    if (tweaks.screen === 'settings') return 'settings';
    if (tweaks.screen === 'costs') return 'costs';
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
      case 'runtimes':
        setTweak('showRuntimes', true);
        return;
      case 'approvals':
        setTweak('showApprovals', true);
        return;
      case 'costs':
        setTweak('screen', 'costs');
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
          <span>API not reachable — showing seed data. {error}</span>
          <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} onClick={refresh}>
            Retry
          </button>
        </div>
      )}

      {liveSource === 'seed' && !error && loading && (
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
              team={team}
              onOpenTeam={() => setTweak('screen', 'workspace')}
              onCreateTeam={() => setTweak('screen', 'create')}
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
          {tweaks.screen === 'costs' && (
            <CostsScreen team={team} runtimes={runtimes} />
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
            />
          )}
        </div>
      </div>

      {tweaks.screen === 'create' && (
        <CreateTeamModal
          onClose={() => setTweak('screen', 'workspace')}
          onCreated={(teamId) => {
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
          onClose={() => setTaskCreateOpen(false)}
          onCreated={() => refresh()}
        />
      )}

      {tweaks.showApprovals && (
        <ApprovalsDrawer team={team} onClose={() => setTweak('showApprovals', false)} />
      )}
      {logRuntimeId && (
        <LogViewerDrawer
          runtimeId={logRuntimeId}
          title={runtimes.find((r) => r.id === logRuntimeId)?.agent}
          onClose={() => setLogRuntimeId(null)}
        />
      )}
      {tweaks.showNotifs && (
        <NotificationsDrawer team={team} onClose={() => setTweak('showNotifs', false)} />
      )}
      {tweaks.showProviders && <ProvidersModal onClose={() => setTweak('showProviders', false)} />}
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
                { value: 'settings', label: 'Settings' },
                { value: 'costs', label: 'Cost dashboard' },
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
