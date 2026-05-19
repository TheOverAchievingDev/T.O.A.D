# IDE File Compatibility Implementation Plan

> IDE-0 (2026-05-18): verified layers committed. Completion reflects actual code, not aspiration.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the project file explorer and editor handle common VS Code/Cursor project file types: edit safe text files, classify common language/config files, and show graceful metadata panels for unsupported or oversized files.

**Architecture:** Add backend file classification as the source of truth for tree/read metadata, then mirror only the small frontend presentation helpers needed for rendering. Preserve the current `ide_tree_list`, `ide_read_file`, and `ide_write_file` command names and source model so `CodeScreen` and `CockpitWithMe` keep working.

**Tech Stack:** Node.js ESM backend, React + TypeScript UI, Monaco via `@monaco-editor/react`, Node test runner, UI `.mjs` helper tests compiled with local TypeScript.

---

## File Structure

- Create `src/ide/fileClassification.js`: classifies filenames/extensions and read buffers into editor metadata.
- Modify `src/ide/ideFileTools.js`: include classification metadata in tree/read results and return unsupported metadata instead of throwing for normal unsupported files.
- Create `test/ideFileClassification.test.js`: focused classification unit coverage.
- Create `test/ideFileTools.compatibility.test.js`: integration tests for tree/read/write compatibility behavior.
- Modify `scripts/test-suites.txt`: include the new backend tests in the root test suite.
- Modify `ui/src/components/ideSource.ts`: extend IDE file/tree types with optional compatibility metadata and a discriminated read result shape.
- Create `ui/src/components/ideFilePresentation.ts`: frontend helpers for language fallback and editable/unsupported rendering decisions.
- Create `ui/test/ideFilePresentation.test.mjs`: compile/import helper tests.
- Modify `ui/src/components/IdeEditorPane.tsx`: support non-editable file tabs and friendly unsupported-file panels.
- Modify `ui/src/components/IdeFileTree.tsx`: show tooltip/class marker for readonly/binary/unsupported files.
- Modify `ui/src/components/codeTreeNavigator.ts`: carry metadata from tree entries into tree nodes.
- Modify `ui/src/styles/app-shell.css`: style unsupported editor state and explorer markers.

---

## Task 1: Backend File Classification

**Files:**
- Create: `src/ide/fileClassification.js`
- Test: `test/ideFileClassification.test.js`

- [x] **Step 1: Write the failing classification tests**

Create `test/ideFileClassification.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFilePath,
  classifyReadBuffer,
  isBinaryBuffer,
} from '../src/ide/fileClassification.js';

test('classifyFilePath maps common project files to Monaco language hints', () => {
  assert.deepEqual(classifyFilePath('src/app.py'), {
    category: 'text',
    editable: true,
    previewable: false,
    binary: false,
    languageHint: 'python',
    reason: null,
  });
  assert.equal(classifyFilePath('Dockerfile').languageHint, 'dockerfile');
  assert.equal(classifyFilePath('.env.local').languageHint, 'dotenv');
  assert.equal(classifyFilePath('package-lock.json').languageHint, 'json');
  assert.equal(classifyFilePath('Makefile').languageHint, 'makefile');
  assert.equal(classifyFilePath('README.mdx').languageHint, 'mdx');
});

test('classifyFilePath marks known non-text files unsupported without image preview support', () => {
  const png = classifyFilePath('assets/logo.png');
  assert.equal(png.category, 'unsupported');
  assert.equal(png.editable, false);
  assert.equal(png.previewable, false);
  assert.equal(png.binary, true);
  assert.match(png.reason, /not editable/i);

  const zip = classifyFilePath('release/app.zip');
  assert.equal(zip.category, 'unsupported');
  assert.equal(zip.binary, true);
});

test('classifyReadBuffer keeps unknown UTF-8 files editable as plaintext', () => {
  const result = classifyReadBuffer({
    relativePath: 'notes.custom',
    bytes: Buffer.from('plain text\n', 'utf8'),
    maxBytes: 1024,
  });
  assert.equal(result.category, 'text');
  assert.equal(result.editable, true);
  assert.equal(result.languageHint, 'plaintext');
  assert.equal(result.reason, null);
});

test('classifyReadBuffer marks binary and oversized content as non-editable', () => {
  assert.equal(isBinaryBuffer(Buffer.from([0x01, 0x00, 0x02])), true);

  const binary = classifyReadBuffer({
    relativePath: 'blob.bin',
    bytes: Buffer.from([0x01, 0x00, 0x02]),
    maxBytes: 1024,
  });
  assert.equal(binary.category, 'binary');
  assert.equal(binary.editable, false);
  assert.equal(binary.binary, true);

  const large = classifyReadBuffer({
    relativePath: 'huge.log',
    bytes: Buffer.from('a'.repeat(8), 'utf8'),
    maxBytes: 4,
  });
  assert.equal(large.category, 'readonly_text');
  assert.equal(large.editable, false);
  assert.equal(large.binary, false);
  assert.match(large.reason, /too large/i);
});
```

