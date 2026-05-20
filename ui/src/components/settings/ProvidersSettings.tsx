import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { PlanUsagePanel } from '../PlanUsagePanel';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';
import { useSectionDraft } from './useSectionDraft';
import { SaveBar, SectionMeta } from './SectionShell';
import {
  ProviderPlanAuth,
  type ProviderId,
  type AuthStatus,
} from './ProviderPlanAuth';
import { getCachedStatus, loadAllStatuses, subscribeStatus } from './providerAuthCache';
import { ProviderModelPicker } from './ProviderModelPicker';

type AuthMode = 'apikey' | 'plan';

interface ProviderEntry {
  id: ProviderId;
  apiKey: string;
  defaultModel: string;
  costCapDailyUsd: number;
  authMode?: AuthMode;
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

interface ProvidersDraft {
  defaultByRole: Record<string, string>;
  providers: ProviderEntry[];
}

const DEFAULTS: ProvidersDraft = {
  defaultByRole: {
    lead: 'anthropic/Opus 4.6',
    architect: 'anthropic/Sonnet 4.6',
    developer: 'anthropic/Sonnet 4.6',
    reviewer: 'anthropic/Sonnet 4.6',
    tester: 'anthropic/Haiku 4.5',
    researcher: 'openai/5.4',
  },
  providers: [
    { id: 'anthropic', apiKey: '', defaultModel: 'Sonnet 4.6', costCapDailyUsd: 50, authMode: 'apikey' },
    { id: 'openai', apiKey: '', defaultModel: '5.4', costCapDailyUsd: 50, authMode: 'apikey' },
    { id: 'gemini', apiKey: '', defaultModel: 'gemini-2.5-pro', costCapDailyUsd: 0, authMode: 'apikey' },
    { id: 'opencode', apiKey: '', defaultModel: 'GLM-4.6', costCapDailyUsd: 0, authMode: 'apikey' },
  ],
};

export function ProvidersSettings() {
  const draft = useSectionDraft<ProvidersDraft>({ section: 'providers', scope: 'global', defaults: DEFAULTS });
  const [authStatuses, setAuthStatuses] = useState<Partial<Record<ProviderId, AuthStatus>>>({});

  // Probe each provider's plan-auth surface once so the auth-mode toggle can
  // hide the "Plan / subscription" option when the provider is API-only
  // (OpenCode) or otherwise unsupported. Reads through providerAuthCache —
  // a cached value is reused, an in-flight fetch is shared, and we subscribe
  // so login/logout from the badge below propagates back here without a
  // second probe.
  useEffect(() => {
    const ids: ProviderId[] = ['anthropic', 'openai', 'gemini', 'opencode'];

    // Seed from cache synchronously so the toggle row doesn't flicker.
    const seed: Partial<Record<ProviderId, AuthStatus>> = {};
    for (const id of ids) {
      const cached = getCachedStatus(id);
      if (cached) seed[id] = cached;
    }
    if (Object.keys(seed).length > 0) setAuthStatuses(seed);

    void loadAllStatuses(ids);

    const unsubscribers = ids.map((id) =>
      subscribeStatus(id, (status) => {
        setAuthStatuses((prev) => {
          if (status === null) {
            if (!(id in prev)) return prev;
            const next = { ...prev };
            delete next[id];
            return next;
          }
          return { ...prev, [id]: status };
        });
      }),
    );
    return () => {
      for (const unsub of unsubscribers) unsub();
    };
  }, []);

  function patchProvider(id: ProviderEntry['id'], partial: Partial<ProviderEntry>) {
    draft.patch({
      providers: draft.draft.providers.map((p) => (p.id === id ? { ...p, ...partial } : p)),
    });
  }
  function patchRole(role: string, value: string) {
    draft.patch({
      defaultByRole: { ...draft.draft.defaultByRole, [role]: value },
    });
  }

  return (
    <div>
      <SettingsSectionHeader
        title="Providers"
        description="API keys, default models, and cost caps for each CLI runtime provider."
      />
      <SectionMeta draft={draft} />

      <SettingsCard
        title="Plan & quota usage"
        description="Live signed-in status and remaining plan quota for each subscription provider. Claude exposes session + weekly quotas via its /usage panel; Codex and Gemini show sign-in only (no quota probe yet)."
      >
        <PlanUsagePanel variant="full" />
      </SettingsCard>

      <SettingsCard title="Per-provider settings">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {draft.draft.providers.map((p) => {
            const authMode: AuthMode = p.authMode ?? 'apikey';
            const label = PROVIDER_LABELS[p.id];
            const auth = authStatuses[p.id];
            const planAuthAvailable = auth ? auth.supported === true : true;
            // If we know the provider can't do plan auth and the user had it
            // selected, snap them back to API key.
            if (!planAuthAvailable && authMode === 'plan') {
              // Defer to next tick to avoid setState during render.
              queueMicrotask(() => patchProvider(p.id, { authMode: 'apikey' }));
            }
            return (
              <div
                key={p.id}
                style={{
                  padding: '12px 14px',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
                  borderRadius: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 8,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className={`provider-glyph ${p.id}`} style={{ width: 24, height: 24, borderRadius: 6 }} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{label}</span>
                  <span className="dim" style={{ fontSize: 11 }}>
                    {authMode === 'plan' ? 'Plan auth' : (p.apiKey ? 'API key set' : 'No key set')}
                  </span>
                </div>

                <div className="field" style={{ margin: 0 }}>
                  <label>Auth method</label>
                  <div className="seg">
                    <button
                      type="button"
                      className={authMode === 'apikey' ? 'active' : ''}
                      onClick={() => patchProvider(p.id, { authMode: 'apikey' })}
                      disabled={draft.saving}
                    >
                      API key
                    </button>
                    {planAuthAvailable && (
                      <button
                        type="button"
                        className={authMode === 'plan' ? 'active' : ''}
                        onClick={() => patchProvider(p.id, { authMode: 'plan' })}
                        disabled={draft.saving}
                      >
                        Plan / subscription
                      </button>
                    )}
                  </div>
                  <div className="field-hint">
                    {authMode === 'apikey'
                      ? !planAuthAvailable && auth?.apiOnly
                        ? `${label} is API-only — no subscription/plan auth flow available.`
                        : 'Pay-per-token using a provider API key. Key stays in settings.json on this machine.'
                      : `Use your ${label} subscription via the CLI's own auth (no API key needed).`}
                  </div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, alignItems: 'start' }}>
                  {authMode === 'apikey' ? (
                    <div className="field" style={{ margin: 0 }}>
                      <label>API key</label>
                      <input
                        type="password"
                        className="field-input mono"
                        value={p.apiKey}
                        onChange={(e) => patchProvider(p.id, { apiKey: e.target.value })}
                        placeholder={p.apiKey ? '••••••' : `${label} API key`}
                        disabled={draft.saving}
                        style={{ fontSize: 12 }}
                      />
                    </div>
                  ) : (
                    <div style={{ margin: 0 }}>
                      <label
                        style={{
                          display: 'block',
                          fontSize: 11,
                          color: 'var(--fg-muted)',
                          marginBottom: 4,
                          fontWeight: 500,
                        }}
                      >
                        Plan auth
                      </label>
                      <ProviderPlanAuth providerId={p.id} providerLabel={label} />
                    </div>
                  )}
                  <div className="field" style={{ margin: 0 }}>
                    <label>Default model</label>
                    <input
                      className="field-input mono"
                      value={p.defaultModel}
                      onChange={(e) => patchProvider(p.id, { defaultModel: e.target.value })}
                      disabled={draft.saving}
                      style={{ fontSize: 12 }}
                    />
                  </div>
                </div>

                <div className="field" style={{ margin: 0 }}>
                  <label>Daily cost cap (USD)</label>
                  <input
                    type="number"
                    className="field-input mono"
                    min={0}
                    value={p.costCapDailyUsd}
                    onChange={(e) => patchProvider(p.id, { costCapDailyUsd: Number(e.target.value) || 0 })}
                    disabled={draft.saving}
                    style={{ fontSize: 12, maxWidth: 180 }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Default model per role"
        description="When a team is created without an explicit model per agent, these defaults fill in. Pick a provider, then a model."
      >
        {Object.entries(draft.draft.defaultByRole).map(([role, value]) => (
          <div key={role} className="field">
            <label style={{ textTransform: 'capitalize' }}>{role}</label>
            <ProviderModelPicker
              value={value}
              onChange={(next) => patchRole(role, next)}
              disabled={draft.saving}
            />
          </div>
        ))}
        <div className="field-hint" style={{ marginTop: 4 }}>
          <Icon name="info" size={11} /> Stored in plaintext on disk — only set production keys on machines you trust.
        </div>
      </SettingsCard>

      <SaveBar draft={draft} />
    </div>
  );
}
