// Per-provider compaction thresholds. Sources (memory-grounded):
//  - claude/anthropic: 0.65 (the Claude CLI's OWN auto-compact at ~85%
//    is internal; our proactive trigger at 0.65 is the user-facing tier).
//  - codex: 0.70 (Codex CLI's /compact tier kicks in around 70% grounded).
//  - gemini: 0.60 (chatCompression.contextPercentageThreshold default).
//  - opencode: 0.70 (conservative; mirror codex until upstream documents).

export const PROVIDER_COMPACTION_THRESHOLDS = Object.freeze({
  claude:    Object.freeze({ trigger: 0.65 }),
  anthropic: Object.freeze({ trigger: 0.65 }),
  codex:     Object.freeze({ trigger: 0.70 }),
  gemini:    Object.freeze({ trigger: 0.60 }),
  opencode:  Object.freeze({ trigger: 0.70 }),
});

export const DEFAULT_THRESHOLD = Object.freeze({ trigger: 0.70 });

export function getProviderThreshold(providerId) {
  if (typeof providerId !== 'string' || providerId.length === 0) return DEFAULT_THRESHOLD;
  return PROVIDER_COMPACTION_THRESHOLDS[providerId] || DEFAULT_THRESHOLD;
}
