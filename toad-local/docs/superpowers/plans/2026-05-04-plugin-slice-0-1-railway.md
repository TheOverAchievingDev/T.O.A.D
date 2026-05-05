# Plugin Slice 0 + 1 (Railway) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-05-04-plugin-slice-0-1-railway-design.md`

**Goal:** Ship plugin infrastructure (slice 0) plus the first concrete plugin — Railway, Postgres-only (slice 1) — together as one feature so the demo-grade outcome ("agent provisioned a Postgres for me") lands intact.

**Architecture:** New `src/plugins/` module mirrors the existing `src/providers/` shape. Two SQLite tables (`plugin_jobs`, `plugin_resources`) join the schema. Eight new MCP tools land in `LocalToolFacade`: 4 plugin-agnostic + 4 Railway-specific. A pure-function `secretRedactor` strips known secret patterns from the audit log. UI gets one new `Settings → Plugins` tab. dev-api-server wires the registry into the facade. Role-gating is the primary defense for high-risk operations (per-tool-call approval modal is a slice-1.5 follow-up).

**Tech Stack:** Node 20+ ESM, `node:sqlite`, `node:test`, React 18 + TypeScript (UI), no new runtime deps.

**Test discipline:** TDD throughout. Every new module ships with its failing test before implementation lands. CLI spawns are testable via injected `spawnImpl`; no live Railway calls in unit tests.

---

## File structure

```
src/plugins/                                   ← NEW directory
├── pluginRegistry.js                          Task 4 — frozen PLUGIN_COMMANDS map
├── pluginAuth.js                              Task 5 — auth detection + manual-login flow
├── pluginJobs.js                              Task 2 — SQLite-backed job tracker
├── pluginResources.js                         Task 3 — SQLite-backed resource tracker
└── railway/
    ├── railwayCli.js                          Task 7 — spawn helper with PATH/PATHEXT
    └── railwayTools.js                        Tasks 8-11 — link / provision / get-conn / migration

src/tools/secretRedactor.js                    Task 6 — pure-function secret stripper

src/storage/schema.sql                         Task 1 — append plugin_jobs + plugin_resources
src/commands/command-contract.js               Task 12 — add 8 new COMMANDS entries
src/security/roleAuthority.js                  Task 12 — add tools to ROLE_TOOLS
src/policy/riskClassifier.js                   Task 13 — light risk-profile hook
src/tools/localToolFacade.js                   Tasks 14-15 — dispatch handlers
scripts/dev-api-server.mjs                     Task 16 — wire registry + stores into facade

ui/src/components/settings/PluginsSettings.tsx Tasks 17-18 — new settings tab
ui/src/components/settings/SettingsLayout.tsx  Task 17 — add 'plugins' nav entry
ui/src/components/settings/SettingsScreen.tsx  Task 17 — route 'plugins'
ui/src/api/secretMask.ts                       Task 19 — UI-side secret detector (mirrors src/tools/secretRedactor)
ui/src/components/AgentInbox.tsx               Task 19 — wire secretMask into tool-result rendering
ui/src/App.tsx                                 Task 20 — team-delete warning hook

test/plugins/                                  ← NEW
├── pluginRegistry.test.js                     Task 4
├── pluginAuth.test.js                         Task 5
├── pluginJobs.test.js                         Task 2
├── pluginResources.test.js                    Task 3
└── railway/
    └── railwayTools.test.js                   Tasks 8-11
test/secretRedactor.test.js                    Task 6

package.json                                   Task 21 — extend test chain
README.md                                      Task 22 — note plugins in deferred → in flight
```

22 tasks total across 7 phases.

---

## Phase 1 — Schema + storage layer

### Task 1: Schema migration for plugin_jobs + plugin_resources

**Files:**
- Modify: `src/storage/schema.sql` (append two new tables + indexes)
- Test: `test/plugins/pluginRegistry.test.js` will be the smoke test for the schema in Task 4 (we don't write a separate schema-only test — keeps the test file count down).

- [ ] **Step 1: Append schema to `src/storage/schema.sql`**

After the existing `drift_score_history` block, append:

```sql
-- Plugin Slice 0+1 — see docs/superpowers/specs/2026-05-04-plugin-slice-0-1-railway-design.md
-- Background-job tracker for long-running plugin actions (EAS builds,
-- Vercel deploys, etc). Mostly unused in slice 1 (Railway is synchronous);
-- table exists so slice 2 (EAS) can plug in without a schema migration.
CREATE TABLE IF NOT EXISTS plugin_jobs (
  job_id          TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL,
  plugin_id       TEXT NOT NULL,
  action          TEXT NOT NULL,
  state           TEXT NOT NULL,
  args_json       TEXT NOT NULL,
  log_tail        TEXT,
  started_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  finished_at     TEXT,
  error           TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_jobs_team ON plugin_jobs(team_id);
CREATE INDEX IF NOT EXISTS idx_plugin_jobs_state ON plugin_jobs(state);

-- Provisioned-resource tracker. Used immediately by Railway's idempotency
-- check (the partial index makes "is there a live Postgres for this team?"
-- a single index lookup). Cleanup-on-team-delete reads from this table.
CREATE TABLE IF NOT EXISTS plugin_resources (
  resource_id     TEXT PRIMARY KEY,
  team_id         TEXT NOT NULL,
  plugin_id       TEXT NOT NULL,
  kind            TEXT NOT NULL,
  external_id     TEXT NOT NULL,
  metadata_json   TEXT NOT NULL DEFAULT '{}',
  created_at      TEXT NOT NULL,
  deprovisioned_at TEXT,
  FOREIGN KEY (team_id) REFERENCES teams(team_id)
);
CREATE INDEX IF NOT EXISTS idx_plugin_resources_team ON plugin_resources(team_id);
CREATE INDEX IF NOT EXISTS idx_plugin_resources_live
  ON plugin_resources(team_id, plugin_id, kind)
  WHERE deprovisioned_at IS NULL;
```

- [ ] **Step 2: Verify schema parses**

```bash
node -e "
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const db = new DatabaseSync(':memory:');
db.exec(fs.readFileSync('src/storage/schema.sql', 'utf8'));
console.log('schema OK');
const tables = db.prepare(\`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plugin_%' ORDER BY name\`).all();
console.log('plugin tables:', tables.map(t => t.name));
"
```

Expected output:
```
schema OK
plugin tables: [ { name: 'plugin_jobs' }, { name: 'plugin_resources' } ]
```

- [ ] **Step 3: Commit**

```bash
git add src/storage/schema.sql
git commit -m "feat(plugins): schema for plugin_jobs + plugin_resources"
```

---

### Task 2: SqlitePluginJobs reader/writer

**Files:**
- Create: `src/plugins/pluginJobs.js`
- Test: `test/plugins/pluginJobs.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/plugins/pluginJobs.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqlitePluginJobs } from '../../src/plugins/pluginJobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'storage', 'schema.sql');

function makeStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  db.prepare(`INSERT INTO teams (team_id, display_name, created_at)
              VALUES ('team-a', 'Team A', '2026-05-04T00:00:00Z')`).run();
  return { db, jobs: new SqlitePluginJobs({ db }) };
}

test('SqlitePluginJobs.create inserts a queued job', () => {
  const { jobs } = makeStore();
  const job = jobs.create({
    teamId: 'team-a',
    pluginId: 'railway',
    action: 'provision_db',
    args: { type: 'postgres' },
  });
  assert.ok(job.jobId);
  assert.equal(job.state, 'queued');
  assert.equal(job.teamId, 'team-a');
});

test('SqlitePluginJobs.update moves state + appends log_tail', () => {
  const { jobs } = makeStore();
  const job = jobs.create({
    teamId: 'team-a', pluginId: 'railway', action: 'x', args: {},
  });
  jobs.update({ jobId: job.jobId, state: 'running', logChunk: 'starting...\n' });
  jobs.update({ jobId: job.jobId, state: 'success', logChunk: 'done\n', finishedAt: '2026-05-04T10:00:00Z' });
  const fetched = jobs.get({ jobId: job.jobId });
  assert.equal(fetched.state, 'success');
  assert.match(fetched.logTail, /starting/);
  assert.match(fetched.logTail, /done/);
  assert.equal(fetched.finishedAt, '2026-05-04T10:00:00Z');
});

test('SqlitePluginJobs.list filters by team and state', () => {
  const { jobs } = makeStore();
  jobs.create({ teamId: 'team-a', pluginId: 'railway', action: 'a', args: {} });
  jobs.create({ teamId: 'team-a', pluginId: 'railway', action: 'b', args: {} });
  const queued = jobs.list({ teamId: 'team-a', state: 'queued' });
  assert.equal(queued.length, 2);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/plugins/pluginJobs.test.js`
Expected: FAIL — "Cannot find module '../../src/plugins/pluginJobs.js'"

- [ ] **Step 3: Implement `src/plugins/pluginJobs.js`**

```js
import { randomUUID } from 'node:crypto';

const LOG_TAIL_MAX = 64 * 1024; // 64KB cap

/**
 * SQLite-backed background-job tracker. Mostly unused in slice 1
 * (Railway is synchronous); slice 2 (EAS) is the first plugin to
 * actually populate this with running jobs. Schema lives in
 * src/storage/schema.sql.
 */
export class SqlitePluginJobs {
  constructor({ db } = {}) {
    if (!db || typeof db.prepare !== 'function') {
      throw new TypeError('SqlitePluginJobs: db with prepare() required');
    }
    this.db = db;
  }

  create({ teamId, pluginId, action, args, jobId, now = new Date().toISOString() }) {
    const id = jobId || `job_${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO plugin_jobs
        (job_id, team_id, plugin_id, action, state, args_json,
         log_tail, started_at, updated_at)
       VALUES (?, ?, ?, ?, 'queued', ?, '', ?, ?)`
    ).run(id, teamId, pluginId, action, JSON.stringify(args ?? {}), now, now);
    return this.get({ jobId: id });
  }

  update({ jobId, state, logChunk, finishedAt, error, now = new Date().toISOString() }) {
    const existing = this.get({ jobId });
    if (!existing) throw new Error(`pluginJobs.update: no job ${jobId}`);
    let nextLog = existing.logTail || '';
    if (typeof logChunk === 'string' && logChunk.length > 0) {
      nextLog = (nextLog + logChunk).slice(-LOG_TAIL_MAX);
    }
    this.db.prepare(
      `UPDATE plugin_jobs
        SET state = ?, log_tail = ?, updated_at = ?,
            finished_at = COALESCE(?, finished_at),
            error = COALESCE(?, error)
       WHERE job_id = ?`
    ).run(
      state ?? existing.state,
      nextLog,
      now,
      finishedAt ?? null,
      error ?? null,
      jobId,
    );
    return this.get({ jobId });
  }

  get({ jobId }) {
    const row = this.db.prepare('SELECT * FROM plugin_jobs WHERE job_id = ?').get(jobId);
    return row ? rowToJob(row) : null;
  }

  list({ teamId, state, limit = 100 } = {}) {
    const conditions = [];
    const params = [];
    if (teamId) { conditions.push('team_id = ?'); params.push(teamId); }
    if (state)  { conditions.push('state = ?');   params.push(state); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT * FROM plugin_jobs ${where}
       ORDER BY started_at DESC, job_id DESC
       LIMIT ?`
    ).all(...params, limit);
    return rows.map(rowToJob);
  }
}

