import { normalizeDiagnostic, normalizeDiagnosticPath } from '../diagnosticNormalize.js';

export { normalizeDiagnosticPath };

export function parseRuffJsonDiagnostics(stdout, { rootPath } = {}) {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) {
    return [];
  }

  let items;
  try {
    items = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(items)) {
    return [];
  }

  return items
    .map((item) => {
      const diagnosticPath = normalizeDiagnosticPath(item?.filename, { rootPath });
      if (!diagnosticPath) {
        return null;
      }
      const code = typeof item?.code === 'string' ? item.code : null;
      return normalizeDiagnostic({
        source: 'ruff',
        code,
        severity: severityForRuffCode(code, item?.message),
        message: typeof item?.message === 'string' ? item.message : 'Ruff diagnostic',
        path: diagnosticPath,
        line: item?.location?.row,
        column: item?.location?.column,
        endLine: item?.end_location?.row,
        endColumn: item?.end_location?.column,
        fixable: Boolean(item?.fix),
      });
    })
    .filter(Boolean);
}

export function parseMypyDiagnostics(stdout, { rootPath } = {}) {
  if (typeof stdout !== 'string' || stdout.length === 0) {
    return [];
  }

  const diagnostics = [];
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(.*?):(\d+)(?::(\d+))?:\s*(error|note|warning):\s*(.*)$/.exec(line);
    if (!match) {
      continue;
    }

    const [, filePath, lineNumber, columnNumber, level, rawMessage] = match;
    const codeMatch = /\s+\[([^\]]+)\]\s*$/.exec(rawMessage);
    const message = codeMatch
      ? rawMessage.slice(0, codeMatch.index).trimEnd()
      : rawMessage;

    diagnostics.push(normalizeDiagnostic({
      source: 'mypy',
      code: codeMatch ? codeMatch[1] : null,
      severity: severityForMypyLevel(level),
      message,
      path: normalizeDiagnosticPath(filePath, { rootPath }),
      line: Number.parseInt(lineNumber, 10),
      column: columnNumber ? Number.parseInt(columnNumber, 10) : 1,
      endLine: Number.parseInt(lineNumber, 10),
      endColumn: columnNumber ? Number.parseInt(columnNumber, 10) + 1 : 1,
      fixable: false,
    }));
  }
  return diagnostics;
}

function severityForRuffCode(code, message) {
  if (typeof code === 'string' && code.startsWith('E9')) {
    return 'error';
  }
  if (typeof message === 'string' && /syntax|parse/i.test(message)) {
    return 'error';
  }
  return 'warning';
}

function severityForMypyLevel(level) {
  if (level === 'error') return 'error';
  if (level === 'warning') return 'warning';
  return 'info';
}

