# IDE Phase 2 Slice A — Monaco Reading Surface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only `Code` screen that browses the selected team's project root or a task worktree and opens text files in a locally bundled Monaco editor.

**Architecture:** File access stays behind the orchestrator boundary: React calls `callTool()`, HTTP dispatches into `LocalToolFacade`, and backend helpers resolve safe project/worktree roots. The UI owns only ephemeral editor state: selected source, selected path, tree loading, and Monaco display.

**Tech Stack:** Node ESM backend, SQLite task projections, React 18 + TypeScript + Vite, `monaco-editor` and `@monaco-editor/react` bundled locally.

---

## File Structure

Backend:

- Create `src/ide/ideFileTools.js` — pure helpers for source resolution, safe path checks, tree listing, binary detection, and file reads.
- Modify `src/commands/command-contract.js` — add `IDE_TREE_LIST` and `IDE_READ_FILE` as read-only commands.
- Verify `src/security/roleAuthority.js` — no code change required because `human` and `lead` already have wildcard authority; add regression tests that developer roles cannot call the operator-only IDE tools.
- Modify `src/tools/localToolFacade.js` — dispatch `ide_tree_list` and `ide_read_file` through the helper.
- Modify `src/mcp/localToolDefinitions.js` — expose both commands for agent/MCP callers.
- Test in `test/ideFileTools.test.js`, `test/localToolFacade.test.js`, `test/localMcpToolDefinitions.test.js`, and `test/roleAuthority.test.js`.

Frontend:

- Create `ui/src/components/CodeScreen.tsx` — source selector, refresh button, tree list, Monaco editor pane.
- Modify `ui/package.json` / `ui/package-lock.json` — add `monaco-editor` and `@monaco-editor/react`.
- Modify `ui/vite.config.ts` — configure local Monaco workers.
- Create `ui/src/vite-env.d.ts` — add Vite client types for `?worker` imports.
- Modify `ui/src/types/index.ts` — add optional worktree metadata to `UiTask` and add `code` to `Tweaks.screen`.
- Modify `ui/src/hooks/useToadData.ts` — preserve backend task `worktree` data in normalized UI tasks.
- Modify `ui/src/components/SidebarNav.tsx` — add `code` to `SidebarKey` and default nav.
- Modify `ui/src/App.tsx` — render `CodeScreen` when `tweaks.screen === 'code'`.
- Modify `ui/src/styles/app-shell.css` — add Code view layout and tree styles.

---

### Task 1: Backend Pure IDE File Helpers

**Files:**
- Create: `src/ide/ideFileTools.js`
- Test: `test/ideFileTools.test.js`

- [ ] **Step 1: Write failing helper tests**

