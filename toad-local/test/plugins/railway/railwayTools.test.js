import test from 'node:test';
import assert from 'node:assert/strict';
import { railwayLink } from '../../../src/plugins/railway/railwayTools.js';
import { railwayProvisionDb } from '../../../src/plugins/railway/railwayTools.js';

test('railwayLink: passes projectId to the CLI when supplied', async () => {
  const calls = [];
  const fakeRunner = async ({ args }) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  };
  const result = await railwayLink({
    teamId: 'team-a',
    projectId: 'proj_abc',
    runRailwayCli: fakeRunner,
  });
  assert.equal(result.linked, true);
  assert.equal(result.projectId, 'proj_abc');
  assert.deepEqual(calls[0], ['link', '--project-id', 'proj_abc', '--yes']);
});

test('railwayLink: creates new project when no projectId supplied', async () => {
  const fakeRunner = async ({ args }) => ({
    stdout: 'Linked to project proj_NEW\n', stderr: '', exitCode: 0,
  });
  const result = await railwayLink({ teamId: 'team-a', runRailwayCli: fakeRunner });
  assert.equal(result.linked, true);
  // We don't try to parse the project id from stdout — that's fragile.
  // We just confirm the link succeeded.
});

test('railwayLink: surfaces CLI error', async () => {
  const fakeRunner = async () => ({ stdout: '', stderr: 'auth required', exitCode: 1 });
  await assert.rejects(
    () => railwayLink({ teamId: 'team-a', runRailwayCli: fakeRunner }),
    /auth required|exit 1/,
  );
});

function fakeResources({ existingPostgres = null } = {}) {
  const inserts = [];
  return {
    inserts,
    findLive: ({ teamId, pluginId, kind }) => {
      if (existingPostgres && teamId === 'team-a' && pluginId === 'railway' && kind === 'postgres') {
        return existingPostgres;
      }
      return null;
    },
    insert: (input) => {
      const created = { resourceId: 'res_new', ...input, createdAt: '2026-05-04T00:00:00Z' };
      inserts.push(created);
      return created;
    },
  };
}

test('railwayProvisionDb: idempotent — returns existing with wasExisting=true', async () => {
  const existing = {
    resourceId: 'res_existing', teamId: 'team-a',
    pluginId: 'railway', kind: 'postgres',
    externalId: 'svc_existing', metadata: {},
  };
  const calls = [];
  const fakeRunner = async ({ args }) => { calls.push(args); return { stdout: '', stderr: '', exitCode: 0 }; };
  const result = await railwayProvisionDb({
    teamId: 'team-a', type: 'postgres',
    runRailwayCli: fakeRunner,
    pluginResources: fakeResources({ existingPostgres: existing }),
  });
  assert.equal(result.wasExisting, true);
  assert.equal(result.resourceId, 'res_existing');
  assert.equal(calls.length, 0, 'CLI should NOT be called when resource already exists');
});

test('railwayProvisionDb: creates new postgres + records resource', async () => {
  const fakeRunner = async () => ({
    stdout: JSON.stringify({ id: 'svc_brandnew', name: 'postgres', type: 'postgresql' }),
    stderr: '', exitCode: 0,
  });
  const resources = fakeResources();
  const result = await railwayProvisionDb({
    teamId: 'team-a', type: 'postgres',
    runRailwayCli: fakeRunner,
    pluginResources: resources,
  });
  assert.equal(result.wasExisting, false);
  assert.equal(result.externalId, 'svc_brandnew');
  assert.equal(result.kind, 'postgres');
  assert.equal(resources.inserts.length, 1);
});

test('railwayProvisionDb: rejects unsupported types in slice 1', async () => {
  await assert.rejects(
    () => railwayProvisionDb({
      teamId: 'team-a', type: 'redis',
      runRailwayCli: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      pluginResources: fakeResources(),
    }),
    /postgres|slice 1/i,
  );
});

test('railwayProvisionDb: surfaces CLI failure', async () => {
  const fakeRunner = async () => ({ stdout: '', stderr: 'permission denied', exitCode: 2 });
  await assert.rejects(
    () => railwayProvisionDb({
      teamId: 'team-a', type: 'postgres',
      runRailwayCli: fakeRunner,
      pluginResources: fakeResources(),
    }),
    /permission denied|exit 2/,
  );
});

import { railwayGetConnectionString } from '../../../src/plugins/railway/railwayTools.js';

test('railwayGetConnectionString: returns plaintext URL', async () => {
  const fakeRunner = async () => ({
    stdout: 'postgres://user:pw@host:5432/db\n',
    stderr: '', exitCode: 0,
  });
  const result = await railwayGetConnectionString({
    teamId: 'team-a',
    resourceId: 'res_x',
    varName: 'DATABASE_URL',
    runRailwayCli: fakeRunner,
  });
  assert.equal(result.value, 'postgres://user:pw@host:5432/db');
  // We DO surface plaintext per spec gotcha #2 path-a; redaction is
  // only for the audit log + UI raw-event surface.
  assert.doesNotMatch(result.value, /<REDACTED>/);
});

test('railwayGetConnectionString: defaults varName to DATABASE_URL', async () => {
  const calls = [];
  const fakeRunner = async ({ args }) => { calls.push(args); return { stdout: 'x', stderr: '', exitCode: 0 }; };
  await railwayGetConnectionString({
    teamId: 'team-a', resourceId: 'res_x',
    runRailwayCli: fakeRunner,
  });
  assert.ok(calls[0].includes('DATABASE_URL'));
});

test('railwayGetConnectionString: surfaces CLI failure', async () => {
  const fakeRunner = async () => ({ stdout: '', stderr: 'no service', exitCode: 1 });
  await assert.rejects(
    () => railwayGetConnectionString({
      teamId: 'team-a', resourceId: 'res_x',
      runRailwayCli: fakeRunner,
    }),
    /no service|exit 1/,
  );
});
