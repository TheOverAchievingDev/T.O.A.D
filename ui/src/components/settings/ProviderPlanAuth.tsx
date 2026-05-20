import { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import {
  getCachedStatus,
  loadStatus,
  subscribeStatus,
} from './providerAuthCache';

export type ProviderId = 'anthropic' | 'openai' | 'gemini' | 'opencode';

export interface AuthStatus {
  providerId: ProviderId;
  supported: boolean;
  /** True when the provider has no plan auth at all — only API keys. */
  apiOnly?: boolean;
  signedIn: boolean | null;
  user?: {
    email?: string | null;
    login?: string | null;
    name?: string | null;
  } | null;
  plan?: string | null;
  subscriptionType?: string | null;
  authMethod?: string | null;
  reason?: string;
}

/** Quick read of just whether plan auth is available for a provider — used
 *  by ProvidersSettings to hide the auth-mode toggle entry for API-only
 *  providers like OpenCode. Reads through the shared cache so we don't
 *  double-fetch when ProviderPlanAuth is also mounted. */
export async function readProviderAuthStatus(providerId: ProviderId): Promise<AuthStatus | null> {
  return loadStatus(providerId);
}

const DEFAULT_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };

interface ProviderPlanAuthProps {
  providerId: ProviderId;
  providerLabel: string;
}

