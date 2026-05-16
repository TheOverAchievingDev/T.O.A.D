import { useMemo, useState } from 'react';
import { Icon } from './Icon';
import { findingTier } from './findingTier';
import type { DriftFinding, DriftRunResult } from '@/hooks/useDrift';
import { CorrectionTaskModal, type DriftFindingForModal } from './CorrectionTaskModal';

interface DriftScreenProps {
  /** The team this drift run reports on. Used only for the empty-state
   *  message when no team is active; the actual data comes from the
   *  parent's lifted useDrift hook (App.tsx). */
  teamId: string | null;
  /** Drift state lifted up to App.tsx so Workspace + TasksScreen +
   *  DriftScreen all share one polling loop. */
  data: DriftRunResult | null;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  onOpenTask?: (taskId: string) => void;
}

const SEVERITY_ORDER: Record<DriftFinding['severity'], number> = {
  critical: 4, high: 3, medium: 2, low: 1, info: 0, observer: -1,
};
const SEVERITY_COLOR: Record<DriftFinding['severity'], string> = {
  critical: 'var(--err, #f87171)',
  high:     'var(--err, #f87171)',
  medium:   'var(--warn, #ffcd66)',
  low:      'var(--ok, #4ade80)',
  info:     'var(--fg-dim)',
  observer: 'var(--accent, #7aa2f7)',
};
const STATUS_COLOR: Record<string, string> = {
  healthy:  'var(--ok, #4ade80)',
  watch:    'var(--warn, #ffcd66)',
  warning:  'var(--warn, #ffcd66)',
  critical: 'var(--err, #f87171)',
};
const CATEGORY_LABEL: Record<string, string> = {
  architecture: 'Architecture',
  checklist:    'Checklist',
  slice_scope:  'Slice Scope',
  test_truth:   'Test Truth',
  risk:         'Risk',
};

