import { useEffect, useMemo, useState, useRef } from 'react';
import * as monaco from 'monaco-editor';
import Editor, { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
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
import { MarkdownPreview } from './MarkdownPreview';
import type { DriftRunResult } from '@/hooks/useDrift';
import { IdeFileTree } from './IdeFileTree';
import {
  sourceKeyToIdeSource,
  type IdeFileResult,
  type IdeSource,
  type IdeStatusResult,
  type IdeTreeEntry,
  type IdeTreeResult,
} from './ideSource';

loader.config({ monaco });

type MonacoWorkerEnvironment = {
  getWorker(workerId: string, label: string): Worker;
};

declare global {
  interface Window {
    MonacoEnvironment?: MonacoWorkerEnvironment;
  }
}

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

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

export type OpenTab = {
  path: string;
  file: IdeFileResult | null;
  fileError: string | null;
  saveError: string | null;
  draftContent: string;
  editorMode: 'code' | 'diff' | 'preview' | 'split';
  diffContent: string;
  loading: boolean;
  saving: boolean;
};

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

  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsCollectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [pendingExternalOpen, setPendingExternalOpen] = useState<{ sourceKey: string; path: string } | null>(null);

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

  const activeTab = tabs.find((t) => t.path === activeTabPath);
  const isDirty = activeTab ? activeTab.draftContent !== activeTab.file?.content : false;
  const isAnyDirty = tabs.some((t) => t.file !== null && t.draftContent !== t.file.content);

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

  function confirmDiscardDirty(): boolean {
    return !isAnyDirty || window.confirm('You have unsaved changes in open tabs. Discard them?');
  }

  function confirmDiscardTabDirty(tab: OpenTab): boolean {
    const dirty = tab.file !== null && tab.draftContent !== tab.file.content;
    return !dirty || window.confirm(`Discard unsaved changes in ${tab.path}?`);
  }

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

  async function openFile(relativePath: string) {
    if (!effectiveTeamId) return;
    
    // Switch to tab if already open
    if (tabs.some(t => t.path === relativePath)) {
      setActiveTabPath(relativePath);
      return;
    }

    const newTab: OpenTab = {
      path: relativePath,
      file: null,
      fileError: null,
      saveError: null,
      draftContent: '',
      editorMode: 'code',
      diffContent: '',
      loading: true,
      saving: false,
    };
    
    setTabs(prev => [...prev, newTab]);
    setActiveTabPath(relativePath);

    try {
      const result = await callTool<IdeFileResult>({
        actor: toolActor,
        method: 'ide_read_file',
        args: { source, relativePath },
      });
      setTabs(prev => prev.map(t => t.path === relativePath ? { ...t, file: result, draftContent: result.content, loading: false } : t));
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === relativePath ? { ...t, fileError: errorMessage(err), loading: false } : t));
    }
  }

  useEffect(() => {
    if (!externalOpenRequest) return;
    if (!confirmDiscardDirty()) return;
    if (sourceKey !== externalOpenRequest.sourceKey) {
      setSourceKey(externalOpenRequest.sourceKey);
      setPendingExternalOpen({ sourceKey: externalOpenRequest.sourceKey, path: externalOpenRequest.path });
      return;
    }
    void openFile(externalOpenRequest.path);
    // External requests are explicit UI commands; openFile intentionally captures current tab state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalOpenRequest?.requestId]);

  useEffect(() => {
    if (!pendingExternalOpen || sourceKey !== pendingExternalOpen.sourceKey) return;
    void openFile(pendingExternalOpen.path);
    setPendingExternalOpen(null);
    // External requests are explicit UI commands; openFile intentionally captures current tab state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingExternalOpen, sourceKey]);

  function closeTab(path: string, event?: React.MouseEvent) {
    if (event) event.stopPropagation();
    const tab = tabs.find(t => t.path === path);
    if (!tab) return;
    if (!confirmDiscardTabDirty(tab)) return;
    
    setTabs(prev => {
      const nextTabs = prev.filter(t => t.path !== path);
      if (activeTabPath === path) {
        if (nextTabs.length > 0) {
          setActiveTabPath(nextTabs[nextTabs.length - 1].path);
        } else {
          setActiveTabPath(null);
        }
      }
      return nextTabs;
    });
  }

  async function refreshTree(pathToReopen = activeTabPath, skipDirtyCheck = false) {
    if (!effectiveTeamId) return;
    if (!skipDirtyCheck && isAnyDirty && !confirmDiscardDirty()) return;
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

      // Optionally we could close tabs that no longer exist, but for now we just keep them open until user closes or refresh fails to load them.
    } catch (err) {
      setTree(null);
      setTreeError(errorMessage(err));
    } finally {
      setLoadingTree(false);
    }
  }

  async function saveFile() {
    if (!effectiveTeamId || !activeTab || !activeTab.file || !isDirty) return;
    const pathToSave = activeTabPath;
    
    setTabs(prev => prev.map(t => t.path === pathToSave ? { ...t, saving: true, saveError: null } : t));
    
    try {
      const result = await callTool<IdeFileResult>({
        actor: toolActor,
        method: 'ide_write_file',
        idempotencyKey: createIdempotencyKey(activeTab.file.relativePath),
        args: {
          source: activeTab.file.source,
          relativePath: activeTab.file.relativePath,
          content: activeTab.draftContent,
          expectedSha256: activeTab.file.sha256,
        },
      });
      setTabs(prev => prev.map(t => t.path === pathToSave ? { ...t, file: result, draftContent: result.content, saving: false } : t));
      
      const nextTree = await callTool<IdeTreeResult>({
        actor: toolActor,
        method: 'ide_tree_list',
        args: { source: result.source },
      });
      setTree(nextTree);
      setTreeError(null);
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === pathToSave ? { ...t, saveError: errorMessage(err), saving: false } : t));
    }
  }

  function revertFile() {
    if (!activeTab || !activeTab.file) return;
    setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, draftContent: t.file!.content, saveError: null } : t));
  }

  useEffect(() => {
    setActiveTabPath(null);
    setTabs([]);
    setTreeQuery('');
    setExpandedPaths(new Set());
    setTreeError(null);
    setSearchResults(null);
    setSearchQuery('');
    void refreshTree(null, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTeamId, sourceKey]);

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!isAnyDirty) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isAnyDirty]);

  useEffect(() => {
    if (!editorRef.current || !decorationsCollectionRef.current) return;
    if (!activeTabPath || !driftData) {
      decorationsCollectionRef.current.clear();
      return;
    }

    const fileFindings = driftData.findings.filter(f => 
      f.evidence.some(ev => ev === activeTabPath || ev.startsWith(activeTabPath + ':'))
    );

    const decorations: monaco.editor.IModelDeltaDecoration[] = [];

    for (const finding of fileFindings) {
      for (const ev of finding.evidence) {
        if (ev === activeTabPath || ev.startsWith(activeTabPath + ':')) {
          const match = ev.match(/:(\d+)/);
          const lineNum = match ? parseInt(match[1], 10) : 1;
          
          decorations.push({
            range: new monaco.Range(lineNum, 1, lineNum, 1),
            options: {
              isWholeLine: true,
              className: 'drift-squiggly',
              glyphMarginClassName: 'drift-glyph',
              glyphMarginHoverMessage: { value: `**Drift Finding [${finding.severity.toUpperCase()}]: ${finding.title}**\n\n${finding.actual}` }
            }
          });
        }
      }
    }

    decorationsCollectionRef.current.set(decorations);
  }, [activeTabPath, driftData, activeTab?.draftContent]);

  async function loadDiff() {
    if (!effectiveTeamId || !activeTabPath) return;
    try {
      const result = await callTool<{ diff: string }>({
        actor: toolActor,
        method: 'ide_get_diff',
        args: { source, relativePath: activeTabPath },
      });
      setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, diffContent: result.diff || 'No changes.', editorMode: 'diff' } : t));
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, fileError: errorMessage(err) } : t));
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
      void refreshTree(activeTabPath, true);
    } catch (err) {
      window.alert(errorMessage(err));
    }
  }

  function handleEditorMount(editor: monaco.editor.IStandaloneCodeEditor) {
    editorRef.current = editor;
    decorationsCollectionRef.current = editor.createDecorationsCollection([]);
    editor.addAction({
      id: 'ide-revert-hunk',
      label: 'Revert this Hunk',
      contextMenuGroupId: '1_modification',
      run: async (ed) => {
        if (!activeTab || activeTab.editorMode !== 'diff') {
          window.alert('Hunk reverts are only available in diff view.');
          return;
        }
        const position = ed.getPosition();
        if (!position) return;
        const model = ed.getModel();
        if (!model) return;
        
        const lineCount = model.getLineCount();
        let startLine = position.lineNumber;
        while (startLine > 0 && !model.getLineContent(startLine).startsWith('@@ ')) {
          startLine--;
        }
        if (startLine === 0) {
          window.alert('No hunk found at cursor.');
          return;
        }
        
        let endLine = position.lineNumber + 1;
        while (endLine <= lineCount && !model.getLineContent(endLine).startsWith('@@ ')) {
          endLine++;
        }
        
        let header = '';
        for (let i = 1; i < startLine; i++) {
          const content = model.getLineContent(i);
          header += content + '\n';
          if (content.startsWith('+++')) break;
        }
        
        let hunk = '';
        for (let i = startLine; i < endLine; i++) {
          hunk += model.getLineContent(i) + '\n';
        }
        
        const patchContent = header + hunk;
        if (window.confirm('Revert this hunk?')) {
          try {
             await callTool({
               actor: toolActor,
               method: 'ide_apply_patch',
               args: { source, patchContent, reverse: true }
             });
             void refreshTree(activeTabPath, true);
             // Re-load the diff and the file
             const newFile = await callTool<IdeFileResult>({ actor: toolActor, method: 'ide_read_file', args: { source, relativePath: activeTabPath }});
             const newDiff = await callTool<{diff: string}>({ actor: toolActor, method: 'ide_get_diff', args: { source, relativePath: activeTabPath }});
             setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, file: newFile, draftContent: newFile.content, diffContent: newDiff.diff || 'No changes.' } : t));
          } catch(err) {
             window.alert(errorMessage(err));
          }
        }
      }
    });
  }

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
                if (!confirmDiscardDirty()) return;
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
                if (!confirmDiscardDirty()) return;
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
              if (!confirmDiscardDirty()) return;
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

      <div className={`code-body ${showExplorer ? '' : 'editor-only'}`}>
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
                activePath={activeTabPath}
                onToggleDirectory={(path) => setExpandedPaths((current) => toggleExpandedPath(current, path))}
                onOpenFile={(path) => void openFile(path)}
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
                      onClick={() => void openFile(match.relativePath)}
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

        <section className="code-editor-pane" aria-label="Selected file" style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
          {activeAgentsInWorktree.length > 0 && (
            <div className="code-agent-banner">
              <Icon name="info" size={14} />
              <span>
                <strong>{activeAgentsInWorktree.length} agent{activeAgentsInWorktree.length > 1 ? 's' : ''}</strong> {activeAgentsInWorktree.length > 1 ? 'are' : 'is'} currently active in this worktree. Files may change.
              </span>
            </div>
          )}
          {tabs.length > 0 && (
            <div className="code-tabs" style={{ display: 'flex', overflowX: 'auto', borderBottom: '1px solid var(--border)' }}>
              {tabs.map((tab) => {
                const isTabDirty = tab.file !== null && tab.draftContent !== tab.file.content;
                return (
                  <div
                    key={tab.path}
                    className={`code-tab ${activeTabPath === tab.path ? 'active' : ''}`}
                    style={{
                      padding: '8px 12px',
                      cursor: 'pointer',
                      borderRight: '1px solid var(--border)',
                      backgroundColor: activeTabPath === tab.path ? 'var(--bg)' : 'var(--bg-muted)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '8px'
                    }}
                    onClick={() => setActiveTabPath(tab.path)}
                  >
                    <span className="mono" style={{ fontSize: '12px' }}>{tab.path.split('/').pop()}</span>
                    {isTabDirty && <span className="code-dirty-dot" style={{ color: 'var(--primary)', fontWeight: 'bold' }}>*</span>}
                    <button 
                      type="button" 
                      onClick={(e) => closeTab(tab.path, e)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)' }}
                    >
                      x
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          
          {activeTab ? (
            <>
              <div className="code-filebar">
                <div className="code-file-meta">
                  <span className="mono">{activeTab.path}</span>
                  {(activeTab.file !== null && activeTab.draftContent !== activeTab.file.content) && <span className="code-dirty-pill">Unsaved</span>}
                </div>
                <div className="code-file-actions">
                  {activeTab.file && <span className="dim">{formatBytes(activeTab.file.sizeBytes)}</span>}
                  {(activeTab.file?.languageHint === 'markdown' || activeTab.path.endsWith('.md')) && (
                    <div className="code-mode-toggles" style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: '4px', overflow: 'hidden' }}>
                      <button className={`btn btn-sm ${activeTab.editorMode === 'code' ? 'btn-primary' : ''}`} style={{ border: 'none', borderRadius: 0 }} onClick={() => setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, editorMode: 'code' } : t))}>Code</button>
                      <button className={`btn btn-sm ${activeTab.editorMode === 'preview' ? 'btn-primary' : ''}`} style={{ border: 'none', borderRadius: 0 }} onClick={() => setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, editorMode: 'preview' } : t))}>Preview</button>
                      <button className={`btn btn-sm ${activeTab.editorMode === 'split' ? 'btn-primary' : ''}`} style={{ border: 'none', borderRadius: 0 }} onClick={() => setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, editorMode: 'split' } : t))}>Split</button>
                    </div>
                  )}
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={() => {
                      if (activeTab.editorMode === 'diff') {
                        setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, editorMode: 'code' } : t));
                      } else {
                        void loadDiff();
                      }
                    }}
                    disabled={!activeTab.file}
                  >
                    {activeTab.editorMode === 'diff' ? 'Edit Code' : 'View Diff'}
                  </button>
                  <button
                    className="btn btn-sm"
                    type="button"
                    onClick={revertFile}
                    disabled={!(activeTab.file !== null && activeTab.draftContent !== activeTab.file.content) || activeTab.saving || activeTab.editorMode === 'diff'}
                  >
                    Revert
                  </button>
                  <button
                    className="btn btn-sm btn-primary"
                    type="button"
                    onClick={() => void saveFile()}
                    disabled={!(activeTab.file !== null && activeTab.draftContent !== activeTab.file.content) || activeTab.saving || activeTab.editorMode === 'diff'}
                  >
                    <Icon name="check" size={12} />
                    {activeTab.saving ? 'Saving' : 'Save'}
                  </button>
                </div>
              </div>
              
              <div style={{ flex: 1, minHeight: 0 }}>
                {activeTab.loading && <div className="code-editor-state">Loading file...</div>}
                {activeTab.fileError && <div className="code-editor-state error">{activeTab.fileError}</div>}
                {activeTab.saveError && <div className="code-save-error">{activeTab.saveError}</div>}
                {!activeTab.loading && !activeTab.fileError && !activeTab.file && (
                  <div className="code-editor-state">Select a file to edit it.</div>
                )}
                {activeTab.file && (
                  <div style={{ display: 'flex', width: '100%', height: '100%' }}>
                    {activeTab.editorMode !== 'preview' && (
                      <div style={{ flex: 1, minWidth: 0, height: '100%' }}>
                        <Editor
                          height="100%"
                          value={activeTab.editorMode === 'diff' ? activeTab.diffContent : activeTab.draftContent}
                          language={activeTab.editorMode === 'diff' ? 'diff' : (activeTab.file.languageHint ?? languageFromPath(activeTab.file.relativePath))}
                          theme="vs-dark"
                          onChange={(value) => {
                            if (activeTab.editorMode === 'code' || activeTab.editorMode === 'split') {
                              setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, draftContent: value ?? '' } : t));
                            }
                          }}
                          onMount={handleEditorMount}
                          options={{
                            minimap: { enabled: false },
                            automaticLayout: true,
                            scrollBeyondLastLine: false,
                            renderWhitespace: 'selection',
                            readOnly: activeTab.editorMode === 'diff',
                            glyphMargin: true,
                          }}
                        />
                      </div>
                    )}
                    {(activeTab.editorMode === 'preview' || activeTab.editorMode === 'split') && (
                      <div style={{ flex: 1, minWidth: 0, height: '100%', borderLeft: activeTab.editorMode === 'split' ? '1px solid var(--border)' : 'none' }}>
                        <MarkdownPreview content={activeTab.draftContent} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="code-editor-state">Select a file to open a tab.</div>
          )}
        </section>
      </div>
    </main>
  );
}

function getInitialExpandedPaths(entries: IdeTreeEntry[], selectedPath: string | null): Set<string> {
  const expanded = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'directory' && !entry.path.includes('/')) {
      expanded.add(entry.path);
    }
  }
  if (selectedPath) {
    for (const ancestor of ancestorPaths(selectedPath)) expanded.add(ancestor);
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

function ancestorPaths(filePath: string): string[] {
  const parts = filePath.split('/');
  const ancestors: string[] = [];
  for (let index = 1; index < parts.length; index += 1) {
    ancestors.push(parts.slice(0, index).join('/'));
  }
  return ancestors;
}

function createIdempotencyKey(relativePath: string): string {
  const suffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `ide-write:${relativePath}:${suffix}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function languageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'js' || ext === 'jsx') return 'javascript';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  if (ext === 'css') return 'css';
  if (ext === 'html') return 'html';
  if (ext === 'yml' || ext === 'yaml') return 'yaml';
  if (ext === 'sql') return 'sql';
  return 'plaintext';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCompactBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}k`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}m`;
}
