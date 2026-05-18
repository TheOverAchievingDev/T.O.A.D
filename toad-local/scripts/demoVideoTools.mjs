import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const VALID_TASK_STATUSES = new Set([
  'pending',
  'ready',
  'planned',
  'in_progress',
  'review',
  'testing',
  'merge_ready',
  'done',
  'blocked',
]);

const BASE_SCREEN_TWEAKS = Object.freeze({
  theme: 'dark',
  density: 'comfy',
  layout: 'org',
  cardVariant: 'detail',
  agentInbox: '',
  showProviders: false,
  showNotifs: false,
  showApprovals: false,
  showRuntimes: false,
  showDiagnostics: false,
  showTweaks: false,
  showSidebar: true,
  showBottomPanel: true,
  showRightPanel: false,
  bottomPanelTab: 'terminal',
  rightPanelAgent: null,
  tasksGroupBy: 'status',
  tasksFilter: 'all',
  developerMode: false,
  firstRunComplete: true,
});

export async function loadScenario(filePath) {
  const scenarioPath = path.resolve(filePath);
  const raw = await readFile(scenarioPath, 'utf8');
  const scenario = JSON.parse(raw);
  validateScenario(scenario, scenarioPath);
  return scenario;
}

export function buildFakeRuntimeLaunch({
  repoRoot,
  scenarioPath,
  workspacePath,
  teamId,
  member,
}) {
  requireObject(member, 'member');
  const agentId = requireString(member.agentId, 'member.agentId');
  return {
    teamId: requireString(teamId, 'teamId'),
    agentId,
    runtimeId: `runtime-${teamId}-${agentId}`,
    command: process.execPath,
    args: [
      path.join(path.resolve(repoRoot), 'scripts', 'demo-agent-runtime.mjs'),
      '--scenario',
      path.resolve(scenarioPath),
      '--agent',
      agentId,
    ],
    cwd: workspacePath,
    providerId: requireString(member.providerId, 'member.providerId'),
    role: member.role || 'developer',
    env: {
      SYMPHONY_DEMO_AGENT_ID: agentId,
      SYMPHONY_DEMO_PROVIDER_ID: member.providerId,
      SYMPHONY_DEMO_MODEL: member.model || '',
    },
  };
}

export function buildStreamJsonFrames({ agentId, model, events = [] }) {
  const frames = [];
  const sessionId = `demo-${agentId}-${Date.now()}`;
  let toolIndex = 0;

  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    if (event.type === 'text') {
      frames.push(JSON.stringify({
        type: 'assistant',
        session_id: sessionId,
        message: {
          role: 'assistant',
          model,
          content: [{ type: 'text', text: requireString(event.text, 'event.text') }],
        },
      }));
      continue;
    }
    if (event.type === 'tool') {
      toolIndex += 1;
      frames.push(JSON.stringify({
        type: 'assistant',
        session_id: sessionId,
        message: {
          role: 'assistant',
          model,
          content: [{
            type: 'tool_use',
            id: `demo_tool_${agentId}_${toolIndex}`,
            name: requireString(event.name, 'event.name'),
            input: event.input && typeof event.input === 'object' && !Array.isArray(event.input)
              ? event.input
              : {},
          }],
        },
      }));
    }
  }

  frames.push(JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: sessionId,
    model,
    usage: {
      input_tokens: 2180,
      output_tokens: 640,
    },
    total_cost_usd: 0.012,
  }));

  return frames;
}

