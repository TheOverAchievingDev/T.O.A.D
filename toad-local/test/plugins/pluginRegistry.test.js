import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SUPPORTED_PLUGINS,
  PLUGIN_COMMANDS,
  parseRailwayFileStatus,
} from '../../src/plugins/pluginRegistry.js';

test('SUPPORTED_PLUGINS contains railway, eas, vercel', () => {
  assert.ok(SUPPORTED_PLUGINS.includes('railway'));
  assert.ok(SUPPORTED_PLUGINS.includes('eas'));
  assert.ok(SUPPORTED_PLUGINS.includes('vercel'));
});

test('PLUGIN_COMMANDS.railway is supported with the right shape', () => {
  const r = PLUGIN_COMMANDS.railway;
  assert.equal(r.label, 'Railway');
  assert.equal(r.cli, 'railway');
  assert.equal(r.statusMode, 'file');
  assert.equal(r.manualLogin, true);
  assert.equal(r.supported, true);
  assert.ok(r.riskProfile);
  assert.equal(r.riskProfile.run_migration, 'high');
  assert.equal(r.riskProfile.provision_db, 'medium');
});

test('PLUGIN_COMMANDS.eas + .vercel are recognized but unsupported in slice 1', () => {
  assert.equal(PLUGIN_COMMANDS.eas.supported, false);
  assert.equal(PLUGIN_COMMANDS.vercel.supported, false);
});

test('parseRailwayFileStatus: token present → signedIn:true', () => {
  const result = parseRailwayFileStatus(
    { token: 'abc123', user: { email: 'foo@example.com' } },
    null,
    'railway',
  );
  assert.equal(result.signedIn, true);
  assert.equal(result.user.email, 'foo@example.com');
});

test('parseRailwayFileStatus: empty/missing token → signedIn:false', () => {
  const noToken = parseRailwayFileStatus({ user: { email: 'x' } }, null, 'railway');
  assert.equal(noToken.signedIn, false);
  const empty = parseRailwayFileStatus({}, null, 'railway');
  assert.equal(empty.signedIn, false);
});

test('parseRailwayFileStatus: malformed JSON → signedIn:false with reason', () => {
  const result = parseRailwayFileStatus(null, null, 'railway');
  assert.equal(result.signedIn, false);
  assert.match(result.reason, /not an object|empty/i);
});
