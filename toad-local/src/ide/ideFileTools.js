import {
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import path from 'node:path';

const IGNORED_DIR_NAMES = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.vite',
  'coverage',
]);

const LANGUAGE_HINTS = new Map([
  ['.js', 'javascript'],
  ['.jsx', 'javascriptreact'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescriptreact'],
  ['.json', 'json'],
  ['.md', 'markdown'],
  ['.css', 'css'],
  ['.html', 'html'],
  ['.rs', 'rust'],
  ['.sql', 'sql'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
]);

export function resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source = { kind: 'project' } }) {
  if (source.kind === 'task_worktree') {
    const task = taskBoard?.getTask?.({ teamId, taskId: source.taskId });
    const worktree = task?.worktree;
    if (worktree?.status !== 'created' || !worktree.path) {
      throw new Error('ide_tree_list: task worktree not found');
    }

    return {
      source,
      rootPath: path.resolve(worktree.path),
      rootLabel: task?.subject ? `Task ${source.taskId}: ${task.subject}` : `Task ${source.taskId}`,
    };
  }

  if (!projectCwd) {
    throw new Error('ide_tree_list: no projectCwd configured');
  }

  return {
    source,
    rootPath: path.resolve(projectCwd),
    rootLabel: 'Project root',
  };
}

export function listIdeTree({
  projectCwd,
  taskBoard,
  teamId,
  source = { kind: 'project' },
  maxEntries = 2000,
}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const allEntries = collectTreeEntries(root.rootPath, '');
  const entries = allEntries.slice(0, maxEntries);

  return {
    source: root.source,
    rootLabel: root.rootLabel,
    entries,
    truncated: allEntries.length > entries.length,
  };
}

export function readIdeFile({
  projectCwd,
  taskBoard,
  teamId,
  source = { kind: 'project' },
  relativePath,
  maxBytes = 1024 * 1024,
}) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const resolved = resolveInsideRoot(root.rootPath, relativePath);
  const stats = statSync(resolved.absolutePath);

  if (stats.isDirectory()) {
    throw new Error('ide_file_read: cannot read directory');
  }
  if (!stats.isFile()) {
    throw new Error('ide_file_read: not a file');
  }
  if (stats.size > maxBytes) {
    throw new Error('ide_file_read: file too large');
  }

  const bytes = readFileSync(resolved.absolutePath);
  if (isBinaryBuffer(bytes)) {
    throw new Error('ide_file_read: binary file');
  }

  const content = bytes.toString('utf8');
  if (content.includes('\uFFFD')) {
    throw new Error('ide_file_read: binary file');
  }

  return {
    source: root.source,
    relativePath: resolved.relativePath,
    content,
    encoding: 'utf8',
    sizeBytes: stats.size,
    languageHint: getLanguageHint(resolved.relativePath),
  };
}

function collectTreeEntries(rootPath, parentRelativePath) {
  const dirPath = parentRelativePath ? path.join(rootPath, parentRelativePath) : rootPath;
  const children = readdirSync(dirPath, { withFileTypes: true })
    .filter((child) => shouldListChild(parentRelativePath, child))
    .sort(compareDirectoryEntries);

  const entries = [];
  for (const child of children) {
    const childRelativePath = parentRelativePath
      ? path.join(parentRelativePath, child.name)
      : child.name;
    const normalizedPath = toPosixPath(childRelativePath);
    const childAbsolutePath = path.join(rootPath, childRelativePath);

    if (child.isDirectory()) {
      const descendantEntries = collectTreeEntries(rootPath, childRelativePath);
      entries.push({
        path: normalizedPath,
        name: child.name,
        kind: 'directory',
      });
      entries.push(...descendantEntries);
      continue;
    }

    if (!child.isFile()) {
      continue;
    }

    const stats = statSync(childAbsolutePath);
    entries.push({
      path: normalizedPath,
      name: child.name,
      kind: 'file',
      sizeBytes: stats.size,
    });
  }

  return entries;
}

function shouldListChild(parentRelativePath, child) {
  if (!child.isDirectory()) {
    return true;
  }

  if (IGNORED_DIR_NAMES.has(child.name)) {
    return false;
  }

  const relativePath = parentRelativePath ? path.join(parentRelativePath, child.name) : child.name;
  return toPosixPath(relativePath) !== '.toad/mcp-configs';
}

function compareDirectoryEntries(a, b) {
  if (a.isDirectory() !== b.isDirectory()) {
    return a.isDirectory() ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function resolveInsideRoot(rootPath, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('ide_file_read: path outside source root');
  }

  const absolutePath = path.resolve(rootPath, relativePath);
  const relativeToRoot = path.relative(rootPath, absolutePath);
  if (relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) {
    throw new Error('ide_file_read: path outside source root');
  }

  return {
    absolutePath,
    relativePath: toPosixPath(relativeToRoot),
  };
}

function isBinaryBuffer(bytes) {
  return bytes.includes(0);
}

function getLanguageHint(relativePath) {
  return LANGUAGE_HINTS.get(path.extname(relativePath).toLowerCase());
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}
