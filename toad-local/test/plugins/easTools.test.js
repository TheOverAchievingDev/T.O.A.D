import test from 'node:test';
import assert from 'node:assert/strict';
import { SqlitePluginJobs } from '../../src/plugins/pluginJobs.js';
import { easProjectInfo, easBuild, easUpdate } from '../../src/plugins/eas/easTools.js';

test('easProjectInfo parses CLI output', async () => {
  const mockRunner = async () => ({
    exitCode: 0,
    stdout: JSON.stringify({ projectId: 'eas-123', fullName: 'test/project' }),
    stderr: '',
  });
  const result = await easProjectInfo({ runEasCli: mockRunner });
  assert.equal(result.projectId, 'eas-123');
});

test('easBuild triggers background job', async () => {
  const pluginJobs = new SqlitePluginJobs({ filePath: ':memory:' });
  pluginJobs.db.prepare("INSERT INTO teams (team_id, created_at) VALUES ('team-1', ?)").run(new Date().toISOString());
  let logCalled = false;
  const mockRunner = async ({ onLog }) => {
    onLog('Building...');
    logCalled = true;
    return { exitCode: 0, stdout: 'done', stderr: '' };
  };

  const job = await easBuild({
    teamId: 'team-1',
    platform: 'android',
    pluginJobs,
    runEasCli: mockRunner,
  });

  assert.equal(job.pluginId, 'eas');
  assert.equal(job.action, 'build');
  assert.equal(job.args.platform, 'android');

  // Wait for background execution to catch up (it's async)
  await new Promise(r => setTimeout(r, 50));

  const updated = pluginJobs.get({ jobId: job.jobId });
  assert.equal(updated.state, 'finished');
  assert.ok(updated.logTail.includes('Building...'));
  assert.ok(logCalled);
});

test('easUpdate triggers background job', async () => {
  const pluginJobs = new SqlitePluginJobs({ filePath: ':memory:' });
  pluginJobs.db.prepare("INSERT INTO teams (team_id, created_at) VALUES ('team-1', ?)").run(new Date().toISOString());
  const mockRunner = async () => {
    return { exitCode: 0, stdout: 'updated', stderr: '' };
  };

  const job = await easUpdate({
    teamId: 'team-1',
    branch: 'main',
    message: 'test update',
    pluginJobs,
    runEasCli: mockRunner,
  });

  assert.equal(job.action, 'update');
  assert.equal(job.args.branch, 'main');

  await new Promise(r => setTimeout(r, 50));
  const updated = pluginJobs.get({ jobId: job.jobId });
  assert.equal(updated.state, 'finished');
});
