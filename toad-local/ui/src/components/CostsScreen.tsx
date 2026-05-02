import { useMemo } from 'react';
import type { Team, Runtime } from '@/types';
import { roleStyle } from '@/data/roles';
import { Icon } from './Icon';
import { useSettings } from '@/hooks/useSettings';

interface CostsScreenProps {
  team: Team;
  runtimes: Runtime[];
}

interface ProviderRate {
  /** USD per million input tokens. */
  in: number;
  /** USD per million output tokens. */
  out: number;
}

interface ProviderSetting {
  apiKey?: string;
  defaultModel?: string;
  costCapDailyUsd?: number;
}

/**
 * Rough token-pricing model — placeholder rates the user can override later.
 * Source: provider public pricing as of mid-2025; treat as estimates only.
 */
const DEFAULT_RATES: Record<string, ProviderRate> = {
  anthropic: { in: 3, out: 15 },
  openai: { in: 2.5, out: 10 },
  opencode: { in: 0.5, out: 1.5 },
};

function rateForProvider(provider: string): ProviderRate {
  return DEFAULT_RATES[provider] ?? { in: 1, out: 3 };
}

function estCostUsd(tokensIn: number, tokensOut: number, rate: ProviderRate): number {
  return (tokensIn / 1_000_000) * rate.in + (tokensOut / 1_000_000) * rate.out;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatUsd(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

export function CostsScreen({ team, runtimes }: CostsScreenProps) {
  const { settings } = useSettings();

  // Pull cost caps from settings.providers if available.
  const providerCaps = useMemo<Record<string, number>>(() => {
    const caps: Record<string, number> = {};
    const providers = settings.providers && typeof settings.providers === 'object'
      ? (settings.providers as { providers?: ProviderSetting[] }).providers
      : null;
    if (Array.isArray(providers)) {
      for (const p of providers) {
        const id = (p as ProviderSetting & { id?: string }).id;
        if (typeof id === 'string' && typeof p.costCapDailyUsd === 'number') {
          caps[id] = p.costCapDailyUsd;
        }
      }
    }
    return caps;
  }, [settings]);

  // Aggregate by provider.
  const byProvider = useMemo(() => {
    const map = new Map<string, { tokensIn: number; tokensOut: number; reqs: number; runtimes: number }>();
    for (const r of runtimes) {
      const cur = map.get(r.provider) ?? { tokensIn: 0, tokensOut: 0, reqs: 0, runtimes: 0 };
      cur.tokensIn += r.tokensIn;
      cur.tokensOut += r.tokensOut;
      cur.reqs += r.reqs;
      cur.runtimes += 1;
      map.set(r.provider, cur);
    }
    return [...map.entries()].map(([provider, agg]) => ({
      provider,
      ...agg,
      cost: estCostUsd(agg.tokensIn, agg.tokensOut, rateForProvider(provider)),
      cap: providerCaps[provider] ?? 0,
    })).sort((a, b) => b.cost - a.cost);
  }, [runtimes, providerCaps]);

  const totals = useMemo(() => {
    let tokensIn = 0;
    let tokensOut = 0;
    let cost = 0;
    let reqs = 0;
    for (const p of byProvider) {
      tokensIn += p.tokensIn;
      tokensOut += p.tokensOut;
      cost += p.cost;
      reqs += p.reqs;
    }
    return { tokensIn, tokensOut, cost, reqs };
  }, [byProvider]);

  // Per-agent breakdown joined with team members.
  const byAgent = useMemo(() => {
    return runtimes
      .map((r) => {
        const member = team.members.find((m) => m.id === r.agent);
        const rate = rateForProvider(r.provider);
        const cost = estCostUsd(r.tokensIn, r.tokensOut, rate);
        return {
          runtime: r,
          memberName: member?.name ?? r.agent,
          memberRole: member?.role ?? 'developer',
          cost,
        };
      })
      .sort((a, b) => b.cost - a.cost);
  }, [runtimes, team]);

  return (
    <main className="ws-main" style={{ overflow: 'auto' }}>
      <div className="ws-main-header">
        <div className="team-title">
          <h1>Cost dashboard</h1>
          <span className="team-meta mono">· {team.name}</span>
          <span className="dim mono" style={{ fontSize: 11 }}>
            estimated; uses default token rates per provider
          </span>
        </div>
      </div>

      <div className="ws-main-body" style={{ padding: '24px 32px 40px' }}>
        {runtimes.length === 0 && (
          <div className="dim" style={{ padding: '40px 0', textAlign: 'center', fontSize: 13 }}>
            No active runtimes. Spin up a team to see live cost data.
          </div>
        )}

        {runtimes.length > 0 && (
          <>
            {/* ---- Aggregate summary ---- */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(4, 1fr)',
                gap: 12,
                marginBottom: 20,
              }}
            >
              <SummaryCell label="Active runtimes" value={runtimes.filter((r) => r.status === 'live').length.toString()} sub={`${runtimes.length} total`} />
              <SummaryCell label="Tokens in" value={formatTokens(totals.tokensIn)} sub={`${totals.reqs} requests`} />
              <SummaryCell label="Tokens out" value={formatTokens(totals.tokensOut)} sub={`ratio ${(totals.tokensOut / Math.max(1, totals.tokensIn)).toFixed(2)}`} />
              <SummaryCell label="Estimated spend" value={formatUsd(totals.cost)} sub="across all runtimes" highlight />
            </div>

            {/* ---- By provider ---- */}
            <Section title="By provider">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {byProvider.map((p) => {
                  const rate = rateForProvider(p.provider);
                  const capUsage = p.cap > 0 ? Math.min(100, (p.cost / p.cap) * 100) : 0;
                  const capColor = capUsage > 90 ? 'var(--err, #e5484d)'
                    : capUsage > 70 ? 'oklch(0.78 0.14 80)'
                    : 'oklch(0.72 0.15 145)';
                  return (
                    <div
                      key={p.provider}
                      style={{
                        padding: '12px 14px',
                        background: 'var(--bg-panel, rgba(255,255,255,0.02))',
                        border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
                        borderRadius: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                        <span className={`provider-glyph ${p.provider}`} style={{ width: 22, height: 22, borderRadius: 5 }} />
                        <span style={{ fontSize: 13, fontWeight: 600, textTransform: 'capitalize' }}>{p.provider}</span>
                        <span className="dim mono" style={{ fontSize: 11 }}>
                          ${rate.in.toFixed(2)}/M in · ${rate.out.toFixed(2)}/M out
                        </span>
                        <span className="mono" style={{ marginLeft: 'auto', fontSize: 14, fontWeight: 600 }}>
                          {formatUsd(p.cost)}
                        </span>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, fontSize: 11.5 }}>
                        <Stat label="Runtimes" value={p.runtimes.toString()} />
                        <Stat label="Tokens in" value={formatTokens(p.tokensIn)} />
                        <Stat label="Tokens out" value={formatTokens(p.tokensOut)} />
                        <Stat label="Requests" value={p.reqs.toString()} />
                      </div>
                      {p.cap > 0 && (
                        <div style={{ marginTop: 10 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                            <span className="dim" style={{ fontSize: 10.5 }}>Daily cap</span>
                            <span className="mono" style={{ fontSize: 10.5, color: capColor }}>
                              {formatUsd(p.cost)} / {formatUsd(p.cap)}
                            </span>
                            <span className="dim mono" style={{ fontSize: 10.5, marginLeft: 'auto' }}>
                              {capUsage.toFixed(0)}%
                            </span>
                          </div>
                          <div
                            style={{
                              height: 4,
                              borderRadius: 2,
                              background: 'rgba(255,255,255,0.06)',
                              overflow: 'hidden',
                            }}
                          >
                            <div
                              style={{
                                width: `${capUsage}%`,
                                height: '100%',
                                background: capColor,
                                transition: 'width 0.3s ease',
                              }}
                            />
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Section>

            {/* ---- By agent ---- */}
            <Section title="By agent">
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {byAgent.map(({ runtime: r, memberName, memberRole, cost }) => (
                  <div
                    key={r.id}
                    style={{
                      ...roleStyle(memberRole),
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr auto auto auto auto',
                      alignItems: 'center',
                      gap: 10,
                      padding: '8px 10px',
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid var(--border-soft, rgba(255,255,255,0.05))',
                      borderRadius: 6,
                      fontSize: 12,
                    }}
                  >
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: '50%',
                        background: r.status === 'live' ? 'oklch(0.72 0.15 145)' : 'var(--fg-dim)',
                      }}
                    />
                    <div>
                      <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{memberName}</span>
                      <span className="dim mono" style={{ marginLeft: 8, fontSize: 10.5 }}>
                        {r.provider} · {r.model}
                      </span>
                    </div>
                    <span className="mono dim" style={{ fontSize: 10.5 }}>
                      {formatTokens(r.tokensIn)} in
                    </span>
                    <span className="mono dim" style={{ fontSize: 10.5 }}>
                      {formatTokens(r.tokensOut)} out
                    </span>
                    <span className="mono dim" style={{ fontSize: 10.5 }}>
                      {r.reqs} reqs
                    </span>
                    <span className="mono" style={{ fontWeight: 600, minWidth: 60, textAlign: 'right' }}>
                      {formatUsd(cost)}
                    </span>
                  </div>
                ))}
              </div>
            </Section>

            <div className="dim" style={{ marginTop: 24, fontSize: 11.5, lineHeight: 1.5 }}>
              <Icon name="info" size={11} /> These are rough estimates using built-in default rates per provider.
              Actual billing comes from your provider dashboards. Set a daily cost cap per provider in
              <strong> Settings → Providers</strong> to see usage progress here.
            </div>
          </>
        )}
      </div>
    </main>
  );
}

function SummaryCell({ label, value, sub, highlight }: { label: string; value: string; sub?: string; highlight?: boolean }) {
  return (
    <div
      style={{
        padding: '14px 16px',
        background: highlight
          ? 'linear-gradient(180deg, oklch(0.30 0.08 25 / 0.18), oklch(0.30 0.08 25 / 0.06))'
          : 'var(--bg-panel, rgba(255,255,255,0.02))',
        border: highlight
          ? '1px solid oklch(0.55 0.18 25 / 0.30)'
          : '1px solid var(--border-soft, rgba(255,255,255,0.06))',
        borderRadius: 10,
      }}
    >
      <div className="section-label" style={{ fontSize: 10 }}>{label}</div>
      <div className="mono" style={{ fontSize: 22, fontWeight: 600, margin: '4px 0 2px' }}>{value}</div>
      {sub && <div className="dim mono" style={{ fontSize: 10.5 }}>{sub}</div>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div className="section-label" style={{ marginBottom: 10 }}>{title}</div>
      {children}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="dim" style={{ fontSize: 10 }}>{label}</div>
      <div className="mono" style={{ fontSize: 13, fontWeight: 500 }}>{value}</div>
    </div>
  );
}
