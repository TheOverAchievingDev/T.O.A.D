import type { CSSProperties } from 'react';
import type { CodeTreeNode } from './codeTreeNavigator';
import { Icon } from './Icon';

interface IdeFileTreeProps {
  nodes: CodeTreeNode[];
  expandedPaths: ReadonlySet<string>;
  activePath: string | null;
  onToggleDirectory: (path: string) => void;
  onOpenFile: (path: string) => void;
}

export function IdeFileTree({
  nodes,
  expandedPaths,
  activePath,
  onToggleDirectory,
  onOpenFile,
}: IdeFileTreeProps) {
  return (
    <div className="code-tree-list">
      {nodes.map((node) => (
        <button
          key={node.path}
          type="button"
          className={`code-tree-row ${node.kind} ${activePath === node.path ? 'active' : ''}`}
          onClick={() => {
            if (node.kind === 'directory') {
              onToggleDirectory(node.path);
              return;
            }
            onOpenFile(node.path);
          }}
          title={node.reason ? `${node.path} - ${node.reason}` : node.path}
          style={{ '--depth': node.depth } as CSSProperties}
        >
          <span className="code-tree-disclosure" aria-hidden="true">
            {node.kind === 'directory' ? (
              <Icon name={expandedPaths.has(node.path) ? 'chevronDown' : 'chevronRight'} size={14} />
            ) : null}
          </span>
          <span className="code-tree-icon">
            <Icon name={node.kind === 'directory' ? 'folder' : 'file'} size={13} />
          </span>
          <span className="code-tree-path">{node.name}</span>
          {node.gitStatus && (
            <span className={`code-tree-git-badge status-${node.gitStatus.replace(/\?/g, 'u').toLowerCase()}`}>
              {node.gitStatus}
            </span>
          )}
          {node.kind === 'file' && node.editable === false && (
            <span
              className={`code-tree-kind-badge ${node.category ?? 'unsupported'}`}
              title={node.reason ?? 'Not editable in Symphony'}
            >
              {node.category === 'readonly_text' ? 'RO' : 'BIN'}
            </span>
          )}
          {node.kind === 'file' && node.sizeBytes !== undefined && (
            <span className="code-tree-size">{formatCompactBytes(node.sizeBytes)}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function formatCompactBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}b`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}k`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}m`;
}
