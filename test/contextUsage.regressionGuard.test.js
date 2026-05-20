import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

// Structural regression guard (design §6): once the context-window
// denominator is single-sourced in MODEL_CONTEXT_WINDOW, NO other
// src/ or ui/src/ file may hardcode a context-window literal. This
// makes the split-denominator divergence (Bug 2) structurally hard
// to reintroduce. The regex covers BOTH window magnitudes —
// 200_000 (every current Claude family) and 1_000_000
// (claude-opus-4-1m). Do NOT drop 1_000_000: that would un-guard
// the opus-1m window. Tighten only via audited file :(exclude)s.
test('no hardcoded context-window literal outside the single-source map', () => {
  let hits = '';
  try {
    hits = execSync(
      `git -C /c/Project-TOAD grep -nE "200[_]?000|1[_]?000[_]?000" -- ` +
      `src ui/src ` +
      // The canonical single source — the ONLY place a window literal lives.
      `":(exclude)src/runtime/contextUsage/modelContextWindow.js" ` +
      // Audited 2026-05-16: the following use 1_000_000 for per-million
      // COST-RATE math / M|m-suffix number FORMATTING — NOT a
      // context-window denominator (verified: no token-limit/occupancy
      // divisor). Excluded so the guard stays strict everywhere else.
      `":(exclude)ui/src/components/CostsScreen.tsx" ` +
      `":(exclude)ui/src/components/PlanUsagePanel.tsx" ` +
      `":(exclude)ui/src/components/Workspace.tsx"`,
      { encoding: 'utf8' }
    );
  } catch (e) {
    // git grep exits 1 when no matches — that's the pass case.
    hits = e.status === 1 ? '' : (e.stdout || '');
  }
  assert.equal(hits.trim(), '',
    `hardcoded context-window literal(s) found — route through MODEL_CONTEXT_WINDOW (do NOT add to the :(exclude) list unless audited non-denominator):\n${hits}`);
});
