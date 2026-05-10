/**
 * Abstract base class for Foundry CLI adapters. One subclass per provider.
 *
 * Subclasses MUST implement send() and SHOULD override isAttached(),
 * close(), and closeAll() if they hold cross-turn state (e.g. persistent
 * subprocesses).
 *
 * Mirrors the runtime tier's RuntimeAdapter pattern (src/runtime/RuntimeAdapter.js).
 */
export class FoundryProviderAdapter {
  constructor(providerId) {
    if (new.target === FoundryProviderAdapter) {
      throw new TypeError('FoundryProviderAdapter is an abstract base class');
    }
    if (typeof providerId !== 'string' || providerId.length === 0) {
      throw new TypeError('FoundryProviderAdapter: providerId required');
    }
    this.providerId = providerId;
  }

  /**
   * Send a user message and await the assistant response.
   * @param {{ foundrySessionId: string, text: string, cliSessionId?: string|null }} _args
   * @returns {Promise<{ text: string, sessionUuid: string, model?: string|null, eventCount: number }>}
   */
  async send(_args) {
    throw new Error(`${this.providerId}: send() not implemented`);
  }

  /** True when the adapter holds in-memory state that close() would tear down. */
  isAttached(_args) {
    return false;
  }

  async close(_args) { /* no-op default */ }
  async closeAll() { /* no-op default */ }
}
