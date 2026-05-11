import { useEffect, useMemo, useState } from 'react';
import type { Actor } from '@/api/client';
import { callTool } from '@/api/client';
import type { Message, Runtime, Team, UiTask, ValidationKind, UiValidationRun } from '@/types';
import type { ProjectEntry } from '@/hooks/useProjects';
import type { DriftRunResult } from '@/hooks/useDrift';
import { roleStyle } from '@/data/roles';
import { Icon } from './Icon';
import { TaskRiskBadge } from './TaskRiskBadge';
import { DriftBadge } from './DriftBadge';
import { IdeFileTree } from './IdeFileTree';
import { IdeEditorPane } from './IdeEditorPane';
import { CockpitFlowCanvas } from './CockpitFlowCanvas';
import { CockpitReviewPane } from './CockpitReviewPane';
import {
  sourceKeyToIdeSource,
  type IdeStatusResult,
  type IdeTreeResult,
} from './ideSource';
import {
  buildCodeTree,
  collectDirectoryPaths,
  filterCodeTree,
  flattenVisibleCodeTree,
} from './codeTreeNavigator';
import {
  VALIDATION_KINDS,
  formatValidationDuration,
  formatValidationTime,
  sortValidationRuns,
  validationOutputLines,
  validationSummary,
} from './cockpitValidation';
import { buildCockpitOutputEntries } from './cockpitOutput';
import { summarizeCockpitReview } from './cockpitReview';
import { buildCockpitTaskGroups } from './cockpitTasks';
import { buildCockpitAgentRows } from './cockpitAgents';
import {
  buildCockpitFileSourceOptions,
  selectedTaskWorktreeSourceKey,
} from './cockpitFileSources';
import {
  buildCockpitSearchSummary,
  type CockpitSearchMatch,
} from './cockpitSearch';
import type { StreamEntry } from '@/utils/agentStream';

interface CockpitScreenProps {
  team: Team;
  tasks: UiTask[];
  runtimes: Runtime[];
  messages: Message[];
  agentStreams?: Record<string, StreamEntry[]>;
  teamId: string | null;
  developerMode: boolean;
  actor: Actor;
  projects: ProjectEntry[];
  activeProject: ProjectEntry | null;
  onSelectProject: (projectId: string) => void;
  onSelectFolder: () => void;
  onOpenTask: (taskId: string) => void;
  onCreateTask: () => void;
  onOpenLogs: (runtimeId: string) => void;
  driftData: DriftRunResult | null;
  driftLoading: boolean;
  driftError: string | null;
  onRefreshDrift: () => Promise<void>;
  onRefreshData: () => void;
  // TODO M.1a Task 4: refine into a concrete ReopenContext type + render
  // the paused-team header when reopenContext is present and isRunning
  // is false. Temporary loose typing keeps the typecheck gate green
  // while Task 3 ships the routing change.
  reopenContext?: unknown;
  onResumeTeam?: () => void;
}

type LeftTab = 'tasks' | 'files' | 'agents';
type CenterTab = 'flow' | 'code' | 'review';
type RightTab = 'inspect' | 'output' | 'review' | 'drift';

