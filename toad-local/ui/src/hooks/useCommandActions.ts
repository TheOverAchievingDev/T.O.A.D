import { useMemo } from 'react';
import type { Team, Tweaks, UiTask, Runtime } from '@/types';
import type { CommandAction } from '@/components/CommandPalette';
import type { SetTweak } from '@/components/TweaksPanel';

interface UseCommandActionsArgs {
  team: Team;
  tasks: UiTask[];
  runtimes?: Runtime[];
  tweaks: Tweaks;
  setTweak: SetTweak;
  onOpenTask: (id: string) => void;
  onOpenAgent: (id: string) => void;
  onCreateTeam: () => void;
  onCreateTask: () => void;
  onRefresh: () => void;
  onOpenLogs?: (runtimeId: string) => void;
  onShowShortcuts?: () => void;
}

/** Compose every actionable destination/toggle/operation in the app into a flat
 * list the CommandPalette can search.
 *
 * Recipe: keep this hook the *only* place command IDs live, so adding a new
 * surface = adding entries here, not threading new props into CommandPalette.
 */
export function useCommandActions({
  team, tasks, runtimes = [], tweaks, setTweak,
  onOpenTask, onOpenAgent, onCreateTeam, onCreateTask, onRefresh, onOpenLogs, onShowShortcuts,
}: UseCommandActionsArgs): CommandAction[] {
  return useMemo<CommandAction[]>(() => {
    const actions: CommandAction[] = [];

    // ---- Navigate ----
    actions.push(
      { id: 'nav.workspace', group: 'Navigate', label: 'Go to Cockpit', icon: 'layers', hint: 'IDE',
        keywords: ['home', 'team', 'org', 'chart', 'ide', 'cockpit'],
        run: () => setTweak('screen', 'cockpit') },
      { id: 'nav.tasks', group: 'Navigate', label: 'Go to Tasks', icon: 'kanban', hint: 'kanban',
        keywords: ['kanban', 'list', 'todo'],
        run: () => setTweak('screen', 'tasks') },
      { id: 'nav.foundry', group: 'Navigate', label: 'Go to Foundry', icon: 'sparkle',
        keywords: ['plan', 'spec', 'roadmap', 'requirements', 'docs'],
        run: () => setTweak('screen', 'foundry') },
      { id: 'nav.costs', group: 'Navigate', label: 'Go to Cost dashboard', icon: 'sparkle',
        keywords: ['cost', 'token', 'spend', 'budget', 'usage', 'billing'],
        run: () => setTweak('screen', 'costs') },
      { id: 'nav.audit', group: 'Navigate', label: 'Go to Audit log', icon: 'list',
        keywords: ['audit', 'log', 'history', 'events', 'trail'],
        run: () => setTweak('screen', 'audit') },
      { id: 'nav.settings', group: 'Navigate', label: 'Go to Settings', icon: 'settings',
        keywords: ['preferences', 'config', 'options', 'github', 'providers', 'risk'],
        run: () => setTweak('screen', 'settings') },
      { id: 'nav.runtimes', group: 'Navigate', label: 'Open Runtimes drawer', icon: 'cpu',
        keywords: ['processes', 'pids'],
        run: () => setTweak('showRuntimes', true) },
      { id: 'nav.approvals', group: 'Navigate', label: 'Open Approvals drawer', icon: 'check',
        keywords: ['gate', 'review', 'risk', 'human approval'],
        run: () => setTweak('showApprovals', true) },
      { id: 'nav.diagnostics', group: 'Navigate', label: 'Open Diagnostics drawer', icon: 'info',
        keywords: ['health', 'checks'],
        run: () => setTweak('showDiagnostics', true) },
      { id: 'nav.notifs', group: 'Navigate', label: 'Open Notifications drawer', icon: 'bell',
        keywords: ['alerts', 'messages'],
        run: () => setTweak('showNotifs', true) },
      { id: 'nav.providers', group: 'Navigate', label: 'Open Providers modal', icon: 'cpu',
        keywords: ['anthropic', 'openai', 'opencode', 'models'],
        run: () => setTweak('showProviders', true) },
      { id: 'nav.picker', group: 'Navigate', label: 'Open Project picker', icon: 'folder',
        keywords: ['project', 'switch', 'open'],
        run: () => setTweak('screen', 'picker') },
      { id: 'nav.empty', group: 'Navigate', label: 'Open Empty workspace', icon: 'inbox',
        keywords: ['no team', 'placeholder'],
        run: () => setTweak('screen', 'empty') },
    );

    // ---- Actions ----
    actions.push(
      { id: 'action.create-task', group: 'Actions', label: 'Create new task', icon: 'plus',
        hint: 'task', keywords: ['new', 'add', 'todo', 'kanban'],
        run: onCreateTask },
      { id: 'action.create-team', group: 'Actions', label: 'Create new team', icon: 'plus',
        hint: 'team', keywords: ['new', 'add', 'spawn'],
        run: onCreateTeam },
      { id: 'action.refresh', group: 'Actions', label: 'Refresh data', icon: 'play',
        keywords: ['reload', 'sync', 'fetch'],
        run: onRefresh },
      { id: 'action.toggle-theme', group: 'Actions', label: `Toggle theme (currently ${tweaks.theme})`, icon: tweaks.theme === 'dark' ? 'sun' : 'moon',
        keywords: ['dark', 'light', 'appearance'],
        run: () => setTweak('theme', tweaks.theme === 'dark' ? 'light' : 'dark') },
      { id: 'action.toggle-tweaks', group: 'Actions', label: tweaks.showTweaks ? 'Hide Tweaks panel' : 'Show Tweaks panel', icon: 'settings',
        keywords: ['dev', 'debug', 'panel'],
        run: () => setTweak('showTweaks', !tweaks.showTweaks) },
    );

    if (onShowShortcuts) {
      actions.push({
        id: 'action.shortcuts',
        group: 'Actions',
        label: 'Show keyboard shortcuts',
        icon: 'info',
        hint: '?',
        keywords: ['help', 'kbd', 'keys', 'hotkeys'],
        run: onShowShortcuts,
      });
    }

    // ---- Settings ----
    actions.push(
      { id: 'settings.density.comfy', group: 'Settings', label: 'Density: Comfy', icon: 'layers',
        keywords: ['spacing', 'comfortable'],
        run: () => setTweak('density', 'comfy') },
      { id: 'settings.density.compact', group: 'Settings', label: 'Density: Compact', icon: 'layers',
        keywords: ['spacing', 'tight', 'dense'],
        run: () => setTweak('density', 'compact') },
      { id: 'settings.cardvariant.detail', group: 'Settings', label: 'Agent card: Detail', icon: 'user',
        keywords: ['style', 'big'],
        run: () => setTweak('cardVariant', 'detail') },
      { id: 'settings.cardvariant.compact', group: 'Settings', label: 'Agent card: Compact', icon: 'user',
        keywords: ['style', 'small'],
        run: () => setTweak('cardVariant', 'compact') },
      { id: 'settings.cardvariant.terminal', group: 'Settings', label: 'Agent card: Terminal', icon: 'terminal',
        keywords: ['style', 'mono'],
        run: () => setTweak('cardVariant', 'terminal') },
      { id: 'settings.layout.org', group: 'Settings', label: 'Layout: Org chart', icon: 'layers',
        run: () => setTweak('layout', 'org') },
      { id: 'settings.layout.chat', group: 'Settings', label: 'Layout: Chat-first', icon: 'inbox',
        run: () => setTweak('layout', 'chat') },
      { id: 'settings.layout.kanban', group: 'Settings', label: 'Layout: Kanban-first', icon: 'kanban',
        run: () => setTweak('layout', 'kanban') },
    );

    // ---- Tasks (one entry per task) ----
    for (const t of tasks) {
      actions.push({
        id: `task.${t.id}`,
        group: 'Tasks',
        label: `${t.id} — ${t.title}`,
        icon: 'file',
        hint: t.status,
        keywords: [t.status, t.assignee, t.project],
        run: () => onOpenTask(t.id),
      });
    }

    // ---- Runtimes (one entry per live/idle runtime, opens log viewer) ----
    if (onOpenLogs) {
      for (const r of runtimes) {
        const member = team.members.find((m) => m.id === r.agent);
        const display = member ? member.name : r.agent;
        actions.push({
          id: `runtime.${r.id}`,
          group: 'Agents',
          label: `View logs · ${display}`,
          icon: 'terminal',
          hint: r.status,
          keywords: [r.provider, r.model, 'logs', 'runtime', String(r.pid)],
          run: () => onOpenLogs(r.id),
        });
      }
    }

    // ---- Agents (one entry per team member) ----
    for (const m of team.members) {
      actions.push({
        id: `agent.${m.id}`,
        group: 'Agents',
        label: `${m.name} — ${m.role}`,
        icon: 'user',
        hint: m.status,
        keywords: [m.role, m.provider, m.model, m.status],
        run: () => onOpenAgent(m.id),
      });
    }

    return actions;
  }, [team, tasks, runtimes, tweaks, setTweak, onOpenTask, onOpenAgent, onCreateTeam, onCreateTask, onRefresh, onOpenLogs, onShowShortcuts]);
}
