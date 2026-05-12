import { useCallback, useEffect, useMemo, useState } from 'react';
import { callTool, type Actor } from '@/api/client';
import type { Agent, Message, Runtime, Team, UiTask } from '@/types';
import type { StreamEntry } from '@/utils/agentStream';
import type { Tweaks } from '@/types';
import type { DriftRunResult } from '@/hooks/useDrift';
import { IdeFileTree } from '../IdeFileTree';
import { IdeEditorPane } from '../IdeEditorPane';
import { type IdeSource, type IdeTreeResult } from '../ideSource';
import {
  buildCodeTree,
  flattenVisibleCodeTree,
  type CodeTreeNode,
} from '../codeTreeNavigator';
import { PaneSplitter } from './PaneSplitter';
import { AgentCard } from './AgentCard';
import { BottomPanel, type BottomPanelTab } from './BottomPanel';
import { BottomPanelOutput } from './BottomPanelOutput';
import { BottomPanelValidations } from './BottomPanelValidations';
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

  /** Drift data — drives the editor's drift-annotation gutter when
   *  Phase 3a Task 2 lands Monaco. */
  drift?: DriftRunResult | null;

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
  tasks,
  runtimes,
  messages,
  agentStreams = {},
  actor,
  drift = null,
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

  // Phase 3a Task 1+2: real file tree + Monaco editor wiring. The
  // editor (IdeEditorPane) manages its own tabs internally — we no
  // longer maintain an openFiles array in CockpitWithMe. Instead we
  // fire an externalOpenRequest at the editor whenever the user
  // clicks a file in the tree; IdeEditorPane handles "is this tab
  // already open / load file / dirty state / save / diff mode" etc.
  const [tree, setTree] = useState<IdeTreeResult | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [treeError, setTreeError] = useState<string | null>(null);
  // externalOpenRequest carries a monotonic requestId so IdeEditorPane
  // re-fires open even if the same path is clicked twice.
  const [externalOpenRequest, setExternalOpenRequest] = useState<
    { sourceKey: string; path: string; requestId: number } | null
  >(null);
  const [openRequestCounter, setOpenRequestCounter] = useState(0);
  const [activePath, setActivePath] = useState<string | null>(null);

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

  const handleOpenFile = useCallback((path: string) => {
    setActivePath(path);
    setOpenRequestCounter((c) => {
      const next = c + 1;
      setExternalOpenRequest({ sourceKey: 'project', path, requestId: next });
      return next;
    });
  }, []);

  // Refresh-tree callback fired by IdeEditorPane after a save.
  const refreshTree = useCallback(async (_pathToReopen: string | null = null) => {
    if (!team.name) return;
    try {
      const result = await callTool<IdeTreeResult>({
        actor: treeActor,
        method: 'ide_tree_list',
        args: { source: { kind: 'project' } },
      });
      setTree(result);
    } catch (err) {
      setTreeError(err instanceof Error ? err.message : String(err));
    }
  }, [team.name, treeActor]);

  // Build the IdeSource the editor pane consumes. CockpitWithMe always
  // operates on the project root (not a task worktree); task-scoped
  // editing remains the Code screen's job.
  const editorSource: IdeSource = useMemo(() => ({ kind: 'project' }), []);

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
            source={editorSource}
            actor={treeActor}
            drift={drift}
            externalOpenRequest={externalOpenRequest}
            onRefreshTreeRequest={refreshTree}
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
          source={editorSource}
          actor={treeActor}
          drift={drift}
          externalOpenRequest={externalOpenRequest}
          onRefreshTreeRequest={refreshTree}
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
            outputCount={Object.values(agentStreams).reduce((n, arr) => n + arr.length, 0)}
            outputSlot={<BottomPanelOutput team={team} agentStreams={agentStreams} />}
            validationsSlot={<BottomPanelValidations tasks={tasks} />}
            // Phase 3a Task 3 ships Output + Validations slots; Terminal
            // and Problems land in Phase 5 (xterm wiring + LSP).
            // BottomPanel's empty-state render kicks in for those slots.
          />
        </PaneSplitter>
      ) : (
        topRegion
      )}
    </div>
  );
}

function EditorRegion({
  source,
  actor,
  drift,
  externalOpenRequest,
  onRefreshTreeRequest,
}: {
  source: IdeSource;
  actor: Actor;
  drift: DriftRunResult | null;
  externalOpenRequest: { sourceKey: string; path: string; requestId: number } | null;
  onRefreshTreeRequest?: (path: string | null) => void;
}) {
  // Phase 3a Task 2 — replaced the placeholder card with the real
  // IdeEditorPane. The pane manages its own tab strip (so we don't
  // render our Phase 2 FileTabs here; keeping two parallel tab UIs
  // would confuse users). Phase 3 polish can re-introduce a custom
  // tab strip on top of IdeEditorPane once the in-scope-for chip
  // and drag-reorder land (Task 4 + per-task scope chips).
  return (
    <div className="cockpit-with-editor">
      <IdeEditorPane
        source={source}
        actor={actor}
        driftData={drift}
        // CockpitWithMe always operates on the project root — task-
        // worktree editing is the Code screen's domain. No agent
        // filter; an empty list is correct here.
        activeAgentsInWorktree={[]}
        externalOpenRequest={externalOpenRequest}
        onRefreshTreeRequest={onRefreshTreeRequest}
      />
    </div>
  );
}
