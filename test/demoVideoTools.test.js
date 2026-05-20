import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('demo video scenario loader validates the family meal planner scenario', async () => {
  const { loadScenario } = await import('../scripts/demoVideoTools.mjs');
  const scenario = await loadScenario(path.join(repoRoot, 'demo', 'scenarios', 'family-meal-planner.json'));

  assert.equal(scenario.project.name, 'Family Meal Planner');
  assert.equal(scenario.team.teamId, 'family-meal-planner');
  assert.equal(scenario.team.members.length, 4);
  assert.deepEqual(
    scenario.team.members.map((member) => member.providerId),
    ['anthropic', 'openai', 'gemini', 'anthropic'],
  );
  assert.ok(scenario.foundry.artifacts.some((artifact) => artifact.targetPath === 'docs/foundry/product-brief.md'));
  assert.ok(scenario.tasks.some((task) => task.status === 'review'));
});

test('demo fake runtime command uses node and points at the runtime script', async () => {
  const { buildFakeRuntimeLaunch } = await import('../scripts/demoVideoTools.mjs');
  const scenarioPath = path.join(repoRoot, 'demo', 'scenarios', 'family-meal-planner.json');
  const launch = buildFakeRuntimeLaunch({
    repoRoot,
    scenarioPath,
    workspacePath: 'C:\\SymphonyDemo\\family-meal-planner',
    teamId: 'family-meal-planner',
    member: {
      agentId: 'developer',
      role: 'developer',
      providerId: 'openai',
      model: 'gpt-5-codex',
    },
  });

  assert.equal(launch.command, process.execPath);
  assert.equal(launch.teamId, 'family-meal-planner');
  assert.equal(launch.agentId, 'developer');
  assert.equal(launch.providerId, 'openai');
  assert.equal(launch.runtimeId, 'runtime-family-meal-planner-developer');
  assert.equal(launch.cwd, 'C:\\SymphonyDemo\\family-meal-planner');
  assert.ok(launch.args.includes(path.join(repoRoot, 'scripts', 'demo-agent-runtime.mjs')));
  assert.ok(launch.args.includes('--agent'));
  assert.ok(launch.args.includes('developer'));
});

test('demo runtime frames produce Claude stream-json events with model and tool use', async () => {
  const { buildStreamJsonFrames } = await import('../scripts/demoVideoTools.mjs');
  const frames = buildStreamJsonFrames({
    agentId: 'tester',
    model: 'gemini-2.5-pro',
    events: [
      { type: 'text', text: 'I am checking the acceptance criteria.' },
      { type: 'tool', name: 'mcp__toad-local__validation_run', input: { taskId: 'TASK-003', kind: 'test' } },
    ],
  });

  assert.equal(frames.length, 3);
  const assistant = JSON.parse(frames[0]);
  const tool = JSON.parse(frames[1]);
  const result = JSON.parse(frames[2]);
  assert.equal(assistant.type, 'assistant');
  assert.equal(assistant.message.model, 'gemini-2.5-pro');
  assert.equal(assistant.message.content[0].text, 'I am checking the acceptance criteria.');
  assert.equal(tool.message.content[0].name, 'mcp__toad-local__validation_run');
  assert.equal(result.type, 'result');
  assert.equal(result.subtype, 'success');
});

test('demo workspace safety refuses to reset arbitrary folders', async () => {
  const { assertSafeDemoWorkspace } = await import('../scripts/demoVideoTools.mjs');

  assert.doesNotThrow(() => assertSafeDemoWorkspace('C:\\SymphonyDemo\\family-meal-planner'));
  assert.throws(
    () => assertSafeDemoWorkspace('C:\\Project-TOAD\\toad-local'),
    /Refusing to reset non-demo workspace/,
  );
});

test('demo Tauri launch env keeps Foundry storage inside the demo workspace', async () => {
  const { buildTauriLaunchEnv } = await import('../scripts/demoVideoTools.mjs');
  const env = buildTauriLaunchEnv({
    baseEnv: { PATH: 'example-path' },
    workspacePath: 'C:\\SymphonyDemo\\family-meal-planner',
  });

  assert.equal(env.PATH, 'example-path');
  assert.equal(env.TOAD_API_TOKEN, '');
  assert.equal(env.VITE_TOAD_API_TOKEN, '');
  assert.equal(
    env.SYMPHONY_FOUNDRY_DB_PATH,
    'C:\\SymphonyDemo\\family-meal-planner\\.demo\\foundry.db',
  );
  assert.match(env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, /remote-debugging-port=9223/);
});

test('demo ffmpeg args pad odd window dimensions for H264 output', async () => {
  const { buildFfmpegRecorderArgs } = await import('../scripts/demoVideoTools.mjs');
  const args = buildFfmpegRecorderArgs({
    outputPath: 'C:\\Project-TOAD\\toad-local\\demo\\out\\family-meal-planner.mp4',
    windowTitle: 'Symphony AI',
  });

  assert.ok(args.includes('title=Symphony AI'));
  assert.ok(args.includes('-vf'));
  assert.ok(args.includes('pad=ceil(iw/2)*2:ceil(ih/2)*2'));
  assert.equal(args.at(-1), 'C:\\Project-TOAD\\toad-local\\demo\\out\\family-meal-planner.mp4');
});
