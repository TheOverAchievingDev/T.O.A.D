import { useEffect, useState } from 'react';
import { Icon } from '@/components/Icon';
import { callTool, ToadApiError, type Actor } from '@/api/client';

export interface ProvidersModalProps {
  onClose: () => void;
  onOpenSettings?: () => void;
}

const ACTOR: Actor = { teamId: 'default', agentId: 'ui-client', agentName: 'ui', role: 'human' };
const PROVIDERS = ['anthropic', 'openai', 'gemini', 'opencode'] as const;
type ProviderId = (typeof PROVIDERS)[number];

interface AuthStatus {
  providerId: ProviderId;
  supported: boolean;
  signedIn: boolean | null;
  user?: { email?: string | null; name?: string | null } | null;
  plan?: string | null;
  reason?: string;
}

const LABELS: Record<ProviderId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

/**
 * Lightweight providers overview.
 *
 * Previously this modal showed a heavy "Providers & system setup" dashboard
 * with hardcoded Provider/System/Diagnostics tabs — fake usage bars, fake
 * "tmux not installed" warnings (TOAD doesn't actually use tmux), fake
 * "Install Ubuntu in WSL" buttons (the orchestrator runs on Windows
 * natively as a Node.js process). Every action button was a no-op.
 *
 * The new modal does just one thing: shows live plan-auth status for each
 * provider and points the user at Settings → Providers for any management
 * action. Real connect/disconnect flows live there.
 */
export function ProvidersModal({ onClose, onOpenSettings }: ProvidersModalProps) {
  const [statuses, setStatuses] = useState<Partial<Record<ProviderId, AuthStatus>>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const next: Partial<Record<ProviderId, AuthStatus>> = {};
      for (const id of PROVIDERS) {
        try {
          const result = await callTool<AuthStatus>({
            actor: ACTOR,
            method: 'provider_auth_status',
            args: { providerId: id },
          });
          if (cancelled) return;
          next[id] = result;
        } catch (err) {
          if (cancelled) return;
          next[id] = {
            providerId: id,
            supported: true,
            signedIn: null,
            reason:
              err instanceof ToadApiError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : 'lookup failed',
          };
        }
      }
      if (!cancelled) {
        setStatuses(next);
        setLoading(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640 }}>
        <div className="td-head">
          <div className="td-head-left">
            <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600 }}>Providers</h2>
            <span className="dim">·</span>
            <span className="dim" style={{ fontSize: 12 }}>Plan-auth status</span>
          </div>
          <div className="td-head-right">
            <button className="icon-btn" onClick={onClose} type="button">
              <Icon name="x" size={16} />
            </button>
          </div>
        </div>

        <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10 }}>
          {loading && <div className="dim" style={{ fontSize: 12 }}>Checking…</div>}
          {!loading && PROVIDERS.map((id) => {
            const status = statuses[id];
            const label = LABELS[id];
            const signedIn = status?.signedIn === true;
            const apiOnly = status && 'apiOnly' in status && (status as AuthStatus & { apiOnly?: boolean }).apiOnly === true;
            const accent = signedIn ? 'oklch(0.72 0.15 145)' : 'var(--fg-dim)';
            return (
              <div
                key={id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 12px',
                  background: 'rgba(255,255,255,0.02)',
                  border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
                  borderRadius: 8,
                }}
              >
                <span className={`provider-glyph ${id}`} style={{ width: 26, height: 26, borderRadius: 6 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
                  <div className="dim" style={{ fontSize: 11 }}>
                    {apiOnly
                      ? 'API-only — no plan auth (use API key)'
                      : signedIn
                        ? status?.user?.email || status?.plan || 'Signed in'
                        : status?.reason || 'Not signed in'}
                  </div>
                </div>
                <span
                  style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: accent,
                    boxShadow: signedIn ? `0 0 6px ${accent}` : 'none',
                  }}
                />
              </div>
            );
          })}
        </div>

        <div
          style={{
            padding: '12px 20px',
            borderTop: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div className="dim" style={{ fontSize: 11.5, flex: 1 }}>
            Manage API keys, plan auth, default models, and cost caps in Settings → Providers.
          </div>
          {onOpenSettings && (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => { onOpenSettings(); onClose(); }}
            >
              <Icon name="settings" size={11} /> Open settings
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
