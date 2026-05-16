import { readFileSync as realReadFileSync } from 'node:fs';
import { runGit as realRunGit } from '../../git/runGit.js';
import { evalConstitutionRule } from '../spec/evalConstitutionRule.js';
import { isTextFile } from '../spec/isTextFile.js';

/**
 * L1.3 gate enforcement at the merge boundary. Diff-scoped: blocks
 * ONLY violations THIS branch introduces vs trunk. Preexisting trunk
 * violations are surfaced (observer) but never block. See
 * docs/superpowers/specs/2026-05-15-broker-observer-seam-and-merge-gate-design.md.
 *
 * Returns:
 *   { blocked, introduced[], preexisting[], unsupported[],
 *     scanError: { command, file, message } | null }
 * introduced/preexisting items: { ruleId, file, line, snippet, description }
 *
 * Fail-OPEN: any scan/git error → blocked:false + scanError populated
 * (the caller emits a loud non-blocking observer finding). A scanner
 * bug must never wedge every team merge.
 */
export function constitutionMergeGate({
  projectCwd,
  worktreePath,
  baseRef,
  spec,
  runGit = realRunGit,
  readFileSyncImpl = realReadFileSync,
} = {}) {
  const out = { blocked: false, introduced: [], preexisting: [], unsupported: [], scanError: null };

  const reviewed = spec && spec.provenance && spec.provenance.reviewed === true;
  const rules = spec && spec.constitution && Array.isArray(spec.constitution.rules)
    ? spec.constitution.rules.filter((r) => r && r.mode === 'gate'
        && typeof r.id === 'string' && r.id.length > 0)
    : [];
  // Two-key: only a ratified spec + a gate-mode rule can ever block.
  if (!reviewed || rules.length === 0) return out;
  if (typeof projectCwd !== 'string' || typeof worktreePath !== 'string'
      || typeof baseRef !== 'string' || baseRef.length === 0) {
    return out;
  }

  // Changed files + status (A/M/D/R) — our own name-status call so we
  // know added-vs-modified (computeDiff only exposes --name-only).
  let diff;
  try {
    diff = runGit(['diff', '--name-status', `${baseRef}..HEAD`], { cwd: worktreePath });
  } catch (err) {
    out.scanError = { command: `git diff --name-status ${baseRef}..HEAD`, file: null, message: String(err && err.message ? err.message : err) };
    return out; // fail-open
  }
  if (!diff || diff.exitCode !== 0) {
    out.scanError = { command: `git diff --name-status ${baseRef}..HEAD`, file: null, message: (diff && diff.stderr) || 'git diff failed' };
    return out; // fail-open
  }

  const changed = [];
  for (const raw of String(diff.stdout || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^([ACDMRT])\S*\t(.+)$/.exec(line);
    if (!m) continue;
    const status = m[1];
    // For renames `R100\told\tnew` — take the destination path.
    const parts = line.split('\t');
    const file = parts[parts.length - 1];
    if (status === 'D') continue; // a deletion can't introduce a violation
    changed.push({ status, file });
  }

  for (const { status, file } of changed) {
    if (!isTextFile(file, { runGit, projectCwd })) continue;

    let wtContent;
    try {
      wtContent = readFileSyncImpl(`${worktreePath}/${file}`, 'utf-8');
    } catch {
      continue; // file unreadable in worktree (e.g. submodule) — skip
    }

    for (const rule of rules) {
      const wtHits = evalConstitutionRule(rule, { path: file, content: wtContent });
      if (wtHits === null) {
        if (!out.unsupported.includes(rule.id)) out.unsupported.push(rule.id);
        continue;
      }
      if (wtHits.length === 0) continue;

      // Added file: no trunk version exists — every hit is introduced.
      if (status === 'A') {
        for (const h of wtHits) {
          out.introduced.push({ ruleId: rule.id, file, line: h.line, snippet: h.snippet, description: rule.description || '' });
        }
        continue;
      }

      // Modified file: classify each hit against the trunk blob.
      let baseContent = null;
      let showErrored = false;
      try {
        const show = runGit(['show', `${baseRef}:${file}`], { cwd: projectCwd });
        if (show && show.exitCode === 0) baseContent = String(show.stdout || '');
        else showErrored = true;
      } catch (err) {
        showErrored = true;
        out.scanError = { command: `git show ${baseRef}:${file}`, file, message: String(err && err.message ? err.message : err) };
      }
      if (showErrored && baseContent === null) {
        // Could not read trunk side of a MODIFIED file → fail-open for
        // this file (do not guess). scanError already records why if
        // it threw; a non-zero exit (file new-to-baseRef despite 'M')
        // is rare — treat conservatively as fail-open, not a block.
        if (!out.scanError) {
          out.scanError = { command: `git show ${baseRef}:${file}`, file, message: 'git show non-zero (trunk side unavailable)' };
        }
        continue;
      }
      const baseHits = baseContent === null ? [] : (evalConstitutionRule(rule, { path: file, content: baseContent }) || []);
      // Match by NORMALIZED LINE CONTENT, not line number — a line
      // added above shifts numbers but the violation is the same one.
      const baseSnippets = new Set(baseHits.map((h) => h.snippet.trim()));
      for (const h of wtHits) {
        const item = { ruleId: rule.id, file, line: h.line, snippet: h.snippet, description: rule.description || '' };
        if (baseSnippets.has(h.snippet.trim())) out.preexisting.push(item);
        else out.introduced.push(item);
      }
    }
  }

  out.blocked = out.introduced.length > 0;
  return out;
}
