import type { UiTask, UiValidationRun } from '@/types';
import type { DriftRunResult } from '@/hooks/useDrift';
import { Icon } from './Icon';
import { DriftBadge } from './DriftBadge';
import { TaskRiskBadge } from './TaskRiskBadge';
import {
  formatValidationDuration,
  formatValidationTime,
  validationSummary,
} from './cockpitValidation';
import type { CockpitReviewSummary } from './cockpitReview';

interface CockpitReviewPaneProps {
  task: UiTask | null;
  validationRuns: UiValidationRun[];
  reviewSummary: CockpitReviewSummary;
  driftData: DriftRunResult | null;
  canOpenTaskFiles: boolean;
  onOpenTask: (taskId: string) => void;
  onOpenTaskFiles: () => void;
  onRunValidation: () => void;
  validationRunning: boolean;
}

export function CockpitReviewPane({
  task,
  validationRuns,
  reviewSummary,
  driftData,
  canOpenTaskFiles,
  onOpenTask,
  onOpenTaskFiles,
  onRunValidation,
  validationRunning,
}: CockpitReviewPaneProps) {
  if (!task) {
    return (
      <div className="cockpit-review-pane empty">
        <div className="cockpit-empty">
          <Icon name="workflow" size={24} />
          <strong>No task selected</strong>
          <span>Select a task from Flow to review files, drift, validation, and diff context.</span>
        </div>
      </div>
    );
  }

  const review = task.review ?? null;
  const changedFiles = review?.files ?? [];
  const scopeDrift = review?.scopeDrift ?? [];
  const diff = review?.diff?.trim() ?? '';

  return (
    <div className="cockpit-review-pane" aria-label="Selected task review">
      <header className="cockpit-review-hero">
        <div>
          <div className="eyebrow">Review cockpit</div>
          <h2>{task.id}</h2>
          <p>{task.title}</p>
        </div>
        <div className="cockpit-review-actions">
          <button className="btn btn-sm" type="button" onClick={() => onOpenTask(task.id)}>
            Open task
          </button>
          <button className="btn btn-sm" type="button" onClick={onOpenTaskFiles} disabled={!canOpenTaskFiles}>
            <Icon name="code" size={12} />
            Task files
          </button>
          <button className="btn btn-sm btn-primary" type="button" onClick={onRunValidation} disabled={validationRunning}>
            <Icon name="play" size={12} />
            {validationRunning ? 'Running' : 'Run validation'}
          </button>
        </div>
      </header>

      <section className="cockpit-review-grid">
        <ReviewMetric label="Gate" value={reviewSummary.state} tone={reviewSummary.state === 'blocked' ? 'bad' : reviewSummary.state === 'ready' ? 'good' : undefined} />
        <ReviewMetric label="Files" value={String(reviewSummary.fileCount)} />
        <ReviewMetric label="Scope drift" value={String(reviewSummary.scopeDriftCount)} tone={reviewSummary.scopeDriftCount > 0 ? 'bad' : undefined} />
        <ReviewMetric label="Validations" value={reviewSummary.validationLabel} />
      </section>

      <section className={`cockpit-review-summary-card ${reviewSummary.state}`}>
        <div>
          <span>Agent summary</span>
          <strong>{review?.summary || review?.reason || 'No review request summary has been captured yet.'}</strong>
        </div>
        <div className="cockpit-review-chip-row">
          <span className={`cockpit-status ${task.status}`}>{task.status}</span>
          {task.riskLevel && (
            <TaskRiskBadge
              level={task.riskLevel}
              requiresHumanApproval={task.requiresHumanApproval}
              humanApproved={task.humanApproved}
              matchedRules={task.matchedRules}
            />
          )}
          <DriftBadge score={driftData?.perTaskScores?.[task.id]} />
        </div>
      </section>

      <div className="cockpit-review-columns">
        <section className="cockpit-review-panel">
          <div className="cockpit-panel-title">
            <h3>Changed files</h3>
            <span className="mono dim">{changedFiles.length}</span>
          </div>
          {changedFiles.length === 0 ? (
            <div className="cockpit-empty small">No changed files captured yet.</div>
          ) : (
            <div className="cockpit-review-file-list">
              {changedFiles.map((file) => (
                <code key={file}>{file}</code>
              ))}
            </div>
          )}
        </section>

        <section className="cockpit-review-panel">
          <div className="cockpit-panel-title">
            <h3>Scope drift</h3>
            <span className="mono dim">{scopeDrift.length}</span>
          </div>
          {scopeDrift.length === 0 ? (
            <div className="cockpit-empty small">No scope drift captured for this task.</div>
          ) : (
            <div className="cockpit-review-file-list drift">
              {scopeDrift.map((file) => (
                <code key={file}>{file}</code>
              ))}
            </div>
          )}
        </section>

        <section className="cockpit-review-panel">
          <div className="cockpit-panel-title">
            <h3>Validations</h3>
            <span className="mono dim">{validationSummary(validationRuns)}</span>
          </div>
          {validationRuns.length === 0 ? (
            <div className="cockpit-empty small">No validation runs yet.</div>
          ) : (
            <div className="cockpit-review-validation-list">
              {validationRuns.slice(0, 5).map((run) => (
                <div key={`${run.kind}-${run.createdAt ?? run.command ?? 'run'}`} className={`cockpit-validation-chip ${run.verdict}`}>
                  <span>{run.kind}</span>
                  <strong>{run.verdict}</strong>
                  {formatValidationDuration(run.durationMs) && <em>{formatValidationDuration(run.durationMs)}</em>}
                  {formatValidationTime(run.createdAt) && <em>{formatValidationTime(run.createdAt)}</em>}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="cockpit-review-diff">
        <div className="cockpit-panel-title">
          <h3>Unified diff</h3>
          {review?.noOpDiff && <span className="chip">No-op diff</span>}
        </div>
        <pre>{diff || 'No review diff has been captured yet.'}</pre>
      </section>
    </div>
  );
}

function ReviewMetric({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className={`cockpit-review-metric ${tone ?? ''}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
