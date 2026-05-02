import { Icon } from '@/components/Icon';

export interface EmptyWorkspaceProps {
  onCreateTeam: () => void;
  onOpenRecent?: () => void;
}

export function EmptyWorkspace({ onCreateTeam, onOpenRecent }: EmptyWorkspaceProps) {
  return (
    <div className="empty-workspace">
      <div className="empty-card">
        <div className="empty-glyph">
          <div className="empty-glyph-node lead" />
          <div className="empty-glyph-line" />
          <div className="empty-glyph-row">
            <div className="empty-glyph-node dev" />
            <div className="empty-glyph-node rev" />
            <div className="empty-glyph-node res" />
          </div>
        </div>
        <h2>No team selected</h2>
        <p>
          Spin up a multi-agent team to start coordinating work. The team lead delegates to your
          specialized agents across any CLI provider.
        </p>
        <div className="empty-actions">
          <button className="btn btn-primary" onClick={onCreateTeam}>
            <Icon name="plus" size={13} /> Create team
          </button>
          <button className="btn" onClick={onOpenRecent}>
            <Icon name="folder" size={13} /> Open recent
          </button>
        </div>
        <div className="empty-tips">
          <div className="empty-tip">
            <span className="kbd">Ctrl</span><span className="kbd">N</span>
            <span>New team</span>
          </div>
          <div className="empty-tip">
            <span className="kbd">Ctrl</span><span className="kbd">P</span>
            <span>Open project</span>
          </div>
          <div className="empty-tip">
            <span className="kbd">Ctrl</span><span className="kbd">K</span>
            <span>Command palette</span>
          </div>
        </div>
      </div>
    </div>
  );
}
