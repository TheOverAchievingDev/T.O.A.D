import { ClaudeStreamJsonAdapter } from './ClaudeStreamJsonAdapter.js';
import { CodexExecAdapter } from './CodexExecAdapter.js';
import { GeminiExecAdapter } from './GeminiExecAdapter.js';
import { OpencodeExecAdapter } from './OpencodeExecAdapter.js';

/**
 * Provider-keyed RuntimeAdapter factory (the SP1a seam). Default for
 * RuntimeSupervisor.createAdapter. `anthropic` (and any unknown
 * provider) keeps the existing persistent-child Claude adapter,
 * byte-unchanged. `openai` returns the per-turn CodexExecAdapter
 * (no child; needs cwd + systemPrompt threaded via registerSessionAgent).
 */
export function createAdapterForProvider({
  runtimeId, teamId, agentId, child, providerId, cwd, systemPrompt, args,
  sessionStore, turnTimeoutMs,
}) {
  if (providerId === 'openai') {
    return new CodexExecAdapter({ runtimeId, teamId, agentId, cwd, systemPrompt, sessionStore, turnTimeoutMs });
  }
  if (providerId === 'gemini') {
    return new GeminiExecAdapter({ runtimeId, teamId, agentId, cwd, systemPrompt, sessionStore, turnTimeoutMs });
  }
  if (providerId === 'opencode') {
    return new OpencodeExecAdapter({ runtimeId, teamId, agentId, cwd, systemPrompt, args, sessionStore, turnTimeoutMs });
  }
  return new ClaudeStreamJsonAdapter({ runtimeId, teamId, agentId, child });
}
