import { ClaudeStreamJsonAdapter } from './ClaudeStreamJsonAdapter.js';
import { CodexExecAdapter } from './CodexExecAdapter.js';

/**
 * Provider-keyed RuntimeAdapter factory (the SP1a seam). Default for
 * RuntimeSupervisor.createAdapter. `anthropic` (and any unknown
 * provider) keeps the existing persistent-child Claude adapter,
 * byte-unchanged. `openai` returns the per-turn CodexExecAdapter
 * (no child; needs cwd + systemPrompt threaded via registerSessionAgent).
 */
export function createAdapterForProvider({ runtimeId, teamId, agentId, child, providerId, cwd, systemPrompt }) {
  if (providerId === 'openai') {
    return new CodexExecAdapter({ runtimeId, teamId, agentId, cwd, systemPrompt });
  }
  return new ClaudeStreamJsonAdapter({ runtimeId, teamId, agentId, child });
}
