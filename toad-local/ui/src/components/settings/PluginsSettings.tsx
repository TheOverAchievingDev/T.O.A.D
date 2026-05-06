import { useEffect, useState } from 'react';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';
import { callTool as callToadApi } from '@/api/client';

interface PluginInfo {
  pluginId: 'railway' | 'eas' | 'vercel';
  label: string;
  supported: boolean;
  signedIn: boolean;
  reason: string | null;
  user: { email?: string; login?: string; name?: string } | null;
}

interface ResourceInfo {
  resourceId: string;
  pluginId: string;
  kind: string;
  externalId: string;
  createdAt: string;
}

interface JobInfo {
  jobId: string;
  pluginId: string;
  action: string;
  state: 'pending' | 'running' | 'finished' | 'error';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

const PROVIDER_GLYPH_CLASS: Record<string, string> = {
  railway: 'railway',
  eas: 'eas',
  vercel: 'vercel',
};

export function PluginsSettings() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [resources, setResources] = useState<ResourceInfo[]>([]);
  const [jobs, setJobs] = useState<JobInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingLogin, setPendingLogin] = useState<string | null>(null);

  const load = async () => {
    try {
      const list = await callToadApi({
        actor: { teamId: 'default', agentId: 'ui-client', role: 'human' },
        method: 'plugin_list_available', args: {},
      }) as { plugins: PluginInfo[] };
      setPlugins(list.plugins);

      const r = await callToadApi({
        actor: { teamId: 'default', agentId: 'ui-client', role: 'human' },
        method: 'plugin_resource_list', args: {},
      }) as { resources: ResourceInfo[] };
      setResources(r.resources);

      const j = await callToadApi({
        actor: { teamId: 'default', agentId: 'ui-client', role: 'human' },
        method: 'plugin_job_list', args: { limit: 10 },
      }) as { jobs: JobInfo[] };
      setJobs(j.jobs);
    } catch {
      // Silent — UI shows empty state.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const startLogin = async (pluginId: string) => {
    setPendingLogin(pluginId);
    try {
      const result = await callToadApi({
        actor: { teamId: 'default', agentId: 'ui-client', role: 'human' },
        method: 'plugin_login', args: { pluginId },
      }) as { manualLogin?: boolean; reason?: string };
      if (result.manualLogin) {
        // Show the manual instructions in an alert for now.
        // Slice 1.5 can build a dedicated modal.
        window.alert(result.reason ?? `Run the ${pluginId} CLI's login command in a terminal.`);
      }
    } finally {
      setPendingLogin(null);
      void load();
    }
  };

  const logout = async (pluginId: string) => {
    if (!window.confirm(`Sign out of ${pluginId}?`)) return;
    try {
      await callToadApi({
        actor: { teamId: 'default', agentId: 'ui-client', role: 'human' },
        method: 'plugin_logout', args: { pluginId },
      });
    } catch (err) {
      window.alert(`Logout failed: ${String(err)}`);
    } finally {
      void load();
    }
  };

  return (
    <div>
      <SettingsSectionHeader
        title="Plugins"
        description="Infrastructure providers your team's agents can use. Each plugin wraps a CLI you've already authenticated locally — Symphony just calls those CLIs through the same role-gated, risk-classified, audit-trailed surface as everything else."
      />

      <SettingsCard title="Available plugins">
        {loading && <div className="dim" style={{ fontSize: 11 }}>Loading…</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {plugins.map((p) => (
            <div
              key={p.pluginId}
              style={{
                padding: '12px 14px',
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
                borderRadius: 8,
                opacity: p.supported ? 1 : 0.55,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span className={`provider-glyph ${PROVIDER_GLYPH_CLASS[p.pluginId] ?? ''}`}
                      style={{ width: 24, height: 24, borderRadius: 6 }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</span>
                <span
                  style={{
                    fontSize: 10,
                    padding: '2px 6px',
                    borderRadius: 3,
                    background: p.signedIn ? 'rgba(74,222,128,0.12)' : 'rgba(255,255,255,0.04)',
                    color: p.signedIn ? 'var(--ok, #4ade80)' : 'var(--fg-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    fontWeight: 600,
                  }}
                >
                  {p.signedIn ? 'Signed in' : (p.supported ? 'Not signed in' : 'Slice 2/3')}
                </span>
                {p.user?.email && (
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{p.user.email}</span>
                )}
              </div>
              {p.reason && !p.signedIn && (
                <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 6 }}>{p.reason}</div>
              )}
              {p.supported && !p.signedIn && (
                <button
                  className="btn btn-sm"
                  onClick={() => void startLogin(p.pluginId)}
                  disabled={pendingLogin === p.pluginId}
                >
                  {pendingLogin === p.pluginId ? 'Awaiting login…' : 'Sign in'}
                </button>
              )}
              {p.supported && p.signedIn && (
                <button className="btn btn-sm" onClick={() => void logout(p.pluginId)}>
                  Sign out
                </button>
              )}
            </div>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Provisioned resources"
        description="Resources Symphony's agents have created via plugins. Deprovisioning is manual in slice 1 — visit the provider's dashboard to remove a resource fully. Cleanup-on-team-delete is a slice-1.5 follow-up."
      >
        {resources.length === 0 ? (
          <div className="dim" style={{ fontSize: 11 }}>No resources yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {resources.map((r) => (
              <div key={r.resourceId} style={{
                padding: '8px 10px', fontSize: 12,
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
                borderRadius: 6,
              }}>
                <span style={{ fontWeight: 600 }}>{r.pluginId}</span>
                <span style={{ color: 'var(--fg-dim)' }}> · {r.kind}</span>
                <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}> · {r.externalId}</span>
                <span style={{ color: 'var(--fg-dim)', fontSize: 11 }}> · {new Date(r.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>

      <SettingsCard
        title="Recent background jobs"
        description="Long-running tasks triggered by plugins (e.g. EAS builds or OTA updates)."
      >
        {jobs.length === 0 ? (
          <div className="dim" style={{ fontSize: 11 }}>No jobs yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {jobs.map((j) => (
              <div key={j.jobId} style={{
                padding: '8px 10px', fontSize: 12,
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
                borderRadius: 6,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <span style={{ fontWeight: 600 }}>{j.pluginId}</span>
                    <span style={{ color: 'var(--fg-dim)' }}> · {j.action}</span>
                    <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}> · {j.jobId.slice(0, 8)}</span>
                  </div>
                  <span
                    style={{
                      fontSize: 10,
                      padding: '2px 6px',
                      borderRadius: 3,
                      background: j.state === 'running' ? 'rgba(59,130,246,0.12)' : (j.state === 'error' ? 'rgba(239,68,68,0.12)' : 'rgba(255,255,255,0.04)'),
                      color: j.state === 'running' ? '#3b82f6' : (j.state === 'error' ? '#ef4444' : 'var(--fg-dim)'),
                      textTransform: 'uppercase',
                      fontWeight: 600,
                    }}
                  >
                    {j.state}
                  </span>
                </div>
                <div style={{ marginTop: 4, color: 'var(--fg-dim)', fontSize: 11 }}>
                  Started: {new Date(j.startedAt).toLocaleString()}
                  {j.finishedAt && ` · Finished: ${new Date(j.finishedAt).toLocaleTimeString()}`}
                </div>
                {j.error && (
                  <div style={{ marginTop: 4, color: '#ef4444', fontSize: 11 }}>
                    Error: {j.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
    </div>
  );
}
