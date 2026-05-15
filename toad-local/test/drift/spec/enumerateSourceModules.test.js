import test from 'node:test';
import assert from 'node:assert/strict';
import { enumerateSourceModules } from '../../../src/drift/spec/enumerateSourceModules.js';

// enumerateSourceModules walks <projectCwd>/src and returns the
// project-relative POSIX paths of files that are CANDIDATE PRODUCT
// MODULES — excluding entrypoints (main/lib/index), module-decl files
// (mod.rs), build scripts, type decls, and test files. Those
// exclusions ARE the wolf-cry guard: without them L1.2b would flag
// src/main.rs / src/lib.rs / src/win/mod.rs as "undeclared drift".
//
// fs is injected (a virtual tree) so tests never touch disk.

/**
 * Build injectable readdir/stat over a flat { 'src/a.rs': 'file',
 * 'src/win': 'dir', ... } map keyed by POSIX path relative to root.
 */
function vfs(tree, root = '/proj') {
  const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const rel = (abs) => {
    const a = norm(abs);
    if (a === root) return '';
    return a.startsWith(root + '/') ? a.slice(root.length + 1) : a;
  };
  return {
    readdirSyncImpl: (abs) => {
      const base = rel(abs);
      const prefix = base === '' ? '' : base + '/';
      const names = new Set();
      for (const key of Object.keys(tree)) {
        if (base === '' ? !key.includes('/') : key.startsWith(prefix) && !key.slice(prefix.length).includes('/')) {
          names.add(key.slice(prefix.length));
        }
      }
      if (names.size === 0 && base !== '' && tree[base] !== 'dir') {
        const e = new Error(`ENOENT ${abs}`); e.code = 'ENOENT'; throw e;
      }
      return [...names];
    },
    statSyncImpl: (abs) => {
      const r = rel(abs);
      const kind = tree[r];
      if (kind === undefined) { const e = new Error(`ENOENT ${abs}`); e.code = 'ENOENT'; throw e; }
      return { isDirectory: () => kind === 'dir', isFile: () => kind === 'file' };
    },
  };
}

test('rust: returns product .rs modules, excludes main/lib/mod/build + tests', () => {
  const tree = {
    src: 'dir',
    'src/main.rs': 'file',
    'src/lib.rs': 'file',
    'src/sampler.rs': 'file',
    'src/heuristics.rs': 'file',
    'src/win': 'dir',
    'src/win/mod.rs': 'file',
    'src/win/procs.rs': 'file',
    'src/build.rs': 'file',
    'src/tests': 'dir',
    'src/tests/helpers.rs': 'file',
  };
  const { readdirSyncImpl, statSyncImpl } = vfs(tree);
  const r = enumerateSourceModules({
    projectCwd: '/proj', language: 'rust', moduleRoot: 'src/main.rs',
    readdirSyncImpl, statSyncImpl,
  });
  assert.equal(r.error, null);
  assert.deepEqual(
    r.modules.sort(),
    ['src/heuristics.rs', 'src/sampler.rs', 'src/win/procs.rs'],
  );
});

test('rust: moduleRoot is excluded even if it is not named main.rs', () => {
  const tree = { src: 'dir', 'src/app.rs': 'file', 'src/widget.rs': 'file' };
  const { readdirSyncImpl, statSyncImpl } = vfs(tree);
  const r = enumerateSourceModules({
    projectCwd: '/proj', language: 'rust', moduleRoot: 'src/app.rs',
    readdirSyncImpl, statSyncImpl,
  });
  assert.deepEqual(r.modules, ['src/widget.rs']);
});

test('node/typescript: excludes index, *.test, *.spec, *.d.ts', () => {
  const tree = {
    src: 'dir',
    'src/index.ts': 'file',
    'src/auth.ts': 'file',
    'src/auth.test.ts': 'file',
    'src/billing.ts': 'file',
    'src/billing.spec.tsx': 'file',
    'src/types.d.ts': 'file',
    'src/api': 'dir',
    'src/api/index.ts': 'file',
    'src/api/users.ts': 'file',
  };
  const { readdirSyncImpl, statSyncImpl } = vfs(tree);
  const r = enumerateSourceModules({
    projectCwd: '/proj', language: 'typescript', moduleRoot: 'src/index.ts',
    readdirSyncImpl, statSyncImpl,
  });
  assert.equal(r.error, null);
  assert.deepEqual(r.modules.sort(), ['src/api/users.ts', 'src/auth.ts', 'src/billing.ts']);
});

test('missing src/ → empty list, NOT an error (no source yet is normal early-build)', () => {
  const { readdirSyncImpl, statSyncImpl } = vfs({ });
  const r = enumerateSourceModules({
    projectCwd: '/proj', language: 'rust', moduleRoot: 'src/main.rs',
    readdirSyncImpl, statSyncImpl,
  });
  assert.equal(r.error, null);
  assert.deepEqual(r.modules, []);
});

test('unsupported language → { modules: null, error } (honest, not silent pass)', () => {
  const { readdirSyncImpl, statSyncImpl } = vfs({ src: 'dir', 'src/x.hs': 'file' });
  const r = enumerateSourceModules({
    projectCwd: '/proj', language: 'haskell', moduleRoot: 'src/Main.hs',
    readdirSyncImpl, statSyncImpl,
  });
  assert.equal(r.modules, null);
  assert.match(r.error, /haskell|unsupported/i);
});

test('nested directories are walked; non-source files ignored', () => {
  const tree = {
    src: 'dir',
    'src/main.rs': 'file',
    'src/a': 'dir',
    'src/a/b': 'dir',
    'src/a/b/deep.rs': 'file',
    'src/a/notes.md': 'file',
    'src/a/data.json': 'file',
  };
  const { readdirSyncImpl, statSyncImpl } = vfs(tree);
  const r = enumerateSourceModules({
    projectCwd: '/proj', language: 'rust', moduleRoot: 'src/main.rs',
    readdirSyncImpl, statSyncImpl,
  });
  assert.deepEqual(r.modules, ['src/a/b/deep.rs']);
});

test('walk is depth + count capped (pathological repos do not hang the drift run)', () => {
  // Build a very wide tree; assert the cap kicks in and we still
  // return (possibly truncated) without throwing.
  const tree = { src: 'dir' };
  for (let i = 0; i < 5000; i += 1) tree[`src/m${i}.rs`] = 'file';
  const { readdirSyncImpl, statSyncImpl } = vfs(tree);
  const r = enumerateSourceModules({
    projectCwd: '/proj', language: 'rust', moduleRoot: 'src/main.rs',
    readdirSyncImpl, statSyncImpl, maxFiles: 1000,
  });
  assert.equal(r.error, null);
  assert.ok(r.modules.length <= 1000, `expected <=1000 capped, got ${r.modules.length}`);
  assert.ok(r.truncated === true, 'truncation flag set when cap hit');
});

test('readdir throwing mid-walk is fail-soft (degrades, never throws out)', () => {
  const { statSyncImpl } = vfs({ src: 'dir', 'src/ok.rs': 'file' });
  const r = enumerateSourceModules({
    projectCwd: '/proj', language: 'rust', moduleRoot: 'src/main.rs',
    readdirSyncImpl: () => { throw new Error('EACCES'); },
    statSyncImpl,
  });
  // A blown readdir at the root yields empty, not a thrown error.
  assert.equal(r.error, null);
  assert.deepEqual(r.modules, []);
});
