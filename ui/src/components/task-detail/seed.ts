// Type definitions for the task-detail subsections (Plan, Diff, Validations).
// The previous SEED_PLAN/SEED_DIFF_FILES/SEED_VALIDATIONS constants have been
// removed — they were unconditionally rendered as the modal's "real" data
// even when no task was loaded, which made the UI look like fake user data.
// Real data flows from the backend task projection (task_history_export).

export type PlanState = 'proposed' | 'approved' | 'rejected';
export type RiskSeverity = 'low' | 'med' | 'high';
export type ValidationKind = 'install' | 'lint' | 'typecheck' | 'test' | 'build' | 'security' | 'manual';
export type ValidationVerdict = 'passed' | 'failed' | 'not_run';
export type DiffStatus = 'added' | 'removed' | 'modified';
export type DiffLineKind = 'ctx' | 'add' | 'del';

export interface PlanRisk {
  sev: RiskSeverity;
  text: string;
}

export interface PlanValidationStep {
  kind: ValidationKind;
  cmd: string;
}

export interface PlanData {
  state: PlanState;
  proposer: string;
  decider: string;
  decidedAt: string;
  proposedAt: string;
  summary: string;
  approach: string[];
  filesExpected: string[];
  risks: PlanRisk[];
  validation: PlanValidationStep[];
}

export interface DiffLine {
  t: DiffLineKind;
  n1?: number;
  n2?: number;
  c: string;
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffFileData {
  path: string;
  added: number;
  removed: number;
  status: DiffStatus;
  expected: boolean;
  drift?: boolean;
  hunks: DiffHunk[];
}

export interface ValidationData {
  id: string;
  kind: ValidationKind;
  cmd: string;
  verdict: ValidationVerdict;
  duration: string | null;
  exitCode: number | null;
  ranAt: string | null;
  ranBy: string | null;
  output?: string[];
}