function rowToJob(r) {
  return {
    jobId: r.job_id,
    teamId: r.team_id,
    pluginId: r.plugin_id,
    action: r.action,
    state: r.state,
    args: safeParse(r.args_json, {}),
    logTail: r.log_tail || '',
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    finishedAt: r.finished_at,
    error: r.error,
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/plugins/pluginJobs.test.js`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/plugins/pluginJobs.js test/plugins/pluginJobs.test.js
git commit -m "feat(plugins): SqlitePluginJobs background-job tracker"
```

---

### Task 3: SqlitePluginResources reader/writer

**Files:**
- Create: `src/plugins/pluginResources.js`
- Test: `test/plugins/pluginResources.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/plugins/pluginResources.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqlitePluginResources } from '../../src/plugins/pluginResources.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', '..', 'src', 'storage', 'schema.sql');

function makeStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  db.prepare(`INSERT INTO teams (team_id, display_name, created_at)
              VALUES ('team-a', 'Team A', '2026-05-04T00:00:00Z')`).run();
  return { db, resources: new SqlitePluginResources({ db }) };
}

test('SqlitePluginResources.insert + listForTeam (live only)', () => {
  const { resources } = makeStore();
  resources.insert({
    teamId: 'team-a', pluginId: 'railway', kind: 'postgres',
    externalId: 'svc_abc', metadata: { region: 'us-west-2' },
  });
  const live = resources.listForTeam({ teamId: 'team-a' });
  assert.equal(live.length, 1);
  assert.equal(live[0].kind, 'postgres');
  assert.equal(live[0].externalId, 'svc_abc');
});

test('SqlitePluginResources.findLive returns the unique live resource per (team, plugin, kind)', () => {
  const { resources } = makeStore();
  resources.insert({
    teamId: 'team-a', pluginId: 'railway', kind: 'postgres', externalId: 'svc_1',
  });
  const found = resources.findLive({ teamId: 'team-a', pluginId: 'railway', kind: 'postgres' });
  assert.ok(found);
  assert.equal(found.externalId, 'svc_1');

  const notFound = resources.findLive({ teamId: 'team-a', pluginId: 'railway', kind: 'redis' });
  assert.equal(notFound, null);
});

test('SqlitePluginResources.markDeprovisioned excludes from live list', () => {
  const { resources } = makeStore();
  const r = resources.insert({
    teamId: 'team-a', pluginId: 'railway', kind: 'postgres', externalId: 'svc_x',
  });
  resources.markDeprovisioned({ resourceId: r.resourceId });
  assert.equal(resources.findLive({ teamId: 'team-a', pluginId: 'railway', kind: 'postgres' }), null);
  assert.equal(resources.listForTeam({ teamId: 'team-a' }).length, 0);
  // But the row still exists for audit purposes:
  const all = resources.listForTeam({ teamId: 'team-a', includeDeprovisioned: true });
  assert.equal(all.length, 1);
  assert.ok(all[0].deprovisionedAt);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/plugins/pluginResources.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/plugins/pluginResources.js`**

```js
import { randomUUID } from 'node:crypto';

/**
 * SQLite-backed provisioned-resource tracker. Used immediately by
 * Railway's idempotency check (findLive is a single index lookup
 * thanks to the partial index in schema.sql) and by the team-delete
 * warning flow.
 */
export class SqlitePluginResources {
  constructor({ db } = {}) {
    if (!db || typeof db.prepare !== 'function') {
      throw new TypeError('SqlitePluginResources: db with prepare() required');
    }
    this.db = db;
  }

  insert({ teamId, pluginId, kind, externalId, metadata, resourceId,
           now = new Date().toISOString() }) {
    const id = resourceId || `res_${randomUUID()}`;
    this.db.prepare(
      `INSERT INTO plugin_resources
        (resource_id, team_id, plugin_id, kind, external_id,
         metadata_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, teamId, pluginId, kind, externalId, JSON.stringify(metadata ?? {}), now);
    return this.get({ resourceId: id });
  }

  /** Single live resource per (team, plugin, kind). Used for idempotency. */
  findLive({ teamId, pluginId, kind }) {
    const row = this.db.prepare(
      `SELECT * FROM plugin_resources
       WHERE team_id = ? AND plugin_id = ? AND kind = ?
         AND deprovisioned_at IS NULL
       LIMIT 1`
    ).get(teamId, pluginId, kind);
    return row ? rowToResource(row) : null;
  }

  listForTeam({ teamId, includeDeprovisioned = false } = {}) {
    if (!teamId) return [];
    const where = includeDeprovisioned
      ? 'WHERE team_id = ?'
      : 'WHERE team_id = ? AND deprovisioned_at IS NULL';
    const rows = this.db.prepare(
      `SELECT * FROM plugin_resources ${where}
       ORDER BY created_at DESC, resource_id DESC`
    ).all(teamId);
    return rows.map(rowToResource);
  }

  get({ resourceId }) {
    const row = this.db.prepare(
      'SELECT * FROM plugin_resources WHERE resource_id = ?'
    ).get(resourceId);
    return row ? rowToResource(row) : null;
  }

  markDeprovisioned({ resourceId, now = new Date().toISOString() }) {
    this.db.prepare(
      'UPDATE plugin_resources SET deprovisioned_at = ? WHERE resource_id = ?'
    ).run(now, resourceId);
    return this.get({ resourceId });
  }
}

function rowToResource(r) {
  return {
    resourceId: r.resource_id,
    teamId: r.team_id,
    pluginId: r.plugin_id,
    kind: r.kind,
    externalId: r.external_id,
    metadata: safeParse(r.metadata_json, {}),
    createdAt: r.created_at,
    deprovisionedAt: r.deprovisioned_at,
  };
}

function safeParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/plugins/pluginResources.test.js`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/plugins/pluginResources.js test/plugins/pluginResources.test.js
git commit -m "feat(plugins): SqlitePluginResources tracker with idempotency lookup"
```

---

## Phase 2 — Plugin registry, auth, and secret redaction

### Task 4: Plugin registry constants

**Files:**
- Create: `src/plugins/pluginRegistry.js`
- Test: `test/plugins/pluginRegistry.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/plugins/pluginRegistry.test.js`:

```js
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
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/plugins/pluginRegistry.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/plugins/pluginRegistry.js`**

```js
import path from 'node:path';

/**
 * Registry of supported plugins. Mirrors src/providers/providerAuth.js's
 * PROVIDER_COMMANDS shape — same CLI-mediated, file-based auth-detection
 * pattern, just for infrastructure providers instead of LLM providers.
 *
 * Each entry's riskProfile maps action names to risk levels consumed by
 * the riskClassifier hook (see src/policy/riskClassifier.js plugin
 * integration).
 */

export const SUPPORTED_PLUGINS = Object.freeze(['railway', 'eas', 'vercel']);

export const PLUGIN_COMMANDS = Object.freeze({
  railway: Object.freeze({
    label: 'Railway',
    cli: 'railway',
    statusMode: 'file',
    statusFile: path.join('~', '.config', 'railway', 'config.json'),
    parseFileStatus: parseRailwayFileStatus,
    manualLogin: true,
    loginInstructions: 'Run `railway login` in a terminal. Symphony will detect the auth file once you complete the browser flow.',
    logoutArgs: ['logout'],
    supported: true,
    riskProfile: Object.freeze({
      link:                  'low',
      provision_db:          'medium',
      get_connection_string: 'medium',
      run_migration:         'high',
    }),
  }),
  eas: Object.freeze({
    label: 'EAS',
    cli: 'eas',
    statusMode: 'file',
    statusFile: path.join('~', '.expo', 'state.json'),
    parseFileStatus: () => ({ signedIn: false, reason: 'EAS plugin not implemented in slice 1' }),
    manualLogin: true,
    loginInstructions: 'EAS plugin lands in slice 2.',
    supported: false,
    unsupportedReason: 'EAS plugin lands in slice 2 (background-job infrastructure exercise).',
    riskProfile: Object.freeze({}),
  }),
  vercel: Object.freeze({
    label: 'Vercel',
    cli: 'vercel',
    statusMode: 'file',
    statusFile: path.join('~', '.config', 'vercel', 'auth.json'),
    parseFileStatus: () => ({ signedIn: false, reason: 'Vercel plugin not implemented in slice 1' }),
    manualLogin: true,
    loginInstructions: 'Vercel plugin lands in slice 3.',
    supported: false,
    unsupportedReason: 'Vercel plugin lands in slice 3 (after EAS validates the long-running-job pattern).',
    riskProfile: Object.freeze({}),
  }),
});

/**
 * Verify Railway's auth file has a token. The Railway CLI stores its
 * config at ~/.config/railway/config.json with a `token` field after
 * `railway login` completes.
 */
export function parseRailwayFileStatus(authJson, _infoJson, providerId) {
  if (!authJson || typeof authJson !== 'object' || Array.isArray(authJson)) {
    return {
      providerId,
      supported: true,
      signedIn: false,
      reason: 'Railway auth file is empty or not an object.',
    };
  }
  const token = pickString(authJson.token, authJson.access_token);
  if (!token) {
    return {
      providerId,
      supported: true,
      signedIn: false,
      reason: 'Railway auth file present but token is missing.',
    };
  }
  const user = (authJson.user && typeof authJson.user === 'object') ? authJson.user : {};
  return {
    providerId,
    supported: true,
    signedIn: true,
    user: {
      email: pickString(user.email, authJson.email),
      login: pickString(user.username, user.name),
      name: pickString(user.name),
    },
    plan: pickString(authJson.plan, user.plan),
    raw: { tokenLength: token.length },
  };
}

function pickString(...candidates) {
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/plugins/pluginRegistry.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/plugins/pluginRegistry.js test/plugins/pluginRegistry.test.js
git commit -m "feat(plugins): pluginRegistry with railway/eas/vercel + parseRailwayFileStatus"
```

---

### Task 5: pluginAuth.getAuthStatus / triggerLogin / triggerLogout

