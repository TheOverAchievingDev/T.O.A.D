import { EventEmitter } from 'node:events';

/**
 * RuntimeEventBus — lightweight pub/sub for streaming runtime events.
 *
 * Provides:
 * - Channel-based event routing (e.g. 'runtime_event', 'tool_use', 'api_retry')
 * - subscribe() with auto-unsubscribe return value
 * - dispose() for clean shutdown
 *
 * Any transport layer (WebSocket, SSE, IPC) can subscribe to the bus
 * and relay events to clients.
 */
export class RuntimeEventBus {
  #emitter;

  constructor() {
    this.#emitter = new EventEmitter();
    // Increase default max listeners for high-traffic channels
    this.#emitter.setMaxListeners(50);
  }

  /**
   * Subscribe to a channel.
   * @param {string} channel - Event channel name
   * @param {Function} handler - Event handler
   */
  on(channel, handler) {
    this.#emitter.on(channel, handler);
  }

  /**
   * Unsubscribe from a channel.
   * @param {string} channel - Event channel name
   * @param {Function} handler - Event handler
   */
  off(channel, handler) {
    this.#emitter.off(channel, handler);
  }

  /**
   * Emit an event on a channel.
   * @param {string} channel - Event channel name
   * @param {object} event - Event payload
   */
  emit(channel, event) {
    this.#emitter.emit(channel, event);
  }

  /**
   * Subscribe and return an unsubscribe function.
   * @param {string} channel - Event channel name
   * @param {Function} handler - Event handler
   * @returns {Function} unsubscribe function
   */
  subscribe(channel, handler) {
    this.#emitter.on(channel, handler);
    return () => this.#emitter.off(channel, handler);
  }

  /**
   * Get the number of listeners for a channel.
   * @param {string} channel - Event channel name
   * @returns {number}
   */
  listenerCount(channel) {
    return this.#emitter.listenerCount(channel);
  }

  /**
   * Remove all listeners on all channels. Use during shutdown.
   */
  dispose() {
    this.#emitter.removeAllListeners();
  }
}
