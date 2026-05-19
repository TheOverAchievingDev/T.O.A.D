import path from 'node:path';
import { runGit as defaultRunGit } from '../git/runGit.js';
import { resolveIdeSourceRoot } from './ideFileTools.js';

function toPosixPath(filePath) {
  return String(filePath).split(path.sep).join('/').replace(/\\/g, '/');
}

// Parse `git diff HEAD --numstat`: lines are "<add>\t<del>\t<path>".
// Binary files emit "-\t-\t<path>" (counts unknown → null, binary:true).
function parseNumstat(stdout) {
  const map = new Map();
  for (const rawLine of String(stdout).split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const addRaw = parts[0];
    const delRaw = parts[1];
    const filePath = toPosixPath(parts.slice(2).join('\t').trim());
    if (!filePath) continue;
    const binary = addRaw === '-' && delRaw === '-';
    map.set(filePath, {
      additions: binary ? null : Number.parseInt(addRaw, 10),
      deletions: binary ? null : Number.parseInt(delRaw, 10),
      binary,
    });
  }
  return map;
}

// Parse one `git status --porcelain` v1 line: "XY PATH".
// Untracked "?? PATH" → status '?'. Rename "R  old -> new" → new path.
function parsePorcelainLine(rawLine) {
  const line = rawLine.replace(/\r$/, '');
  if (line.length < 4) return null;
  const xy = line.slice(0, 2);
  let rest = line.slice(3);
  let status;
  if (xy === '??') {
    status = '?';
  } else {
    const trimmed = xy.trim();
    if (!trimmed) return null; // '  ' = clean; never appears in porcelain output
    status = trimmed.charAt(0);
  }
  // Note: a path literally containing ' -> ' would be mangled here.
  // Acceptable per spec §9 (ASCII paths assumed; quoted-path dequoting deferred).
  const arrowIdx = rest.indexOf(' -> ');
  if (arrowIdx !== -1) rest = rest.slice(arrowIdx + 4);
  const relativePath = toPosixPath(rest.trim());
  if (!relativePath) return null;
  return { status, relativePath };
}

/**
 * Working-tree change set vs HEAD for the resolved IDE source root.
 * Best-effort: source-resolution or git failure returns
 * { source, files: [], error } rather than throwing (mirrors getIdeStatus).
 *
 * Returns { source, files: IdeChangeEntry[], error? } where
 * IdeChangeEntry = { relativePath, status, additions, deletions, binary }.
 */
export function getIdeChangesSummary({
  projectCwd, taskBoard, teamId, source, runGit = defaultRunGit,
} = {}) {
  let root;
  try {
    root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  } catch (error) {
    return {
      source: source ?? null,
      files: [],
      error: error && error.message ? error.message : String(error),
    };
  }

  const numstatResult = runGit(['diff', 'HEAD', '--numstat'], { cwd: root.rootPath });
  if (numstatResult.exitCode !== 0) {
    return {
      source: root.source,
      files: [],
      error: numstatResult.stderr || 'git diff --numstat failed',
    };
  }
  const numstat = parseNumstat(numstatResult.stdout);

  const statusResult = runGit(['status', '--porcelain'], { cwd: root.rootPath });
  if (statusResult.exitCode !== 0) {
    return {
      source: root.source,
      files: [],
      error: statusResult.stderr || 'git status --porcelain failed',
    };
  }

  const files = [];
  for (const rawLine of String(statusResult.stdout).split('\n')) {
    if (!rawLine) continue;
    const parsed = parsePorcelainLine(rawLine);
    if (!parsed) continue;
    const stat = numstat.get(parsed.relativePath);
    files.push({
      relativePath: parsed.relativePath,
      status: parsed.status,
      additions: stat ? stat.additions : null,
      deletions: stat ? stat.deletions : null,
      binary: stat ? stat.binary : false,
    });
  }
  return { source: root.source, files };
}
