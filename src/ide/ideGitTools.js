import { execFileSync } from 'node:child_process';
import { resolveIdeSourceRoot } from './ideFileTools.js';
import path from 'node:path';
import { writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function withGitErrors(prefix, operation) {
  try {
    return operation();
  } catch (error) {
    throw new Error(`${prefix}: ${error.stderr?.toString() || error.message || 'git error'}`);
  }
}

export function getIdeStatus({ projectCwd, taskBoard, teamId, source }) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  
  let output;
  try {
    output = execFileSync('git', ['status', '--porcelain', '-z'], { cwd: root.rootPath, encoding: 'utf8' });
  } catch (error) {
    if (error.status !== null && error.status !== 0 && !error.stderr?.toString().includes('not a git repository')) {
      throw new Error(`ide_get_status: ${error.stderr?.toString() || error.message}`);
    }
    output = ''; // Handle non-git dirs gracefully if needed, or fail. Usually we want it to fail.
  }

  const entries = [];
  if (output) {
    const items = output.split('\0').filter(Boolean);
    // Git status -z format for renames is "XY orig_path\0new_path\0" but let's handle simple parsing:
    // If it's a rename, it's 2 parts. We'll simplify and just grab the status and path.
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.length < 3) continue;
      const status = item.slice(0, 2);
      const relativePath = item.slice(3);
      entries.push({ status, relativePath: toPosixPath(relativePath) });
      
      // If it's a rename/copy, the next null-terminated string is the orig path
      if (status[0] === 'R' || status[0] === 'C') {
         i++; // skip orig path
      }
    }
  }

  return { source: root.source, entries };
}

export function getIdeDiff({ projectCwd, taskBoard, teamId, source, relativePath }) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  
  const args = ['diff', 'HEAD'];
  if (relativePath) {
    args.push('--', relativePath);
  }

  let diffOutput;
  try {
    diffOutput = execFileSync('git', args, { cwd: root.rootPath, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch (error) {
    if (relativePath && isMissingHeadError(error)) {
      diffOutput = diffFileAgainstEmpty(root.rootPath, relativePath);
    } else {
      throw new Error(`ide_get_diff: ${error.stderr?.toString() || error.message || 'git error'}`);
    }
  }

  return { source: root.source, relativePath, diff: diffOutput };
}

export function createIdeCheckpoint({ projectCwd, taskBoard, teamId, source, message }) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  if (!message || typeof message !== 'string') {
    throw new Error('ide_checkpoint_task: message required');
  }

  return withGitErrors('ide_checkpoint_task', () => {
    execFileSync('git', ['add', '-A'], { cwd: root.rootPath });
    try {
      execFileSync('git', ['commit', '-m', message], { cwd: root.rootPath });
    } catch (e) {
      if (!e.stdout?.toString().includes('nothing to commit')) {
        throw e;
      }
    }
    const hash = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root.rootPath, encoding: 'utf8' }).trim();
    return { source: root.source, checkpointCommit: hash };
  });
}

export function applyIdePatch({ projectCwd, taskBoard, teamId, source, patchContent, reverse = false }) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  
  if (!patchContent || typeof patchContent !== 'string') {
    throw new Error('ide_apply_patch: patch content required');
  }

  const patchFile = path.join(root.rootPath, `.ide-patch-${randomUUID()}`);
  try {
    writeFileSync(patchFile, patchContent, 'utf8');
    withGitErrors('ide_apply_patch', () => {
      const args = ['apply', '--ignore-space-change', '--ignore-whitespace'];
      if (reverse) args.push('--reverse');
      args.push(patchFile);
      execFileSync('git', args, { cwd: root.rootPath });
    });
    return { source: root.source, success: true };
  } finally {
    try {
      unlinkSync(patchFile);
    } catch {}
  }
}

export function searchIdeFiles({ projectCwd, taskBoard, teamId, source, query }) {
  const root = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  
  if (!query || typeof query !== 'string') {
    throw new Error('ide_search_files: query required');
  }

  let output;
  try {
    output = execFileSync('git', ['grep', '-I', '-n', '-i', '--untracked', '-e', query], { cwd: root.rootPath, encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
  } catch (error) {
    if (error.status === 1) {
      output = '';
    } else {
      throw new Error(`ide_search_files: ${error.stderr?.toString() || error.message}`);
    }
  }

  const matches = [];
  if (output) {
    const lines = output.split('\n');
    for (const line of lines) {
      if (!line) continue;
      const firstColon = line.indexOf(':');
      if (firstColon === -1) continue;
      const secondColon = line.indexOf(':', firstColon + 1);
      if (secondColon === -1) continue;
      
      const relativePath = toPosixPath(line.slice(0, firstColon));
      const lineNumber = parseInt(line.slice(firstColon + 1, secondColon), 10);
      const content = line.slice(secondColon + 1);
      
      matches.push({ relativePath, lineNumber, content });
    }
  }

  return { source: root.source, matches };
}

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function isMissingHeadError(error) {
  const stderr = error?.stderr?.toString?.() || '';
  const message = error?.message || '';
  const text = `${stderr}\n${message}`.toLowerCase();
  return text.includes("bad revision 'head'")
    || text.includes('ambiguous argument \'head\'')
    || text.includes("could not access 'head'");
}

function diffFileAgainstEmpty(rootPath, relativePath) {
  const safeRelativePath = validateGitRelativePath(rootPath, relativePath);
  try {
    return execFileSync('git', ['diff', '--no-index', '--', '/dev/null', safeRelativePath], {
      cwd: rootPath,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (error) {
    if (error.status === 1) {
      return error.stdout?.toString?.() || '';
    }
    throw new Error(`ide_get_diff: ${error.stderr?.toString() || error.message || 'git error'}`);
  }
}

function validateGitRelativePath(rootPath, relativePath) {
  if (!relativePath || typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    throw new Error('ide_get_diff: path outside source root');
  }
  const absolutePath = path.resolve(rootPath, relativePath);
  const relativeToRoot = path.relative(rootPath, absolutePath);
  if (
    relativeToRoot === '..'
    || relativeToRoot.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToRoot)
  ) {
    throw new Error('ide_get_diff: path outside source root');
  }
  return toPosixPath(relativeToRoot);
}
