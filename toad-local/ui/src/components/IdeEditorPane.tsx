import { useEffect, useRef, useState } from 'react';
import * as monaco from 'monaco-editor';
import Editor, { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { callTool, type Actor } from '@/api/client';
import type { Runtime } from '@/types';
import { Icon } from './Icon';
import { MarkdownPreview } from './MarkdownPreview';
import type { DriftRunResult } from '@/hooks/useDrift';
import type { IdeFileResult, IdeSource } from './ideSource';

loader.config({ monaco });

type MonacoWorkerEnvironment = {
  getWorker(workerId: string, label: string): Worker;
};

declare global {
  interface Window {
    MonacoEnvironment?: MonacoWorkerEnvironment;
  }
}

if (!window.MonacoEnvironment) {
  window.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      if (label === 'json') return new jsonWorker();
      if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
      if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
      if (label === 'typescript' || label === 'javascript') return new tsWorker();
      return new editorWorker();
    },
  };
}

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

interface IdeEditorPaneProps {
  source: IdeSource;
  actor: Actor;
  driftData?: DriftRunResult | null;
  activeAgentsInWorktree: Runtime[];
  externalOpenRequest: { sourceKey: string; path: string; requestId: number } | null;
  onRefreshTreeRequest?: (path: string | null) => void;
}

export function IdeEditorPane({
  source,
  actor,
  driftData,
  activeAgentsInWorktree,
  externalOpenRequest,
  onRefreshTreeRequest,
}: IdeEditorPaneProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsCollectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);

  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [pendingExternalOpen, setPendingExternalOpen] = useState<{ sourceKey: string; path: string } | null>(null);

  const activeTab = tabs.find((t) => t.path === activeTabPath);
  const isDirty = activeTab ? activeTab.draftContent !== activeTab.file?.content : false;
  const isAnyDirty = tabs.some((t) => t.file !== null && t.draftContent !== t.file.content);

  const sourceKey = source.kind === 'project' ? 'project' : `task:${source.taskId}`;

  function confirmDiscardDirty(): boolean {
    return !isAnyDirty || window.confirm('You have unsaved changes in open tabs. Discard them?');
  }

  function confirmDiscardTabDirty(tab: OpenTab): boolean {
    const dirty = tab.file !== null && tab.draftContent !== tab.file.content;
    return !dirty || window.confirm(`Discard unsaved changes in ${tab.path}?`);
  }

  async function openFile(relativePath: string) {
    if (!actor.teamId) return;
    
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
        actor,
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
      // Source changed, we can't handle it directly here as we just receive `source`.
      // The parent component should unmount/remount us or change the `source` prop.
      // We set a pending state so that when the source prop updates, we open the file.
      setPendingExternalOpen({ sourceKey: externalOpenRequest.sourceKey, path: externalOpenRequest.path });
      return;
    }
    void openFile(externalOpenRequest.path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalOpenRequest?.requestId]);

  useEffect(() => {
    if (!pendingExternalOpen || sourceKey !== pendingExternalOpen.sourceKey) return;
    void openFile(pendingExternalOpen.path);
    setPendingExternalOpen(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingExternalOpen, sourceKey]);

  useEffect(() => {
    // When the source changes, clear all tabs if they don't match the new source.
    // (A more robust implementation might keep tabs per source, but this mirrors CodeScreen behavior).
    setActiveTabPath(null);
    setTabs([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);


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

  async function saveFile() {
    if (!actor.teamId || !activeTab || !activeTab.file || !isDirty) return;
    const pathToSave = activeTabPath;
    
    setTabs(prev => prev.map(t => t.path === pathToSave ? { ...t, saving: true, saveError: null } : t));
    
    try {
      const result = await callTool<IdeFileResult>({
        actor,
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
      
      if (onRefreshTreeRequest) {
         onRefreshTreeRequest(pathToSave);
      }
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === pathToSave ? { ...t, saveError: errorMessage(err), saving: false } : t));
    }
  }

  function revertFile() {
    if (!activeTab || !activeTab.file) return;
    setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, draftContent: t.file!.content, saveError: null } : t));
  }

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
    if (!actor.teamId || !activeTabPath) return;
    try {
      const result = await callTool<{ diff: string }>({
        actor,
        method: 'ide_get_diff',
        args: { source, relativePath: activeTabPath },
      });
      setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, diffContent: result.diff || 'No changes.', editorMode: 'diff' } : t));
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, fileError: errorMessage(err) } : t));
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
               actor,
               method: 'ide_apply_patch',
               args: { source, patchContent, reverse: true }
             });
             if (onRefreshTreeRequest) {
                onRefreshTreeRequest(activeTabPath);
             }
             // Re-load the diff and the file
             const newFile = await callTool<IdeFileResult>({ actor, method: 'ide_read_file', args: { source, relativePath: activeTabPath }});
             const newDiff = await callTool<{diff: string}>({ actor, method: 'ide_get_diff', args: { source, relativePath: activeTabPath }});
             setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, file: newFile, draftContent: newFile.content, diffContent: newDiff.diff || 'No changes.' } : t));
          } catch(err) {
             window.alert(errorMessage(err));
          }
        }
      }
    });
  }

  return (
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
  );
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
