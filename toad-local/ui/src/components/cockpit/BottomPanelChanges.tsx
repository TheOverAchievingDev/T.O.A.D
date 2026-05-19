import { Icon } from '../Icon';
import {
  formatChangeCounts,
  statusGlyph,
  type IdeChangeEntry,
} from '../ideChanges';

export interface BottomPanelChangesProps {
  files: IdeChangeEntry[];
  running?: boolean;
  error?: string | null;
  onOpenChange?: (relativePath: string) => void;
  onRefresh?: () => void;
}

export function BottomPanelChanges({
  files,
  running = false,
  error = null,
  onOpenChange,
  onRefresh,
}: BottomPanelChangesProps) {
  return (
    <div className="bp-changes">
      <div className="bp-problems-head">
        <div className="bp-problems-summary">
          {files.length > 0 && <span className="bp-changes-count">{files.length} changed</span>}
          {running && <span className="bp-problems-running">Running</span>}
        </div>
        {onRefresh && (
          <div className="bp-problems-actions">
            <button type="button" className="btn btn-xs" onClick={onRefresh} disabled={running}>
              <Icon name="refresh" size={12} />
              Refresh
            </button>
          </div>
        )}
      </div>

      {error && <div className="bp-problems-error">{error}</div>}

      {files.length === 0 ? (
        <div className="bp-output-empty">
          <div>No changes vs HEAD.</div>
        </div>
      ) : (
        <div className="bp-changes-list">
          {files.map((entry) => (
            <button
              key={entry.relativePath}
              type="button"
              className="bp-change-row"
              onClick={() => onOpenChange?.(entry.relativePath)}
              disabled={!onOpenChange}
              title={entry.relativePath}
            >
              <span
                className={`bp-change-status status-${entry.status === '?' ? 'untracked' : entry.status.toLowerCase()}`}
                aria-label={`status ${entry.status}`}
              >
                {statusGlyph(entry.status)}
              </span>
              <span className="bp-change-path mono">{entry.relativePath}</span>
              <span className="bp-change-counts mono">{formatChangeCounts(entry)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
