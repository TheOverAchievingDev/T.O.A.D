import type { Actor } from '@/api/client';
import type { Message, Runtime, Team, Tweaks, UiTask } from '@/types';
import type { StreamEntry } from '@/utils/agentStream';
import type { DriftRunResult } from '@/hooks/useDrift';
import type { BottomPanelTab } from './BottomPanel';
import { CockpitForMe } from './CockpitForMe';
import { CockpitWithMe } from './CockpitWithMe';

/**
 * Phase 2 Task 11 — CockpitScreenV2.
 *
 * Top-level switch that picks FOR-me or WITH-me based on
 * tweaks.developerMode. The persona pill in the Titlebar (Phase 1)
 * flips developerMode; the change cascades here and swaps the layout.
 *
 * Both child layouts accept their own focused prop shape, so this
 * component's job is just routing + passing the right slice of state.
 *
 * Phase 1's CockpitScreen.tsx (1,132 lines, the monolith) keeps
 * running until Task 12 retires it; the App.tsx call site swaps from
 * <CockpitScreen ... /> to <CockpitScreenV2 ... /> as part of this
 * task. CockpitScreen.tsx continues to mount when tweaks.screen ===
 * 'task' or 'create' (those two routes need TaskDetailModal-style
 * behavior that CockpitScreenV2 doesn't model — they remain on the
 * old screen until Phase 3 polish migrates them).
 */

export interface CockpitScreenV2Props {
  team: Team;
  tasks: UiTask[];
  runtimes: Runtime[];
  messages: Message[];
  agentStreams?: Record<string, StreamEntry[]>;
  actor?: Actor;
  drift: DriftRunResult | null;

  /** Persona — picks the layout. */
  developerMode: boolean;

  /** Tweaks state for Phase 2 panel toggles. */
  showBottomPanel: boolean;
  showRightPanel: boolean;
  bottomPanelTab: BottomPanelTab;
  rightPanelAgent: string | null;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;

  /** Reopen-flow context shown in FOR-me's banner. */
  reopenContext?: {
    teamId: string;
    teamName: string;
    isRunning: boolean;
    lastActiveAt: string | null;
    lastTask?: { taskId: string; subject: string; status: string };
    lastDriftScore?: { teamScore: number; status: string; runId: string; createdAt: string };
    lastCommit?: { sha: string; message: string; authoredAt: string | null };
  } | null;

  /** Callbacks — same handlers App.tsx wires for the existing Cockpit. */
  onResumeTeam?: () => void;
  onCreateTask?: () => void;
  onRefreshDrift?: () => Promise<void>;
  onOpenTaskDetail?: (taskId: string) => void;
  onOpenDriftScreen?: () => void;
  onMessageSent?: () => void;
}

export function CockpitScreenV2(props: CockpitScreenV2Props) {
  if (props.developerMode) {
    return (
      <CockpitWithMe
        team={props.team}
        tasks={props.tasks}
        runtimes={props.runtimes}
        messages={props.messages}
        agentStreams={props.agentStreams}
        actor={props.actor}
        showBottomPanel={props.showBottomPanel}
        showRightPanel={props.showRightPanel}
        bottomPanelTab={props.bottomPanelTab}
        rightPanelAgent={props.rightPanelAgent}
        setTweak={props.setTweak}
        onMessageSent={props.onMessageSent}
      />
    );
  }
  return (
    <CockpitForMe
      team={props.team}
      tasks={props.tasks}
      runtimes={props.runtimes}
      agentStreams={props.agentStreams}
      drift={props.drift}
      reopenContext={props.reopenContext}
      onResumeTeam={props.onResumeTeam}
      onCreateTask={props.onCreateTask}
      onRefreshDrift={props.onRefreshDrift}
      onOpenTaskDetail={props.onOpenTaskDetail}
      onOpenDriftScreen={props.onOpenDriftScreen}
    />
  );
}