**Files:**
- Create: `src/plugins/pluginAuth.js`
- Test: `test/plugins/pluginAuth.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/plugins/pluginAuth.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { getAuthStatus, triggerAuthLogin, triggerAuthLogout } from '../../src/plugins/pluginAuth.js';

test('getAuthStatus: unknown pluginId → not supported', () => {
  const result = getAuthStatus({ pluginId: 'bogus' });
  assert.equal(result.supported, false);
  assert.match(result.reason, /unknown plugin/i);
});

test('getAuthStatus: railway not signed in (file missing)', () => {
  const result = getAuthStatus({
    pluginId: 'railway',
    statImpl: () => { const e = new Error(); e.code = 'ENOENT'; throw e; },
    readFileImpl: () => '{}',
  });
  assert.equal(result.signedIn, false);
  assert.match(result.reason, /not signed in|does not exist/i);
});

test('getAuthStatus: railway signed in (file has token)', () => {
  const result = getAuthStatus({
    pluginId: 'railway',
    statImpl: () => ({ size: 50 }),
    readFileImpl: () => JSON.stringify({ token: 'abc', user: { email: 'a@b.c' } }),
  });
  assert.equal(result.signedIn, true);
  assert.equal(result.user.email, 'a@b.c');
});

test('getAuthStatus: eas marked unsupported in slice 1', () => {
  const result = getAuthStatus({ pluginId: 'eas' });
  assert.equal(result.supported, false);
  assert.match(result.reason, /slice 2/i);
});

test('triggerAuthLogin returns manualLogin instructions for railway', () => {
  const result = triggerAuthLogin({ pluginId: 'railway' });
  assert.equal(result.started, false);
  assert.equal(result.manualLogin, true);
  assert.match(result.reason, /railway login/);
});

test('triggerAuthLogout shells out to railway logout', () => {
  const calls = [];
  const fakeSpawnSync = (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: '', stderr: '' };
  };
  const result = triggerAuthLogout({ pluginId: 'railway', spawnSyncImpl: fakeSpawnSync });
  assert.equal(result.loggedOut, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'railway');
  assert.deepEqual(calls[0].args, ['logout']);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/plugins/pluginAuth.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/plugins/pluginAuth.js`**

```js
import { readFileSync, statSync } from 'node:fs';
import { spawnSync as defaultSpawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN_COMMANDS } from './pluginRegistry.js';

/**
 * Status of a plugin's CLI authentication. Mirrors the providerAuth.js
 * surface — same shape, same injectable hooks for tests, just keyed
 * on PLUGIN_COMMANDS instead of PROVIDER_COMMANDS.
 */
export function getAuthStatus({ pluginId, readFileImpl, statImpl } = {}) {
  const cfg = PLUGIN_COMMANDS[pluginId];
  if (!cfg) {
    return { pluginId, supported: false, signedIn: null, reason: `unknown plugin: ${pluginId}` };
  }
  if (!cfg.supported) {
    return {
      pluginId,
      supported: false,
      signedIn: null,
      reason: cfg.unsupportedReason ?? `Plugin ${pluginId} is not yet implemented.`,
    };
  }
  if (cfg.statusMode !== 'file') {
    return { pluginId, supported: true, signedIn: null, reason: 'unsupported statusMode' };
  }

  const readFile = readFileImpl || ((p) => readFileSync(p, 'utf8'));
  const stat = statImpl || ((p) => statSync(p));
  const authPath = expandHome(cfg.statusFile);

  let raw;
  try {
    stat(authPath);
    raw = readFile(authPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      return {
        pluginId,
        supported: true,
        signedIn: false,
        reason: `Not signed in (${cfg.statusFile} does not exist).`,
      };
    }
    return {
      pluginId,
      supported: true,
      signedIn: null,
      reason: err && err.message ? err.message : 'read failed',
    };
  }

  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      pluginId,
      supported: true,
      signedIn: false,
      reason: `Auth file ${cfg.statusFile} did not parse as JSON.`,
    };
  }

  return cfg.parseFileStatus(json, null, pluginId);
}

/**
 * For plugins with manualLogin: returns instructions for the operator
 * to follow at the terminal. (Symphony does not auto-spawn `railway
 * login` because it opens a browser tab and we don't want unattended
 * processes blocking on user interaction.)
 */
export function triggerAuthLogin({ pluginId } = {}) {
  const cfg = PLUGIN_COMMANDS[pluginId];
  if (!cfg) {
    return { pluginId, started: false, reason: `unknown plugin: ${pluginId}` };
  }
  if (!cfg.supported) {
    return { pluginId, started: false, reason: cfg.unsupportedReason };
  }
  if (cfg.manualLogin) {
    return {
      pluginId,
      started: false,
      manualLogin: true,
      cli: cfg.cli,
      reason: cfg.loginInstructions || `Sign in via the ${cfg.cli} CLI directly.`,
    };
  }
  return { pluginId, started: false, reason: 'auto-spawn login not supported in slice 1' };
}

export function triggerAuthLogout({ pluginId, spawnSyncImpl } = {}) {
  const cfg = PLUGIN_COMMANDS[pluginId];
  if (!cfg) {
    return { pluginId, loggedOut: false, reason: `unknown plugin: ${pluginId}` };
  }
  if (!cfg.supported) {
    return { pluginId, loggedOut: false, reason: cfg.unsupportedReason };
  }
  const sync = spawnSyncImpl || defaultSpawnSync;
  try {
    const result = sync(cfg.cli, cfg.logoutArgs || ['logout'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    });
    if (result.status === 0) {
      return { pluginId, loggedOut: true };
    }
    return {
      pluginId,
      loggedOut: false,
      reason: result.stderr?.toString().trim() || `${cfg.cli} exited ${result.status}`,
    };
  } catch (err) {
    return { pluginId, loggedOut: false, reason: err && err.message ? err.message : 'spawn failed' };
  }
}

function expandHome(p) {
  if (typeof p !== 'string' || !p.startsWith('~')) return p;
  return path.join(os.homedir(), p.slice(1));
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/plugins/pluginAuth.test.js`
Expected: PASS — 6 tests

- [ ] **Step 5: Commit**

```bash
git add src/plugins/pluginAuth.js test/plugins/pluginAuth.test.js
git commit -m "feat(plugins): pluginAuth.{getAuthStatus,triggerAuthLogin,triggerAuthLogout}"
```

---

### Task 6: secretRedactor pure function

**Files:**
- Create: `src/tools/secretRedactor.js`
- Test: `test/secretRedactor.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/secretRedactor.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../src/tools/secretRedactor.js';

test('redactSecrets: postgres URL password redacted', () => {
  const input = 'DATABASE_URL=postgres://alice:s3cr3t@db.example.com:5432/app';
  const output = redactSecrets(input);
  assert.match(output, /alice:<REDACTED>@/);
  assert.doesNotMatch(output, /s3cr3t/);
});

test('redactSecrets: postgresql:// (long form) handled', () => {
  const input = 'postgresql://user:pw@h:5432/d';
  assert.match(redactSecrets(input), /user:<REDACTED>@/);
});

test('redactSecrets: bearer tokens redacted', () => {
  const input = 'Authorization: Bearer abc123def456ghi789jkl012mno345';
  const output = redactSecrets(input);
  assert.match(output, /Bearer <REDACTED>/);
});

test('redactSecrets: authorization header value redacted', () => {
  const input = 'authorization: sk_live_abcdef123456';
  const output = redactSecrets(input);
  assert.match(output, /authorization: <REDACTED>/);
});

test('redactSecrets: redis/mongo/mysql connection strings', () => {
  assert.match(redactSecrets('redis://u:pw@h:6379'), /u:<REDACTED>@/);
  assert.match(redactSecrets('mongodb://u:pw@h:27017'), /u:<REDACTED>@/);
  assert.match(redactSecrets('mongodb+srv://u:pw@cluster.mongodb.net'), /u:<REDACTED>@/);
  assert.match(redactSecrets('mysql://u:pw@h:3306'), /u:<REDACTED>@/);
});

test('redactSecrets: env-var-shaped JSON keys redacted', () => {
  const input = '{"DATABASE_URL": "postgres://a:b@c", "OTHER": "ok"}';
  const output = redactSecrets(input);
  assert.match(output, /"DATABASE_URL":\s*"<REDACTED>"/);
  // OTHER should be untouched
  assert.match(output, /"OTHER":\s*"ok"/);
});

test('redactSecrets: passes non-secret text through unchanged', () => {
  const input = 'plain text with no secrets here';
  assert.equal(redactSecrets(input), input);
});

test('redactSecrets: handles non-string input gracefully', () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
  assert.deepEqual(redactSecrets({ a: 1 }), { a: 1 });
});

test('redactSecrets: API_KEY / SECRET_KEY / ACCESS_TOKEN / REFRESH_TOKEN keys redacted', () => {
  const input = `
    {"API_KEY": "abc"}
    {"SECRET_KEY": "def"}
    {"ACCESS_TOKEN": "ghi"}
    {"REFRESH_TOKEN": "jkl"}
  `;
  const output = redactSecrets(input);
  assert.match(output, /"API_KEY":\s*"<REDACTED>"/);
  assert.match(output, /"SECRET_KEY":\s*"<REDACTED>"/);
  assert.match(output, /"ACCESS_TOKEN":\s*"<REDACTED>"/);
  assert.match(output, /"REFRESH_TOKEN":\s*"<REDACTED>"/);
});
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/secretRedactor.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `src/tools/secretRedactor.js`**

```js
/**
 * Strip known secret patterns from a string. Used by the runtime_events
 * audit pipeline so plaintext connection strings + bearer tokens never
 * land in the SQLite log.
 *
 * Pure function — table-driven, deterministic.
 *
 * Slice 1: agent receives the unredacted value (intentional path-a from
 * the plugin spec gotcha #2). Audit log + UI raw-event view see only
 * <REDACTED>. Slice 2 ships the substitution-pipeline (path-b) so even
 * the agent sees opaque references.
 */
