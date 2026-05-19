export type IdeDiagnosticSeverity = 'error' | 'warning' | 'info';

export type IdeDiagnostic = {
  source: 'ruff' | 'mypy' | string;
  code: string | null;
  severity: IdeDiagnosticSeverity;
  message: string;
  path: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  fixable: boolean;
};

export type IdeDiagnosticToolResult = {
  tool: string;
  available: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  message: string;
};

export type IdeDiagnosticsResult = {
  diagnostics: IdeDiagnostic[];
  toolResults: IdeDiagnosticToolResult[];
  generatedAt?: string;
};

export type IdeFileActionResult = IdeDiagnosticsResult & {
  changed?: boolean;
  file?: unknown;
};

export function isPythonPath(filePath: string): boolean {
  return normalizeDiagnosticPath(filePath).toLowerCase().endsWith('.py');
}

export function normalizeDiagnosticPath(filePath: string): string {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}

export function diagnosticKey(diagnostic: IdeDiagnostic): string {
  return [
    diagnostic.source,
    diagnostic.path,
    diagnostic.line,
    diagnostic.column,
    diagnostic.code ?? '',
    diagnostic.message,
  ].join(':');
}

export function diagnosticsForPath(
  diagnostics: IdeDiagnostic[],
  filePath: string,
): IdeDiagnostic[] {
  const normalizedPath = normalizeDiagnosticPath(filePath);
  return diagnostics
    .filter((diagnostic) => normalizeDiagnosticPath(diagnostic.path) === normalizedPath)
    .sort(compareDiagnostics);
}

export function countDiagnosticsBySeverity(diagnostics: IdeDiagnostic[]): {
  total: number;
  error: number;
  warning: number;
  info: number;
} {
  const counts = { total: diagnostics.length, error: 0, warning: 0, info: 0 };
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === 'error') counts.error += 1;
    else if (diagnostic.severity === 'warning') counts.warning += 1;
    else counts.info += 1;
  }
  return counts;
}

export function groupDiagnosticsByFile(diagnostics: IdeDiagnostic[]): Array<{
  path: string;
  diagnostics: IdeDiagnostic[];
}> {
  const groups = new Map<string, IdeDiagnostic[]>();
  for (const diagnostic of [...diagnostics].sort(compareDiagnostics)) {
    const filePath = normalizeDiagnosticPath(diagnostic.path);
    groups.set(filePath, [...(groups.get(filePath) ?? []), diagnostic]);
  }
  return [...groups.entries()].map(([filePath, fileDiagnostics]) => ({
    path: filePath,
    diagnostics: fileDiagnostics,
  }));
}

export function toMonacoMarkerData(
  diagnostic: IdeDiagnostic,
  markerSeverity: { Error: number; Warning: number; Info: number },
) {
  return {
    severity: diagnostic.severity === 'error'
      ? markerSeverity.Error
      : diagnostic.severity === 'warning'
        ? markerSeverity.Warning
        : markerSeverity.Info,
    message: diagnostic.code
      ? `[${diagnostic.source}:${diagnostic.code}] ${diagnostic.message}`
      : `[${diagnostic.source}] ${diagnostic.message}`,
    startLineNumber: positiveInt(diagnostic.line, 1),
    startColumn: positiveInt(diagnostic.column, 1),
    endLineNumber: positiveInt(diagnostic.endLine, positiveInt(diagnostic.line, 1)),
    endColumn: Math.max(
      positiveInt(diagnostic.endColumn, positiveInt(diagnostic.column, 1) + 1),
      positiveInt(diagnostic.column, 1) + 1,
    ),
    source: diagnostic.source,
    code: diagnostic.code ?? undefined,
  };
}

function compareDiagnostics(a: IdeDiagnostic, b: IdeDiagnostic): number {
  return normalizeDiagnosticPath(a.path).localeCompare(normalizeDiagnosticPath(b.path))
    || a.line - b.line
    || a.column - b.column
    || severityRank(a.severity) - severityRank(b.severity)
    || a.message.localeCompare(b.message);
}

function severityRank(severity: IdeDiagnosticSeverity): number {
  if (severity === 'error') return 0;
  if (severity === 'warning') return 1;
  return 2;
}

function positiveInt(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
