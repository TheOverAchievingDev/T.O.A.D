import test from 'node:test';
import assert from 'node:assert/strict';
import { scanContracts } from '../../../src/drift/spec/scanContracts.js';

// scanContracts walks the project (bounded, fail-soft) and asks ONE
// question per declared contract: does a function/route with that
// identifier exist in the source at all? (L1.4a — PRESENCE only.)
//
// §4a fence: the `signature` string is an OPAQUE presence anchor. We
// parse it only enough to pull the identifier. We never check arg
// types, return types, or — in this slice — arity (that is L1.4b).
//
// fs is injected via a virtual tree so tests never touch disk.

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
      const k = tree[r];
      if (k === undefined) { const e = new Error(`ENOENT ${abs}`); e.code = 'ENOENT'; throw e; }
      return { isDirectory: () => k === 'dir', isFile: () => typeof k === 'string', size: typeof k === 'string' ? k.length : 0 };
    },
    readFileSyncImpl: (abs) => {
      const r = rel(abs);
      if (typeof tree[r] !== 'string') { const e = new Error(`ENOENT ${abs}`); e.code = 'ENOENT'; throw e; }
      return tree[r];
    },
  };
}

const RUST = [
  { id: 'killer.kill', signature: 'fn kill(pids: &[u32]) -> KillReport' },
  { id: 'safety.is_protected', signature: 'fn is_protected(row: &ProcessRow) -> Option<ProtectedReason>' },
];

test('rust: declared contract whose fn exists in source → found, no missing', () => {
  const fs = vfs({
    src: 'dir',
    'src/killer.rs': 'pub fn kill(pids: &[u32]) -> KillReport {\n  todo!()\n}\n',
    'src/safety.rs': 'pub fn is_protected(row: &ProcessRow) -> Option<ProtectedReason> { None }\n',
  });
  const r = scanContracts({ projectCwd: '/proj', contracts: RUST, language: 'rust', ...fs });
  assert.equal(r.error, null);
  const byId = Object.fromEntries(r.results.map((x) => [x.id, x]));
  assert.equal(byId['killer.kill'].found, true);
  assert.equal(byId['safety.is_protected'].found, true);
  assert.deepEqual(r.missing, []);
});

test('rust: declared contract with NO matching fn definition → reported missing', () => {
  const fs = vfs({
    src: 'dir',
    'src/killer.rs': 'pub fn kill(pids: &[u32]) -> KillReport { todo!() }\n',
    // is_protected is never defined anywhere
  });
  const r = scanContracts({ projectCwd: '/proj', contracts: RUST, language: 'rust', ...fs });
  assert.equal(r.error, null);
  assert.deepEqual(r.missing, ['safety.is_protected']);
});

test('rust: a call site is NOT mistaken for a definition (presence = def, not use)', () => {
  const fs = vfs({
    src: 'dir',
    // only a CALL to kill(), never `fn kill(`
    'src/ui.rs': 'fn on_click() {\n    let report = kill(&selected);\n}\n',
  });
  const r = scanContracts({ projectCwd: '/proj', contracts: [RUST[0]], language: 'rust', ...fs });
  assert.deepEqual(r.missing, ['killer.kill'], 'a call must not satisfy a contract');
});

test('rust: generic fn definition (fn id<T>(...)) still counts as present', () => {
  const fs = vfs({
    src: 'dir',
    'src/killer.rs': 'pub fn kill<T: Into<u32>>(pids: &[T]) -> KillReport { todo!() }\n',
  });
  const r = scanContracts({ projectCwd: '/proj', contracts: [RUST[0]], language: 'rust', ...fs });
  assert.deepEqual(r.missing, []);
});

test('js/ts: function declaration, method, and arrow assignment all count as present', () => {
  const contracts = [
    { id: 'a.foo', signature: 'function foo(x)' },
    { id: 'b.bar', signature: 'bar(a, b)' },
    { id: 'c.baz', signature: 'baz(q)' },
  ];
  const fs = vfs({
    src: 'dir',
    'src/a.js': 'export function foo(x) { return x; }\n',
    'src/b.js': 'class C {\n  bar(a, b) { return a + b; }\n}\n',
    'src/c.js': 'const baz = (q) => q * 2;\n',
  });
  const r = scanContracts({ projectCwd: '/proj', contracts, language: 'javascript', ...fs });
  assert.deepEqual(r.missing, []);
});

test('identifier comes from the signature; falls back to last segment of id', () => {
  // No parseable `fn name(` in signature → fall back to id after last '.'
  const fs = vfs({ src: 'dir', 'src/x.rs': 'fn score(r: &Row) -> S { todo!() }\n' });
  const r = scanContracts({
    projectCwd: '/proj',
    contracts: [{ id: 'heuristics.score' }], // no signature at all
    language: 'rust',
    ...fs,
  });
  assert.deepEqual(r.missing, [], 'identifier resolved from id "heuristics.score" → score');
});

test('web contract (request_schema / kind:endpoint) is bucketed, not presence-scanned', () => {
  const contracts = [
    { id: 'auth.login', request_schema: { type: 'object', required: ['email'] } },
    { id: 'h.health', kind: 'endpoint', method: 'GET', path: '/health' },
    { id: 'killer.kill', signature: 'fn kill(p: &[u32]) -> R' },
  ];
  const fs = vfs({ src: 'dir', 'src/k.rs': 'fn kill(p: &[u32]) -> R { todo!() }\n' });
  const r = scanContracts({ projectCwd: '/proj', contracts, language: 'rust', ...fs });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.webContractIds.sort(), ['auth.login', 'h.health']);
});

test('unsupported language → honest error, no missing (never a silent wrong scan)', () => {
  const fs = vfs({ src: 'dir', 'src/x.hs': 'kill pids = undefined\n' });
  const r = scanContracts({ projectCwd: '/proj', contracts: RUST, language: 'haskell', ...fs });
  assert.match(r.error, /unsupported language/i);
  assert.deepEqual(r.missing, []);
});

test('docs/foundry/** is never scanned (the contract is DEFINED there)', () => {
  const fs = vfs({
    src: 'dir',
    'docs/foundry': 'dir',
    // spec.json literally contains "fn kill(...)" because it DECLARES it
    'docs/foundry/spec.json': '{"contracts":[{"signature":"fn kill(pids: &[u32]) -> R"}]}\n',
  });
  const r = scanContracts({ projectCwd: '/proj', contracts: [RUST[0]], language: 'rust', ...fs });
  assert.deepEqual(r.missing, ['killer.kill'], 'matching the spec itself is not implementation');
});

test('empty / absent contracts list → empty result, no walk', () => {
  const fs = vfs({ src: 'dir', 'src/k.rs': 'fn kill() {}\n' });
  const r = scanContracts({ projectCwd: '/proj', contracts: [], language: 'rust', ...fs });
  assert.deepEqual(r.results, []);
  assert.deepEqual(r.missing, []);
  assert.equal(r.error, null);
});

test('file-count cap is honored (pathological repo cannot hang the run)', () => {
  const tree = { src: 'dir' };
  for (let i = 0; i < 3000; i += 1) tree[`src/f${i}.rs`] = '// nothing\n';
  const fs = vfs(tree);
  const r = scanContracts({ projectCwd: '/proj', contracts: [RUST[0]], language: 'rust', maxFiles: 200, ...fs });
  assert.equal(r.error, null);
  assert.equal(r.truncated, true);
});
