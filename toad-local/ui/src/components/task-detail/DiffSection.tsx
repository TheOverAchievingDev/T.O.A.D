import { useState } from 'react';
import { Icon } from '../Icon';
import type { DiffFileData } from './seed';

function DiffFileView({ file, defaultOpen = false }: { file: DiffFileData; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const statusLabel = file.status === 'added' ? 'A' : file.status === 'removed' ? 'D' : 'M';

  return (
    <div className={`diff-file ${file.drift ? 'diff-file-drift' : ''}`}>
      <button className="diff-file-head" onClick={() => setOpen(!open)} type="button">
        <Icon name="moreH" size={11} className="diff-chev" style={{ transform: open ? 'rotate(90deg)' : 'none' }} />
        <span className={`diff-status diff-status-${file.status}`}>{statusLabel}</span>
        <span className="mono diff-path">{file.path}</span>
        {file.drift && (
          <span
            className="chip"
            style={{
              background: 'oklch(0.78 0.14 80 / 0.14)',
              color: 'oklch(0.85 0.14 80)',
              borderColor: 'oklch(0.78 0.14 80 / 0.30)',
              fontSize: 10,
            }}
          >
            <Icon name="info" size={9} /> Scope drift
          </span>
        )}
        <span className="diff-stats mono">
          <span style={{ color: 'oklch(0.72 0.15 145)' }}>+{file.added}</span>
          <span style={{ color: 'oklch(0.65 0.20 25)' }}>−{file.removed}</span>
        </span>
        <button
          className="icon-btn"
          style={{ width: 22, height: 22 }}
          onClick={(e) => e.stopPropagation()}
          type="button"
        >
          <Icon name="eye" size={11} />
        </button>
      </button>

      {open && (
        <div className="diff-body">
          {file.hunks.map((hunk, i) => (
            <div key={i} className="diff-hunk">
              <div className="diff-hunk-head mono">{hunk.header}</div>
              {hunk.lines.map((ln, j) => (
                <div key={j} className={`diff-line diff-line-${ln.t}`}>
                  <span className="diff-gutter mono">{ln.n1 ?? ''}</span>
                  <span className="diff-gutter mono">{ln.n2 ?? ''}</span>
                  <span className="diff-marker mono">{ln.t === 'add' ? '+' : ln.t === 'del' ? '−' : ' '}</span>
                  <span className="mono diff-code">{ln.c}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

interface DiffSectionProps {
  files: DiffFileData[];
}

export function DiffSection({ files }: DiffSectionProps) {
  const [open, setOpen] = useState(true);
  const [view, setView] = useState<'unified' | 'split'>('unified');
  const totalAdded = files.reduce((a, f) => a + f.added, 0);
  const totalRemoved = files.reduce((a, f) => a + f.removed, 0);
  const driftFiles = files.filter((f) => f.drift);
  const driftCount = driftFiles.length;

  return (
    <div className="td-section sect">
      <button className="sect-head" onClick={() => setOpen(!open)} type="button">
        <Icon name="workflow" size={12} className="sect-chev" style={{ transform: open ? 'none' : 'rotate(-90deg)' }} />
        <h3>Changes</h3>
        <span className="chip" style={{ fontSize: 10.5 }}>{files.length} files</span>
        {driftCount > 0 && (
          <span
            className="chip"
            style={{
              background: 'oklch(0.78 0.14 80 / 0.14)',
              color: 'oklch(0.85 0.14 80)',
              borderColor: 'oklch(0.78 0.14 80 / 0.30)',
              fontSize: 10,
            }}
          >
            <Icon name="info" size={9} /> {driftCount} drift
          </span>
        )}
        <span className="mono dim" style={{ marginLeft: 'auto', fontSize: 11 }}>
          <span style={{ color: 'oklch(0.72 0.15 145)' }}>+{totalAdded}</span>{' '}
          <span style={{ color: 'oklch(0.65 0.20 25)' }}>−{totalRemoved}</span>
        </span>
      </button>

      {open && (
        <div className="sect-body">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div className="seg">
              <button className={view === 'unified' ? 'active' : ''} onClick={() => setView('unified')} type="button">Unified</button>
              <button className={view === 'split' ? 'active' : ''} onClick={() => setView('split')} type="button">Split</button>
            </div>
            <button className="btn btn-sm btn-ghost" style={{ marginLeft: 'auto' }} type="button">
              <Icon name="eye" size={11} /> Open in IDE
            </button>
          </div>

          <div className="diff-stack">
            {files.map((f, i) => (
              <DiffFileView key={f.path} file={f} defaultOpen={i === 0} />
            ))}
          </div>

          {driftFiles[0] && (
            <div className="diff-drift-callout">
              <Icon name="info" size={13} />
              <div>
                <strong>Scope drift detected.</strong> Modified <span className="mono">{driftFiles[0].path}</span>, which isn't in the plan's expected files. Review carefully or ask the agent to revert.
              </div>
              <button className="btn btn-sm" type="button">Open plan</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
