import * as claudeExtractor from './extractors/claudeExtractor.js';

const REGISTRY = Object.freeze({
  claude:    claudeExtractor,
  anthropic: claudeExtractor,
  // codex/gemini/opencode added by SP2 Tasks 4-6.
});

export const PROVIDER_KEYS = Object.freeze(Object.keys(REGISTRY));

export function getExtractor(providerId) {
  if (typeof providerId !== 'string' || providerId.length === 0) return null;
  return REGISTRY[providerId] || null;
}
