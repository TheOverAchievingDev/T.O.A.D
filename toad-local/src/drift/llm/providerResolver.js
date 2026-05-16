/**
 * Pick the CLI + model the drift judge should spawn.
 *
 * Default: match the team's lead provider.
 * Override: settings.drift.tier{1,2}ModelOverride wins when set.
 *
 * Pure function — no I/O. Returns { cli, model }.
 */

/**
 * CLI + model strings each provider's drift judge will spawn.
 *
 * IMPORTANT: these strings are passed verbatim to the provider CLI's
 * `--model` flag. They MUST be values that CLI accepts; otherwise
 * every drift run emits a `judge_failed` meta-finding and the team
 * score sticks at +8 forever. Empirically verified per provider:
 *
 * Claude CLI: accepts aliases `haiku` | `sonnet` | `opus` (always
 *   resolve to the latest stable of that family) OR full versioned
 *   ids like `claude-haiku-4-5-20251022`. REJECTS hyphenated-version
 *   shorthands like `haiku-4.5` with exit code 1 and the message
 *   "There's an issue with the selected model (haiku-4.5). It may
 *   not exist or you may not have access to it." (2026-05-14 bug —
 *   the prior PROVIDER_MAP shipped those rejected names and every
 *   drift LLM check failed silently on stdout.)
 *   §8a doctrine (L3 drift-judge reform): Haiku for the common case
 *   (tier1); escalate to Sonnet only when Haiku flags ambiguity
 *   (tier2). Opus is NOT the escalation target — `sonnet` alias.
 *
 * Codex CLI: accepts the model strings the user can pick in their
 *   ChatGPT plan dashboard. `gpt-5` (Plus tier) is the safest tier-2
 *   default. Tier-1 wants a cheaper/faster option — `gpt-5-codex` is
 *   typical for the codex CLI specifically (it's the model tuned for
 *   coding agents); fall back to override if a given user's account
 *   only enables `gpt-4o-mini` or `o4-mini-high`.
 *
 * Gemini CLI: accepts the public Gemini model ids. `gemini-2.5-flash`
 *   and `gemini-2.5-pro` are the current public tiers and are accepted
 *   by the Gemini CLI's --model flag verbatim.
 *
 * For precise control / older account tiers, the operator can set
 * `settings.drift.tier1ModelOverride` / `tier2ModelOverride` and skip
 * this map entirely.
 */
export const PROVIDER_MAP = Object.freeze({
  anthropic: Object.freeze({
    cli: 'claude',
    tier1: 'haiku',
    tier2: 'sonnet',
  }),
  openai: Object.freeze({
    cli: 'codex',
    tier1: 'gpt-5-codex',
    tier2: 'gpt-5',
  }),
  gemini: Object.freeze({
    cli: 'gemini',
    tier1: 'gemini-2.5-flash',
    tier2: 'gemini-2.5-pro',
  }),
});

const FALLBACK_PROVIDER = 'anthropic';

export function resolveProvider({ teamConfig, settings, tier } = {}) {
  if (tier !== 1 && tier !== 2) {
    throw new TypeError(`resolveProvider: tier must be 1 or 2 (got ${tier})`);
  }
  const driftSettings = settings?.drift ?? {};
  const override = tier === 1
    ? driftSettings.tier1ModelOverride
    : driftSettings.tier2ModelOverride;

  const leadProviderId = teamConfig?.lead?.providerId ?? FALLBACK_PROVIDER;
  const provider = PROVIDER_MAP[leadProviderId] || PROVIDER_MAP[FALLBACK_PROVIDER];

  return {
    cli: provider.cli,
    model: typeof override === 'string' && override.length > 0
      ? override
      : (tier === 1 ? provider.tier1 : provider.tier2),
  };
}
