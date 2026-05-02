import { useEffect, useMemo, useState } from 'react';
import type { Team, UiTask } from '@/types';
import { Icon } from './Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';

export type AssignedRole = 'lead' | 'architect' | 'developer' | 'reviewer' | 'tester' | 'human';
export type TaskPriority = 'low' | 'medium' | 'high' | 'urgent';
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

const ASSIGNED_ROLES: AssignedRole[] = ['lead', 'architect', 'developer', 'reviewer', 'tester', 'human'];
const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high', 'urgent'];
const RISK_LEVELS: RiskLevel[] = ['low', 'medium', 'high', 'critical'];

const DEFAULT_ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'creating' }
  | { kind: 'done'; taskId: string }
  | { kind: 'error'; message: string };

interface TaskCreationModalProps {
  team: Team;
  existingTasks: UiTask[];
  onClose: () => void;
  onCreated?: (taskId: string) => void;
  /** Optional default base branch — if omitted, uses team.branch. */
  defaultBaseBranch?: string;
  actor?: Actor;
}

function suggestNextTaskId(existing: UiTask[]): string {
  const numericIds = existing
    .map((t) => /^T-(\d+)/.exec(t.id))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number.parseInt(m[1], 10))
    .filter((n) => Number.isFinite(n));
  const next = numericIds.length === 0 ? 1 : Math.max(...numericIds) + 1;
  return `T-${String(next).padStart(3, '0')}`;
}