export function buildDemoScreenshotManifest() {
  const settingsSections = [
    ['settings-general', 'Settings - General', 'General'],
    ['settings-providers', 'Settings - Providers', 'Providers'],
    ['settings-foundry', 'Settings - Foundry', 'Foundry'],
    ['settings-drift', 'Settings - Drift', 'Drift'],
    ['settings-plugins', 'Settings - Plugins', 'Plugins'],
    ['settings-github', 'Settings - GitHub', 'GitHub'],
    ['settings-workspace', 'Settings - Workspace', 'Workspace'],
    ['settings-risk', 'Settings - Risk policies', 'Risk policies'],
    ['settings-mcp', 'Settings - MCP servers', 'MCP servers'],
    ['settings-notifications', 'Settings - Notifications', 'Notifications'],
    ['settings-advanced', 'Settings - Advanced', 'Advanced'],
    ['settings-about', 'Settings - About', 'About'],
  ].map(([id, title, label]) => ({
    id,
    title,
    group: 'settings',
    screen: 'settings',
    waitFor: 'main.settings-screen',
    actions: label === 'General'
      ? []
      : [{ type: 'clickSelector', selector: `nav[aria-label="Settings sections"] button:has-text("${label}")` }],
  }));

  return [
    {
      id: 'cockpit-for-me',
      title: 'Cockpit - FOR me overview',
      group: 'cockpit',
      screen: 'cockpit',
      tweaks: { developerMode: false },
      waitFor: 'text=Your team is working',
    },
    {
      id: 'cockpit-with-me',
      title: 'Cockpit - WITH me IDE mode',
      group: 'cockpit',
      screen: 'cockpit',
      tweaks: {
        developerMode: true,
        showBottomPanel: true,
        showRightPanel: true,
        bottomPanelTab: 'terminal',
      },
      waitFor: '.cockpit-with-me, text=Terminal',
    },
    {
      id: 'cockpit-bottom-validations',
      title: 'Cockpit - validation bottom panel',
      group: 'cockpit',
      screen: 'cockpit',
      tweaks: { developerMode: true, showBottomPanel: true, bottomPanelTab: 'validations' },
      waitFor: 'text=Validations',
    },
    {
      id: 'foundry-discovery',
      title: 'Foundry - discovery chat and docs',
      group: 'foundry',
      screen: 'foundry',
      waitFor: '.foundry-screen',
    },
    {
      id: 'foundry-roadmap-artifact',
      title: 'Foundry - roadmap artifact selected',
      group: 'foundry',
      screen: 'foundry',
      waitFor: '.foundry-screen',
      actions: [{ type: 'clickText', text: 'Roadmap', optional: true }],
    },
    {
      id: 'code-explorer',
      title: 'Code - project explorer',
      group: 'code',
      screen: 'code',
      waitFor: '.code-screen',
    },
    {
      id: 'code-search',
      title: 'Code - search pane',
      group: 'code',
      screen: 'code',
      waitFor: '.code-screen',
      actions: [{ type: 'clickSelector', selector: '.code-pane-tabs button:has-text("Search")' }],
    },
    {
      id: 'tasks-board',
      title: 'Tasks - status board',
      group: 'tasks',
      screen: 'tasks',
      waitFor: 'text=Tasks',
    },
    {
      id: 'tasks-by-assignee',
      title: 'Tasks - grouped by assignee',
      group: 'tasks',
      screen: 'tasks',
      tweaks: { tasksGroupBy: 'assignee' },
      waitFor: 'text=Tasks',
    },
    {
      id: 'drift-monitor',
      title: 'Drift monitor',
      group: 'watch',
      screen: 'drift',
      waitFor: 'text=Drift',
    },
    {
      id: 'costs',
      title: 'Costs and usage',
      group: 'watch',
      screen: 'costs',
      waitFor: 'text=Costs',
    },
    {
      id: 'audit',
      title: 'Audit log',
      group: 'inspect',
      screen: 'audit',
      waitFor: 'text=Audit',
    },
    {
      id: 'project-picker',
      title: 'Project picker',
      group: 'project',
      screen: 'picker',
      waitFor: '.picker, text=Where shall we work today?',
    },
    {
      id: 'create-team',
      title: 'Create team from Foundry plan',
      group: 'workflow',
      screen: 'foundry',
      actions: [{ type: 'clickSelector', selector: '.foundry-artifacts button:has-text("Create team")' }],
      waitFor: '.modal, text=Create team',
    },
    {
      id: 'create-task',
      title: 'Create task modal',
      group: 'workflow',
      screen: 'cockpit',
      waitFor: 'text=Your team is working',
      actions: [{ type: 'clickText', text: 'Add task' }],
      waitForAfterActions: '.modal, text=Create task',
    },
    {
      id: 'task-detail',
      title: 'Task detail and review',
      group: 'workflow',
      screen: 'cockpit',
      waitFor: 'text=Your team is working',
      actions: [{ type: 'clickText', text: 'Open full task' }],
      waitForAfterActions: '.modal, text=Task',
    },
    {
      id: 'drawer-runtimes',
      title: 'Runtimes drawer',
      group: 'drawers',
      screen: 'cockpit',
      tweaks: { showRuntimes: true },
      waitFor: 'text=Runtimes',
    },
    {
      id: 'drawer-notifications',
      title: 'Notifications drawer',
      group: 'drawers',
      screen: 'cockpit',
      tweaks: { showNotifs: true },
      waitFor: 'text=Notifications',
    },
    {
      id: 'drawer-approvals',
      title: 'Approvals drawer',
      group: 'drawers',
      screen: 'cockpit',
      tweaks: { showApprovals: true },
      waitFor: 'text=Approvals',
    },
    {
      id: 'drawer-diagnostics',
      title: 'Diagnostics drawer',
      group: 'drawers',
      screen: 'cockpit',
      tweaks: { showDiagnostics: true },
      waitFor: 'text=Diagnostics',
    },
    {
      id: 'providers-modal',
      title: 'Providers modal',
      group: 'drawers',
      screen: 'cockpit',
      tweaks: { showProviders: true },
      waitFor: 'text=Providers',
    },
    {
      id: 'command-palette',
      title: 'Command palette',
      group: 'workflow',
      screen: 'cockpit',
      waitFor: 'text=Your team is working',
      actions: [{ type: 'keyboard', key: 'Control+K' }],
      waitForAfterActions: '[role="dialog"], .cmdk-backdrop, text=Command',
    },
    ...settingsSections,
  ].map((capture) => ({
    description: capture.title,
    ...capture,
    tweaks: { ...BASE_SCREEN_TWEAKS, screen: capture.screen, ...(capture.tweaks || {}) },
  }));
}