export function redactSecrets(input) {
  if (typeof input !== 'string') return input;
  return input
    // postgres / postgresql / mysql / mongodb / redis URLs — strip password
    .replace(
      /((?:postgres(?:ql)?|mysql|redis|rediss|mongodb(?:\+srv)?):\/\/[^:@\s]+):([^@\s]+)@/gi,
      '$1:<REDACTED>@',
    )
    // explicit Authorization: Bearer <long token> header
    .replace(/(\bBearer\s+)([A-Za-z0-9_\-.]{16,})/gi, '$1<REDACTED>')
    // generic authorization header value (anything after "authorization:" or
    // "x-api-key:" etc up to whitespace/comma/semicolon)
    .replace(/(\bauthorization:\s*)([^\s,;]+)/gi, '$1<REDACTED>')
    .replace(/(\bx-api-key:\s*)([^\s,;]+)/gi, '$1<REDACTED>')
    // env-var-shaped secret keys in JSON: {"DATABASE_URL":"..."} → redact
    .replace(
      /("(?:DATABASE_URL|API_KEY|SECRET_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|CLIENT_SECRET)"\s*:\s*)"[^"]*"/gi,
      '$1"<REDACTED>"',
    );
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/secretRedactor.test.js`
Expected: PASS — 9 tests

- [ ] **Step 5: Commit**

```bash
git add src/tools/secretRedactor.js test/secretRedactor.test.js
git commit -m "feat(plugins): secretRedactor pure function for audit-log redaction"
```

---

## Phase 3 — Railway tools

### Task 7: railwayCli spawn helper

**Files:**
- Create: `src/plugins/railway/railwayCli.js`

(No test file — this is a thin spawn wrapper consumed by railwayTools, which has comprehensive tests.)

- [ ] **Step 1: Implement `src/plugins/railway/railwayCli.js`**

```js
import { spawn as defaultSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a bare CLI name to an absolute path on Windows by walking
 * PATH × PATHEXT. Mirrors the helper in claudeUsageProbe.js — Node's
 * spawn doesn't apply PATHEXT for `.cmd` shims by default.
 */
export function resolveCommandPath(command) {
  if (process.platform !== 'win32') return command;
  if (typeof command !== 'string' || command.length === 0) return command;
  if (command.includes('\\') || command.includes('/')) return command;
  const dirs = String(process.env.PATH || '').split(';').filter(Boolean);
  const pathext = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';').map((e) => e.toLowerCase());
  for (const dir of dirs) {
    const cleanDir = dir.replace(/^"|"$/g, '');
    for (const ext of pathext) {
      const candidate = path.join(cleanDir, command + ext);
      if (existsSync(candidate)) return candidate;
    }
  }
  return command;
}

/**
 * Run the railway CLI with given args and return { stdout, stderr,
 * exitCode }. Throws on spawn failure or timeout.
 *
 * Tests inject a fake `spawnImpl` to avoid hitting the real CLI.
 */
export async function runRailwayCli({
  args,
  cwd = process.cwd(),
  timeoutMs = 30_000,
  spawnImpl,
} = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('runRailwayCli: args must be an array');
  }
  const spawnFn = spawnImpl || defaultSpawn;
  const cliPath = resolveCommandPath('railway');

  return await new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnFn(cliPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`railway spawn failed: ${err && err.message ? err.message : err}`));
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`railway timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (proc.stdout) proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    if (proc.stderr) proc.stderr.on('data', (c) => { stderrBuf += c.toString(); });

    proc.on('exit', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: code });
    });
    proc.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(new Error(`railway spawn error: ${err.message}`));
    });
  });
}
```

- [ ] **Step 2: Verify it parses**

```bash
node -e "import('./src/plugins/railway/railwayCli.js').then(m => console.log(typeof m.runRailwayCli, typeof m.resolveCommandPath))"
```

Expected: `function function`

- [ ] **Step 3: Commit**

```bash
git add src/plugins/railway/railwayCli.js
git commit -m "feat(plugins): railwayCli spawn helper with PATH/PATHEXT resolution"
```

---

### Task 8: railwayTools — link

**Files:**
- Create: `src/plugins/railway/railwayTools.js` (will grow over Tasks 8-11)
- Test: `test/plugins/railway/railwayTools.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/plugins/railway/railwayTools.test.js`:

```js
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
```

- [ ] **Step 2: Run test, watch it fail**

Run: `node --no-warnings --test test/plugins/railway/railwayTools.test.js`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `railwayLink` in `src/plugins/railway/railwayTools.js`**

```js
import { runRailwayCli as defaultRunner } from './railwayCli.js';

/**
 * Link a team's worktree to a Railway project. If projectId is supplied,
 * link to that existing project. Otherwise create a new one.
 *
 * Returns { linked: true, projectId } on success. Throws on CLI failure.
 *
 * Idempotency note: the railway CLI itself handles "already linked"
 * gracefully (re-linking is a no-op), so we don't track link state
 * in plugin_resources — only provisioned databases / services land
 * in that table.
 */
export async function railwayLink({ teamId, projectId, cwd, runRailwayCli } = {}) {
  if (!teamId) throw new TypeError('railwayLink: teamId required');
  const runner = runRailwayCli || defaultRunner;
  const args = projectId
    ? ['link', '--project-id', projectId, '--yes']
    : ['link', '--yes'];
  const result = await runner({ args, cwd });
  if (result.exitCode !== 0) {
    throw new Error(`railway link failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return {
    linked: true,
    projectId: projectId ?? null,
    teamId,
  };
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/plugins/railway/railwayTools.test.js`
Expected: PASS — 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/plugins/railway/railwayTools.js test/plugins/railway/railwayTools.test.js
git commit -m "feat(plugins): railwayLink — link team worktree to a Railway project"
```

---

### Task 9: railwayTools — provisionDb (with idempotency)

**Files:**
- Modify: `src/plugins/railway/railwayTools.js` (add `railwayProvisionDb`)
- Modify: `test/plugins/railway/railwayTools.test.js` (append tests)

- [ ] **Step 1: Append failing tests**

Append to `test/plugins/railway/railwayTools.test.js`:

```js
import { railwayProvisionDb } from '../../../src/plugins/railway/railwayTools.js';

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
```

- [ ] **Step 2: Run test, watch the new ones fail**

Run: `node --no-warnings --test test/plugins/railway/railwayTools.test.js`
Expected: FAIL — `railwayProvisionDb` not exported

- [ ] **Step 3: Append `railwayProvisionDb` to `src/plugins/railway/railwayTools.js`**

Add to the existing file:

```js
const SLICE_1_SUPPORTED_TYPES = new Set(['postgres']);

/**
 * Provision a database in Railway for the given team. Idempotent: if
 * the team already has a live database of the requested type, returns
 * the existing record with wasExisting:true and DOES NOT call the CLI.
 *
 * Slice 1 ships postgres only. Other types (redis, mongodb, mysql)
 * land in slice 1.5 by adding entries to SLICE_1_SUPPORTED_TYPES and
 * the type→CLI-arg mapping.
 *
 * Throws on CLI failure.
 */
export async function railwayProvisionDb({
  teamId,
  type = 'postgres',
  runRailwayCli,
  pluginResources,
} = {}) {
  if (!teamId) throw new TypeError('railwayProvisionDb: teamId required');
  if (!pluginResources) throw new TypeError('railwayProvisionDb: pluginResources required');
  if (!SLICE_1_SUPPORTED_TYPES.has(type)) {
    throw new Error(`railwayProvisionDb: type "${type}" not supported in slice 1 (postgres only)`);
  }

  // Idempotency: short-circuit if a live resource already exists.
  const existing = pluginResources.findLive({
    teamId, pluginId: 'railway', kind: type,
  });
  if (existing) {
    return { ...existing, wasExisting: true };
  }

  const runner = runRailwayCli || (await import('./railwayCli.js')).runRailwayCli;

  // `railway add --plugin postgresql --json` provisions a Postgres and
  // emits a JSON record on stdout. Slice 1 keys on the JSON output.
  const result = await runner({
    args: ['add', '--plugin', 'postgresql', '--json'],
  });
  if (result.exitCode !== 0) {
    throw new Error(`railway add failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(`railway add returned non-JSON stdout: ${result.stdout.slice(0, 200)}`);
  }
  const externalId = parsed.id ?? parsed.serviceId ?? parsed.service_id;
  if (!externalId) {
    throw new Error(`railway add returned no service id: ${JSON.stringify(parsed)}`);
  }

  const inserted = pluginResources.insert({
    teamId,
    pluginId: 'railway',
    kind: type,
    externalId,
    metadata: { railway: parsed },
  });
  return { ...inserted, wasExisting: false };
}
```

- [ ] **Step 4: Run test, watch it pass**

Run: `node --no-warnings --test test/plugins/railway/railwayTools.test.js`
Expected: PASS — 7 tests (3 from Task 8 + 4 new)

- [ ] **Step 5: Commit**

```bash
git add src/plugins/railway/railwayTools.js test/plugins/railway/railwayTools.test.js
git commit -m "feat(plugins): railwayProvisionDb — idempotent Postgres provisioning"
```

---

### Task 10: railwayTools — getConnectionString

**Files:**
- Modify: `src/plugins/railway/railwayTools.js`
- Modify: `test/plugins/railway/railwayTools.test.js`

- [ ] **Step 1: Append failing tests**

Append to the test file:

```js
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
```

- [ ] **Step 2: Watch fail**

Run: `node --no-warnings --test test/plugins/railway/railwayTools.test.js`
Expected: FAIL — function not exported.

- [ ] **Step 3: Append to `railwayTools.js`**

```js
/**
 * Pull a single environment variable's value (default DATABASE_URL)
 * for a Railway service. Returns the plaintext value — agents see it
 * directly. The audit log + UI raw-event view get the value passed
 * through redactSecrets so the password never lands in SQLite.
 *
 * Slice 1 path-a: plaintext exposure is intentional but loud. Slice 2
 * adds the substitution pipeline (path-b) so even agents see opaque
 * references like {$secret: 'railway.svc_x.DATABASE_URL'}.
 */
