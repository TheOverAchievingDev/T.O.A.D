import { useMemo, useState } from 'react';
import { Icon } from '@/components/Icon';

type DiagnosticStatus = 'pass' | 'warn' | 'fail';
type DiagnosticGroup = 'Providers' | 'Runtime' | 'Storage' | 'Network' | 'Filesystem';

interface DiagnosticCheck {
  id: string;
  group: DiagnosticGroup;
  label: string;
  status: DiagnosticStatus;
  evidence: string;
  fix?: string;
}

interface DiagnosticRun {
  ranAt: string;
  duration: string;
  pass: number;
  warn: number;
  fail: number;
  db: {
    path: string;
    size: string;
    tables: Record<string, number>;
  };
  checks: DiagnosticCheck[];
}

interface DiagRowProps {
  check: DiagnosticCheck;
  expanded: boolean;
  onToggle: (id: string) => void;
}

export interface DiagnosticsDrawerProps {
  onClose: () => void;
}

const DIAG_RUN: DiagnosticRun = {
  ranAt: '14s ago',
  duration: '2.4s',
  pass: 14,
  warn: 2,
  fail: 1,
  db: {
    path: '~/.toad/db.sqlite',
    size: '14.2 MB',
    tables: {
      teams: 3,
      agents: 8,
      tasks: 412,
      validations: 184,
      runtime_events: 24_820,
      comments: 96,
    },
  },
  checks: [
    {
      id: 'claude_cli',
      group: 'Providers',
      label: 'Claude CLI installed and authenticated',
      status: 'pass',
      evidence: '/usr/local/bin/claude - v0.42.0 - auth: anthropic.com',
    },
    {
      id: 'codex_cli',
      group: 'Providers',
      label: 'OpenAI Codex CLI installed',
      status: 'pass',
      evidence: '~/.local/bin/codex - v5.4.2',
    },
    {
      id: 'opencode',
      group: 'Providers',
      label: 'OpenCode auth',
      status: 'warn',
      evidence: 'Token expired 2 days ago',
      fix: 'opencode auth login',
    },
    {
      id: 'gemini_cli',
      group: 'Providers',
      label: 'Gemini CLI',
      status: 'warn',
      evidence: 'Not installed',
      fix: 'npm i -g @google/gemini-cli',
    },
    {
      id: 'tmux',
      group: 'Runtime',
      label: 'tmux installed (>=3.4)',
      status: 'fail',
      evidence: 'tmux: command not found',
      fix: 'apt install tmux',
    },
    { id: 'git', group: 'Runtime', label: 'Git supports worktrees', status: 'pass', evidence: 'git version 2.45.0' },
    { id: 'node', group: 'Runtime', label: 'Node.js (>=20)', status: 'pass', evidence: 'v22.4.0' },
    { id: 'pnpm', group: 'Runtime', label: 'pnpm installed', status: 'pass', evidence: 'v9.6.1' },
    {
      id: 'db',
      group: 'Storage',
      label: 'TOAD database reachable',
      status: 'pass',
      evidence: '~/.toad/db.sqlite - 14.2 MB - 6 tables',
    },
    {
      id: 'db_writable',
      group: 'Storage',
      label: 'Database writable',
      status: 'pass',
      evidence: 'fsync OK - last write 4s ago',
    },
    {
      id: 'retention',
      group: 'Storage',
      label: 'Retention policy active',
      status: 'pass',
      evidence: 'Pruning events older than 14 days',
    },
    {
      id: 'sse',
      group: 'Network',
      label: 'Event stream healthy',
      status: 'pass',
      evidence: '9 listeners - 0 backpressure / 5m',
    },
    {
      id: 'api_token',
      group: 'Network',
      label: 'API token configured',
      status: 'pass',
      evidence: 'tok_...a14f - created 3d ago',
    },
    {
      id: 'approvals',
      group: 'Network',
      label: 'Approval handler responsive',
      status: 'pass',
      evidence: 'median 1.4s - p95 4.8s',
    },
    {
      id: 'perms',
      group: 'Filesystem',
      label: 'Project root writable',
      status: 'pass',
      evidence: '~/code/ide-test - 0755',
    },
    {
      id: 'git_clean',
      group: 'Filesystem',
      label: 'Working tree clean',
      status: 'pass',
      evidence: 'no uncommitted changes outside worktrees',
    },
    {
      id: 'disk',
      group: 'Filesystem',
      label: 'Disk space available',
      status: 'pass',
      evidence: '184 GB free of 512 GB',
    },
  ],
};

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
          <div className="diag-evidence mono">{check.evidence}</div>
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
  const [openIds, setOpenIds] = useState<Set<string>>(
    () => new Set(DIAG_RUN.checks.filter((check) => check.status !== 'pass').map((check) => check.id)),
  );

  const toggle = (id: string) => {
    setOpenIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const groups = useMemo(() => (
    DIAG_RUN.checks.reduce<Partial<Record<DiagnosticGroup, DiagnosticCheck[]>>>((acc, check) => {
      acc[check.group] = [...(acc[check.group] ?? []), check];
      return acc;
    }, {})
  ), []);

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer diag-drawer" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name="cpu" size={15} />
            <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>Diagnostics</h2>
            <span className="dim mono" style={{ fontSize: 11 }}>
              {DIAG_RUN.duration} - {DIAG_RUN.ranAt}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button className="btn btn-sm"><Icon name="play" size={11} /> Run again</button>
            <button className="icon-btn" onClick={onClose}><Icon name="x" size={14} /></button>
          </div>
        </div>

        <div className="diag-summary">
          <div className="diag-summary-tile diag-pass-tile">
            <div className="mono diag-summary-num" style={{ color: 'var(--ok)' }}>{DIAG_RUN.pass}</div>
            <div className="diag-summary-label">passing</div>
          </div>
          <div className="diag-summary-tile diag-warn-tile">
            <div className="mono diag-summary-num" style={{ color: 'var(--warn)' }}>{DIAG_RUN.warn}</div>
            <div className="diag-summary-label">warnings</div>
          </div>
          <div className="diag-summary-tile diag-fail-tile">
            <div className="mono diag-summary-num" style={{ color: 'var(--err)' }}>{DIAG_RUN.fail}</div>
            <div className="diag-summary-label">failing</div>
          </div>
        </div>

        <div className="notif-body-scroll" style={{ padding: '0 0 12px' }}>
          {Object.entries(groups).map(([group, checks]) => (
            <div key={group}>
              <div className="sticky-section-head">
                <span className="section-label">{group}</span>
                <span className="count-pill">{checks.length}</span>
              </div>
              <div style={{ padding: '4px 12px 8px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                {checks.map((check) => (
                  <DiagRow key={check.id} check={check} expanded={openIds.has(check.id)} onToggle={toggle} />
                ))}
              </div>
            </div>
          ))}

          <div className="diag-db-card">
            <div className="diag-db-h">Database</div>
            <div className="diag-db-row mono"><span className="dim">Path</span><span>{DIAG_RUN.db.path}</span></div>
            <div className="diag-db-row mono"><span className="dim">Size</span><span>{DIAG_RUN.db.size}</span></div>
            <div className="diag-db-h" style={{ marginTop: 12 }}>Table row counts</div>
            {Object.entries(DIAG_RUN.db.tables).map(([name, count]) => (
              <div key={name} className="diag-db-row mono">
                <span className="dim">{name}</span>
                <span>{count.toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="drawer-foot">
          <button className="btn btn-sm btn-ghost"><Icon name="file" size={11} /> Export report</button>
          <button className="btn btn-sm btn-ghost">Vacuum DB</button>
        </div>
      </div>
    </div>
  );
}
