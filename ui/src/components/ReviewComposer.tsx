import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';

export type ReviewSeverity = 'nit' | 'minor' | 'major' | 'blocking';
export type ReviewDecision = 'approved' | 'changes_requested';

const SEVERITIES: ReviewSeverity[] = ['nit', 'minor', 'major', 'blocking'];

const SEVERITY_META: Record<ReviewSeverity, { color: string; bg: string; bd: string; label: string }> = {
  nit: {
    color: 'oklch(0.70 0.05 240)', bg: 'oklch(0.30 0.04 240 / 0.4)',
    bd: 'oklch(0.50 0.06 240 / 0.30)', label: 'Nit',
  },
  minor: {
    color: 'oklch(0.78 0.10 80)', bg: 'oklch(0.78 0.10 80 / 0.14)',
    bd: 'oklch(0.78 0.10 80 / 0.30)', label: 'Minor',
  },
  major: {
    color: 'oklch(0.80 0.18 50)', bg: 'oklch(0.65 0.18 50 / 0.14)',
    bd: 'oklch(0.65 0.18 50 / 0.30)', label: 'Major',
  },
  blocking: {
    color: 'oklch(0.85 0.20 25)', bg: 'oklch(0.55 0.20 25 / 0.22)',
    bd: 'oklch(0.65 0.20 25 / 0.50)', label: 'Blocking',
  },
};

interface FeedbackItem {
  /** Stable id for React keys; not sent to backend. */
  id: string;
  file: string;
  comment: string;
  severity?: ReviewSeverity;
}

interface ReviewComposerProps {
  taskId: string;
  /** Files known to have changed in this task — populates a quick-pick datalist. */
  changedFiles?: string[];
  actor: Actor;
  /** Called after a successful review_decide call. */
  onDecided?: (decision: ReviewDecision) => void;
}

type SubmitState =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'done'; decision: ReviewDecision }
  | { kind: 'error'; message: string };

let nextLocalId = 1;
function makeFeedbackId(): string {
  return `fb_${nextLocalId++}_${Math.random().toString(36).slice(2, 6)}`;
}

