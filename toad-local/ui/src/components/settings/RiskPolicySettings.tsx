import { useEffect, useMemo, useState } from 'react';
import { Icon } from '../Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';

type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
type RuleKind = 'files' | 'commands';

interface RiskRule {
  pattern: string;
  riskLevel?: RiskLevel;
  requiresHumanApproval?: boolean;
}

interface PolicyResponse {
  rules: RiskRule[];
  commandRules: RiskRule[];
  path: string;
  exists: boolean;
  malformed: boolean;
}

interface PreviewVerdict {
  riskLevel: RiskLevel | null;
  requiresHumanApproval: boolean;
  matchedRules: Array<{ pattern: string; appliesTo?: string; riskLevel?: RiskLevel; requiresHumanApproval?: boolean; reason?: string }>;
}

const DEFAULT_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };
const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

const LEVEL_COLOR: Record<RiskLevel, { color: string; bg: string; bd: string }> = {
  low: { color: 'oklch(0.78 0.05 245)', bg: 'oklch(0.30 0.04 245 / 0.4)', bd: 'oklch(0.55 0.08 245 / 0.30)' },
  medium: { color: 'oklch(0.85 0.14 80)', bg: 'oklch(0.78 0.14 80 / 0.14)', bd: 'oklch(0.78 0.14 80 / 0.30)' },
  high: { color: 'oklch(0.78 0.20 25)', bg: 'oklch(0.65 0.20 25 / 0.14)', bd: 'oklch(0.65 0.20 25 / 0.30)' },
  critical: { color: 'oklch(0.85 0.20 25)', bg: 'oklch(0.55 0.20 25 / 0.22)', bd: 'oklch(0.65 0.20 25 / 0.50)' },
};

interface RuleRowProps {
  rule: RiskRule;
  index: number;
  onChange: (next: RiskRule) => void;
  onRemove: () => void;
  kind: RuleKind;
  disabled?: boolean;
}

function RuleRow({ rule, onChange, onRemove, kind, disabled }: RuleRowProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.6fr auto auto auto',
        alignItems: 'center',
        gap: 8,
        padding: '6px 8px',
        background: 'rgba(255,255,255,0.02)',
        border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
        borderRadius: 6,
      }}
    >
      <input
        className="field-input mono"
        style={{ fontSize: 12 }}
        value={rule.pattern}
        onChange={(e) => onChange({ ...rule, pattern: e.target.value })}
        placeholder={kind === 'files' ? 'e.g. .env*, **/secrets/**' : 'e.g. rm -rf, force-push'}
        disabled={disabled}
      />
      <div className="seg" style={{ minWidth: 'auto' }}>
        <button
          type="button"
          className={!rule.riskLevel ? 'active' : ''}
          onClick={() => onChange({ ...rule, riskLevel: undefined })}
          disabled={disabled}
          style={{ fontSize: 10 }}
        >
          —
        </button>
        {RISK_LEVELS.map((lv) => {
          const isActive = rule.riskLevel === lv;
          const meta = LEVEL_COLOR[lv];
          return (
            <button
              key={lv}
              type="button"
              className={isActive ? 'active' : ''}
              onClick={() => onChange({ ...rule, riskLevel: lv })}
              disabled={disabled}
              style={{
                fontSize: 10,
                ...(isActive ? { background: meta.bg, color: meta.color } : {}),
              }}
            >
              {lv[0].toUpperCase()}
              <span style={{ display: 'none' }}>{lv}</span>
            </button>
          );
        })}
      </div>
      <label
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 4,
          fontSize: 11,
          color: 'var(--fg-muted)',
          cursor: disabled ? 'default' : 'pointer',
        }}
        title="Force human approval before merge_ready → done"
      >
        <input
          type="checkbox"
          checked={rule.requiresHumanApproval === true}
          onChange={(e) => onChange({ ...rule, requiresHumanApproval: e.target.checked })}
          disabled={disabled}
        />
        gate
      </label>
      <button
        type="button"
        className="icon-btn"
        onClick={onRemove}
        disabled={disabled}
        aria-label="Remove rule"
      >
        <Icon name="trash" size={12} />
      </button>
    </div>
  );
}

