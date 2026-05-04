import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';

type DiagnosticStatus = 'pass' | 'warn' | 'fail';
type DiagnosticGroup = 'Providers' | 'Runtime' | 'Storage' | 'Other';

interface DiagnosticCheck {
  id: string;
  group: DiagnosticGroup;
  label: string;
  status: DiagnosticStatus;
  evidence: string;
  fix?: string;
}

interface DiagnosticSummary {
  pass: number;
  warn: number;
  fail: number;
}

interface BackendCheck {
  id: string;
  label?: string;
  status?: 'pass' | 'warn' | 'warning' | 'fail';
  hint?: string;
  suggestedFix?: string;
  error?: string;
  // Plus arbitrary details — we serialize whatever's left as evidence text.
  [key: string]: unknown;
}

interface BackendSummary {
  pass?: number;
  warn?: number;
  warning?: number;
  fail?: number;
}

interface DiagRowProps {
  check: DiagnosticCheck;
  expanded: boolean;
  onToggle: (id: string) => void;
}

export interface DiagnosticsDrawerProps {
  onClose: () => void;
}

const ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };

/** Map a backend check-id prefix to a UI group bucket. The backend doesn't
 *  emit a group field, so we infer from the id. */
function groupForCheck(id: string): DiagnosticGroup {
  if (id.startsWith('provider_')) return 'Providers';
  if (id.startsWith('db_') || id.includes('database')) return 'Storage';
  if (
    id.startsWith('state_machine_')
    || id.startsWith('role_authority_')
    || id.includes('runtime')
    || id.includes('validation_configured')
    || id.includes('unknown_role')
  ) return 'Runtime';
  return 'Other';
}

/** Backend uses `'warning'` (singular). Normalize to the UI's `'warn'`. */
function normalizeStatus(s: BackendCheck['status']): DiagnosticStatus {
  if (s === 'pass') return 'pass';
  if (s === 'fail') return 'fail';
  return 'warn';
}

/** Pull human-readable evidence from any non-meta fields the backend
 *  attached to the check (e.g. `from`, `to`, `path`, `runtimesChecked`,
 *  `stuck`, `version`). Hint is broken out separately as the suggested
 *  fix when present. */
function evidenceFromBackend(check: BackendCheck): string {
  const skipKeys = new Set(['id', 'label', 'status', 'hint', 'suggestedFix', 'error']);
  const detail: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(check)) {
    if (skipKeys.has(key)) continue;
    detail[key] = value;
  }
  if (check.error) {
    return String(check.error);
  }
  if (Object.keys(detail).length === 0) {
    return check.hint ?? '';
  }
  return JSON.stringify(detail, null, 2);
}

function fixFromBackend(check: BackendCheck): string | undefined {
  if (typeof check.suggestedFix === 'string' && check.suggestedFix.length > 0) return check.suggestedFix;
  if (typeof check.hint === 'string' && check.hint.length > 0) return check.hint;
  return undefined;
}