export function CockpitScreen({
  team,
  tasks,
  runtimes,
  messages,
  agentStreams = {},
  teamId,
  developerMode,
  actor,
  projects,
  activeProject,
  onSelectProject,
  onSelectFolder,
  onOpenTask,
  onCreateTask,
  onOpenLogs,
  driftData,
  driftLoading,
  driftError,
  onRefreshDrift,
  onRefreshData,
}: CockpitScreenProps) {
  const [leftTab, setLeftTab] = useState<LeftTab>('tasks');
  const [centerTab, setCenterTab] = useState<CenterTab>(developerMode ? 'code' : 'flow');
  const [rightTab, setRightTab] = useState<RightTab>('inspect');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(tasks[0]?.id ?? null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(team.members[0]?.id ?? null);
  const [testRunning, setTestRunning] = useState(false);
  const [terminalExpanded, setTerminalExpanded] = useState(false);
  const [testMessage, setTestMessage] = useState<string | null>(null);
  const [validationKind, setValidationKind] = useState<ValidationKind>('test');
  const [fileSourceKey, setFileSourceKey] = useState('project');
  const [fileTree, setFileTree] = useState<IdeTreeResult | null>(null);
  const [fileTreeError, setFileTreeError] = useState<string | null>(null);
  const [fileTreeLoading, setFileTreeLoading] = useState(false);
  const [fileQuery, setFileQuery] = useState('');
  const [fileContentQuery, setFileContentQuery] = useState('');
  const [fileSearchResults, setFileSearchResults] = useState<CockpitSearchMatch[] | null>(null);
  const [fileSearchLoading, setFileSearchLoading] = useState(false);
  const [fileSearchError, setFileSearchError] = useState<string | null>(null);
  const [expandedFilePaths, setExpandedFilePaths] = useState<Set<string>>(() => new Set());
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [externalOpenRequest, setExternalOpenRequest] = useState<{ sourceKey: string; path: string; requestId: number } | null>(null);

  const selectedTask = useMemo(() => {
    if (selectedTaskId) return tasks.find((task) => task.id === selectedTaskId) ?? tasks[0] ?? null;
    return tasks[0] ?? null;
  }, [selectedTaskId, tasks]);
  const selectedAgent = useMemo(() => {
    if (selectedAgentId) return team.members.find((member) => member.id === selectedAgentId) ?? null;
    if (selectedTask?.assignee) return team.members.find((member) => member.id === selectedTask.assignee) ?? null;
    return team.members.find((member) => member.role === 'lead') ?? team.members[0] ?? null;
  }, [selectedAgentId, selectedTask?.assignee, team.members]);

  const liveRuntimes = runtimes.filter((runtime) => runtime.status === 'live' || runtime.status === 'launching');
  const reviewTasks = tasks.filter((task) => task.status === 'review');
  const activeTasks = tasks.filter((task) => task.status !== 'done' && task.status !== 'rejected');
  const taskGroups = useMemo(() => buildCockpitTaskGroups(activeTasks), [activeTasks]);
  const agentRows = useMemo(
    () => buildCockpitAgentRows({ members: team.members, runtimes, streams: agentStreams }),
    [agentStreams, runtimes, team.members],
  );
  const selectedTaskSourceKey = selectedTaskWorktreeSourceKey(selectedTask);
  const fileSourceOptions = useMemo(
    () => buildCockpitFileSourceOptions({
      tasks,
      selectedTaskId: selectedTask?.id ?? null,
      projectLabel: activeProject?.name ?? 'Project root',
    }),
    [activeProject?.name, selectedTask?.id, tasks],
  );
  const fileSource = useMemo(() => sourceKeyToIdeSource(fileSourceKey), [fileSourceKey]);
  const codeTree = useMemo(() => buildCodeTree(fileTree?.entries ?? []), [fileTree?.entries]);
  const filteredTree = useMemo(() => filterCodeTree(codeTree, fileQuery), [codeTree, fileQuery]);
  const effectiveExpandedPaths = useMemo(
    () => (fileQuery.trim() ? new Set(filteredTree.expandedPaths) : expandedFilePaths),
    [expandedFilePaths, filteredTree.expandedPaths, fileQuery],
  );
  const visibleFileNodes = useMemo(
    () => flattenVisibleCodeTree(filteredTree.nodes, effectiveExpandedPaths),
    [effectiveExpandedPaths, filteredTree.nodes],
  );
  const visibleFiles = visibleFileNodes.filter((node) => node.kind === 'file');
  const fileSearchSummary = useMemo(
    () => buildCockpitSearchSummary(fileSearchResults ?? [], 24),
    [fileSearchResults],
  );
  const selectedDriftFindings = driftData?.findings.filter((finding) =>
    selectedTask ? finding.taskId === selectedTask.id : true,
  ) ?? [];
  const outputEntries = useMemo(
    () => buildCockpitOutputEntries({ streams: agentStreams, messages, limit: 12 }),
    [agentStreams, messages],
  );
  const validationRuns = useMemo(
    () => sortValidationRuns(selectedTask?.validations ?? []),
    [selectedTask?.validations],
  );
  const latestValidation = validationRuns[0] ?? null;
  const latestValidationOutput = validationOutputLines(latestValidation);
  const selectedKindLatestValidation = selectedTask?.latestValidation?.[validationKind] ?? null;
  const reviewSummary = summarizeCockpitReview({
    review: selectedTask?.review ?? null,
    validations: selectedTask?.validations ?? [],
  });
  const selectedAgentRuntime = selectedAgent ? runtimes.find((runtime) => runtime.agent === selectedAgent.id) ?? null : null;
  const selectedAgentTasks = selectedAgent
    ? activeTasks.filter((task) => task.assignee === selectedAgent.id)
    : [];
  const selectedAgentOutputEntries = selectedAgent
    ? outputEntries.filter((entry) => entry.agentId === selectedAgent.id).slice(0, 5)
    : [];

  const activeAgentsInWorktree = useMemo(() => {
    if (!fileSourceKey.startsWith('task:')) return [];
    const taskId = fileSourceKey.slice(5);
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.status === 'done' || task.status === 'rejected') return [];
    const assignee = task.assignee || 'lead';
    return liveRuntimes.filter(r => r.agent === assignee || r.agent === 'lead');
  }, [fileSourceKey, tasks, liveRuntimes]);

  async function refreshFiles() {
    if (!teamId) return;
    setFileTreeLoading(true);
    setFileTreeError(null);
    try {
      const [treeResult, statusResult] = await Promise.all([
        callTool<IdeTreeResult>({
          actor,
          method: 'ide_tree_list',
          args: { source: fileSource },
        }),
        callTool<IdeStatusResult>({
          actor,
          method: 'ide_get_status',
          args: { source: fileSource },
        }).catch(() => null),
      ]);
      if (statusResult) {
        const statusByPath = new Map(statusResult.entries.map((entry) => [entry.relativePath, entry.status.trim()]));
        for (const entry of treeResult.entries) {
          const status = statusByPath.get(entry.path);
          if (status) entry.gitStatus = status;
        }
      }
      setFileTree(treeResult);
      setExpandedFilePaths((current) => mergeExpandedPaths(current, getInitialExpandedPaths(treeResult.entries, activeFilePath)));
    } catch (err) {
      setFileTree(null);
      setFileTreeError(err instanceof Error ? err.message : String(err));
    } finally {
      setFileTreeLoading(false);
    }
  }

  async function searchFileContents() {
    const query = fileContentQuery.trim();
    if (!teamId || !query) {
      setFileSearchResults(null);
      setFileSearchError(null);
      return;
    }
    setFileSearchLoading(true);
    setFileSearchError(null);
    try {
      const result = await callTool<{ matches: CockpitSearchMatch[] }>({
        actor,
        method: 'ide_search_files',
        args: { source: fileSource, query },
      });
      setFileSearchResults(result.matches ?? []);
    } catch (err) {
      setFileSearchResults(null);
      setFileSearchError(err instanceof Error ? err.message : String(err));
    } finally {
      setFileSearchLoading(false);
    }
  }

  function openFileFromCockpit(path: string) {
    setActiveFilePath(path);
    setExpandedFilePaths((current) => mergeExpandedPaths(current, getInitialExpandedPaths([], path)));
    setExternalOpenRequest({ sourceKey: fileSourceKey, path, requestId: Date.now() });
  }

  useEffect(() => {
    setFileQuery('');
    setFileContentQuery('');
    setFileSearchResults(null);
    setFileSearchError(null);
    setExpandedFilePaths(new Set());
    setFileTreeError(null);
    void refreshFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamId, fileSourceKey, activeProject?.id]);

  useEffect(() => {
    if (fileSourceOptions.some((option) => option.key === fileSourceKey)) return;
    setFileSourceKey('project');
  }, [fileSourceKey, fileSourceOptions]);

  useEffect(() => {
    if (selectedAgentId && team.members.some((member) => member.id === selectedAgentId)) return;
    setSelectedAgentId(team.members.find((member) => member.role === 'lead')?.id ?? team.members[0]?.id ?? null);
  }, [selectedAgentId, team.members]);

  async function runSelectedTaskValidation() {
    if (!selectedTask || testRunning) return;
    setTestRunning(true);
    setTestMessage(null);
    try {
      const result = await callTool<UiValidationRun>({
        actor,
        method: 'validation_run',
        idempotencyKey: `cockpit-validation-${selectedTask.id}-${validationKind}-${Date.now()}`,
        args: { taskId: selectedTask.id, kind: validationKind },
      });
      setTestMessage(`${validationKind} ${result.verdict ?? 'recorded'}${typeof result.exitCode === 'number' ? `, exit ${result.exitCode}` : ''}`);
      onRefreshData();
    } catch (err) {
      setTestMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setTestRunning(false);
    }
  }

  function selectTaskInCockpit(taskId: string) {
    const task = tasks.find((candidate) => candidate.id === taskId) ?? null;
    setSelectedTaskId(taskId);
    setSelectedAgentId(task?.assignee || selectedAgentId);
    setRightTab('inspect');
  }

  function selectAgentInCockpit(agentId: string) {
    setSelectedAgentId(agentId);
    setRightTab('inspect');
  }

  function openSelectedTaskFilesInCode() {
    if (!selectedTaskSourceKey) return;
    setFileSourceKey(selectedTaskSourceKey);
    setLeftTab('files');
    setCenterTab('code');
  }

  return (
    <main className={`cockpit-screen ${developerMode ? 'dev-mode' : ''} ${terminalExpanded ? 'terminal-expanded' : ''}`}>
      <aside className="cockpit-left" aria-label="Cockpit task and agent status">
        <div className="cockpit-pane-head">
          <div>
            <div className="eyebrow">Cockpit</div>
            <h2>{team.name || activeProject?.name || 'No team'}</h2>
          </div>
          <button className="btn btn-sm btn-primary" type="button" onClick={onCreateTask}>
            <Icon name="plus" size={12} />
            Task
          </button>
        </div>
        <div className="cockpit-seg">
          <button type="button" className={leftTab === 'tasks' ? 'active' : ''} onClick={() => setLeftTab('tasks')}>
            <Icon name="kanban" size={12} />
            Tasks
          </button>
          <button type="button" className={leftTab === 'files' ? 'active' : ''} onClick={() => setLeftTab('files')}>
            <Icon name="folder" size={12} />
            Files
          </button>
          <button type="button" className={leftTab === 'agents' ? 'active' : ''} onClick={() => setLeftTab('agents')}>
            <Icon name="users" size={12} />
            Agents
          </button>
        </div>

        {leftTab === 'tasks' && (
          <div className="cockpit-task-list">
            {activeTasks.length === 0 ? (
              <div className="cockpit-empty">
                <Icon name="kanban" size={18} />
                <strong>No active tasks</strong>
                <span>Create a task to give the team work inside the cockpit.</span>
              </div>
            ) : (
              taskGroups.map((group) => (
                <section key={group.status} className="cockpit-task-group">
                  <div className="cockpit-task-group-head">
                    <span>{group.label}</span>
                    <strong>{group.count}</strong>
                  </div>
                  {group.tasks.length === 0 ? (
                    <div className="cockpit-task-group-empty">No tasks</div>
                  ) : group.tasks.map((task) => {
                    const member = team.members.find((m) => m.id === task.assignee);
                    return (
                      <button
                        key={task.id}
                        type="button"
                        className={`cockpit-task ${selectedTask?.id === task.id ? 'active' : ''}`}
                        style={roleStyle(member?.role ?? 'developer')}
                        onClick={() => selectTaskInCockpit(task.id)}
                        onDoubleClick={() => onOpenTask(task.id)}
                        title="Double-click to open full task detail"
                      >
                        <span className="cockpit-task-top">
                          <span className="task-id">{task.id}</span>
                          <span className={`cockpit-status ${task.status}`}>{task.status}</span>
                        </span>
                        <span className="cockpit-task-title">{task.title}</span>
                        <span className="cockpit-task-meta">
                          {member ? member.name : task.assignee || 'unassigned'}
                          {task.riskLevel && (
                            <TaskRiskBadge
                              level={task.riskLevel}
                              requiresHumanApproval={task.requiresHumanApproval}
                              humanApproved={task.humanApproved}
                              matchedRules={task.matchedRules}
                            />
                          )}
                          <DriftBadge score={driftData?.perTaskScores?.[task.id]} />
                        </span>
                      </button>
                    );
                  })}
                </section>
              ))
            )}
          </div>
        )}

        {leftTab === 'files' && (
          <div className="cockpit-files">
            <div className="cockpit-file-controls">
              {projects.length > 0 && (
                <select
                  className="field-input mono"
                  value={activeProject?.id ?? ''}
                  aria-label="Active project"
                  onChange={(event) => event.target.value && onSelectProject(event.target.value)}
                >
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              )}
              <button className="btn btn-sm" type="button" onClick={onSelectFolder}>
                <Icon name="folder" size={12} />
                Open folder
              </button>
              {selectedTaskSourceKey && fileSourceKey !== selectedTaskSourceKey && (
                <button
                  className="btn btn-sm"
                  type="button"
                  onClick={() => setFileSourceKey(selectedTaskSourceKey)}
                  title="Switch the file tree and editor to the selected task worktree"
                >
                  <Icon name="kanban" size={12} />
                  Selected task files
                </button>
              )}
              <select
                className="field-input mono"
                value={fileSourceKey}
                aria-label="File source"
                onChange={(event) => setFileSourceKey(event.target.value)}
              >
                {fileSourceOptions.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.isSelectedTask ? '* ' : ''}{option.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="code-tree-search cockpit-file-search">
              <Icon name="search" size={12} />
              <input
                value={fileQuery}
                onChange={(event) => setFileQuery(event.target.value)}
                placeholder="Filter files..."
                aria-label="Filter files"
              />
              {fileQuery && (
                <button
                  type="button"
                  className="code-tree-clear"
                  onClick={() => setFileQuery('')}
                  aria-label="Clear file filter"
                >
                  x
                </button>
              )}
            </div>
            <div className="cockpit-content-search">
              <div className="code-tree-search cockpit-file-search">
                <Icon name="search" size={12} />
                <input
                  value={fileContentQuery}
                  onChange={(event) => setFileContentQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void searchFileContents();
                  }}
                  placeholder="Search contents..."
                  aria-label="Search file contents"
                />
                {fileContentQuery && (
                  <button
                    type="button"
                    className="code-tree-clear"
                    onClick={() => {
                      setFileContentQuery('');
                      setFileSearchResults(null);
                      setFileSearchError(null);
                    }}
                    aria-label="Clear content search"
                  >
                    x
                  </button>
                )}
              </div>
              <button className="btn btn-sm" type="button" onClick={() => void searchFileContents()} disabled={fileSearchLoading || !fileContentQuery.trim()}>
                {fileSearchLoading ? 'Searching' : 'Find'}
              </button>
            </div>
            {fileSearchError && <div className="code-error">{fileSearchError}</div>}
            {fileSearchResults && (
              <div className="cockpit-search-results" aria-label="Content search results">
                <div className="cockpit-search-summary">
                  <span>{fileSearchSummary.totalCount} match{fileSearchSummary.totalCount === 1 ? '' : 'es'}</span>
                  {fileSearchSummary.overflowCount > 0 && <em>{fileSearchSummary.overflowCount} hidden</em>}
                </div>
                {fileSearchSummary.rows.length === 0 ? (
                  <div className="code-muted">No content matches found.</div>
                ) : fileSearchSummary.rows.map((match) => (
                  <button
                    key={match.id}
                    className="cockpit-search-result"
                    type="button"
                    onClick={() => openFileFromCockpit(match.relativePath)}
                  >
                    <strong className="mono">{match.title}</strong>
                    <span>{match.snippet}</span>
                  </button>
                ))}
              </div>
            )}
            <div className="code-tree-tools">
              <button type="button" onClick={() => setExpandedFilePaths(new Set(collectDirectoryPaths(codeTree)))}>
                Expand all
              </button>
              <button type="button" onClick={() => setExpandedFilePaths(new Set())}>
                Collapse all
              </button>
              <button type="button" onClick={() => void refreshFiles()}>
                {fileTreeLoading ? 'Loading' : 'Refresh'}
              </button>
            </div>
            {fileTreeLoading && <div className="code-muted">Loading files...</div>}
            {fileTreeError && <div className="code-error">{fileTreeError}</div>}
            {fileTree?.truncated && <div className="code-muted">Tree truncated at the backend entry cap.</div>}
            {fileTree && visibleFiles.length === 0 && (
              <div className="code-muted">{fileQuery ? 'No matches found.' : 'No readable files found.'}</div>
            )}
            <IdeFileTree
              nodes={visibleFileNodes}
              expandedPaths={effectiveExpandedPaths}
              activePath={activeFilePath}
              onToggleDirectory={(path) => setExpandedFilePaths((current) => toggleExpandedPath(current, path))}
              onOpenFile={openFileFromCockpit}
            />
          </div>
        )}

        {leftTab === 'agents' && (
          <div className="cockpit-agent-list">
            {team.members.length === 0 ? (
              <div className="cockpit-empty">
                <Icon name="users" size={18} />
                <strong>No team yet</strong>
                <span>Create or launch a team to see agent status here.</span>
              </div>
            ) : (
              agentRows.map((row) => {
                const { member, runtime } = row;
                return (
                  <button
                    key={member.id}
                    type="button"
                    className="cockpit-agent"
                    style={roleStyle(member.role)}
                    onClick={() => selectAgentInCockpit(member.id)}
                    onDoubleClick={() => row.canOpenLogs && runtime && onOpenLogs(runtime.id)}
                  >
                    <span className={`status-dot ${row.status}`} />
                    <span className="agent-avatar">{member.avatar}</span>
                    <span className="cockpit-agent-main">
                      <span className="cockpit-agent-name-row">
                        <strong>{member.name}</strong>
                        <em>{member.role}</em>
                      </span>
                      <span>{row.latestActivity}</span>
                      <span className="cockpit-agent-runtime">{row.runtimeLabel ?? member.model}</span>
                    </span>
                    <span className="mono cockpit-agent-pid">
                      {runtime ? `pid ${runtime.pid}` : row.status}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        )}
      </aside>

      <section className="cockpit-center" aria-label="Flow canvas and code editor">
        <div className="cockpit-center-tabs" role="tablist" aria-label="Cockpit center view">
          <button
            type="button"
            className={centerTab === 'flow' ? 'active' : ''}
            onClick={() => setCenterTab('flow')}
          >
            <Icon name="workflow" size={13} />
            Flow
          </button>
          <button
            type="button"
            className={centerTab === 'code' ? 'active' : ''}
            onClick={() => setCenterTab('code')}
          >
            <Icon name="code" size={13} />
            Code
          </button>
          <button
            type="button"
            className={centerTab === 'review' ? 'active' : ''}
            onClick={() => setCenterTab('review')}
          >
            <Icon name="eye" size={13} />
            Review
          </button>
        </div>
        <div className="cockpit-center-body">
          {centerTab === 'flow' ? (
            <CockpitFlowCanvas
              team={team}
              tasks={tasks}
              runtimes={runtimes}
              messages={messages}
              agentStreams={agentStreams}
              selectedTaskId={selectedTask?.id ?? null}
              selectedAgentId={selectedAgent?.id ?? null}
              driftData={driftData}
              onSelectTask={selectTaskInCockpit}
              onSelectAgent={selectAgentInCockpit}
              onOpenTask={onOpenTask}
              onOpenLogs={onOpenLogs}
              onCreateTask={onCreateTask}
            />
          ) : centerTab === 'review' ? (
            <CockpitReviewPane
              task={selectedTask}
              validationRuns={validationRuns}
              reviewSummary={reviewSummary}
              driftData={driftData}
              canOpenTaskFiles={Boolean(selectedTaskSourceKey)}
              onOpenTask={onOpenTask}
              onOpenTaskFiles={openSelectedTaskFilesInCode}
              onRunValidation={() => void runSelectedTaskValidation()}
              validationRunning={testRunning}
            />
          ) : (
            <IdeEditorPane
              source={fileSource}
              actor={actor}
              driftData={driftData}
              activeAgentsInWorktree={activeAgentsInWorktree}
              externalOpenRequest={externalOpenRequest}
              onRefreshTreeRequest={(path) => {
                if (path) setActiveFilePath(path);
                void refreshFiles();
              }}
            />
          )}
        </div>
      </section>

      <aside className="cockpit-right" aria-label="Agent output, review notes, and drift">
        <div className="cockpit-seg">
          <button type="button" className={rightTab === 'inspect' ? 'active' : ''} onClick={() => setRightTab('inspect')}>
            Inspect
          </button>
          <button type="button" className={rightTab === 'output' ? 'active' : ''} onClick={() => setRightTab('output')}>
            Output
          </button>
          <button type="button" className={rightTab === 'review' ? 'active' : ''} onClick={() => setRightTab('review')}>
            Review
            {reviewTasks.length > 0 && <span className="count-pill">{reviewTasks.length}</span>}
          </button>
          <button type="button" className={rightTab === 'drift' ? 'active' : ''} onClick={() => setRightTab('drift')}>
            Drift
          </button>
        </div>

        {rightTab === 'inspect' && (
          <div className="cockpit-right-body">
            <div className="cockpit-panel-title">
              <h3>Inspector</h3>
              {selectedTask && (
                <button className="btn btn-sm" type="button" onClick={() => onOpenTask(selectedTask.id)}>
                  Open task
                </button>
              )}
            </div>

            {selectedAgent ? (
              <section className="cockpit-inspect-card" style={roleStyle(selectedAgent.role)}>
                <div className="cockpit-inspect-agent">
                  <span className={`status-dot ${runtimeStatusClass(selectedAgentRuntime?.status ?? selectedAgent.status)}`} />
                  <span className="agent-avatar">{selectedAgent.avatar}</span>
                  <div>
                    <strong>{selectedAgent.name}</strong>
                    <span>{selectedAgent.role} / {selectedAgent.provider} {selectedAgent.model}</span>
                  </div>
                </div>
                <div className="cockpit-inspect-grid">
                  <Metric label="Runtime" value={selectedAgentRuntime?.status ?? selectedAgent.status} />
                  <Metric label="Assigned" value={String(selectedAgentTasks.length)} />
                  <Metric label="Done" value={String(selectedAgent.tasksDone)} />
                  <Metric label="Tokens" value={formatTokenUse(selectedAgent.tokens, selectedAgent.tokenLimit)} />
                </div>
                {selectedAgentRuntime && (
                  <button className="btn btn-sm" type="button" onClick={() => onOpenLogs(selectedAgentRuntime.id)}>
                    <Icon name="terminal" size={12} />
                    Open logs
                  </button>
                )}
              </section>
            ) : (
              <div className="cockpit-empty small">Select an agent to inspect runtime context.</div>
            )}

            {selectedTask ? (
              <section className="cockpit-inspect-card task">
                <div className="cockpit-inspect-task-head">
                  <span className="task-id">{selectedTask.id}</span>
                  <span className={`cockpit-status ${selectedTask.status}`}>{selectedTask.status}</span>
                </div>
                <h3>{selectedTask.title}</h3>
                <div className="cockpit-inspect-row">
                  <span>Assignee</span>
                  <strong>{selectedTask.assignee || 'unassigned'}</strong>
                </div>
                <div className="cockpit-inspect-row">
                  <span>Validations</span>
                  <strong>{validationSummary(validationRuns)}</strong>
                </div>
                <div className="cockpit-inspect-row">
                  <span>Review</span>
                  <strong>{reviewSummary.state}</strong>
                </div>
                <div className="cockpit-inspect-row">
                  <span>Drift</span>
                  <strong>{driftData?.perTaskScores?.[selectedTask.id] ?? '-'}</strong>
                </div>
                <div className="cockpit-inspect-chips">
                  {selectedTask.riskLevel && (
                    <TaskRiskBadge
                      level={selectedTask.riskLevel}
                      requiresHumanApproval={selectedTask.requiresHumanApproval}
                      humanApproved={selectedTask.humanApproved}
                      matchedRules={selectedTask.matchedRules}
                    />
                  )}
                  <DriftBadge score={driftData?.perTaskScores?.[selectedTask.id]} />
                </div>
                <div className="cockpit-inspect-actions">
                  <button className="btn btn-sm" type="button" onClick={() => setCenterTab('review')}>
                    <Icon name="eye" size={12} />
                    Review center
                  </button>
                  <button className="btn btn-sm" type="button" onClick={openSelectedTaskFilesInCode} disabled={!selectedTaskSourceKey}>
                    <Icon name="code" size={12} />
                    Task files
                  </button>
                </div>
              </section>
            ) : (
              <div className="cockpit-empty small">Select a task on the Flow canvas to inspect delivery state.</div>
            )}

            <section className="cockpit-inspect-card">
              <div className="cockpit-panel-title">
                <h3>Focused output</h3>
              </div>
              {selectedAgentOutputEntries.length === 0 ? (
                <div className="cockpit-empty small">No output for the selected agent yet.</div>
              ) : selectedAgentOutputEntries.map((entry) => (
                <div key={entry.id} className={`cockpit-output-entry ${entry.kind}`}>
                  <div className="cockpit-output-meta">
                    <span className="mono">{entry.time || '--:--:--'}</span>
                    <strong>{entry.agentId}</strong>
                    <em>{entry.label}</em>
                  </div>
                  <p>{entry.body}</p>
                </div>
              ))}
            </section>
          </div>
        )}

        {rightTab === 'output' && (
          <div className="cockpit-right-body">
            <div className="cockpit-metric-grid">
              <Metric label="Live" value={`${liveRuntimes.length}/${runtimes.length}`} />
              <Metric label="Open" value={String(activeTasks.length)} />
              <Metric label="Review" value={String(reviewTasks.length)} />
              <Metric label="Drift" value={driftData ? `${driftData.teamScore}%` : '-'} />
            </div>
            <h3>Recent output</h3>
            {outputEntries.length === 0 ? (
              <div className="cockpit-empty small">No agent output yet.</div>
            ) : (
              <div className="cockpit-output-list">
                {outputEntries.map((entry) => (
                  <div key={entry.id} className={`cockpit-output-entry ${entry.kind}`}>
                    <div className="cockpit-output-meta">
                      <span className="mono">{entry.time || '--:--:--'}</span>
                      <strong>{entry.agentId}</strong>
                      <em>{entry.label}</em>
                    </div>
                    <p>{entry.body}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {rightTab === 'review' && (
          <div className="cockpit-right-body">
            <h3>{selectedTask ? selectedTask.id : 'No task selected'}</h3>
            {selectedTask ? (
              <>
                <p className="dim">{selectedTask.title}</p>
                <div className={`cockpit-review-card ${reviewSummary.state}`}>
                  <span>Review gate</span>
                  <strong>{reviewSummary.state}</strong>
                  <p>{selectedTask.review?.summary || selectedTask.review?.reason || 'No review request has been recorded for this task yet.'}</p>
                </div>
                <div className="cockpit-review-row">
                  <span>Status</span>
                  <strong>{selectedTask.status}</strong>
                </div>
                <div className="cockpit-review-row">
                  <span>Assignee</span>
                  <strong>{selectedTask.assignee || 'unassigned'}</strong>
                </div>
                <div className="cockpit-review-row">
                  <span>Files changed</span>
                  <strong>{reviewSummary.fileCount}</strong>
                </div>
                <div className="cockpit-review-row">
                  <span>Scope drift</span>
                  <strong>{reviewSummary.scopeDriftCount}</strong>
                </div>
                <div className="cockpit-review-row">
                  <span>Validations</span>
                  <strong>{reviewSummary.validationLabel}</strong>
                </div>
                {selectedTask.review?.requestedAt && (
                  <div className="cockpit-review-row">
                    <span>Requested</span>
                    <strong>{formatValidationTime(selectedTask.review.requestedAt) ?? selectedTask.review.requestedAt}</strong>
                  </div>
                )}
                {(selectedTask.review?.files?.length ?? 0) > 0 && (
                  <div className="cockpit-review-files">
                    <span>Changed files</span>
                    {selectedTask.review?.files.slice(0, 6).map((file) => (
                      <code key={file}>{file}</code>
                    ))}
                    {(selectedTask.review?.files.length ?? 0) > 6 && (
                      <em>{(selectedTask.review?.files.length ?? 0) - 6} more</em>
                    )}
                  </div>
                )}
                {(selectedTask.review?.scopeDrift?.length ?? 0) > 0 && (
                  <div className="cockpit-review-files drift">
                    <span>Scope drift</span>
                    {selectedTask.review?.scopeDrift.slice(0, 4).map((file) => (
                      <code key={file}>{file}</code>
                    ))}
                  </div>
                )}
                <button className="btn btn-sm" type="button" onClick={() => onOpenTask(selectedTask.id)}>
                  Open full task
                </button>
              </>
            ) : (
              <div className="cockpit-empty small">Select a task to inspect review context.</div>
            )}
          </div>
        )}

        {rightTab === 'drift' && (
          <div className="cockpit-right-body">
            <div className="cockpit-panel-title">
              <h3>Drift report</h3>
              <button className="btn btn-sm" type="button" onClick={() => void onRefreshDrift()} disabled={driftLoading}>
                <Icon name="refresh" size={12} />
                {driftLoading ? 'Running' : 'Run'}
              </button>
            </div>
            {driftError && <div className="code-error">{driftError}</div>}
            {!driftData && !driftError && <div className="cockpit-empty small">No drift run yet.</div>}
            {driftData && (
              <>
                <div className="cockpit-drift-score">
                  <strong>{driftData.teamScore}%</strong>
                  <span>{driftData.status}</span>
                </div>
                {(selectedDriftFindings.length === 0) ? (
                  <div className="cockpit-empty small">No drift findings for the selected task.</div>
                ) : selectedDriftFindings.slice(0, 6).map((finding) => (
                  <div key={finding.id} className={`cockpit-finding ${finding.severity}`}>
                    <span>{finding.severity}</span>
                    <strong>{finding.title}</strong>
                    <p>{finding.recommendedCorrection}</p>
                  </div>
                ))}
              </>
            )}
          </div>
        )}
      </aside>
      {developerMode && (
        <section
          className={`cockpit-bottom ${terminalExpanded ? 'expanded' : 'collapsed'}`}
          aria-label="Integrated terminal and test runner"
        >
          <div className="cockpit-bottom-title">
            <Icon name="terminal" size={14} />
            <div>
              <strong>Terminal / Test Runner</strong>
              <span className="dim">
                {selectedTask ? `${selectedTask.id} · ${validationSummary(validationRuns)}` : 'No task selected'}
              </span>
            </div>
            <button
              className="btn btn-sm cockpit-terminal-toggle"
              type="button"
              onClick={() => setTerminalExpanded((expanded) => !expanded)}
            >
              <Icon name={terminalExpanded ? 'chevronDown' : 'chevronUp'} size={12} />
              {terminalExpanded ? 'Collapse' : 'Expand'}
            </button>
          </div>
          <div className="cockpit-terminal">
            <div className="cockpit-validation-bar">
              <select
                className="field-input mono cockpit-validation-kind"
                value={validationKind}
                onChange={(event) => setValidationKind(event.target.value as ValidationKind)}
                aria-label="Validation kind"
              >
                {VALIDATION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {kind}
                  </option>
                ))}
              </select>
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => void runSelectedTaskValidation()}
                disabled={!selectedTask || testRunning}
              >
                <Icon name="play" size={12} />
                {testRunning ? 'Running' : selectedKindLatestValidation ? 'Re-run' : 'Run'}
              </button>
              {testMessage && <span className="mono cockpit-test-message">{testMessage}</span>}
            </div>
            <div className="cockpit-validation-history" aria-label="Validation history">
              {validationRuns.length === 0 ? (
                <span className="dim">No validation runs yet.</span>
              ) : validationRuns.slice(0, 4).map((run) => (
                <span
                  key={`${run.kind}-${run.createdAt ?? run.command ?? 'run'}`}
                  className={`cockpit-validation-chip ${run.verdict}`}
                >
                  {run.kind}
                  <strong>{run.verdict}</strong>
                  {formatValidationDuration(run.durationMs) && <em>{formatValidationDuration(run.durationMs)}</em>}
                </span>
              ))}
            </div>
            <pre className="cockpit-terminal-output">
              {latestValidation
                ? [
                    `$ ${latestValidation.command ?? `${latestValidation.kind} command not configured`}`,
                    `verdict=${latestValidation.verdict}${latestValidation.exitCode !== null ? ` exit=${latestValidation.exitCode}` : ''}${formatValidationTime(latestValidation.createdAt) ? ` at ${formatValidationTime(latestValidation.createdAt)}` : ''}`,
                    ...latestValidationOutput.slice(0, 12),
                    latestValidationOutput.length > 12 ? `... ${latestValidationOutput.length - 12} more lines` : '',
                  ].filter(Boolean).join('\n')
                : 'Select a task and run a validation to see command output here.'}
            </pre>
          </div>
        </section>
      )}
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="cockpit-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function runtimeStatusClass(status: Runtime['status'] | Team['members'][number]['status']): string {
  if (status === 'live') return 'live active';
  if (status === 'launching' || status === 'thinking') return 'thinking active';
  if (status === 'error') return 'err active';
  return 'idle';
}

function formatTokenUse(tokens: number, tokenLimit: number): string {
  if (!tokenLimit) return `${tokens.toLocaleString()}`;
  return `${Math.round((tokens / tokenLimit) * 100)}%`;
}

function getInitialExpandedPaths(entries: { path: string; kind: 'file' | 'directory' }[], selectedPath: string | null): Set<string> {
  const expanded = new Set<string>();
  for (const entry of entries) {
    if (entry.kind === 'directory' && !entry.path.includes('/')) expanded.add(entry.path);
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
  if (next.has(path)) next.delete(path);
  else next.add(path);
  return next;
}
