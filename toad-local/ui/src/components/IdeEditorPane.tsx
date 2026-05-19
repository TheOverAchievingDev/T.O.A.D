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
import { isEditableIdeFile, languageForFile, unsupportedReason } from './ideFilePresentation';
import {
  diagnosticsForPath,
  isDiagnosablePath,
  toMonacoMarkerData,
  type IdeDiagnostic,
  type IdeDiagnosticsResult,
  type IdeFileActionResult,
} from './ideDiagnostics';

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
  externalOpenRequest: { sourceKey: string; path: string; requestId: number; mode?: 'diff' } | null;
  onRefreshTreeRequest?: (path: string | null) => void;
  /** Phase 3d Task 13 — optional path → task lookup. When provided,
   *  files that match a task's allowedFiles contract render an "in
   *  scope for t_42" chip in the file bar so the operator knows the
   *  edit belongs to a specific task. Omitted when no task contract
   *  is in play (e.g. standalone Code screen with no team). */
  scopeChipForPath?: (path: string) => { taskId: string; assignee?: string } | null;
  /** Phase 3d Task 14 — optional recent-activity lookup for the
   *  active file. Returns the most-recent agent event whose summary
   *  touches the active file, or null when nothing recent matched.
   *  Renders as a Cursor-style "just edited" banner above the editor
   *  body. Caller is responsible for the freshness window (typically
   *  the last 60-90s of agentStreams). */
  recentActivityForPath?: (path: string) => { agentName: string; summary: string; at: string } | null;
  /** Python-IDE Task 10 — diagnostics for the project/active source.
   *  Used to render Monaco squiggles on the active tab. Optional so
   *  non-diagnostic callsites (e.g. Code screen) stay unaffected. */
  diagnostics?: IdeDiagnostic[];
  /** Python-IDE Task 10 — navigation request from the Problems tab.
   *  When its path matches the active model, the editor moves the
   *  cursor and reveals the target line. requestId de-dupes repeats. */
  diagnosticNavigationTarget?: { path: string; line: number; column: number; requestId: number } | null;
  /** Python-IDE Task 10 — run Ruff/Mypy diagnostics for a file (or the
   *  whole project when path is omitted). Wired by CockpitWithMe. */
  onRunDiagnosticsRequest?: (path?: string) => Promise<IdeDiagnosticsResult | null>;
  /** Python-IDE Task 10 — feed fresh diagnostics back to the caller so
   *  the Problems tab / Cockpit state stays in sync after format/fix. */
  onDiagnosticsResult?: (result: IdeDiagnosticsResult | null | undefined) => void;
}

