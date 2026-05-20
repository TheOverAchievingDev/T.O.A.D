import {
  readdirSync as realReaddirSync,
  statSync as realStatSync,
  readFileSync as realReadFileSync,
} from 'node:fs';

/**
 * Apply spec.contracts[] against the project tree — L1.4a, the LAST
 * Layer-1 deterministic check (reviewer order: dependency → structural
 * → constitution → contract).
 *
 * THIS SLICE = PRESENCE ONLY. The one question per contract: does a
 * function with that identifier exist *as a definition* anywhere in
 * the source? Not "is it called", not "are the types right".
 *
 * §4a fence (restated here so a future contributor does not "improve"
 * this into a type validator): the `signature` string is an OPAQUE
 * presence anchor. We parse it only enough to pull the identifier.
 * Argument-count / arity comparison is its own follow-up slice
 * (L1.4b) — split off for the same wolf-cry reason L1.2 was split
 * a/b: arity across self-receivers, generic commas, and multi-line
 * sigs is FP-dense and deserves its own dogfood. Type correctness is
 * the COMPILER's job (validation_run) and is NEVER in scope.
 *
 * Web contracts (request_schema / response_schema / kind:endpoint)
 * need route-registration enumeration — a separate surface. They are
 * bucketed into `webContractIds` and NOT presence-scanned here; the
 * check turns that into one honest "endpoint contract drift is a
 * later slice" meta rather than silently passing them.
 *
 * Bounded + fail-soft, identical discipline to scanConstitution:
 * ignores build/vendor dirs; depth + file-count + per-file-size caps;
 * never reads docs/foundry/** (the contract is DEFINED there — a
 * match against spec.json itself is a guaranteed false positive);
 * every fs call wrapped; never throws.
 *
 * Returns:
 *   { results: [{ id, identifier, found }],
 *     missing: string[],          // contract ids with no definition
 *     webContractIds: string[],   // deferred to the web slice
 *     unsupported: string[],      // (reserved; arity slice will use)
 *     error: string|null, truncated: boolean }
 */
const DEFAULT_MAX_FILES = 4000;
const MAX_DEPTH = 24;
const MAX_FILE_BYTES = 512 * 1024;
const IGNORED_DIRS = new Set([
  'target', 'node_modules', '.git', '.toad', 'dist', 'build', '.next',
  'coverage', '.venv', '__pycache__', 'vendor',
]);
// docs/foundry/ is the contract-DEFINITION surface: spec.json literally
// contains the signature strings because it DECLARES them. Scanning the
// rulebook for satisfaction of itself is a guaranteed false positive
// (same lesson as scanConstitution's 2026-05-15 dogfood).
const EXCLUDE_PATH_PREFIXES = ['docs/foundry'];

function isExcludedPath(rel) {
  for (const p of EXCLUDE_PATH_PREFIXES) {
    if (rel === p || rel.startsWith(`${p}/`)) return true;
  }
  return false;
}

const TEXT_EXT = /\.(rs|toml|js|jsx|ts|tsx|mjs|cjs|json|md|txt|py|go|java|kt|rb|c|h|cpp|hpp|cs|swift|sh|bat|ps1|yaml|yml|cfg|ini|env|manifest|xml|html|css|sql|gradle|properties|lock)$/i;

// Language → which file extensions hold its definitions, plus a
// per-identifier "is this DEFINED here" matcher factory. Presence =
// a definition, never a call site (the dominant FP class).
const RUST_LANGS = new Set(['rust', 'rs']);
const JS_LANGS = new Set([
  'javascript', 'js', 'typescript', 'ts', 'node', 'nodejs',
]);

