import { useState } from 'react';
import { Icon } from '../Icon';
import type { ValidationData, ValidationVerdict } from './seed';

const VERDICT_META: Record<ValidationVerdict, { color: string; icon: 'check' | 'x' | null; label: string }> = {
  passed: { color: 'oklch(0.72 0.15 145)', icon: 'check', label: 'Passed' },
  failed: { color: 'oklch(0.65 0.20 25)', icon: 'x', label: 'Failed' },
  not_run: { color: 'var(--fg-dim)', icon: null, label: 'Not run' },
};

function ValidationRow({ v }: { v: ValidationData }) {
  const [open, setOpen] = useState(false);
  const meta = VERDICT_META[v.verdict];

  return (
    <div className={`val-row val-${v.verdict}`}>
      <button
        className="val-row-head"
        onClick={() => v.verdict !== 'not_run' && setOpen(!open)}
        type="button"
      >
        <span
          className="val-verdict-pill"
          style={{
            background: `color-mix(in oklch, ${meta.color} 14%, transparent)`,
            color: meta.color,
            borderColor: `color-mix(in oklch, ${meta.color} 30%, transparent)`,
          }}
        >
          {meta.icon === 'check' && <Icon name="check" size={10} />}
          {meta.icon === 'x' && '×'}
          {!meta.icon && '—'}
        </span>
        <span className="val-kind">{v.kind}</span>
        <span className="mono val-cmd">{v.cmd}</span>

        <span className="val-meta mono">
          {v.duration && <span style={{ color: 'var(--fg-muted)' }}>{v.duration}</span>}
          {v.exitCode !== null && v.exitCode !== undefined && (
            <span style={{ color: v.exitCode === 0 ? 'var(--ok)' : 'var(--err)' }}>exit {v.exitCode}</span>
          )}
          {v.ranAt && <span style={{ color: 'var(--fg-dim)' }}>{v.ranAt}</span>}
        </span>

        <button className="btn btn-sm btn-ghost" onClick={(e) => e.stopPropagation()} type="button">
          <Icon name="play" size={11} /> {v.verdict === 'not_run' ? 'Run' : 'Re-run'}
        </button>
      </button>

      {open && v.output && (
        <div className="val-output mono">
          {v.output.map((line, i) => (
            <div
              key={i}
              className={`val-line ${line.includes('error') ? 'val-line-err' : ''} ${line.includes('✓') ? 'val-line-ok' : ''}`}
            >
              {line || ' '}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ValidationsSectionProps {
  validations: ValidationData[];
}

export function ValidationsSection({ validations }: ValidationsSectionProps) {
  const [open, setOpen] = useState(true);
  const passed = validations.filter((v) => v.verdict === 'passed').length;
  const failed = validations.filter((v) => v.verdict === 'failed').length;
  const notRun = validations.filter((v) => v.verdict === 'not_run').length;
  const failedSample = validations.find((v) => v.verdict === 'failed');

  return (
    <div className="td-section sect">
      <button className="sect-head" onClick={() => setOpen(!open)} type="button">
        <Icon name="workflow" size={12} className="sect-chev" style={{ transform: open ? 'none' : 'rotate(-90deg)' }} />
        <h3>Validations</h3>
        <span className="val-counts mono">
          <span style={{ color: 'var(--ok)' }}>{passed} pass</span>
          {failed > 0 && <span style={{ color: 'var(--err)' }}>· {failed} fail</span>}
          {notRun > 0 && <span style={{ color: 'var(--fg-dim)' }}>· {notRun} pending</span>}
        </span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button className="btn btn-sm" onClick={(e) => e.stopPropagation()} type="button">
            <Icon name="play" size={11} /> Run all
          </button>
        </span>
      </button>

      {open && (
        <div className="sect-body">
          <div className="val-stack">
            {validations.map((v) => <ValidationRow key={v.id} v={v} />)}
          </div>
          {failedSample && (
            <div className="val-fail-callout">
              <Icon name="info" size={13} />
              <div>
                <strong>{failed} validation{failed === 1 ? '' : 's'} failed.</strong> Latest failure in <span className="mono">{failedSample.cmd}</span>. Task can't move to <span className="mono">MERGE READY</span> until all validations pass.
              </div>
              <button className="btn btn-sm" type="button">View error</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
