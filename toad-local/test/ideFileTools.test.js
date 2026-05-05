import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  listIdeTree,
  readIdeFile,
  resolveIdeSourceRoot,
} from '../src/ide/ideFileTools.js';

function makeTmpProject() {
  const dir = mkdtempSync(join(tmpdir(), 'toad-ide-files-test-'));
  return {
    dir,
    cleanup() { try { rmSync(dir, { recursive: true, force: true }); } catch {} },
  };
}

function writeProjectFile(root, relativePath, content) {
  const fullPath = join(root, relativePath);
  mkdirSync(resolve(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content);
}

test('resolveIdeSourceRoot resolves project source from projectCwd', () => {
  const tmp = makeTmpProject();
  try {
    const result = resolveIdeSourceRoot({
      projectCwd: tmp.dir,
      source: { kind: 'project' },
    });

    assert.equal(result.rootPath, resolve(tmp.dir));
    assert.equal(result.rootLabel, 'Project root');
    assert.deepEqual(result.source, { kind: 'project' });
  } finally {
    tmp.cleanup();
  }
});

test('resolveIdeSourceRoot resolves task worktree source when created', () => {
  const tmp = makeTmpProject();
  try {
    const taskBoard = {
      getTask({ teamId, taskId }) {
        assert.equal(teamId, 'team-a');
        assert.equal(taskId, 'task-1');
        return {
          taskId: 'task-1',
          subject: 'Add editor',
          worktree: { status: 'created', path: tmp.dir },
        };
      },
    };

    const result = resolveIdeSourceRoot({
      projectCwd: 'ignored-for-task',
      taskBoard,
      teamId: 'team-a',
      source: { kind: 'task_worktree', taskId: 'task-1' },
    });

    assert.equal(result.rootPath, resolve(tmp.dir));
    assert.equal(result.rootLabel, 'Task task-1: Add editor');
    assert.deepEqual(result.source, { kind: 'task_worktree', taskId: 'task-1' });
  } finally {
    tmp.cleanup();
  }
});

test('resolveIdeSourceRoot rejects missing projectCwd', () => {
  assert.throws(
    () => resolveIdeSourceRoot({ source: { kind: 'project' } }),
    /ide_tree_list: no projectCwd configured/,
  );
});

test('resolveIdeSourceRoot rejects missing or uncreated task worktree', () => {
  const taskBoard = {
    getTask() {
      return { taskId: 'task-1', worktree: { status: 'skipped' } };
    },
  };

  assert.throws(
    () => resolveIdeSourceRoot({
      projectCwd: 'ignored-for-task',
      taskBoard,
      teamId: 'team-a',
      source: { kind: 'task_worktree', taskId: 'task-1' },
    }),
    /ide_tree_list: task worktree not found/,
  );
});

test('listIdeTree returns text project files and skips ignored directories including node_modules', () => {
  const tmp = makeTmpProject();
  try {
    mkdirSync(join(tmp.dir, 'src'), { recursive: true });
    writeProjectFile(tmp.dir, 'src/app.ts', 'export const app = true;\n');
    writeProjectFile(tmp.dir, 'README.md', '# TOAD\n');
    writeProjectFile(tmp.dir, 'node_modules/pkg/index.js', 'module.exports = {};\n');
    writeProjectFile(tmp.dir, '.git/config', '[core]\n');
    writeProjectFile(tmp.dir, '.toad/mcp-configs/server.json', '{}\n');

    const result = listIdeTree({
      projectCwd: tmp.dir,
      source: { kind: 'project' },
    });

    assert.equal(result.rootLabel, 'Project root');
    assert.equal(result.truncated, false);
    assert.ok(result.entries.some((entry) => entry.path === 'README.md'));
    assert.ok(result.entries.some((entry) => entry.path === 'src'));
    assert.ok(result.entries.some((entry) => entry.path === 'src/app.ts'));
    assert.equal(result.entries.some((entry) => entry.path.startsWith('node_modules/')), false);
    assert.equal(result.entries.some((entry) => entry.path.startsWith('.git/')), false);
    assert.equal(result.entries.some((entry) => entry.path.startsWith('.toad/mcp-configs/')), false);
    assert.equal(result.entries.find((entry) => entry.path === 'src').kind, 'directory');
    assert.equal(result.entries.find((entry) => entry.path === 'README.md').kind, 'file');
    assert.equal(typeof result.entries.find((entry) => entry.path === 'README.md').sizeBytes, 'number');
  } finally {
    tmp.cleanup();
  }
});

test('listIdeTree includes binary files as file entries', () => {
  const tmp = makeTmpProject();
  try {
    writeFileSync(join(tmp.dir, 'binary.dat'), Buffer.from([0, 1, 2, 3]));

    const result = listIdeTree({
      projectCwd: tmp.dir,
      source: { kind: 'project' },
    });

    const binaryEntry = result.entries.find((entry) => entry.path === 'binary.dat');
    assert.ok(binaryEntry);
    assert.equal(binaryEntry.kind, 'file');
    assert.equal(binaryEntry.name, 'binary.dat');
    assert.equal(binaryEntry.sizeBytes, 4);
  } finally {
    tmp.cleanup();
  }
});

test('listIdeTree includes empty non-ignored directories', () => {
  const tmp = makeTmpProject();
  try {
    mkdirSync(join(tmp.dir, 'empty-dir'), { recursive: true });

    const result = listIdeTree({
      projectCwd: tmp.dir,
      source: { kind: 'project' },
    });

    const emptyEntry = result.entries.find((entry) => entry.path === 'empty-dir');
    assert.ok(emptyEntry);
    assert.equal(emptyEntry.kind, 'directory');
    assert.equal(emptyEntry.name, 'empty-dir');
  } finally {
    tmp.cleanup();
  }
});

test('listIdeTree caps entries and reports truncated', () => {
  const tmp = makeTmpProject();
  try {
    writeProjectFile(tmp.dir, 'a.txt', 'a\n');
    writeProjectFile(tmp.dir, 'b.txt', 'b\n');
    writeProjectFile(tmp.dir, 'c.txt', 'c\n');

    const result = listIdeTree({
      projectCwd: tmp.dir,
      source: { kind: 'project' },
      maxEntries: 2,
    });

    assert.equal(result.entries.length, 2);
    assert.equal(result.truncated, true);
  } finally {
    tmp.cleanup();
  }
});

test('readIdeFile reads utf8 files with a language hint for TypeScript', () => {
  const tmp = makeTmpProject();
  try {
    writeProjectFile(tmp.dir, 'src/app.ts', 'const answer: number = 42;\n');

    const result = readIdeFile({
      projectCwd: tmp.dir,
      source: { kind: 'project' },
      relativePath: 'src/app.ts',
    });

    assert.deepEqual(result.source, { kind: 'project' });
    assert.equal(result.relativePath, 'src/app.ts');
    assert.equal(result.content, 'const answer: number = 42;\n');
    assert.equal(result.encoding, 'utf8');
    assert.equal(result.sizeBytes, Buffer.byteLength(result.content));
    assert.equal(result.languageHint, 'typescript');
  } finally {
    tmp.cleanup();
  }
});

test('readIdeFile rejects traversal outside source root', () => {
  const tmp = makeTmpProject();
  try {
    assert.throws(
      () => readIdeFile({
        projectCwd: tmp.dir,
        source: { kind: 'project' },
        relativePath: '../outside.txt',
      }),
      /ide_read_file: path outside source root/,
    );
  } finally {
    tmp.cleanup();
  }
});

test('readIdeFile rejects symlinks that resolve outside source root', (t) => {
  const tmp = makeTmpProject();
  const outside = makeTmpProject();
  try {
    writeProjectFile(outside.dir, 'secret.txt', 'outside\n');
    try {
      symlinkSync(join(outside.dir, 'secret.txt'), join(tmp.dir, 'linked-secret.txt'), 'file');
    } catch (error) {
      if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) {
        t.skip(`symlink creation unavailable: ${error.code}`);
        return;
      }
      throw error;
    }

    assert.throws(
      () => readIdeFile({
        projectCwd: tmp.dir,
        source: { kind: 'project' },
        relativePath: 'linked-secret.txt',
      }),
      /ide_read_file: path outside source root/,
    );
  } finally {
    outside.cleanup();
    tmp.cleanup();
  }
});

test('readIdeFile rejects binary files', () => {
  const tmp = makeTmpProject();
  try {
    writeFileSync(join(tmp.dir, 'data.bin'), Buffer.from([65, 0, 66, 67]));

    assert.throws(
      () => readIdeFile({
        projectCwd: tmp.dir,
        source: { kind: 'project' },
        relativePath: 'data.bin',
      }),
      /ide_read_file: binary file/,
    );
  } finally {
    tmp.cleanup();
  }
});

test('readIdeFile rejects files over maxBytes', () => {
  const tmp = makeTmpProject();
  try {
    writeProjectFile(tmp.dir, 'big.txt', '1234567890');

    assert.throws(
      () => readIdeFile({
        projectCwd: tmp.dir,
        source: { kind: 'project' },
        relativePath: 'big.txt',
        maxBytes: 5,
      }),
      /ide_read_file: file too large/,
    );
  } finally {
    tmp.cleanup();
  }
});