function esc(id) {
  return id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Build the language-aware DEFINITION regexes for an identifier.
 * Returns null for an unsupported language (caller emits honest error).
 */
function defMatchers(language, identifier) {
  const i = esc(identifier);
  if (RUST_LANGS.has(language)) {
    // `fn name(` or generic `fn name<...>(` — a call has no `fn`.
    return [new RegExp(`\\bfn\\s+${i}\\s*[<(]`)];
  }
  if (JS_LANGS.has(language)) {
    return [
      new RegExp(`\\bfunction\\s*\\*?\\s+${i}\\s*\\(`),          // function decl
      new RegExp(`\\b${i}\\s*\\([^)]*\\)\\s*\\{`),                 // method / shorthand def
      new RegExp(`\\b${i}\\s*[:=]\\s*(async\\s+)?(function\\b|\\(?[^=;]*=>)`), // arrow / fn-expr
    ];
  }
  return null;
}

function langExtOk(language, name) {
  if (RUST_LANGS.has(language)) return /\.rs$/i.test(name);
  if (JS_LANGS.has(language)) return /\.(js|jsx|ts|tsx|mjs|cjs)$/i.test(name);
  return false;
}

/**
 * Resolve the identifier a contract names. Signature first (parsed
 * only enough — §4a), falling back to the last dotted segment of `id`.
 */
function resolveIdentifier(contract) {
  const sig = typeof contract.signature === 'string' ? contract.signature : '';
  if (sig) {
    let m = /(?:\bfn|\bfunction|\bdef)\s+([A-Za-z_$][\w$]*)/.exec(sig);
    if (m) return m[1];
    m = /^\s*([A-Za-z_$][\w$]*)\s*\(/.exec(sig);
    if (m) return m[1];
  }
  const id = typeof contract.id === 'string' ? contract.id : '';
  if (!id) return null;
  const seg = id.split('.').filter(Boolean);
  return seg.length > 0 ? seg[seg.length - 1] : null;
}

// ── L1.4b arity (§4a: presence + ARITY, never types) ───────────────
// Discipline: return a number ONLY when the parse is unambiguous. ANY
// uncertainty → null, so checkContractDrift degrades to presence-only
// and never wolf-cries on a count it isn't sure of.

const SCAN_CAP = 4000; // bound the paren scan; a real signature is tiny

/**
 * From an opening '(' at openIdx, return the substring strictly inside
 * its matching ')'. null if unbalanced within SCAN_CAP (→ ambiguous).
 */
function extractBalancedParen(str, openIdx) {
  if (str[openIdx] !== '(') return null;
  let depth = 0;
  const end = Math.min(str.length, openIdx + SCAN_CAP);
  for (let i = openIdx; i < end; i += 1) {
    const ch = str[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return str.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * Skip a balanced `<...>` generic clause starting at idx (str[idx]
 * === '<'). Returns the index just past the matching '>', or -1 if
 * unbalanced. Treats `->`/`=>` as NOT closing a generic.
 */
function skipGenerics(str, idx) {
  if (str[idx] !== '<') return idx;
  let depth = 0;
  const end = Math.min(str.length, idx + SCAN_CAP);
  for (let i = idx; i < end; i += 1) {
    const ch = str[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      if (str[i - 1] === '-' || str[i - 1] === '=') continue; // -> / =>
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Count top-level arguments in a parameter substring. Depth-aware over
 * () [] {} <> so generic / tuple / closure / array commas are not
 * separators. Returns null on any ambiguity (unbalanced, JS
 * destructuring / rest / default — logical arity not a fixed count).
 */
function arityFromParams(paramStr, lang) {
  if (typeof paramStr !== 'string') return null;
  const s = paramStr.trim();
  if (s.length === 0) return 0;
  const segs = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; cur += ch; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1; if (depth < 0) return null; cur += ch; continue;
    }
    if (ch === '<') { depth += 1; cur += ch; continue; }
    if (ch === '>') {
      if (s[i - 1] === '-' || s[i - 1] === '=') { cur += ch; continue; } // ->/=>
      depth -= 1; if (depth < 0) return null; cur += ch; continue;
    }
    if (ch === ',' && depth === 0) { segs.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (depth !== 0) return null;
  if (cur.trim().length > 0) segs.push(cur);
  const params = segs.map((x) => x.trim()).filter((x) => x.length > 0);
  if (params.length === 0) return 0;

  if (RUST_LANGS.has(lang)) {
    // self / &self / &mut self / &'a self is a RECEIVER, not an arg.
    if (/^&?\s*(?:'[A-Za-z_]\w*\s+)?(?:mut\s+)?self$/.test(params[0])) {
      params.shift();
    }
  }
  if (JS_LANGS.has(lang)) {
    for (const p of params) {
      // rest, destructuring, or a default value → logical arity is not
      // a fixed number we can compare honestly. Bail (presence-only).
      if (p.startsWith('...') || p.startsWith('{') || p.startsWith('[')) return null;
      if (/(^|[^=!<>])=(?!=)/.test(p)) return null; // default value
    }
  }
  return params.length;
}

function declaredArity(signature, lang) {
  if (typeof signature !== 'string' || signature.length === 0) return null;
  // First '(' in a (single-line) signature is the param list — a Rust
  // generic clause `<...>` has no parens so it never precedes wrongly.
  const open = signature.indexOf('(');
  if (open < 0) return null;
  const inner = extractBalancedParen(signature, open);
  if (inner === null) return null;
  return arityFromParams(inner, lang);
}

/**
 * Given content and a definition regex match, locate the parameter
 * '(' and return the found definition's arity (or null if ambiguous).
 * Rust: match ends at `<` or `(` (the `[<(]` matcher) — skip a
 * generic clause if present. JS: scan a small window from the
 * identifier to the first '('.
 */
function foundArityFromMatch(content, match, lang) {
  if (!match) return null;
  const matchEnd = match.index + match[0].length;
  if (RUST_LANGS.has(lang)) {
    let i = matchEnd - 1; // the [<(] char
    if (content[i] === '<') {
      i = skipGenerics(content, i);
      if (i < 0) return null;
      while (i < content.length && /\s/.test(content[i])) i += 1;
    }
    if (content[i] !== '(') return null;
    const inner = extractBalancedParen(content, i);
    return inner === null ? null : arityFromParams(inner, lang);
  }
  // JS: find the first '(' within a bounded window after the match
  // start; bail if we hit a statement terminator first.
  const winEnd = Math.min(content.length, match.index + 200);
  for (let i = match.index; i < winEnd; i += 1) {
    const ch = content[i];
    if (ch === '(') {
      const inner = extractBalancedParen(content, i);
      return inner === null ? null : arityFromParams(inner, lang);
    }
    if (ch === ';' || ch === '{') return null; // no clean param list
  }
  return null;
}

function isWebContract(c) {
  return (c && (
    (c.request_schema && typeof c.request_schema === 'object')
    || (c.response_schema && typeof c.response_schema === 'object')
    || c.kind === 'endpoint'
  )) === true;
}

export function scanContracts({
  projectCwd,
  contracts,
  language,
  maxFiles = DEFAULT_MAX_FILES,
  readdirSyncImpl = realReaddirSync,
  statSyncImpl = realStatSync,
  readFileSyncImpl = realReadFileSync,
} = {}) {
  const out = {
    results: [], missing: [], webContractIds: [], unsupported: [],
    error: null, truncated: false,
  };
  const list = Array.isArray(contracts) ? contracts : [];
  if (list.length === 0) return out;
  if (typeof projectCwd !== 'string' || projectCwd.length === 0) return out;

  const lang = typeof language === 'string' ? language.toLowerCase() : '';

  // Bucket web vs internal; resolve identifiers for internal ones.
  const internal = [];
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    const id = typeof c.id === 'string' && c.id.length > 0 ? c.id : '(unnamed)';
    if (isWebContract(c)) { out.webContractIds.push(id); continue; }
    const identifier = resolveIdentifier(c);
    if (!identifier) { out.webContractIds.push(id); continue; }
    internal.push({
      id,
      identifier,
      signature: typeof c.signature === 'string' ? c.signature : null,
    });
  }
  if (internal.length === 0) return out;

  // Language must be known BEFORE we walk — an unknown language can't
  // be presence-scanned, and silently "finding nothing" would wolf-cry
  // every contract as missing. Honest error instead.
  const probe = defMatchers(lang, 'x');
  if (probe === null) {
    out.error = `unsupported language for contract presence scan: ${language}`;
    return out;
  }

  // Compile matchers once per contract. declaredArity is parsed once
  // from the signature here (§4a: identifier + arg count only).
  const compiled = internal.map((c) => ({
    ...c,
    found: false,
    foundArity: null,
    declaredArity: declaredArity(c.signature, lang),
    res: defMatchers(lang, c.identifier),
  }));

  const root = projectCwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const stack = [{ abs: root, depth: 0 }];
  let scanned = 0;
  while (stack.length > 0) {
    if (scanned >= maxFiles) { out.truncated = true; break; }
    const { abs, depth } = stack.pop();
    if (depth > MAX_DEPTH) continue;
    let entries;
    try { entries = readdirSyncImpl(abs); } catch { continue; }
    if (!Array.isArray(entries)) continue;
    for (const name of entries) {
      if (scanned >= maxFiles) { out.truncated = true; break; }
      if (IGNORED_DIRS.has(name)) continue;
      const childAbs = `${abs}/${name}`;
      let st;
      try { st = statSyncImpl(childAbs); } catch { continue; }
      const rel = childAbs.slice(root.length + 1);
      if (isExcludedPath(rel)) continue;
      if (st && typeof st.isDirectory === 'function' && st.isDirectory()) {
        stack.push({ abs: childAbs, depth: depth + 1 });
        continue;
      }
      if (!st || typeof st.isFile !== 'function' || !st.isFile()) continue;
      scanned += 1;
      if (!TEXT_EXT.test(name)) continue;
      if (!langExtOk(lang, name)) continue;
      if (typeof st.size === 'number' && st.size > MAX_FILE_BYTES) continue;
      let content;
      try { content = readFileSyncImpl(childAbs, 'utf-8'); } catch { continue; }
      if (typeof content !== 'string' || content.length === 0) continue;
      for (const c of compiled) {
        if (c.found) continue;
        for (const re of c.res) {
          re.lastIndex = 0;
          const m = re.exec(content);
          if (m) {
            c.found = true;
            // Capture arity from the SAME (first) definition match.
            // Ambiguous parse → null → presence-only for this contract.
            c.foundArity = foundArityFromMatch(content, m, lang);
            break;
          }
        }
      }
    }
  }

  for (const c of compiled) {
    out.results.push({
      id: c.id,
      identifier: c.identifier,
      found: c.found,
      declaredArity: c.declaredArity,
      foundArity: c.found ? c.foundArity : null,
    });
    if (!c.found) out.missing.push(c.id);
  }
  return out;
}
