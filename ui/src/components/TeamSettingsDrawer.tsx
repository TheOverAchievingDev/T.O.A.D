import { Fragment, useEffect, useState } from 'react';
import type { Team } from '@/types';
import { Icon } from './Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';

interface BackendMember {
  agentId: string;
  role?: string | null;
  providerId?: string;
  prompt?: string;
  command?: string;
  cwd?: string;
  skipPermissions?: boolean;
}

interface BackendTeamConfig {
  teamId: string;
  lead?: BackendMember;
  teammates?: BackendMember[];
  validation?: Record<string, string> | null;
}

interface TeamSettingsDrawerProps {
  team: Team;
  actor: Actor;
  onClose: () => void;
  onSaved: () => void;
}

const VALIDATION_KEYS: { key: string; label: string; placeholder: string }[] = [
  { key: 'installCommand', label: 'Install', placeholder: 'npm install' },
  { key: 'lintCommand', label: 'Lint', placeholder: 'npm run lint' },
  { key: 'typecheckCommand', label: 'Typecheck', placeholder: 'npm run typecheck' },
  { key: 'testCommand', label: 'Test', placeholder: 'npm test' },
  { key: 'buildCommand', label: 'Build', placeholder: 'npm run build' },
  { key: 'securityCommand', label: 'Security', placeholder: 'npm audit' },
];

/**
 * Per-team settings drawer. Loads the persisted team_config via team_list,
 * lets the operator edit lead prompt, validation commands, and per-member
 * prompt overrides, then saves via team_create (which is upsert).
 *
 * Intentionally a subset of CreateTeamModal — once a team exists we don't
 * want to let the operator change membership/roles/providers from here
 * because that would invalidate the running runtimes. Use End Team +
 * recreate for those changes.
 */
