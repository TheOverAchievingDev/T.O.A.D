/**
 * BR7 — C (bundle whole-impl review) hardening of secretSubstitution.js.
 * The module ships as un-integrated scaffolding (zero importers); these
 * tests lock the security-correctness properties so that IF/WHEN it is
 * wired in (its own slice) it is safe:
 *   - substitute() fails CLOSED by default (unknown token → '' + signal),
 *     opt-in fail-open only.
 *   - redactForAudit() is substring-safe (a secret that is a substring of
 *     another is not left partially un-redacted).
 *   - short-secret (<8) skips are signalled, not silent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretRegistry } from '../../src/tools/secretSubstitution.js';

test('substitute() fails CLOSED by default: unknown token → empty, miss signalled', () => {
  const r = new SecretRegistry();
  const tok = r.register('DB', 'super-secret-value');
  const misses = [];
  const out = r.substitute(`use ${tok} and {{GHOST_deadbeef}} now`, { onMissing: (t) => misses.push(t) });
  assert.equal(out, 'use super-secret-value and  now', 'unknown token must be blanked, not passed through literally');
  assert.deepEqual(misses, ['{{GHOST_deadbeef}}'], 'the missing token must be signalled to the caller');
});

test('substitute() opt-in failOpen preserves an unknown token verbatim', () => {
  const r = new SecretRegistry();
  const out = r.substitute('keep {{GHOST_deadbeef}}', { failOpen: true });
  assert.equal(out, 'keep {{GHOST_deadbeef}}');
});

test('redactForAudit() is substring-safe (longer secret containing a shorter one fully redacted)', () => {
  const r = new SecretRegistry();
  const tShort = r.register('A', 'abcdefgh');            // 8 chars
  const tLong = r.register('B', 'abcdefgh-PLUS-MORE-TAIL'); // contains the short one as a prefix
  const out = r.redactForAudit('value=abcdefgh-PLUS-MORE-TAIL end');
  // The long secret's plaintext must NOT survive in any partial form.
  assert.ok(!out.includes('abcdefgh-PLUS-MORE-TAIL'), 'long secret must be fully redacted');
  assert.ok(!out.includes('PLUS-MORE-TAIL'), 'no plaintext fragment of the long secret may remain');
  assert.ok(out.includes(tLong), 'the long secret should be replaced by its token');
  assert.ok(tShort.length > 0);
});

test('redactForAudit() signals how many short (<8) secrets were skipped', () => {
  const r = new SecretRegistry();
  r.register('S', 'short');                 // 5 chars → skipped
  r.register('L', 'long-enough-secret');    // redacted
  let skipped = -1;
  const out = r.redactForAudit('short and long-enough-secret', { onShortSkip: (n) => { skipped = n; } });
  assert.equal(skipped, 1, 'the one short secret skip must be signalled');
  assert.ok(out.includes('short'), 'short secret is intentionally left (documented gap) but now observable');
  assert.ok(!out.includes('long-enough-secret'), 'long secret still redacted');
});