- [x] **Step 2: Run the failing test**

Run: `node --no-warnings --test test/ideFileClassification.test.js`

Expected: FAIL because `src/ide/fileClassification.js` does not exist.

- [x] **Step 3: Implement the classifier**

Create `src/ide/fileClassification.js`:

```js
import path from 'node:path';

const LANGUAGE_BY_EXTENSION = new Map([
  ['.js', 'javascript'],
  ['.cjs', 'javascript'],
  ['.mjs', 'javascript'],
  ['.jsx', 'javascriptreact'],
  ['.ts', 'typescript'],
  ['.mts', 'typescript'],
  ['.cts', 'typescript'],
  ['.tsx', 'typescriptreact'],
  ['.json', 'json'],
  ['.jsonc', 'jsonc'],
  ['.css', 'css'],
  ['.scss', 'scss'],
  ['.sass', 'scss'],
  ['.less', 'less'],
  ['.html', 'html'],
  ['.htm', 'html'],
  ['.vue', 'html'],
  ['.svelte', 'html'],
  ['.md', 'markdown'],
  ['.markdown', 'markdown'],
  ['.mdx', 'mdx'],
  ['.py', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
  ['.java', 'java'],
  ['.kt', 'kotlin'],
  ['.kts', 'kotlin'],
  ['.c', 'c'],
  ['.h', 'c'],
  ['.cpp', 'cpp'],
  ['.cc', 'cpp'],
  ['.cxx', 'cpp'],
  ['.hpp', 'cpp'],
  ['.cs', 'csharp'],
  ['.php', 'php'],
  ['.rb', 'ruby'],
  ['.swift', 'swift'],
  ['.sql', 'sql'],
  ['.sh', 'shell'],
  ['.bash', 'shell'],
  ['.zsh', 'shell'],
  ['.ps1', 'powershell'],
  ['.psm1', 'powershell'],
  ['.yml', 'yaml'],
  ['.yaml', 'yaml'],
  ['.toml', 'toml'],
  ['.xml', 'xml'],
  ['.ini', 'ini'],
  ['.cfg', 'ini'],
  ['.conf', 'ini'],
  ['.txt', 'plaintext'],
  ['.log', 'plaintext'],
]);

const LANGUAGE_BY_BASENAME = new Map([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['rakefile', 'ruby'],
  ['gemfile', 'ruby'],
  ['procfile', 'plaintext'],
  ['compose.yml', 'yaml'],
  ['compose.yaml', 'yaml'],
  ['docker-compose.yml', 'yaml'],
  ['docker-compose.yaml', 'yaml'],
  ['package-lock.json', 'json'],
  ['pnpm-lock.yaml', 'yaml'],
  ['yarn.lock', 'plaintext'],
  ['cargo.lock', 'toml'],
]);

const UNSUPPORTED_BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif',
  '.pdf',
  '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.wav', '.ogg', '.mp4', '.mov', '.webm',
  '.exe', '.dll', '.so', '.dylib', '.bin',
]);

export function classifyFilePath(relativePath) {
  const basename = path.basename(String(relativePath || ''));
  const lowerName = basename.toLowerCase();
  const ext = path.extname(lowerName);

  if (UNSUPPORTED_BINARY_EXTENSIONS.has(ext)) {
    return metadata({
      category: 'unsupported',
      editable: false,
      binary: true,
      languageHint: null,
      reason: `${basename || 'File'} is not editable in Symphony yet.`,
    });
  }

  const languageHint = languageForName(lowerName, ext);
  return metadata({
    category: 'text',
    editable: true,
    binary: false,
    languageHint,
    reason: null,
  });
}

export function classifyReadBuffer({ relativePath, bytes, maxBytes }) {
  const base = classifyFilePath(relativePath);
  if (base.category === 'unsupported') return base;

  if (isBinaryBuffer(bytes)) {
    return metadata({
      category: 'binary',
      editable: false,
      binary: true,
      languageHint: null,
      reason: 'Binary file is not editable in Symphony.',
    });
  }

  const content = bytes.toString('utf8');
  if (content.includes('\uFFFD')) {
    return metadata({
      category: 'binary',
      editable: false,
      binary: true,
      languageHint: null,
      reason: 'File is not valid UTF-8 text.',
    });
  }

  if (Number.isFinite(maxBytes) && bytes.length > maxBytes) {
    return metadata({
      category: 'readonly_text',
      editable: false,
      binary: false,
      languageHint: base.languageHint || 'plaintext',
      reason: `File is too large to edit (${bytes.length} bytes).`,
    });
  }

  return metadata({
    category: 'text',
    editable: true,
    binary: false,
    languageHint: base.languageHint || 'plaintext',
    reason: null,
  });
}

export function isBinaryBuffer(bytes) {
  if (!bytes || typeof bytes.includes !== 'function') return false;
  if (bytes.includes(0)) return true;
  const sampleLength = Math.min(bytes.length, 512);
  if (sampleLength === 0) return false;
  let control = 0;
  for (let i = 0; i < sampleLength; i += 1) {
    const b = bytes[i];
    if (b < 7 || (b > 14 && b < 32)) control += 1;
  }
  return control / sampleLength > 0.18;
}

function languageForName(lowerName, ext) {
  if (lowerName.startsWith('.env')) return 'dotenv';
  if (LANGUAGE_BY_BASENAME.has(lowerName)) return LANGUAGE_BY_BASENAME.get(lowerName);
  return LANGUAGE_BY_EXTENSION.get(ext) || 'plaintext';
}

function metadata({ category, editable, binary, languageHint, reason }) {
  return {
    category,
    editable,
    previewable: false,
    binary,
    languageHint,
    reason,
  };
}
```

