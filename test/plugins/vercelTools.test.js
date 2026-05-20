import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlitePluginJobs } from '../../src/plugins/pluginJobs.js';
import { vercelLink, vercelEnvPull, vercelDeploy, vercelList } from '../../src/plugins/vercel/vercelTools.js';

test('vercelLink triggers CLI', async () => {
  let called = false;
  const mockRunner = async ({ args }) => {
    called = true;
    assert.deepEqual(args, ['link', '--yes']);
    return { exitCode: 0, stdout: 'linked', stderr: '' };
  };
  await vercelLink({ runVercelCli: mockRunner });
  assert.ok(called);
});

test('vercelEnvPull triggers CLI', async () => {
  let called = false;
  const mockRunner = async ({ args }) => {
    called = true;
    assert.deepEqual(args, ['env', 'pull', '.env.local', '--yes']);
    return { exitCode: 0, stdout: 'pulled', stderr: '' };
  };
  await vercelEnvPull({ runVercelCli: mockRunner });
  assert.ok(called);
});

test('vercelDeploy triggers background job', async () => {
  const pluginJobs = new SqlitePluginJobs({ filePath: ':memory:' });
  pluginJobs.db.prepare("INSERT INTO teams (team_id, created_at) VALUES ('team-1', ?)").run(new Date().toISOString());
  
  let logCalled = false;
  const mockRunner = async ({ args, onLog }) => {
    assert.ok(args.includes('deploy'));
    assert.ok(args.includes('--prod'));
    onLog('Deploying...');
    logCalled = true;
    return { exitCode: 0, stdout: 'done', stderr: '' };
  };

  const job = await vercelDeploy({
    teamId: 'team-1',
    prod: true,
    pluginJobs,
    runVercelCli: mockRunner,
  });

  assert.equal(job.pluginId, 'vercel');
  assert.equal(job.action, 'deploy');

  await new Promise(r => setTimeout(r, 50));
  const updated = pluginJobs.get({ jobId: job.jobId });
  assert.equal(updated.state, 'finished');
  assert.ok(updated.logTail.includes('Deploying...'));
});

test('vercelList parses JSON output', async () => {
  const mockRunner = async () => ({
    exitCode: 0,
    stdout: JSON.stringify([{ id: 'dep_1', url: 'test.vercel.app' }]),
    stderr: '',
  });
  const result = await vercelList({ runVercelCli: mockRunner });
  assert.equal(result[0].id, 'dep_1');
});
