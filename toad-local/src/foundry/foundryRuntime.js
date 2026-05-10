import { ClaudeFoundryAdapter } from './providers/ClaudeFoundryAdapter.js';
import { CodexFoundryAdapter } from './providers/CodexFoundryAdapter.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * FoundryRuntime — provider dispatcher for Foundry planning sessions.
 *
 * Holds one adapter per supported provider. `send`/`isAttached`/`close`
 * each take a `provider` arg and route to the matching adapter.
 *
 * F.1: persistent Claude subprocess. F.2: adds Codex via spawn-per-turn-
 * with-resume. F.2.5+: drop in GeminiFoundryAdapter under 'gemini'.
 */
export class FoundryRuntime {
  constructor({
    instructionsPath,
    projectCwdResolver,
    spawnImpl,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    onCrash = null,
    adapters = null, // injection point for tests
  } = {}) {
    if (adapters) {
      this.adapters = adapters;
    } else {
      if (typeof instructionsPath !== 'string' || instructionsPath.length === 0) {
        throw new TypeError('FoundryRuntime: instructionsPath is required when adapters are not injected');
      }
      const resolver = typeof projectCwdResolver === 'function'
        ? projectCwdResolver
        : (() => process.cwd());
      this.adapters = {
        anthropic: new ClaudeFoundryAdapter({ spawnImpl, instructionsPath, timeoutMs, onCrash }),
        openai:    new CodexFoundryAdapter({ spawnImpl, instructionsPath, projectCwdResolver: resolver, timeoutMs }),
      };
    }
  }

  async send({ foundrySessionId, text, cliSessionId = null, provider = 'anthropic' } = {}) {
    return this.#requireAdapter(provider).send({ foundrySessionId, text, cliSessionId });
  }

  isAttached({ foundrySessionId, provider = 'anthropic' } = {}) {
    return this.#requireAdapter(provider).isAttached({ foundrySessionId });
  }

  async close({ foundrySessionId, provider } = {}) {
    if (provider) {
      return this.#requireAdapter(provider).close({ foundrySessionId });
    }
    // Defensive: close on every adapter when provider unknown. Use
    // allSettled so a throwing adapter doesn't prevent the others from
    // closing — close failures should never cascade.
    await Promise.allSettled(
      Object.values(this.adapters).map((adapter) => adapter.close({ foundrySessionId })),
    );
  }

  async closeAll() {
    await Promise.allSettled(
      Object.values(this.adapters).map((adapter) => adapter.closeAll()),
    );
  }

  #requireAdapter(provider) {
    const adapter = this.adapters[provider];
    if (!adapter) throw new Error(`FoundryRuntime: unsupported provider "${provider}"`);
    return adapter;
  }
}
