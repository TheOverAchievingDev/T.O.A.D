import { useEffect, useMemo, useState } from 'react';
import { callTool, type Actor } from '@/api/client';
import type { UiTask, Runtime } from '@/types';
import type { ProjectEntry } from '@/hooks/useProjects';
import { Icon } from './Icon';
import {
  buildCodeTree,
  collectDirectoryPaths,
  filterCodeTree,
  flattenVisibleCodeTree,
} from './codeTreeNavigator';
import type { DriftRunResult } from '@/hooks/useDrift';
import { IdeFileTree } from './IdeFileTree';
import { IdeEditorPane } from './IdeEditorPane';
import {
  sourceKeyToIdeSource,
  type IdeSource,
  type IdeStatusResult,
  type IdeTreeResult,
} from './ideSource';

type CodeTask = UiTask & {
  worktree?: {
    status?: string;
    path?: string;
    branch?: string | null;
  } | null;
};

interface CodeScreenProps {
  teamId: string | null;
  tasks: CodeTask[];
  actor?: Actor;
  projects?: ProjectEntry[];
  activeProject?: ProjectEntry | null;
  onSelectProject?: (projectId: string) => void;
  onSelectFolder?: () => void;
  driftData?: DriftRunResult | null;
  runtimes?: Runtime[];
  mode?: 'standalone' | 'cockpit';
  externalOpenRequest?: {
    sourceKey: string;
    path: string;
    requestId: number;
  } | null;
}

const DEFAULT_ACTOR: Actor = { teamId: 'system', agentId: 'ui-client', agentName: 'ui', role: 'human' };

