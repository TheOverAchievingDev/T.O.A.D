# Beast Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in Beast Mode team preset that uses a frontier lead and required architect to fan scoped tasks out to multiple parallel developer agents in per-task worktrees.

**Architecture:** Beast Mode extends the existing team config, task board, launch, and Create Team modal instead of creating a separate orchestration system. The backend owns durable team metadata, architect-plan validation, task slice metadata, and launch gating; the UI only pre-fills/edit those contracts and surfaces current mode/state.

**Tech Stack:** Node.js ESM backend, SQLite-backed event stores, React/TypeScript UI, Node test runner for backend tests, UI `.mjs` tests plus Vite typecheck/build.

---

## File Structure

- Create `toad-local/src/team/beastMode.js`: pure Beast Mode defaults and config/member normalizers.
- Create `toad-local/src/team/beastArchitectPlan.js`: pure architect-plan validator, normalizer, and write-scope overlap helper.
- Modify `toad-local/src/team/teamConfig.js`: preserve `teamMode`, `beastConfig`, `beastState`, and member `model/profile/parallelSlot` fields.
- Modify `toad-local/src/team/sqliteTeamConfigRegistry.js`: round-trip Beast metadata through SQLite config JSON.
- Modify `toad-local/src/team/teamSystemPrompts.js`: add Beast-specific lead/architect/developer guidance.
- Modify `toad-local/src/commands/command-contract.js`: add architect-plan command names and mutating classification.
- Modify `toad-local/src/mcp/localToolDefinitions.js`: expose architect-plan record/get tools and task slice metadata fields.
- Modify `toad-local/src/tools/localToolFacade.js`: implement architect-plan record/get, task metadata capture, and Beast launch gating.
- Modify `toad-local/src/task/inMemoryTaskBoard.js`: project task slice metadata.
- Modify `toad-local/ui/src/types/index.ts`: expose team/members/task Beast fields needed by UI.
- Create `toad-local/ui/src/components/createTeam/beastTeamDraft.ts`: UI-side Beast roster preset helpers.
- Modify `toad-local/ui/src/components/CreateTeamModal.tsx`: add Standard/Beast mode selector and advanced Beast fields.
- Modify cockpit UI files only after backend contracts are stable:
  - `toad-local/ui/src/components/cockpit/CockpitScreenV2.tsx`
  - `toad-local/ui/src/components/cockpit/CockpitForMe.tsx`
  - `toad-local/ui/src/components/cockpit/Inspector.tsx`
- Add/update tests:
  - `toad-local/test/beastMode.test.js`
  - `toad-local/test/beastArchitectPlan.test.js`
  - `toad-local/test/teamConfig.test.js`
  - `toad-local/test/localToolFacade.test.js`
  - `toad-local/ui/test/beastTeamDraft.test.mjs`

## Task 1: Beast Team Config And Template

**Files:**
- Create: `toad-local/src/team/beastMode.js`
- Modify: `toad-local/src/team/teamConfig.js`
- Modify: `toad-local/src/team/sqliteTeamConfigRegistry.js`
- Test: `toad-local/test/beastMode.test.js`
- Test: `toad-local/test/teamConfig.test.js`

- [ ] **Step 1: Write failing Beast template tests**

Create `toad-local/test/beastMode.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BEAST_MODE_DEFAULT_CONFIG,
  createBeastModeTeamDraft,
  normalizeBeastConfig,
  normalizeTeamMode,
} from '../src/team/beastMode.js';

test('normalizeTeamMode only accepts standard or beast', () => {
  assert.equal(normalizeTeamMode('beast'), 'beast');
  assert.equal(normalizeTeamMode('standard'), 'standard');
  assert.equal(normalizeTeamMode('other'), 'standard');
  assert.equal(normalizeTeamMode(null), 'standard');
});

test('normalizeBeastConfig preserves supported edits and fills defaults', () => {
  const config = normalizeBeastConfig({
    defaultDevCount: 5,
    maxParallelDevs: 4,
    githubMirror: 'issues_and_prs',
  });
  assert.equal(config.defaultDevCount, 5);
  assert.equal(config.maxParallelDevs, 4);
  assert.equal(config.requireArchitectPlan, true);
  assert.equal(config.worktreePolicy, 'per_task');
  assert.equal(config.integrationPolicy, 'lead_ordered');
  assert.equal(config.githubMirror, 'issues_and_prs');
});

test('createBeastModeTeamDraft returns default editable roster', () => {
  const draft = createBeastModeTeamDraft({ teamId: 'big-build', cwd: 'C:\\Project' });
  assert.equal(draft.teamMode, 'beast');
  assert.deepEqual(draft.beastConfig, BEAST_MODE_DEFAULT_CONFIG);
  assert.equal(draft.lead.agentId, 'lead');
  assert.equal(draft.lead.role, 'lead');
  assert.equal(draft.lead.providerId, 'anthropic');
  assert.deepEqual(
    draft.teammates.map((m) => [m.agentId, m.role, m.parallelSlot ?? null]),
    [
      ['architect', 'architect', null],
      ['dev-1', 'developer', 1],
      ['dev-2', 'developer', 2],
      ['dev-3', 'developer', 3],
      ['reviewer', 'reviewer', null],
      ['tester', 'tester', null],
    ],
  );
  assert.equal(draft.teammates[1].providerId, 'opencode');
  assert.equal(draft.teammates[1].profile, 'Default');
});
```

Append this test to `toad-local/test/teamConfig.test.js`:

```js
test('TeamConfig preserves beast mode metadata and member model/profile fields', () => {
  const config = new TeamConfig({
    teamId: 'team-beast',
    teamMode: 'beast',
    beastConfig: {
      defaultDevCount: 4,
      maxParallelDevs: 2,
      githubMirror: 'issues',
    },
    beastState: {
      architectPlan: { planId: 'ap-1', slices: [] },
    },
    lead: { agentId: 'lead', providerId: 'anthropic', model: 'Opus 4.7' },
    teammates: [
      {
        agentId: 'dev-1',
        role: 'developer',
        providerId: 'opencode',
        model: 'Qwen3-Coder',
        profile: 'qwen-local',
        parallelSlot: 1,
      },
    ],
  });
  const json = config.toJSON();
  assert.equal(json.teamMode, 'beast');
  assert.equal(json.beastConfig.defaultDevCount, 4);
  assert.equal(json.beastConfig.maxParallelDevs, 2);
  assert.equal(json.beastConfig.githubMirror, 'issues');
  assert.equal(json.beastState.architectPlan.planId, 'ap-1');
  assert.equal(json.lead.model, 'Opus 4.7');
  assert.equal(json.teammates[0].model, 'Qwen3-Coder');
  assert.equal(json.teammates[0].profile, 'qwen-local');
  assert.equal(json.teammates[0].parallelSlot, 1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test .\toad-local\test\beastMode.test.js .\toad-local\test\teamConfig.test.js
```

