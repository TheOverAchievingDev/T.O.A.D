import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RoleId, Provider } from '@/types';
import { ROLES, ROLE_KEYS, roleStyle } from '@/data/roles';
import { providerBrand } from '@/data/providerLabels';
import { SEED_PROVIDERS } from '@/data/seed';
import { Icon } from './Icon';
import { PlanUsagePanel } from './PlanUsagePanel';
import { callTool, ToadApiError, type Actor } from '@/api/client';
import { useProjects } from '@/hooks/useProjects';
import { mergeDynamicProviderModels, modelArgsForProvider } from './createTeamModelArgs';

interface MemberDraft {
  id: number;
  name: string;
  role: Exclude<RoleId, 'lead'>;
  provider: string;
  model: string;
}

export interface CreateTeamSeed {
  /** Pre-fill the team name. */
  teamName?: string;
  /** Pre-fill the lead's launch prompt. */
  leadPrompt?: string;
  /** Pre-fill the lead's provider (anthropic / openai / gemini / opencode). */
  leadProvider?: string;
  /** Pre-fill the team's project path. */
  projectPath?: string;
  /** Pre-fill the teammate roster. Each entry becomes a MemberDraft. */
  members?: Array<{
    name: string;
    role: Exclude<RoleId, 'lead'>;
    provider?: string;
    model?: string;
  }>;
}

interface CreateTeamModalProps {
  onClose: () => void;
  onCreated?: (teamId: string) => void;
  actor?: Actor;
  providers?: Provider[];
  /** Optional pre-fill (used by Foundry → CreateTeamModal handoff). */
  seed?: CreateTeamSeed;
}

type ProjectMode = 'list' | 'custom';
type EffortLevel = 'default' | 'low' | 'medium' | 'high';
type ModelLoadState = 'idle' | 'loading' | 'loaded' | 'degraded' | 'error';
type SubmitState =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'launching' }
  | { kind: 'done'; teamId: string }
  | { kind: 'error'; message: string };

const DEFAULT_ACTOR: Actor = { teamId: 'system', agentId: 'ui-client', agentName: 'ui', role: 'human' };

// Empty defaults — the modal is opened with a blank slate so the user
// fills in real team details. Was previously seeded with sample names.
const INITIAL_MEMBERS: MemberDraft[] = [];

