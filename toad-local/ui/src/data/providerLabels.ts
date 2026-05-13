/**
 * Provider-id → friendly-name helpers.
 *
 * The backend deals in stable provider ids ('anthropic', 'openai',
 * 'opencode', 'gemini'). The UI displays friendly labels — sometimes
 * the brand name ("Claude", "Codex"), sometimes the company ("Anthropic"),
 * depending on context.
 *
 * One place to map them, so we don't end up with "OpenAI Codex" in one
 * surface, "openai" in another, and "Codex" in a third — which is what
 * spawned Bug 1 (the launching screen was showing the raw provider id
 * instead of a friendly name, so "openai" looked like the wrong thing
 * had been selected).
 */

/** Provider ids accepted by the backend. */
export type ProviderId = 'anthropic' | 'openai' | 'opencode' | 'gemini' | (string & {});

/**
 * Short brand name — what the user thinks of as "the AI" they're talking
 * to. Used in tight chrome (status pills, launching messages, agent
 * cards). "Claude" not "Anthropic", "Codex" not "OpenAI".
 */
export function providerBrand(providerId: ProviderId | null | undefined): string {
  switch (providerId) {
    case 'anthropic':  return 'Claude';
    case 'openai':     return 'Codex';
    case 'opencode':   return 'OpenCode';
    case 'gemini':     return 'Gemini';
    case null:
    case undefined:
    case '':
      return 'Unknown';
    default:
      return String(providerId);
  }
}

/**
 * Long label — what shows in dropdowns and settings panels where the
 * user is choosing between providers and wants the full vendor name.
 */
export function providerLabel(providerId: ProviderId | null | undefined): string {
  switch (providerId) {
    case 'anthropic':  return 'Anthropic Claude';
    case 'openai':     return 'OpenAI Codex';
    case 'opencode':   return 'OpenCode';
    case 'gemini':     return 'Google Gemini';
    case null:
    case undefined:
    case '':
      return 'Unknown';
    default:
      return String(providerId);
  }
}
