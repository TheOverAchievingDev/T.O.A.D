import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';

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

  const [mode, setMode] = useState<'idle' | 'device' | 'pat'>('idle');
  const [device, setDevice] = useState<DeviceStartResult | null>(null);
  const [pollState, setPollState] = useState<'idle' | 'polling' | 'pending' | 'denied' | 'expired'>('idle');
  const [pat, setPat] = useState('');
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
        <SettingsCard
          title="Connect a GitHub account"
          description="Pick a flow. Device Flow opens GitHub in a browser tab and asks you to enter a short user code — no client secret distribution required. PAT lets you paste a Personal Access Token directly (good for fully-offline setups)."
        >
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={startDevice}
              disabled={submitting || !status?.clientIdConfigured}
              title={!status?.clientIdConfigured ? 'Set TOAD_GITHUB_CLIENT_ID env var or settings.github.clientId first' : undefined}
            >
              <Icon name="github" size={12} /> Sign in with GitHub
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setMode('pat')}
              disabled={submitting}
            >
              Use a Personal Access Token instead
            </button>
          </div>
          {!status?.clientIdConfigured && (
            <div className="field-hint" style={{ marginTop: 8 }}>
              <Icon name="info" size={11} /> Device Flow needs an OAuth client_id. Register a TOAD GitHub App and either set <span className="mono">TOAD_GITHUB_CLIENT_ID</span> or save it under <span className="mono">settings.github.clientId</span>. PAT works without a client_id.
            </div>
          )}
        </SettingsCard>
      )}

      {!loading && mode === 'device' && device && (
        <SettingsCard
          title="Sign in with GitHub"
          description="Open GitHub in your browser and enter the user code below. We'll keep checking until you authorize."
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
              padding: '14px 16px',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid var(--border-soft, rgba(255,255,255,0.08))',
              borderRadius: 8,
              marginBottom: 12,
            }}
          >
            <div>
              <div className="section-label" style={{ fontSize: 10 }}>User code</div>
              <div className="mono" style={{ fontSize: 22, letterSpacing: '0.12em', fontWeight: 600 }}>
                {device.userCode}
              </div>
            </div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => navigator.clipboard?.writeText(device.userCode)}
            >
              Copy
            </button>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
            <a
              className="btn btn-primary btn-sm"
              href={device.verificationUriComplete || device.verificationUri}
              target="_blank"
              rel="noreferrer noopener"
            >
              <Icon name="github" size={11} /> Open GitHub
            </a>
            <button type="button" className="btn btn-sm btn-ghost" onClick={cancelDevice}>
              Cancel
            </button>
            <span className="dim" style={{ fontSize: 11.5, marginLeft: 'auto' }}>
              {pollState === 'polling' && 'Waiting for you to authorize…'}
              {pollState === 'pending' && 'Still waiting…'}
              {pollState === 'denied' && 'Access denied. Try again or use a PAT.'}
              {pollState === 'expired' && 'Code expired. Restart the flow.'}
            </span>
          </div>
        </SettingsCard>
      )}

      {!loading && mode === 'pat' && (
        <SettingsCard
          title="Personal Access Token"
          description="Paste a fine-grained or classic PAT with at least the repo + read:user scopes. We verify it by calling /user before saving."
        >
          <div className="field">
            <label>Token</label>
            <input
              type="password"
              className="field-input mono"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              placeholder="ghp_…"
              autoFocus
            />
            <div className="field-hint">
              The token is stored in <span className="mono">{'<settings.json>'}</span> on this machine. Disconnect anytime to clear it.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={() => { setMode('idle'); setPat(''); }}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submitPat}
              disabled={submitting || !pat.trim()}
            >
              {submitting ? 'Verifying…' : 'Verify & save'}
            </button>
          </div>
        </SettingsCard>
      )}
    </div>
  );
}