export function screenshotFileName(index, titleOrId) {
  const prefix = String(index).padStart(2, '0');
  const slug = String(titleOrId)
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `${prefix}-${slug || 'screenshot'}.png`;
}

export function assertSafeDemoWorkspace(workspacePath) {
  const resolved = path.resolve(requireString(workspacePath, 'workspacePath'));
  const candidate = normalizePath(resolved);
  const roots = [
    process.env.SYMPHONY_DEMO_ROOT || 'C:\\SymphonyDemo',
    path.join(os.tmpdir(), 'symphony-demo'),
  ].map((root) => normalizePath(path.resolve(root)));

  const allowed = roots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
  if (!allowed) {
    throw new Error(
      `Refusing to reset non-demo workspace: ${resolved}. ` +
      `Use a folder under C:\\SymphonyDemo or ${path.join(os.tmpdir(), 'symphony-demo')}.`,
    );
  }
  return resolved;
}

export function buildTauriLaunchEnv({ baseEnv = process.env, workspacePath }) {
  const resolvedWorkspace = path.resolve(requireString(workspacePath, 'workspacePath'));
  return {
    ...baseEnv,
    TOAD_API_TOKEN: '',
    VITE_TOAD_API_TOKEN: '',
    SYMPHONY_FOUNDRY_DB_PATH: path.join(resolvedWorkspace, '.demo', 'foundry.db'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223 --remote-allow-origins=*',
    WEBVIEW2_USER_DATA_FOLDER: path.join(resolvedWorkspace, '.demo-webview2'),
  };
}

export function buildFfmpegRecorderArgs({ outputPath, windowTitle }) {
  return [
    '-y',
    '-f', 'gdigrab',
    '-framerate', '30',
    '-draw_mouse', '1',
    '-i', `title=${requireString(windowTitle, 'windowTitle')}`,
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    requireString(outputPath, 'outputPath'),
  ];
}

export function parseCliArgs(argv) {
  const parsed = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      parsed._.push(token);
      continue;
    }
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

export function scenarioMembers(scenario) {
  return [scenario.team.lead, ...scenario.team.members.filter((member) => member.agentId !== scenario.team.lead.agentId)];
}

function validateScenario(scenario, scenarioPath) {
  requireObject(scenario, 'scenario');
  requireObject(scenario.project, 'scenario.project');
  requireString(scenario.project.name, 'scenario.project.name');
  requireString(scenario.project.slug, 'scenario.project.slug');

  requireObject(scenario.team, 'scenario.team');
  requireString(scenario.team.teamId, 'scenario.team.teamId');
  if (!Array.isArray(scenario.team.members) || scenario.team.members.length === 0) {
    throw new Error(`${scenarioPath}: scenario.team.members must be a non-empty array`);
  }
  for (const member of scenario.team.members) {
    requireObject(member, 'team.member');
    requireString(member.agentId, 'team.member.agentId');
    requireString(member.providerId, 'team.member.providerId');
    requireString(member.role, 'team.member.role');
  }
  const lead = scenario.team.members.find((member) => member.role === 'lead') || scenario.team.members[0];
  scenario.team.lead = lead;

  requireObject(scenario.foundry, 'scenario.foundry');
  requireString(scenario.foundry.sessionId, 'scenario.foundry.sessionId');
  if (!Array.isArray(scenario.foundry.messages)) scenario.foundry.messages = [];
  if (!Array.isArray(scenario.foundry.artifacts) || scenario.foundry.artifacts.length === 0) {
    throw new Error(`${scenarioPath}: scenario.foundry.artifacts must be a non-empty array`);
  }
  for (const artifact of scenario.foundry.artifacts) {
    requireObject(artifact, 'foundry.artifact');
    requireString(artifact.kind, 'foundry.artifact.kind');
    requireString(artifact.title, 'foundry.artifact.title');
    requireString(artifact.targetPath, 'foundry.artifact.targetPath');
    requireString(artifact.content, 'foundry.artifact.content');
  }

  if (!Array.isArray(scenario.tasks) || scenario.tasks.length === 0) {
    throw new Error(`${scenarioPath}: scenario.tasks must be a non-empty array`);
  }
  for (const task of scenario.tasks) {
    requireObject(task, 'scenario.task');
    requireString(task.taskId, 'scenario.task.taskId');
    requireString(task.subject, 'scenario.task.subject');
    const status = task.status || 'pending';
    if (!VALID_TASK_STATUSES.has(status)) {
      throw new Error(`${scenarioPath}: unsupported task status "${status}" for ${task.taskId}`);
    }
  }
  if (!scenario.runtimeScripts || typeof scenario.runtimeScripts !== 'object') {
    scenario.runtimeScripts = {};
  }
}

function requireObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function requireString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function normalizePath(value) {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}
