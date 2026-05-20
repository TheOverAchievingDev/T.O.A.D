/**
 * Single source of truth for the providerId → CLI command mapping.
 *
 * Three places need this:
 *   - team_create / normalizeMember: derive the spawn binary when the
 *     caller (UI, foundry materialize) supplied only providerId.
 *   - agent_swap_provider: write both fields when the operator swaps a
 *     live agent's provider.
 *   - Any future "import legacy team config" path that needs to repair
 *     mismatched command/providerId pairs.
 *
 * Keep this map in sync with the providerLabels enum on the UI side
 * (toad-local/ui/src/data/providerLabels.ts). Drift between these two
 * was the root cause of the 2026-05-15 "Codex selected but Claude
 * spawned" bug: the CreateTeamModal sent providerId='openai' but no
 * command field, and normalizeMember hardcoded 'claude' as the
 * fallback. The result silently spawned the wrong binary for every
 * non-Anthropic member.
 */
export const PROVIDER_COMMANDS = Object.freeze({
  anthropic: 'claude',
  openai: 'codex',
  gemini: 'gemini',
  opencode: 'opencode',
});

/**
 * Resolve a providerId to its canonical CLI binary name.
 *
 * Returns null for unknown providers (caller decides whether to fall
 * back to a default or refuse). Empty/missing input → null too.
 */
export function commandForProvider(providerId) {
  if (typeof providerId !== 'string' || providerId.length === 0) return null;
  const cmd = PROVIDER_COMMANDS[providerId];
  return typeof cmd === 'string' ? cmd : null;
}

/**
 * Inverse: given a CLI binary name, return the provider it belongs to.
 * Useful when a legacy team config has `command` but no `providerId`
 * — we can recover the provider without losing the operator's
 * historical intent. Returns null for unknown commands.
 */
export function providerForCommand(command) {
  if (typeof command !== 'string' || command.length === 0) return null;
  for (const [providerId, cmd] of Object.entries(PROVIDER_COMMANDS)) {
    if (cmd === command) return providerId;
  }
  return null;
}