Expected: fails because `src/team/beastMode.js` does not exist and `TeamConfig` drops Beast metadata.

- [ ] **Step 3: Implement Beast config helpers**

Create `toad-local/src/team/beastMode.js`:

```js
export const TEAM_MODES = Object.freeze(['standard', 'beast']);

export const BEAST_MODE_DEFAULT_CONFIG = Object.freeze({
  defaultDevCount: 3,
  maxParallelDevs: 3,
  requireArchitectPlan: true,
  worktreePolicy: 'per_task',
  integrationPolicy: 'lead_ordered',
  githubMirror: 'off',
});

const GITHUB_MIRROR_MODES = new Set(['off', 'issues', 'issues_and_prs']);

export function normalizeTeamMode(value) {
  return value === 'beast' ? 'beast' : 'standard';
}

export function normalizeBeastConfig(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const defaultDevCount = normalizePositiveInt(raw.defaultDevCount, BEAST_MODE_DEFAULT_CONFIG.defaultDevCount);
  const maxParallelDevs = normalizePositiveInt(raw.maxParallelDevs, Math.min(defaultDevCount, BEAST_MODE_DEFAULT_CONFIG.maxParallelDevs));
  return {
    defaultDevCount,
    maxParallelDevs: Math.min(maxParallelDevs, defaultDevCount),
    requireArchitectPlan: raw.requireArchitectPlan === false ? false : true,
    worktreePolicy: raw.worktreePolicy === 'per_task' ? 'per_task' : BEAST_MODE_DEFAULT_CONFIG.worktreePolicy,
    integrationPolicy: raw.integrationPolicy === 'lead_ordered' ? 'lead_ordered' : BEAST_MODE_DEFAULT_CONFIG.integrationPolicy,
    githubMirror: GITHUB_MIRROR_MODES.has(raw.githubMirror) ? raw.githubMirror : BEAST_MODE_DEFAULT_CONFIG.githubMirror,
  };
}

export function normalizeBeastState(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    architectPlan: raw.architectPlan && typeof raw.architectPlan === 'object' && !Array.isArray(raw.architectPlan)
      ? { ...raw.architectPlan }
      : null,
  };
}

export function createBeastModeTeamDraft({
  teamId,
  cwd = null,
  leadProviderId = 'anthropic',
  developerProviderId = 'opencode',
  developerProfile = 'Default',
  defaultDevCount = BEAST_MODE_DEFAULT_CONFIG.defaultDevCount,
} = {}) {
  const devCount = normalizePositiveInt(defaultDevCount, BEAST_MODE_DEFAULT_CONFIG.defaultDevCount);
  const cwdPart = typeof cwd === 'string' && cwd.length > 0 ? { cwd } : {};
  const developers = Array.from({ length: devCount }, (_, index) => ({
    agentId: `dev-${index + 1}`,
    role: 'developer',
    providerId: developerProviderId,
    profile: developerProfile,
    parallelSlot: index + 1,
    ...cwdPart,
  }));
  return {
    teamId: typeof teamId === 'string' && teamId.trim() ? teamId.trim() : 'beast-team',
    teamMode: 'beast',
    beastConfig: normalizeBeastConfig({ defaultDevCount: devCount, maxParallelDevs: Math.min(3, devCount) }),
    beastState: normalizeBeastState(),
    lead: { agentId: 'lead', role: 'lead', providerId: leadProviderId, ...cwdPart },
    teammates: [
      { agentId: 'architect', role: 'architect', providerId: leadProviderId, ...cwdPart },
      ...developers,
      { agentId: 'reviewer', role: 'reviewer', providerId: leadProviderId, ...cwdPart },
      { agentId: 'tester', role: 'tester', providerId: 'gemini', ...cwdPart },
    ],
  };
}

function normalizePositiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
```

- [ ] **Step 4: Preserve Beast metadata in TeamConfig**

Modify `toad-local/src/team/teamConfig.js`:

```js
import { PROVIDER_COMMANDS, commandForProvider } from './providerCommands.js';
import { normalizeBeastConfig, normalizeBeastState, normalizeTeamMode } from './beastMode.js';
```

Inside `normalizeMember`, add these fields to the returned object after `providerId`:

```js
    model: typeof m.model === 'string' && m.model.trim() ? m.model.trim() : '',
    profile: typeof m.profile === 'string' && m.profile.trim() ? m.profile.trim() : '',
    parallelSlot: Number.isInteger(m.parallelSlot) && m.parallelSlot > 0 ? m.parallelSlot : null,
```

Change the constructor signature and body:

```js
  constructor({ teamId, lead = {}, teammates = [], validation = null, teamMode = 'standard', beastConfig = null, beastState = null }) {
    if (typeof teamId !== 'string' || teamId.trim() === '') {
      throw new TypeError('teamId must be a non-empty string');
    }
    this.teamId = teamId.trim();
    this.teamMode = normalizeTeamMode(teamMode);
    this.beastConfig = this.teamMode === 'beast' ? normalizeBeastConfig(beastConfig || {}) : null;
    this.beastState = this.teamMode === 'beast' ? normalizeBeastState(beastState || {}) : null;
    this.lead = normalizeMember(lead, 'lead');
    this.teammates = Array.isArray(teammates)
      ? teammates.map((t, idx) => normalizeMember(t, `worker-${idx + 1}`))
      : [];
    this.validation = normalizeValidation(validation);
  }
```

In `toJSON`, include Beast metadata:

```js
    if (this.validation) json.validation = { ...this.validation };
    if (this.teamMode === 'beast') {
      json.teamMode = 'beast';
      json.beastConfig = { ...this.beastConfig };
      json.beastState = { ...this.beastState };
    } else {
      json.teamMode = 'standard';
    }
```

- [ ] **Step 5: Round-trip Beast metadata from SQLite**

Modify `rowToConfig` in `toad-local/src/team/sqliteTeamConfigRegistry.js`:

```js
  return new TeamConfig({
    teamId: raw.teamId,
    lead: raw.lead || {},
    teammates: Array.isArray(raw.teammates) ? raw.teammates : [],
    validation: raw.validation || null,
    teamMode: raw.teamMode || 'standard',
    beastConfig: raw.beastConfig || null,
    beastState: raw.beastState || null,
  });
```

- [ ] **Step 6: Run tests and commit**

Run:

```powershell
node --test .\toad-local\test\beastMode.test.js .\toad-local\test\teamConfig.test.js
```

Expected: PASS.

Commit:

```powershell
git add .\toad-local\src\team\beastMode.js .\toad-local\src\team\teamConfig.js .\toad-local\src\team\sqliteTeamConfigRegistry.js .\toad-local\test\beastMode.test.js .\toad-local\test\teamConfig.test.js
git commit -m "feat(team): add beast mode team config"
```

