// Pure, browser-safe. LoC = REQUESTED Edit/Write activity (no tool_result
// exists). Write removed is unknowable → removedKnown:false (never guessed).
export function lineCount(s) {
  if (typeof s !== 'string' || s.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < s.length; i += 1) if (s[i] === '\n') n += 1;
  return s[s.length - 1] === '\n' ? n : n + 1;
}

export function locForEvent(event) {
  if (!event || event.type !== 'tool_use') return null;
  const name = typeof event.toolName === 'string' ? event.toolName.replace(/^mcp__[^_]+__/, '') : '';
  const input = (event.input && typeof event.input === 'object') ? event.input : {};
  const file = typeof input.file_path === 'string' ? input.file_path : '';
  if (name === 'Edit') {
    if (input.old_string === input.new_string) return { file, added: 0, removed: 0, removedKnown: true };
    return { file, added: lineCount(input.new_string), removed: lineCount(input.old_string), removedKnown: true };
  }
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    let a = 0; let r = 0;
    for (const ed of edits) {
      if (ed && ed.old_string === ed.new_string) continue; // no-op edit contributes nothing (§6.1)
      a += lineCount(ed && ed.new_string); r += lineCount(ed && ed.old_string);
    }
    return { file, added: a, removed: r, removedKnown: true };
  }
  if (name === 'Write') {
    return { file, added: lineCount(input.content), removed: 0, removedKnown: false };
  }
  return null;
}

// Minimal gitignore-subset: trailing-slash dir prefix, leading-slash anchor,
// and '*' (no slash) wildcard. Sufficient for LoC filtering; NOT a full
// gitignore engine (documented limitation). Rules are passed in (pure):
// the caller reads .gitignore + settings.runtime.locIgnorePaths at edit
// time and supplies them; locIgnorePaths AUGMENTS gitRules.
function matchOne(path, pat) {
  if (!pat) return false;
  let p = pat.trim();
  if (p.length === 0 || p.startsWith('#')) return false;
  const anchored = p.startsWith('/');
  if (anchored) p = p.slice(1);
  if (p.endsWith('/')) {
    const dir = p.slice(0, -1);
    return anchored ? path === dir || path.startsWith(`${dir}/`)
      : path === dir || path.includes(`${dir}/`) || path.startsWith(`${dir}/`);
  }
  const rx = new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
  const base = path.split('/').pop();
  return anchored ? rx.test(path) : rx.test(path) || rx.test(base);
}
export function isIgnored(path, gitRules, locIgnorePaths) {
  const norm = String(path).replace(/\\/g, '/').replace(/^\.?\//, '');
  const rules = [...(Array.isArray(gitRules) ? gitRules : []), ...(Array.isArray(locIgnorePaths) ? locIgnorePaths : [])];
  return rules.some((r) => matchOne(norm, r));
}

/**
 * @typedef {{ added: number, removed: number }} LocFileDelta
 * @typedef {{ added: number, removed: number, removedUnknown: boolean, filesTouched: number, byFile: Record<string, LocFileDelta> }} LocAgentTotals
 * @param {Array<unknown>} events
 * @param {{ gitRules?: string[], locIgnorePaths?: string[] }} [opts]
 * @returns {Record<string, LocAgentTotals>}
 */
export function accumulateLoc(events, { gitRules = [], locIgnorePaths = [] } = {}) {
  const acc = {};
  for (const e of (Array.isArray(events) ? events : [])) {
    const loc = locForEvent(e);
    if (!loc) continue;
    if (isIgnored(loc.file, gitRules, locIgnorePaths)) continue;
    const id = e && typeof e.agentId === 'string' ? e.agentId : 'unknown';
    const a = acc[id] || (acc[id] = { added: 0, removed: 0, removedUnknown: false, _files: new Set(), _byFile: {} });
    a.added += loc.added;
    a.removed += loc.removed;
    if (!loc.removedKnown) a.removedUnknown = true;
    if (loc.file) {
      a._files.add(loc.file);
      const bf = a._byFile[loc.file] || (a._byFile[loc.file] = { added: 0, removed: 0 });
      bf.added += loc.added;
      bf.removed += loc.removed;
    }
  }
  for (const id of Object.keys(acc)) {
    acc[id].filesTouched = acc[id]._files.size;
    acc[id].byFile = acc[id]._byFile;
    delete acc[id]._files;
    delete acc[id]._byFile;
  }
  return acc;
}
