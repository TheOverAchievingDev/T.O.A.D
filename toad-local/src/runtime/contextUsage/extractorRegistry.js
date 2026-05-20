import * as claudeExtractor from './extractors/claudeExtractor.js';

const REGISTRY = Object.freeze({
  claude:    claudeExtractor,
  anthropic: claudeExtractor,
  // codex/gemini/opencode added by SP2 Tasks 4-6.
});

export const PROVIDER_KEYS = Object.freeze(Object.keys(REGISTRY));

export function getExtractor(providerId) {
  if (typeof providerId !== 'string' || providerId.length === 0) return null;
  // Own-property check: REGISTRY[providerId] would resolve inherited
  // keys like '__proto__' or 'constructor' as truthy (Object.prototype
  // / Object), which would then fail the dispatcher's extractor.* call.
  // hasOwnProperty.call closes that path; the dispatcher stays no-throw.
  return Object.prototype.hasOwnProperty.call(REGISTRY, providerId) ? REGISTRY[providerId] : null;
}