## Task 2: Architect Plan Contract And Commands

**Files:**
- Create: `toad-local/src/team/beastArchitectPlan.js`
- Modify: `toad-local/src/commands/command-contract.js`
- Modify: `toad-local/src/mcp/localToolDefinitions.js`
- Modify: `toad-local/src/tools/localToolFacade.js`
- Test: `toad-local/test/beastArchitectPlan.test.js`
- Test: `toad-local/test/localToolFacade.test.js`

- [ ] **Step 1: Write failing architect-plan tests**

Create `toad-local/test/beastArchitectPlan.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeArchitectPlan,
  pathsOverlap,
  validateArchitectPlan,
} from '../src/team/beastArchitectPlan.js';

test('validateArchitectPlan accepts scoped independent slices', () => {
  const plan = normalizeArchitectPlan({
    planId: 'ap-1',
    teamId: 'team-a',
    slices: [
      {
        id: 'slice-ui',
        title: 'Build UI',
        assignedRole: 'developer',
        allowedPaths: ['ui/src/**'],
        blockedPaths: ['src/security/**'],
        dependsOn: [],
        validation: ['npm run typecheck'],
        mergeOrder: 1,
        conflictRisk: 'medium',
        preferredAgent: 'dev-1',
      },
    ],
  });
  assert.equal(plan.valid, true);
  assert.equal(plan.plan.planId, 'ap-1');
  assert.equal(plan.plan.slices[0].allowedPaths[0], 'ui/src/**');
});

test('validateArchitectPlan rejects duplicate slice ids and invalid dependencies', () => {
  const result = validateArchitectPlan({
    planId: 'ap-1',
    teamId: 'team-a',
    slices: [
      { id: 'same', title: 'A', allowedPaths: ['a/**'], dependsOn: ['missing'], mergeOrder: 1 },
      { id: 'same', title: 'B', allowedPaths: ['b/**'], mergeOrder: 2 },
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('duplicate slice id: same')));
  assert.ok(result.errors.some((e) => e.includes('dependsOn missing unknown slice missing')));
});

test('validateArchitectPlan rejects overlapping parallel write scopes', () => {
  const result = validateArchitectPlan({
    planId: 'ap-1',
    teamId: 'team-a',
    slices: [
      { id: 'a', title: 'A', allowedPaths: ['src/**'], mergeOrder: 1 },
      { id: 'b', title: 'B', allowedPaths: ['src/components/**'], mergeOrder: 2 },
    ],
  });
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('overlapping write scopes')));
});

test('pathsOverlap handles exact, directory, and glob-like scopes', () => {
  assert.equal(pathsOverlap('src/**', 'src/components/Button.tsx'), true);
  assert.equal(pathsOverlap('src/components/**', 'src/**'), true);
  assert.equal(pathsOverlap('src/a.ts', 'src/a.ts'), true);
  assert.equal(pathsOverlap('src/a.ts', 'test/a.test.ts'), false);
});
```

Append to `toad-local/test/localToolFacade.test.js` near other team tests:

```js
test('beast_architect_plan_record validates and persists architect plan on team config', async () => {
  const registry = new TeamConfigRegistry();
  registry.registerTeam(new TeamConfig({
    teamId: 'team-beast',
    teamMode: 'beast',
    lead: { agentId: 'lead' },
    teammates: [{ agentId: 'architect', role: 'architect' }],
  }));
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: registry,
  });
  const actor = { teamId: 'team-beast', agentId: 'architect', role: 'architect' };
  const result = await facade.execute({
    actor,
    command: {
      name: 'beast_architect_plan_record',
      idempotencyKey: 'ap-record-1',
      args: {
        planId: 'ap-1',
        slices: [
          {
            id: 'slice-ui',
            title: 'Build UI',
            assignedRole: 'developer',
            allowedPaths: ['ui/src/**'],
            mergeOrder: 1,
            preferredAgent: 'dev-1',
          },
        ],
      },
    },
  });
  assert.equal(result.valid, true);
  const saved = registry.getTeam('team-beast').toJSON();
  assert.equal(saved.beastState.architectPlan.planId, 'ap-1');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test .\toad-local\test\beastArchitectPlan.test.js .\toad-local\test\localToolFacade.test.js
```

Expected: fails because `beastArchitectPlan.js` and command handling do not exist.

- [ ] **Step 3: Implement architect-plan validator**

Create `toad-local/src/team/beastArchitectPlan.js`:

```js
const CONFLICT_RISK = new Set(['low', 'medium', 'high', 'critical']);
const ASSIGNED_ROLES = new Set(['developer', 'architect', 'reviewer', 'tester', 'lead', 'human']);

export function normalizeArchitectPlan(input = {}) {
  const validation = validateArchitectPlan(input);
  return validation;
}

export function validateArchitectPlan(input = {}) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const errors = [];
  const planId = cleanString(raw.planId) || `architect-plan-${Date.now()}`;
  const teamId = cleanString(raw.teamId) || null;
  const slicesInput = Array.isArray(raw.slices) ? raw.slices : [];
  if (slicesInput.length === 0) errors.push('architect plan must include at least one slice');

  const seen = new Set();
  const slices = slicesInput.map((slice, index) => {
    const s = slice && typeof slice === 'object' && !Array.isArray(slice) ? slice : {};
    const id = cleanString(s.id) || `slice-${index + 1}`;
    if (seen.has(id)) errors.push(`duplicate slice id: ${id}`);
    seen.add(id);
    const title = cleanString(s.title);
    if (!title) errors.push(`slice ${id} missing title`);
    const allowedPaths = normalizeStringList(s.allowedPaths);
    if (allowedPaths.length === 0) errors.push(`slice ${id} missing allowedPaths`);
    const assignedRole = cleanString(s.assignedRole) || 'developer';
    if (!ASSIGNED_ROLES.has(assignedRole)) errors.push(`slice ${id} has unsupported assignedRole ${assignedRole}`);
    const mergeOrder = Number.isInteger(s.mergeOrder) && s.mergeOrder > 0 ? s.mergeOrder : index + 1;
    const conflictRisk = CONFLICT_RISK.has(s.conflictRisk) ? s.conflictRisk : 'medium';
    return {
      id,
      title: title || id,
      assignedRole,
      allowedPaths,
      blockedPaths: normalizeStringList(s.blockedPaths),
      dependsOn: normalizeStringList(s.dependsOn),
      validation: normalizeStringList(s.validation),
      mergeOrder,
      conflictRisk,
      preferredAgent: cleanString(s.preferredAgent),
    };
  });

  const sliceIds = new Set(slices.map((s) => s.id));
  for (const slice of slices) {
    for (const dep of slice.dependsOn) {
      if (!sliceIds.has(dep)) errors.push(`slice ${slice.id} dependsOn missing unknown slice ${dep}`);
    }
  }

  for (let i = 0; i < slices.length; i += 1) {
    for (let j = i + 1; j < slices.length; j += 1) {
      if (slices[i].dependsOn.includes(slices[j].id) || slices[j].dependsOn.includes(slices[i].id)) continue;
      if (scopeListsOverlap(slices[i].allowedPaths, slices[j].allowedPaths)) {
        errors.push(`overlapping write scopes between ${slices[i].id} and ${slices[j].id}`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    plan: {
      planId,
      teamId,
      createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
      slices,
    },
  };
}

export function pathsOverlap(left, right) {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  if (!a || !b) return false;
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function scopeListsOverlap(left, right) {
  for (const a of left) {
    for (const b of right) {
      if (pathsOverlap(a, b)) return true;
    }
  }
  return false;
}

function normalizeScope(value) {
  const s = cleanString(value);
  if (!s) return '';
  return s.replace(/\\/g, '/').replace(/\/\*\*$/, '').replace(/\/$/, '');
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map(cleanString).filter(Boolean);
}

function cleanString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}
```