export function CreateTeamModal({
  onClose,
  onCreated,
  actor = DEFAULT_ACTOR,
  providers = SEED_PROVIDERS,
  seed,
}: CreateTeamModalProps) {
  const seededMembers = useMemo<MemberDraft[]>(() => {
    if (!seed?.members) return INITIAL_MEMBERS;
    return seed.members.map((m, i) => ({
      id: i + 1,
      name: m.name,
      role: m.role,
      provider: m.provider ?? 'anthropic',
      model: m.model ?? 'Default',
    }));
  }, [seed]);
  const [teamName, setTeamName] = useState(seed?.teamName ?? '');
  const [runtimeProviders, setRuntimeProviders] = useState<Provider[]>(providers);
  const [opencodeModelState, setOpencodeModelState] = useState<ModelLoadState>('idle');
  const [opencodeModelNote, setOpencodeModelNote] = useState('');
  const [solo, setSolo] = useState(false);
  const [members, setMembers] = useState<MemberDraft[]>(seededMembers);
  const [expandedMember, setExpandedMember] = useState<number | null>(null);
  const [runAfterCreate, setRunAfterCreate] = useState(true);
  const [autoApprove, setAutoApprove] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [validationOpen, setValidationOpen] = useState(false);
  const [projectMode, setProjectMode] = useState<ProjectMode>(seed?.projectPath ? 'custom' : 'list');
  const projectRegistry = useProjects();
  const recentProjects = useMemo(
    () => projectRegistry.projects,
    [projectRegistry.projects],
  );
  const [project, setProject] = useState(recentProjects[0]?.path ?? '');
  const [customPath, setCustomPath] = useState(seed?.projectPath ?? '');
  const [effort, setEffort] = useState<EffortLevel>('medium');
  const [leadProvider, setLeadProvider] = useState(seed?.leadProvider ?? 'anthropic');
  const [leadModel, setLeadModel] = useState(seed?.leadProvider === 'opencode' ? 'Default' : 'Opus 4.6');
  const [leadPrompt, setLeadPrompt] = useState(seed?.leadPrompt ?? '');
  const [validationInstall, setValidationInstall] = useState('');
  const [validationLint, setValidationLint] = useState('');
  const [validationTypecheck, setValidationTypecheck] = useState('');
  const [validationTest, setValidationTest] = useState('');
  const [validationBuild, setValidationBuild] = useState('');
  const [validationSecurity, setValidationSecurity] = useState('');
  const [description, setDescription] = useState('');
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && submit.kind !== 'creating' && submit.kind !== 'launching') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submit.kind]);

  useEffect(() => {
    if (projectMode !== 'list') return;
    if (project) return;
    if (recentProjects[0]?.path) setProject(recentProjects[0].path);
  }, [project, projectMode, recentProjects]);

  useEffect(() => {
    let cancelled = false;
    setRuntimeProviders(providers);
    setOpencodeModelState('loading');
    void callTool<{
      models?: Array<{ id?: string }>;
      degraded?: boolean;
      reason?: string | null;
      authenticatedProviders?: string[];
    }>({
      actor,
      method: 'provider_model_list',
      args: { providerId: 'opencode' },
    }).then((result) => {
      if (cancelled) return;
      const modelIds = Array.isArray(result.models)
        ? result.models.map((m) => (typeof m.id === 'string' ? m.id : '')).filter(Boolean)
        : [];
      if (modelIds.length > 0) {
        setRuntimeProviders(mergeDynamicProviderModels(providers, 'opencode', modelIds));
        setOpencodeModelState(result.degraded ? 'degraded' : 'loaded');
        const authProviders = Array.isArray(result.authenticatedProviders) ? result.authenticatedProviders : [];
        setOpencodeModelNote(authProviders.length > 0
          ? `Free models plus ${authProviders.join(', ')} credentials`
          : 'Free OpenCode models');
      } else {
        setOpencodeModelState('error');
        setOpencodeModelNote(result.reason || 'Could not load OpenCode models');
      }
    }).catch((err) => {
      if (cancelled) return;
      setOpencodeModelState('error');
      setOpencodeModelNote(err instanceof Error ? err.message : 'Could not load OpenCode models');
    });
    return () => { cancelled = true; };
  }, [actor, providers]);

  const updateMember = (id: number, patch: Partial<MemberDraft>) =>
    setMembers((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch } : m)));
  const removeMember = (id: number) =>
    setMembers((prev) => prev.filter((m) => m.id !== id));
  const addMember = () =>
    setMembers((prev) => {
      const next = Math.max(0, ...prev.map((m) => m.id)) + 1;
      return [
        ...prev,
        { id: next, name: `agent-${next}`, role: 'developer', provider: 'anthropic', model: 'Default' },
      ];
    });

  const inFlight = submit.kind === 'creating' || submit.kind === 'launching';

  async function handleSubmit() {
    if (!teamName.trim()) {
      setSubmit({ kind: 'error', message: 'Team name is required.' });
      return;
    }
    const cwd = projectMode === 'custom' ? customPath.trim() : project;
    if (!cwd) {
      setSubmit({ kind: 'error', message: 'Project path is required.' });
      return;
    }

    const teamId = teamName.trim();
    const leadModelArgs = modelArgsForProvider(leadProvider, leadModel);
    const lead = {
      agentId: 'lead',
      role: 'lead' as const,
      providerId: leadProvider,
      prompt: leadPrompt,
      skipPermissions: autoApprove,
      ...(leadModelArgs.length > 0 ? { args: leadModelArgs } : {}),
      ...(cwd ? { cwd } : {}),
    };
    const teammates = solo
      ? []
      : members.map((m) => {
          const modelArgs = modelArgsForProvider(m.provider, m.model);
          return {
            agentId: m.name.trim() || `agent-${m.id}`,
            role: m.role,
            providerId: m.provider,
            skipPermissions: autoApprove,
            ...(modelArgs.length > 0 ? { args: modelArgs } : {}),
            ...(cwd ? { cwd } : {}),
          };
        });

    // Pack validation commands; only include keys the user actually filled in
    // so the backend's normalizer doesn't see empty strings.
    const validation: Record<string, string> = {};
    if (validationInstall.trim()) validation.installCommand = validationInstall.trim();
    if (validationLint.trim()) validation.lintCommand = validationLint.trim();
    if (validationTypecheck.trim()) validation.typecheckCommand = validationTypecheck.trim();
    if (validationTest.trim()) validation.testCommand = validationTest.trim();
    if (validationBuild.trim()) validation.buildCommand = validationBuild.trim();
    if (validationSecurity.trim()) validation.securityCommand = validationSecurity.trim();

    try {
      setSubmit({ kind: 'creating' });
      await callTool({
        actor,
        method: 'team_create',
        args: {
          teamId,
          lead,
          teammates,
          ...(Object.keys(validation).length > 0 ? { validation } : {}),
        },
        idempotencyKey: `team-create-${teamId}-${Date.now()}`,
      });

      // §1: When the user supplied a lead prompt, capture it as a seed task
      // so the team has something to work on the moment it boots. Failure
      // here is non-fatal — the team is created and launchable regardless.
      const trimmedPrompt = leadPrompt.trim();
      if (trimmedPrompt) {
        const seedTaskId = `T-001`;
        const subject = trimmedPrompt.length > 80
          ? `${trimmedPrompt.slice(0, 77)}…`
          : trimmedPrompt;
        try {
          await callTool({
            actor: { ...actor, teamId },
            method: 'task_create',
            args: {
              taskId: seedTaskId,
              subject,
              description: trimmedPrompt,
              assignedRole: 'lead',
              priority: 'medium',
            },
            idempotencyKey: `seed-task-${teamId}-${Date.now()}`,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn('[create-team] seed task creation failed', err);
        }
      }

      if (runAfterCreate) {
        setSubmit({ kind: 'launching' });
        await callTool({
          actor: { ...actor, teamId },
          method: 'team_launch',
          args: { teamId },
          idempotencyKey: `team-launch-${teamId}-${Date.now()}`,
        });
      }

      setSubmit({ kind: 'done', teamId });
      onCreated?.(teamId);
      // Brief pause so user sees the success state
      setTimeout(onClose, 600);
    } catch (err) {
      const message = err instanceof ToadApiError ? err.message
        : err instanceof Error ? err.message
        : 'Unknown error';
      setSubmit({ kind: 'error', message });
    }
  }

  const memberCount = solo ? 1 : members.length + 1;

  return (
    <div className="modal-backdrop" onClick={inFlight ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>Create team</h2>
            <div className="sub">Provision a multi-agent team via your local CLI runtimes.</div>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={inFlight}>
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          {/* Provider plan/quota at-a-glance — operators picking which
              CLI to delegate roles to want to see headroom before
              choosing. Compact variant trims height since the modal is
              already dense. */}
          <div className="field">
            <label style={{ marginBottom: 6 }}>Provider plans</label>
            <PlanUsagePanel variant="compact" />
          </div>

          <div className="field">
            <label>Team name</label>
            <input
              className="field-input mono"
              value={teamName}
              onChange={(e) => setTeamName(e.target.value)}
              placeholder="e.g. signal-ops"
              disabled={inFlight}
            />
          </div>

          <div className="section-h">
            <h3>
              Members <span style={{ color: 'var(--fg-dim)', fontWeight: 400, marginLeft: 6 }}>{memberCount}</span>
            </h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--fg-muted)', cursor: 'pointer' }}>
                <input type="checkbox" checked={solo} onChange={(e) => setSolo(e.target.checked)} disabled={inFlight} />
                Solo team
              </label>
              <button className="btn btn-sm" onClick={addMember} disabled={inFlight || solo}>
                <Icon name="plus" size={12} /> Add member
              </button>
            </div>
          </div>

          {/* Lead — fixed */}
          <div className="member" style={roleStyle('lead')}>
            <span className="drag-h"><Icon name="drag" size={14} /></span>
            <div className="member-name" style={{ background: 'transparent', border: 'none', color: 'var(--fg)', fontWeight: 600 }}>
              lead
            </div>
            <div style={{ flex: 1, fontSize: 11.5, color: 'var(--fg-muted)' }}>Team Lead — coordinates and delegates</div>
            <button className="member-mini-btn" type="button">
              <span className={`provider-glyph ${leadProvider}`} />
              {leadModel}
            </button>
            <span style={{ width: 24 }} />
          </div>

          {!solo && members.map((m) => {
            const expanded = expandedMember === m.id;
            const providerEntry = runtimeProviders.find((p) => p.id === m.provider);
            return (
              <div key={m.id}>
                <div className="member" style={roleStyle(m.role)}>
                  <span className="drag-h"><Icon name="drag" size={14} /></span>
                  <input
                    className="member-name"
                    value={m.name}
                    onChange={(e) => updateMember(m.id, { name: e.target.value })}
                    disabled={inFlight}
                  />
                  <select
                    className="member-role"
                    value={m.role}
                    onChange={(e) => updateMember(m.id, { role: e.target.value as MemberDraft['role'] })}
                    disabled={inFlight}
                  >
                    {ROLE_KEYS.filter((k) => k !== 'lead').map((k) => (
                      <option key={k} value={k}>{ROLES[k].label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="member-mini-btn"
                    onClick={() => setExpandedMember(expanded ? null : m.id)}
                  >
                    <span className={`provider-glyph ${m.provider}`} />
                    {m.model}
                    <Icon name={expanded ? 'chevronUp' : 'chevronDown'} size={10} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    style={{ color: 'var(--err)' }}
                    onClick={() => removeMember(m.id)}
                    disabled={inFlight}
                  >
                    <Icon name="trash" size={13} />
                  </button>
                </div>
                {expanded && (
                  <div className="model-strip">
                    <span className="label">Provider</span>
                    {runtimeProviders.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`model-pill ${m.provider === p.id ? 'active' : ''}`}
                        onClick={() => updateMember(m.id, { provider: p.id, model: p.models[0] ?? 'Default' })}
                      >
                        <span className={`provider-glyph ${p.id}`} style={{ marginRight: 4 }} />
                        {p.label}
                      </button>
                    ))}
                    <span className="label" style={{ marginLeft: 12 }}>Model</span>
                    {(providerEntry?.models ?? []).map((modelName) => (
                      <button
                        key={modelName}
                        type="button"
                        className={`model-pill ${m.model === modelName ? 'active' : ''}`}
                        onClick={() => updateMember(m.id, { model: modelName })}
                      >
                        {modelName}
                      </button>
                    ))}
                    {m.provider === 'opencode' && (
                      <span className="label" title={opencodeModelNote}>
                        {opencodeModelState === 'loading' ? 'Loading models' : opencodeModelNote}
                      </span>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <div
            className="toggle-row"
            onClick={() => !inFlight && setRunAfterCreate(!runAfterCreate)}
            style={inFlight ? ({ opacity: 0.6, pointerEvents: 'none' } as CSSProperties) : undefined}
          >
            <div className={`toggle ${runAfterCreate ? 'on' : ''}`} />
            <div className="toggle-label-block" style={{ flex: 1 }}>
              <div className="ti">Run team after create</div>
              <div className="sub">Boots the team immediately via local CLI runtimes.</div>
            </div>
          </div>

          <div className="field">
            <label>Project</label>
            <div className="project-picker">
              <div className="tab-pills">
                <button
                  type="button"
                  className={`tab-pill ${projectMode === 'list' ? 'active' : ''}`}
                  onClick={() => setProjectMode('list')}
                  disabled={inFlight}
                >
                  From list
                </button>
                <button
                  type="button"
                  className={`tab-pill ${projectMode === 'custom' ? 'active' : ''}`}
                  onClick={() => setProjectMode('custom')}
                  disabled={inFlight}
                >
                  Custom path
                </button>
              </div>
              <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Icon name="folder" size={14} style={{ color: 'var(--fg-muted)' }} />
                {projectMode === 'list' ? (
                  <select
                    className="field-input"
                    value={project}
                    onChange={(e) => setProject(e.target.value)}
                    style={{ flex: 1 }}
                    disabled={inFlight}
                  >
                    {recentProjects.length === 0 && (
                      <option value="" disabled>
                        No projects yet — open a folder first
                      </option>
                    )}
                    {recentProjects.map((p) => (
                      <option key={p.id} value={p.path}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="field-input mono"
                    placeholder="C:\\Users\\…\\my-project"
                    style={{ flex: 1 }}
                    value={customPath}
                    onChange={(e) => setCustomPath(e.target.value)}
                    disabled={inFlight}
                  />
                )}
              </div>
            </div>
          </div>

          <div className={`collapser ${advancedOpen ? 'open' : ''}`}>
            <div className="collapser-head" onClick={() => setAdvancedOpen(!advancedOpen)}>
              <div className="icon-circle"><Icon name="settings" size={13} /></div>
              <div style={{ flex: 1 }}>
                <div className="collapser-title">
                  Launch settings
                  <span className="badge">Optional</span>
                </div>
                <div className="collapser-sub">
                  Prompt, model, effort, safety. {advancedOpen ? '' : `· ${leadModel} · ${effort} · auto-approve ${autoApprove ? 'on' : 'off'}`}
                </div>
              </div>
              <Icon name="chevronDown" size={14} className="chev" />
            </div>
            <div className="collapser-body">
              <div className="field">
                <label>Lead prompt</label>
                <textarea
                  className="field-input"
                  rows={3}
                  placeholder="Instructions for the team lead during provisioning…"
                  style={{ resize: 'vertical', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                  value={leadPrompt}
                  onChange={(e) => setLeadPrompt(e.target.value)}
                  disabled={inFlight}
                />
                <div className="field-hint">When set, this prompt is also captured as the team's first task (T-001) so the lead has something to pick up on launch.</div>
              </div>

              <div className="field-row">
                <div className="field">
                  <label>Default model</label>
                  <div className="model-strip" style={{ margin: 0 }}>
                    {runtimeProviders.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`model-pill ${leadProvider === p.id ? 'active' : ''}`}
                        onClick={() => {
                          setLeadProvider(p.id);
                          setLeadModel(p.id === 'opencode' ? 'Default' : (p.models[1] ?? p.models[0] ?? 'Default'));
                        }}
                      >
                        <span className={`provider-glyph ${p.id}`} style={{ marginRight: 4 }} />
                        {p.label}
                      </button>
                    ))}
                    <span style={{ width: 1, background: 'var(--border-soft)', alignSelf: 'stretch', margin: '0 4px' }} />
                    {(runtimeProviders.find((p) => p.id === leadProvider)?.models ?? []).map((mm) => (
                      <button
                        key={mm}
                        type="button"
                        className={`model-pill ${leadModel === mm ? 'active' : ''}`}
                        onClick={() => setLeadModel(mm)}
                      >
                        {mm}
                      </button>
                    ))}
                    {leadProvider === 'opencode' && (
                      <span className="label" title={opencodeModelNote}>
                        {opencodeModelState === 'loading' ? 'Loading models' : opencodeModelNote}
                      </span>
                    )}
                  </div>
                </div>
              </div>

              <div className="field">
                <label>Effort level</label>
                <div className="seg">
                  {(['default', 'low', 'medium', 'high'] as EffortLevel[]).map((e) => (
                    <button
                      key={e}
                      type="button"
                      className={effort === e ? 'active' : ''}
                      onClick={() => setEffort(e)}
                      disabled={inFlight}
                    >
                      {e[0].toUpperCase() + e.slice(1)}
                    </button>
                  ))}
                </div>
                <div className="field-hint">How much reasoning the team invests before responding.</div>
              </div>

              <div
                className="toggle-row"
                onClick={() => !inFlight && setAutoApprove(!autoApprove)}
                style={inFlight ? ({ opacity: 0.6, pointerEvents: 'none' } as CSSProperties) : undefined}
              >
                <div className={`toggle ${autoApprove ? 'on' : ''}`} />
                <div className="toggle-label-block" style={{ flex: 1 }}>
                  <div className="ti" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    Auto-approve all tools
                    <span
                      className="chip"
                      style={{
                        background: 'oklch(0.65 0.20 25 / 0.12)',
                        color: 'oklch(0.78 0.20 25)',
                        borderColor: 'oklch(0.65 0.20 25 / 0.3)',
                      }}
                    >
                      autonomous
                    </span>
                  </div>
                  <div className="sub">All tools execute without confirmation. Use with trusted code only.</div>
                </div>
              </div>
            </div>
          </div>

          <div className={`collapser ${validationOpen ? 'open' : ''}`}>
            <div className="collapser-head" onClick={() => setValidationOpen(!validationOpen)}>
              <div className="icon-circle"><Icon name="check" size={13} /></div>
              <div style={{ flex: 1 }}>
                <div className="collapser-title">
                  Validation commands
                  <span className="badge">Optional</span>
                </div>
                <div className="collapser-sub">
                  Default install / lint / typecheck / test / build / security commands. New tasks pre-fill from these unless you override per-task.
                </div>
              </div>
              <Icon name="chevronDown" size={14} className="chev" />
            </div>
            <div className="collapser-body">
              {(
                [
                  { label: 'Install', placeholder: 'pnpm install', value: validationInstall, set: setValidationInstall },
                  { label: 'Lint', placeholder: 'pnpm lint', value: validationLint, set: setValidationLint },
                  { label: 'Typecheck', placeholder: 'pnpm tsc --noEmit', value: validationTypecheck, set: setValidationTypecheck },
                  { label: 'Test', placeholder: 'pnpm test', value: validationTest, set: setValidationTest },
                  { label: 'Build', placeholder: 'pnpm build', value: validationBuild, set: setValidationBuild },
                  { label: 'Security', placeholder: 'pnpm audit --prod', value: validationSecurity, set: setValidationSecurity },
                ] as const
              ).map((row) => (
                <div className="field" key={row.label}>
                  <label>{row.label}</label>
                  <input
                    className="field-input mono"
                    value={row.value}
                    onChange={(e) => row.set(e.target.value)}
                    placeholder={row.placeholder}
                    disabled={inFlight}
                    style={{ fontSize: 12 }}
                  />
                </div>
              ))}
              <div className="field-hint">
                Each populated command becomes a runnable validation step on every task this team picks up. Leave blank to skip that step.
              </div>
            </div>
          </div>

          <div className={`collapser ${detailsOpen ? 'open' : ''}`}>
            <div className="collapser-head" onClick={() => setDetailsOpen(!detailsOpen)}>
              <div className="icon-circle"><Icon name="info" size={13} /></div>
              <div style={{ flex: 1 }}>
                <div className="collapser-title">
                  Team details
                  <span className="badge">Optional</span>
                </div>
                <div className="collapser-sub">Description, color, default workflow templates.</div>
              </div>
              <Icon name="chevronDown" size={14} className="chev" />
            </div>
            <div className="collapser-body">
              <div className="field">
                <label>Description</label>
                <input
                  className="field-input"
                  placeholder="What this team is for…"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={inFlight}
                />
              </div>
            </div>
          </div>

          {submit.kind === 'error' && (
            <div
              style={{
                marginTop: 12,
                padding: '8px 10px',
                background: 'oklch(0.30 0.08 25 / 0.4)',
                border: '1px solid oklch(0.55 0.18 25 / 0.4)',
                borderRadius: 6,
                color: 'oklch(0.85 0.10 25)',
                fontSize: 12,
              }}
            >
              {submit.message}
            </div>
          )}
          {submit.kind === 'done' && (
            <div
              style={{
                marginTop: 12,
                padding: '8px 10px',
                background: 'oklch(0.30 0.08 145 / 0.4)',
                border: '1px solid oklch(0.55 0.18 145 / 0.4)',
                borderRadius: 6,
                color: 'oklch(0.85 0.10 145)',
                fontSize: 12,
              }}
            >
              <Icon name="check" size={11} /> Team {submit.teamId} created{runAfterCreate ? ' and launched' : ''}.
            </div>
          )}
        </div>

        <div className="modal-foot">
          <div style={{ fontSize: 11.5, color: 'var(--fg-dim)' }}>
            <span className="kbd">Esc</span> to cancel
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose} disabled={inFlight}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleSubmit}
              disabled={inFlight || submit.kind === 'done'}
            >
              {submit.kind === 'creating' && <>Creating {providerBrand(leadProvider)} team…</>}
              {submit.kind === 'launching' && <>Launching {providerBrand(leadProvider)}…</>}
              {submit.kind === 'done' && <><Icon name="check" size={11} /> Done</>}
              {(submit.kind === 'idle' || submit.kind === 'error') && (
                <><Icon name="play" size={11} /> {runAfterCreate ? 'Create & launch' : 'Create team'}</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