export function ProviderPlanAuth({ providerId, providerLabel }: ProviderPlanAuthProps) {
  const cached = getCachedStatus(providerId);
  const [status, setStatus] = useState<AuthStatus | null>(cached);
  const [loading, setLoading] = useState(cached === null);
  const [busy, setBusy] = useState<'login' | 'logout' | null>(null);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualLoginHint, setManualLoginHint] = useState<{ cli: string; reason: string } | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollAttemptsRef = useRef(0);

  async function fetchStatus(opts: { silent?: boolean } = {}) {
    if (!opts.silent) setLoading(true);
    setError(null);
    try {
      const result = await loadStatus(providerId, { force: true });
      // loadStatus swallows errors and returns null — surface that as a
      // soft error so the user can hit Refresh again.
      if (result === null) {
        setError('Failed to read auth status');
      }
      return result;
    } catch (err) {
      const message = err instanceof ToadApiError ? err.message
        : err instanceof Error ? err.message
        : 'Failed to read auth status';
      setError(message);
      return null;
    } finally {
      if (!opts.silent) setLoading(false);
    }
  }

  useEffect(() => {
    const initial = getCachedStatus(providerId);
    if (initial !== null) {
      setStatus(initial);
      setLoading(false);
    } else {
      // Trigger a fetch (will dedupe with anything in flight).
      void loadStatus(providerId).finally(() => setLoading(false));
    }
    const unsubscribe = subscribeStatus(providerId, (next) => setStatus(next));
    return () => {
      unsubscribe();
      if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    };
  }, [providerId]);

  function startPolling() {
    pollAttemptsRef.current = 0;
    setPolling(true);
    schedulePoll();
  }

  function stopPolling() {
    setPolling(false);
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
  }

  function schedulePoll() {
    if (pollTimerRef.current) clearTimeout(pollTimerRef.current);
    pollTimerRef.current = setTimeout(async () => {
      pollAttemptsRef.current += 1;
      const next = await fetchStatus({ silent: true });
      if (next?.signedIn) {
        stopPolling();
        return;
      }
      // Cap at ~5 minutes (60 attempts × 5s) so we don't poll forever.
      if (pollAttemptsRef.current >= 60) {
        stopPolling();
        return;
      }
      schedulePoll();
    }, 5000);
  }

  async function login() {
    setBusy('login');
    setError(null);
    setManualLoginHint(null);
    try {
      const result = await callTool<{
        started: boolean;
        pid?: number;
        reason?: string;
        manualLogin?: boolean;
        cli?: string;
      }>({
        actor: DEFAULT_ACTOR,
        method: 'provider_auth_login',
        args: { providerId },
        idempotencyKey: `pa-login-${providerId}-${Date.now()}`,
      });
      if (result.manualLogin) {
        // Some providers (Claude Code, Codex) own their own login flow via
        // their CLI's interactive prompt. Surface the instructions instead
        // of treating it as an error.
        setManualLoginHint({
          cli: result.cli || providerId,
          reason: result.reason || 'Sign in via the CLI directly.',
        });
        return;
      }
      if (!result.started) {
        setError(result.reason ?? 'CLI did not start');
        return;
      }
      // Login spawned — start polling status.
      startPolling();
    } catch (err) {
      setError(err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Login failed to start'));
    } finally {
      setBusy(null);
    }
  }

  async function logout() {
    if (!confirm(`Sign out of ${providerLabel} on this machine?`)) return;
    setBusy('logout');
    setError(null);
    try {
      const result = await callTool<{ ok: boolean; reason?: string }>({
        actor: DEFAULT_ACTOR,
        method: 'provider_auth_logout',
        args: { providerId },
        idempotencyKey: `pa-logout-${providerId}-${Date.now()}`,
      });
      if (!result.ok) {
        setError(result.reason ?? 'Logout failed');
      } else {
        await fetchStatus();
      }
    } catch (err) {
      setError(err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Logout failed'));
    } finally {
      setBusy(null);
    }
  }

  // ---- Render ----------------------------------------------------------

  if (loading) {
    return (
      <div className="dim" style={{ fontSize: 11.5, padding: '6px 0' }}>
        Checking plan auth…
      </div>
    );
  }

  if (status && !status.supported) {
    return (
      <div
        style={{
          padding: '8px 10px',
          borderRadius: 6,
          background: 'rgba(255,255,255,0.02)',
          border: '1px dashed var(--border-soft, rgba(255,255,255,0.10))',
          fontSize: 11.5,
          color: 'var(--fg-muted)',
        }}
      >
        <Icon name="info" size={11} /> {status.apiOnly
          ? `${providerLabel} is API-only — no plan auth available. Use the API key tab.`
          : `Plan auth for ${providerLabel} not wired yet.${status.reason ? ` ${status.reason}` : ''}`}
      </div>
    );
  }

  const signedIn = status?.signedIn === true;
  const cliMissing = status?.signedIn === null && /not installed|not on PATH/i.test(status?.reason ?? '');

  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: 6,
        background: signedIn ? 'oklch(0.30 0.08 145 / 0.20)' : 'rgba(255,255,255,0.03)',
        border: `1px solid ${signedIn ? 'oklch(0.55 0.15 145 / 0.30)' : 'var(--border-soft, rgba(255,255,255,0.06))'}`,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            display: 'inline-block',
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: signedIn
              ? 'oklch(0.72 0.15 145)'
              : (cliMissing ? 'var(--fg-dim)' : 'oklch(0.78 0.14 80)'),
          }}
        />
        <span style={{ fontSize: 12, fontWeight: 600 }}>
          {signedIn ? 'Plan auth: signed in' : (cliMissing ? 'Plan auth: CLI not installed' : 'Plan auth: not signed in')}
        </span>
        {polling && (
          <span className="dim" style={{ fontSize: 10.5, marginLeft: 'auto' }}>
            Polling {pollAttemptsRef.current}/60…
          </span>
        )}
      </div>

      {signedIn && (
        <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>
          {status?.user?.email && <div>{status.user.email}</div>}
          {status?.plan && <div className="dim">{status.plan}</div>}
          {!status?.plan && status?.subscriptionType && (
            <div className="dim">subscription: {status.subscriptionType}</div>
          )}
          {status?.authMethod && (
            <div className="dim mono" style={{ fontSize: 10 }}>via {status.authMethod}</div>
          )}
        </div>
      )}

      {!signedIn && status?.reason && !cliMissing && (
        <div className="dim" style={{ fontSize: 11 }}>{status.reason}</div>
      )}

      {cliMissing && (
        <div className="dim" style={{ fontSize: 11 }}>
          Install the {providerLabel} CLI and ensure it's on your PATH, then click Refresh.
        </div>
      )}

      {manualLoginHint && (
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 6,
            background: 'oklch(0.30 0.08 240 / 0.20)',
            border: '1px solid oklch(0.55 0.15 240 / 0.30)',
            fontSize: 11.5,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontWeight: 600 }}>
            <Icon name="terminal" size={11} /> Sign in via the {manualLoginHint.cli} CLI
          </div>
          <div style={{ color: 'var(--fg-muted)' }}>{manualLoginHint.reason}</div>
          <div className="dim" style={{ fontSize: 10.5 }}>
            Once you're signed in there, click Refresh below.
          </div>
        </div>
      )}

      {error && (
        <div style={{ fontSize: 11, color: 'oklch(0.85 0.10 25)' }}>{error}</div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {!signedIn && !cliMissing && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={login}
            disabled={busy === 'login' || polling}
          >
            <Icon name="user" size={11} />
            {busy === 'login'
              ? 'Starting…'
              : polling
                ? 'Waiting for browser…'
                : manualLoginHint
                  ? `How to sign in to ${providerLabel}`
                  : `Sign in with ${providerLabel}`}
          </button>
        )}
        {signedIn && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={logout}
            disabled={busy === 'logout'}
          >
            {busy === 'logout' ? 'Signing out…' : 'Sign out'}
          </button>
        )}
        {polling && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={stopPolling}>
            Stop polling
          </button>
        )}
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => fetchStatus()}
          disabled={busy !== null}
        >
          <Icon name="play" size={10} /> Refresh
        </button>
      </div>
    </div>
  );
}
