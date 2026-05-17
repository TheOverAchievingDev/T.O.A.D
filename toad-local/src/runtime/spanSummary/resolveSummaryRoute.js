// Pure (Readability Layer-2 P3b-1). Route the summarizer to a CLI the
// workers are NOT on (compete with itself, not them). Only grounded
// "what plan are workers on" signal is teamConfig.lead.providerId.
// Availability/failover is the orchestrator's concern, not this fn.
export const SUMMARY_PROVIDER_MAP = Object.freeze({
  anthropic: Object.freeze({ cli: 'claude', model: 'haiku' }),
  openai: Object.freeze({ cli: 'codex', model: 'gpt-5-codex' }),
  gemini: Object.freeze({ cli: 'gemini', model: 'gemini-2.5-flash' }),
});

const PREFERENCE = Object.freeze(['gemini', 'openai', 'anthropic']);

export function resolveSummaryRoute({ leadProviderId, settings } = {}) {
  const lead =
    typeof leadProviderId === 'string' && SUMMARY_PROVIDER_MAP[leadProviderId]
      ? leadProviderId
      : 'anthropic';
  let providerId = PREFERENCE.find((p) => p !== lead) || 'gemini';
  const sm = settings && typeof settings === 'object' ? settings.summarizer : null;
  if (sm && typeof sm === 'object'
      && typeof sm.providerId === 'string' && SUMMARY_PROVIDER_MAP[sm.providerId]) {
    providerId = sm.providerId;
  }
  const base = SUMMARY_PROVIDER_MAP[providerId];
  let model = base.model;
  if (sm && typeof sm === 'object' && typeof sm.model === 'string' && sm.model.length > 0) {
    model = sm.model;
  }
  return { providerId, cli: base.cli, model };
}