- [x] **Step 4: Run the classifier test**

Run: `node --no-warnings --test test/ideFileClassification.test.js`

Expected: PASS.

---

## Task 2: Backend IDE Tool Metadata and Unsupported Read Results

**Files:**
- Modify: `src/ide/ideFileTools.js`
- Test: `test/ideFileTools.compatibility.test.js`

- [x] **Step 1: Write failing integration tests**

Create `test/ideFileTools.compatibility.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listIdeTree, readIdeFile, writeIdeFile } from '../src/ide/ideFileTools.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'toad-ide-compat-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'app.py'), 'print("hi")\n');
  writeFileSync(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  writeFileSync(join(dir, 'huge.log'), 'abcdef');
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('listIdeTree includes language and compatibility metadata', () => {
  const f = fixture();
  try {
    const tree = listIdeTree({ projectCwd: f.dir, teamId: 'team-a' });
    const py = tree.entries.find((e) => e.path === 'src/app.py');
    const png = tree.entries.find((e) => e.path === 'image.png');
    assert.equal(py.languageHint, 'python');
    assert.equal(py.category, 'text');
    assert.equal(py.editable, true);
    assert.equal(png.category, 'unsupported');
    assert.equal(png.editable, false);
    assert.equal(png.binary, true);
  } finally {
    f.cleanup();
  }
});

test('readIdeFile returns editable UTF-8 content with metadata', () => {
  const f = fixture();
  try {
    const file = readIdeFile({ projectCwd: f.dir, teamId: 'team-a', relativePath: 'src/app.py' });
    assert.equal(file.kind, 'text');
    assert.equal(file.languageHint, 'python');
    assert.equal(file.editable, true);
    assert.equal(file.content, 'print("hi")\n');
  } finally {
    f.cleanup();
  }
});

test('readIdeFile returns unsupported metadata for binary files instead of throwing', () => {
  const f = fixture();
  try {
    const file = readIdeFile({ projectCwd: f.dir, teamId: 'team-a', relativePath: 'image.png' });
    assert.equal(file.kind, 'unsupported');
    assert.equal(file.editable, false);
    assert.equal(file.binary, true);
    assert.equal(file.content, undefined);
    assert.match(file.reason, /not editable|binary/i);
  } finally {
    f.cleanup();
  }
});

test('readIdeFile returns oversized readonly metadata for large text files', () => {
  const f = fixture();
  try {
    const file = readIdeFile({
      projectCwd: f.dir,
      teamId: 'team-a',
      relativePath: 'huge.log',
      maxBytes: 4,
    });
    assert.equal(file.kind, 'unsupported');
    assert.equal(file.category, 'readonly_text');
    assert.equal(file.editable, false);
    assert.equal(file.binary, false);
    assert.match(file.reason, /too large/i);
  } finally {
    f.cleanup();
  }
});

test('writeIdeFile remains text-only and returns editable read result', () => {
  const f = fixture();
  try {
    const before = readIdeFile({ projectCwd: f.dir, teamId: 'team-a', relativePath: 'src/app.py' });
    const after = writeIdeFile({
      projectCwd: f.dir,
      teamId: 'team-a',
      relativePath: 'src/app.py',
      content: 'print("bye")\n',
      expectedSha256: before.sha256,
    });
    assert.equal(after.kind, 'text');
    assert.equal(after.content, 'print("bye")\n');
  } finally {
    f.cleanup();
  }
});
```