export function TeamSettingsDrawer({ team, actor, onClose, onSaved }: TeamSettingsDrawerProps) {
  const [config, setConfig] = useState<BackendTeamConfig | null>(null);
  const [leadPrompt, setLeadPrompt] = useState('');
  const [memberPrompts, setMemberPrompts] = useState<Record<string, string>>({});
  const [validation, setValidation] = useState<Record<string, string>>({});
  const [skipPermissions, setSkipPermissions] = useState<boolean>(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    callTool<BackendTeamConfig[]>({
      actor,
      method: 'team_list',
      args: {},
    })
      .then((rows) => {
        if (cancelled) return;
        const c = Array.isArray(rows) ? rows.find((r) => r.teamId === team.name) : null;
        if (!c) {
          setError(`Team "${team.name}" not found in the registry.`);
          setLoading(false);
          return;
        }
        setConfig(c);
        setLeadPrompt(c.lead?.prompt ?? '');
        const promptsMap: Record<string, string> = {};
        (c.teammates ?? []).forEach((t) => { promptsMap[t.agentId] = t.prompt ?? ''; });
        setMemberPrompts(promptsMap);
        setValidation((c.validation ?? {}) as Record<string, string>);
        setSkipPermissions(c.lead?.skipPermissions ?? true);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof ToadApiError ? err.message : err instanceof Error ? err.message : 'Failed to load team config');
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [team.name, actor]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  async function save() {
    if (!config || saving) return;
    setSaving(true);
    setError(null);
    try {
      const cleanValidation: Record<string, string> = {};
      for (const k of Object.keys(validation)) {
        const v = validation[k]?.trim();
        if (v) cleanValidation[k] = v;
      }
      const lead = {
        ...(config.lead ?? { agentId: 'lead' }),
        prompt: leadPrompt,
        skipPermissions,
      };
      const teammates = (config.teammates ?? []).map((t) => ({
        ...t,
        prompt: memberPrompts[t.agentId] ?? t.prompt ?? '',
        skipPermissions,
      }));
      // team_create upserts on teamId — same path the modal uses.
      await callTool({
        actor,
        method: 'team_create',
        args: {
          teamId: team.name,
          lead,
          teammates,
          ...(Object.keys(cleanValidation).length > 0 ? { validation: cleanValidation } : {}),
        },
        idempotencyKey: `team-settings-${team.name}-${Date.now()}`,
      });
      setSavedAt(Date.now());
      onSaved();
    } catch (err) {
      setError(err instanceof ToadApiError ? err.message : err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer notif-drawer" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 580 }}>
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="settings" size={15} />
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Team settings</h2>
            <span className="chip mono" style={{ fontSize: 10.5 }}>{team.name}</span>
          </div>
          <button className="icon-btn" onClick={onClose} title="Close" type="button"><Icon name="x" size={16} /></button>
        </div>

        {loading ? (
          <div style={{ padding: 24, textAlign: 'center', color: 'var(--fg-muted)', fontSize: 12 }}>Loading…</div>
        ) : error ? (
          <div style={{ padding: '12px 16px', color: 'var(--err, #f87171)', fontSize: 12 }}>{error}</div>
        ) : config ? (
          <div style={{ padding: '0 16px 16px', overflowY: 'auto', flex: 1 }}>
            <div style={{ marginTop: 12 }}>
              <div className="td-side-label" style={{ marginBottom: 6 }}>Lead prompt</div>
              <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
                Sent to the lead as the first stdin turn after spawn. Empty = no kickoff (lead boots and waits).
              </div>
              <textarea
                value={leadPrompt}
                onChange={(e) => setLeadPrompt(e.target.value)}
                rows={4}
                style={{
                  width: '100%',
                  background: 'var(--bg-panel, rgba(255,255,255,0.04))',
                  border: '1px solid var(--border, rgba(255,255,255,0.08))',
                  borderRadius: 6,
                  color: 'var(--fg)',
                  fontSize: 13,
                  padding: '8px 10px',
                  fontFamily: 'inherit',
                  resize: 'vertical',
                }}
                placeholder="Optional kickoff prompt for the lead…"
              />
            </div>

            {(config.teammates ?? []).length > 0 ? (
              <div style={{ marginTop: 18 }}>
                <div className="td-side-label" style={{ marginBottom: 6 }}>Teammate prompts (optional)</div>
                <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
                  Per-member kickoff. Most teammates don't need one — they wait for lead delegation.
                </div>
                {(config.teammates ?? []).map((t) => (
                  <div key={t.agentId} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginBottom: 3 }}>
                      <span className="mono">{t.agentId}</span>
                      <span className="dim" style={{ marginLeft: 6 }}>· {t.role ?? 'unspecified'}</span>
                    </div>
                    <textarea
                      value={memberPrompts[t.agentId] ?? ''}
                      onChange={(e) => setMemberPrompts((p) => ({ ...p, [t.agentId]: e.target.value }))}
                      rows={2}
                      style={{
                        width: '100%',
                        background: 'var(--bg-panel, rgba(255,255,255,0.04))',
                        border: '1px solid var(--border, rgba(255,255,255,0.08))',
                        borderRadius: 6,
                        color: 'var(--fg)',
                        fontSize: 12,
                        padding: '6px 8px',
                        fontFamily: 'inherit',
                        resize: 'vertical',
                      }}
                    />
                  </div>
                ))}
              </div>
            ) : null}

            <div style={{ marginTop: 18 }}>
              <div className="td-side-label" style={{ marginBottom: 6 }}>Validation commands</div>
              <div className="dim" style={{ fontSize: 11, marginBottom: 6 }}>
                Run by agents via <code className="mono">validation_run</code>. Empty = command unavailable.
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', rowGap: 6, columnGap: 8, alignItems: 'center' }}>
                {VALIDATION_KEYS.map(({ key, label, placeholder }) => (
                  <Fragment key={key}>
                    <label style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{label}</label>
                    <input
                      type="text"
                      value={validation[key] ?? ''}
                      onChange={(e) => setValidation((v) => ({ ...v, [key]: e.target.value }))}
                      placeholder={placeholder}
                      style={{
                        background: 'var(--bg-panel, rgba(255,255,255,0.04))',
                        border: '1px solid var(--border, rgba(255,255,255,0.08))',
                        borderRadius: 6,
                        color: 'var(--fg)',
                        fontSize: 12,
                        padding: '5px 8px',
                        fontFamily: 'var(--font-mono, monospace)',
                      }}
                    />
                  </Fragment>
                ))}
              </div>
            </div>

            <div style={{ marginTop: 18, display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                id="team-skip-perms"
                checked={skipPermissions}
                onChange={(e) => setSkipPermissions(e.target.checked)}
              />
              <label htmlFor="team-skip-perms" style={{ fontSize: 12 }}>
                Auto-approve tool calls (skip per-call permission prompts)
              </label>
            </div>
          </div>
        ) : null}

        <div style={{ padding: '12px 16px', borderTop: '1px solid var(--border, rgba(255,255,255,0.08))', display: 'flex', gap: 8, alignItems: 'center' }}>
          {savedAt ? (
            <span style={{ fontSize: 11, color: 'var(--ok, #4ade80)' }}>Saved · changes apply at next launch</span>
          ) : null}
          <span style={{ flex: 1 }} />
          <button className="btn btn-sm btn-ghost" onClick={onClose} type="button">Cancel</button>
          <button
            className="btn btn-sm btn-primary"
            onClick={() => void save()}
            disabled={loading || saving || !config}
            type="button"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
