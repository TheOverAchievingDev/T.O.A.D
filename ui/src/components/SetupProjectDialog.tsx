import { useEffect, useState } from 'react';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import { Icon } from './Icon';

export interface SetupProjectDialogProps {
  /** Display name of the just-picked folder (leaf path component). Used as
   *  the default GitHub repo name when the user opts in to creating one. */
  defaultRepoName?: string;
  /** Absolute path of the project folder. Shown as context. */
  projectPath?: string;
  onComplete: () => void;
  onCancel: () => void;
}

const ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };

interface GithubStatus {
  status: 'connected' | 'disconnected' | 'no-settings-store';
}

/**
 * Pop-in dialog that runs between "user picked a folder" and "user crafts
 * the team in CreateTeamModal". Asks two questions:
 *
 *   1. Initialize this folder as a git repo? (default yes — agent
 *      worktrees + the §19 merge gate need a git repo to function.)
 *   2. Optionally create a new GitHub repo and wire it as `origin`.
 *      Requires GitHub to be connected in Settings → Providers; otherwise
 *      the GitHub option is disabled with a hint to connect first.
 *
 * On submit, the dialog calls (in order):
 *   - `git_init_local` (always, unless the user unchecks)
 *   - `github_create_repository`
 *   - `git_set_remote name=origin url=<cloneUrl>`
 *
 * Best-effort: a failure on any step surfaces as an inline error; the
 * user can retry, skip, or cancel out of the dialog entirely.
 */
