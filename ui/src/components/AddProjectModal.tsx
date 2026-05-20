import { useEffect, useState } from 'react';
import { Icon } from './Icon';

interface AddProjectModalProps {
  onClose: () => void;
  onAdd: (input: { name: string; path: string; apiBaseUrl?: string; apiToken?: string }) => void;
}

export function AddProjectModal({ onClose, onAdd }: AddProjectModalProps) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [apiBaseUrl, setApiBaseUrl] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function submit() {
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (!path.trim()) {
      setError('Project path is required.');
      return;
    }
    onAdd({
      name: name.trim(),
      path: path.trim(),
      apiBaseUrl: apiBaseUrl.trim() || undefined,
      apiToken: apiToken.trim() || undefined,
    });
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
        <div className="modal-head">
          <div>
            <h2>Add project</h2>
            <div className="sub">Register an existing Symphony project so you can switch between them from the titlebar.</div>
          </div>
          <button className="icon-btn" onClick={onClose} type="button">
            <Icon name="x" size={16} />
          </button>
        </div>

        <div className="modal-body">
          <div className="field">
            <label>Name</label>
            <input
              className="field-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. signal-ops"
              autoFocus
            />
          </div>
          <div className="field">
            <label>Path</label>
            <input
              className="field-input mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\Projects\my-app\…"
            />
            <div className="field-hint">
              The directory holding the project's <span className="mono">.toad/toad.db</span>.
            </div>
          </div>
          <div className="field">
            <label>API base URL <span className="dim" style={{ fontWeight: 400 }}>(optional)</span></label>
            <input
              className="field-input mono"
              value={apiBaseUrl}
              onChange={(e) => setApiBaseUrl(e.target.value)}
              placeholder="http://127.0.0.1:3001"
            />
            <div className="field-hint">
              Leave blank to use the global default. Override only when this project runs on a different port.
            </div>
          </div>
          <div className="field">
            <label>Bearer token <span className="dim" style={{ fontWeight: 400 }}>(optional)</span></label>
            <input
              className="field-input mono"
              type="password"
              value={apiToken}
              onChange={(e) => setApiToken(e.target.value)}
              placeholder="Leave blank to inherit"
            />
          </div>

          {error && (
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
              {error}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <div style={{ fontSize: 11.5, color: 'var(--fg-dim)' }}>
            <span className="kbd">Esc</span> to cancel
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn btn-primary" onClick={submit}>
              <Icon name="plus" size={11} /> Add project
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
