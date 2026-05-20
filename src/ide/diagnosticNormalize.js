import path from 'node:path';

export function normalizeDiagnosticPath(filePath, { rootPath } = {}) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    return '';
  }
  const normalizedRoot = typeof rootPath === 'string' && rootPath.length > 0
    ? path.resolve(rootPath)
    : null;
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : (normalizedRoot ? path.resolve(normalizedRoot, filePath) : path.normalize(filePath));
  const relativePath = normalizedRoot
    ? path.relative(normalizedRoot, absolutePath)
    : filePath;
  return toPosixPath(relativePath || path.basename(absolutePath));
}

export function normalizeDiagnostic(diagnostic) {
  const line = positiveIntegerOrDefault(diagnostic.line, 1);
  const column = positiveIntegerOrDefault(diagnostic.column, 1);
  const endLine = positiveIntegerOrDefault(diagnostic.endLine, line);
  const endColumn = positiveIntegerOrDefault(diagnostic.endColumn, column + 1);
  return {
    source: diagnostic.source,
    code: diagnostic.code || null,
    severity: diagnostic.severity || 'warning',
    message: diagnostic.message || 'Diagnostic',
    path: diagnostic.path,
    line,
    column,
    endLine,
    endColumn: endLine === line ? Math.max(endColumn, column + 1) : endColumn,
    fixable: Boolean(diagnostic.fixable),
  };
}

export function positiveIntegerOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}
