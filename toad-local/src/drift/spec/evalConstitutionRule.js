const CLIKE_EXT = /\.(rs|js|jsx|ts|tsx|mjs|cjs|go|java|kt|c|h|cpp|hpp|cs|swift|gradle|css|scss)$/i;
const HASH_EXT = /\.(toml|py|sh|bash|zsh|yaml|yml|ini|cfg|env|properties|conf)$/i;

function stripComments(line, path) {
  if (CLIKE_EXT.test(path)) {
    let s = line.replace(/\/\*[\s\S]*?\*\//g, ' ');
    s = s.replace(/(^|[^:])\/\/.*$/, '$1');
    return s;
  }
  if (HASH_EXT.test(path)) return line.replace(/#.*$/, '');
  return line;
}

function globToRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; }
      else re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) re += `\\${c}`;
    else if (c === '?') re += '[^/]';
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function matchesAny(path, globs) {
  if (!Array.isArray(globs) || globs.length === 0) return false;
  for (const g of globs) {
    if (typeof g !== 'string' || g.length === 0) continue;
    try { if (globToRe(g).test(path)) return true; } catch { /* skip bad glob */ }
  }
  return false;
}

/**
 * Evaluate ONE constitution rule against ONE file's content.
 * Single source of truth shared by scanConstitution (whole-tree) and
 * constitutionMergeGate (diff-scoped).
 *
 * @returns {Array<{line:number,snippet:string}>|null}
 *   array (possibly empty) of ALL hits for a supported rule;
 *   null = unsupported detector type OR uncompilable regex (caller
 *   records it as "not enforced" — never treat null as "clean").
 */
export function evalConstitutionRule(rule, { path, content }) {
  const t = rule && rule.detector && rule.detector.type;
  if (t === 'path_presence') {
    if (matchesAny(path, rule.detector.forbidden_paths)) {
      return [{ line: 0, snippet: `forbidden path present: ${path}` }];
    }
    return [];
  }
  if (t === 'grep') {
    if (matchesAny(path, rule.detector.exclude_paths)) return [];
    let re;
    try { re = new RegExp(rule.detector.pattern); } catch { return null; }
    const hits = [];
    const lines = String(content ?? '').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const code = stripComments(lines[i], path);
      if (code.length === 0) continue;
      re.lastIndex = 0;
      if (re.test(code)) hits.push({ line: i + 1, snippet: lines[i].trim().slice(0, 200) });
    }
    return hits;
  }
  return null;
}
