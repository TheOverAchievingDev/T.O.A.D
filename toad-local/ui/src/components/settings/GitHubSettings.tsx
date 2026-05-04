import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';
import { openUrlInBrowser } from '@/integrations/tauri';

interface GithubUser {
  login: string;
  id: number;
  name: string | null;
  avatarUrl: string | null;
  htmlUrl: string | null;
}

interface GithubStatus {
  status: 'connected' | 'disconnected' | 'no-settings-store';
  source?: 'device' | 'pat' | 'unknown';
  user?: GithubUser | null;
  scopes?: string[];
  connectedAt?: string | null;
  clientIdConfigured?: boolean;
  clientIdSource?: 'env' | 'settings' | 'built-in' | null;
}

interface DeviceStartResult {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}

const DEFAULT_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };

export function GitHubSettings() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [mode, setMode] = useState<'idle' | 'device'>('idle');
  const [device, setDevice] = useState<DeviceStartResult | null>(null);
  const [pollState, setPollState] = useState<'idle' | 'polling' | 'pending' | 'denied' | 'expired'>('idle');
  const [pat, setPat] = useState('');
  const [clientIdDraft, setClientIdDraft] = useState('');
  const [savingClientId, setSavingClientId] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const expiresAtRef = useRef<number | null>(null);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const result = await callTool<GithubStatus>({
        actor: DEFAULT_ACTOR,
        method: 'github_status',
        args: {},
      });
      setStatus(result);
    } catch (err) {
      setError(err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Failed to load GitHub status'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStatus();
    return () => {
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, []);

  async function startDevice() {
    setError(null);
    setMode('device');
    setSubmitting(true);
    try {
      const result = await callTool<DeviceStartResult>({
        actor: DEFAULT_ACTOR,
        method: 'github_device_start',
        args: {},
      });
      setDevice(result);
      expiresAtRef.current = Date.now() + result.expiresIn * 1000;
      setPollState('polling');
      schedulePoll(result.deviceCode, result.interval * 1000);
      // Auto-open the browser straight to GitHub's authorize page with the
      // user code pre-filled. The user just clicks "Authorize" — no manual
      // code typing. This is as close to the VS Code one-click experience
      // as Device Flow allows.
      const target = result.verificationUriComplete || result.verificationUri;
      if (target) {
        try { await openUrlInBrowser(target); } catch { /* ignore — user can click the fallback link */ }
      }
    } catch (err) {
      const message = err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Failed to start device flow');
      setError(message);
      setMode('idle');
    } finally {
      setSubmitting(false);
    }
  }

  function schedulePoll(deviceCode: string, intervalMs: number) {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(() => void doPoll(deviceCode), intervalMs);
  }

  async function doPoll(deviceCode: string) {
    if (expiresAtRef.current && Date.now() > expiresAtRef.current) {
      setPollState('expired');
      return;
    }
    try {
      const result = await callTool<{
        status: 'granted' | 'pending';
        user?: GithubUser;
        reason?: string;
        interval?: number;
      }>({
        actor: DEFAULT_ACTOR,
        method: 'github_device_poll',
        args: { deviceCode },
        idempotencyKey: `gh-poll-${deviceCode}-${Date.now()}`,
      });
      if (result.status === 'granted') {
        setPollState('idle');
        setDevice(null);
        setMode('idle');
        await loadStatus();
        return;
      }
      if (result.reason === 'access_denied') {
        setPollState('denied');
        return;
      }
      if (result.reason === 'expired_token') {
        setPollState('expired');
        return;
      }
      // pending or slow_down — keep polling, honor any new interval hint
      const intervalMs = (result.interval ?? device?.interval ?? 5) * 1000;
      schedulePoll(deviceCode, intervalMs);
    } catch (err) {
      const message = err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Polling failed');
      setError(message);
      setPollState('idle');
    }
  }

  async function submitPat() {
    if (!pat.trim()) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await callTool<{ status: 'verified' | 'rejected'; httpStatus?: number }>({
        actor: DEFAULT_ACTOR,
        method: 'github_pat_verify',
        args: { token: pat.trim() },
        idempotencyKey: `gh-pat-${Date.now()}`,
      });
      if (result.status === 'rejected') {
        setError(`GitHub rejected the token (HTTP ${result.httpStatus ?? '?'}). Make sure it has at least the repo + read:user scopes.`);
      } else {
        setPat('');
        setMode('idle');
        await loadStatus();
      }
    } catch (err) {
      setError(err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Failed to verify token'));
    } finally {
      setSubmitting(false);
    }
  }

  async function disconnect() {
    if (!confirm('Disconnect GitHub? Stored creds will be removed but the OAuth client_id is kept.')) return;
    setSubmitting(true);
    setError(null);
    try {
      await callTool({
        actor: DEFAULT_ACTOR,
        method: 'github_disconnect',
        args: {},
        idempotencyKey: `gh-disc-${Date.now()}`,
      });
      await loadStatus();
    } catch (err) {
      setError(err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Failed to disconnect'));
    } finally {
      setSubmitting(false);
    }
  }

  function cancelDevice() {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    setDevice(null);
    setPollState('idle');
    setMode('idle');
  }

  /** Save a pasted OAuth client_id to global settings (merges with the
   *  existing `github` section so we don't wipe out a stored token). */
  async function saveClientId() {
    const value = clientIdDraft.trim();
    if (!value) return;
    setSavingClientId(true);
    setError(null);
    try {
      // Read-modify-write: settings_set replaces the whole section.
      const existing = await callTool<{ value: Record<string, unknown> }>({
        actor: DEFAULT_ACTOR,
        method: 'settings_get',
        args: { scope: 'global', section: 'github' },
      });
      const merged = { ...(existing?.value || {}), clientId: value };
      await callTool({
        actor: DEFAULT_ACTOR,
        method: 'settings_set',
        args: { scope: 'global', section: 'github', value: merged },
        idempotencyKey: `gh-cid-${Date.now()}`,
      });
      setClientIdDraft('');
      await loadStatus();
    } catch (err) {
      setError(err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Failed to save client_id'));
    } finally {
      setSavingClientId(false);
    }
  }

  return (
    <div>
      <SettingsSectionHeader
        title="GitHub"
        description="Connect a GitHub account so TOAD can read branches, manage worktrees, and create PRs against a real remote."
      />

      {error && (
        <div
          style={{
            marginBottom: 16,
            padding: '8px 12px',
            background: 'oklch(0.30 0.08 25 / 0.4)',
            border: '1px solid oklch(0.55 0.18 25 / 0.4)',
            borderRadius: 6,
            color: 'oklch(0.85 0.10 25)',
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {loading && <div className="dim" style={{ fontSize: 12 }}>Loading…</div>}

      {!loading && status?.status === 'connected' && (
        <SettingsCard
          title="Connected"
          description={`Authorized via ${status.source === 'device' ? 'OAuth Device Flow' : 'Personal Access Token'}.`}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {status.user?.avatarUrl && (
              <img
                src={status.user.avatarUrl}
                alt=""
                width={48}
                height={48}
                style={{ borderRadius: '50%', border: '1px solid var(--border-soft, rgba(255,255,255,0.1))' }}
              />
            )}
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                {status.user?.name || status.user?.login}
              </div>
              <div className="mono dim" style={{ fontSize: 12 }}>
                @{status.user?.login}
              </div>
              {status.connectedAt && (
                <div className="dim" style={{ fontSize: 11, marginTop: 4 }}>
                  Connected {new Date(status.connectedAt).toLocaleString()}
                </div>
              )}
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={disconnect}
              disabled={submitting}
            >
              Disconnect
            </button>
          </div>

          {status.scopes && status.scopes.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div className="section-label" style={{ fontSize: 10, marginBottom: 6 }}>
                Scopes
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {status.scopes.map((s) => (
                  <span key={s} className="chip mono" style={{ fontSize: 11 }}>{s}</span>
                ))}
              </div>
            </div>
          )}
        </SettingsCard>
      )}

      {!loading && status?.status !== 'connected' && mode === 'idle' && (
        <>
          <SettingsCard
            title="Connect with a Personal Access Token"
            description="Easiest path: paste a fine-grained token from GitHub. No app registration, no env vars."
          >
            <div className="field" style={{ margin: 0 }}>
              <label>Token</label>
              <input
                type="password"
                className="field-input mono"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder="github_pat_… or ghp_…"
                style={{ fontSize: 12 }}
                disabled={submitting}
              />
              <div className="field-hint" style={{ marginTop: 6 }}>
                <Icon name="info" size={11} /> Create one at{' '}
                <a
                  href="https://github.com/settings/tokens?type=beta"
                  target="_blank"
                  rel="noreferrer"
                  style={{ color: 'var(--accent)' }}
                >
                  github.com/settings/tokens
                </a>
                {' '}with <span className="mono">repo</span> + <span className="mono">read:user</span> scopes. The token stays
                on this machine in <span className="mono">settings.json</span>.
              </div>
            </div>
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                className="btn btn-primary"
                onClick={submitPat}
                disabled={submitting || !pat.trim()}
              >
                <Icon name="github" size={12} /> {submitting ? 'Verifying…' : 'Connect GitHub'}
              </button>
            </div>
          </SettingsCard>

          <SettingsCard
            title="Or sign in with GitHub OAuth"
            description={
              status?.clientIdSource === 'built-in'
                ? 'One-click sign-in via this build\'s registered TOAD OAuth App. Browser opens, you click Authorize, you\'re in.'
                : 'Opens GitHub in your browser with the auth code pre-filled. Requires a one-time OAuth App registration (~60 seconds on github.com — no secret needed).'
            }
          >
            {!status?.clientIdConfigured && (
              <div className="field" style={{ margin: 0 }}>
                <label>OAuth client_id</label>
                <input
                  type="text"
                  className="field-input mono"
                  value={clientIdDraft}
                  onChange={(e) => setClientIdDraft(e.target.value)}
                  placeholder="Iv1.1234567890abcdef"
                  style={{ fontSize: 12 }}
                  disabled={savingClientId}
                />
                <div className="field-hint" style={{ marginTop: 6 }}>
                  <Icon name="info" size={11} /> Register a new app at{' '}
                  <a
                    href="https://github.com/settings/applications/new"
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'var(--accent)' }}
                  >
                    github.com/settings/applications/new
                  </a>
                  : Application name "TOAD", Homepage URL <span className="mono">http://localhost</span>, leave callback URL
                  blank. Tick "Enable Device Flow" then save the Client ID here.
                </div>
                <div style={{ marginTop: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={saveClientId}
                    disabled={savingClientId || !clientIdDraft.trim()}
                  >
                    {savingClientId ? 'Saving…' : 'Save client_id'}
                  </button>
                </div>
              </div>
            )}
            {status?.clientIdConfigured && (
              <button
                type="button"
                className="btn btn-primary"
                onClick={startDevice}
                disabled={submitting}
              >
                <Icon name="github" size={12} /> Sign in with GitHub
              </button>
            )}
          </SettingsCard>
        </>
      )}

      {!loading && mode === 'device' && device && (
        <SettingsCard
          title="Authorizing in your browser…"
          description="GitHub should have opened in your default browser with the code pre-filled. Click Authorize there — TOAD will pick it up automatically."
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 14px',
              background: 'oklch(0.30 0.08 240 / 0.20)',
              border: '1px solid oklch(0.55 0.15 240 / 0.30)',
              borderRadius: 8,
              marginBottom: 12,
            }}
          >
            <div
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background:
                  pollState === 'denied' || pollState === 'expired'
                    ? 'oklch(0.65 0.20 25)'
                    : 'oklch(0.72 0.15 145)',
                flexShrink: 0,
              }}
            />
            <div style={{ flex: 1, fontSize: 12.5 }}>
              {pollState === 'polling' && 'Waiting for you to authorize on GitHub…'}
              {pollState === 'pending' && 'Still waiting on GitHub…'}
              {pollState === 'denied' && 'Authorization denied. You can try again or use a PAT instead.'}
              {pollState === 'expired' && 'Code expired before you authorized. Restart the flow.'}
            </div>
          </div>

          <div className="field-hint" style={{ fontSize: 11, marginBottom: 10 }}>
            <Icon name="info" size={11} /> Browser didn't open? Click below — the code <span className="mono">{device.userCode}</span> is the same one in the URL.
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <a
              className="btn btn-sm"
              href={device.verificationUriComplete || device.verificationUri}
              target="_blank"
              rel="noreferrer noopener"
              onClick={(e) => {
                // Use Tauri's shell.open in desktop, browser fallback otherwise.
                e.preventDefault();
                void openUrlInBrowser(device.verificationUriComplete || device.verificationUri);
              }}
            >
              <Icon name="github" size={11} /> Open GitHub manually
            </a>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => navigator.clipboard?.writeText(device.userCode)}
              title="Copy the user code to clipboard"
            >
              Copy code
            </button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={cancelDevice} style={{ marginLeft: 'auto' }}>
              Cancel
            </button>
          </div>
        </SettingsCard>
      )}

    </div>
  );
}
