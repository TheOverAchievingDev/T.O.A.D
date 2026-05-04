/**
 * Pick the CLI + model the drift judge should spawn.
 *
 * Default: match the team's lead provider.
 * Override: settings.drift.tier{1,2}ModelOverride wins when set.
 *
 * Pure function — no I/O. Returns { cli, model }.
 */

export const PROVIDER_MAP = Object.freeze({
  anthropic: Object.freeze({
    cli: 'claude',
    tier1: 'haiku-4.5',
    tier2: 'opus-4.7',
  }),
  openai: Object.freeze({
    cli: 'codex',
    tier1: 'gpt-4o-mini',
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
