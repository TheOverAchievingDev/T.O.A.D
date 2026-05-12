import { useEffect, useMemo, useState } from 'react';
import { callTool, type Actor } from '@/api/client';
import type { Agent, Message, Runtime, Team, UiTask } from '@/types';
import type { StreamEntry } from '@/utils/agentStream';
import type { Tweaks } from '@/types';
import { Icon } from '../Icon';
import { IdeFileTree } from '../IdeFileTree';
import { type IdeTreeResult } from '../ideSource';
import {
  buildCodeTree,
  flattenVisibleCodeTree,
  type CodeTreeNode,
} from '../codeTreeNavigator';
import { PaneSplitter } from './PaneSplitter';
import { AgentCard } from './AgentCard';
import { BottomPanel, type BottomPanelTab } from './BottomPanel';
import { FileTabs, type OpenFile } from './FileTabs';
import { AgentInboxPanel } from './AgentInboxPanel';

/**
 * Phase 2 CockpitWithMe — code-first, Cursor-style layout for the
 * "AI builds it WITH me" persona. Per spec §8.1.
 *
 * Layout:
 *
 *   ┌──────────┬───────────────────────────────┬──────────────┐
 *   │          │  FileTabs                     │              │
 *   │  AGENT   ├───────────────────────────────┤  AGENT INBOX │
 *   │  CARDS   │                               │  (optional,  │
 *   │  (left)  │  Editor area (Phase 3 lands   │   toggled    │
 *   │          │  real Monaco; placeholder     │   via Ctrl+  │
 *   │          │  shows the active file path)  │   Alt+I)     │
 *   │          │                               │              │
 *   ├──────────┴───────────────────────────────┴──────────────┤
 *   │  BottomPanel (Terminal / Problems / Output / Validations)│
 *   └──────────────────────────────────────────────────────────┘
 *
 * Phase 2 scope deliberately keeps the editor integration light per
 * the plan's risk register — IdeEditorPane (Monaco) and IdeFileTree
 * have complex prop graphs that aren't worth rewiring just for the
 * persona-switch milestone. Phase 3 swaps in the real editor + tree.
 *
 * Today this component proves the LAYOUT and persona-toggle behavior:
 *   - Three vertical PaneSplitters compose the four regions.
 *   - File tabs row sits across the top of the editor pane.
 *   - Bottom panel appears when tweaks.showBottomPanel.
 *   - Right Agent Inbox appears when tweaks.showRightPanel.
 *   - All splitter sizes persist via localStorage.
 *
 * What you can do TODAY in WITH-me Cockpit:
 *   - See the team's agent cards in the left rail (same data as FOR-me)
 *   - Click an agent → opens the Agent Inbox right panel
 *     and selects them
 *   - Toggle bottom panel (Ctrl+J), right panel (Ctrl+Alt+I)
 *   - Resize every region; sizes stick across reloads
 *
 * What's NOT here yet (Phase 3):
 *   - File tree (left, below agents) — placeholder "no files yet" state
 *   - Monaco editor body — placeholder shows the active file path
 *   - Real Terminal / Problems / Output content
 *   - Drag-to-reorder file tabs
 */

export interface CockpitWithMeProps {
  team: Team;
  tasks: UiTask[];
  runtimes: Runtime[];
  messages: Message[];
  agentStreams?: Record<string, StreamEntry[]>;
  actor?: Actor;

  /** Phase 2 panel state — owned by App.tsx via tweaks. */
  showBottomPanel: boolean;
  showRightPanel: boolean;
  bottomPanelTab: BottomPanelTab;
  rightPanelAgent: string | null;
  setTweak: <K extends keyof Tweaks>(key: K, value: Tweaks[K]) => void;

  /** Optional message-refresh hook fired after Agent Inbox composer
   *  sends — same as the existing useToadData wiring. */
  onMessageSent?: () => void;
}