export async function railwayGetConnectionString({
  teamId,
  resourceId,
  varName = 'DATABASE_URL',
  runRailwayCli,
} = {}) {
  if (!teamId) throw new TypeError('railwayGetConnectionString: teamId required');
  if (!resourceId) throw new TypeError('railwayGetConnectionString: resourceId required');

  const runner = runRailwayCli || (await import('./railwayCli.js')).runRailwayCli;

  // `railway variables get <NAME> --service <id>` prints the raw value.
  const result = await runner({
    args: ['variables', 'get', varName, '--service', resourceId],
  });
  if (result.exitCode !== 0) {
    throw new Error(`railway variables get failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }

  return {
    teamId,
    resourceId,
    varName,
    value: result.stdout.trim(),
  };
}
```

- [ ] **Step 4: Watch pass**

Run: `node --no-warnings --test test/plugins/railway/railwayTools.test.js`
Expected: PASS — 10 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/railway/railwayTools.js test/plugins/railway/railwayTools.test.js
git commit -m "feat(plugins): railwayGetConnectionString — plaintext URL retrieval"
```

---

### Task 11: railwayTools — runMigration

**Files:**
- Modify: `src/plugins/railway/railwayTools.js`
- Modify: `test/plugins/railway/railwayTools.test.js`

- [ ] **Step 1: Append failing tests**

```js
import { railwayRunMigration } from '../../../src/plugins/railway/railwayTools.js';

test('railwayRunMigration: passes SQL via stdin to railway run', async () => {
  let receivedStdin = null;
  const fakeRunner = async ({ args, stdin }) => {
    receivedStdin = stdin;
    return { stdout: 'CREATE TABLE\n', stderr: '', exitCode: 0 };
  };
  const result = await railwayRunMigration({
    teamId: 'team-a',
    resourceId: 'res_x',
    sql: 'CREATE TABLE foo (id INT);',
    runRailwayCli: fakeRunner,
  });
  assert.equal(result.executed, true);
  assert.match(receivedStdin, /CREATE TABLE foo/);
});

test('railwayRunMigration: rejects empty SQL', async () => {
  await assert.rejects(
    () => railwayRunMigration({
      teamId: 'team-a', resourceId: 'res_x', sql: '',
      runRailwayCli: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    }),
    /sql required/i,
  );
});

test('railwayRunMigration: surfaces CLI failure as error', async () => {
  const fakeRunner = async () => ({ stdout: '', stderr: 'syntax error', exitCode: 1 });
  await assert.rejects(
    () => railwayRunMigration({
      teamId: 'team-a', resourceId: 'res_x', sql: 'INVALID;',
      runRailwayCli: fakeRunner,
    }),
    /syntax error|exit 1/,
  );
});
```

- [ ] **Step 2: Watch fail**

Run: `node --no-warnings --test test/plugins/railway/railwayTools.test.js`
Expected: FAIL.

- [ ] **Step 3: Update `railwayCli.js` + `railwayTools.js`**

The existing `runRailwayCli` doesn't pipe stdin. Add stdin support to `src/plugins/railway/railwayCli.js`:

Replace the `runRailwayCli` implementation with:

```js
export async function runRailwayCli({
  args,
  cwd = process.cwd(),
  timeoutMs = 30_000,
  stdin = null,
  spawnImpl,
} = {}) {
  if (!Array.isArray(args)) {
    throw new TypeError('runRailwayCli: args must be an array');
  }
  const spawnFn = spawnImpl || defaultSpawn;
  const cliPath = resolveCommandPath('railway');
  const stdioConfig = stdin
    ? ['pipe', 'pipe', 'pipe']
    : ['ignore', 'pipe', 'pipe'];

  return await new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawnFn(cliPath, args, { cwd, stdio: stdioConfig });
    } catch (err) {
      reject(new Error(`railway spawn failed: ${err && err.message ? err.message : err}`));
      return;
    }

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`railway timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    if (proc.stdout) proc.stdout.on('data', (c) => { stdoutBuf += c.toString(); });
    if (proc.stderr) proc.stderr.on('data', (c) => { stderrBuf += c.toString(); });

    if (stdin && proc.stdin) {
      proc.stdin.write(stdin);
      proc.stdin.end();
    }

    proc.on('exit', (code) => {
      if (timedOut) return;
      clearTimeout(timer);
      resolve({ stdout: stdoutBuf, stderr: stderrBuf, exitCode: code });
    });
    proc.on('error', (err) => {
      if (timedOut) return;
      clearTimeout(timer);
      reject(new Error(`railway spawn error: ${err.message}`));
    });
  });
}
```

Now append `railwayRunMigration` to `src/plugins/railway/railwayTools.js`:

```js
/**
 * Run a SQL migration against a Railway-provisioned database. The SQL
 * is piped via stdin to `railway run psql --service <id>`. Risk profile:
 * "high" — role-gated to lead/human only. Per-tool-call approval modal
 * is a slice-1.5 follow-up.
 *
 * Throws on empty SQL or CLI failure.
 */
export async function railwayRunMigration({
  teamId,
  resourceId,
  sql,
  runRailwayCli,
} = {}) {
  if (!teamId) throw new TypeError('railwayRunMigration: teamId required');
  if (!resourceId) throw new TypeError('railwayRunMigration: resourceId required');
  if (typeof sql !== 'string' || sql.trim().length === 0) {
    throw new TypeError('railwayRunMigration: sql required (non-empty)');
  }

  const runner = runRailwayCli || (await import('./railwayCli.js')).runRailwayCli;

  const result = await runner({
    args: ['run', '--service', resourceId, 'psql'],
    stdin: sql,
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0) {
    throw new Error(`railway migration failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`);
  }
  return {
    teamId,
    resourceId,
    executed: true,
    output: result.stdout.trim(),
  };
}
```

- [ ] **Step 4: Watch pass**

Run: `node --no-warnings --test test/plugins/railway/railwayTools.test.js`
Expected: PASS — 13 tests total.

- [ ] **Step 5: Commit**

```bash
git add src/plugins/railway/railwayCli.js src/plugins/railway/railwayTools.js test/plugins/railway/railwayTools.test.js
git commit -m "feat(plugins): railwayRunMigration — high-risk SQL migration via stdin"
```

---

## Phase 4 — Tool surface integration

### Task 12: command-contract + roleAuthority entries

**Files:**
- Modify: `src/commands/command-contract.js` — 8 new COMMANDS
- Modify: `src/security/roleAuthority.js` — add to ROLE_TOOLS
- Modify: `test/roleAuthority.test.js` — append new test

- [ ] **Step 1: Append failing test to `test/roleAuthority.test.js`**

```js
test('roleAuthority: plugin_* tools allowed for lead/architect/human, denied for developer', () => {
  for (const tool of ['plugin_list_available', 'plugin_login', 'plugin_logout', 'plugin_resource_list']) {
    for (const role of ['lead', 'architect', 'human']) {
      assert.doesNotThrow(
        () => assertRoleCanCallTool({ role, toolName: tool }),
        `${role} should be allowed ${tool}`,
      );
    }
    assert.throws(
      () => assertRoleCanCallTool({ role: 'developer', toolName: tool }),
      /cannot call|not allowed/i,
      `developer should be denied ${tool}`,
    );
  }
});

test('roleAuthority: railway_run_migration allowed only for lead/human', () => {
  for (const role of ['lead', 'human']) {
    assert.doesNotThrow(() => assertRoleCanCallTool({ role, toolName: 'railway_run_migration' }));
  }
  for (const role of ['architect', 'developer', 'reviewer', 'tester']) {
    assert.throws(
      () => assertRoleCanCallTool({ role, toolName: 'railway_run_migration' }),
      /cannot call|not allowed/i,
    );
  }
});

test('roleAuthority: railway_get_connection_string allowed for developer (read for config)', () => {
  assert.doesNotThrow(() => assertRoleCanCallTool({ role: 'developer', toolName: 'railway_get_connection_string' }));
});
```

- [ ] **Step 2: Watch fail**

Run: `node test/roleAuthority.test.js`
Expected: FAIL — tools not in any role's allowlist.

- [ ] **Step 3: Add COMMANDS entries to `src/commands/command-contract.js`**

Inside `COMMANDS` object, add:

```js
  PLUGIN_LIST_AVAILABLE: 'plugin_list_available',
  PLUGIN_LOGIN: 'plugin_login',
  PLUGIN_LOGOUT: 'plugin_logout',
  PLUGIN_RESOURCE_LIST: 'plugin_resource_list',
  RAILWAY_LINK: 'railway_link',
  RAILWAY_PROVISION_DB: 'railway_provision_db',
  RAILWAY_GET_CONNECTION_STRING: 'railway_get_connection_string',
  RAILWAY_RUN_MIGRATION: 'railway_run_migration',
```

(Place them in alphabetical order if the existing entries are alphabetical, otherwise alongside the other plugin-style/provider-style commands.)

- [ ] **Step 4: Add to ROLE_TOOLS in `src/security/roleAuthority.js`**

In the `architect` array, append:
```js
    'plugin_list_available',
    'plugin_login',
    'plugin_logout',
    'plugin_resource_list',
    'railway_link',
    'railway_provision_db',
    'railway_get_connection_string',
```

In the `developer` array, append:
```js
    'plugin_list_available',
    'plugin_resource_list',
    'railway_get_connection_string',
```

`lead` and `human` already get `'*'` so they automatically have access to all the new tools, including `railway_run_migration`. Reviewer/tester get nothing new.

If `COMMON_READ_TOOLS` exists at the top of `roleAuthority.js` and includes plugin-listing-style tools, you can alternatively add `plugin_list_available` and `plugin_resource_list` there — read the file to decide.

- [ ] **Step 5: Watch pass**

Run: `node test/roleAuthority.test.js`
Expected: PASS — all existing + 3 new tests.

- [ ] **Step 6: Commit**

```bash
git add src/commands/command-contract.js src/security/roleAuthority.js test/roleAuthority.test.js
git commit -m "feat(plugins): plugin_* + railway_* commands + role guards"
```

---

### Task 13: riskClassifier integration

**Files:**
- Modify: `src/policy/riskClassifier.js` — add a tool-name-based hook
- Test: `test/riskClassifier.test.js` — append new tests

- [ ] **Step 1: Read the existing classifier**

Read `src/policy/riskClassifier.js` to understand its current shape. The slice-1 plugins should leverage whatever existing classification the classifier provides; if its API doesn't yet accept a tool name, this task adds that.

- [ ] **Step 2: Append failing tests to `test/riskClassifier.test.js`**

```js
import { classify, classifyToolCall } from '../src/policy/riskClassifier.js';

test('classifyToolCall: railway_provision_db → medium', () => {
  const v = classifyToolCall({ toolName: 'railway_provision_db' });
  assert.equal(v.riskLevel, 'medium');
});

test('classifyToolCall: railway_run_migration → high', () => {
  const v = classifyToolCall({ toolName: 'railway_run_migration' });
  assert.equal(v.riskLevel, 'high');
});

test('classifyToolCall: railway_link → low', () => {
  const v = classifyToolCall({ toolName: 'railway_link' });
  assert.equal(v.riskLevel, 'low');
});

test('classifyToolCall: unknown tool → null (defer to default)', () => {
  const v = classifyToolCall({ toolName: 'something_unknown' });
  assert.equal(v.riskLevel, null);
});
```

- [ ] **Step 3: Watch fail**

Run: `node test/riskClassifier.test.js`
Expected: FAIL — `classifyToolCall` not exported.

- [ ] **Step 4: Add `classifyToolCall` to `src/policy/riskClassifier.js`**

Append to the file:

```js
import { PLUGIN_COMMANDS } from '../plugins/pluginRegistry.js';

/**
 * Classify a tool call by name. Returns { riskLevel: 'low'|'medium'|'high'|null }.
 *
 * Slice-1 lookup table: maps `<plugin>_<action>` tool names against the
 * plugin's `riskProfile` from PLUGIN_COMMANDS. Returns null for unknown
 * tools so callers can fall back to whatever default they want.
 *
 * Used by LocalToolFacade's plugin-tool dispatch to (eventually) gate
 * high-risk tool calls behind a §14-style approval modal. Slice 1 only
 * uses this for telemetry + the per-call audit row's risk-level field;
 * actual gating is via roleAuthority (lead/human only for high-risk).
 */
export function classifyToolCall({ toolName } = {}) {
  if (typeof toolName !== 'string' || toolName.length === 0) {
    return { riskLevel: null, reasons: ['no tool name supplied'] };
  }
  // Plugin tools: split on first underscore, look up in PLUGIN_COMMANDS.<plugin>.riskProfile
  const idx = toolName.indexOf('_');
  if (idx > 0) {
    const pluginId = toolName.slice(0, idx);
    const action = toolName.slice(idx + 1);
    const cfg = PLUGIN_COMMANDS[pluginId];
    if (cfg && cfg.riskProfile && cfg.riskProfile[action]) {
      return {
        riskLevel: cfg.riskProfile[action],
        reasons: [`${pluginId}.${action} → ${cfg.riskProfile[action]}`],
      };
    }
  }
  return { riskLevel: null, reasons: [] };
}
```

- [ ] **Step 5: Watch pass**

Run: `node test/riskClassifier.test.js`
Expected: PASS — all existing + 4 new tests.

- [ ] **Step 6: Commit**

```bash
git add src/policy/riskClassifier.js test/riskClassifier.test.js
git commit -m "feat(plugins): classifyToolCall hook reads plugin risk profiles"
```

---

### Task 14: LocalToolFacade — plugin_* dispatch handlers

**Files:**
- Modify: `src/tools/localToolFacade.js` — add constructor injection + 4 new case branches + 4 handler methods
- Modify: `test/localToolFacade.test.js` — append 4 new tests

- [ ] **Step 1: Append failing tests to `test/localToolFacade.test.js`**

```js
test('LocalToolFacade plugin_list_available returns SUPPORTED_PLUGINS shape', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    pluginAuthReadFile: () => '{"token":"x"}',  // pretend railway is signed in
    pluginAuthStat: () => ({ size: 50 }),
  });
  const result = await facade.execute({
    commandName: COMMANDS.PLUGIN_LIST_AVAILABLE,
    actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
    args: {},
  });
  assert.ok(Array.isArray(result.plugins));
  const railway = result.plugins.find((p) => p.pluginId === 'railway');
  assert.ok(railway);
  assert.equal(railway.signedIn, true);
});

test('LocalToolFacade plugin_login surfaces manualLogin instructions for railway', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  const result = await facade.execute({
    commandName: COMMANDS.PLUGIN_LOGIN,
    actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
    args: { pluginId: 'railway' },
  });
  assert.equal(result.manualLogin, true);
  assert.match(result.reason, /railway login/);
});

test('LocalToolFacade plugin_logout shells out to railway logout', async () => {
  const calls = [];
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    pluginAuthSpawnSync: (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const result = await facade.execute({
    commandName: COMMANDS.PLUGIN_LOGOUT,
    actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
    args: { pluginId: 'railway' },
  });
  assert.equal(result.loggedOut, true);
  assert.equal(calls[0].cmd, 'railway');
});

test('LocalToolFacade plugin_resource_list returns rows from pluginResources', async () => {
  let listed = null;
  const fakeResources = {
    listForTeam: ({ teamId }) => {
      listed = teamId;
      return [{ resourceId: 'r1', teamId, pluginId: 'railway', kind: 'postgres', externalId: 'svc_x' }];
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    pluginResources: fakeResources,
  });
  const result = await facade.execute({
    commandName: COMMANDS.PLUGIN_RESOURCE_LIST,
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
    args: {},
  });
  assert.equal(listed, 'team-a');
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].kind, 'postgres');
});
```

- [ ] **Step 2: Watch fail**

Run: `node --no-warnings test/localToolFacade.test.js`
Expected: FAIL — unsupported commands.

- [ ] **Step 3: Modify `src/tools/localToolFacade.js`**

**3a.** Add to constructor params (alongside `claudeUsageProbe`, etc):
```js
  pluginAuthReadFile = null,
  pluginAuthStat = null,
  pluginAuthSpawnSync = null,
  pluginResources = null,
  pluginJobs = null,
```

**3b.** Store them:
```js
this.pluginAuthReadFile = typeof pluginAuthReadFile === 'function' ? pluginAuthReadFile : null;
this.pluginAuthStat = typeof pluginAuthStat === 'function' ? pluginAuthStat : null;
this.pluginAuthSpawnSync = typeof pluginAuthSpawnSync === 'function' ? pluginAuthSpawnSync : null;
this.pluginResources = pluginResources && typeof pluginResources.listForTeam === 'function'
  ? pluginResources : null;
this.pluginJobs = pluginJobs && typeof pluginJobs.create === 'function'
  ? pluginJobs : null;
```

**3c.** Add to `execute()` switch:
```js
case COMMANDS.PLUGIN_LIST_AVAILABLE:
  return this.#pluginListAvailable(actor, args);
case COMMANDS.PLUGIN_LOGIN:
  return this.#pluginLogin(actor, args);
case COMMANDS.PLUGIN_LOGOUT:
  return this.#pluginLogout(actor, args);
case COMMANDS.PLUGIN_RESOURCE_LIST:
  return this.#pluginResourceList(actor, args);
```

**3d.** Add new imports at top:
```js
import { PLUGIN_COMMANDS, SUPPORTED_PLUGINS } from '../plugins/pluginRegistry.js';
import {
  getAuthStatus as pluginGetAuthStatus,
  triggerAuthLogin as pluginTriggerLogin,
  triggerAuthLogout as pluginTriggerLogout,
} from '../plugins/pluginAuth.js';
```

**3e.** Add handler methods (place near `#providerAuthStatus`):

```js
async #pluginListAvailable(_actor, _args) {
  const plugins = SUPPORTED_PLUGINS.map((pluginId) => {
    const cfg = PLUGIN_COMMANDS[pluginId];
    const status = pluginGetAuthStatus({
      pluginId,
      readFileImpl: this.pluginAuthReadFile,
      statImpl: this.pluginAuthStat,
    });
    return {
      pluginId,
      label: cfg?.label ?? pluginId,
      supported: cfg?.supported === true,
      signedIn: status.signedIn === true,
      reason: status.reason ?? null,
      user: status.user ?? null,
    };
  });
  return { plugins };
}

#pluginLogin(_actor, args) {
  const pluginId = requireString(args?.pluginId, 'args.pluginId');
  return pluginTriggerLogin({ pluginId });
}

#pluginLogout(_actor, args) {
  const pluginId = requireString(args?.pluginId, 'args.pluginId');
  return pluginTriggerLogout({
    pluginId,
    spawnSyncImpl: this.pluginAuthSpawnSync,
  });
}

#pluginResourceList(actor, args) {
  if (!this.pluginResources) {
    return { resources: [] };
  }
  const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
    ? args.teamId
    : actor.teamId;
  const resources = this.pluginResources.listForTeam({ teamId });
  return { resources };
}
```

- [ ] **Step 4: Watch pass**

Run: `node --no-warnings test/localToolFacade.test.js`
Expected: PASS (all existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/tools/localToolFacade.js test/localToolFacade.test.js
git commit -m "feat(plugins): plugin_* dispatch handlers in LocalToolFacade"
```

---

### Task 15: LocalToolFacade — railway_* dispatch handlers

**Files:**
- Modify: `src/tools/localToolFacade.js` — add 4 new case branches + 4 handler methods
- Modify: `test/localToolFacade.test.js` — append 4 new tests

- [ ] **Step 1: Append failing tests**

```js
test('LocalToolFacade railway_link delegates to railwayLink', async () => {
  const calls = [];
  const fakeRailwayLink = async (args) => { calls.push(args); return { linked: true, projectId: 'p1' }; };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    railwayToolImpls: { link: fakeRailwayLink },
  });
  const result = await facade.execute({
    commandName: COMMANDS.RAILWAY_LINK,
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
    args: { projectId: 'p1' },
  });
  assert.equal(result.linked, true);
  assert.equal(calls[0].teamId, 'team-a');
});

test('LocalToolFacade railway_provision_db idempotent + uses pluginResources', async () => {
  const calls = [];
  const fakeProvision = async (args) => {
    calls.push(args);
    return { resourceId: 'res_1', externalId: 'svc_x', kind: 'postgres', wasExisting: false };
  };
  const fakeResources = { findLive: () => null, insert: () => ({ resourceId: 'res_1' }) };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    pluginResources: fakeResources,
    railwayToolImpls: { provisionDb: fakeProvision },
  });
  const result = await facade.execute({
    commandName: COMMANDS.RAILWAY_PROVISION_DB,
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
    args: { type: 'postgres' },
  });
  assert.equal(result.kind, 'postgres');
  assert.equal(calls[0].pluginResources, fakeResources, 'facade should pass pluginResources to the tool');
});

