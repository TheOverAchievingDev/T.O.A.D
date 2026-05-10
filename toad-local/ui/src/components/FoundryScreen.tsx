import { useCallback, useEffect, useMemo, useState } from 'react';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import { Icon } from './Icon';

interface FoundrySessionSummary {
  sessionId: string;
  title: string;
  status: 'draft' | 'ready' | 'exported' | 'archived';
  projectPath: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  artifactCount: number;
}

interface FoundryMessage {
  messageId: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  createdAt: string;
}

interface FoundryArtifact {
  artifactId: string;
  sessionId: string;
  kind: string;
  title: string;
  content: string;
  targetPath: string | null;
  version: number;
  status: 'draft' | 'approved' | 'exported';
  updatedAt: string;
}

interface FoundrySessionDetail {
  session: FoundrySessionSummary;
  messages: FoundryMessage[];
  artifacts: FoundryArtifact[];
}

interface FoundryExportResult {
  files: Array<{ artifactId: string; targetPath: string; absolutePath: string }>;
}

interface FoundryMaterializeResult {
  sessionId: string;
  mode?: 'plan' | 'apply';
  teamId: string;
  files: Array<{ artifactId: string; targetPath: string; absolutePath: string }>;
  tasks?: Array<{ taskId: string; subject: string }>;
}

export interface FoundryPlanResult {
  sessionId: string;
  teamId: string;
  files: Array<{ artifactId: string; targetPath: string; absolutePath: string }>;
  suggestedTeam: {
    teamId: string;
    cwd: string;
    leadPrompt: string;
    lead: { agentId: string; role: string; providerId: string; skipPermissions?: boolean };
    teammates: Array<{ agentId: string; role: string; providerId: string; skipPermissions?: boolean }>;
  };
  suggestedTasks: Array<{
    taskId: string;
    subject: string;
    description?: string;
    assignedRole?: string;
    expectedDeliverables?: string[];
    acceptanceCriteria?: string[];
  }>;
}

interface FoundryScreenProps {
  teamId: string;
  /** Whether a project is currently loaded (sidecar has TOAD_PROJECT_CWD).
   *  When false, "Create team" first prompts the user to pick a folder so
   *  the project can materialize *somewhere*. */
  hasActiveProject?: boolean;
  /** Async function that opens a Tauri folder picker, switches the
   *  orchestrator to the chosen folder, and resolves once the sidecar has
   *  restarted. The Foundry screen calls this BEFORE materialize when no
   *  project is loaded. Resolves to true if a folder was picked, false if
   *  the user cancelled. */
  onPickProjectFolder?: () => Promise<boolean>;
  /** Called after `foundry_project_materialize` runs in plan mode — the
   *  parent should open the CreateTeamModal pre-filled from the suggestion
   *  and, after team_create succeeds, call `foundry_project_seed_tasks`.
   *  Falling back to onMaterialized when this callback isn't provided
   *  preserves the legacy auto-create behavior. */
  onMaterializePlan?: (plan: FoundryPlanResult) => void;
  onMaterialized?: (teamId: string) => void;
  /** When true, the Foundry chat shows a first-run welcome banner
   *  above the thread. Flips off after the user dismisses or sends
   *  their first message. */
  firstRun?: boolean;
  /** Called when the user dismisses the welcome banner OR sends
   *  their first chat turn successfully. Parent flips
   *  tweaks.firstRunComplete in response. */
  onFirstRunDismiss?: () => void;
}

