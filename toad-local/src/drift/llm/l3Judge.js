import { llmJudge as defaultLlmJudge } from './llmJudge.js';
import { buildL3SystemPrompt } from './prompts/l3.js';

function defaultConfidenceOf(_i, result) {
  try {
    const parsed = JSON.parse(String(result?.rawText ?? '').trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
    return parsed && parsed.confidence === 'low' ? 'low' : 'high';
  } catch { return 'high'; }
}

function capHaiku(findings) {
  return (Array.isArray(findings) ? findings : []).map((f) =>
    (f && f.severity === 'critical' ? { ...f, severity: 'high' } : f));
}

/**
 * Haiku-first; ONE Sonnet escalation iff Haiku self-reports
 * confidence:'low'. Never loops (exactly one escalation max). Haiku-
 * tier criticals capped to high — the tier-1-can't-emit-critical
 * invariant is INTRODUCED here (it previously lived only in the
 * deleted checkLlmSemantic.js:257; verified during spec review).
 * Throws on judge failure — the engine converts that to a
 * non-blocking meta and does NOT cache it.
 */
export async function l3Judge({
  packet, provider, systemPrompt, briefPath = null, cwd = null,
  isolateHome = false, timeoutMs = 30_000,
  llmJudgeImpl, confidenceOf = defaultConfidenceOf,
} = {}) {
  const judge = llmJudgeImpl || defaultLlmJudge;
  const sys = systemPrompt || buildL3SystemPrompt();

  const haiku = await judge({
    cli: provider.cli, model: provider.tier1, systemPrompt: sys,
    userPayload: packet, briefPath, cwd, isolateHome, timeoutMs,
  });
  if (confidenceOf(0, haiku) !== 'low') {
    return { findings: capHaiku(haiku.findings), tier: 'haiku', confidence: 'high', rawText: haiku.rawText };
  }
  // exactly one escalation — same packet, stronger model
  const sonnet = await judge({
    cli: provider.cli, model: provider.tier2, systemPrompt: sys,
    userPayload: packet, briefPath, cwd, isolateHome, timeoutMs,
  });
  const sonnetLow = confidenceOf(1, sonnet) === 'low';
  return {
    findings: sonnet.findings,
    tier: 'sonnet-escalated',
    confidence: sonnetLow ? 'low' : 'high',
    rawText: sonnet.rawText,
  };
}