Create `test/ideFileTools.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import {
  listIdeTree,
  readIdeFile,
  resolveIdeSourceRoot,
} from '../src/ide/ideFileTools.js';

async function makeProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-ide-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  await fs.writeFile(path.join(root, 'README.md'), '# Hello\n', 'utf8');
  await fs.writeFile(path.join(root, 'src', 'app.ts'), 'export const ok = true;\n', 'utf8');
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'ignored\n', 'utf8');
  await fs.writeFile(path.join(root, 'binary.dat'), Buffer.from([0, 1, 2, 3]));
  return root;
}

test('resolveIdeSourceRoot resolves project source from projectCwd', async () => {
  const projectCwd = await makeProject();
  const source = resolveIdeSourceRoot({
    projectCwd,
    taskBoard: null,
    teamId: 'team-a',
    source: { kind: 'project' },
  });
  assert.equal(source.rootPath, projectCwd);
  assert.equal(source.rootLabel, 'Project root');
});

test('resolveIdeSourceRoot resolves task worktree source from task projection', async () => {
  const worktreePath = await makeProject();
  const taskBoard = {
    getTask({ teamId, taskId }) {
      assert.equal(teamId, 'team-a');
      assert.equal(taskId, 'T-1');
      return {
        taskId,
        subject: 'Implement feature',
        worktree: { status: 'created', path: worktreePath },
      };
    },
  };
  const source = resolveIdeSourceRoot({
    projectCwd: 'unused',
    taskBoard,
    teamId: 'team-a',
    source: { kind: 'task_worktree', taskId: 'T-1' },
  });
  assert.equal(source.rootPath, worktreePath);
  assert.equal(source.rootLabel, 'T-1 — Implement feature');
});

test('listIdeTree returns text project files and skips ignored directories', async () => {
  const projectCwd = await makeProject();
  const result = await listIdeTree({
    projectCwd,
    taskBoard: null,
    teamId: 'team-a',
    source: { kind: 'project' },
  });
  assert.equal(result.truncated, false);
  assert.ok(result.entries.some((e) => e.path === 'README.md' && e.kind === 'file'));
  assert.ok(result.entries.some((e) => e.path === 'src/app.ts' && e.kind === 'file'));
  assert.equal(result.entries.some((e) => e.path.includes('node_modules')), false);
});

test('listIdeTree caps entries and reports truncated', async () => {
  const projectCwd = await makeProject();
  const result = await listIdeTree({
    projectCwd,
    taskBoard: null,
    teamId: 'team-a',
    source: { kind: 'project' },
    maxEntries: 1,
  });
  assert.equal(result.entries.length, 1);
  assert.equal(result.truncated, true);
});

test('readIdeFile reads utf8 files with language hint', async () => {
  const projectCwd = await makeProject();
  const result = await readIdeFile({
    projectCwd,
    taskBoard: null,
    teamId: 'team-a',
    source: { kind: 'project' },
    relativePath: 'src/app.ts',
  });
  assert.equal(result.content, 'export const ok = true;\n');
  assert.equal(result.encoding, 'utf8');
  assert.equal(result.languageHint, 'typescript');
});

test('readIdeFile rejects traversal outside source root', async () => {
  const projectCwd = await makeProject();
  await assert.rejects(
    () => readIdeFile({
      projectCwd,
      taskBoard: null,
      teamId: 'team-a',
      source: { kind: 'project' },
      relativePath: '../outside.txt',
    }),
    /path escapes source root/,
  );
});

test('readIdeFile rejects binary files', async () => {
  const projectCwd = await makeProject();
  await assert.rejects(
    () => readIdeFile({
      projectCwd,
      taskBoard: null,
      teamId: 'team-a',
      source: { kind: 'project' },
      relativePath: 'binary.dat',
    }),
    /binary files are not supported/,
  );
});
```

- [ ] **Step 2: Run helper tests to verify RED**

Run: `node --no-warnings test/ideFileTools.test.js`

Expected: FAIL with module-not-found for `src/ide/ideFileTools.js`.

- [ ] **Step 3: Implement helper module**

Create `src/ide/ideFileTools.js`:

```js
import { promises as fs } from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_ENTRIES = 2000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.vite', 'coverage']);
const LANGUAGE_BY_EXT = new Map([
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.ts', 'typescript'],
  ['.tsx', 'typescript'],
  ['.json', 'json'],
  ['.md', 'markdown'],
  ['.css', 'css'],
  ['.html', 'html'],
  ['.rs', 'rust'],
  ['.sql', 'sql'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
]);

export function resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source } = {}) {
  const normalized = normalizeSource(source);
  if (normalized.kind === 'project') {
    if (typeof projectCwd !== 'string' || projectCwd.trim().length === 0) {
      throw new Error('ide_tree_list: no projectCwd configured');
    }
    return { source: normalized, rootPath: path.resolve(projectCwd), rootLabel: 'Project root' };
  }

  const task = taskBoard?.getTask?.({ teamId, taskId: normalized.taskId });
  const wt = task?.worktree;
  if (!wt || wt.status !== 'created' || typeof wt.path !== 'string' || wt.path.length === 0) {
    throw new Error('ide_tree_list: task worktree not found');
  }
  const subject = typeof task.subject === 'string' && task.subject.length > 0 ? ` — ${task.subject}` : '';
  return {
    source: normalized,
    rootPath: path.resolve(wt.path),
    rootLabel: `${normalized.taskId}${subject}`,
  };
}

export async function listIdeTree({ projectCwd, taskBoard, teamId, source, maxEntries = DEFAULT_MAX_ENTRIES } = {}) {
  const resolved = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const entries = [];
  let truncated = false;

  async function walk(dir, relativeDir = '') {
    if (entries.length >= maxEntries) {
      truncated = true;
      return;
    }
    const dirents = await fs.readdir(dir, { withFileTypes: true });
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const dirent of dirents) {
      if (entries.length >= maxEntries) {
        truncated = true;
        return;
      }
      if (dirent.isDirectory() && shouldIgnoreDir(relativeDir, dirent.name)) continue;
      const rel = relativeDir ? `${relativeDir}/${dirent.name}` : dirent.name;
      const abs = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        entries.push({ path: rel, name: dirent.name, kind: 'directory' });
        await walk(abs, rel);
      } else if (dirent.isFile()) {
        const stat = await fs.stat(abs);
        entries.push({ path: rel, name: dirent.name, kind: 'file', sizeBytes: stat.size });
      }
    }
  }

  await walk(resolved.rootPath);
  return {
    source: resolved.source,
    rootLabel: resolved.rootLabel,
    entries,
    truncated,
  };
}

export async function readIdeFile({ projectCwd, taskBoard, teamId, source, relativePath, maxBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  const resolved = resolveIdeSourceRoot({ projectCwd, taskBoard, teamId, source });
  const abs = safeResolve(resolved.rootPath, relativePath);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error('ide_read_file: path is not a file');
  if (stat.size > maxBytes) throw new Error('ide_read_file: file is too large');
  const buffer = await fs.readFile(abs);
  if (buffer.includes(0)) throw new Error('ide_read_file: binary files are not supported in Slice A');
  const content = buffer.toString('utf8');
  if (content.includes('\uFFFD')) throw new Error('ide_read_file: binary files are not supported in Slice A');
  return {
    source: resolved.source,
    relativePath: toPosixPath(path.relative(resolved.rootPath, abs)),
    content,
    encoding: 'utf8',
    sizeBytes: stat.size,
    languageHint: LANGUAGE_BY_EXT.get(path.extname(abs).toLowerCase()),
  };
}

function normalizeSource(source) {
  if (!source || typeof source !== 'object' || source.kind === 'project' || source.kind == null) {
    return { kind: 'project' };
  }
  if (source.kind === 'task_worktree' && typeof source.taskId === 'string' && source.taskId.length > 0) {
    return { kind: 'task_worktree', taskId: source.taskId };
  }
  throw new Error('ide source must be project or task_worktree');
}

function safeResolve(rootPath, relativePath) {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('ide_read_file: relativePath is required');
  }
  if (path.isAbsolute(relativePath)) throw new Error('ide_read_file: path escapes source root');
  const root = path.resolve(rootPath);
  const abs = path.resolve(root, relativePath);
  const rel = path.relative(root, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('ide_read_file: path escapes source root');
  }
  return abs;
}

function shouldIgnoreDir(relativeDir, name) {
  if (IGNORED_DIRS.has(name)) return true;
  return relativeDir === '.toad' && name === 'mcp-configs';
}

function toPosixPath(value) {
  return value.split(path.sep).join('/');
}
```

- [ ] **Step 4: Run helper tests to verify GREEN**

Run: `node --no-warnings test/ideFileTools.test.js`

Expected: PASS.

- [ ] **Step 5: Commit helper module**

```bash
git add toad-local/src/ide/ideFileTools.js toad-local/test/ideFileTools.test.js
git commit -m "feat(ide): add read-only file helpers"
```

---

### Task 2: Backend Command, Facade, Authority, and MCP Wiring

**Files:**
- Modify: `src/commands/command-contract.js`
- Modify: `src/tools/localToolFacade.js`
- Modify: `src/mcp/localToolDefinitions.js`
- Test: `test/localToolFacade.test.js`
- Test: `test/localMcpToolDefinitions.test.js`
- Test: `test/roleAuthority.test.js`

- [ ] **Step 1: Write failing facade tests**

Append to `test/localToolFacade.test.js`:

```js
test('LocalToolFacade ide_tree_list returns project files through the facade', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-facade-ide-'));
  await fs.writeFile(path.join(tmpRoot, 'README.md'), '# Project\n', 'utf8');
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    projectCwd: tmpRoot,
  });

  const result = await facade.execute({
    commandName: COMMANDS.IDE_TREE_LIST,
    actor: { teamId: 'team-a', agentId: 'ui', role: 'human' },
    args: { source: { kind: 'project' } },
  });

  assert.equal(result.rootLabel, 'Project root');
  assert.ok(result.entries.some((e) => e.path === 'README.md'));
});

test('LocalToolFacade ide_read_file reads project file through the facade', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-facade-ide-'));
  await fs.writeFile(path.join(tmpRoot, 'README.md'), '# Project\n', 'utf8');
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    projectCwd: tmpRoot,
  });

  const result = await facade.execute({
    commandName: COMMANDS.IDE_READ_FILE,
    actor: { teamId: 'team-a', agentId: 'ui', role: 'human' },
    args: { source: { kind: 'project' }, relativePath: 'README.md' },
  });

  assert.equal(result.content, '# Project\n');
  assert.equal(result.relativePath, 'README.md');
});
```

- [ ] **Step 2: Write failing MCP and role tests**

In `test/localMcpToolDefinitions.test.js`, add `ide_tree_list` and `ide_read_file` to the expected sorted names array. Add this test:

```js
test('ide MCP tools are read-only and do not require idempotencyKey', () => {
  for (const name of ['ide_tree_list', 'ide_read_file']) {
    const tool = getLocalMcpTool(name);
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.inputSchema.required.includes('idempotencyKey'), false);
  }
});
```

In `test/roleAuthority.test.js`, add:

```js
test('ide read tools are operator-only in Slice A', () => {
  for (const role of ['human', 'lead']) {
    assert.doesNotThrow(() => assertRoleCanCallTool({ role, toolName: 'ide_tree_list' }));
    assert.doesNotThrow(() => assertRoleCanCallTool({ role, toolName: 'ide_read_file' }));
  }
  assert.throws(
    () => assertRoleCanCallTool({ role: 'developer', toolName: 'ide_read_file' }),
    /developer cannot call ide_read_file/,
  );
});
```

- [ ] **Step 3: Run tests to verify RED**

Run:

```bash
node --no-warnings test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
node test/roleAuthority.test.js
```

Expected: FAIL because the commands and MCP definitions are missing.

- [ ] **Step 4: Add command constants**

In `src/commands/command-contract.js`, add:

```js
IDE_TREE_LIST: 'ide_tree_list',
IDE_READ_FILE: 'ide_read_file',
```

Do not add either command to `MUTATING_COMMANDS`.
Do not add either command to `COMMON_READ_TOOLS`; Slice A is an operator UI surface and `human` / `lead` already have wildcard authority.

- [ ] **Step 5: Wire facade dispatch**

In `src/tools/localToolFacade.js`, import:

```js
import { listIdeTree, readIdeFile } from '../ide/ideFileTools.js';
```

Add dispatch cases:

```js
case COMMANDS.IDE_TREE_LIST:
  return this.#ideTreeList(actor, args);
case COMMANDS.IDE_READ_FILE:
  return this.#ideReadFile(actor, args);
```

Add methods:

```js
async #ideTreeList(actor, args) {
  return listIdeTree({
    projectCwd: this.projectCwd,
    taskBoard: this.taskBoard,
    teamId: actor.teamId,
    source: args.source,
    maxEntries: typeof args.maxEntries === 'number' ? args.maxEntries : undefined,
  });
}

async #ideReadFile(actor, args) {
  return readIdeFile({
    projectCwd: this.projectCwd,
    taskBoard: this.taskBoard,
    teamId: actor.teamId,
    source: args.source,
    relativePath: requireString(args.relativePath, 'args.relativePath'),
  });
}
```

- [ ] **Step 6: Add MCP definitions**

In `src/mcp/localToolDefinitions.js`, add two tool definitions:

```js
makeTool({
  name: COMMANDS.IDE_TREE_LIST,
  title: 'IDE Tree List',
  description: 'Read-only. Lists files under the selected project root or task worktree for the Code view.',
  required: [],
  properties: {
    source: IDE_SOURCE_SCHEMA,
    maxEntries: { type: 'integer', minimum: 1, maximum: 10000 },
  },
}),
```

```js
makeTool({
  name: COMMANDS.IDE_READ_FILE,
  title: 'IDE Read File',
  description: 'Read-only. Reads a UTF-8 text file from the selected project root or task worktree for the Code view.',
  required: ['relativePath'],
  properties: {
    source: IDE_SOURCE_SCHEMA,
    relativePath: { type: 'string', minLength: 1 },
  },
}),
```

