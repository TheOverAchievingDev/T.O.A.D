import { useMemo } from 'react';
import type { UiTask, ValidationKind, UiValidationRun } from '@/types';

/**
 * Phase 3a Task 3 — Validations slot for the WITH-me Cockpit BottomPanel.
 *
 * Shows the latest validation run per task per kind. Tasks with no
 * recent validations don't render. Rows group by task so the operator
 * can quickly see which task's lint / typecheck / test / build is
 * green or red.
 *
 * The TRIGGER UI (a "Run" button) intentionally lives elsewhere —
 * either in the Menubar's Run menu (Run → Run Validations on Active
 * Task) or in the Inspector's Task tab. This slot is read-only display.
 * Phase 5 polish can add a per-row "re-run" button.
 */

export interface BottomPanelValidationsProps {
  tasks: UiTask[];
  /** Cap on tasks shown. Default 8 — keeps the panel compact. */
  limit?: number;
}

const KINDS: ValidationKind[] = ['lint', 'typecheck', 'test', 'build'];

function verdictDot(verdict: UiValidationRun['verdict']): string {
  switch (verdict) {
    case 'passed': return 'green';
    case 'failed': return 'red';
    case 'not_run':
    default:       return 'idle';
  }
}
function verdictLabel(verdict: UiValidationRun['verdict']): string {
  switch (verdict) {
    case 'passed': return 'pass';
    case 'failed': return 'fail';
    case 'not_run':
    default:       return '—';
  }
}

function pickLatest(task: UiTask, kind: ValidationKind): UiValidationRun | null {
  if (task.latestValidation?.[kind]) return task.latestValidation[kind] ?? null;
  if (!task.validations) return null;
  let latest: UiValidationRun | null = null;
  for (const v of task.validations) {
    if (v.kind !== kind) continue;
    if (!latest || (v.createdAt ?? '') > (latest.createdAt ?? '')) latest = v;
  }
  return latest;
}

function taskMostRecentValidationAt(task: UiTask): string {
  let best = '';
  if (task.latestValidation) {
    for (const v of Object.values(task.latestValidation)) {
      if (v?.createdAt && v.createdAt > best) best = v.createdAt;
    }
  }
  if (task.validations) {
    for (const v of task.validations) {
      if (v.createdAt && v.createdAt > best) best = v.createdAt;
    }
  }
  return best;
}

export function BottomPanelValidations({ tasks, limit = 8 }: BottomPanelValidationsProps) {
  const tasksWithValidations = useMemo(() => {
    const withTimes = tasks
      .filter((t) => {
        if (task_hasAnyValidation(t)) return true;
        return false;
      })
      .map((t) => ({ task: t, at: taskMostRecentValidationAt(t) }));
    withTimes.sort((a, b) => b.at.localeCompare(a.at));
    return withTimes.slice(0, limit).map((x) => x.task);
  }, [tasks, limit]);

  if (tasksWithValidations.length === 0) {
    return (
      <div className="bp-output-empty">
        <div className="bp-empty-label">Validations</div>
        <div className="bp-empty-hint">
          No tasks have recent validation runs. Trigger one from Run → Run Validations on Active Task,
          or let an agent fire <span className="mono">validation_run</span> during testing.
        </div>
      </div>
    );
  }

  return (
    <div className="bp-validations">
      <div className="bp-validations-head">
        <span className="col-task">Task</span>
        {KINDS.map((k) => (
          <span key={k} className="col-kind">{k}</span>
        ))}
      </div>
      {tasksWithValidations.map((task) => (
        <div key={task.id} className="bp-validations-row">
          <span className="col-task">
            <span className="task-id mono">{task.id}</span>
            <span className="task-title">{task.title}</span>
          </span>
          {KINDS.map((kind) => {
            const run = pickLatest(task, kind);
            const verdict = run?.verdict ?? 'not_run';
            return (
              <span key={kind} className={`col-kind ${verdict}`} title={run?.command ?? ''}>
                <span className={`dot ${verdictDot(verdict)}`} />
                <span className="lbl">{verdictLabel(verdict)}</span>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function task_hasAnyValidation(task: UiTask): boolean {
  if (task.latestValidation) {
    for (const v of Object.values(task.latestValidation)) {
      if (v) return true;
    }
  }
  if (task.validations && task.validations.length > 0) return true;
  return false;
}