export function CodeScreen({
  teamId,
  tasks,
  actor = DEFAULT_ACTOR,
  projects = [],
  activeProject = null,
  onSelectProject,
  onSelectFolder,
  driftData,
  runtimes = [],
  mode = 'standalone',
  externalOpenRequest = null,
}: CodeScreenProps) {
  const [sourceKey, setSourceKey] = useState('project');
  const [tree, setTree] = useState<IdeTreeResult | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [treeQuery, setTreeQuery] = useState('');
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => new Set());
  const [loadingTree, setLoadingTree] = useState(false);

  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [pendingExternalOpen, setPendingExternalOpen] = useState<{ sourceKey: string; path: string; requestId: number } | null>(null);

  const [leftPaneMode, setLeftPaneMode] = useState<'tree' | 'search'>('tree');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{relativePath: string, lineNumber: number, content: string}[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const worktreeTasks = useMemo(
    () => tasks.filter((task) => task.worktree?.status === 'created' && task.worktree.path),
    [tasks],
  );

  const activeAgentsInWorktree = useMemo(() => {
    if (!sourceKey.startsWith('task:')) return [];
    const taskId = sourceKey.slice(5);
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status === 'done' || task.status === 'rejected') return [];
    const assignee = task.assignee || 'lead';
    return runtimes.filter(r => (r.agent === assignee || r.agent === 'lead') && (r.status === 'live' || r.status === 'launching'));
  }, [sourceKey, tasks, runtimes]);

  const source = useMemo<IdeSource>(() => sourceKeyToIdeSource(sourceKey), [sourceKey]);
  const showChrome = mode === 'standalone';
  const showExplorer = mode === 'standalone';

  const effectiveTeamId = teamId ?? actor.teamId;
  const rootLabel =
    source.kind === 'task_worktree'
      ? (tree?.rootLabel ?? 'Task worktree')
      : (activeProject?.path ?? tree?.rootLabel ?? 'Project root');

  const toolActor = useMemo<Actor>(() => ({
    teamId: effectiveTeamId,
    agentId: actor.agentId,
    agentName: actor.agentName,
    role: actor.role,
  }), [actor.agentId, actor.agentName, actor.role, effectiveTeamId]);


  const codeTree = useMemo(() => buildCodeTree(tree?.entries ?? []), [tree?.entries]);
  const filteredTree = useMemo(() => filterCodeTree(codeTree, treeQuery), [codeTree, treeQuery]);
  const effectiveExpandedPaths = useMemo(
    () => (treeQuery.trim() ? new Set(filteredTree.expandedPaths) : expandedPaths),
    [expandedPaths, filteredTree.expandedPaths, treeQuery],
  );
  const visibleTreeNodes = useMemo(
    () => flattenVisibleCodeTree(filteredTree.nodes, effectiveExpandedPaths),
    [effectiveExpandedPaths, filteredTree.nodes],
  );
  const visibleFiles = visibleTreeNodes.filter((node) => node.kind === 'file');

  async function performSearch() {
    if (!searchQuery.trim() || !effectiveTeamId) return;
    setIsSearching(true);
    setSearchError(null);
    try {
      const res = await callTool<{ matches: { relativePath: string, lineNumber: number, content: string }[] }>({
        actor: toolActor,
        method: 'ide_search_files',
        args: { source, query: searchQuery },
      });
      setSearchResults(res.matches || []);
    } catch (err) {
      setSearchError(errorMessage(err));
      setSearchResults(null);
    } finally {
      setIsSearching(false);
    }
  }

  function handleOpenFile(path: string) {
    setActiveFilePath(path);
    setPendingExternalOpen({ sourceKey, path, requestId: Date.now() });
  }

  useEffect(() => {
    if (!externalOpenRequest) return;
    if (sourceKey !== externalOpenRequest.sourceKey) {
      setSourceKey(externalOpenRequest.sourceKey);
    }
    setPendingExternalOpen(externalOpenRequest);
    // External requests are explicit UI commands; openFile intentionally captures current tab state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalOpenRequest?.requestId]);

  async function refreshTree(pathToReopen: string | null = activeFilePath) {
    if (!effectiveTeamId) return;
    setLoadingTree(true);
    setTreeError(null);
    try {
      const [result, statusResult] = await Promise.all([
        callTool<IdeTreeResult>({
          actor: toolActor,
          method: 'ide_tree_list',
          args: { source },
        }),
        callTool<IdeStatusResult>({
          actor: toolActor,
          method: 'ide_get_status',
          args: { source },
        }).catch(() => null),
      ]);

      if (statusResult) {
        const statusMap = new Map(statusResult.entries.map((e) => [e.relativePath, e.status.trim()]));
        for (const entry of result.entries) {
          const st = statusMap.get(entry.path);
          if (st) {
            entry.gitStatus = st;
          }
        }
      }

      setTree(result);
      setExpandedPaths((current) => mergeExpandedPaths(current, getInitialExpandedPaths(result.entries, pathToReopen)));
    } catch (err) {
      setTree(null);
      setTreeError(errorMessage(err));
    } finally {
      setLoadingTree(false);
    }
  }

  async function createCheckpoint() {
    const message = window.prompt('Checkpoint message:');
    if (!message) return;
    try {
      await callTool({
        actor: toolActor,
        method: 'ide_checkpoint_task',
        args: { source, message },
      });
      void refreshTree(activeFilePath);
    } catch (err) {
      window.alert(errorMessage(err));
    }
  }

  useEffect(() => {
    setActiveFilePath(null);
    setTreeQuery('');
    setExpandedPaths(new Set());
    setTreeError(null);
    setSearchResults(null);
    setSearchQuery('');
    void refreshTree(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTeamId, sourceKey]);

  if (!effectiveTeamId) {
    return (
      <div className="code-empty">
        Select a project to browse files.
      </div>
    );
  }

  const files = tree?.entries.filter((entry) => entry.kind === 'file') ?? [];

  return (
    <main className={`code-screen ${mode === 'cockpit' ? 'code-screen-embedded' : ''}`}>
      {showChrome && (
        <header className="code-header">
          <div>
            <div className="eyebrow">Orchestrator IDE</div>
            <h1>Code</h1>
            <p title={rootLabel}>{rootLabel}</p>
          </div>
          <div className="code-actions">
            {projects.length > 0 && (
              <select
                className="field-input mono code-project-select"
                value={activeProject?.id ?? ''}
                aria-label="Active project"
                onChange={(event) => {
                  if (!event.target.value) return;
                  onSelectProject?.(event.target.value);
                }}
              >
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            )}
            {onSelectFolder && (
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => {
                  onSelectFolder();
                }}
              >
                <Icon name="folder" size={12} />
                Open folder
              </button>
            )}
            <select
              className="field-input mono code-source-select"
              value={sourceKey}
              onChange={(event) => {
                setSourceKey(event.target.value);
              }}
            >
              <option value="project">Project root</option>
              {worktreeTasks.map((task) => (
                <option key={task.id} value={`task:${task.id}`}>
                  {task.id} - {task.title}
                </option>
              ))}
            </select>
            {source.kind === 'task_worktree' && (
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => void createCheckpoint()}
              >
                <Icon name="check" size={12} />
                Checkpoint
              </button>
            )}
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => void refreshTree()}
              disabled={loadingTree}
            >
              <Icon name="refresh" size={12} />
              {loadingTree ? 'Loading' : 'Refresh'}
            </button>
          </div>
        </header>
      )}

      <div className="code-body">
        {showExplorer && (
          <aside className="code-tree" aria-label="Project files">
            <div className="code-tree-toolbar">
              <div className="code-pane-tabs" style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
                <button 
                  type="button" 
                  className={`btn btn-sm ${leftPaneMode === 'tree' ? 'btn-primary' : ''}`}
                  onClick={() => setLeftPaneMode('tree')}
                >
                  Explorer
                </button>
                <button 
                  type="button" 
                  className={`btn btn-sm ${leftPaneMode === 'search' ? 'btn-primary' : ''}`}
                  onClick={() => setLeftPaneMode('search')}
                >
                  Search
                </button>
              </div>
              {leftPaneMode === 'tree' && (
                <div className="code-tree-search">
                  <Icon name="search" size={12} />
                  <input
                    value={treeQuery}
                    onChange={(event) => setTreeQuery(event.target.value)}
                    placeholder="Filter files..."
                    aria-label="Filter files"
                  />
                  {treeQuery && (
                    <button
                      type="button"
                      className="code-tree-clear"
                      onClick={() => setTreeQuery('')}
                      aria-label="Clear file filter"
                    >
                      x
                    </button>
                  )}
                </div>
              )}
              {leftPaneMode === 'tree' && (
                <div className="code-tree-tools" style={{ marginTop: '4px' }}>
                  <button type="button" onClick={() => setExpandedPaths(new Set(collectDirectoryPaths(codeTree)))}>
                    Expand all
                  </button>
                  <button type="button" onClick={() => setExpandedPaths(new Set())}>
                    Collapse all
                  </button>
                </div>
              )}
            </div>
            
            {leftPaneMode === 'tree' ? (
              <>
                {loadingTree && <div className="code-muted">Loading files...</div>}
                {treeError && <div className="code-error">{treeError}</div>}
                {tree?.truncated && <div className="code-muted">Tree truncated at the backend entry cap.</div>}
                {tree && files.length === 0 && (
                  <div className="code-muted">No readable files found.</div>
                )}
                {tree && treeQuery && visibleFiles.length === 0 && (
                  <div className="code-muted">No matches found.</div>
                )}
                <IdeFileTree
                  nodes={visibleTreeNodes}
                  expandedPaths={effectiveExpandedPaths}
                  activePath={activeFilePath}
                  onToggleDirectory={(path) => setExpandedPaths((current) => toggleExpandedPath(current, path))}
                  onOpenFile={handleOpenFile}
                />
              </>
            ) : (
              <div className="code-search-pane" style={{ padding: '0 8px' }}>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <input
                    className="field-input"
                    style={{ flex: 1 }}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void performSearch(); }}
                    placeholder="Search contents..."
                  />
                  <button className="btn btn-sm" type="button" onClick={() => void performSearch()} disabled={isSearching}>
                    <Icon name="search" size={12} />
                  </button>
                </div>
                {searchError && <div className="code-error" style={{ marginTop: '8px' }}>{searchError}</div>}
                {isSearching && <div className="code-muted" style={{ marginTop: '8px' }}>Searching...</div>}
                {searchResults && searchResults.length === 0 && !isSearching && (
                  <div className="code-muted" style={{ marginTop: '8px' }}>No matches found.</div>
                )}
                {searchResults && searchResults.length > 0 && (
                  <div className="code-search-results" style={{ marginTop: '12px', overflowY: 'auto' }}>
                    {searchResults.map((match, i) => (
                      <div 
                        key={i} 
                        className="code-search-match" 
                        style={{ padding: '4px', cursor: 'pointer', borderBottom: '1px solid var(--border)', fontSize: '11px' }}
                        onClick={() => handleOpenFile(match.relativePath)}
                      >
                        <div style={{ fontWeight: 'bold', color: 'var(--primary)' }}>{match.relativePath}:{match.lineNumber}</div>
                        <div className="mono" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{match.content}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </aside>
        )}

        <IdeEditorPane
          source={source}
          actor={toolActor}
          driftData={driftData}
          activeAgentsInWorktree={activeAgentsInWorktree}
          externalOpenRequest={pendingExternalOpen}
          onRefreshTreeRequest={(path) => refreshTree(path)}
        />
      </div>
    </main>
  );
}

function getInitialExpandedPaths(entries: { path: string; kind: 'file' | 'directory' }[], selectedPath: string | null): Set<string> {
  const expanded = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'directory' && !entry.path.includes('/')) {
      expanded.add(entry.path);
    }
  }
  if (selectedPath) {
    const parts = selectedPath.split('/');
    for (let index = 1; index < parts.length; index += 1) expanded.add(parts.slice(0, index).join('/'));
  }
  return expanded;
}

function mergeExpandedPaths(current: Set<string>, next: Set<string>): Set<string> {
  return new Set([...current, ...next]);
}

function toggleExpandedPath(current: Set<string>, path: string): Set<string> {
  const next = new Set(current);
  if (next.has(path)) {
    next.delete(path);
  } else {
    next.add(path);
  }
  return next;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
