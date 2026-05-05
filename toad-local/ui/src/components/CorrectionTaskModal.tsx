import { useEffect, useMemo, useState } from 'react';
import { callTool as callToadApi } from '@/api/client';

export interface DriftFindingForModal {
  id: string;
  taskId: string | null;
  category: string;
  severity: 'low' | 'medium' | 'high' | 'critical' | 'info';
  title: string;
  expected: string;
  actual: string;
  recommendedCorrection: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  selectedFindings: DriftFindingForModal[];
  teamId: string;
  onCreated: (result: { taskId: string }) => void;
}

const SEVERITY_TO_RISK: Record<string, 'low' | 'medium' | 'high'> = {
  critical: 'high',
  high: 'high',
  medium: 'medium',
  low: 'low',
  info: 'low',
};

function inferRiskLevel(findings: DriftFindingForModal[]): 'low' | 'medium' | 'high' {
  let max: 'low' | 'medium' | 'high' = 'low';
  for (const f of findings) {
    const r = SEVERITY_TO_RISK[f.severity] ?? 'low';
    if (r === 'high') return 'high';
    if (r === 'medium') max = 'medium';
  }
  return max;
}

function buildDescription(findings: DriftFindingForModal[]): string {
  const parts: string[] = ['# Drift findings to address', ''];
  findings.forEach((f, i) => {
    parts.push(`## ${i + 1}. ${f.title}`);
    parts.push(`- **Category:** ${f.category}`);
    parts.push(`- **Severity:** ${f.severity}`);
    if (f.taskId) parts.push(`- **Task:** ${f.taskId}`);
    parts.push(`- **Expected:** ${f.expected}`);
    parts.push(`- **Actual:** ${f.actual}`);
    parts.push(`- **Recommended correction:** ${f.recommendedCorrection}`);
    parts.push('');
  });
  return parts.join('\n');
}

export function CorrectionTaskModal({ open, onClose, selectedFindings, teamId, onCreated }: Props) {
  const initialSubject = useMemo(
    () => selectedFindings.length === 1
      ? selectedFindings[0].title
      : `Drift correction (${selectedFindings.length} findings)`,
    [selectedFindings],
  );
  const initialDescription = useMemo(() => buildDescription(selectedFindings), [selectedFindings]);
  const initialRisk = useMemo(() => inferRiskLevel(selectedFindings), [selectedFindings]);

  const [subject, setSubject] = useState(initialSubject);
  const [description, setDescription] = useState(initialDescription);
  const [riskLevel, setRiskLevel] = useState<'low' | 'medium' | 'high'>(initialRisk);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset when the selection changes.
  useEffect(() => {
    setSubject(initialSubject);
    setDescription(initialDescription);
    setRiskLevel(initialRisk);
    setError(null);
  }, [initialSubject, initialDescription, initialRisk]);

  if (!open) return null;

  const submitDisabled = submitting || subject.trim().length === 0 || selectedFindings.length === 0;

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const findingIds = selectedFindings.map((f) => f.id);
      const result = await callToadApi({
        actor: { teamId, agentId: 'ui-client', role: 'human' },
        method: 'drift_correction_create',
        args: { findingIds, subject: subject.trim(), description, riskLevel, teamId },
        idempotencyKey: `drift-correction-${teamId}-${Date.now()}-${findingIds[0]}`,
      }) as { taskId: string };
      onCreated(result);
      onClose();
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        style={{
          background: 'var(--bg, #1a1a1a)', border: '1px solid var(--border-soft, rgba(255,255,255,0.1))',
          borderRadius: 8, padding: 20, width: 600, maxHeight: '80vh', overflow: 'auto',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: 0, marginBottom: 12, fontSize: 14 }}>
          Create correction task ({selectedFindings.length} {selectedFindings.length === 1 ? 'finding' : 'findings'})
        </h3>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>Subject</div>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={submitting}
            style={{ width: '100%', padding: '6px 8px', fontSize: 12 }}
          />
        </label>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>Description</div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={submitting}
            rows={12}
            style={{ width: '100%', padding: '6px 8px', fontSize: 11, fontFamily: 'monospace', resize: 'vertical' }}
          />
        </label>

        <label style={{ display: 'block', marginBottom: 12 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 4 }}>Risk level</div>
          <select
            value={riskLevel}
            onChange={(e) => setRiskLevel(e.target.value as 'low' | 'medium' | 'high')}
            disabled={submitting}
            style={{ padding: '4px 8px', fontSize: 12 }}
          >
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </label>

        {error && (
          <div style={{ fontSize: 11, color: 'var(--err, #f87171)', marginBottom: 12 }}>{error}</div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn btn-sm" onClick={onClose} disabled={submitting}>Cancel</button>
          <button
            className="btn btn-sm"
            onClick={() => void submit()}
            disabled={submitDisabled}
          >
            {submitting ? 'Creating…' : 'Create correction task'}
          </button>
        </div>
      </div>
    </div>
  );
}