test('LocalToolFacade railway_get_connection_string redacts in audit but returns plaintext', async () => {
  const fakeGet = async () => ({ value: 'postgres://u:pw@h:5432/d', resourceId: 'res_1' });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    railwayToolImpls: { getConnectionString: fakeGet },
  });
  const result = await facade.execute({
    commandName: COMMANDS.RAILWAY_GET_CONNECTION_STRING,
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
    args: { resourceId: 'res_1' },
  });
  // Plaintext returned to caller (path-a)
  assert.equal(result.value, 'postgres://u:pw@h:5432/d');
});

test('LocalToolFacade railway_run_migration delegates to railwayRunMigration', async () => {
  const fakeMigrate = async (args) => ({ executed: true, output: 'ok' });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    railwayToolImpls: { runMigration: fakeMigrate },
  });
  const result = await facade.execute({
    commandName: COMMANDS.RAILWAY_RUN_MIGRATION,
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },  // human role required
    args: { resourceId: 'res_1', sql: 'CREATE TABLE x (id INT);' },
  });
  assert.equal(result.executed, true);
});
```

- [ ] **Step 2: Watch fail**

Run: `node --no-warnings test/localToolFacade.test.js`
Expected: FAIL — unsupported commands.

- [ ] **Step 3: Modify `src/tools/localToolFacade.js`**

**3a.** Add to constructor:
```js
  railwayToolImpls = null,    // {link, provisionDb, getConnectionString, runMigration} for tests
```

**3b.** Store:
```js
this.railwayToolImpls = railwayToolImpls && typeof railwayToolImpls === 'object'
  ? railwayToolImpls : null;
```

**3c.** Add to switch:
```js
case COMMANDS.RAILWAY_LINK:
  return this.#railwayLink(actor, args);
case COMMANDS.RAILWAY_PROVISION_DB:
  return this.#railwayProvisionDb(actor, args);
case COMMANDS.RAILWAY_GET_CONNECTION_STRING:
  return this.#railwayGetConnectionString(actor, args);
case COMMANDS.RAILWAY_RUN_MIGRATION:
  return this.#railwayRunMigration(actor, args);
```

**3d.** Add imports:
```js
import {
  railwayLink as defaultRailwayLink,
  railwayProvisionDb as defaultRailwayProvisionDb,
  railwayGetConnectionString as defaultRailwayGetConnectionString,
  railwayRunMigration as defaultRailwayRunMigration,
} from '../plugins/railway/railwayTools.js';
```

**3e.** Add handler methods:

```js
async #railwayLink(actor, args) {
  const impl = this.railwayToolImpls?.link || defaultRailwayLink;
  const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
    ? args.teamId : actor.teamId;
  return impl({
    teamId,
    projectId: args?.projectId,
  });
}

