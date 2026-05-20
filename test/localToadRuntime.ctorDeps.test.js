/**
 * Regression: `new LocalToadRuntime()` WITHOUT an injected toolFacade must not
 * throw `ReferenceError: providerAuthReadFile is not defined`.
 *
 * dev-api-server.mjs constructs LocalToadRuntime with no toolFacade, so the
 * default `new LocalToolFacade({ ... providerAuthReadFile, providerAuthStat ... })`
 * path executes. Those identifiers must be declared as constructor options
 * (they were passed through but never destructured → crashed the real app
 * while the test suite missed it because every test injects a toolFacade).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalToadRuntime } from '../src/app/LocalToadRuntime.js';

test('new LocalToadRuntime() without an injected toolFacade does not throw (provider-auth deps threaded through ctor)', () => {
  let rt;
  assert.doesNotThrow(() => {
    rt = new LocalToadRuntime();
  });
  if (rt && typeof rt.close === 'function') {
    try { rt.close(); } catch { /* best effort cleanup */ }
  }
});