Define `IDE_SOURCE_SCHEMA` near the other shared uppercase schemas:

```js
const IDE_SOURCE_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    kind: { type: 'string', enum: ['project', 'task_worktree'] },
    taskId: { type: 'string', minLength: 1 },
  },
});
```

- [ ] **Step 7: Run backend wiring tests to verify GREEN**

Run:

```bash
node --no-warnings test/ideFileTools.test.js
node --no-warnings test/localToolFacade.test.js
node test/localMcpToolDefinitions.test.js
node test/roleAuthority.test.js
```

Expected: PASS.

- [ ] **Step 8: Commit backend command wiring**

```bash
git add toad-local/src/commands/command-contract.js toad-local/src/tools/localToolFacade.js toad-local/src/mcp/localToolDefinitions.js toad-local/test/localToolFacade.test.js toad-local/test/localMcpToolDefinitions.test.js toad-local/test/roleAuthority.test.js
git commit -m "feat(ide): expose read-only file tools"
```

---

### Task 3: Monaco Dependency and Vite Worker Setup

**Files:**
- Modify: `ui/package.json`
- Modify: `ui/package-lock.json`
- Modify: `ui/vite.config.ts`
- Create: `ui/src/vite-env.d.ts`

- [ ] **Step 1: Install Monaco locally**

Run:

```bash
cd C:\Project-TOAD\toad-local\ui
npm install monaco-editor @monaco-editor/react
```

Expected: `monaco-editor` and `@monaco-editor/react` appear in `dependencies`.

- [ ] **Step 2: Add Vite client worker types**

Create `ui/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 3: Configure local Monaco workers**

Modify `ui/vite.config.ts` by adding worker optimization:

```ts
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['monaco-editor', '@monaco-editor/react'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  // existing build and server config remains unchanged
});
```

The `CodeScreen` task will import workers using Vite's `?worker` syntax, so no CDN loader is used.

- [ ] **Step 4: Verify dependency build**

Run:

```bash
cd C:\Project-TOAD\toad-local\ui
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit Monaco setup**

```bash
git add toad-local/ui/package.json toad-local/ui/package-lock.json toad-local/ui/vite.config.ts toad-local/ui/src/vite-env.d.ts
git commit -m "build(ui): bundle monaco locally"
```

---

### Task 4: Code Screen Component

**Files:**
- Create: `ui/src/components/CodeScreen.tsx`
- Modify: `ui/src/styles/app-shell.css`

- [ ] **Step 1: Write the component**

