import { useState } from 'react';
import { Icon } from '@/components/Icon';

type ProvidersTab = 'providers' | 'system' | 'diagnostics';
type ProviderStatus = 'connected' | 'auth-failed' | 'not-installed';
type SetupKind = 'wsl' | 'tmux';
type DiagnosticStatus = 'pass' | 'warn' | 'fail';

interface ProviderModel {
  name: string;
  usage: number;
  limit: number;
  unit: string;
}

interface ProviderCardData {
  id: string;
  name: string;
  status: ProviderStatus;
  account: string;
  models: ProviderModel[];
}

interface ProviderCardProps {
  provider: ProviderCardData;
}

interface SetupCardProps {
  kind: SetupKind;
}

interface DiagnosticCheck {
  id: string;
  label: string;
  status: DiagnosticStatus;
  evidence: string;
  fix?: string;
}

export interface ProvidersModalProps {
  onClose: () => void;
}

const PROVIDER_CARDS: ProviderCardData[] = [
  {
    id: 'anthropic',
    name: 'Anthropic',
    status: 'connected',
    account: 'claude.ai - Pro plan',
    models: [
      { name: 'Opus 4.6', usage: 42, limit: 100, unit: 'M tokens / mo' },
      { name: 'Sonnet 4.6', usage: 128, limit: 500, unit: 'M tokens / mo' },
      { name: 'Haiku 4.5', usage: 18, limit: 200, unit: 'M tokens / mo' },
    ],
  },
  {
    id: 'openai',
    name: 'OpenAI Codex',
    status: 'connected',
    account: 'ChatGPT Plus - alex@example.com',
    models: [
      { name: '5.4', usage: 8, limit: 50, unit: 'M tokens / mo' },
      { name: '5.4-mini', usage: 22, limit: 200, unit: 'M tokens / mo' },
    ],
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    status: 'auth-failed',
    account: 'Local CLI - auth expired',
    models: [],
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    status: 'not-installed',
    account: 'Not connected',
    models: [],
  },
];

const DIAGNOSTIC_CHECKS: DiagnosticCheck[] = [
  {
    id: 'claude_cli',
    label: 'Claude CLI installed and authenticated',
    status: 'pass',
    evidence: '/usr/local/bin/claude - v0.42.0 - auth: anthropic.com',
  },
  {
    id: 'codex_cli',
    label: 'OpenAI Codex CLI installed',
    status: 'pass',
    evidence: '~/.local/bin/codex - v5.4.2',
  },
  {
    id: 'tmux',
    label: 'tmux installed (>=3.4)',
    status: 'fail',
    evidence: 'tmux: command not found',
    fix: 'apt install tmux',
  },
  {
    id: 'wsl',
    label: 'WSL has user distribution',
    status: 'warn',
    evidence: 'Only docker-desktop service distro found',
    fix: 'wsl --install Ubuntu-24.04',
  },
  {
    id: 'git',
    label: 'Git supports worktrees',
    status: 'pass',
    evidence: 'git version 2.45.0',
  },
  {
    id: 'db',
    label: 'TOAD database reachable',
    status: 'pass',
    evidence: '~/.toad/db.sqlite - 14.2 MB - 6 tables',
  },
  {
    id: 'sse',
    label: 'Event stream healthy',
    status: 'pass',
    evidence: '9 listeners - 0 backpressure events / 5m',
  },
  {
    id: 'approvals',
    label: 'Approval handler responsive',
    status: 'warn',
    evidence: 'median 1.4s - p95 4.8s',
    fix: 'Consider raising approval_timeout in settings',
  },
];