export function CockpitWithMe({
  team,
  tasks: _tasks,
  runtimes,
  messages,
  agentStreams = {},
  actor,
  showBottomPanel,
  showRightPanel,
  bottomPanelTab,
  rightPanelAgent,
  setTweak,
  onMessageSent,
}: CockpitWithMeProps) {
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(
    () => (rightPanelAgent ?? team.members.find((m) => m.role === 'lead')?.id ?? team.members[0]?.id ?? null),
  );

  // Phase 3a Task 1: real file-tree state. Loaded on mount via the
  // existing ide_tree_list MCP method; same source the Code screen uses.
  const [openFiles, setOpenFiles] = useState<OpenFile[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [tree, setTree] = useState<IdeTreeResult | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [treeError, setTreeError] = useState<string | null>(null);

  // Load the project file tree on mount + whenever the team changes.
  // Mirrors CodeScreen's loadTree logic but trimmed: no git-status
  // enrichment, no checkpoint plumbing — Phase 3d's Code screen polish
  // is the better place to share that logic via a hook. Phase 3a Task 1
  // keeps it inline so the diff stays small.
  const treeActor: Actor = useMemo(
    () => ({
      teamId: team.name || 'system',
      agentId: 'ui-client',
      agentName: 'ui',
      role: 'human',
    }),
    [team.name],
  );

  useEffect(() => {
    let cancelled = false;
    if (!team.name) {
      setTree(null);
      return;
    }
    (async () => {
      setTreeError(null);
      try {
        const result = await callTool<IdeTreeResult>({
          actor: treeActor,
          method: 'ide_tree_list',
          args: { source: { kind: 'project' } },
        });
        if (cancelled) return;
        setTree(result);
        // Auto-expand the root one level so the user sees content.
        setExpandedPaths((prev) => {
          if (prev.size > 0) return prev;
          const next = new Set<string>();
          for (const entry of result.entries) {
            if (entry.kind === 'directory' && entry.path.indexOf('/') < 0) {
              next.add(entry.path);
            }
          }
          return next;
        });
      } catch (err) {
        if (cancelled) return;
        setTreeError(err instanceof Error ? err.message : String(err));
        setTree(null);
      }
    })();
    return () => { cancelled = true; };
  }, [team.name, treeActor]);

  // Build the hierarchical tree from the flat entries the MCP method
  // returns. Memoized so re-renders don't rebuild unless entries change.
  const treeNodes: CodeTreeNode[] = useMemo(
    () => (tree ? buildCodeTree(tree.entries) : []),
    [tree],
  );
  const visibleNodes: CodeTreeNode[] = useMemo(
    () => flattenVisibleCodeTree(treeNodes, expandedPaths),
    [treeNodes, expandedPaths],
  );

  const handleToggleDirectory = (path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const handleOpenFile = (path: string) => {
    setOpenFiles((prev) => {
      if (prev.some((f) => f.path === path)) return prev;
      return [...prev, { path }];
    });
    setActivePath(path);
  };

  const runtimeByAgent = useMemo(() => {
    const m = new Map<string, Runtime>();
    for (const r of runtimes) if (r.agent) m.set(r.agent, r);
    return m;
  }, [runtimes]);

  const handleAgentSelect = (id: string) => {
    setSelectedAgentId(id);
    // Auto-open the right panel when an agent is picked from the rail —
    // operators are signaling "I want to talk to this person."
    if (!showRightPanel) setTweak('showRightPanel', true);
    setTweak('rightPanelAgent', id);
  };

  const closeFile = (path: string) => {
    setOpenFiles((prev) => prev.filter((f) => f.path !== path));
    if (activePath === path) {
      const remaining = openFiles.filter((f) => f.path !== path);
      setActivePath(remaining[0]?.path ?? null);
    }
  };

  // Outer top region: file tabs + editor body. Outer column splitter
  // wraps left rail | (editor + optional right inbox). Inner splitter
  // (anchorEnd) sizes the right panel when shown.
  const topRegion = (
    <PaneSplitter
      orientation="horizontal"
      defaultSize={260}
      minSize={220}
      maxSize={400}
      storageKey="cockpit.withMe.leftCol"
    >
      {/* LEFT rail — file tree on top + agent column below.
          Phase 3a Task 1 wires the real IdeFileTree (loaded via
          ide_tree_list MCP) above the agent stack, splitting them
          with a vertical PaneSplitter so the operator can resize. */}
      <div className="cockpit-with-left">
        <PaneSplitter
          orientation="vertical"
          defaultSize={320}
          minSize={120}
          maxSize={640}
          storageKey="cockpit.withMe.fileTreeHeight"
        >
          {/* TOP: file tree */}
          <div className="cockpit-with-tree">
            <div className="cockpit-col-head">
              <h4>FILES</h4>
              {tree?.rootLabel && (
                <span className="cockpit-col-sub mono" title={tree.rootLabel}>
                  {tree.rootLabel.length > 22 ? `…${tree.rootLabel.slice(-22)}` : tree.rootLabel}
                </span>
              )}
            </div>
            <div className="cockpit-with-tree-body">
              {treeError && (
                <div className="cockpit-with-tree-error">{treeError}</div>
              )}
              {!treeError && tree && visibleNodes.length === 0 && (
                <div className="cockpit-with-tree-empty">Project is empty.</div>
              )}
              {!treeError && !tree && (
                <div className="cockpit-with-tree-empty">Loading…</div>
              )}
              {!treeError && tree && visibleNodes.length > 0 && (
                <IdeFileTree
                  nodes={visibleNodes}
                  expandedPaths={expandedPaths}
                  activePath={activePath}
                  onToggleDirectory={handleToggleDirectory}
                  onOpenFile={handleOpenFile}
                />
              )}
            </div>
          </div>
          {/* BOTTOM: agent column */}
          <div className="cockpit-with-agents">
            <div className="cockpit-col-head">
              <h4>TEAM</h4>
              <span className="cockpit-col-sub">{team.members.length} agents</span>
            </div>
            <div className="cockpit-col-body">
              {team.members.map((a: Agent) => (
                <AgentCard
                  key={a.id}
                  agent={a}
                  runtime={runtimeByAgent.get(a.id) ?? null}
                  active={selectedAgentId === a.id}
                  onSelect={handleAgentSelect}
                />
              ))}
            </div>
          </div>
        </PaneSplitter>
      </div>

      {/* RIGHT of outer splitter: editor + optional right panel */}
      {showRightPanel ? (
        <PaneSplitter
          orientation="horizontal"
          defaultSize={360}
          minSize={280}
          maxSize={520}
          storageKey="cockpit.withMe.rightCol"
          anchorEnd
        >
          <EditorRegion
            openFiles={openFiles}
            activePath={activePath}
            onActivate={setActivePath}
            onCloseFile={closeFile}
          />
          <AgentInboxPanel
            team={team}
            messages={messages}
            agentStreams={agentStreams}
            actor={actor}
            selectedAgentId={selectedAgentId}
            onSelectAgent={(id) => {
              setSelectedAgentId(id);
              setTweak('rightPanelAgent', id);
            }}
            onClose={() => setTweak('showRightPanel', false)}
            onMessageSent={onMessageSent}
          />
        </PaneSplitter>
      ) : (
        <EditorRegion
          openFiles={openFiles}
          activePath={activePath}
          onActivate={setActivePath}
          onCloseFile={closeFile}
        />
      )}
    </PaneSplitter>
  );

  return (
    <div className="cockpit-with">
      {showBottomPanel ? (
        <PaneSplitter
          orientation="vertical"
          defaultSize={220}
          minSize={120}
          maxSize={520}
          storageKey="cockpit.withMe.bottomPanelHeight"
          anchorEnd
        >
          {topRegion}
          <BottomPanel
            activeTab={bottomPanelTab}
            onChangeTab={(tab) => setTweak('bottomPanelTab', tab)}
            onClose={() => setTweak('showBottomPanel', false)}
          />
        </PaneSplitter>
      ) : (
        topRegion
      )}
    </div>
  );
}

function EditorRegion({
  openFiles,
  activePath,
  onActivate,
  onCloseFile,
}: {
  openFiles: OpenFile[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onCloseFile: (path: string) => void;
}) {
  return (
    <div className="cockpit-with-editor">
      <FileTabs
        files={openFiles}
        activePath={activePath}
        onActivate={onActivate}
        onClose={onCloseFile}
      />
      <div className="cockpit-with-editor-body">
        {activePath ? (
          <div className="cockpit-with-editor-placeholder mono">
            <Icon name="code" size={16} />
            <span>{activePath}</span>
            <span className="hint">Monaco editor lands Phase 3.</span>
          </div>
        ) : (
          <div className="cockpit-with-editor-empty">
            <Icon name="code" size={20} />
            <div className="title">No file open</div>
            <div className="hint">
              Phase 3 wires the file tree + Monaco editor. Until then this is
              an empty editor pane.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