const ACTOR_AGENT = 'ui-foundry';

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function FoundryScreen({
  teamId,
  hasActiveProject = true,
  onPickProjectFolder,
  onMaterializePlan,
  onMaterialized,
  firstRun = false,
  onFirstRunDismiss,
}: FoundryScreenProps) {
  const actor = useMemo<Actor>(() => ({
    teamId: teamId || 'foundry',
    agentId: ACTOR_AGENT,
    agentName: 'Foundry',
    role: 'human',
  }), [teamId]);
  const [sessions, setSessions] = useState<FoundrySessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [detail, setDetail] = useState<FoundrySessionDetail | null>(null);
  const [title, setTitle] = useState('New project plan');
  const [message, setMessage] = useState('');
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  const [artifactDraft, setArtifactDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exported, setExported] = useState<FoundryExportResult | null>(null);
  const [materialized, setMaterialized] = useState<FoundryMaterializeResult | null>(null);

  const loadSessions = useCallback(async () => {
    const result = await callTool<FoundrySessionSummary[]>({
      actor,
      method: 'foundry_session_list',
    });
    setSessions(result);
    if (!activeSessionId && result[0]) setActiveSessionId(result[0].sessionId);
  }, [actor, activeSessionId]);

  const loadDetail = useCallback(async (sessionId: string) => {
    const result = await callTool<FoundrySessionDetail>({
      actor,
      method: 'foundry_session_get',
      args: { sessionId },
    });
    setDetail(result);
    const selected = result.artifacts.find((artifact) => artifact.artifactId === selectedArtifactId)
      ?? result.artifacts[0]
      ?? null;
    setSelectedArtifactId(selected?.artifactId ?? null);
    setArtifactDraft(selected?.content ?? '');
  }, [actor, selectedArtifactId]);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    callTool<FoundrySessionSummary[]>({ actor, method: 'foundry_session_list' })
      .then((result) => {
        if (cancelled) return;
        setSessions(result);
        if (!activeSessionId && result[0]) setActiveSessionId(result[0].sessionId);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(formatError(err));
      });
    return () => { cancelled = true; };
  }, [actor, activeSessionId]);

  useEffect(() => {
    if (!activeSessionId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setError(null);
    callTool<FoundrySessionDetail>({
      actor,
      method: 'foundry_session_get',
      args: { sessionId: activeSessionId },
    })
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        const selected = result.artifacts.find((artifact) => artifact.artifactId === selectedArtifactId)
          ?? result.artifacts[0]
          ?? null;
        setSelectedArtifactId(selected?.artifactId ?? null);
        setArtifactDraft(selected?.content ?? '');
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(formatError(err));
      });
    return () => { cancelled = true; };
  }, [actor, activeSessionId, selectedArtifactId]);

  const selectedArtifact = detail?.artifacts.find((artifact) => artifact.artifactId === selectedArtifactId) ?? null;

  async function runAction<T>(label: string, action: () => Promise<T>): Promise<T | null> {
    setBusy(label);
    setError(null);
    try {
      return await action();
    } catch (err) {
      setError(formatError(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function createSession() {
    const created = await runAction('create', () =>
      callTool<FoundrySessionSummary>({
        actor,
        method: 'foundry_session_create',
        idempotencyKey: makeId('foundry-session'),
        args: { title },
      })
    );
    if (!created) return;
    setActiveSessionId(created.sessionId);
    setMessage('');
    setExported(null);
    setMaterialized(null);
    await loadSessions();
    await loadDetail(created.sessionId);
  }

  async function sendChatTurn() {
    if (!message.trim()) return;

    // First-run auto-session: when the user is sending a message but
    // no session exists yet (brand-new install), create one inline so
    // the welcome banner doesn't need to nag the user to click "New".
    let sessionId = activeSessionId;
    if (!sessionId) {
      const created = await runAction('create', () =>
        callTool<FoundrySessionSummary>({
          actor,
          method: 'foundry_session_create',
          idempotencyKey: makeId('foundry-session'),
          args: { title: 'My first project' },
        })
      );
      if (!created) return;
      sessionId = created.sessionId;
      setActiveSessionId(sessionId);
      await loadSessions();
    }

    const added = await runAction('message', () =>
      callTool<{ assistant: FoundryMessage }>({
        actor,
        method: 'foundry_chat_turn',
        idempotencyKey: makeId('foundry-chat'),
        args: {
          sessionId,
          text: message.trim(),
        },
      })
    );
    if (!added) return;
    setMessage('');
    await loadSessions();
    await loadDetail(sessionId);
    // First message landed — the user has clearly engaged. Flip the
    // first-run flag so the welcome banner stays gone going forward.
    onFirstRunDismiss?.();
  }

  async function generateArtifacts() {
    if (!activeSessionId) return;
    const generated = await runAction('generate', () =>
      callTool<{ artifacts: FoundryArtifact[] }>({
        actor,
        method: 'foundry_artifact_generate',
        idempotencyKey: makeId('foundry-generate'),
        args: { sessionId: activeSessionId },
      })
    );
    if (!generated) return;
    setSelectedArtifactId(generated.artifacts[0]?.artifactId ?? null);
    await loadSessions();
    await loadDetail(activeSessionId);
  }

  async function saveArtifact() {
    if (!selectedArtifact) return;
    const saved = await runAction('save', () =>
      callTool<FoundryArtifact>({
        actor,
        method: 'foundry_artifact_upsert',
        idempotencyKey: makeId('foundry-save'),
        args: {
          artifactId: selectedArtifact.artifactId,
          sessionId: selectedArtifact.sessionId,
          kind: selectedArtifact.kind,
          title: selectedArtifact.title,
          content: artifactDraft,
          targetPath: selectedArtifact.targetPath,
          status: selectedArtifact.status,
        },
      })
    );
    if (!saved) return;
    await loadDetail(saved.sessionId);
  }

  async function exportArtifacts() {
    if (!activeSessionId) return;
    const result = await runAction('export', () =>
      callTool<FoundryExportResult>({
        actor,
        method: 'foundry_artifact_export',
        idempotencyKey: makeId('foundry-export'),
        args: { sessionId: activeSessionId },
      })
    );
    if (!result) return;
    setExported(result);
    await loadSessions();
    await loadDetail(activeSessionId);
  }

  async function materializeProject() {
    if (!activeSessionId) return;
    // Pre-flight: when no project is loaded yet (the user reached Foundry
    // via "Create new project" on the welcome screen), the orchestrator
    // has no working directory to materialize into. Pop the folder picker
    // first; the sidecar restarts with the chosen path; foundry sessions
    // survive the restart because they live in ~/.symphony/foundry.db.
    if (!hasActiveProject) {
      if (!onPickProjectFolder) {
        setError('No project loaded. Open the welcome screen and pick a folder before materializing.');
        return;
      }
      const picked = await onPickProjectFolder();
      if (!picked) return; // user cancelled the folder picker
      // Give the sidecar a beat to come back up after `switch_project`.
      // The Tauri command kills + respawns; the Node process needs a moment
      // before its API responds. Two short retries with backoff are usually
      // plenty.
      await new Promise((r) => setTimeout(r, 800));
    }
    // When the parent provides onMaterializePlan, run in plan mode so the
    // user can craft the team in CreateTeamModal before the team is
    // actually created. Falling back to apply mode preserves the legacy
    // "auto-create everything" behavior for parents that don't use the
    // plan/handoff flow.
    if (onMaterializePlan) {
      const plan = await runAction('materialize', () =>
        callTool<FoundryPlanResult>({
          actor,
          method: 'foundry_project_materialize',
          idempotencyKey: makeId('foundry-materialize-plan'),
          args: { sessionId: activeSessionId, mode: 'plan' },
        })
      );
      if (!plan) return;
      setExported({ files: plan.files });
      await loadSessions();
      await loadDetail(activeSessionId);
      onMaterializePlan(plan);
      return;
    }

    const result = await runAction('materialize', () =>
      callTool<FoundryMaterializeResult>({
        actor,
        method: 'foundry_project_materialize',
        idempotencyKey: makeId('foundry-materialize'),
        args: { sessionId: activeSessionId },
      })
    );
    if (!result) return;
    setMaterialized(result);
    setExported({ files: result.files });
    await loadSessions();
    await loadDetail(activeSessionId);
    onMaterialized?.(result.teamId);
  }

  return (
    <main className="foundry-screen">
      <aside className="foundry-sidebar">
        <div className="foundry-panel-head">
          <div>
            <div className="eyebrow">Foundry</div>
            <h2>Project plans</h2>
          </div>
          <button className="icon-btn" type="button" title="Refresh" onClick={() => void loadSessions()}>
            <Icon name="play" size={14} />
          </button>
        </div>
        <div className="foundry-create">
          <input
            className="input"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Project name"
          />
          <button className="btn btn-primary" type="button" disabled={busy === 'create'} onClick={() => void createSession()}>
            <Icon name="plus" size={14} /> New
          </button>
        </div>
        <div className="foundry-session-list">
          {sessions.length === 0 && (
            <div className="empty-mini">
              <Icon name="sparkle" size={18} />
              <span>No plans yet</span>
            </div>
          )}
          {sessions.map((session) => (
            <button
              key={session.sessionId}
              type="button"
              className={`foundry-session ${session.sessionId === activeSessionId ? 'active' : ''}`}
              onClick={() => {
                setActiveSessionId(session.sessionId);
                setExported(null);
                setMaterialized(null);
              }}
            >
              <span className="foundry-session-title">{session.title}</span>
              <span className="dim">{session.messageCount} notes · {session.artifactCount} files</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="foundry-chat">
        <div className="foundry-panel-head">
          <div>
            <div className="eyebrow">Discovery</div>
            <h2>{detail?.session.title ?? 'No active plan'}</h2>
          </div>
          <button
            className="btn"
            type="button"
            disabled={!activeSessionId || busy === 'generate'}
            onClick={() => void generateArtifacts()}
          >
            <Icon name="sparkle" size={14} /> Generate docs
          </button>
        </div>
        {error && <div className="banner banner-warn foundry-error">{error}</div>}
        <div className="foundry-thread">
          {firstRun && (!detail || detail.messages.length === 0) && (
            <div className="foundry-welcome">
              <h3>Welcome to Symphony.</h3>
              <p>
                Tell me what you want to build, and a team of AI agents will plan,
                code, and ship it. Start with one sentence — &ldquo;a meal planner for
                picky eaters,&rdquo; &ldquo;a habit tracker for my partner,&rdquo;
                whatever. I&rsquo;ll ask follow-ups.
              </p>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onFirstRunDismiss?.()}
              >
                Dismiss
              </button>
            </div>
          )}
          {!firstRun && !detail && (
            <div className="foundry-empty">
              <Icon name="sparkle" size={22} />
              <h3>Select or create a plan</h3>
            </div>
          )}
          {detail?.messages.map((item) => (
            <div key={item.messageId} className={`foundry-message ${item.role}`}>
              <div className="foundry-message-meta">{item.role}</div>
              <FoundryMessageBody text={item.text} />
            </div>
          ))}
        </div>
        <div className="foundry-compose">
          <textarea
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            placeholder="Describe goals, users, workflows, entities, constraints, integrations..."
            disabled={!activeSessionId}
          />
          <button className="btn btn-primary" type="button" disabled={!activeSessionId || !message.trim() || busy === 'message'} onClick={() => void sendChatTurn()}>
            <Icon name="send" size={14} /> Send
          </button>
        </div>
      </section>

      <aside className="foundry-artifacts">
        <div className="foundry-panel-head">
          <div>
            <div className="eyebrow">Artifacts</div>
            <h2>{detail?.artifacts.length ?? 0} files</h2>
          </div>
          <button
            className="btn"
            type="button"
            disabled={!selectedArtifact || busy === 'export'}
            onClick={() => void exportArtifacts()}
          >
            <Icon name="folder" size={14} /> Export
          </button>
          <button
            className="btn btn-primary"
            type="button"
            disabled={!activeSessionId || busy === 'materialize'}
            onClick={() => void materializeProject()}
          >
            <Icon name="plus" size={14} /> Create team
          </button>
        </div>
        <div className="foundry-artifact-tabs">
          {detail?.artifacts.map((artifact) => (
            <button
              key={artifact.artifactId}
              type="button"
              className={artifact.artifactId === selectedArtifactId ? 'active' : ''}
              onClick={() => {
                setSelectedArtifactId(artifact.artifactId);
                setArtifactDraft(artifact.content);
              }}
            >
              <span>{artifact.title}</span>
              <span className="mono">{artifact.targetPath}</span>
            </button>
          ))}
        </div>
        {selectedArtifact ? (
          <div className="foundry-editor">
            <div className="foundry-editor-bar">
              <span className="chip">{selectedArtifact.status}</span>
              <span className="dim">v{selectedArtifact.version}</span>
              <button className="btn btn-sm" type="button" disabled={busy === 'save'} onClick={() => void saveArtifact()}>
                <Icon name="check" size={13} /> Save
              </button>
            </div>
            <textarea value={artifactDraft} onChange={(event) => setArtifactDraft(event.target.value)} />
          </div>
        ) : (
          <div className="foundry-empty">
            <Icon name="file" size={22} />
            <h3>No artifacts yet</h3>
          </div>
        )}
        {exported && (
          <div className="foundry-exported">
            {exported.files.map((file) => (
              <div key={file.artifactId} className="mono">{file.targetPath}</div>
            ))}
          </div>
        )}
        {materialized && (
          <div className="foundry-exported">
            <strong>Created {materialized.teamId}</strong>
            <div>{(materialized.tasks ?? []).length} tasks created</div>
          </div>
        )}
      </aside>
    </main>
  );
}

function formatError(err: unknown): string {
  if (err instanceof ToadApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

interface FoundryMessageBodyProps {
  text: string;
}

type MessageBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'code'; text: string };

function FoundryMessageBody({ text }: FoundryMessageBodyProps) {
  const blocks = useMemo(() => parseMessageBlocks(text), [text]);
  return (
    <div className="foundry-message-body">
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          return <h4 key={index}>{block.text}</h4>;
        }
        if (block.kind === 'code') {
          return <pre key={index}><code>{block.text}</code></pre>;
        }
        if (block.kind === 'list') {
          const Tag = block.ordered ? 'ol' : 'ul';
          return (
            <Tag key={index}>
              {block.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}
            </Tag>
          );
        }
        return <p key={index}>{block.text}</p>;
      })}
    </div>
  );
}

function parseMessageBlocks(text: string): MessageBlock[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: MessageBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let code: string[] | null = null;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ').trim() });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push({ kind: 'list', ordered: list.ordered, items: list.items });
    list = null;
  };
  const flushCode = () => {
    if (!code) return;
    blocks.push({ kind: 'code', text: code.join('\n').trimEnd() });
    code = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      flushParagraph();
      flushList();
      if (code) {
        flushCode();
      } else {
        code = [];
      }
      continue;
    }

    if (code) {
      code.push(line);
      continue;
    }

    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = parseHeading(trimmed);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ kind: 'heading', text: heading });
      continue;
    }

    const orderedMatch = /^(\d+)[.)]\s+(.+)$/.exec(trimmed);
    const bulletMatch = /^[-*]\s+(.+)$/.exec(trimmed);
    if (orderedMatch || bulletMatch) {
      flushParagraph();
      const ordered = !!orderedMatch;
      const item = (orderedMatch?.[2] ?? bulletMatch?.[1] ?? '').trim();
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push(item);
      continue;
    }

    flushList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  flushList();
  flushCode();
  return blocks.length > 0 ? blocks : [{ kind: 'paragraph', text }];
}

function parseHeading(line: string): string | null {
  const markdown = /^#{1,4}\s+(.+)$/.exec(line);
  if (markdown) return markdown[1].trim();

  const normalized = line.replace(/:$/, '').trim();
  const knownHeadings = new Set([
    'Summary',
    'Open Questions',
    'Decisions So Far',
    'Next Step',
    'Product Brief',
    'Roadmap',
    'Data Model',
    'Technical Spec',
    'Implementation Tasks',
  ]);
  return knownHeadings.has(normalized) ? normalized : null;
}
