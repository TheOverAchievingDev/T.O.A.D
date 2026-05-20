import { normalizeDiagnostic, normalizeDiagnosticPath } from '../diagnosticNormalize.js';

export function parseEslintJsonDiagnostics(stdout, { rootPath } = {}) {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) return [];
  let files;
  try { files = JSON.parse(stdout); } catch { return []; }
  if (!Array.isArray(files)) return [];
  const out = [];
  for (const file of files) {
    const diagnosticPath = normalizeDiagnosticPath(file?.filePath, { rootPath });
    if (!diagnosticPath) continue;
    for (const m of Array.isArray(file?.messages) ? file.messages : []) {
      out.push(normalizeDiagnostic({
        source: 'eslint',
        code: typeof m?.ruleId === 'string' ? m.ruleId : null,
        severity: m?.severity === 2 ? 'error' : 'warning',
        message: typeof m?.message === 'string' ? m.message : 'ESLint diagnostic',
        path: diagnosticPath,
        line: m?.line,
        column: m?.column,
        endLine: m?.endLine,
        endColumn: m?.endColumn,
        fixable: Boolean(m?.fix),
      }));
    }
  }
  return out;
}

const TSC_LINE = /^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+(TS\d+):\s*(.*)$/;

export function parseTscDiagnostics(stdout, { rootPath } = {}) {
  if (typeof stdout !== 'string' || stdout.length === 0) return [];
  const out = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const match = TSC_LINE.exec(raw);
    if (!match) continue;
    const [, filePath, line, column, level, code, message] = match;
    const diagnosticPath = normalizeDiagnosticPath(filePath, { rootPath });
    if (!diagnosticPath || diagnosticPath.startsWith('../')) continue;
    out.push(normalizeDiagnostic({
      source: 'tsc',
      code,
      severity: level === 'warning' ? 'warning' : 'error',
      message,
      path: diagnosticPath,
      line: Number.parseInt(line, 10),
      column: Number.parseInt(column, 10),
      endLine: Number.parseInt(line, 10),
      endColumn: Number.parseInt(column, 10) + 1,
      fixable: false,
    }));
  }
  return out;
}
