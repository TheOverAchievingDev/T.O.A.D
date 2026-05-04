import { useEffect, useState } from 'react';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import { Icon } from './Icon';

interface OriginRemoteResult {
  ok: boolean;
  owner?: string;
  repo?: string;
  reason?: string;
}

interface CreatePullRequestSuccess {
  ok: true;
  pr: {
    number: number;
    htmlUrl: string;
    state: string;
    title: string;
  };
}

interface CreatePullRequestFailure {
  ok: false;
  status: number;
  message?: string;
  errors?: Array<{ message?: string | null; field?: string | null }>;
}

type CreatePullRequestResult = CreatePullRequestSuccess | CreatePullRequestFailure;

interface OpenPullRequestButtonProps {
  taskId: string;
  taskTitle: string;
  headBranch: string | null;
  baseBranch: string | null;
  actor: Actor;
}

/**
 * §3c affordance: open a GitHub PR from the task's worktree branch into its
 * base branch, using the stored access token. Self-disables when the
 * project's origin remote isn't on github.com or when GitHub isn't connected
 * — the button stays out of the way for non-github projects.
 */
export function OpenPullRequestButton({
  taskId,
  taskTitle,
  headBranch,
  baseBranch,
  actor,
}: OpenPullRequestButtonProps) {
  const [origin, setOrigin] = useState<OriginRemoteResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<CreatePullRequestResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    callTool<OriginRemoteResult>({
      actor,
      method: 'github_origin_remote',
      args: {},
    })
      .then((res) => { if (!cancelled) setOrigin(res); })
      .catch(() => { if (!cancelled) setOrigin({ ok: false, reason: 'lookup_failed' }); });
    return () => { cancelled = true; };
  }, [actor]);

  const canOpen = !!(origin?.ok && headBranch && baseBranch);

  async function openPullRequest() {
    if (!canOpen || !origin?.ok || !origin.owner || !origin.repo || !headBranch || !baseBranch) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const pr = await callTool<CreatePullRequestResult>({
        actor,
        method: 'github_create_pull_request',
        args: {
          owner: origin.owner,
          repo: origin.repo,
          head: headBranch,
          base: baseBranch,
          title: taskTitle,
        },
        idempotencyKey: `open-pr-${taskId}-${Date.now()}`,
      });
      setResult(pr);
    } catch (err) {
      const message = err instanceof ToadApiError ? err.message
        : err instanceof Error ? err.message
        : 'Failed to open pull request';
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  // ---- render -------------------------------------------------------------

  if (origin === null) {
    return (
      <div className="dim" style={{ fontSize: 11, padding: '4px 0' }}>
        Checking GitHub remote…
      </div>
    );
  }

  if (!origin.ok) {
    const reason = origin.reason || 'unknown';
    const friendly =
      reason === 'no_origin_remote' ? 'No git remote named "origin" — push the repo first.'
      : reason === 'origin_not_github' ? 'Origin remote is not a github.com URL.'
      : reason === 'no_project_cwd' ? 'No project working directory configured.'
      : 'GitHub origin lookup failed.';
    return (
      <div
        style={{
          padding: '8px 10px',
          borderRadius: 6,
          background: 'rgba(255,255,255,0.02)',
          border: '1px dashed var(--border-soft, rgba(255,255,255,0.10))',
          fontSize: 11,
          color: 'var(--fg-muted)',
        }}
      >
        <Icon name="info" size={11} /> {friendly}
      </div>
    );
  }

  if (!headBranch || !baseBranch) {
    return (
      <div className="dim" style={{ fontSize: 11, padding: '4px 0' }}>
        {!headBranch
          ? 'No worktree branch on this task — assign a worktree first.'
          : 'No base branch configured on this task.'}
      </div>
    );
  }

  if (result && result.ok === true) {
    return (
      <div
        style={{
          padding: '8px 10px',
          borderRadius: 6,
          background: 'oklch(0.30 0.08 145 / 0.20)',
          border: '1px solid oklch(0.55 0.15 145 / 0.30)',
          fontSize: 11.5,
        }}
      >
        <div style={{ fontWeight: 600, marginBottom: 4 }}>
          <Icon name="check" size={11} /> Pull request opened
        </div>
        <a
          href={result.pr.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="mono"
          style={{ fontSize: 11, color: 'var(--accent)' }}
        >
          #{result.pr.number} — {result.pr.htmlUrl}
        </a>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <button
        type="button"
        className="btn btn-sm btn-primary"
        disabled={busy}
        onClick={openPullRequest}
      >
        <Icon name="github" size={11} />
        {busy ? 'Opening pull request…' : `Open pull request (${origin.owner}/${origin.repo})`}
      </button>
      <div className="dim mono" style={{ fontSize: 10.5 }}>
        {headBranch} → {baseBranch}
      </div>
      {result && result.ok === false && (
        <div
          style={{
            padding: '6px 8px',
            borderRadius: 6,
            background: 'oklch(0.32 0.08 25 / 0.20)',
            border: '1px solid oklch(0.55 0.15 25 / 0.30)',
            fontSize: 11,
            color: 'oklch(0.85 0.10 25)',
          }}
        >
          <div style={{ fontWeight: 600 }}>GitHub rejected (HTTP {result.status})</div>
          <div>{result.message || 'Validation failed'}</div>
          {Array.isArray(result.errors) && result.errors.length > 0 && (
            <ul style={{ margin: '4px 0 0 14px', padding: 0 }}>
              {result.errors.map((e, i) => (
                <li key={i}>{e.message || JSON.stringify(e)}</li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <div style={{ fontSize: 11, color: 'oklch(0.85 0.10 25)' }}>{error}</div>
      )}
    </div>
  );
}