export function ReviewComposer({ taskId, changedFiles = [], actor, onDecided }: ReviewComposerProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [items, setItems] = useState<FeedbackItem[]>([]);
  const [draftFile, setDraftFile] = useState('');
  const [draftComment, setDraftComment] = useState('');
  const [draftSeverity, setDraftSeverity] = useState<ReviewSeverity | ''>('');
  const [submit, setSubmit] = useState<SubmitState>({ kind: 'idle' });

  useEffect(() => {
    if (submit.kind === 'done') {
      const t = setTimeout(() => setSubmit({ kind: 'idle' }), 2000);
      return () => clearTimeout(t);
    }
  }, [submit]);

  function addItem() {
    if (!draftFile.trim() || !draftComment.trim()) return;
    setItems((prev) => [
      ...prev,
      {
        id: makeFeedbackId(),
        file: draftFile.trim(),
        comment: draftComment.trim(),
        severity: draftSeverity || undefined,
      },
    ]);
    setDraftFile('');
    setDraftComment('');
    setDraftSeverity('');
  }

  function removeItem(id: string) {
    setItems((prev) => prev.filter((x) => x.id !== id));
  }

  async function decide(decision: ReviewDecision) {
    if (submit.kind === 'submitting') return;
    if (decision === 'changes_requested' && items.length === 0 && !reason.trim()) {
      setSubmit({ kind: 'error', message: 'Add at least one feedback item or a top-level reason.' });
      return;
    }
    const feedback = items.map(({ file, comment, severity }) => {
      const entry: { file: string; comment: string; severity?: ReviewSeverity } = { file, comment };
      if (severity) entry.severity = severity;
      return entry;
    });
    const args: Record<string, unknown> = { taskId, decision };
    if (reason.trim()) args.reason = reason.trim();
    if (feedback.length) args.feedback = feedback;

    try {
      setSubmit({ kind: 'submitting' });
      await callTool({
        actor,
        method: 'review_decide',
        args,
        idempotencyKey: `review-decide-${taskId}-${decision}-${Date.now()}`,
      });
      setSubmit({ kind: 'done', decision });
      setReason('');
      setItems([]);
      onDecided?.(decision);
    } catch (err) {
      const message = err instanceof ToadApiError ? err.message
        : err instanceof Error ? err.message
        : 'Failed to record decision';
      setSubmit({ kind: 'error', message });
    }
  }

  const inFlight = submit.kind === 'submitting';

  return (
    <div
      style={{
        border: '1px solid var(--border-soft, rgba(255,255,255,0.08))',
        borderRadius: 8,
        background: 'var(--bg-panel, #1a1916)',
        marginTop: 16,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          width: '100%',
          padding: '10px 14px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'transparent',
          border: 0,
          color: 'var(--fg)',
          fontSize: 12.5,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        <Icon name="check" size={13} />
        Review decision
        <span className="dim" style={{ fontSize: 11, fontWeight: 400, marginLeft: 4 }}>
          {items.length > 0 ? `${items.length} feedback item${items.length === 1 ? '' : 's'}` : 'add feedback or approve'}
        </span>
        <Icon
          name="chevronDown"
          size={12}
          style={{ marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
        />
      </button>

      {open && (
        <div style={{ padding: '0 14px 14px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {items.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="section-label" style={{ fontSize: 10 }}>Feedback ({items.length})</div>
              {items.map((item) => {
                const meta = item.severity ? SEVERITY_META[item.severity] : null;
                return (
                  <div
                    key={item.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'auto 1fr auto',
                      alignItems: 'flex-start',
                      gap: 8,
                      padding: '6px 8px',
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid var(--border-soft, rgba(255,255,255,0.05))',
                      borderRadius: 6,
                    }}
                  >
                    {meta ? (
                      <span
                        className="chip mono"
                        style={{
                          fontSize: 10,
                          padding: '1px 5px',
                          background: meta.bg,
                          color: meta.color,
                          borderColor: meta.bd,
                          textTransform: 'uppercase',
                          letterSpacing: '0.04em',
                          fontWeight: 600,
                        }}
                      >
                        {meta.label}
                      </span>
                    ) : (
                      <span className="dim mono" style={{ fontSize: 10 }}>—</span>
                    )}
                    <div style={{ minWidth: 0 }}>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--fg)' }}>{item.file}</div>
                      <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>{item.comment}</div>
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      style={{ width: 22, height: 22 }}
                      onClick={() => removeItem(item.id)}
                      disabled={inFlight}
                      aria-label="remove feedback"
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr',
              gap: 6,
              padding: '8px',
              background: 'rgba(255,255,255,0.02)',
              border: '1px dashed var(--border-soft, rgba(255,255,255,0.08))',
              borderRadius: 6,
            }}
          >
            <div className="section-label" style={{ fontSize: 10 }}>New feedback</div>
            <input
              className="field-input mono"
              list="review-files"
              placeholder="file path (e.g. src/audio/stream.ts)"
              value={draftFile}
              onChange={(e) => setDraftFile(e.target.value)}
              disabled={inFlight}
              style={{ fontSize: 11 }}
            />
            {changedFiles.length > 0 && (
              <datalist id="review-files">
                {changedFiles.map((f) => <option key={f} value={f} />)}
              </datalist>
            )}
            <textarea
              className="field-input"
              placeholder="What's the issue or note?"
              value={draftComment}
              onChange={(e) => setDraftComment(e.target.value)}
              rows={2}
              disabled={inFlight}
              style={{ fontSize: 12, resize: 'vertical' }}
            />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span className="dim" style={{ fontSize: 11 }}>Severity:</span>
              <button
                type="button"
                className={`chip mono ${draftSeverity === '' ? 'active' : ''}`}
                style={{
                  fontSize: 10,
                  padding: '2px 6px',
                  background: draftSeverity === '' ? 'rgba(255,255,255,0.12)' : 'transparent',
                  cursor: 'pointer',
                  textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}
                onClick={() => setDraftSeverity('')}
                disabled={inFlight}
              >
                None
              </button>
              {SEVERITIES.map((s) => {
                const meta = SEVERITY_META[s];
                const isActive = draftSeverity === s;
                return (
                  <button
                    key={s}
                    type="button"
                    className="chip mono"
                    style={{
                      fontSize: 10,
                      padding: '2px 6px',
                      background: isActive ? meta.bg : 'transparent',
                      color: isActive ? meta.color : 'var(--fg-muted)',
                      borderColor: isActive ? meta.bd : 'var(--border-soft, rgba(255,255,255,0.10))',
                      cursor: 'pointer',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      fontWeight: 600,
                    }}
                    onClick={() => setDraftSeverity(s)}
                    disabled={inFlight}
                  >
                    {meta.label}
                  </button>
                );
              })}
              <button
                type="button"
                className="btn btn-sm"
                style={{ marginLeft: 'auto' }}
                onClick={addItem}
                disabled={inFlight || !draftFile.trim() || !draftComment.trim()}
              >
                <Icon name="plus" size={11} /> Add
              </button>
            </div>
          </div>

          <div className="field" style={{ margin: 0 }}>
            <label style={{ fontSize: 11 }}>Top-level reason <span className="dim" style={{ fontWeight: 400 }}>(optional)</span></label>
            <input
              className="field-input"
              placeholder="One-line summary of your decision"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              disabled={inFlight}
            />
          </div>

          {submit.kind === 'error' && (
            <div
              style={{
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
                padding: '8px 10px',
                background: 'oklch(0.30 0.08 145 / 0.4)',
                border: '1px solid oklch(0.55 0.18 145 / 0.4)',
                borderRadius: 6,
                color: 'oklch(0.85 0.10 145)',
                fontSize: 12,
              }}
            >
              <Icon name="check" size={11} /> Decision recorded — {submit.decision === 'approved' ? 'approved' : 'changes requested'}.
            </div>
          )}

          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => decide('changes_requested')}
              disabled={inFlight}
            >
              {inFlight ? 'Recording…' : 'Request changes'}
            </button>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => decide('approved')}
              disabled={inFlight}
            >
              <Icon name="check" size={11} /> {inFlight ? 'Recording…' : 'Approve'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
