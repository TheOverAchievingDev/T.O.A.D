/**
 * Single source of truth for a model's context-window size (the
 * denominator for context-usage %). Keyed by family prefix so a
 * versioned id (claude-sonnet-4-5-YYYYMMDD) resolves without a new
 * entry per date. Unknown → null: the caller reports source:'unknown'
 * and a null percentage rather than guessing (design §2 Bug 2 / §3).
 *
 * Adding a model is a one-line change here and ONLY here — never
 * hardcode a window elsewhere (a structural regression guard test
 * enforces this; design §6).
 */
export const MODEL_CONTEXT_WINDOW = Object.freeze({
  // family prefix → tokens
  'claude-sonnet': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-haiku': 200_000,
  'claude-3-opus': 200_000,
  'claude-opus-4-1m': 1_000_000,
  'claude-opus': 200_000,
  // Non-Claude entries added for SP2 per-provider usage reporting.
  // Codex (OpenAI): GPT-5 variants ship with 128K at time of writing.
  'gpt-5': 128_000,
  // Gemini: 2.5 Pro ships with 1M token context window.
  'gemini-2.5': 1_000_000,
  'gemini-2.0': 1_000_000,
  // OpenCode: Qwen Coder variants ship with 128K context.
  'qwen': 128_000,
});

export function resolveContextWindow(model) {
  if (typeof model !== 'string' || model.length === 0) return null;
  // Longest-prefix match so 'claude-opus-4-1m' beats 'claude-opus'.
  let best = null;
  let bestLen = -1;
  for (const prefix of Object.keys(MODEL_CONTEXT_WINDOW)) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = MODEL_CONTEXT_WINDOW[prefix];
      bestLen = prefix.length;
    }
  }
  return best;
}
