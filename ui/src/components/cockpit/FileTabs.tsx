import { Icon } from '../Icon';

/**
 * Phase 2 FileTabs — Cursor-style horizontal tab strip across the top
 * of the WITH-me Cockpit editor pane. Each open file becomes a tab;
 * clicking a tab activates that file, the × button closes it, and
 * tabs scroll horizontally if more open than fit.
 *
 * Per spec §8.3, each tab carries an optional in-scope-for chip when
 * the file belongs to an active task's allowed-files contract — so
 * the operator can tell at a glance which files an agent is currently
 * authorized to touch.
 *
 * Pin behavior (middle-click / context menu / Ctrl+K Ctrl+Enter) lands
 * in Phase 3 polish. Phase 2 just shows pinned state visually if the
 * caller sets `pinned: true`.
 *
 * Drag-to-reorder is also Phase 3.
 */

export interface OpenFile {
  path: string;
  /** True when the file has unsaved changes (dirty dot in the tab). */
  dirty?: boolean;
  /** True when the user pinned the tab (rendered before unpinned ones). */
  pinned?: boolean;
  /** When set, render an in-scope-for chip on the tab. */
  scopeTaskId?: string;
}

export interface FileTabsProps {
  files: OpenFile[];
  activePath: string | null;
  onActivate: (path: string) => void;
  onClose: (path: string) => void;
  /** Optional pin handler — when omitted, pin support is hidden. */
  onPin?: (path: string) => void;
}

/** Take the last segment of a slash/backslash-separated path. Used for
 *  the tab label so we don't show the whole repo-relative path. */
function basename(path: string): string {
  const normalized = path.replace(/\\/g, '/');
  const idx = normalized.lastIndexOf('/');
  return idx < 0 ? normalized : normalized.slice(idx + 1);
}

export function FileTabs({ files, activePath, onActivate, onClose, onPin: _onPin }: FileTabsProps) {
  if (files.length === 0) {
    return (
      <div className="file-tabs file-tabs-empty">
        <span className="file-tabs-hint">No files open · pick one from the tree.</span>
      </div>
    );
  }

  // Sort: pinned first (preserving order within group), then unpinned.
  const ordered = files
    .map((f, idx) => ({ f, idx }))
    .sort((a, b) => {
      const pa = a.f.pinned ? 1 : 0;
      const pb = b.f.pinned ? 1 : 0;
      if (pa !== pb) return pb - pa;
      return a.idx - b.idx;
    })
    .map(({ f }) => f);

  return (
    <div className="file-tabs">
      {ordered.map((file) => {
        const isActive = file.path === activePath;
        return (
          <div
            key={file.path}
            className="file-tab"
            data-active={isActive || undefined}
            data-pinned={file.pinned || undefined}
            onClick={() => onActivate(file.path)}
            onMouseDown={(e) => {
              // Middle-click closes (standard browser tab convention).
              if (e.button === 1) {
                e.preventDefault();
                onClose(file.path);
              }
            }}
            title={file.path}
          >
            {file.dirty && <span className="dot" aria-label="unsaved changes" />}
            <span className="file-tab-label">{basename(file.path)}</span>
            {file.scopeTaskId && (
              <span className="scope" title={`In scope for ${file.scopeTaskId}`}>
                {file.scopeTaskId}
              </span>
            )}
            <button
              type="button"
              className="close"
              onClick={(e) => {
                e.stopPropagation();
                onClose(file.path);
              }}
              title="Close (Ctrl+W)"
              aria-label={`Close ${file.path}`}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