- [x] **Step 2: Run the failing integration tests**

Run: `node --no-warnings --test test/ideFileTools.compatibility.test.js`

Expected: FAIL because metadata fields and unsupported read shapes are not implemented.

- [x] **Step 3: Extend `ideFileTools.js`**

Modify imports:

```js
import {
  classifyFilePath,
  classifyReadBuffer,
  isBinaryBuffer,
} from './fileClassification.js';
```

In `collectTreeEntries`, after `const stats = statSync(childAbsolutePath);`, merge classification metadata:

```js
const meta = classifyFilePath(normalizedPath);
state.entries.push({
  path: normalizedPath,
  name: child.name,
  kind: 'file',
  sizeBytes: stats.size,
  ...meta,
});
```

In `readIdeFile`, replace the early size/binary throws with a single read-and-classify flow:

```js
const bytes = withReadFileErrors(() => readFileSync(resolved.absolutePath));
const meta = classifyReadBuffer({ relativePath: resolved.relativePath, bytes, maxBytes });
if (!meta.editable) {
  return {
    kind: 'unsupported',
    source: root.source,
    relativePath: resolved.relativePath,
    sizeBytes: stats.size,
    ...meta,
  };
}

const content = bytes.toString('utf8');
return {
  kind: 'text',
  source: root.source,
  relativePath: resolved.relativePath,
  content,
  encoding: 'utf8',
  sizeBytes: stats.size,
  sha256: sha256(bytes),
  ...meta,
};
```

Keep directory, not-file, path traversal, and filesystem errors as thrown errors.

In `writeIdeFile`, keep existing string and null-byte validation. The `return readIdeFile(...)` line can remain because saved text returns `kind:'text'`.

- [x] **Step 4: Run backend IDE compatibility tests**