- [ ] **Step 4: Add command names and MCP schemas**

Modify `toad-local/src/commands/command-contract.js`:

```js
  BEAST_ARCHITECT_PLAN_RECORD: 'beast_architect_plan_record',
  BEAST_ARCHITECT_PLAN_GET: 'beast_architect_plan_get',
```

Add `COMMANDS.BEAST_ARCHITECT_PLAN_RECORD` to `MUTATING_COMMANDS`.

Modify `toad-local/src/mcp/localToolDefinitions.js` by adding two `makeTool` entries after `TEAM_LAUNCH` or near team tools:

```js
  makeTool({
    name: COMMANDS.BEAST_ARCHITECT_PLAN_RECORD,
    title: 'Record Beast Architect Plan',
    description: 'Record the required Beast Mode architect parallelization plan. Validates slice ids, dependencies, write scopes, merge order, preferred agents, and validation commands before persisting.',
    required: ['planId', 'slices'],
    properties: {
      planId: { type: 'string', minLength: 1 },
      slices: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'allowedPaths'],
          properties: {
            id: { type: 'string', minLength: 1 },
            title: { type: 'string', minLength: 1 },
            assignedRole: { type: 'string', enum: ['developer', 'architect', 'reviewer', 'tester', 'lead', 'human'] },
            allowedPaths: STRING_LIST_SCHEMA,
            blockedPaths: STRING_LIST_SCHEMA,
            dependsOn: STRING_LIST_SCHEMA,
            validation: STRING_LIST_SCHEMA,
            mergeOrder: { type: 'integer', minimum: 1 },
            conflictRisk: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
            preferredAgent: { type: 'string', minLength: 1 },
          },
        },
      },
    },
  }),
  makeTool({
    name: COMMANDS.BEAST_ARCHITECT_PLAN_GET,
    title: 'Get Beast Architect Plan',
    description: 'Read the persisted Beast Mode architect plan for the current team.',
    required: [],
    properties: {},
  }),
```

- [ ] **Step 5: Implement LocalToolFacade architect-plan handlers**

Modify imports in `toad-local/src/tools/localToolFacade.js`:

```js
import { validateArchitectPlan } from '../team/beastArchitectPlan.js';
```

Add dispatch cases:

```js
      case COMMANDS.BEAST_ARCHITECT_PLAN_RECORD:
        return this.#beastArchitectPlanRecord(actor, args);
      case COMMANDS.BEAST_ARCHITECT_PLAN_GET:
        return this.#beastArchitectPlanGet(actor);
```

Add methods near team methods:

```js
  #beastArchitectPlanRecord(actor, args) {
    if (!this.teamConfigRegistry) {
      throw new Error('beast_architect_plan_record: teamConfigRegistry is not configured');
    }
    const current = this.teamConfigRegistry.getTeam(actor.teamId);
    if (!current) throw new Error(`beast_architect_plan_record: no config for teamId ${actor.teamId}`);
    if (current.teamMode !== 'beast') throw new Error('beast_architect_plan_record: team is not in beast mode');
    const validation = validateArchitectPlan({
      ...args,
      teamId: actor.teamId,
      createdAt: new Date().toISOString(),
    });
    if (!validation.valid) {
      return { valid: false, errors: validation.errors, plan: validation.plan };
    }
    const snapshot = current.toJSON();
    const updated = new TeamConfig({
      ...snapshot,
      beastState: {
        ...(snapshot.beastState || {}),
        architectPlan: validation.plan,
      },
    });
    this.teamConfigRegistry.registerTeam(updated);
    return { valid: true, errors: [], plan: validation.plan };
  }

  #beastArchitectPlanGet(actor) {
    if (!this.teamConfigRegistry) {
      throw new Error('beast_architect_plan_get: teamConfigRegistry is not configured');
    }
    const current = this.teamConfigRegistry.getTeam(actor.teamId);
    if (!current) throw new Error(`beast_architect_plan_get: no config for teamId ${actor.teamId}`);
    return {
      teamId: actor.teamId,
      teamMode: current.teamMode || 'standard',
      architectPlan: current.beastState?.architectPlan || null,
    };
  }
```

- [ ] **Step 6: Run tests and commit**

Run:

```powershell
node --test .\toad-local\test\beastArchitectPlan.test.js .\toad-local\test\localToolFacade.test.js
```

Expected: PASS for new tests and no regression in touched local facade tests.

Commit:

```powershell
git add .\toad-local\src\team\beastArchitectPlan.js .\toad-local\src\commands\command-contract.js .\toad-local\src\mcp\localToolDefinitions.js .\toad-local\src\tools\localToolFacade.js .\toad-local\test\beastArchitectPlan.test.js .\toad-local\test\localToolFacade.test.js
git commit -m "feat(team): persist beast architect plans"
```

## Task 3: Task Slice Metadata

**Files:**
- Modify: `toad-local/src/task/inMemoryTaskBoard.js`
- Modify: `toad-local/src/tools/localToolFacade.js`
- Modify: `toad-local/src/mcp/localToolDefinitions.js`
- Modify: `toad-local/ui/src/types/index.ts`
- Test: `toad-local/test/localToolFacade.test.js`

- [ ] **Step 1: Write failing task metadata test**

Append to `toad-local/test/localToolFacade.test.js` near `task_create` tests:

```js
test('task_create accepts Beast slice metadata and projects it onto the task', () => {
  const facade = new LocalToolFacade({ broker: new InMemoryBroker(), taskBoard: new InMemoryTaskBoard() });
  const task = facade.execute({
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    command: {
      name: 'task_create',
      idempotencyKey: 'beast-task-1',
      args: {
        taskId: 'B-001',
        subject: 'Build user settings pane',
        assignedRole: 'developer',
        ownerId: 'dev-1',
        allowedFiles: ['ui/src/settings/**'],
        forbiddenFiles: ['src/security/**'],
        testCommands: ['npm run typecheck'],
        dependencyTaskIds: ['B-000'],
        workSliceId: 'slice-settings',
        architectPlanId: 'ap-1',
        mergeOrder: 3,
        conflictRisk: 'medium',
        preferredAgent: 'dev-1',
      },
    },
  });
  assert.equal(task.workSliceId, 'slice-settings');
  assert.equal(task.architectPlanId, 'ap-1');
  assert.equal(task.mergeOrder, 3);
  assert.equal(task.conflictRisk, 'medium');
  assert.equal(task.preferredAgent, 'dev-1');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
node --test .\toad-local\test\localToolFacade.test.js --test-name-pattern "Beast slice metadata"
```

Expected: FAIL because projected task fields are missing.

- [ ] **Step 3: Project Beast slice metadata**

In `toad-local/src/task/inMemoryTaskBoard.js`, add default fields to `task` inside `projectTask`:

```js
    workSliceId: null,
    architectPlanId: null,
    mergeOrder: null,
    conflictRisk: null,
    preferredAgent: null,
```

Inside the `TASK_EVENT_TYPES.CREATED` block, after `task.delivers = normalizeStringList(event.payload.delivers);`, add:

```js
      task.workSliceId = typeof event.payload.workSliceId === 'string' ? event.payload.workSliceId : null;
      task.architectPlanId = typeof event.payload.architectPlanId === 'string' ? event.payload.architectPlanId : null;
      task.mergeOrder = Number.isInteger(event.payload.mergeOrder) ? event.payload.mergeOrder : null;
      task.conflictRisk = normalizeRiskLevel(event.payload.conflictRisk);
      task.preferredAgent = typeof event.payload.preferredAgent === 'string' ? event.payload.preferredAgent : null;
```

- [ ] **Step 4: Accept task_create metadata in facade and MCP schema**

In `normalizeTaskRiskContractArgs` in `toad-local/src/tools/localToolFacade.js`, add before `return payload;`:

```js
  if (typeof args.workSliceId === 'string' && args.workSliceId.trim().length > 0) {
    payload.workSliceId = args.workSliceId.trim();
  }
  if (typeof args.architectPlanId === 'string' && args.architectPlanId.trim().length > 0) {
    payload.architectPlanId = args.architectPlanId.trim();
  }
  if (Number.isInteger(args.mergeOrder) && args.mergeOrder > 0) {
    payload.mergeOrder = args.mergeOrder;
  }
  if (typeof args.conflictRisk === 'string' && args.conflictRisk.trim().length > 0) {
    const conflictRisk = args.conflictRisk.trim();
    if (!TASK_RISK_LEVELS.includes(conflictRisk)) {
      throw new Error(`task_create: unsupported conflictRisk ${conflictRisk}`);
    }
    payload.conflictRisk = conflictRisk;
  }
  if (typeof args.preferredAgent === 'string' && args.preferredAgent.trim().length > 0) {
    payload.preferredAgent = args.preferredAgent.trim();
  }
```

In `toad-local/src/mcp/localToolDefinitions.js` task_create properties, add:

```js
      workSliceId: { type: 'string', minLength: 1 },
      architectPlanId: { type: 'string', minLength: 1 },
      mergeOrder: { type: 'integer', minimum: 1 },
      conflictRisk: { type: 'string', enum: TASK_RISK_LEVELS },
      preferredAgent: { type: 'string', minLength: 1 },
```

In `toad-local/ui/src/types/index.ts`, add optional fields to `UiTask`:

