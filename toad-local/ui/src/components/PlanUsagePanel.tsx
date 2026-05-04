import { useEffect, useState } from 'react';
import { callTool as callToadApi } from '@/api/client';
import { Icon } from './Icon';

/**
 * Plan-usage breakdown for every supported subscription provider.
 *
 * Renders one row per provider with:
 *   - Provider glyph + label
 *   - Signed-in / signed-out badge with plan tier
 *   - Quota bars (session / weekly) when the provider has a usable
 *     quota probe (anthropic only today)
 *   - "no quota probe available" hint for providers without one
 *
 * Used in two places:
 *   1. Settings → Providers panel (full operator dashboard)
 *   2. Team creation modal (so the operator can see headroom before
 *      assigning roles to a particular provider)
 *
 * Polls usage_summary on mount + every 30s. The backend caches the
 * claude pty probe for 90s so this poll is cheap.
 */

interface QuotaWindow {
  pctUsed: number;
  resetIn: string | null;
  label: string;
}

interface ProviderUsage {
  providerId: string;
  label: string;
  signedIn: boolean;
  plan: string | null;
  reason: string | null;
  quota: {
    session?: QuotaWindow;
    weekly?: QuotaWindow;
    opusWeekly?: QuotaWindow;
  } | null;
}

interface UsageSummary {
  providers: ProviderUsage[];
}

interface PlanUsagePanelProps {
  /** "compact" trims the row height and hides the spend totals — used in
   *  the team-creation modal where vertical space is tight. "full" is
   *  the dashboard layout shown in Settings. */
  variant?: 'compact' | 'full';
}

const PROVIDER_GLYPH_CLASS: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'gemini',
};

function pctColor(pct: number) {
  if (pct >= 85) return 'var(--err, #f87171)';
  if (pct >= 60) return 'var(--warn, #ffcd66)';
  return 'var(--ok, #4ade80)';
}

function QuotaBar({ window }: { window: QuotaWindow }) {
  const pct = Math.min(100, Math.max(0, window.pctUsed));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 11 }}>
        <span style={{ color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {window.label}
        </span>
        <span style={{ color: pctColor(pct), fontWeight: 600 }}>{pct}%</span>
      </div>
      <div
        style={{
          height: 6,
          background: 'rgba(255,255,255,0.06)',
          borderRadius: 3,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            background: pctColor(pct),
            transition: 'width 250ms ease-out',
          }}
        />
      </div>
      {window.resetIn ? (
        <span style={{ fontSize: 10, color: 'var(--fg-dim)' }}>resets {window.resetIn}</span>
      ) : null}
    </div>
  );
}

function ProviderRow({ provider, variant }: { provider: ProviderUsage; variant: 'compact' | 'full' }) {
  const glyph = PROVIDER_GLYPH_CLASS[provider.providerId] ?? '';
  const quotas: QuotaWindow[] = [];
  if (provider.quota?.session) quotas.push(provider.quota.session);
  if (provider.quota?.weekly) quotas.push(provider.quota.weekly);
  if (provider.quota?.opusWeekly) quotas.push(provider.quota.opusWeekly);

  return (
    <div
      style={{
        padding: variant === 'compact' ? '8px 10px' : '12px 14px',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: variant === 'compact' ? 8 : 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span className={`provider-glyph ${glyph}`} style={{ width: 22, height: 22, borderRadius: 5 }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>{provider.label}</span>
        <span
          style={{
            fontSize: 10,
            padding: '2px 6px',
            borderRadius: 3,
            background: provider.signedIn ? 'rgba(74,222,128,0.12)' : 'rgba(255,255,255,0.04)',
            color: provider.signedIn ? 'var(--ok, #4ade80)' : 'var(--fg-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            fontWeight: 600,
          }}
        >
          {provider.signedIn ? 'Signed in' : 'Not signed in'}
        </span>
        {provider.plan ? (
          <span style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'capitalize' }}>
            {provider.plan}
          </span>
        ) : null}
      </div>

      {quotas.length > 0 ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: variant === 'compact' && quotas.length > 1 ? '1fr 1fr' : '1fr',
            gap: variant === 'compact' ? 8 : 12,
          }}
        >
          {quotas.map((q) => (
            <QuotaBar key={q.label} window={q} />
          ))}
        </div>
      ) : provider.signedIn ? (
        <div style={{ fontSize: 11, color: 'var(--fg-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="info" size={11} />
          {provider.providerId === 'anthropic'
            ? 'Quota probe pending — claude /usage will scrape on next poll.'
            : 'No quota probe available for this provider yet.'}
        </div>
      ) : (
        <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
          {provider.reason || 'Sign in via the provider settings to see quota.'}
        </div>
      )}
    </div>
  );
}

export function PlanUsagePanel({ variant = 'full' }: PlanUsagePanelProps) {
  const [providers, setProviders] = useState<ProviderUsage[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function fetchUsage() {
      try {
        const res = await callToadApi({
          actor: { teamId: 'default', agentId: 'ui-client', role: 'human' },
          method: 'usage_summary',
          args: {},
        });
        if (!cancelled && res && typeof res === 'object') {
          const summary = res as UsageSummary;
          if (Array.isArray(summary.providers)) {
            setProviders(summary.providers);
          }
        }
      } catch {
        // Silent — panel shows "unavailable" state below.
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetchUsage();
    const id = setInterval(fetchUsage, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (loading && !providers) {
    return (
      <div style={{ fontSize: 11, color: 'var(--fg-dim)', padding: '12px 0' }}>
        Loading provider plan info…
      </div>
    );
  }

  if (!providers || providers.length === 0) {
    return (
      <div style={{ fontSize: 11, color: 'var(--fg-dim)', padding: '12px 0' }}>
        Plan info unavailable — sidecar may still be starting.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {providers.map((p) => (
        <ProviderRow key={p.providerId} provider={p} variant={variant} />
      ))}
    </div>
  );
}