Run: `node --no-warnings --test test/ideFileClassification.test.js test/ideFileTools.compatibility.test.js`

Expected: PASS.

---

## Task 3: Frontend IDE Types and Presentation Helpers

**Files:**
- Modify: `ui/src/components/ideSource.ts`
- Create: `ui/src/components/ideFilePresentation.ts`
- Test: `ui/test/ideFilePresentation.test.mjs`

- [x] **Step 1: Write failing frontend helper tests**

Create `ui/test/ideFilePresentation.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

async function compileHelper() {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'toad-ide-presentation-'));
  const source = path.resolve('ui/src/components/ideFilePresentation.ts');
  const tsc = path.resolve('ui/node_modules/typescript/bin/tsc');
  const result = spawnSync(process.execPath, [
    tsc,
    source,
    '--target', 'ES2022',
    '--module', 'ES2022',
    '--moduleResolution', 'Bundler',
    '--outDir', outDir,
    '--skipLibCheck',
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    await rm(outDir, { recursive: true, force: true });
    throw new Error(result.stderr || result.stdout || 'tsc failed');
  }
  return { outDir, mod: await import(pathToFileURL(path.join(outDir, 'ideFilePresentation.js')).href) };
}

test('languageForFile maps common Cursor/VS Code project files', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    assert.equal(mod.languageForFile('src/app.py'), 'python');
    assert.equal(mod.languageForFile('Dockerfile'), 'dockerfile');
    assert.equal(mod.languageForFile('.env.local'), 'dotenv');
    assert.equal(mod.languageForFile('Makefile'), 'makefile');
    assert.equal(mod.languageForFile('README.mdx'), 'mdx');
    assert.equal(mod.languageForFile('unknown.custom'), 'plaintext');
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('isEditableIdeFile recognizes text result shape only', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    assert.equal(mod.isEditableIdeFile({ kind: 'text', editable: true, content: 'x' }), true);
    assert.equal(mod.isEditableIdeFile({ kind: 'unsupported', editable: false, reason: 'binary' }), false);
    assert.equal(mod.isEditableIdeFile({ content: 'legacy', editable: undefined }), true);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run the failing frontend helper tests**

Run: `node --test ui/test/ideFilePresentation.test.mjs`

Expected: FAIL because `ideFilePresentation.ts` does not exist.

- [x] **Step 3: Extend frontend types**

Modify `ui/src/components/ideSource.ts`:

```ts
export type IdeFileCategory = 'text' | 'readonly_text' | 'binary' | 'unsupported';

export interface IdeCompatibilityMeta {
  category?: IdeFileCategory;
  editable?: boolean;
  previewable?: boolean;
  binary?: boolean;
  reason?: string | null;
}
```

Extend `IdeTreeEntry` with `IdeCompatibilityMeta`.

Replace `IdeFileResult` with a union-compatible interface set:

```ts
export interface IdeTextFileResult extends IdeCompatibilityMeta {
  kind?: 'text';
  source: IdeSource;
  relativePath: string;
  content: string;
  encoding: 'utf8';
  sizeBytes: number;
  sha256: string;
  languageHint?: string | null;
  editable?: true;
}

export interface IdeUnsupportedFileResult extends IdeCompatibilityMeta {
  kind: 'unsupported';
  source: IdeSource;
  relativePath: string;
  sizeBytes: number;
  languageHint?: string | null;
  editable: false;
  reason: string;
}

export type IdeFileResult = IdeTextFileResult | IdeUnsupportedFileResult;
```

- [x] **Step 4: Add frontend presentation helper**

Create `ui/src/components/ideFilePresentation.ts`:

```ts
interface IdeFileLike {
  kind?: string;
  editable?: boolean;
  content?: string;
  languageHint?: string | null;
  relativePath?: string;
}