/** Tiny chip-list editor: comma- or enter-separated entries with delete. */
function ChipList({
  label, values, onChange, placeholder, hint, disabled,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  hint?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');
  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (values.includes(trimmed)) { setDraft(''); return; }
    onChange([...values, trimmed]);
    setDraft('');
  };
  return (
    <div className="field">
      <label>{label}</label>
      <div style={{
        display: 'flex', flexWrap: 'wrap', gap: 4,
        padding: '6px 8px',
        border: '1px solid var(--border-soft, rgba(255,255,255,0.08))',
        borderRadius: 6,
        background: 'var(--bg-input, rgba(0,0,0,0.2))',
        minHeight: 32,
        alignItems: 'center',
      }}>
        {values.map((v) => (
          <span key={v} className="chip mono" style={{ fontSize: 11, padding: '2px 4px 2px 6px', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            {v}
            <button
              type="button"
              className="icon-btn"
              style={{ width: 14, height: 14 }}
              onClick={() => onChange(values.filter((x) => x !== v))}
              disabled={disabled}
              aria-label={`remove ${v}`}
            >
              <Icon name="x" size={9} />
            </button>
          </span>
        ))}
        <input
          className="mono"
          style={{ flex: 1, minWidth: 80, background: 'transparent', border: 0, outline: 0, color: 'var(--fg)', fontSize: 12 }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Backspace' && draft === '' && values.length > 0) {
              e.preventDefault();
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={commit}
          placeholder={values.length === 0 ? placeholder : ''}
          disabled={disabled}
        />
      </div>
      {hint && <div className="field-hint">{hint}</div>}
    </div>
  );
}

export function TaskCreationModal({
  team, existingTasks, onClose, onCreated, defaultBaseBranch, actor = DEFAULT_ACTOR,
}: TaskCreationModalProps) {
  const suggestedId = useMemo(() => suggestNextTaskId(existingTasks), [existingTasks]);

  const [taskId, setTaskId] = useState(suggestedId);
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [assignedRole, setAssignedRole] = useState<AssignedRole>('developer');
  const [priority, setPriority] = useState<TaskPriority>('medium');
  const [baseBranch, setBaseBranch] = useState(defaultBaseBranch ?? team.branch ?? 'main');

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [allowedFiles, setAllowedFiles] = useState<string[]>([]);
  const [forbiddenFiles, setForbiddenFiles] = useState<string[]>([]);
  const [acceptanceCriteria, setAcceptanceCriteria] = useState<string[]>([]);
  const [testCommands, setTestCommands] = useState<string[]>([]);
  const [expectedDeliverables, setExpectedDeliverables] = useState<string[]>([]);
  const [dependencyTaskIds, setDependencyTaskIds] = useState<string[]>([]);
  const [riskLevel, setRiskLevel] = useState<RiskLevel | ''>('');
  const [requiresHumanApproval, setRequiresHumanApproval] = useState(false);

  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });

  // If the suggested ID changes (e.g. tasks updated), refresh only when the
  // user hasn't edited the field yet.
  useEffect(() => {
    setTaskId((prev) => (prev === '' ? suggestedId : prev));
  }, [suggestedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && submit.kind !== 'creating') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submit.kind]);

  const inFlight = submit.kind === 'creating';
  const canSubmit = !!taskId.trim() && !!subject.trim() && !inFlight;

  async function handleSubmit() {
    if (!taskId.trim()) {
      setSubmit({ kind: 'error', message: 'Task ID is required.' });
      return;
    }
    if (!subject.trim()) {
      setSubmit({ kind: 'error', message: 'Title is required.' });
      return;
    }

    const args: Record<string, unknown> = {
      taskId: taskId.trim(),
      subject: subject.trim(),
      assignedRole,
      priority,
    };
    if (description.trim()) args.description = description.trim();
    if (baseBranch.trim()) args.baseBranch = baseBranch.trim();
    if (allowedFiles.length) args.allowedFiles = allowedFiles;
    if (forbiddenFiles.length) args.forbiddenFiles = forbiddenFiles;
    if (acceptanceCriteria.length) args.acceptanceCriteria = acceptanceCriteria;
    if (testCommands.length) args.testCommands = testCommands;
    if (expectedDeliverables.length) args.expectedDeliverables = expectedDeliverables;
    if (dependencyTaskIds.length) args.dependencyTaskIds = dependencyTaskIds;
    if (riskLevel) args.riskLevel = riskLevel;
    if (requiresHumanApproval) args.requiresHumanApproval = true;

    try {
      setSubmit({ kind: 'creating' });
      await callTool({
        actor,
        method: 'task_create',
        args,
        idempotencyKey: `task-create-${taskId.trim()}-${Date.now()}`,
      });
      setSubmit({ kind: 'done', taskId: taskId.trim() });
      onCreated?.(taskId.trim());
      setTimeout(onClose, 600);
    } catch (err) {
      const message = err instanceof ToadApiError ? err.message
        : err instanceof Error ? err.message
        : 'Unknown error';
      setSubmit({ kind: 'error', message });
    }
  }

  return (
    <div className="modal-backdrop" onClick={inFlight ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div>
            <h2>New task</h2>
            <div className="sub">Add a task to {team.name}'s board.</div>
          </div>
          <button className="icon-btn" onClick={onClose} disabled={inFlight} type="button">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="field-row" style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 12 }}>
            <div className="field">
              <label>Task ID</label>
              <input
                className="field-input mono"
                value={taskId}
                onChange={(e) => setTaskId(e.target.value)}
                placeholder="T-001"
                disabled={inFlight}
              />
            </div>
            <div className="field">
              <label>Title</label>
              <input
                className="field-input"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="What needs doing?"
                autoFocus
                disabled={inFlight}
              />
            </div>
          </div>

          <div className="field">
            <label>Description</label>
            <textarea
              className="field-input"
              rows={4}
              placeholder="Goal, context, constraints, links to relevant code…"
              style={{ resize: 'vertical', fontSize: 12 }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={inFlight}
            />
          </div>

          <div className="field-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <div className="field">
              <label>Role</label>
              <select
                className="field-input"
                value={assignedRole}
                onChange={(e) => setAssignedRole(e.target.value as AssignedRole)}
                disabled={inFlight}
              >
                {ASSIGNED_ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Priority</label>
              <div className="seg">
                {PRIORITIES.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={priority === p ? 'active' : ''}
                    onClick={() => setPriority(p)}
                    disabled={inFlight}
                  >
                    {p[0].toUpperCase() + p.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>Base branch</label>
              <input
                className="field-input mono"
                value={baseBranch}
                onChange={(e) => setBaseBranch(e.target.value)}
                placeholder="main"
                disabled={inFlight}
              />
            </div>
          </div>

          <div className={`collapser ${advancedOpen ? 'open' : ''}`}>
            <div className="collapser-head" onClick={() => setAdvancedOpen(!advancedOpen)}>
              <div className="icon-circle"><Icon name="settings" size={13} /></div>
              <div style={{ flex: 1 }}>
                <div className="collapser-title">
                  Scope, risk &amp; validation
                  <span className="badge">Optional</span>
                </div>
                <div className="collapser-sub">
                  Files, acceptance criteria, test commands, risk classification, dependencies.
                </div>
              </div>
              <Icon name="chevronDown" size={14} className="chev" />
            </div>
            <div className="collapser-body">
              <ChipList
                label="Allowed files"
                values={allowedFiles}
                onChange={setAllowedFiles}
                placeholder="e.g. src/audio/**, tests/audio/**"
                hint="Glob patterns. Edits outside this list trip the §14 scope-drift check."
                disabled={inFlight}
              />
              <ChipList
                label="Forbidden files"
                values={forbiddenFiles}
                onChange={setForbiddenFiles}
                placeholder="e.g. .env*, **/secrets/**"
                hint="Hard-rejected at review_request — agent can never touch these."
                disabled={inFlight}
              />
              <ChipList
                label="Acceptance criteria"
                values={acceptanceCriteria}
                onChange={setAcceptanceCriteria}
                placeholder="Each entry is a checklist item the reviewer must verify."
                disabled={inFlight}
              />
              <ChipList
                label="Test commands"
                values={testCommands}
                onChange={setTestCommands}
                placeholder="e.g. pnpm test stream, pnpm lint src/audio"
                hint="Each gets an entry in the Validations section of the task."
                disabled={inFlight}
              />
              <ChipList
                label="Expected deliverables"
                values={expectedDeliverables}
                onChange={setExpectedDeliverables}
                placeholder="e.g. streamTranscribe() async generator, dual-reversal guard, partial event"
                disabled={inFlight}
              />
              <ChipList
                label="Dependency tasks"
                values={dependencyTaskIds}
                onChange={setDependencyTaskIds}
                placeholder="e.g. T-001"
                hint="Task can only enter ready when listed dependencies are done."
                disabled={inFlight}
              />

              <div className="field-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <div className="field">
                  <label>Risk level</label>
                  <div className="seg">
                    <button
                      type="button"
                      className={riskLevel === '' ? 'active' : ''}
                      onClick={() => setRiskLevel('')}
                      disabled={inFlight}
                    >
                      None
                    </button>
                    {RISK_LEVELS.map((r) => (
                      <button
                        key={r}
                        type="button"
                        className={riskLevel === r ? 'active' : ''}
                        onClick={() => setRiskLevel(r)}
                        disabled={inFlight}
                      >
                        {r[0].toUpperCase() + r.slice(1)}
                      </button>
                    ))}
                  </div>
                  <div className="field-hint">
                    Auto-elevated by the §14 risk-policy classifier when the agent edits sensitive files; you can pre-set it here.
                  </div>
                </div>
                <div className="field">
                  <label>Human approval gate</label>
                  <div
                    className="toggle-row"
                    onClick={() => !inFlight && setRequiresHumanApproval(!requiresHumanApproval)}
                    style={inFlight ? { opacity: 0.6, pointerEvents: 'none' } : undefined}
                  >
                    <div className={`toggle ${requiresHumanApproval ? 'on' : ''}`} />
                    <div className="toggle-label-block" style={{ flex: 1 }}>
                      <div className="ti">Block merge until a human approves</div>
                      <div className="sub">§14 gate — required when riskLevel ≥ critical or you set this manually.</div>
                    </div>
                  </div>
                </div>
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
              <Icon name="check" size={11} /> Task {submit.taskId} created.
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
              disabled={!canSubmit || submit.kind === 'done'}
            >
              {submit.kind === 'creating' && <>Creating…</>}
              {submit.kind === 'done' && <><Icon name="check" size={11} /> Done</>}
              {(submit.kind === 'idle' || submit.kind === 'error') && (
                <><Icon name="plus" size={11} /> Create task</>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
