import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import type { RoleId, Provider } from '@/types';
import { ROLES, ROLE_KEYS, roleStyle } from '@/data/roles';
import { SEED_PROVIDERS } from '@/data/seed';
import { Icon } from './Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';

interface MemberDraft {
  id: number;
  name: string;
  role: Exclude<RoleId, 'lead'>;
  provider: string;
  model: string;
}

interface CreateTeamModalProps {
  onClose: () => void;
  onCreated?: (teamId: string) => void;
  actor?: Actor;
  providers?: Provider[];
}

type ProjectMode = 'list' | 'custom';
type EffortLevel = 'default' | 'low' | 'medium' | 'high';
type SubmitState =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'launching' }
  | { kind: 'done'; teamId: string }
  | { kind: 'error'; message: string };

const DEFAULT_ACTOR: Actor = { teamId: 'system', agentId: 'ui-client', agentName: 'ui', role: 'human' };

const RECENT_PROJECTS = ['ide-test', 'symphonyv3', 'Harmony', 'orchestrator'];

const INITIAL_MEMBERS: MemberDraft[] = [
  { id: 1, name: 'alice', role: 'reviewer', provider: 'anthropic', model: 'Default' },
  { id: 2, name: 'tom', role: 'developer', provider: 'anthropic', model: 'Default' },
  { id: 3, name: 'rex', role: 'researcher', provider: 'openai', model: '5.4' },
];

export function CreateTeamModal({
  onClose,
  onCreated,
  actor = DEFAULT_ACTOR,
  providers = SEED_PROVIDERS,
}: CreateTeamModalProps) {
  const [teamName, setTeamName] = useState('signal-ops');
  const [solo, setSolo] = useState(false);
  const [members, setMembers] = useState<MemberDraft[]>(INITIAL_MEMBERS);
  const [expandedMember, setExpandedMember] = useState<number | null>(null);
  const [runAfterCreate, setRunAfterCreate] = useState(true);
  const [autoApprove, setAutoApprove] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [projectMode, setProjectMode] = useState<ProjectMode>('list');
  const [project, setProject] = useState(RECENT_PROJECTS[0]);
  const [customPath, setCustomPath] = useState('');
  const [effort, setEffort] = useState<EffortLevel>('medium');
  const [leadProvider, setLeadProvider] = useState('anthropic');
  const [leadModel, setLeadModel] = useState('Opus 4.6');
  const [leadPrompt, setLeadPrompt] = useState('');
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
    const lead = {
      agentId: 'lead',
      role: 'lead' as const,
      providerId: leadProvider,
      prompt: leadPrompt,
      skipPermissions: autoApprove,
      ...(cwd ? { cwd } : {}),
    };
    const teammates = solo
      ? []
      : members.map((m) => ({
          agentId: m.name.trim() || `agent-${m.id}`,
          role: m.role,
          providerId: m.provider,
          skipPermissions: autoApprove,
          ...(cwd ? { cwd } : {}),
        }));

    try {
      setSubmit({ kind: 'creating' });
      await callTool({
        actor,
        method: 'team_create',
        args: { teamId, lead, teammates },
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
              <span className="provider-glyph anthropic" />
              {leadModel}
            </button>
            <span style={{ width: 24 }} />
          </div>

          {!solo && members.map((m) => {
            const expanded = expandedMember === m.id;
            const providerEntry = providers.find((p) => p.id === m.provider);
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
                    {providers.map((p) => (
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
                    {RECENT_PROJECTS.map((p) => <option key={p} value={p}>{p}</option>)}
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
                    {providers.map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        className={`model-pill ${leadProvider === p.id ? 'active' : ''}`}
                        onClick={() => {
                          setLeadProvider(p.id);
                          setLeadModel(p.models[1] ?? p.models[0] ?? 'Default');
                        }}
                      >
                        <span className={`provider-glyph ${p.id}`} style={{ marginRight: 4 }} />
                        {p.label}
                      </button>
                    ))}
                    <span style={{ width: 1, background: 'var(--border-soft)', alignSelf: 'stretch', margin: '0 4px' }} />
                    {(providers.find((p) => p.id === leadProvider)?.models ?? []).map((mm) => (
                      <button
                        key={mm}
                        type="button"
                        className={`model-pill ${leadModel === mm ? 'active' : ''}`}
                        onClick={() => setLeadModel(mm)}
                      >
                        {mm}
                      </button>
                    ))}
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
              {submit.kind === 'creating' && <>Creating…</>}
              {submit.kind === 'launching' && <>Launching…</>}
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
