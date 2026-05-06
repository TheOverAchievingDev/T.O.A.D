export type CockpitValidationKind = 'install' | 'lint' | 'typecheck' | 'test' | 'build' | 'security';

export interface CockpitValidationRun {
  kind: CockpitValidationKind;
  command: string | null;
  exitCode: number | null;
  durationMs: number | null;
  verdict: 'passed' | 'failed' | 'not_run';
  stdout: string;
  stderr: string;
  createdAt?: string;
}

export const VALIDATION_KINDS: CockpitValidationKind[] = ['test', 'typecheck', 'lint', 'build', 'security', 'install'];

export function sortValidationRuns<T extends CockpitValidationRun>(runs: T[] | undefined): T[] {
  return [...(runs ?? [])].sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt));
}

export function validationSummary(runs: CockpitValidationRun[]): string {
  if (runs.length === 0) return 'No validations run';
  const passed = runs.filter((run) => run.verdict === 'passed').length;
  const failed = runs.filter((run) => run.verdict === 'failed').length;
  const notRun = runs.filter((run) => run.verdict === 'not_run').length;
  const parts = [`${passed} pass`];
  if (failed > 0) parts.push(`${failed} fail`);
  if (notRun > 0) parts.push(`${notRun} not run`);
  return parts.join(' / ');
}

export function validationOutputLines(run: CockpitValidationRun | null | undefined): string[] {
  if (!run) return [];
  return `${run.stdout ?? ''}\n${run.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function formatValidationDuration(durationMs: number | null | undefined): string | null {
  if (!Number.isFinite(durationMs ?? NaN)) return null;
  const ms = Math.max(0, Number(durationMs));
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatValidationTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}