Create `ui/src/components/CodeScreen.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react';
import * as monaco from 'monaco-editor';
import Editor, { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import { callTool, type Actor } from '@/api/client';
import type { UiTask } from '@/types';
import { Icon } from './Icon';

loader.config({ monaco });

type MonacoWorkerEnvironment = {
  getWorker(workerId: string, label: string): Worker;
};

declare global {
  interface Window {
    MonacoEnvironment?: MonacoWorkerEnvironment;
  }
}

window.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

type IdeSource =
  | { kind: 'project' }
  | { kind: 'task_worktree'; taskId: string };

interface IdeTreeEntry {
  path: string;
  name: string;
  kind: 'file' | 'directory';
  sizeBytes?: number;
}

interface IdeTreeResult {
  source: IdeSource;
  rootLabel: string;
  entries: IdeTreeEntry[];
  truncated: boolean;
}

interface IdeFileResult {
  relativePath: string;
  content: string;
  encoding: 'utf8';
  sizeBytes: number;
  languageHint?: string;
}

type CodeTask = UiTask & {
  worktree?: {
    status?: string;
    path?: string;
    branch?: string | null;
  } | null;
};

interface CodeScreenProps {
  teamId: string | null;
  tasks: CodeTask[];
  actor?: Actor;
}

const DEFAULT_ACTOR: Actor = { teamId: 'system', agentId: 'ui-client', role: 'human' };

export function CodeScreen({ teamId, tasks, actor = DEFAULT_ACTOR }: CodeScreenProps) {
  const [sourceKey, setSourceKey] = useState('project');
  const [tree, setTree] = useState<IdeTreeResult | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<IdeFileResult | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [loadingTree, setLoadingTree] = useState(false);
  const [loadingFile, setLoadingFile] = useState(false);

  const worktreeTasks = useMemo(
    () => tasks.filter((t) => t.worktree?.status === 'created' && t.worktree.path),
    [tasks],
  );
  const source = useMemo<IdeSource>(() => {
    if (sourceKey.startsWith('task:')) return { kind: 'task_worktree', taskId: sourceKey.slice(5) };
    return { kind: 'project' };
  }, [sourceKey]);

  async function refreshTree(pathToReopen = selectedPath) {
    if (!teamId) return;
    setLoadingTree(true);
    setTreeError(null);
    try {
      const result = await callTool<IdeTreeResult>({
        actor: {
          teamId,
          agentId: actor.agentId,
          agentName: actor.agentName,
          role: actor.role,
        },
        method: 'ide_tree_list',
        args: { source },
      });
      setTree(result);
      if (pathToReopen && result.entries.some((e) => e.path === pathToReopen && e.kind === 'file')) {
        await openFile(pathToReopen);
      } else {
        setSelectedPath(null);
        setFile(null);
      }
    } catch (err) {
      setTreeError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingTree(false);
    }
  }

  async function openFile(relativePath: string) {
    if (!teamId) return;
    setSelectedPath(relativePath);
    setLoadingFile(true);
    setFileError(null);
    try {
      const result = await callTool<IdeFileResult>({
        actor: {
          teamId,
          agentId: actor.agentId,
          agentName: actor.agentName,
          role: actor.role,
        },
        method: 'ide_read_file',
        args: { source, relativePath },
      });
      setFile(result);
    } catch (err) {
      setFile(null);
      setFileError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingFile(false);
    }
  }

  useEffect(() => {
    setSelectedPath(null);
    setFile(null);
    void refreshTree(null);
  }, [teamId, sourceKey]);

  if (!teamId) {
    return <div className="empty-state code-empty">Select a team to browse code.</div>;
  }

  return (
    <div className="code-screen">
      <header className="code-header">
        <div>
          <h1>Code</h1>
          <p>{tree?.rootLabel ?? 'Read-only project browser'}</p>
        </div>
        <div className="code-actions">
          <select className="field-input mono" value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
            <option value="project">Project root</option>
            {worktreeTasks.map((task) => (
              <option key={task.id} value={`task:${task.id}`}>
                {task.id} — {task.title}
              </option>
            ))}
          </select>
          <button className="btn" type="button" onClick={() => void refreshTree()}>
            <Icon name="refresh" size={12} /> Refresh
          </button>
        </div>
      </header>
      <div className="code-body">
        <aside className="code-tree">
          {loadingTree && <div className="code-muted">Loading files…</div>}
          {treeError && <div className="code-error">{treeError}</div>}
          {tree?.truncated && <div className="code-muted">Tree truncated at the backend entry cap.</div>}
          {tree && tree.entries.filter((e) => e.kind === 'file').length === 0 && (
            <div className="code-muted">No readable files found.</div>
          )}
          {tree?.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className={`code-tree-row ${entry.kind} ${selectedPath === entry.path ? 'active' : ''}`}
              disabled={entry.kind !== 'file'}
              onClick={() => void openFile(entry.path)}
            >
              <span>{entry.kind === 'directory' ? '▸' : ''}</span>
              <span className="code-tree-path">{entry.path}</span>
            </button>
          ))}
        </aside>
        <main className="code-editor-pane">
          <div className="code-filebar">
            <span className="mono">{selectedPath ?? 'No file selected'}</span>
            {file && <span className="dim">{formatBytes(file.sizeBytes)}</span>}
          </div>
          {loadingFile && <div className="code-editor-state">Loading file…</div>}
          {fileError && <div className="code-editor-state error">{fileError}</div>}
          {!loadingFile && !fileError && !file && <div className="code-editor-state">Select a file to inspect it.</div>}
          {file && (
            <Editor
              height="100%"
              value={file.content}
              language={file.languageHint ?? languageFromPath(file.relativePath)}
              theme="vs-dark"
              options={{
                readOnly: true,
                minimap: { enabled: false },
                automaticLayout: true,
                scrollBeyondLastLine: false,
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function languageFromPath(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (ext === 'ts' || ext === 'tsx') return 'typescript';
  if (ext === 'js' || ext === 'jsx') return 'javascript';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'markdown';
  if (ext === 'css') return 'css';
  if (ext === 'html') return 'html';
  if (ext === 'yml' || ext === 'yaml') return 'yaml';
  return 'plaintext';
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 2: Add Code screen styles**

Append to `ui/src/styles/app-shell.css`:

```css
.code-screen {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}