export function IdeEditorPane({
  source,
  actor,
  driftData,
  activeAgentsInWorktree,
  externalOpenRequest,
  onRefreshTreeRequest,
  scopeChipForPath,
  recentActivityForPath,
  diagnostics,
  diagnosticNavigationTarget,
  onRunDiagnosticsRequest,
  onDiagnosticsResult,
}: IdeEditorPaneProps) {
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsCollectionRef = useRef<monaco.editor.IEditorDecorationsCollection | null>(null);
  const lastNavRequestRef = useRef<number | null>(null);

  const [tabs, setTabs] = useState<OpenTab[]>([]);
  const [activeTabPath, setActiveTabPath] = useState<string | null>(null);
  const [pendingExternalOpen, setPendingExternalOpen] = useState<{ sourceKey: string; path: string; mode?: 'diff' } | null>(null);
  const [pythonActionRunning, setPythonActionRunning] = useState(false);

  const activeTab = tabs.find((t) => t.path === activeTabPath);
  const activeTabEditable = isEditableIdeFile(activeTab?.file);
  const isDirty = activeTab && isEditableIdeFile(activeTab.file) ? activeTab.draftContent !== activeTab.file.content : false;
  const isAnyDirty = tabs.some((t) => isEditableIdeFile(t.file) && t.draftContent !== t.file.content);

  const sourceKey = source.kind === 'project' ? 'project' : `task:${source.taskId}`;

  function confirmDiscardDirty(): boolean {
    return !isAnyDirty || window.confirm('You have unsaved changes in open tabs. Discard them?');
  }

  function confirmDiscardTabDirty(tab: OpenTab): boolean {
    const dirty = isEditableIdeFile(tab.file) && tab.draftContent !== tab.file.content;
    return !dirty || window.confirm(`Discard unsaved changes in ${tab.path}?`);
  }

  async function openFile(relativePath: string, mode?: 'diff') {
    if (!actor.teamId) return;

    // Switch to tab if already open
    if (tabs.some(t => t.path === relativePath)) {
      setActiveTabPath(relativePath);
      if (mode === 'diff') await loadDiffForPath(relativePath);
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
      setTabs(prev => prev.map(t => t.path === relativePath ? { ...t, file: result, draftContent: isEditableIdeFile(result) ? result.content : '', loading: false } : t));
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === relativePath ? { ...t, fileError: errorMessage(err), loading: false } : t));
    }
    if (mode === 'diff') await loadDiffForPath(relativePath);
  }

  useEffect(() => {
    if (!externalOpenRequest) return;
    if (!confirmDiscardDirty()) return;
    if (sourceKey !== externalOpenRequest.sourceKey) {
      // Source changed, we can't handle it directly here as we just receive `source`.
      // The parent component should unmount/remount us or change the `source` prop.
      // We set a pending state so that when the source prop updates, we open the file.
      setPendingExternalOpen({ sourceKey: externalOpenRequest.sourceKey, path: externalOpenRequest.path, mode: externalOpenRequest.mode });
      return;
    }
    void openFile(externalOpenRequest.path, externalOpenRequest.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalOpenRequest?.requestId]);

  useEffect(() => {
    if (!pendingExternalOpen || sourceKey !== pendingExternalOpen.sourceKey) return;
    void openFile(pendingExternalOpen.path, pendingExternalOpen.mode);
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
    if (!actor.teamId || !activeTab || !isEditableIdeFile(activeTab.file) || !isDirty) return;
    const editableFile = activeTab.file;
    const pathToSave = activeTabPath;

    setTabs(prev => prev.map(t => t.path === pathToSave ? { ...t, saving: true, saveError: null } : t));

    try {
      const result = await callTool<IdeFileResult>({
        actor,
        method: 'ide_write_file',
        idempotencyKey: createIdempotencyKey(editableFile.relativePath),
        args: {
          source: editableFile.source,
          relativePath: editableFile.relativePath,
          content: activeTab.draftContent,
          expectedSha256: editableFile.sha256,
        },
      });
      setTabs(prev => prev.map(t => t.path === pathToSave ? { ...t, file: result, draftContent: isEditableIdeFile(result) ? result.content : '', saving: false } : t));
      
      if (onRefreshTreeRequest) {
         onRefreshTreeRequest(pathToSave);
      }
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === pathToSave ? { ...t, saveError: errorMessage(err), saving: false } : t));
    }
  }

  function revertFile() {
    if (!activeTab || !isEditableIdeFile(activeTab.file)) return;
    setTabs(prev => prev.map(t => t.path === activeTabPath && isEditableIdeFile(t.file)
      ? { ...t, draftContent: t.file.content, saveError: null }
      : t));
  }

  async function runActiveDiagnostics() {
    if (!activeTabPath || !onRunDiagnosticsRequest || pythonActionRunning) return;
    setPythonActionRunning(true);
    try {
      const result = await onRunDiagnosticsRequest(activeTabPath);
      onDiagnosticsResult?.(result);
    } finally {
      setPythonActionRunning(false);
    }
  }

  // Python-IDE Task 10 — Format (Ruff) / Fix (Ruff) for the active
  // Python file. CockpitWithMe wires diagnostics state through
  // onDiagnosticsResult; the IDE tools return the refreshed file so
  // we keep the editor draft + saved content consistent afterwards.
  async function runActivePythonAction(method: 'ide_format_file' | 'ide_fix_file') {
    if (!actor.teamId || !activeTab || !isEditableIdeFile(activeTab.file)) return;
    if (pythonActionRunning || activeTab.saving) return;
    const pathToUpdate = activeTabPath;
    const editableFile = activeTab.file;
    setPythonActionRunning(true);
    setTabs(prev => prev.map(t => t.path === pathToUpdate ? { ...t, saveError: null } : t));
    try {
      const result = await callTool<IdeFileActionResult>({
        actor,
        method,
        idempotencyKey: createIdempotencyKey(`${method}:${editableFile.relativePath}`),
        args: { source: editableFile.source, relativePath: editableFile.relativePath },
      });
      const refreshed = result.file as IdeFileResult | undefined;
      if (refreshed && isEditableIdeFile(refreshed)) {
        setTabs(prev => prev.map(t => t.path === pathToUpdate
          ? { ...t, file: refreshed, draftContent: refreshed.content }
          : t));
      }
      onDiagnosticsResult?.(result);
      if (onRefreshTreeRequest) onRefreshTreeRequest(pathToUpdate);
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === pathToUpdate ? { ...t, saveError: errorMessage(err) } : t));
    } finally {
      setPythonActionRunning(false);
    }
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

  // Python-IDE Task 10 — apply Ruff/Mypy diagnostics as Monaco
  // markers on the active model under a dedicated owner so they
  // never collide with drift glyphs or built-in language markers.
  // Recomputes on diagnostics / active tab / saved-content change;
  // a missing model or no diagnostics clears the owner's markers.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;
    const owner = 'symphony-python-diagnostics';
    if (!activeTabPath || !diagnostics || diagnostics.length === 0) {
      monaco.editor.setModelMarkers(model, owner, []);
      return;
    }
    const forFile = diagnosticsForPath(diagnostics, activeTabPath);
    const markers = forFile.map((d) => toMonacoMarkerData(d, monaco.MarkerSeverity));
    monaco.editor.setModelMarkers(model, owner, markers);
    return () => {
      const m = editor.getModel();
      if (m) monaco.editor.setModelMarkers(m, owner, []);
    };
  }, [activeTabPath, diagnostics, activeTab?.file, activeTab?.editorMode]);

  // Python-IDE Task 10 — react to a Problems-tab navigation request.
  // Only act once per requestId and only when the target file is the
  // active model, then move the cursor and centre the target line.
  useEffect(() => {
    if (!diagnosticNavigationTarget) return;
    if (lastNavRequestRef.current === diagnosticNavigationTarget.requestId) return;
    const editor = editorRef.current;
    if (!editor) return;
    if (activeTabPath !== diagnosticNavigationTarget.path) return;
    lastNavRequestRef.current = diagnosticNavigationTarget.requestId;
    const position = {
      lineNumber: Math.max(1, diagnosticNavigationTarget.line),
      column: Math.max(1, diagnosticNavigationTarget.column),
    };
    editor.setPosition(position);
    editor.revealPositionInCenter(position);
    editor.focus();
  }, [diagnosticNavigationTarget, activeTabPath]);

  async function loadDiffForPath(relativePath: string) {
    if (!actor.teamId || !relativePath) return;
    try {
      const result = await callTool<{ diff: string }>({
        actor,
        method: 'ide_get_diff',
        args: { source, relativePath },
      });
      setTabs(prev => prev.map(t => t.path === relativePath ? { ...t, diffContent: result.diff || 'No changes.', editorMode: 'diff' } : t));
    } catch (err) {
      setTabs(prev => prev.map(t => t.path === relativePath ? { ...t, fileError: errorMessage(err) } : t));
    }
  }

  async function loadDiff() {
    if (!activeTabPath) return;
    await loadDiffForPath(activeTabPath);
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
             setTabs(prev => prev.map(t => t.path === activeTabPath ? { ...t, file: newFile, draftContent: isEditableIdeFile(newFile) ? newFile.content : '', diffContent: newDiff.diff || 'No changes.' } : t));
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
      {/* Phase 3d Task 14 — per-file activity hint. When the caller's
          recentActivityForPath helper returns an entry for the active
          tab's path, surface it as a Cursor-style "agent X just …"
          banner. Adds team-aware specificity vs. the worktree-level
          banner above. */}
      {activeTab && recentActivityForPath && (() => {
        const activity = recentActivityForPath(activeTab.path);
        if (!activity) return null;
        return (
          <div className="code-agent-banner code-activity-banner" title={`At ${activity.at}`}>
            <Icon name="sparkle" size={13} />
            <span>
              <strong>{activity.agentName}</strong> just {activity.summary}
            </span>
          </div>
        );
      })()}
      {tabs.length > 0 && (
        <div className="code-tabs" style={{ display: 'flex', overflowX: 'auto', borderBottom: '1px solid var(--border)' }}>
          {tabs.map((tab) => {
            const isTabDirty = isEditableIdeFile(tab.file) && tab.draftContent !== tab.file.content;
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
              {(isEditableIdeFile(activeTab.file) && activeTab.draftContent !== activeTab.file.content) && <span className="code-dirty-pill">Unsaved</span>}
              {(() => {
                // Phase 3d Task 13 — "in scope for t_42" chip. Renders
                // only when a callsite (CodeScreen / CockpitWithMe) has
                // wired scopeChipForPath AND the active file matches a
                // task's allowedFiles contract. Click → opens the task
                // (we don't have a handler today, so it's display-only;
                // Phase 4 can add navigation).
                const scope = scopeChipForPath?.(activeTab.path) ?? null;
                if (!scope) return null;
                return (
                  <span
                    className="code-scope-chip mono"
                    title={`Active file is in the scope contract of task ${scope.taskId}${scope.assignee ? ` (${scope.assignee})` : ''}`}
                  >
                    in scope for <strong>{scope.taskId}</strong>
                    {scope.assignee && <> · {scope.assignee}</>}
                  </span>
                );
              })()}
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
              {isDiagnosablePath(activeTab.path) && activeTabEditable && (
                <div className="code-mode-toggles" style={{ display: 'flex', border: '1px solid var(--border)', borderRadius: '4px', overflow: 'hidden' }}>
                  <button
                    className="btn btn-sm"
                    style={{ border: 'none', borderRadius: 0 }}
                    type="button"
                    onClick={() => void runActiveDiagnostics()}
                    disabled={pythonActionRunning || activeTab.saving || !onRunDiagnosticsRequest}
                  >
                    {pythonActionRunning ? 'Running' : 'Run diagnostics'}
                  </button>
                  <button
                    className="btn btn-sm"
                    style={{ border: 'none', borderRadius: 0 }}
                    type="button"
                    onClick={() => void runActivePythonAction('ide_format_file')}
                    disabled={pythonActionRunning || activeTab.saving}
                  >
                    Format
                  </button>
                  <button
                    className="btn btn-sm"
                    style={{ border: 'none', borderRadius: 0 }}
                    type="button"
                    onClick={() => void runActivePythonAction('ide_fix_file')}
                    disabled={pythonActionRunning || activeTab.saving}
                  >
                    Fix
                  </button>
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
                disabled={!activeTabEditable || !(isEditableIdeFile(activeTab.file) && activeTab.draftContent !== activeTab.file.content) || activeTab.saving || pythonActionRunning || activeTab.editorMode === 'diff'}
              >
                Revert
              </button>
              <button
                className="btn btn-sm btn-primary"
                type="button"
                onClick={() => void saveFile()}
                disabled={!activeTabEditable || !(isEditableIdeFile(activeTab.file) && activeTab.draftContent !== activeTab.file.content) || activeTab.saving || pythonActionRunning || activeTab.editorMode === 'diff'}
              >
                <Icon name="check" size={12} />
                {activeTab.saving ? 'Saving' : 'Save'}
              </button>
            </div>
          </div>
          
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {activeTab.loading && <div className="code-editor-state">Loading file...</div>}
            {activeTab.fileError && <div className="code-editor-state error">{activeTab.fileError}</div>}
            {activeTab.saveError && <div className="code-save-error">{activeTab.saveError}</div>}
            {!activeTab.loading && !activeTab.fileError && !activeTab.file && (
              <div className="code-editor-state">Select a file to edit it.</div>
            )}
            {activeTab.file && !isEditableIdeFile(activeTab.file) && (
              <div className="code-unsupported-file">
                <div className="code-unsupported-card">
                  <Icon name="file" size={22} />
                  <div>
                    <h3>{activeTab.path.split('/').pop()}</h3>
                    <p>{unsupportedReason(activeTab.file)}</p>
                    <dl>
                      <div><dt>Path</dt><dd className="mono">{activeTab.path}</dd></div>
                      <div><dt>Size</dt><dd>{formatBytes(activeTab.file.sizeBytes)}</dd></div>
                      <div><dt>Type</dt><dd>{activeTab.file.category ?? 'unsupported'}</dd></div>
                    </dl>
                  </div>
                </div>
              </div>
            )}
            {activeTab.file && isEditableIdeFile(activeTab.file) && (
              <div style={{ display: 'flex', width: '100%', height: '100%' }}>
                {activeTab.editorMode !== 'preview' && (
                  <div style={{ flex: 1, minWidth: 0, height: '100%' }}>
                    <Editor
                      height="100%"
                      value={activeTab.editorMode === 'diff' ? activeTab.diffContent : activeTab.draftContent}
                      language={activeTab.editorMode === 'diff' ? 'diff' : languageForFile(activeTab.file.relativePath, activeTab.file.languageHint)}
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
