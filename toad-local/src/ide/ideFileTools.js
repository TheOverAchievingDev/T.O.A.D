import {
  readdirSync,
  realpathSync,
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
  const state = {
    entries: [],
    maxEntries: Math.max(0, maxEntries),
    truncated: false,
  };
  collectTreeEntries(root.rootPath, '', state);

  return {
    source: root.source,
    rootLabel: root.rootLabel,
    entries: state.entries,
    truncated: state.truncated,
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
  const stats = withReadFileErrors(() => statSync(resolved.absolutePath));

  if (stats.isDirectory()) {
    throw new Error('ide_read_file: cannot read directory');
  }
  if (!stats.isFile()) {
    throw new Error('ide_read_file: not a file');
  }
  if (stats.size > maxBytes) {
    throw new Error('ide_read_file: file too large');
  }

  const bytes = withReadFileErrors(() => readFileSync(resolved.absolutePath));
  if (isBinaryBuffer(bytes)) {
    throw new Error('ide_read_file: binary file');
  }

  const content = bytes.toString('utf8');
  if (content.includes('\uFFFD')) {
    throw new Error('ide_read_file: binary file');
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

function collectTreeEntries(rootPath, parentRelativePath, state) {
  const dirPath = parentRelativePath ? path.join(rootPath, parentRelativePath) : rootPath;
  const children = readdirSync(dirPath, { withFileTypes: true })
    .filter((child) => shouldListChild(parentRelativePath, child))
    .sort(compareDirectoryEntries);

  for (let index = 0; index < children.length; index++) {
    const child = children[index];
    if (state.entries.length >= state.maxEntries) {
      state.truncated = children.slice(index).some(isVisibleTreeEntry);
      return;
    }

    const childRelativePath = parentRelativePath
      ? path.join(parentRelativePath, child.name)
      : child.name;
    const normalizedPath = toPosixPath(childRelativePath);
    const childAbsolutePath = path.join(rootPath, childRelativePath);
    const hasLaterVisibleSibling = children.slice(index + 1).some(isVisibleTreeEntry);

    if (child.isDirectory()) {
      state.entries.push({
        path: normalizedPath,
        name: child.name,
        kind: 'directory',
      });
      if (state.entries.length >= state.maxEntries) {
        state.truncated = true;
        return;
      }
      collectTreeEntries(rootPath, childRelativePath, state);
      if (state.truncated) {
        return;
      }
      continue;
    }

    if (!child.isFile()) {
      continue;
    }

    const stats = statSync(childAbsolutePath);
    state.entries.push({
      path: normalizedPath,
      name: child.name,
      kind: 'file',
      sizeBytes: stats.size,
    });
    if (state.entries.length >= state.maxEntries && hasLaterVisibleSibling) {
      state.truncated = true;
      return;
    }
  }
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

function isVisibleTreeEntry(child) {
  return child.isDirectory() || child.isFile();
}

function resolveInsideRoot(rootPath, relativePath) {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error('ide_read_file: path outside source root');
  }

  const absolutePath = path.resolve(rootPath, relativePath);
  const relativeToRoot = path.relative(rootPath, absolutePath);
  if (isOutsideRoot(relativeToRoot)) {
    throw new Error('ide_read_file: path outside source root');
  }

  const realRootPath = withReadFileErrors(() => realpathSync(rootPath));
  const realTargetPath = withReadFileErrors(() => realpathSync(absolutePath));
  const realRelativeToRoot = path.relative(realRootPath, realTargetPath);
  if (isOutsideRoot(realRelativeToRoot)) {
    throw new Error('ide_read_file: path outside source root');
  }

  return {
    absolutePath: realTargetPath,
    relativePath: toPosixPath(relativeToRoot),
  };
}

function isOutsideRoot(relativePath) {
  return relativePath === '..'
    || relativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativePath);
}

function withReadFileErrors(operation) {
  try {
    return operation();
  } catch (error) {
    if (error?.message?.startsWith('ide_read_file:')) {
      throw error;
    }
    throw new Error(`ide_read_file: ${error?.message || 'filesystem error'}`);
  }
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