.code-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 22px;
  border-bottom: 1px solid var(--border-soft);
}

.code-header h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 650;
}

.code-header p {
  margin: 4px 0 0;
  color: var(--fg-muted);
  font-size: 12px;
}

.code-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.code-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(220px, 320px) minmax(0, 1fr);
}

.code-tree {
  min-height: 0;
  overflow: auto;
  border-right: 1px solid var(--border-soft);
  padding: 10px;
}

.code-tree-row {
  width: 100%;
  display: grid;
  grid-template-columns: 14px minmax(0, 1fr);
  align-items: center;
  gap: 4px;
  border: 0;
  background: transparent;
  color: var(--fg-muted);
  text-align: left;
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 5px 6px;
  border-radius: 5px;
}

.code-tree-row.file {
  color: var(--fg);
  cursor: pointer;
}

.code-tree-row.file:hover,
.code-tree-row.active {
  background: rgba(255,255,255,0.06);
}

.code-tree-row.directory {
  color: var(--fg-dim);
}

.code-tree-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.code-editor-pane {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.code-filebar {
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border-soft);
  color: var(--fg-muted);
  font-size: 11px;
}

.code-editor-pane .monaco-editor {
  flex: 1;
}

.code-editor-state,
.code-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--fg-muted);
  font-size: 13px;
}

.code-editor-state.error,
.code-error {
  color: var(--err);
}

.code-muted {
  color: var(--fg-dim);
  font-size: 11px;
  padding: 8px;
}
```

- [ ] **Step 3: Run UI typecheck to catch integration errors**

Run: `cd C:\Project-TOAD\toad-local\ui && npm run typecheck`

Expected: PASS.

- [ ] **Step 4: Commit CodeScreen**

```bash
git add toad-local/ui/src/components/CodeScreen.tsx toad-local/ui/src/styles/app-shell.css
git commit -m "feat(ui): add read-only code screen"
```

---

### Task 5: Route Code Screen into the App

**Files:**
- Modify: `ui/src/components/SidebarNav.tsx`
- Modify: `ui/src/App.tsx`
- Modify: `ui/src/types/index.ts`
- Modify: `ui/src/hooks/useToadData.ts`

- [ ] **Step 1: Add sidebar key**

In `ui/src/components/SidebarNav.tsx`, add `code`:

```ts
export type SidebarKey =
  | 'workspace'
  | 'foundry'
  | 'code'
  | 'tasks'
  | 'runtimes'
  | 'approvals'
  | 'drift'
  | 'costs'
  | 'diagnostics'
  | 'settings';
```

Add to `DEFAULT_TOP` immediately after Foundry:

```ts
{ key: 'code', label: 'Code', icon: 'code' },
```

- [ ] **Step 2: Preserve task worktree metadata and add tweak union value**

In `ui/src/types/index.ts`, extend `UiTask`:

```ts
export interface UiTask {
  id: string;
  title: string;
  status: TaskStatus;
  assignee: string;
  project: string;
  riskLevel?: TaskRiskLevel | null;
  requiresHumanApproval?: boolean;
  matchedRules?: MatchedRiskRule[];
  humanApproved?: boolean;
  worktree?: {
    status?: string;
    path?: string;
    branch?: string | null;
  } | null;
}
```

Add `'code'` to `Tweaks.screen`:

```ts
  screen:
    | 'workspace'
    | 'tasks'
    | 'settings'
    | 'foundry'
    | 'code'
    | 'costs'
    | 'audit'
    | 'drift'
    | 'picker'
    | 'empty'
    | 'onboarding'
    | 'create'
    | 'launching'
    | 'task';
```

In `ui/src/hooks/useToadData.ts`, extend `BackendTask`:

```ts
  worktree?: {
    status?: string;
    path?: string;
    branch?: string | null;
  } | null;
