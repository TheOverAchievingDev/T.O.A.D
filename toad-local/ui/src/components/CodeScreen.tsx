import { useEffect, useMemo, useState } from 'react';
import * as monaco from 'monaco-editor';
import Editor, { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { callTool, type Actor } from '@/api/client';
import type { UiTask } from '@/types';
import { Icon } from './Icon';

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

type IdeSource =
  | { kind: 'project' }
  | { kind: 'task_worktree'; taskId: string };

interface IdeTreeEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  sizeBytes?: number;
}

interface IdeTreeResult {
  source: IdeSource;
  rootLabel: string;
  entries: IdeTreeEntry[];
  truncated: boolean;
}

interface IdeFileResult {
  source: IdeSource;
  relativePath: string;
  content: string;
  encoding: 'utf8';
  sizeBytes: number;
  languageHint?: string;
}

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
}

const DEFAULT_ACTOR: Actor = { teamId: 'system', agentId: 'ui-client', agentName: 'ui', role: 'human' };

export function CodeScreen({ teamId, tasks, actor = DEFAULT_ACTOR }: CodeScreenProps) {
  const [sourceKey, setSourceKey] = useState('project');
  const [tree, setTree] = useState<IdeTreeResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<IdeFileResult | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);

  const worktreeTasks = useMemo(
    () => tasks.filter((task) => task.worktree?.status === 'created' && task.worktree.path),
    [tasks],
  );

  const source = useMemo<IdeSource>(() => {
    if (sourceKey.startsWith('task:')) {
      return { kind: 'task_worktree', taskId: sourceKey.slice(5) };
    }
    return { kind: 'project' };
  }, [sourceKey]);

  const toolActor = useMemo<Actor>(() => ({
    teamId: teamId ?? actor.teamId,
    agentId: actor.agentId,
    agentName: actor.agentName,
    role: actor.role,
  }), [actor.agentId, actor.agentName, actor.role, actor.teamId, teamId]);

  async function openFile(relativePath: string) {
    if (!teamId) return;
    setSelectedPath(relativePath);
    setLoadingFile(true);
    setFileError(null);
    try {
      const result = await callTool<IdeFileResult>({
        actor: toolActor,
        method: 'ide_read_file',
        args: { source, relativePath },
      });
      setFile(result);
    } catch (err) {
      setFile(null);
      setFileError(errorMessage(err));
    } finally {
      setLoadingFile(false);
    }
  }

  async function refreshTree(pathToReopen = selectedPath) {
    if (!teamId) return;
    setLoadingTree(true);
    setTreeError(null);
    try {
      const result = await callTool<IdeTreeResult>({
        actor: toolActor,
        method: 'ide_tree_list',
        args: { source },
      });
      setTree(result);

      if (pathToReopen && result.entries.some((entry) => entry.path === pathToReopen && entry.kind === 'file')) {
        await openFile(pathToReopen);
      } else {
        setSelectedPath(null);
        setFile(null);
        setFileError(null);
      }
    } catch (err) {
      setTree(null);
      setTreeError(errorMessage(err));
    } finally {
      setLoadingTree(false);
    }
  }

  useEffect(() => {
    setSelectedPath(null);
    setFile(null);
    setFileError(null);
    void refreshTree(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, sourceKey]);

  if (!teamId) {
    return (
      <div className="code-empty">
        Select a team to browse project files.
      </div>
    );
  }

  const files = tree?.entries.filter((entry) => entry.kind === 'file') ?? [];

  return (
    <main className="code-screen">
      <header className="code-header">
        <div>
          <div className="eyebrow">Read-only IDE</div>
          <h1>Code</h1>
          <p>{tree?.rootLabel ?? 'Project root'}</p>
        </div>
        <div className="code-actions">
          <select
            className="field-input mono code-source-select"
            value={sourceKey}
            onChange={(event) => setSourceKey(event.target.value)}
          >
            <option value="project">Project root</option>
            {worktreeTasks.map((task) => (
              <option key={task.id} value={`task:${task.id}`}>
                {task.id} - {task.title}
              </option>
            ))}
          </select>
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

      <div className="code-body">
        <aside className="code-tree" aria-label="Project files">
          {loadingTree && <div className="code-muted">Loading files...</div>}
          {treeError && <div className="code-error">{treeError}</div>}
          {tree?.truncated && <div className="code-muted">Tree truncated at the backend entry cap.</div>}
          {tree && files.length === 0 && (
            <div className="code-muted">No readable files found.</div>
          )}
          {tree?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className={`code-tree-row ${entry.kind} ${selectedPath === entry.path ? 'active' : ''}`}
              disabled={entry.kind !== 'file'}
              onClick={() => void openFile(entry.path)}
              title={entry.path}
            >
              <span className="code-tree-icon">
                <Icon name={entry.kind === 'directory' ? 'folder' : 'file'} size={13} />
              </span>
              <span className="code-tree-path">{entry.path}</span>
            </button>
          ))}
        </aside>

        <section className="code-editor-pane" aria-label="Selected file">
          <div className="code-filebar">
            <span className="mono">{selectedPath ?? 'No file selected'}</span>
            {file && <span className="dim">{formatBytes(file.sizeBytes)}</span>}
          </div>
          {loadingFile && <div className="code-editor-state">Loading file...</div>}
          {fileError && <div className="code-editor-state error">{fileError}</div>}
          {!loadingFile && !fileError && !file && (
            <div className="code-editor-state">Select a file to inspect it.</div>
          )}
          {file && (
            <Editor
              height="100%"
              value={file.content}
              language={file.languageHint ?? languageFromPath(file.relativePath)}
              theme="vs-dark"
              options={{
                readOnly: true,
                minimap: { enabled: false },
                automaticLayout: true,
                scrollBeyondLastLine: false,
                renderWhitespace: 'selection',
              }}
            />
          )}
        </section>
      </div>
    </main>
  );
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