export function SetupProjectDialog({
  defaultRepoName = '',
  projectPath,
  onComplete,
  onCancel,
}: SetupProjectDialogProps) {
  const [initGit, setInitGit] = useState(true);
  const [createRepo, setCreateRepo] = useState(false);
  const [repoName, setRepoName] = useState(defaultRepoName);
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [repoDesc, setRepoDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [githubConnected, setGithubConnected] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    callTool<GithubStatus>({ actor: ACTOR, method: 'github_status', args: {} })
      .then((res) => { if (!cancelled) setGithubConnected(res.status === 'connected'); })
      .catch(() => { if (!cancelled) setGithubConnected(false); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape' && !busy) onCancel();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, busy]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (initGit) {
        const res = await callTool<{ ok: boolean; alreadyInitialized?: boolean; reason?: string }>({
          actor: ACTOR,
          method: 'git_init_local',
          args: {},
          idempotencyKey: `git-init-${Date.now()}`,
        });
        if (!res.ok) {
          setError(`git init failed: ${res.reason ?? 'unknown error'}`);
          return;
        }
      }
      if (createRepo) {
        const trimmed = repoName.trim();
        if (!trimmed) {
          setError('Repository name is required when "Create GitHub repo" is checked.');
          return;
        }
        const created = await callTool<
          | { ok: true; repo: { name: string; fullName: string; cloneUrl: string; htmlUrl: string } }
          | { ok: false; status: number; message?: string; errors?: Array<{ message?: string }> }
        >({
          actor: ACTOR,
          method: 'github_create_repository',
          args: { name: trimmed, description: repoDesc.trim() || undefined, private: repoPrivate, autoInit: false },
          idempotencyKey: `gh-create-repo-${Date.now()}`,
        });
        if (!created.ok) {
          if (created.status === 422) {
            const detail = created.errors?.[0]?.message || created.message || 'Validation failed';
            setError(`GitHub rejected the repo: ${detail}`);
          } else {
            setError(`GitHub create-repo failed (HTTP ${created.status})`);
          }
          return;
        }
        // Wire the new GitHub repo as `origin`. The user pushes manually
        // later (we don't auto-push because there are no commits yet).
        const remote = await callTool<{ ok: boolean; reason?: string }>({
          actor: ACTOR,
          method: 'git_set_remote',
          args: { name: 'origin', url: created.repo.cloneUrl },
          idempotencyKey: `git-set-remote-${Date.now()}`,
        });
        if (!remote.ok) {
          setError(`Repo created on GitHub, but setting origin failed: ${remote.reason ?? 'unknown'}`);
          return;
        }
      }
      onComplete();
    } catch (err) {
      const message = err instanceof ToadApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Setup failed';
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-head">
          <div>
            <h2>Set up the project</h2>
            <div className="sub">
              {projectPath ? (
                <>Folder: <span className="mono">{projectPath}</span></>
              ) : (
                'Pick what to wire up before crafting the team.'
              )}
            </div>
          </div>
          <button className="icon-btn" onClick={onCancel} type="button" disabled={busy}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: 10,
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
              borderRadius: 8,
              cursor: busy ? 'not-allowed' : 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={initGit}
              onChange={(e) => setInitGit(e.target.checked)}
              disabled={busy}
              style={{ marginTop: 2 }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Initialize as a git repo</div>
              <div className="dim" style={{ fontSize: 11.5, marginTop: 2 }}>
                Runs <span className="mono">git init</span> with <span className="mono">main</span> as the
                default branch. Required for agent worktrees and the merge gate. Idempotent — safe to run
                if it's already a repo.
              </div>
            </div>
          </label>

          <label
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              padding: 10,
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
              borderRadius: 8,
              cursor: githubConnected === false || busy ? 'not-allowed' : 'pointer',
              opacity: githubConnected === false ? 0.5 : 1,
            }}
          >
            <input
              type="checkbox"
              checked={createRepo}
              onChange={(e) => setCreateRepo(e.target.checked)}
              disabled={busy || githubConnected !== true}
              style={{ marginTop: 2 }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>Create a new GitHub repository</div>
              <div className="dim" style={{ fontSize: 11.5, marginTop: 2 }}>
                {githubConnected === null && 'Checking GitHub connection…'}
                {githubConnected === false && (
                  <>GitHub isn't connected — open <strong>Settings → GitHub</strong> first.</>
                )}
                {githubConnected === true && 'Creates the repo under your account and wires it as `origin`.'}
              </div>
            </div>
          </label>

          {createRepo && githubConnected && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingLeft: 28 }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Repo name</label>
                <input
                  className="field-input mono"
                  value={repoName}
                  onChange={(e) => setRepoName(e.target.value)}
                  placeholder="my-project"
                  disabled={busy}
                  autoFocus
                />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Description (optional)</label>
                <input
                  className="field-input"
                  value={repoDesc}
                  onChange={(e) => setRepoDesc(e.target.value)}
                  placeholder="Short description for the repo"
                  disabled={busy}
                />
              </div>
              <div className="seg" style={{ alignSelf: 'flex-start' }}>
                <button
                  type="button"
                  className={repoPrivate ? 'active' : ''}
                  onClick={() => setRepoPrivate(true)}
                  disabled={busy}
                >
                  Private
                </button>
                <button
                  type="button"
                  className={!repoPrivate ? 'active' : ''}
                  onClick={() => setRepoPrivate(false)}
                  disabled={busy}
                >
                  Public
                </button>
              </div>
            </div>
          )}

          {error && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                background: 'oklch(0.32 0.08 25 / 0.20)',
                border: '1px solid oklch(0.55 0.15 25 / 0.30)',
                fontSize: 11.5,
                color: 'oklch(0.85 0.10 25)',
              }}
            >
              {error}
            </div>
          )}
        </div>

        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
            display: 'flex',
            gap: 8,
            justifyContent: 'flex-end',
          }}
        >
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy} type="button">
            Skip
          </button>
          <button
            className="btn btn-primary"
            onClick={submit}
            disabled={busy || (!initGit && !createRepo)}
            type="button"
          >
            <Icon name="check" size={11} /> {busy ? 'Setting up…' : 'Continue'}
          </button>
        </div>
      </div>
    </div>
  );
}