```

And include `worktree` in `normalizeTask()`'s return object:

```ts
    worktree: raw.worktree && typeof raw.worktree === 'object'
      ? {
          status: raw.worktree.status,
          path: raw.worktree.path,
          branch: raw.worktree.branch ?? null,
        }
      : null,
```

- [ ] **Step 3: Render CodeScreen in App and route sidebar state**

In `ui/src/App.tsx`, import:

```ts
import { CodeScreen } from '@/components/CodeScreen';
```

In the main screen switch/render block, add:

```tsx
{tweaks.screen === 'code' && (
  <CodeScreen
    teamId={team.name || activeTeamId}
    tasks={tasks}
    actor={{ teamId: team.name || activeTeamId || 'system', agentId: 'ui-client', role: 'human' }}
  />
)}
```

Place it alongside the other full-screen route branches for Foundry/Tasks/Drift/Settings.

In `activeNav`, add the Code screen branch:

```ts
if (tweaks.screen === 'code') return 'code';
```

In `handleNavSelect`, add:

```ts
case 'code':
  setTweak('screen', 'code');
  return;
```

- [ ] **Step 4: Run UI checks**

Run:

```bash
cd C:\Project-TOAD\toad-local\ui
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit route wiring**

```bash
git add toad-local/ui/src/components/SidebarNav.tsx toad-local/ui/src/App.tsx toad-local/ui/src/types/index.ts toad-local/ui/src/hooks/useToadData.ts
git commit -m "feat(ui): route code view"
```

---

### Task 6: Final Verification and Manual Browser Smoke

**Files:**
- No source files unless verification exposes defects.

- [ ] **Step 1: Run full backend suite**

Run:

```bash
cd C:\Project-TOAD\toad-local
npm test
```

Expected: PASS.

- [ ] **Step 2: Run UI checks**

Run:

```bash
cd C:\Project-TOAD\toad-local\ui
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 3: Restart local dev servers**

Run:

```powershell
$root = 'C:\Project-TOAD\toad-local'
$ui = Join-Path $root 'ui'
$tokenPath = Join-Path $root '.toad\api-token'
$token = (Get-Content -Raw -LiteralPath $tokenPath).Trim()
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*dev-api-server.mjs*' -and $_.CommandLine -like '*toad-local*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*toad-local*' -and $_.CommandLine -like '*vite*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 700
$env:TOAD_PROJECT_CWD = $root
$env:TOAD_DB_PATH = Join-Path $root '.toad\toad.db'
$env:TOAD_API_TOKEN = $token
Start-Process -FilePath 'node' -ArgumentList @('--no-warnings','scripts/dev-api-server.mjs') -WorkingDirectory $root -WindowStyle Hidden
$env:VITE_TOAD_API_TOKEN = $token
Start-Process -FilePath 'npm.cmd' -ArgumentList @('run','dev','--','--host','127.0.0.1') -WorkingDirectory $ui -WindowStyle Hidden
```

- [ ] **Step 4: Smoke the API tools**

Run:

```powershell
$token = (Get-Content -Raw -LiteralPath 'C:\Project-TOAD\toad-local\.toad\api-token').Trim()
$body = @{
  actor = @{ teamId='system'; agentId='smoke'; role='human' }
  method = 'ide_tree_list'
  args = @{ source = @{ kind='project' }; maxEntries = 20 }
} | ConvertTo-Json -Depth 8
Invoke-WebRequest -Uri 'http://127.0.0.1:3001/api/call' -Method Post -ContentType 'application/json' -Headers @{ Authorization = "Bearer $token" } -Body $body -UseBasicParsing
```

Expected: JSON response with `result.entries`.

- [ ] **Step 5: Manual browser check**

In the in-app browser at `http://127.0.0.1:5173/`:

1. Select a team.
2. Click `Code` in the sidebar.
3. Confirm the project tree loads.
4. Click `README.md` or another text file.
5. Confirm Monaco renders content and is read-only.
6. Click Refresh and confirm the selected file remains open if it still exists.
7. If a task has a created worktree, switch the source dropdown and open a file there.

- [ ] **Step 6: Commit verification fixes or finish clean**

If no defects were found:

```bash
git status --short
```

Expected: clean except intentionally untracked root `package.json` and `package-lock.json`, unless those files have been intentionally handled in a separate cleanup.