```ts
  workSliceId?: string | null;
  architectPlanId?: string | null;
  mergeOrder?: number | null;
  conflictRisk?: TaskRiskLevel | null;
  preferredAgent?: string | null;
  dependencyTaskIds?: string[];
```

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
node --test .\toad-local\test\localToolFacade.test.js --test-name-pattern "Beast slice metadata"
```

Expected: PASS.

Commit:

```powershell
git add .\toad-local\src\task\inMemoryTaskBoard.js .\toad-local\src\tools\localToolFacade.js .\toad-local\src\mcp\localToolDefinitions.js .\toad-local\ui\src\types\index.ts .\toad-local\test\localToolFacade.test.js
git commit -m "feat(tasks): carry beast slice metadata"
```

## Task 4: Beast Launch Gating And Prompts

**Files:**
- Modify: `toad-local/src/tools/localToolFacade.js`
- Modify: `toad-local/src/team/teamSystemPrompts.js`
- Test: `toad-local/test/localToolFacade.test.js`
- Test: `toad-local/test/teamSystemPrompts.test.js`

- [ ] **Step 1: Write failing launch-gate test**

Append to `toad-local/test/localToolFacade.test.js` near `team_launch` tests:

```js
test('team_launch in Beast Mode launches lead and architect before architect plan, skips devs', async () => {
  const launches = [];
  const registry = new TeamConfigRegistry();
  registry.registerTeam(new TeamConfig({
    teamId: 'team-beast',
    teamMode: 'beast',
    lead: { agentId: 'lead', role: 'lead' },
    teammates: [
      { agentId: 'architect', role: 'architect' },
      { agentId: 'dev-1', role: 'developer' },
      { agentId: 'reviewer', role: 'reviewer' },
    ],
  }));
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: registry,
    launchAgent: async (input) => {
      launches.push(input);
      return { status: 'running' };
    },
  });
  const result = await facade.execute({
    actor: { teamId: 'team-beast', agentId: 'operator', role: 'human' },
    command: { name: 'team_launch', idempotencyKey: 'launch-beast-1', args: { teamId: 'team-beast' } },
  });
  assert.deepEqual(launches.map((l) => l.agentId), ['lead', 'architect']);
  assert.equal(result.members.find((m) => m.agentId === 'dev-1').status, 'waiting_for_architect_plan');
  assert.equal(result.members.find((m) => m.agentId === 'reviewer').status, 'waiting_for_architect_plan');
});
```

Append to `toad-local/test/teamSystemPrompts.test.js`:

```js
test('Beast lead prompt requires architect plan before developer work', () => {
  const text = buildLeadSystemPrompt({
    teamId: 'beast',
    lead: { agentId: 'lead' },
    teammates: [
      { agentId: 'architect', role: 'architect' },
      { agentId: 'dev-1', role: 'developer' },
    ],
    cwd: 'C:\\Project',
    teamMode: 'beast',
    beastConfig: { requireArchitectPlan: true },
  });
  assert.match(text, /Beast Mode/);
  assert.match(text, /beast_architect_plan_record/);
  assert.match(text, /Do not assign implementation tasks to developers until/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```powershell
node --test .\toad-local\test\localToolFacade.test.js .\toad-local\test\teamSystemPrompts.test.js --test-name-pattern "Beast|beast"
```

Expected: FAIL because launch still starts all members and prompts lack Beast guidance.

- [ ] **Step 3: Add Beast prompt guidance**

Modify `buildLeadSystemPrompt` signature in `toad-local/src/team/teamSystemPrompts.js`:

```js
export function buildLeadSystemPrompt({ teamId, lead, teammates, cwd, teamMode = 'standard', beastConfig = null }) {
```

Before the final `].join('\n\n')`, include:

```js
    ...(teamMode === 'beast' ? [
      'Beast Mode is enabled. You must use the architect as the decomposition gate before developer implementation begins.',
      'Ask the architect to produce a machine-readable parallelization plan, then record it with beast_architect_plan_record. Do not assign implementation tasks to developers until that command succeeds.',
      'Each developer task must be independent, include allowedFiles/forbiddenFiles, dependencyTaskIds, testCommands, workSliceId, architectPlanId, mergeOrder, conflictRisk, and preferredAgent where known.',
      'Use one task, one developer, one worktree. If two slices overlap, serialize them or ask the operator for an explicit override.',
    ] : []),
```

Modify `buildTeammateSystemPrompt` signature similarly:

```js
export function buildTeammateSystemPrompt({ teamId, member, leadId, teammates, cwd, teamMode = 'standard' }) {
```

Add Beast role-specific text:

```js
    ...(teamMode === 'beast' && member.role === 'architect' ? [
      'Beast Mode architect duty: before developers start, produce a slice plan with ids, titles, assigned roles, allowedPaths, blockedPaths, dependencies, validation commands, mergeOrder, conflictRisk, and preferredAgent. Ask the lead to record it with beast_architect_plan_record or record it yourself if you are authorized.',
    ] : []),
    ...(teamMode === 'beast' && member.role === 'developer' ? [
      'Beast Mode developer duty: only work on tasks assigned to your agent and stay inside the task worktree and allowedFiles scope. Do not broaden architecture or touch blocked paths without asking the lead.',
    ] : []),
```

Modify `buildAgentSystemPrompt` calls to thread mode/config:

```js
    return buildLeadSystemPrompt({ teamId, lead, teammates, cwd, teamMode, beastConfig });
```

and:

```js
    teamMode,
```

- [ ] **Step 4: Gate team_launch before architect plan**

In `#teamLaunch` after `const members = [config.lead, ...config.teammates];`, replace with:

```js
    const allMembers = [config.lead, ...config.teammates];
    const needsBeastPlan =
      config.teamMode === 'beast'
      && config.beastConfig?.requireArchitectPlan !== false
      && !config.beastState?.architectPlan;
    const members = needsBeastPlan
      ? allMembers.filter((member) => member.agentId === config.lead.agentId || member.role === 'architect')
      : allMembers;
    const gatedMembers = needsBeastPlan
      ? allMembers.filter((member) => !members.includes(member))
      : [];
```

When `buildAgentSystemPrompt` is called, add:

```js
          teamMode: config.teamMode || 'standard',
          beastConfig: config.beastConfig || null,
```

Before returning from `#teamLaunch`, append gated results:

```js
    for (const member of gatedMembers) {
      results.push({
        runtimeId: `runtime-${teamId}-${member.agentId}`,
        agentId: member.agentId,
        status: 'waiting_for_architect_plan',
      });
    }
```

Adjust the no-prompt lead kickoff when `needsBeastPlan` is true:

```js
        if (isLead && !hasUserPrompt) {
          launchInput.prompt = needsBeastPlan
            ? [
                'Boot complete. Beast Mode is enabled.',
                'First, ask architect to read the Foundry docs and produce the parallelization plan. Record that plan with beast_architect_plan_record before assigning implementation work to developers.',
                'After the plan is recorded, create scoped tasks with allowedFiles, forbiddenFiles, dependencyTaskIds, testCommands, workSliceId, architectPlanId, mergeOrder, conflictRisk, and preferredAgent.',
              ].join('\n\n')
            : [
                'Boot complete. Your team manifest is loaded in the system prompt above including who you are, your teammates, and the project root.',
                'Briefly tell the operator you are online, then start orchestrating: inspect the project (Read/Bash as needed), identify the most useful work, create concrete tasks via task_create, and assign each to the right teammate via message_send. Do not wait for the operator to spell out the work; drive it forward yourself. The operator can interrupt or redirect you any time.',
              ].join('\n\n');
        }
```

- [ ] **Step 5: Run tests and commit**

Run:

```powershell
node --test .\toad-local\test\localToolFacade.test.js .\toad-local\test\teamSystemPrompts.test.js --test-name-pattern "Beast|beast"
```

Expected: PASS.

Commit:

```powershell
git add .\toad-local\src\tools\localToolFacade.js .\toad-local\src\team\teamSystemPrompts.js .\toad-local\test\localToolFacade.test.js .\toad-local\test\teamSystemPrompts.test.js
git commit -m "feat(team): gate beast launch on architect plan"
```

## Task 5: Create Team Beast Mode UI

**Files:**
- Create: `toad-local/ui/src/components/createTeam/beastTeamDraft.ts`
- Modify: `toad-local/ui/src/components/CreateTeamModal.tsx`
- Test: `toad-local/ui/test/beastTeamDraft.test.mjs`

- [ ] **Step 1: Write failing UI helper test**

Create `toad-local/ui/test/beastTeamDraft.test.mjs`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBeastMemberDrafts, buildBeastConfigDraft } from '../src/components/createTeam/beastTeamDraft.ts';

test('buildBeastMemberDrafts creates architect, three devs, reviewer, tester', () => {
  const members = buildBeastMemberDrafts();
  assert.deepEqual(
    members.map((m) => [m.name, m.role, m.provider, m.parallelSlot ?? null]),
    [
      ['architect', 'architect', 'anthropic', null],
      ['dev-1', 'developer', 'opencode', 1],
      ['dev-2', 'developer', 'opencode', 2],
      ['dev-3', 'developer', 'opencode', 3],
      ['reviewer', 'reviewer', 'anthropic', null],
      ['tester', 'qa', 'gemini', null],
    ],
  );
});

test('buildBeastConfigDraft clamps max parallel devs to dev count', () => {
  assert.deepEqual(buildBeastConfigDraft({ defaultDevCount: 2, maxParallelDevs: 5 }), {
    defaultDevCount: 2,
    maxParallelDevs: 2,
    requireArchitectPlan: true,
    worktreePolicy: 'per_task',
    integrationPolicy: 'lead_ordered',
    githubMirror: 'off',
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
cd .\toad-local\ui
node --test .\test\beastTeamDraft.test.mjs
```

Expected: FAIL because helper file does not exist.

- [ ] **Step 3: Implement UI Beast draft helper**

Create `toad-local/ui/src/components/createTeam/beastTeamDraft.ts`:

```ts
import type { RoleId } from '@/types';

export interface BeastMemberDraft {
  id: number;
  name: string;
  role: Exclude<RoleId, 'lead'>;
  provider: string;
  model: string;
  profile?: string;
  parallelSlot?: number | null;
}

export interface BeastConfigDraft {
  defaultDevCount: number;
  maxParallelDevs: number;
  requireArchitectPlan: true;
  worktreePolicy: 'per_task';
  integrationPolicy: 'lead_ordered';
  githubMirror: 'off' | 'issues' | 'issues_and_prs';
}

export function buildBeastConfigDraft(input: Partial<BeastConfigDraft> = {}): BeastConfigDraft {
  const defaultDevCount = Number.isInteger(input.defaultDevCount) && input.defaultDevCount! > 0
    ? input.defaultDevCount!
    : 3;
  const requestedMax = Number.isInteger(input.maxParallelDevs) && input.maxParallelDevs! > 0
    ? input.maxParallelDevs!
    : Math.min(3, defaultDevCount);
  return {
    defaultDevCount,
    maxParallelDevs: Math.min(requestedMax, defaultDevCount),
    requireArchitectPlan: true,
    worktreePolicy: 'per_task',
    integrationPolicy: 'lead_ordered',
    githubMirror: input.githubMirror ?? 'off',
  };
}

export function buildBeastMemberDrafts(devCount = 3): BeastMemberDraft[] {
  const count = Number.isInteger(devCount) && devCount > 0 ? devCount : 3;
  const developers = Array.from({ length: count }, (_, index) => ({
    id: index + 2,
    name: `dev-${index + 1}`,
    role: 'developer' as const,
    provider: 'opencode',
    model: 'Default',
    profile: 'Default',
    parallelSlot: index + 1,
  }));
  return [
    { id: 1, name: 'architect', role: 'architect', provider: 'anthropic', model: 'Sonnet 4.6', parallelSlot: null },
    ...developers,
    { id: count + 2, name: 'reviewer', role: 'reviewer', provider: 'anthropic', model: 'Sonnet 4.6', parallelSlot: null },
    { id: count + 3, name: 'tester', role: 'qa', provider: 'gemini', model: 'Default', parallelSlot: null },
  ];
}
```

- [ ] **Step 4: Wire CreateTeamModal mode selector and payload**

Modify `MemberDraft` in `toad-local/ui/src/components/CreateTeamModal.tsx`:

```ts
  profile?: string;
  parallelSlot?: number | null;
```

Import helper:

```ts
import { buildBeastConfigDraft, buildBeastMemberDrafts } from './createTeam/beastTeamDraft';
```

Add state:

```ts
  const [teamMode, setTeamMode] = useState<'standard' | 'beast'>('standard');
  const [beastDevCount, setBeastDevCount] = useState(3);
  const [beastMaxParallel, setBeastMaxParallel] = useState(3);
  const [beastGithubMirror, setBeastGithubMirror] = useState<'off' | 'issues' | 'issues_and_prs'>('off');
```

Add mode selector above Members:

```tsx
          <div className="field">
            <label>Team mode</label>
            <div className="seg">
              <button
                type="button"
                className={teamMode === 'standard' ? 'active' : ''}
                onClick={() => setTeamMode('standard')}
                disabled={inFlight}
              >
                Standard
              </button>
              <button
                type="button"
                className={teamMode === 'beast' ? 'active' : ''}
                onClick={() => {
                  setTeamMode('beast');
                  setSolo(false);
                  setMembers(buildBeastMemberDrafts(beastDevCount));
                  setAdvancedOpen(true);
                }}
                disabled={inFlight}
              >
                Beast
              </button>
            </div>
            <div className="field-hint">Beast Mode preloads lead, architect, parallel developers, reviewer, and tester with architect-plan gating.</div>
          </div>
```

Inside Launch settings collapser, add Beast controls:

```tsx
              {teamMode === 'beast' && (
                <>
                  <div className="field-row">
                    <div className="field">
                      <label>Developer slots</label>
                      <input
                        className="field-input mono"
                        type="number"
                        min={1}
                        max={8}
                        value={beastDevCount}
                        onChange={(e) => {
                          const next = Math.max(1, Math.min(8, Number(e.target.value) || 3));
                          setBeastDevCount(next);
                          setBeastMaxParallel(Math.min(beastMaxParallel, next));
                          setMembers(buildBeastMemberDrafts(next));
                        }}
                        disabled={inFlight}
                      />
                    </div>
                    <div className="field">
                      <label>Max parallel devs</label>
                      <input
                        className="field-input mono"
                        type="number"
                        min={1}
                        max={beastDevCount}
                        value={beastMaxParallel}
                        onChange={(e) => setBeastMaxParallel(Math.max(1, Math.min(beastDevCount, Number(e.target.value) || 1)))}
                        disabled={inFlight}
                      />
                    </div>
                  </div>
                  <div className="field">
                    <label>GitHub mirror</label>
                    <select
                      className="field-input"
                      value={beastGithubMirror}
                      onChange={(e) => setBeastGithubMirror(e.target.value as typeof beastGithubMirror)}
                      disabled={inFlight}
                    >
                      <option value="off">Off</option>
                      <option value="issues">Issues</option>
                      <option value="issues_and_prs">Issues and PRs</option>
                    </select>
                  </div>
                </>
              )}
```

In `handleSubmit`, map UI `qa` role to backend `tester` for the tester member:

```ts
          role: m.role === 'qa' ? 'tester' : m.role,
          model: m.model,
          profile: m.profile,
          ...(typeof m.parallelSlot === 'number' ? { parallelSlot: m.parallelSlot } : {}),
```

In `team_create` args, add:

```ts
          teamMode,
          ...(teamMode === 'beast'
            ? {
                beastConfig: buildBeastConfigDraft({
                  defaultDevCount: beastDevCount,
                  maxParallelDevs: beastMaxParallel,
                  githubMirror: beastGithubMirror,
                }),
              }
            : {}),
```

- [ ] **Step 5: Run UI tests/typecheck and commit**

Run:

```powershell
cd .\toad-local\ui
node --test .\test\beastTeamDraft.test.mjs
npm run typecheck
```

Expected: PASS.

Commit:

```powershell
git add .\toad-local\ui\src\components\createTeam\beastTeamDraft.ts .\toad-local\ui\src\components\CreateTeamModal.tsx .\toad-local\ui\test\beastTeamDraft.test.mjs
git commit -m "feat(ui): add beast mode team preset"
```

## Task 6: Cockpit Beast Mode Surfacing

**Files:**
- Modify: `toad-local/ui/src/hooks/useToadData.ts`
- Modify: `toad-local/ui/src/types/index.ts`
- Modify: `toad-local/ui/src/components/cockpit/CockpitScreenV2.tsx`
- Modify: `toad-local/ui/src/components/cockpit/CockpitForMe.tsx`
- Modify: `toad-local/ui/src/components/cockpit/Inspector.tsx`
- Modify: `toad-local/ui/src/styles/app-shell.css`

- [ ] **Step 1: Add UI type fields**

In `Team`, add:

```ts
  teamMode?: 'standard' | 'beast';
  beastConfig?: {
    defaultDevCount: number;
    maxParallelDevs: number;
    requireArchitectPlan: boolean;
    worktreePolicy: string;
    integrationPolicy: string;
    githubMirror: string;
  } | null;
  beastState?: {
    architectPlan?: { planId: string; slices: unknown[] } | null;
  } | null;
```

- [ ] **Step 2: Map team metadata from API**

In `toad-local/ui/src/hooks/useToadData.ts`, where team config or team list data is normalized, preserve:

```ts
    teamMode: raw.teamMode === 'beast' ? 'beast' : 'standard',
    beastConfig: raw.beastConfig ?? null,
    beastState: raw.beastState ?? null,
```

If this file does not currently receive team config JSON in the active data path, add a small follow-up fetch through `team_list` in the same hook and merge by active team id.

- [ ] **Step 3: Show Cockpit pipeline state**

In `CockpitForMe.tsx`, derive:

```ts
  const isBeastMode = team.teamMode === 'beast';
  const hasArchitectPlan = Boolean(team.beastState?.architectPlan);
  const activeDevCount = team.members.filter((m) => m.role === 'developer' && (m.status === 'live' || m.status === 'thinking')).length;
```

Render near the existing view controls:

```tsx
        {isBeastMode && (
          <div className="beast-pipeline" aria-label="Beast Mode pipeline">
            <span className="beast-badge">Beast Mode</span>
            <span className={hasArchitectPlan ? 'done' : 'active'}>Architect planning</span>
            <span className={hasArchitectPlan ? 'active' : ''}>Tasks scoped</span>
            <span>{activeDevCount} devs running</span>
            <span>Review</span>
            <span>Validation</span>
            <span>Integrating</span>
          </div>
        )}
```

- [ ] **Step 4: Show task metadata in Inspector**

In `Inspector.tsx`, inside the task tab detail, add rows when values exist:

```tsx
        {task.workSliceId && <DetailRow label="Slice" value={task.workSliceId} />}
        {typeof task.mergeOrder === 'number' && <DetailRow label="Merge order" value={String(task.mergeOrder)} />}
        {task.conflictRisk && <DetailRow label="Conflict risk" value={task.conflictRisk} />}
        {task.worktree?.path && <DetailRow label="Worktree" value={task.worktree.path} />}
        {Array.isArray(task.allowedFiles) && task.allowedFiles.length > 0 && (
          <DetailRow label="Allowed paths" value={task.allowedFiles.join(', ')} />
        )}
```

- [ ] **Step 5: Add focused CSS**

Append to `toad-local/ui/src/styles/app-shell.css`:

```css
.beast-pipeline {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border-soft);
  background: var(--bg-1);
  color: var(--fg-muted);
  font-size: 11.5px;
  overflow-x: auto;
}

.beast-pipeline span {
  white-space: nowrap;
}

.beast-pipeline .beast-badge {
  color: var(--accent);
  font-weight: 700;
}

.beast-pipeline .active {
  color: var(--fg);
}

.beast-pipeline .done {
  color: var(--ok);
}
```

- [ ] **Step 6: Verify and commit**

Run:

```powershell
cd .\toad-local\ui
npm run typecheck
npm run build
```

Expected: PASS.

Commit:

```powershell
git add .\toad-local\ui\src\hooks\useToadData.ts .\toad-local\ui\src\types\index.ts .\toad-local\ui\src\components\cockpit\CockpitScreenV2.tsx .\toad-local\ui\src\components\cockpit\CockpitForMe.tsx .\toad-local\ui\src\components\cockpit\Inspector.tsx .\toad-local\ui\src\styles\app-shell.css
git commit -m "feat(cockpit): surface beast mode state"
```

## Task 7: Full Verification

**Files:**
- No source edits unless verification exposes a bug.

- [ ] **Step 1: Run backend targeted tests**

Run:

```powershell
node --test .\toad-local\test\beastMode.test.js .\toad-local\test\beastArchitectPlan.test.js .\toad-local\test\teamConfig.test.js .\toad-local\test\teamSystemPrompts.test.js .\toad-local\test\localToolFacade.test.js
```

Expected: PASS.

- [ ] **Step 2: Run UI targeted tests and build**

Run:

```powershell
cd .\toad-local\ui
node --test .\test\beastTeamDraft.test.mjs
npm run typecheck
npm run build
```

Expected: PASS.

- [ ] **Step 3: Run whitespace check**

Run:

```powershell
cd C:\Project-TOAD
git diff --check
```

Expected: no output.

- [ ] **Step 4: Manual smoke through desktop**

Start app with:

```powershell
.\start-desktop.bat
```

Smoke path:

1. Open Create Team.
2. Switch `Team mode` to `Beast`.
3. Confirm roster is lead, architect, dev-1, dev-2, dev-3, reviewer, tester.
4. Change dev count to 4 and verify dev-4 appears.
5. Change a dev provider/model/profile and verify payload survives create.
6. Create Beast team with `Run after create`.
7. Confirm only lead and architect launch before architect plan exists.
8. Record an architect plan through the tool/API.
9. Resume launch and confirm developer agents can launch.
10. Create a task from the plan and confirm Inspector shows slice/worktree/scope metadata.

- [ ] **Step 5: Commit verification-only fixes if needed**

If any verification fix is required:

```powershell
git add <only-fixed-files>
git commit -m "fix(beast): address verification findings"
```

If no fixes are required, do not create an empty commit.

## Self-Review

Spec coverage:

- Fixed default plus editable team: Task 1 and Task 5.
- OpenCode as bridge provider/profile: Task 1 and Task 5.
- Architect required before dev work: Task 2 and Task 4.
- One task, one dev, one worktree: Task 3 captures slice metadata; existing worktree-per-task behavior is reused; Task 4 prevents early dev launch.
- Scoped writes: Task 3 stores allowed/forbidden scope; existing review file contract enforces changed files.
- Review/test/merge visibility: existing lifecycle remains; Task 6 surfaces key metadata.
- GitHub mirroring setting: Task 1 and Task 5 store setting only; full sync remains deferred per design.

Placeholder scan:

- No implementation step relies on unspecified names. All new files, command names, exported functions, and test commands are listed.

Type consistency:

- Backend uses `teamMode`, `beastConfig`, `beastState.architectPlan`, `workSliceId`, `architectPlanId`, `mergeOrder`, `conflictRisk`, and `preferredAgent`.
- UI uses the same team/task property names, with only the existing UI role alias `qa` mapped to backend role `tester` at submit time.
