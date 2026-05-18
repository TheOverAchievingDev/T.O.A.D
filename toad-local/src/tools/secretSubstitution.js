/**
 * ⚠️ SCAFFOLDING — NOT WIRED IN (bundle review C / BR7). As of 2026-05-18
 * nothing in production imports this module: no caller `register()`s a
 * secret and no caller `substitute()`s before subprocess/env injection,
 * and `globalSecretRegistry` is never populated. The "the agent never sees
 * plaintext" guarantee below is therefore NOT in effect yet. Integration
 * (wiring substitute() into the plugin tool-result/env path and
 * redactForAudit() into the audit writer) is its OWN tracked slice. Until
 * then this is hardened scaffolding, not an active security control. The
 * live secret defense today is Slice 1 `secretRedactor.redactSecrets`
 * (audit-log regex scrub), which IS wired (railwayTools.js).
 *
 * Secret Redactor — Slice 2: Agent-Side Substitution Pipeline.
 *
 * Slice 1 (secretRedactor.js) strips secrets from the AUDIT LOG and UI
 * event view. Slice 2 goes further: even the *agent itself* never sees
 * plaintext secrets. Instead it receives an opaque reference token
 * (e.g. `{{DB_url_a1b2c3}}`) in the value it works with, and this
 * module resolves those tokens to real values at the moment they're
 * consumed (plugin tool call results, env-var injection).
 *
 * Design:
 *   - `SecretRegistry` is an in-process, per-runtime store. It NEVER
 *     persists to SQLite — losing the mapping on sidecar restart is
 *     intentional: the agent must re-acquire secrets through the plugin
 *     flow, not from a stale transcript.
 *   - Tokens use the form `{{NS_label_hex8}}` — namespace prefix + human
 *     hint + collision-resistant 8-char hex suffix. Compact enough that
 *     agents can reference them in prompts without token waste.
 *   - `substitute(text)` replaces ALL tokens in a string in one pass
 *     (avoids repeated indexOf scanning).
 *   - `redactForAudit(text)` is the inverse: replaces known plaintext
 *     values with their token (for use when writing raw output to the
 *     audit log, complementing Slice 1 regex scrubbing).
 */
import { randomBytes } from 'node:crypto';

const TOKEN_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;

export class SecretRegistry {
  // token → plaintext. Never serialised.
  #store = new Map();
  // plaintext → token (reverse index for redactForAudit).
  #reverse = new Map();

  /**
   * Register a plaintext secret and get back an opaque token. Idempotent:
   * registering the same plaintext twice returns the same token.
   *
   * @param {string} namespace  Short label baked into the token for
   *   readability (e.g. 'DB_url', 'RAILWAY_token'). Max 24 chars.
   * @param {string} plaintext  The real secret value.
   * @returns {string} The opaque token (e.g. `{{DB_url_a1b2c3d4}}`).
   */
  register(namespace, plaintext) {
    if (typeof plaintext !== 'string' || plaintext.length === 0) {
      throw new TypeError('SecretRegistry.register: plaintext must be a non-empty string');
    }
    // Idempotent — same plaintext always maps to the same token.
    if (this.#reverse.has(plaintext)) {
      return this.#reverse.get(plaintext);
    }
    const ns = String(namespace || 'SEC').slice(0, 24).replace(/[^A-Za-z0-9_]/g, '_');
    const suffix = randomBytes(4).toString('hex');
    const token = `{{${ns}_${suffix}}}`;
    this.#store.set(token, plaintext);
    this.#reverse.set(plaintext, token);
    return token;
  }

  /**
   * Resolve an opaque token back to its plaintext value.
   * Returns null when the token is unknown (expired, wrong registry).
   *
   * @param {string} token  e.g. `{{DB_url_a1b2c3d4}}`
   * @returns {string|null}
   */
  resolve(token) {
    return this.#store.get(token) ?? null;
  }

  /**
   * Replace ALL `{{token}}` occurrences in a string with their plaintext
   * values. Fails CLOSED by default: an unknown/expired token (after
   * clear() or a sidecar restart) is replaced with '' so a stale reference
   * can never be injected verbatim into a subprocess/env as a literal
   * `{{NS_...}}` fragment. Each miss is reported via `onMissing(token)` so
   * the caller can decide to abort. `failOpen:true` opts back into the old
   * leave-as-is behaviour (the exception, not the default).
   *
   * Use this at the point where a plugin result reaches the runtime
   * executor (e.g. just before injecting an env-var into a subprocess).
   *
   * @param {string} text
   * @param {{ failOpen?: boolean, onMissing?: (token:string)=>void }} [opts]
   * @returns {string}
   */
  substitute(text, { failOpen = false, onMissing } = {}) {
    if (typeof text !== 'string') return text;
    return text.replace(TOKEN_RE, (match, key) => {
      const token = `{{${key}}}`;
      const value = this.#store.get(token);
      if (value !== undefined) return value;
      if (typeof onMissing === 'function') onMissing(token);
      return failOpen ? match : '';
    });
  }

  /**
   * Replace known plaintext values with their tokens. Use this when
   * writing plugin output to the audit log, complementing the regex
   * scrubbing in secretRedactor.js (Slice 1). Processes all registered
   * secrets; skips secrets shorter than 8 chars (too short to scrub
   * safely without false positives).
   *
   * @param {string} text
   * @returns {string}
   */
  redactForAudit(text, { onShortSkip } = {}) {
    if (typeof text !== 'string') return text;
    let result = text;
    // Length-descending so a secret that is a SUBSTRING of another is
    // redacted only after the longer one — otherwise the short replace
    // corrupts the long secret's occurrences and leaks a plaintext tail.
    const entries = [...this.#reverse.entries()].sort((a, b) => b[0].length - a[0].length);
    let shortSkipped = 0;
    for (const [plaintext, token] of entries) {
      if (plaintext.length < 8) { shortSkipped += 1; continue; } // too short to scrub safely
      result = result.replaceAll(plaintext, token);
    }
    if (shortSkipped > 0 && typeof onShortSkip === 'function') onShortSkip(shortSkipped);
    return result;
  }

  /**
   * Clear all registered secrets. Call on sidecar shutdown or team
   * teardown — prevents token reuse across session boundaries.
   */
  clear() {
    this.#store.clear();
    this.#reverse.clear();
  }

  /** Number of registered secrets. Useful for tests and diagnostics. */
  get size() {
    return this.#store.size;
  }
}

/**
 * Module-level singleton intended for production use once integrated.
 * ⚠️ Currently NO production code registers/substitutes via this singleton
 * (see the not-wired notice at the top of this file) — it exists for the
 * future integration slice. Tests construct their own `SecretRegistry`.
 */
export const globalSecretRegistry = new SecretRegistry();