export function DriftScreen({ teamId, data, loading, error, refresh, onOpenTask }: DriftScreenProps) {
  const [filterCategory, setFilterCategory] = useState<string>('all');
  const [filterSeverity, setFilterSeverity] = useState<string>('all');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedFindingIds, setSelectedFindingIds] = useState<Set<string>>(new Set());
  const [modalOpen, setModalOpen] = useState(false);
  const [hideRemediated, setHideRemediated] = useState(false);

  const toggleFinding = (id: string) => {
    setSelectedFindingIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sortedFindings = useMemo(() => {
    if (!data) return [];
    return [...data.findings].sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
  }, [data]);

  const filtered = useMemo(() => sortedFindings.filter((f) =>
    (filterCategory === 'all' || f.category === filterCategory) &&
    (filterSeverity === 'all' || f.severity === filterSeverity) &&
    (!hideRemediated || !f.correctionTaskId)
  ), [sortedFindings, filterCategory, filterSeverity, hideRemediated]);

  const topFindings = sortedFindings.slice(0, 4);

  if (!teamId) {
    return <div className="empty-state" style={{ padding: 24 }}>Select a team to view drift.</div>;
  }
  if (loading && !data) {
    return <div className="empty-state" style={{ padding: 24 }}>Computing drift…</div>;
  }
  if (error) {
    return <div className="empty-state" style={{ padding: 24, color: 'var(--err)' }}>Drift fetch failed: {error}</div>;
  }
  if (!data) return null;

  const peak = data.history.length ? Math.max(...data.history.map((h) => h.teamScore)) : data.teamScore;

  return (
    <div className="screen-pad" style={{ padding: 24 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h1 style={{ margin: 0, fontSize: 18, fontWeight: 600 }}>Drift Monitor</h1>
        <button className="btn" onClick={() => void refresh()}>
          <Icon name="refresh" size={12} /> Run check
        </button>
      </div>

      {data.llm && typeof data.llm.tier2 === 'object' && data.llm.tier2.failed && (
        <div style={{
          padding: '10px 14px', marginBottom: 16,
          background: 'rgba(255, 205, 102, 0.08)',
          border: '1px solid var(--warn, #ffcd66)',
          borderRadius: 6, fontSize: 12, color: 'var(--fg-muted)',
        }}>
          ⚠️ Deep-scan unavailable — {data.llm.tier2.failed}. Showing tier-1 findings only.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 16, marginBottom: 16 }}>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Team drift
          </div>
          <div style={{ fontSize: 36, fontWeight: 700, color: STATUS_COLOR[data.status], margin: '8px 0' }}>
            {data.teamScore}%
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: STATUS_COLOR[data.status] }} />
            <span style={{ textTransform: 'capitalize', fontSize: 12 }}>{data.status}</span>
          </div>
        </div>
        <div className="card" style={{ padding: 16 }}>
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 6 }}>
            Last {data.history.length} runs · peak {peak}% · current {data.teamScore}%
          </div>
          <Sparkline points={data.history.map((h) => h.teamScore)} />
        </div>
      </div>

      <div className="card" style={{ padding: 16, marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 12 }}>Category breakdown</div>
        {Object.entries(data.categoryScores).map(([cat, score]) => (
          <div key={cat} style={{ display: 'grid', gridTemplateColumns: '120px 1fr 50px', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 11 }}>{CATEGORY_LABEL[cat] ?? cat}</span>
            <div style={{ height: 8, background: 'rgba(255,255,255,0.06)', borderRadius: 4, overflow: 'hidden' }}>
              <div style={{
                width: `${score}%`, height: '100%',
                background: score >= 80 ? STATUS_COLOR.healthy : score >= 60 ? STATUS_COLOR.watch : STATUS_COLOR.critical,
              }} />
            </div>
            <span style={{ fontSize: 11, textAlign: 'right' }}>{score}%</span>
          </div>
        ))}
      </div>

      {topFindings.length > 0 && (
        <div className="card" style={{ padding: 16, marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>Top drift sources</div>
          {topFindings.map((f) => (
            <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '6px 0' }}>
              <span style={{
                fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                background: SEVERITY_COLOR[f.severity], color: '#000',
                textTransform: 'uppercase',
              }}>
                {f.severity}
              </span>
              <span>{f.title}</span>
              {f.taskId && (
                <span style={{ color: 'var(--fg-dim)', fontSize: 11 }}>· {f.taskId}</span>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ padding: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ fontSize: 12, fontWeight: 600 }}>All findings ({sortedFindings.length})</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <select value={filterCategory} onChange={(e) => setFilterCategory(e.target.value)} className="field-input mono" style={{ fontSize: 11, padding: '4px 6px' }}>
              <option value="all">All categories</option>
              {Object.keys(CATEGORY_LABEL).map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
            </select>
            <select value={filterSeverity} onChange={(e) => setFilterSeverity(e.target.value)} className="field-input mono" style={{ fontSize: 11, padding: '4px 6px' }}>
              <option value="all">All severities</option>
              {(['critical', 'high', 'medium', 'low', 'info', 'observer'] as const).map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 12,
          padding: '8px 12px',
          background: 'rgba(255,255,255,0.02)',
          border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
          borderRadius: 6,
          marginBottom: 12,
        }}>
          <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
            Selected: {selectedFindingIds.size}
          </span>
          <button
            className="btn btn-sm"
            onClick={() => setModalOpen(true)}
            disabled={selectedFindingIds.size === 0}
          >
            Create correction task
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, marginLeft: 'auto' }}>
            <input
              type="checkbox"
              checked={hideRemediated}
              onChange={(e) => setHideRemediated(e.target.checked)}
            />
            Hide remediated findings
          </label>
        </div>
        {filtered.length === 0 && (
          <div style={{ fontSize: 11, color: 'var(--fg-dim)', padding: 8 }}>No findings match this filter.</div>
        )}
        {filtered.map((f) => {
          const open = expanded.has(f.id);
          const isRemediated = Boolean(f.correctionTaskId);
          return (
            <div key={f.id} style={{
              border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
              borderRadius: 6, padding: 12, marginBottom: 8,
              opacity: isRemediated ? 0.55 : 1,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={selectedFindingIds.has(f.id)}
                  onChange={(e) => { e.stopPropagation(); toggleFinding(f.id); }}
                  disabled={isRemediated}
                  style={{ flex: 'none' }}
                />
                <div
                  onClick={() => setExpanded((s) => {
                    const next = new Set(s);
                    if (next.has(f.id)) next.delete(f.id); else next.add(f.id);
                    return next;
                  })}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1 }}
                >
                  <span style={{
                    fontSize: 9, fontWeight: 700, padding: '2px 6px', borderRadius: 3,
                    background: SEVERITY_COLOR[f.severity], color: '#000',
                    textTransform: 'uppercase',
                  }}>
                    {f.severity}
                  </span>
                  {(() => {
                    const tier = findingTier(f.checkName);
                    if (tier === 'llm') {
                      return (
                        <span style={{
                          fontSize: 9, padding: '2px 6px', borderRadius: 3,
                          background: 'rgba(255,255,255,0.06)',
                          color: 'var(--fg-muted)', textTransform: 'uppercase',
                          letterSpacing: '0.04em', fontWeight: 600,
                        }}>AI</span>
                      );
                    }
                    return null;
                  })()}
                  {f.kind && (
                    <span
                      title={f.kind === 'conformance'
                        ? 'Conformance — did the agents follow the right process?'
                        : 'Drift — does the code match the spec?'}
                      style={{
                        fontSize: 9, padding: '2px 6px', borderRadius: 3,
                        background: f.kind === 'conformance'
                          ? 'rgba(255,255,255,0.06)'
                          : 'rgba(217, 119, 87, 0.16)',
                        color: f.kind === 'conformance'
                          ? 'var(--fg-muted)'
                          : 'var(--clay, #d97757)',
                        textTransform: 'uppercase', letterSpacing: '0.04em',
                        fontWeight: 600,
                      }}
                    >
                      {f.kind === 'conformance' ? 'Conformance' : 'Drift'}
                    </span>
                  )}
                  <span style={{ fontWeight: 600, fontSize: 12, flex: 1 }}>{f.title}</span>
                  {isRemediated && (
                    <span
                      style={{
                        fontSize: 9, padding: '2px 6px', borderRadius: 3,
                        background: 'rgba(74, 222, 128, 0.12)',
                        color: 'var(--ok, #4ade80)',
                        textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600,
                      }}
                      title="This finding has a correction task in flight."
                    >
                      Correction in progress
                    </span>
                  )}
                  <span style={{ color: 'var(--fg-dim)', fontSize: 10 }}>
                    {CATEGORY_LABEL[f.category] ?? f.category}
                    {f.taskId && (
                      <>
                        {' · '}
                        <span
                          onClick={(e) => { e.stopPropagation(); if (f.taskId) onOpenTask?.(f.taskId); }}
                          style={{ textDecoration: 'underline', cursor: 'pointer' }}
                        >
                          {f.taskId}
                        </span>
                      </>
                    )}
                    {f.correctionTaskId && (
                      <>
                        {' · '}
                        <span
                          onClick={(e) => { e.stopPropagation(); if (f.correctionTaskId) onOpenTask?.(f.correctionTaskId); }}
                          style={{ textDecoration: 'underline', cursor: 'pointer' }}
                          title="Open correction task"
                        >
                          {f.correctionTaskId}
                        </span>
                      </>
                    )}
                  </span>
                </div>
              </div>
              {open && (
                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--fg-muted)' }}>
                  <div><strong>Expected:</strong> {f.expected}</div>
                  <div><strong>Actual:</strong> {f.actual}</div>
                  <div><strong>Evidence:</strong>
                    <ul style={{ margin: '4px 0 4px 16px' }}>
                      {f.evidence.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  </div>
                  <div><strong>Recommended:</strong> {f.recommendedCorrection}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {modalOpen && teamId && (
        <CorrectionTaskModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          selectedFindings={
            Array.from(selectedFindingIds)
              .map((id) => sortedFindings.find((f) => f.id === id))
              .filter((f): f is DriftFinding => Boolean(f))
              .map((f) => ({
                id: f.id,
                taskId: f.taskId,
                category: f.category,
                severity: f.severity,
                title: f.title,
                expected: f.expected,
                actual: f.actual,
                recommendedCorrection: f.recommendedCorrection,
              }))
          }
          teamId={teamId}
          onCreated={() => {
            setSelectedFindingIds(new Set());
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length === 0) return <div style={{ fontSize: 10, color: 'var(--fg-dim)' }}>No history yet</div>;
  const w = 200, h = 32;
  const max = Math.max(1, ...points);
  const step = points.length > 1 ? w / (points.length - 1) : 0;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${i * step} ${h - (p / max) * h}`).join(' ');
  return (
    <svg width={w} height={h} style={{ display: 'block' }}>
      <path d={path} fill="none" stroke="var(--clay, #d97757)" strokeWidth={1.5} />
    </svg>
  );
}