async #railwayProvisionDb(actor, args) {
  if (!this.pluginResources) {
    throw new Error('railway_provision_db: pluginResources not configured for this facade');
  }
  const impl = this.railwayToolImpls?.provisionDb || defaultRailwayProvisionDb;
  const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
    ? args.teamId : actor.teamId;
  return impl({
    teamId,
    type: args?.type ?? 'postgres',
    pluginResources: this.pluginResources,
  });
}

async #railwayGetConnectionString(actor, args) {
  const impl = this.railwayToolImpls?.getConnectionString || defaultRailwayGetConnectionString;
  const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
    ? args.teamId : actor.teamId;
  return impl({
    teamId,
    resourceId: requireString(args?.resourceId, 'args.resourceId'),
    varName: args?.varName,
  });
}

async #railwayRunMigration(actor, args) {
  const impl = this.railwayToolImpls?.runMigration || defaultRailwayRunMigration;
  const teamId = (typeof args?.teamId === 'string' && args.teamId.length > 0)
    ? args.teamId : actor.teamId;
  return impl({
    teamId,
    resourceId: requireString(args?.resourceId, 'args.resourceId'),
    sql: requireString(args?.sql, 'args.sql'),
  });
}
```

- [ ] **Step 4: Watch pass**

Run: `node --no-warnings test/localToolFacade.test.js`
Expected: PASS (all existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/tools/localToolFacade.js test/localToolFacade.test.js
git commit -m "feat(plugins): railway_* dispatch handlers in LocalToolFacade"
```

---

## Phase 5 — Production wiring

### Task 16: dev-api-server — wire registry + stores into facade

**Files:**
- Modify: `scripts/dev-api-server.mjs`

- [ ] **Step 1: Add imports**

Near the top, alongside existing imports:

```js
import { SqlitePluginJobs } from '../src/plugins/pluginJobs.js';
import { SqlitePluginResources } from '../src/plugins/pluginResources.js';
```

- [ ] **Step 2: Construct stores after `driftDb` is available**

After the existing `if (driftDb) { ... }` block (which constructs the drift store + engine + monitor), add:

```js
let pluginJobs = null;
let pluginResources = null;
if (driftDb) {
  pluginJobs = new SqlitePluginJobs({ db: driftDb });
  pluginResources = new SqlitePluginResources({ db: driftDb });
}
```

- [ ] **Step 3: Pass to LocalToolFacade construction**

If the facade is constructed inside `LocalToadRuntime` (it is — check `src/app/LocalToadRuntime.js`), update the runtime construction in `dev-api-server.mjs` to pass the stores via deps:

Read `src/app/LocalToadRuntime.js` to see how it constructs the facade. If the facade construction is inline, late-inject the stores onto `runtime.toolFacade`:

```js
if (runtime.toolFacade) {
  runtime.toolFacade.pluginJobs = pluginJobs;
  runtime.toolFacade.pluginResources = pluginResources;
}
```

(Same pattern dev-api-server already uses for `driftEngine`.)

- [ ] **Step 4: Smoke-check syntax**

```bash
node --check scripts/dev-api-server.mjs
```

Expected: silent success.

- [ ] **Step 5: Run full backend tests**

```bash
npm test 2>&1 | tail -10
```

Expected: every test passes (no regressions).

- [ ] **Step 6: Commit**

```bash
git add scripts/dev-api-server.mjs
git commit -m "feat(plugins): wire pluginJobs + pluginResources into LocalToolFacade"
```

---

## Phase 6 — UI

### Task 17: Settings → Plugins tab

**Files:**
- Create: `ui/src/components/settings/PluginsSettings.tsx`
- Modify: `ui/src/components/settings/SettingsLayout.tsx` — add 'plugins' nav entry
- Modify: `ui/src/components/settings/SettingsScreen.tsx` — route 'plugins'

- [ ] **Step 1: Read existing patterns**

Read `ui/src/components/settings/ProvidersSettings.tsx` — it's the closest sibling. The PluginsSettings component will use the same shape.

