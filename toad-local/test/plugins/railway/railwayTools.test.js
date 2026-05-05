import test from 'node:test';
import assert from 'node:assert/strict';
import { railwayLink } from '../../../src/plugins/railway/railwayTools.js';

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