const PROVIDER_STATUS_META: Record<ProviderStatus, {
  color: string;
  label: string;
  chipBg: string;
  chipFg: string;
  chipBd: string;
}> = {
  connected: {
    color: 'var(--ok)',
    label: 'Connected',
    chipBg: 'oklch(0.72 0.15 145 / 0.14)',
    chipFg: 'oklch(0.82 0.15 145)',
    chipBd: 'oklch(0.72 0.15 145 / 0.30)',
  },
  'auth-failed': {
    color: 'var(--err)',
    label: 'Auth failed',
    chipBg: 'oklch(0.65 0.20 25 / 0.14)',
    chipFg: 'oklch(0.78 0.18 25)',
    chipBd: 'oklch(0.65 0.20 25 / 0.30)',
  },
  'not-installed': {
    color: 'var(--fg-dim)',
    label: 'Not installed',
    chipBg: 'var(--bg-input)',
    chipFg: 'var(--fg-muted)',
    chipBd: 'var(--border-soft)',
  },
};

function ProviderCard({ provider }: ProviderCardProps) {
  const statusMeta = PROVIDER_STATUS_META[provider.status];

  return (
    <div className={`prov-card prov-card-${provider.status}`}>
      <div className="prov-card-head">
        <div className={`provider-glyph ${provider.id}`} style={{ width: 36, height: 36, borderRadius: 9 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="prov-card-name">{provider.name}</div>
          <div className="prov-card-account">{provider.account}</div>
        </div>
        <span
          className="chip"
          style={{ background: statusMeta.chipBg, color: statusMeta.chipFg, borderColor: statusMeta.chipBd }}
        >
          <span
            className="status-dot"
            style={{
              background: statusMeta.color,
              boxShadow: provider.status === 'connected' ? `0 0 6px ${statusMeta.color}` : 'none',
            }}
          />
          {statusMeta.label}
        </span>
      </div>

      {provider.models.length > 0 && (
        <div className="prov-card-models">
          {provider.models.map((model) => {
            const pct = (model.usage / model.limit) * 100;
            return (
              <div key={model.name} className="prov-model-row">
                <div className="prov-model-name">{model.name}</div>
                <div className="prov-model-bar"><span style={{ width: `${pct}%` }} /></div>
                <div className="prov-model-usage mono">
                  <span style={{ color: 'var(--fg)' }}>{model.usage}</span>
                  <span style={{ color: 'var(--fg-dim)' }}>/{model.limit}</span>
                  <span style={{ color: 'var(--fg-dim)', marginLeft: 4 }}>{model.unit}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="prov-card-actions">
        {provider.status === 'connected' && (
          <>
            <button className="btn btn-sm">Manage</button>
            <button className="btn btn-sm btn-ghost">Disconnect</button>
          </>
        )}
        {provider.status === 'auth-failed' && (
          <>
            <button className="btn btn-sm btn-primary">Reconnect</button>
            <button className="btn btn-sm btn-ghost">View error</button>
          </>
        )}
        {provider.status === 'not-installed' && (
          <button className="btn btn-sm">Install &amp; connect</button>
        )}
      </div>
    </div>
  );
}

function SetupCard({ kind }: SetupCardProps) {
  if (kind === 'wsl') {
    return (
      <div className="setup-card setup-card-warn">
        <div className="setup-card-icon"><Icon name="cpu" size={16} /></div>
        <div style={{ flex: 1 }}>
          <div className="setup-card-h">WSL has only service distributions.</div>
          <div className="setup-card-p">
            Install a Linux distribution like Ubuntu so teammate runtimes can spawn local processes.
            TOAD detected <span className="mono">docker-desktop</span> only.
          </div>
          <div className="setup-card-actions">
            <button className="btn btn-sm btn-primary">Install Ubuntu in WSL</button>
            <button className="btn btn-sm">Manual guide</button>
            <button className="btn btn-sm btn-ghost">Show steps</button>
            <button className="btn btn-sm btn-ghost">Re-check</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="setup-card setup-card-err">
      <div className="setup-card-icon"><Icon name="terminal" size={16} /></div>
      <div style={{ flex: 1 }}>
        <div className="setup-card-h">tmux is not installed - verification failed.</div>
        <div className="setup-card-p">
          Teammate sessions need tmux for persistent attachable shells. Install it via your package
          manager and re-check.
        </div>
        <div className="setup-log mono">
          <div>$ which tmux</div>
          <div className="dim">tmux: not found</div>
          <div>$ apt-cache policy tmux</div>
          <div className="dim">N: Unable to locate package tmux</div>
        </div>
        <div className="setup-card-actions">
          <button className="btn btn-sm btn-primary">Retry install</button>
          <button className="btn btn-sm">Manual guide</button>
          <button className="btn btn-sm btn-ghost">Show install log</button>
          <button className="btn btn-sm btn-ghost">Re-check</button>
        </div>
      </div>
    </div>
  );
}

export function ProvidersModal({ onClose }: ProvidersModalProps) {
  const [tab, setTab] = useState<ProvidersTab>('providers');
  const diagPass = 14;
  const diagWarn = 2;
  const diagFail = 1;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal prov-modal" onClick={(event) => event.stopPropagation()}>
        <div className="td-head">
          <div className="td-head-left">
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Providers &amp; system setup</h2>
            <span className="dim">/</span>
            <span className="dim" style={{ fontSize: 12 }}>Last checked 14s ago</span>
          </div>
          <div className="td-head-right">
            <button className="btn btn-sm"><Icon name="settings" size={11} /> Re-check</button>
            <button className="icon-btn" onClick={onClose}><Icon name="x" size={16} /></button>
          </div>
        </div>

        <div className="prov-tabs">
          <button
            className={`side-tab ${tab === 'providers' ? 'active' : ''}`}
            onClick={() => setTab('providers')}
          >
            Providers <span className="num">{PROVIDER_CARDS.length}</span>
          </button>
          <button
            className={`side-tab ${tab === 'system' ? 'active' : ''}`}
            onClick={() => setTab('system')}
          >
            System <span className="num" style={{ color: 'var(--err)' }}>!</span>
          </button>
          <button
            className={`side-tab ${tab === 'diagnostics' ? 'active' : ''}`}
            onClick={() => setTab('diagnostics')}
          >
            Diagnostics
          </button>
          <div
            style={{
              marginLeft: 'auto',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '8px 16px 0',
              fontSize: 11.5,
              color: 'var(--fg-muted)',
            }}
          >
            <span><span className="mono" style={{ color: 'var(--ok)' }}>{diagPass}</span> pass</span>
            <span><span className="mono" style={{ color: 'var(--warn)' }}>{diagWarn}</span> warn</span>
            <span><span className="mono" style={{ color: 'var(--err)' }}>{diagFail}</span> fail</span>
          </div>
        </div>

        <div className="prov-body">
          {tab === 'providers' && (
            <div className="prov-grid">
              {PROVIDER_CARDS.map((provider) => <ProviderCard key={provider.id} provider={provider} />)}
            </div>
          )}

          {tab === 'system' && (
            <div className="prov-stack">
              <SetupCard kind="tmux" />
              <SetupCard kind="wsl" />
              <div className="setup-card setup-card-ok">
                <div className="setup-card-icon"><Icon name="check" size={16} /></div>
                <div style={{ flex: 1 }}>
                  <div className="setup-card-h">Git 2.45.0 detected.</div>
                  <div className="setup-card-p">Worktrees and base-ref tracking are available.</div>
                </div>
              </div>
              <div className="setup-card setup-card-ok">
                <div className="setup-card-icon"><Icon name="check" size={16} /></div>
                <div style={{ flex: 1 }}>
                  <div className="setup-card-h">Node 22.4.0 - pnpm 9.6.1.</div>
                  <div className="setup-card-p">Validation runners ready.</div>
                </div>
              </div>
            </div>
          )}

          {tab === 'diagnostics' && (
            <div className="prov-stack">
              {DIAGNOSTIC_CHECKS.map((check) => (
                <div key={check.id} className={`diag-row diag-${check.status}`}>
                  <span className={`diag-pill ${check.status}`}>
                    {check.status === 'pass' && <Icon name="check" size={10} />}
                    {check.status === 'warn' && '!'}
                    {check.status === 'fail' && 'x'}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="diag-label">{check.label}</div>
                    <div className="diag-evidence mono">{check.evidence}</div>
                    {check.fix && (
                      <div className="diag-fix">
                        <span className="dim">Suggested fix:</span> <span className="mono">{check.fix}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