const LANGUAGE_BY_EXTENSION = new Map<string, string>([
  ['js', 'javascript'],
  ['cjs', 'javascript'],
  ['mjs', 'javascript'],
  ['jsx', 'javascriptreact'],
  ['ts', 'typescript'],
  ['mts', 'typescript'],
  ['cts', 'typescript'],
  ['tsx', 'typescriptreact'],
  ['json', 'json'],
  ['jsonc', 'jsonc'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['sass', 'scss'],
  ['less', 'less'],
  ['html', 'html'],
  ['htm', 'html'],
  ['vue', 'html'],
  ['svelte', 'html'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['mdx', 'mdx'],
  ['py', 'python'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['c', 'c'],
  ['h', 'c'],
  ['cpp', 'cpp'],
  ['cc', 'cpp'],
  ['cxx', 'cpp'],
  ['hpp', 'cpp'],
  ['cs', 'csharp'],
  ['php', 'php'],
  ['rb', 'ruby'],
  ['swift', 'swift'],
  ['sql', 'sql'],
  ['sh', 'shell'],
  ['bash', 'shell'],
  ['zsh', 'shell'],
  ['ps1', 'powershell'],
  ['psm1', 'powershell'],
  ['yml', 'yaml'],
  ['yaml', 'yaml'],
  ['toml', 'toml'],
  ['xml', 'xml'],
  ['ini', 'ini'],
  ['cfg', 'ini'],
  ['conf', 'ini'],
  ['txt', 'plaintext'],
  ['log', 'plaintext'],
]);

const LANGUAGE_BY_BASENAME = new Map<string, string>([
  ['dockerfile', 'dockerfile'],
  ['makefile', 'makefile'],
  ['rakefile', 'ruby'],
  ['gemfile', 'ruby'],
  ['procfile', 'plaintext'],
  ['package-lock.json', 'json'],
  ['pnpm-lock.yaml', 'yaml'],
  ['yarn.lock', 'plaintext'],
  ['cargo.lock', 'toml'],
]);

export function languageForFile(path: string, languageHint?: string | null): string {
  if (languageHint) return languageHint;
  const basename = path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  if (basename.startsWith('.env')) return 'dotenv';
  const byName = LANGUAGE_BY_BASENAME.get(basename);
  if (byName) return byName;
  const ext = basename.includes('.') ? basename.slice(basename.lastIndexOf('.') + 1) : '';
  return LANGUAGE_BY_EXTENSION.get(ext) ?? 'plaintext';
}

export function isEditableIdeFile(file: IdeFileLike | null | undefined): boolean {
  if (!file) return false;
  if (file.kind === 'unsupported') return false;
  if (file.editable === false) return false;
  return typeof file.content === 'string';
}

export function unsupportedReason(file: IdeFileLike | null | undefined): string {
  const reason = (file as { reason?: unknown } | null | undefined)?.reason;
  return typeof reason === 'string' && reason.trim()
    ? reason
    : 'This file cannot be edited in Symphony yet.';
}
```

- [x] **Step 5: Run frontend helper tests**

Run: `node --test ui/test/ideFilePresentation.test.mjs`

Expected: PASS.

---

## Task 4: Editor Unsupported State

**Files:**
- Modify: `ui/src/components/IdeEditorPane.tsx`
- Modify: `ui/src/styles/app-shell.css`
- Test: `ui/test/ideFilePresentation.test.mjs`

- [x] **Step 1: Add a test for unsupported reason helper**

Append to `ui/test/ideFilePresentation.test.mjs`:

```js
test('unsupportedReason provides stable panel copy', async () => {
  const { outDir, mod } = await compileHelper();
  try {
    assert.equal(mod.unsupportedReason({ reason: 'Binary file' }), 'Binary file');
    assert.match(mod.unsupportedReason({}), /cannot be edited/i);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run the helper test**

Run: `node --test ui/test/ideFilePresentation.test.mjs`

Expected: PASS if Task 3 already included `unsupportedReason`.

- [x] **Step 3: Update `IdeEditorPane.tsx` imports and edit guards**

Import:

```ts
import {
  isEditableIdeFile,
  languageForFile,
  unsupportedReason,
} from './ideFilePresentation';
```

Replace dirty checks:

```ts
const activeTabEditable = isEditableIdeFile(activeTab?.file);
const isDirty = activeTab && activeTabEditable ? activeTab.draftContent !== activeTab.file?.content : false;
const isAnyDirty = tabs.some((t) => isEditableIdeFile(t.file) && t.draftContent !== t.file?.content);
```

In `saveFile`, require editable file:

```ts
if (!actor.teamId || !activeTab || !isEditableIdeFile(activeTab.file) || !isDirty) return;
```

In `revertFile`, require editable file:

```ts
if (!activeTab || !isEditableIdeFile(activeTab.file)) return;
```

Replace `languageFromPath(...)` use with:

```tsx
language={activeTab.editorMode === 'diff'
  ? 'diff'
  : languageForFile(activeTab.file.relativePath, activeTab.file.languageHint)}
```

- [x] **Step 4: Render unsupported file panels**

In `IdeEditorPane.tsx`, inside the active file body, branch before Monaco:

```tsx
{activeTab.file && !isEditableIdeFile(activeTab.file) && (
  <div className="code-unsupported-file">
    <div className="code-unsupported-card">
      <Icon name="file" size={22} />
      <div>
        <h3>{activeTab.path.split('/').pop()}</h3>
        <p>{unsupportedReason(activeTab.file)}</p>
        <dl>
          <div><dt>Path</dt><dd className="mono">{activeTab.path}</dd></div>
          <div><dt>Size</dt><dd>{formatBytes(activeTab.file.sizeBytes)}</dd></div>
          <div><dt>Type</dt><dd>{activeTab.file.category ?? 'unsupported'}</dd></div>
        </dl>
      </div>
    </div>
  </div>
)}
{activeTab.file && isEditableIdeFile(activeTab.file) && (
  // existing Monaco/Markdown render block
)}
```

Disable edit-only buttons with `!isEditableIdeFile(activeTab.file)`.

- [x] **Step 5: Add unsupported panel styles**

Add to `ui/src/styles/app-shell.css`:

```css
.code-unsupported-file {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  padding: 28px;
  color: var(--fg-muted);
}

.code-unsupported-card {
  max-width: 520px;
  width: 100%;
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 14px;
  padding: 18px;
  border: 1px solid var(--border-soft);
  border-radius: 8px;
  background: rgba(255,255,255,0.025);
}

.code-unsupported-card h3 {
  margin: 0 0 6px;
  color: var(--fg);
  font-size: 14px;
}

.code-unsupported-card p {
  margin: 0 0 14px;
  font-size: 12px;
}

.code-unsupported-card dl {
  display: grid;
  gap: 7px;
  margin: 0;
  font-size: 11px;
}

.code-unsupported-card dl div {
  display: grid;
  grid-template-columns: 70px minmax(0, 1fr);
  gap: 10px;
}

.code-unsupported-card dt {
  color: var(--fg-dim);
}

.code-unsupported-card dd {
  margin: 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
```

- [x] **Step 6: Run UI checks**

Run:

```powershell
npm run typecheck
node --test ui/test/ideFilePresentation.test.mjs
```

Expected: PASS.

---

## Task 5: Explorer Metadata Display

**Files:**
- Modify: `ui/src/components/codeTreeNavigator.ts`
- Modify: `ui/src/components/IdeFileTree.tsx`
- Modify: `ui/src/styles/app-shell.css`

- [x] **Step 1: Carry metadata through tree nodes**

In `ui/src/components/codeTreeNavigator.ts`, extend `CodeTreeEntry` and `CodeTreeNode`:

```ts
category?: 'text' | 'readonly_text' | 'binary' | 'unsupported';
editable?: boolean;
previewable?: boolean;
binary?: boolean;
reason?: string | null;
languageHint?: string | null;
```

Update `ensureNode(...)` to accept an entry object instead of individual metadata, or add parameters for these fields. When an existing node is found, preserve/update metadata:

```ts
if (entry.category !== undefined) existing.category = entry.category;
if (entry.editable !== undefined) existing.editable = entry.editable;
if (entry.previewable !== undefined) existing.previewable = entry.previewable;
if (entry.binary !== undefined) existing.binary = entry.binary;
if (entry.reason !== undefined) existing.reason = entry.reason;
if (entry.languageHint !== undefined) existing.languageHint = entry.languageHint;
```

- [x] **Step 2: Add explorer marker rendering**

In `ui/src/components/IdeFileTree.tsx`, add a marker before size:

```tsx
{node.kind === 'file' && node.editable === false && (
  <span
    className={`code-tree-kind-badge ${node.category ?? 'unsupported'}`}
    title={node.reason ?? 'Not editable in Symphony'}
  >
    {node.category === 'readonly_text' ? 'RO' : 'BIN'}
  </span>
)}
```

Update row title:

```tsx
title={node.reason ? `${node.path} - ${node.reason}` : node.path}
```

- [x] **Step 3: Add badge styles**

Add to `ui/src/styles/app-shell.css`:

```css
.code-tree-kind-badge {
  justify-self: end;
  border: 1px solid var(--border-soft);
  border-radius: 3px;
  padding: 1px 4px;
  color: var(--fg-dim);
  font-family: var(--font-ui);
  font-size: 9px;
  line-height: 1.3;
}

.code-tree-kind-badge.readonly_text {
  color: var(--warn);
  border-color: color-mix(in oklab, var(--warn) 35%, transparent);
}
```

- [x] **Step 4: Run UI typecheck**

Run: `npm run typecheck`

Expected: PASS.

---

## Task 6: Test Suite Wiring and Full Verification

**Files:**
- Modify: `scripts/test-suites.txt`

- [x] **Step 1: Add backend tests to root test suite**

Append to `scripts/test-suites.txt` if absent:

```powershell
$path = 'scripts\test-suites.txt'
$text = Get-Content -Raw -LiteralPath $path
$suffix = ' && node --no-warnings --test test/ideFileClassification.test.js && node --no-warnings --test test/ideFileTools.compatibility.test.js'
if ($text -notlike '*test/ideFileClassification.test.js*') {
  Set-Content -LiteralPath $path -NoNewline -Value ($text.TrimEnd() + $suffix + [Environment]::NewLine)
}
```

- [x] **Step 2: Run focused backend tests**

Run:

```powershell
node --no-warnings --test test/ideFileClassification.test.js test/ideFileTools.compatibility.test.js
```

Expected: PASS.

- [x] **Step 3: Run focused UI tests**

Run:

```powershell
node --test ui/test/ideFilePresentation.test.mjs ui/test/cockpitTreeActor.test.mjs
```

Expected: PASS.

- [x] **Step 4: Run UI verification**

Run:

```powershell
npm run typecheck
npm run build
```

from `ui/`.

Expected: both PASS. Existing Vite large chunk warnings are acceptable if build exits 0.

- [x] **Step 5: Run root suite**

Run:

```powershell
npm test
```

Expected: PASS.

- [ ] **Step 6: Manual smoke**

With the UI running, open project files in WITH-me or Code:

- `docs/foundry/definition-of-done.md` opens editable with Markdown controls.
- A `.py` or `.toml` fixture opens with the expected Monaco language.
- A `.png` or `.zip` opens a tab with a friendly unsupported panel.
- A large `.log` over the edit cap opens a read-only/unsupported panel.

Expected: no generic `binary file` or `file too large` error for ordinary unsupported files.

---

## Self-Review

- Spec coverage: Backend classification, broader language support, unsupported metadata panels, explorer metadata, write safety, tests, and manual verification are covered.
- Scope check: Image previews, PDF previews, archive browsing, notebook execution, binary editing, and VS Code extension compatibility remain out of scope.
- Type consistency: Backend categories are `text`, `readonly_text`, `binary`, and `unsupported`; frontend types and explorer badges use the same strings.
- Placeholder scan: No TBD/TODO placeholders remain; each task has explicit files, commands, and expected results.