function DiagRow({ check, expanded, onToggle }: DiagRowProps) {
  return (
    <div className={`diag-row diag-${check.status} ${expanded ? 'diag-row-expanded' : ''}`}>
      <button className="diag-row-head" onClick={() => onToggle(check.id)}>
        <span className={`diag-pill ${check.status}`}>
          {check.status === 'pass' && <Icon name="check" size={10} />}
          {check.status === 'warn' && '!'}
          {check.status === 'fail' && 'x'}
        </span>
        <span className="diag-label">{check.label}</span>
        <span className="mono dim diag-id">{check.id}</span>
      </button>
      {expanded && (
        <div className="diag-detail">
          {check.evidence && <div className="diag-evidence mono" style={{ whiteSpace: 'pre-wrap' }}>{check.evidence}</div>}
          {check.fix && (
            <div className="diag-fix">
              <span className="dim">Suggested fix:</span> <span className="mono">{check.fix}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function DiagnosticsDrawer({ onClose }: DiagnosticsDrawerProps) {
  const [checks, setChecks] = useState<DiagnosticCheck[]>([]);
  const [summary, setSummary] = useState<DiagnosticSummary>({ pass: 0, warn: 0, fail: 0 });
  const [running, setRunning] = useState(false);
  const [ranAt, setRanAt] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());

  const runChecks = useCallback(async () => {
    setRunning(true);
    setError(null);
    try {
      const result = await callTool<{ checks: BackendCheck[]; summary?: BackendSummary }>({
        actor: ACTOR,
        method: 'diagnostics_run',
        args: {},
      });
      const mapped: DiagnosticCheck[] = (result?.checks ?? []).map((c) => ({
        id: c.id,
        group: groupForCheck(c.id),
        label: typeof c.label === 'string' ? c.label : c.id,
        status: normalizeStatus(c.status),
        evidence: evidenceFromBackend(c),
        fix: fixFromBackend(c),
      }));
      setChecks(mapped);
      const s = result?.summary ?? {};
      setSummary({
        pass: typeof s.pass === 'number' ? s.pass : mapped.filter((c) => c.status === 'pass').length,
        warn: typeof s.warning === 'number' ? s.warning : (typeof s.warn === 'number' ? s.warn : mapped.filter((c) => c.status === 'warn').length),
        fail: typeof s.fail === 'number' ? s.fail : mapped.filter((c) => c.status === 'fail').length,
      });
      setRanAt(new Date().toLocaleTimeString());
      // Auto-expand non-passing checks so issues are visible without an extra click.
      setOpenIds(new Set(mapped.filter((c) => c.status !== 'pass').map((c) => c.id)));
    } catch (err) {
      const message = err instanceof ToadApiError
        ? err.message
        : err instanceof Error
          ? err.message
          : 'Diagnostics failed';
      setError(message);
    } finally {
      setRunning(false);
    }
  }, []);

  // Run automatically on first open so the drawer never displays stale or
  // empty state on a fresh mount.
  useEffect(() => { void runChecks(); }, [runChecks]);

  const toggle = (id: string) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const groups = useMemo(() => (
    checks.reduce<Partial<Record<DiagnosticGroup, DiagnosticCheck[]>>>((acc, check) => {
      acc[check.group] = [...(acc[check.group] ?? []), check];
      return acc;
    }, {})
  ), [checks]);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer diag-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="cpu" size={15} />
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Diagnostics</h2>
            <span className="dim mono" style={{ fontSize: 11 }}>
              {running ? 'Running…' : ranAt ? `Last run ${ranAt}` : ''}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => void runChecks()}
              disabled={running}
            >
              <Icon name="play" size={11} /> {running ? 'Running…' : 'Run again'}
            </button>
            <button className="icon-btn" onClick={onClose} type="button">
              <Icon name="x" size={14} />
            </button>
          </div>
        </div>

        {error && (
          <div
            style={{
              margin: '12px 16px 0',
              padding: '8px 12px',
              borderRadius: 6,
              background: 'oklch(0.30 0.08 25 / 0.20)',
              border: '1px solid oklch(0.55 0.15 25 / 0.30)',
              fontSize: 11.5,
              color: 'oklch(0.85 0.10 25)',
            }}
          >
            <Icon name="info" size={11} /> {error}
          </div>
        )}

        <div className="diag-summary">
          <div className="diag-summary-tile diag-pass-tile">
            <div className="mono diag-summary-num" style={{ color: 'var(--ok)' }}>{summary.pass}</div>
            <div className="diag-summary-label">passing</div>
          </div>
          <div className="diag-summary-tile diag-warn-tile">
            <div className="mono diag-summary-num" style={{ color: 'var(--warn)' }}>{summary.warn}</div>
            <div className="diag-summary-label">warnings</div>
          </div>
          <div className="diag-summary-tile diag-fail-tile">
            <div className="mono diag-summary-num" style={{ color: 'var(--err)' }}>{summary.fail}</div>
            <div className="diag-summary-label">failing</div>
          </div>
        </div>

        <div className="notif-body-scroll" style={{ padding: '0 0 12px' }}>
          {!running && checks.length === 0 && !error && (
            <div className="dim" style={{ padding: '24px 16px', fontSize: 12, textAlign: 'center' }}>
              No checks ran yet — click "Run again" to refresh.
            </div>
          )}
          {Object.entries(groups).map(([group, groupChecks]) => (
            <div key={group}>
              <div className="sticky-section-head">
                <span className="section-label">{group}</span>
                <span className="count-pill">{groupChecks!.length}</span>
              </div>
              <div style={{ padding: '4px 12px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {groupChecks!.map((check) => (
                  <DiagRow key={check.id} check={check} expanded={openIds.has(check.id)} onToggle={toggle} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
