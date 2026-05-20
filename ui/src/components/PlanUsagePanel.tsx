import { useEffect, useState } from 'react';
import { callTool as callToadApi } from '@/api/client';
import { Icon } from './Icon';

/**
 * Plan-usage breakdown for every supported subscription provider.
 */

interface QuotaWindow {
  pctUsed: number;
  resetIn?: string | null;
  label: string;
}

interface SymphonyUsage {
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

interface ProviderUsage {
  providerId: string;
  label: string;
  signedIn: boolean;
  plan: string | null;
  reason: string | null;
  quota: {
    session?: QuotaWindow | null;
    weekly?: QuotaWindow | null;
    opusWeekly?: QuotaWindow | null;
    models?: QuotaWindow[] | null;
  } | null;
  symphonyUsage?: SymphonyUsage;
}

interface UsageSummary {
  providers: ProviderUsage[];
}

interface PlanUsagePanelProps {
  variant?: 'compact' | 'full';
}

const PROVIDER_GLYPH_CLASS: Record<string, string> = {
  anthropic: 'anthropic',
  openai: 'openai',
  gemini: 'gemini',
  opencode: 'opencode',
};

function pctColor(pct: number) {
  if (pct >= 85) return 'var(--err, #f87171)';
  if (pct >= 60) return 'var(--warn, #ffcd66)';
  return 'var(--ok, #4ade80)';
}

function QuotaBar({ window }: { window: QuotaWindow }) {
  const pct = Math.min(100, Math.max(0, typeof window.pctUsed === 'number' ? window.pctUsed : 0));
  const label = window.label || 'Unknown Quota';
  const resetIn = typeof window.resetIn === 'string' ? window.resetIn : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8, fontSize: 11 }}>
        <span style={{ color: 'var(--fg-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={label}>
          {label}
        </span>
        <span style={{ color: pctColor(pct), fontWeight: 600 }}>{pct}%</span>
      </div>
      <div style={{ height: 6, background: 'rgba(255,255,255,0.06)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: pctColor(pct), transition: 'width 250ms ease-out' }} />
      </div>
      {resetIn ? (
        <span style={{ fontSize: 10, color: 'var(--fg-dim)' }}>
          {resetIn.includes('left') ? resetIn : `resets ${resetIn}`}
        </span>
      ) : null}
    </div>
  );
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
}

function formatCostUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function SymphonyUsageLine({ usage }: { usage: SymphonyUsage }) {
  const tokens = (usage.tokensIn || 0) + (usage.tokensOut || 0);
  const cost = usage.costUsd || 0;
  if (tokens === 0 && cost === 0) {
    return (
      <div style={{ fontSize: 11, color: 'var(--fg-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Icon name="info" size={11} />
        Symphony hasn't spent any tokens on this provider yet.
      </div>
    );
  }
  return (
    <div style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <span style={{ color: 'var(--fg-dim)' }}>Symphony used</span>
        <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{formatNumber(tokens)}</span>
        <span style={{ color: 'var(--fg-dim)' }}>tokens</span>
      </span>
      {cost > 0 && (
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ color: 'var(--fg-dim)' }}>·</span>
          <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{formatCostUsd(cost)}</span>
          <span style={{ color: 'var(--fg-dim)' }}>spend</span>
        </span>
      )}
    </div>
  );
}

function ProviderRow({ provider, variant }: { provider: ProviderUsage; variant: 'compact' | 'full' }) {
  const glyph = PROVIDER_GLYPH_CLASS[provider.providerId] ?? '';
  const quotas: QuotaWindow[] = [];
  
  // Gemini model quotas are higher priority to show than the synthesized 'session' object
  if (provider.providerId === 'gemini') {
    if (Array.isArray(provider.quota?.models)) {
      quotas.push(...provider.quota.models);
    } else if (provider.quota?.session) {
      quotas.push(provider.quota.session);
    }
  } else {
    if (provider.quota?.session) quotas.push(provider.quota.session);
    if (provider.quota?.weekly) quotas.push(provider.quota.weekly);
    if (provider.quota?.opusWeekly) quotas.push(provider.quota.opusWeekly);
  }

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

      {quotas.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: variant === 'compact' && quotas.length > 1 ? '1fr 1fr' : '1fr', gap: variant === 'compact' ? 8 : 12 }}>
          {quotas.map((q, idx) => (
            <QuotaBar key={`${q.label}-${idx}`} window={q} />
          ))}
        </div>
      )}

      {provider.signedIn && provider.symphonyUsage && (
        <SymphonyUsageLine usage={provider.symphonyUsage} />
      )}
      {!provider.signedIn && (
        <div style={{ fontSize: 11, color: 'var(--fg-dim)' }}>
          {provider.reason || 'Sign in via the provider settings to see quota.'}
        </div>
      )}
      {provider.signedIn && quotas.length === 0 && (provider.providerId === 'anthropic' || provider.providerId === 'openai' || provider.providerId === 'gemini') && (
        <div style={{ fontSize: 11, color: 'var(--fg-dim)', display: 'flex', alignItems: 'center', gap: 6 }}>
          <Icon name="info" size={11} />
          Quota probe pending — {provider.providerId} CLI will scrape on next poll.
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
        // Silent
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void fetchUsage();
    const id = setInterval(fetchUsage, 30_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  if (loading && !providers) {
    return <div style={{ fontSize: 11, color: 'var(--fg-dim)', padding: '12px 0' }}>Loading provider plan info…</div>;
  }

  if (!providers || providers.length === 0) {
    return <div style={{ fontSize: 11, color: 'var(--fg-dim)', padding: '12px 0' }}>Plan info unavailable — sidecar may still be starting.</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {providers.map((p) => (
        <ProviderRow key={p.providerId} provider={p} variant={variant} />
      ))}
    </div>
  );
}