export function RiskPolicySettings() {
  const [policy, setPolicy] = useState<PolicyResponse | null>(null);
  const [draftRules, setDraftRules] = useState<RiskRule[]>([]);
  const [draftCommandRules, setDraftCommandRules] = useState<RiskRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  // Preview pane
  const [previewFiles, setPreviewFiles] = useState('.env.production\nsrc/app.ts');
  const [previewCommands, setPreviewCommands] = useState('');
  const [previewVerdict, setPreviewVerdict] = useState<PreviewVerdict | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const dirty = useMemo(() => {
    if (!policy) return false;
    return JSON.stringify(policy.rules) !== JSON.stringify(draftRules)
      || JSON.stringify(policy.commandRules) !== JSON.stringify(draftCommandRules);
  }, [policy, draftRules, draftCommandRules]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const result = await callTool<PolicyResponse>({
        actor: DEFAULT_ACTOR,
        method: 'risk_policy_get',
        args: {},
      });
      setPolicy(result);
      setDraftRules(result.rules);
      setDraftCommandRules(result.commandRules);
    } catch (err) {
      setError(err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Failed to load risk policy'));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setSaving(true);
    setError(null);
    setInfo(null);
    try {
      await callTool({
        actor: DEFAULT_ACTOR,
        method: 'risk_policy_set',
        args: { rules: draftRules, commandRules: draftCommandRules },
        idempotencyKey: `rpset-${Date.now()}`,
      });
      setInfo('Saved.');
      await load();
    } catch (err) {
      setError(err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Failed to save'));
    } finally {
      setSaving(false);
    }
  }

  async function runPreview() {
    setPreviewLoading(true);
    setError(null);
    try {
      const verdict = await callTool<PreviewVerdict>({
        actor: DEFAULT_ACTOR,
        method: 'risk_policy_preview',
        args: {
          files: previewFiles.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
          commands: previewCommands.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
          policy: { rules: draftRules, commandRules: draftCommandRules },
        },
      });
      setPreviewVerdict(verdict);
    } catch (err) {
      setError(err instanceof ToadApiError ? err.message : (err instanceof Error ? err.message : 'Preview failed'));
    } finally {
      setPreviewLoading(false);
    }
  }

  function addRule(kind: RuleKind) {
    const empty: RiskRule = { pattern: '', riskLevel: 'medium' };
    if (kind === 'files') setDraftRules((prev) => [...prev, empty]);
    else setDraftCommandRules((prev) => [...prev, empty]);
  }

  function updateRule(kind: RuleKind, index: number, next: RiskRule) {
    if (kind === 'files') setDraftRules((prev) => prev.map((r, i) => (i === index ? next : r)));
    else setDraftCommandRules((prev) => prev.map((r, i) => (i === index ? next : r)));
  }

  function removeRule(kind: RuleKind, index: number) {
    if (kind === 'files') setDraftRules((prev) => prev.filter((_, i) => i !== index));
    else setDraftCommandRules((prev) => prev.filter((_, i) => i !== index));
  }

  return (
    <div>
      <SettingsSectionHeader
        title="Risk policies"
        description="Pattern-based rules that auto-elevate task risk and gate human approval at review_request time. Stored at the project level in .toad/risk-policy.json."
      />

      {policy?.path && (
        <div className="dim mono" style={{ fontSize: 11, marginBottom: 12 }}>
          File: {policy.path} {policy.exists ? '' : '(not yet created — saving will create it)'}
          {policy.malformed && <span style={{ color: 'var(--err)', marginLeft: 8 }}>· malformed JSON on disk</span>}
        </div>
      )}

      {error && (
        <div
          style={{
            marginBottom: 12, padding: '8px 12px',
            background: 'oklch(0.30 0.08 25 / 0.4)', border: '1px solid oklch(0.55 0.18 25 / 0.4)',
            borderRadius: 6, color: 'oklch(0.85 0.10 25)', fontSize: 12,
          }}
        >
          {error}
        </div>
      )}
      {info && (
        <div
          style={{
            marginBottom: 12, padding: '8px 12px',
            background: 'oklch(0.30 0.08 145 / 0.4)', border: '1px solid oklch(0.55 0.18 145 / 0.4)',
            borderRadius: 6, color: 'oklch(0.85 0.10 145)', fontSize: 12,
          }}
        >
          {info}
        </div>
      )}

      {loading && <div className="dim" style={{ fontSize: 12 }}>Loading…</div>}

      {!loading && (
        <>
          <SettingsCard
            title="File rules"
            description="Glob patterns matched against task.payload.files at review_request time. Matching files elevate the task's riskLevel and (optionally) trigger the §14 human-approval gate."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {draftRules.length === 0 && (
                <div className="dim" style={{ fontSize: 12, padding: '8px 0' }}>No file rules. Add one below.</div>
              )}
              {draftRules.map((r, i) => (
                <RuleRow
                  key={i}
                  index={i}
                  rule={r}
                  kind="files"
                  onChange={(next) => updateRule('files', i, next)}
                  onRemove={() => removeRule('files', i)}
                  disabled={saving}
                />
              ))}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => addRule('files')} disabled={saving}>
                <Icon name="plus" size={11} /> Add file rule
              </button>
            </div>
          </SettingsCard>

          <SettingsCard
            title="Command rules"
            description="Patterns matched against bash commands extracted from runtime_events for the task. Substring/prefix/suffix matching."
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {draftCommandRules.length === 0 && (
                <div className="dim" style={{ fontSize: 12, padding: '8px 0' }}>No command rules. Add one below.</div>
              )}
              {draftCommandRules.map((r, i) => (
                <RuleRow
                  key={i}
                  index={i}
                  rule={r}
                  kind="commands"
                  onChange={(next) => updateRule('commands', i, next)}
                  onRemove={() => removeRule('commands', i)}
                  disabled={saving}
                />
              ))}
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => addRule('commands')} disabled={saving}>
                <Icon name="plus" size={11} /> Add command rule
              </button>
            </div>
          </SettingsCard>

          <SettingsCard
            title="Preview"
            description="Run the draft policy against example files and commands to see how the §14 classifier will decide."
          >
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div className="field" style={{ margin: 0 }}>
                <label>Sample files (one per line)</label>
                <textarea
                  className="field-input mono"
                  rows={4}
                  value={previewFiles}
                  onChange={(e) => setPreviewFiles(e.target.value)}
                  style={{ fontSize: 11.5, resize: 'vertical' }}
                />
              </div>
              <div className="field" style={{ margin: 0 }}>
                <label>Sample commands (one per line)</label>
                <textarea
                  className="field-input mono"
                  rows={4}
                  value={previewCommands}
                  onChange={(e) => setPreviewCommands(e.target.value)}
                  placeholder="e.g. rm -rf node_modules"
                  style={{ fontSize: 11.5, resize: 'vertical' }}
                />
              </div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
              <button type="button" className="btn btn-sm" onClick={runPreview} disabled={previewLoading}>
                <Icon name="eye" size={11} /> {previewLoading ? 'Classifying…' : 'Preview verdict'}
              </button>
              {previewVerdict && (
                <PreviewVerdictView verdict={previewVerdict} />
              )}
            </div>
          </SettingsCard>

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                if (!policy) return;
                setDraftRules(policy.rules);
                setDraftCommandRules(policy.commandRules);
                setInfo(null);
              }}
              disabled={!dirty || saving}
            >
              Revert
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={save}
              disabled={!dirty || saving}
            >
              <Icon name="check" size={11} /> {saving ? 'Saving…' : 'Save policy'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function PreviewVerdictView({ verdict }: { verdict: PreviewVerdict }) {
  if (!verdict.riskLevel && !verdict.requiresHumanApproval && verdict.matchedRules.length === 0) {
    return <span className="dim" style={{ fontSize: 12 }}>No rules matched.</span>;
  }
  const meta = verdict.riskLevel ? LEVEL_COLOR[verdict.riskLevel] : null;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
      {meta && (
        <span
          className="chip"
          style={{ background: meta.bg, color: meta.color, borderColor: meta.bd, fontSize: 10 }}
        >
          {verdict.riskLevel?.toUpperCase()}
        </span>
      )}
      {verdict.requiresHumanApproval && (
        <span
          className="chip"
          style={{
            fontSize: 10,
            background: 'oklch(0.55 0.20 25 / 0.22)',
            color: 'oklch(0.85 0.20 25)',
            borderColor: 'oklch(0.65 0.20 25 / 0.50)',
          }}
        >
          §14 gate
        </span>
      )}
      <span className="dim mono">
        {verdict.matchedRules.length} match{verdict.matchedRules.length === 1 ? '' : 'es'}
      </span>
    </span>
  );
}
