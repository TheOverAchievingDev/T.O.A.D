import { Icon } from '../Icon';
import {
  countDiagnosticsBySeverity,
  groupDiagnosticsByFile,
  type IdeDiagnostic,
  type IdeDiagnosticToolResult,
} from '../ideDiagnostics';

export interface BottomPanelProblemsProps {
  diagnostics: IdeDiagnostic[];
  toolResults?: IdeDiagnosticToolResult[];
  running?: boolean;
  error?: string | null;
  onOpenDiagnostic?: (diagnostic: IdeDiagnostic) => void;
  onRunDiagnostics?: () => void;
  onFixProject?: () => void;
}

export function BottomPanelProblems({
  diagnostics,
  toolResults = [],
  running = false,
  error = null,
  onOpenDiagnostic,
  onRunDiagnostics,
  onFixProject,
}: BottomPanelProblemsProps) {
  const counts = countDiagnosticsBySeverity(diagnostics);
  const groups = groupDiagnosticsByFile(diagnostics);
  const unavailable = toolResults.filter((tool) => !tool.available || tool.timedOut);

  return (
    <div className="bp-problems">
      <div className="bp-problems-head">
        <div className="bp-problems-summary">
          <span className="sev error">{counts.error}</span>
          <span className="sev warning">{counts.warning}</span>
          <span className="sev info">{counts.info}</span>
          {running && <span className="bp-problems-running">Running</span>}
        </div>
        {onRunDiagnostics && (
          <div className="bp-problems-actions">
            {onFixProject && (
              <button type="button" className="btn btn-xs" onClick={onFixProject} disabled={running}>
                <Icon name="sparkle" size={12} />
                Fix
              </button>
            )}
            <button type="button" className="btn btn-xs" onClick={onRunDiagnostics} disabled={running}>
              <Icon name="refresh" size={12} />
              Refresh
            </button>
          </div>
        )}
      </div>

      {error && <div className="bp-problems-error">{error}</div>}
      {unavailable.length > 0 && (
        <div className="bp-problems-tools">
          {unavailable.map((tool) => (
            <span key={`${tool.tool}:${tool.message}`}>{tool.tool}: {tool.message}</span>
          ))}
        </div>
      )}

      {groups.length === 0 ? (
        <div className="bp-output-empty">
          <div>No Python diagnostics from the active project.</div>
          {toolResults.length > 0 && (
            <div className="mono">{toolResults.map((tool) => `${tool.tool}: ${tool.message}`).join(' | ')}</div>
          )}
        </div>
      ) : (
        <div className="bp-problems-list">
          {groups.map((group) => (
            <div className="bp-problems-file" key={group.path}>
              <div className="bp-problems-file-head mono">{group.path}</div>
              {group.diagnostics.map((diagnostic) => (
                <button
                  key={`${diagnostic.source}:${diagnostic.path}:${diagnostic.line}:${diagnostic.column}:${diagnostic.message}`}
                  type="button"
                  className="bp-problem-row"
                  onClick={() => onOpenDiagnostic?.(diagnostic)}
                >
                  <span className={`bp-problem-severity ${diagnostic.severity}`} aria-label={diagnostic.severity} />
                  <span className="bp-problem-location mono">
                    {diagnostic.line}:{diagnostic.column}
                  </span>
                  <span className="bp-problem-source mono">
                    {diagnostic.source}{diagnostic.code ? `:${diagnostic.code}` : ''}
                  </span>
                  <span className="bp-problem-message">{diagnostic.message}</span>
                  {diagnostic.fixable && <span className="bp-problem-fixable">fixable</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