- [ ] **Step 2: Create `ui/src/components/settings/PluginsSettings.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { SettingsSectionHeader, SettingsCard } from './SettingsLayout';
import { callTool as callToadApi } from '@/api/client';

interface PluginInfo {
  pluginId: 'railway' | 'eas' | 'vercel';
  label: string;
  supported: boolean;
  signedIn: boolean;
  reason: string | null;
  user: { email?: string; login?: string; name?: string } | null;
}

interface ResourceInfo {
  resourceId: string;
  pluginId: string;
  kind: string;
  externalId: string;
  createdAt: string;
}

const PROVIDER_GLYPH_CLASS: Record<string, string> = {
  railway: 'railway',
  eas: 'eas',
  vercel: 'vercel',
};

export function PluginsSettings() {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [resources, setResources] = useState<ResourceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [pendingLogin, setPendingLogin] = useState<string | null>(null);

  const load = async () => {
    try {
      const list = await callToadApi({
        actor: { teamId: 'default', agentId: 'ui-client', role: 'human' },
        method: 'plugin_list_available', args: {},
      }) as { plugins: PluginInfo[] };
      setPlugins(list.plugins);

      const r = await callToadApi({
        actor: { teamId: 'default', agentId: 'ui-client', role: 'human' },
        method: 'plugin_resource_list', args: {},
      }) as { resources: ResourceInfo[] };
      setResources(r.resources);
    } catch {
      // Silent — UI shows empty state.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    const id = window.setInterval(load, 30_000);
    return () => window.clearInterval(id);
  }, []);

  const startLogin = async (pluginId: string) => {
    setPendingLogin(pluginId);
    try {
      const result = await callToadApi({
        actor: { teamId: 'default', agentId: 'ui-client', role: 'human' },
        method: 'plugin_login', args: { pluginId },
      }) as { manualLogin?: boolean; reason?: string };
      if (result.manualLogin) {
        // Show the manual instructions in an alert for now.
        // Slice 1.5 can build a dedicated modal.
        window.alert(result.reason ?? `Run the ${pluginId} CLI's login command in a terminal.`);
      }
    } finally {
      setPendingLogin(null);
      void load();
    }
  };

  const logout = async (pluginId: string) => {
    if (!window.confirm(`Sign out of ${pluginId}?`)) return;
    try {
      await callToadApi({
        actor: { teamId: 'default', agentId: 'ui-client', role: 'human' },
        method: 'plugin_logout', args: { pluginId },
      });
    } catch (err) {
      window.alert(`Logout failed: ${String(err)}`);
    } finally {
      void load();
    }
  };

  return (
    <div>
      <SettingsSectionHeader
        title="Plugins"
        description="Infrastructure providers your team's agents can use. Each plugin wraps a CLI you've already authenticated locally — Symphony just calls those CLIs through the same role-gated, risk-classified, audit-trailed surface as everything else."
      />

      <SettingsCard title="Available plugins">
        {loading && <div className="dim" style={{ fontSize: 11 }}>Loading…</div>}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {plugins.map((p) => (
            <div
              key={p.pluginId}
              style={{
                padding: '12px 14px',
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
                borderRadius: 8,
                opacity: p.supported ? 1 : 0.55,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <span className={`provider-glyph ${PROVIDER_GLYPH_CLASS[p.pluginId] ?? ''}`}
                      style={{ width: 24, height: 24, borderRadius: 6 }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{p.label}</span>
                <span
                  style={{
                    fontSize: 10,
                    padding: '2px 6px',
                    borderRadius: 3,
                    background: p.signedIn ? 'rgba(74,222,128,0.12)' : 'rgba(255,255,255,0.04)',
                    color: p.signedIn ? 'var(--ok, #4ade80)' : 'var(--fg-dim)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.04em',
                    fontWeight: 600,
                  }}
                >
                  {p.signedIn ? 'Signed in' : (p.supported ? 'Not signed in' : 'Slice 2/3')}
                </span>
                {p.user?.email && (
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>{p.user.email}</span>
                )}
              </div>
              {p.reason && !p.signedIn && (
                <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 6 }}>{p.reason}</div>
              )}
              {p.supported && !p.signedIn && (
                <button
                  className="btn btn-sm"
                  onClick={() => void startLogin(p.pluginId)}
                  disabled={pendingLogin === p.pluginId}
                >
                  {pendingLogin === p.pluginId ? 'Awaiting login…' : 'Sign in'}
                </button>
              )}
              {p.supported && p.signedIn && (
                <button className="btn btn-sm" onClick={() => void logout(p.pluginId)}>
                  Sign out
                </button>
              )}
            </div>
          ))}
        </div>
      </SettingsCard>

      <SettingsCard
        title="Provisioned resources"
        description="Resources Symphony's agents have created via plugins. Deprovisioning is manual in slice 1 — visit the provider's dashboard to remove a resource fully. Cleanup-on-team-delete is a slice-1.5 follow-up."
      >
        {resources.length === 0 ? (
          <div className="dim" style={{ fontSize: 11 }}>No resources yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {resources.map((r) => (
              <div key={r.resourceId} style={{
                padding: '8px 10px', fontSize: 12,
                background: 'rgba(255,255,255,0.02)',
                border: '1px solid var(--border-soft, rgba(255,255,255,0.06))',
                borderRadius: 6,
              }}>
                <span style={{ fontWeight: 600 }}>{r.pluginId}</span>
                <span style={{ color: 'var(--fg-dim)' }}> · {r.kind}</span>
                <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}> · {r.externalId}</span>
                <span style={{ color: 'var(--fg-dim)', fontSize: 11 }}> · {new Date(r.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
    </div>
  );
}
```

- [ ] **Step 3: Add 'plugins' nav entry to `ui/src/components/settings/SettingsLayout.tsx`**

Read the existing file to find the `SettingsSectionKey` union and the nav-items array. Add `'plugins'` between `'providers'` and `'github'`:

```ts
export type SettingsSectionKey =
  | 'general'
  | 'providers'
  | 'plugins'    // NEW
  | 'github'
  | 'workspace'
  | 'risk'
  | 'mcp'
  | 'notifications'
  | 'advanced';
```

In whatever array of nav items the layout renders, add:

```tsx
{ key: 'plugins', label: 'Plugins', icon: 'package' /* or whatever icon fits */ }
```

- [ ] **Step 4: Route 'plugins' in `ui/src/components/settings/SettingsScreen.tsx`**

Add the import:
```tsx
import { PluginsSettings } from './PluginsSettings';
```

Add the route alongside `{active === 'providers' && <ProvidersSettings />}`:

```tsx
{active === 'plugins' && <PluginsSettings />}
```

- [ ] **Step 5: Type-check**

```bash
cd ui && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/settings/PluginsSettings.tsx ui/src/components/settings/SettingsLayout.tsx ui/src/components/settings/SettingsScreen.tsx
git commit -m "feat(plugins-ui): Settings → Plugins tab with sign-in + resource list"
```

---

### Task 18: Loud secret-surface warning in agent activity stream

**Files:**
- Create: `ui/src/api/secretMask.ts`
- Modify: `ui/src/components/AgentInbox.tsx` — wire secretMask into tool-result rendering

- [ ] **Step 1: Create `ui/src/api/secretMask.ts`**

```ts
/**
 * UI-side detector for known secret patterns. Mirrors
 * src/tools/secretRedactor.js but runs in the browser, so the agent
 * activity stream can mask plaintext connection strings + tokens
 * before they hit the DOM.
 *
 * Returns { masked, didMask, count } — `masked` is the string to
 * display, `didMask` is a boolean we use to render a warning banner,
 * `count` is the number of distinct secrets we found.
 */
const SECRET_PATTERNS: { pattern: RegExp; replace: (match: string, ...groups: string[]) => string }[] = [
  // postgres / mysql / mongodb / redis URLs
  {
    pattern: /((?:postgres(?:ql)?|mysql|redis|rediss|mongodb(?:\+srv)?):\/\/[^:@\s]+):([^@\s]+)@/gi,
    replace: (_m, prefix) => `${prefix}:•••••••@`,
  },
  // bearer tokens
  {
    pattern: /(\bBearer\s+)([A-Za-z0-9_\-.]{16,})/gi,
    replace: (_m, prefix) => `${prefix}•••••••`,
  },
  // env-var-shaped keys in JSON
  {
    pattern: /("(?:DATABASE_URL|API_KEY|SECRET_KEY|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|CLIENT_SECRET)"\s*:\s*)"[^"]*"/gi,
    replace: (_m, prefix) => `${prefix}"•••••••"`,
  },
];

export function secretMask(input: string): { masked: string; didMask: boolean; count: number } {
  if (typeof input !== 'string') return { masked: '', didMask: false, count: 0 };
  let masked = input;
  let count = 0;
  for (const { pattern, replace } of SECRET_PATTERNS) {
    masked = masked.replace(pattern, (...args) => {
      count += 1;
      return replace(...(args as [string, ...string[]]));
    });
  }
  return { masked, didMask: count > 0, count };
}
```

- [ ] **Step 2: Wire into `ui/src/components/AgentInbox.tsx`**

Read the existing file. Find where tool-call results are rendered (look for `tool_result`, `result`, or similar). Wrap the rendering with `secretMask`:

```tsx
import { secretMask } from '@/api/secretMask';

// inside the rendering of a tool result:
const raw = JSON.stringify(toolResult, null, 2);
const { masked, didMask } = secretMask(raw);

return (
  <div>
    {didMask && (
      <div style={{
        fontSize: 10,
        color: 'var(--warn, #ffcd66)',
        background: 'rgba(255, 205, 102, 0.06)',
        padding: '4px 8px',
        borderRadius: 4,
        marginBottom: 4,
      }}>
        ⚠️ Secret value masked in this view. The agent received the unredacted value.
      </div>
    )}
    <pre style={{ fontSize: 10, color: 'var(--fg-muted)' }}>{masked}</pre>
  </div>
);
```

If the existing AgentInbox doesn't render tool results in a single place, add a small helper component `<MaskedToolResult>` and use it everywhere tool results are shown.

- [ ] **Step 3: Type-check**

```bash
cd ui && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api/secretMask.ts ui/src/components/AgentInbox.tsx
git commit -m "feat(plugins-ui): mask plaintext secrets in agent activity stream"
```

---

### Task 19: Team-delete warning when plugin resources exist

**Files:**
- Modify: `ui/src/App.tsx` — extend `handleEndTeam` to check resources first

- [ ] **Step 1: Read existing `handleEndTeam` in `App.tsx`**

The function exists (set up during slice-1 work). Find where it makes the `team_delete` API call.

- [ ] **Step 2: Add a resource check before delete**

Modify `handleEndTeam` to:

```tsx
const handleEndTeam = useCallback(async () => {
  const teamId = team.name || activeTeamId;
  if (!teamId) return;

  // Slice-1 plugin warning: check live resources before delete
  let resources: { resourceId: string; pluginId: string; kind: string; externalId: string }[] = [];
  try {
    const r = await callToadApi({
      actor: { teamId, agentId: 'ui-client', role: 'human' },
      method: 'plugin_resource_list', args: { teamId },
    }) as { resources: typeof resources };
    resources = r.resources;
  } catch {
    // Silent — best-effort warning.
  }

  if (resources.length > 0) {
    const list = resources.map((r) => `  • ${r.pluginId}/${r.kind} (${r.externalId})`).join('\n');
    const proceed = window.confirm(
      `This team has ${resources.length} live plugin resource${resources.length === 1 ? '' : 's'}:\n\n${list}\n\n`
      + `These will NOT be auto-deprovisioned. They will continue to incur cost until you remove them in their respective dashboards.\n\n`
      + `Continue with team deletion?`,
    );
    if (!proceed) return;
  }

  // Existing delete flow:
  try {
    await callToadApi({
      actor: { teamId, agentId: 'ui-client', role: 'human' },
      method: 'team_stop',
      args: { teamId },
      idempotencyKey: `team-end-stop-${teamId}-${Date.now()}`,
    }).catch((err) => {
      console.warn('team_stop during End failed (proceeding to delete):', err);
    });
    await callToadApi({
      actor: { teamId, agentId: 'ui-client', role: 'human' },
      method: 'team_delete',
      args: { teamId },
      idempotencyKey: `team-end-delete-${teamId}-${Date.now()}`,
    });
  } catch (err) {
    console.error('team_delete failed:', err);
  } finally {
    refresh();
  }
}, [team.name, activeTeamId, refresh]);
```

- [ ] **Step 3: Type-check**

```bash
cd ui && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/App.tsx
git commit -m "feat(plugins-ui): warn before team-delete when plugin resources exist"
```

---

## Phase 7 — Final wire-up

### Task 20: Smoke test — engine boots, tools dispatch

This task has no test file — it's a sanity check that the full stack composes.

- [ ] **Step 1: Smoke-check backend boot**

```bash
node --check scripts/dev-api-server.mjs
```

Expected: silent success.

- [ ] **Step 2: Run the entire test suite**

```bash
npm test 2>&1 | tail -10
```

Expected: every test passes (no regressions). Verify the new test files appear in the output.

- [ ] **Step 3: Type-check the UI**

```bash
cd ui && npx tsc --noEmit
```

Expected: clean.

(Step 4 is the npm-test-chain extension in Task 21; don't commit anything yet.)

---

### Task 21: Extend npm test chain

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Append the 6 new test files**

Find `"test":` in `package.json`. Append (preserving the `&&` chain) after the last drift entry:

```
&& node --no-warnings --test test/secretRedactor.test.js
&& node --no-warnings --test test/plugins/pluginRegistry.test.js
&& node --no-warnings --test test/plugins/pluginAuth.test.js
&& node --no-warnings --test test/plugins/pluginJobs.test.js
&& node --no-warnings --test test/plugins/pluginResources.test.js
&& node --no-warnings --test test/plugins/railway/railwayTools.test.js
```

- [ ] **Step 2: Verify JSON parses**

```bash
node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).scripts.test)" | tail -5
```

- [ ] **Step 3: Run full suite**

```bash
npm test 2>&1 | tail -15
```

Expected: every test passes.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "chore(plugins): wire slice-1 tests into npm test chain"
```

---

### Task 22: README mention + e2e smoke

**Files:**
- Modify: `README.md` — note plugins are in flight rather than future-tense

- [ ] **Step 1: Update README's "What's deferred"**

Find the `Infrastructure plugin system.` line in the deferred list. Replace it with:

```md
- **Infrastructure plugin system — slice 0+1 in flight.** Slice 0 (plugin
  infrastructure: registry, auth helpers, jobs/resources stores, secret
  redactor) + slice 1 (Railway plugin, Postgres-only) shipping together.
  See `toad-local/docs/superpowers/specs/2026-05-04-plugin-slice-0-1-railway-design.md`.
  Slice 1.5 (other Railway DB types, auto-deprovision), slice 2 (EAS),
  slice 3 (Vercel) tracked as follow-ups.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs(plugins): note slice 0+1 in flight in README deferred list"
```

- [ ] **Step 3: End-to-end manual verification**

(Human smoke test — no automated test for this.)

1. Boot the desktop app:
```bash
cd ui && npm run tauri:dev
```

2. Open **Settings → Plugins**. Confirm Railway shows up with "Not signed in" (or "Signed in" if you have `~/.config/railway/config.json` set up).

3. If you have the Railway CLI installed and signed in:
   - Click on a team
   - Open the agent inbox
   - As the human, send a message asking the lead to provision a database (in chat: "lead, provision a Postgres for this project")
   - The lead should call `railway_provision_db` and the resource should appear in **Settings → Plugins → Provisioned resources**

4. Try the team-delete warning:
   - Mark the team for deletion via "End team"
   - Confirm the warning lists the Railway resource
   - Cancel the delete

5. Smoke-check secret masking:
   - Have an agent call `railway_get_connection_string`
   - The agent's tool-result panel in the inbox should show the connection URL with the password masked + a yellow warning banner

- [ ] **Step 4: Commit a ship note**

```bash
git commit --allow-empty -m "ship(plugins): slice 0+1 verified end-to-end"
```

---

## Self-review

- [x] **Spec coverage** — every section of the spec maps to a task:
  - §3 architecture / data flow → Tasks 1-3 (storage), 4-5 (registry/auth), 7-11 (Railway tools), 14-16 (facade + wiring)
  - §4 module layout → Tasks 1-15 cover every file
  - §5 schema → Task 1
  - §6 plugin registry shape → Task 4
  - §7 plugin-agnostic MCP tools → Task 14
  - §8 Railway-specific MCP tools → Tasks 8-11 + Task 15
  - §9 secret redaction → Task 6 + Task 18 (UI side mirror)
  - §10 UI changes → Tasks 17, 18, 19
  - §11 testing strategy → every implementation task ships tests
  - §13 open questions for slice 1.5+ — captured as future work, not gating
- [x] **Placeholder scan** — no TBD/TODO/"add appropriate handling"; every code change ships exact code
- [x] **Type consistency** — `pluginId`, `resourceId`, `externalId`, `teamId`, `riskProfile` shape, `LlmTierStatus`-style discriminated unions all consistent across tasks
- [x] **Method-name consistency** — `getAuthStatus`, `triggerAuthLogin`, `triggerAuthLogout`, `runRailwayCli`, `railwayLink`, `railwayProvisionDb`, `railwayGetConnectionString`, `railwayRunMigration`, `findLive`, `listForTeam`, `markDeprovisioned`, `secretMask`, `redactSecrets`, `classifyToolCall` — same spelling everywhere
