import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  applyPermissionSuggestions,
  addPermissionRules,
  buildWorkspaceIsolationRules,
  writeWorkspaceIsolationSettings,
  assertWorkspaceIsolated,
  buildScrubbedAgentEnv,
} from '../src/runtime/claudeSettingsWriter.js';

describe('claudeSettingsWriter', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toad-settings-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('addPermissionRules', () => {
    it('creates settings file and adds tool names to permissions.allow', async () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      const result = await addPermissionRules({ settingsPath, toolNames: ['Write', 'Edit'], behavior: 'allow' });
      assert.equal(result.added, 2);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.deepStrictEqual(settings.permissions.allow, ['Write', 'Edit']);
    });

    it('does not duplicate existing tool names', async () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      const dir = path.dirname(settingsPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['Write'] },
      }));

      const result = await addPermissionRules({ settingsPath, toolNames: ['Write', 'Edit'], behavior: 'allow' });
      assert.equal(result.added, 1);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.deepStrictEqual(settings.permissions.allow, ['Write', 'Edit']);
    });

    it('preserves existing settings keys', async () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      const dir = path.dirname(settingsPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        permissions: { allow: ['Read'] },
      }));

      await addPermissionRules({ settingsPath, toolNames: ['Write'], behavior: 'allow' });

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.equal(settings.model, 'claude-sonnet-4-20250514');
      assert.deepStrictEqual(settings.permissions.allow, ['Read', 'Write']);
    });

    it('writes to permissions.deny when behavior is deny', async () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      const result = await addPermissionRules({ settingsPath, toolNames: ['Bash'], behavior: 'deny' });
      assert.equal(result.added, 1);

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.deepStrictEqual(settings.permissions.deny, ['Bash']);
    });

    it('returns zero when all tools already exist', async () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      const dir = path.dirname(settingsPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['Write', 'Edit'] },
      }));

      const result = await addPermissionRules({ settingsPath, toolNames: ['Write', 'Edit'], behavior: 'allow' });
      assert.equal(result.added, 0);
    });

    it('does not write file when nothing is added', async () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      const dir = path.dirname(settingsPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['Write'] },
      }));
      const before = fs.statSync(settingsPath).mtimeMs;

      // Small delay to detect mtime change
      await new Promise((r) => setTimeout(r, 50));
      await addPermissionRules({ settingsPath, toolNames: ['Write'], behavior: 'allow' });
      const after = fs.statSync(settingsPath).mtimeMs;
      assert.equal(before, after);
    });
  });

  describe('applyPermissionSuggestions', () => {
    it('applies addRules suggestion', async () => {
      const result = await applyPermissionSuggestions({
        projectCwd: tmpDir,
        suggestions: [
          {
            type: 'addRules',
            rules: [{ toolName: 'Write' }, { toolName: 'Edit' }],
            behavior: 'allow',
            destination: 'localSettings',
          },
        ],
      });

      assert.ok(result.applied > 0);

      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.ok(settings.permissions.allow.includes('Write'));
      assert.ok(settings.permissions.allow.includes('Edit'));
    });

    it('translates setMode acceptEdits into Edit/Write/NotebookEdit rules', async () => {
      await applyPermissionSuggestions({
        projectCwd: tmpDir,
        suggestions: [
          { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
        ],
      });

      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.ok(settings.permissions.allow.includes('Edit'));
      assert.ok(settings.permissions.allow.includes('Write'));
      assert.ok(settings.permissions.allow.includes('NotebookEdit'));
    });

    it('translates setMode bypassPermissions into broad tool list', async () => {
      await applyPermissionSuggestions({
        projectCwd: tmpDir,
        suggestions: [
          { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
        ],
      });

      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      for (const tool of ['Edit', 'Write', 'NotebookEdit', 'Bash', 'Read', 'Grep', 'Glob']) {
        assert.ok(settings.permissions.allow.includes(tool), `expected ${tool} in allow list`);
      }
    });

    it('skips suggestions with empty rules arrays', async () => {
      const result = await applyPermissionSuggestions({
        projectCwd: tmpDir,
        suggestions: [
          { type: 'addRules', rules: [], behavior: 'allow', destination: 'localSettings' },
        ],
      });
      assert.equal(result.applied, 0);
    });

    it('skips unsupported suggestion types', async () => {
      const result = await applyPermissionSuggestions({
        projectCwd: tmpDir,
        suggestions: [
          { type: 'unknown_type' },
        ],
      });
      assert.equal(result.applied, 0);
    });

    it('returns zero applied for empty suggestions', async () => {
      const result = await applyPermissionSuggestions({
        projectCwd: tmpDir,
        suggestions: [],
      });
      assert.equal(result.applied, 0);
    });

    it('applies multiple suggestions cumulatively', async () => {
      await applyPermissionSuggestions({
        projectCwd: tmpDir,
        suggestions: [
          { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' },
          { type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'localSettings' },
        ],
      });

      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.ok(settings.permissions.allow.includes('Bash'));
      assert.ok(settings.permissions.allow.includes('Write'));
    });
  });

  describe('buildWorkspaceIsolationRules', () => {
    // Per PROJECT.md §4: agents must never read or write outside their
    // workspace. The native CLI tools stay enabled — we constrain them
    // via deny rules naming specific outside-the-workspace paths.

    const PATH_AWARE_TOOLS = ['Read', 'Edit', 'Write', 'NotebookEdit', 'Grep', 'Glob', 'Bash'];

    it('throws when projectCwd is missing', () => {
      assert.throws(
        () => buildWorkspaceIsolationRules({ installDir: '/c/install' }),
        /projectCwd required/,
      );
    });

    it('throws when installDir is missing', () => {
      assert.throws(
        () => buildWorkspaceIsolationRules({ projectCwd: '/c/workspace' }),
        /installDir required/,
      );
    });

    it('emits one rule per path-aware tool for the install directory', () => {
      const rules = buildWorkspaceIsolationRules({
        projectCwd: '/c/workspace',
        installDir: '/c/install',
        platform: 'linux',
      });
      for (const tool of PATH_AWARE_TOOLS) {
        assert.ok(
          rules.includes(`${tool}(/c/install/**)`),
          `expected ${tool}(/c/install/**) in rules, got: ${rules.join(', ')}`,
        );
      }
    });

    it('emits one rule per path-aware tool for each extraDeny path', () => {
      const rules = buildWorkspaceIsolationRules({
        projectCwd: '/c/workspace',
        installDir: '/c/install',
        extraDeny: ['/home/user/.ssh', '/home/user/.aws'],
        platform: 'linux',
      });
      for (const tool of PATH_AWARE_TOOLS) {
        assert.ok(rules.includes(`${tool}(/home/user/.ssh/**)`));
        assert.ok(rules.includes(`${tool}(/home/user/.aws/**)`));
      }
    });

    it('never includes projectCwd in deny rules even if passed via extraDeny', () => {
      const rules = buildWorkspaceIsolationRules({
        projectCwd: '/c/workspace',
        installDir: '/c/install',
        extraDeny: ['/c/workspace'], // defensive — caller mistake
        platform: 'linux',
      });
      for (const tool of PATH_AWARE_TOOLS) {
        assert.ok(
          !rules.includes(`${tool}(/c/workspace/**)`),
          `workspace path must not appear in deny rules, but ${tool}(/c/workspace/**) did`,
        );
      }
    });

    it('normalizes Windows backslashes to forward slashes in patterns', () => {
      const rules = buildWorkspaceIsolationRules({
        projectCwd: 'C:\\workspace',
        installDir: 'C:\\Project-TOAD\\toad-local',
        platform: 'win32',
      });
      // Backslashes → forward slashes so Claude Code's glob matcher works.
      assert.ok(rules.some((r) => r === 'Read(C:/Project-TOAD/toad-local/**)'));
      assert.ok(!rules.some((r) => r.includes('\\')));
    });

    it('includes Windows system paths on win32 platform', () => {
      const rules = buildWorkspaceIsolationRules({
        projectCwd: 'C:/workspace',
        installDir: 'C:/install',
        platform: 'win32',
      });
      assert.ok(rules.includes('Read(C:/Windows/**)'));
      assert.ok(rules.includes('Bash(C:/Program Files/**)'));
    });

    it('includes POSIX system paths on non-win32 platform', () => {
      const rules = buildWorkspaceIsolationRules({
        projectCwd: '/home/user/workspace',
        installDir: '/opt/symphony',
        platform: 'linux',
      });
      assert.ok(rules.includes('Read(/etc/**)'));
      assert.ok(rules.includes('Read(/sys/**)'));
      assert.ok(rules.includes('Bash(/proc/**)'));
      assert.ok(rules.includes('Read(/root/**)'));
    });

    it('does not leak POSIX paths onto win32 or vice versa', () => {
      const winRules = buildWorkspaceIsolationRules({
        projectCwd: 'C:/workspace',
        installDir: 'C:/install',
        platform: 'win32',
      });
      assert.ok(!winRules.some((r) => r.includes('/etc/')));
      assert.ok(!winRules.some((r) => r.includes('/proc/')));

      const linuxRules = buildWorkspaceIsolationRules({
        projectCwd: '/workspace',
        installDir: '/install',
        platform: 'linux',
      });
      assert.ok(!linuxRules.some((r) => r.includes('C:/Windows')));
      assert.ok(!linuxRules.some((r) => r.includes('Program Files')));
    });

    it('strips trailing slashes from input paths before appending /**', () => {
      const rules = buildWorkspaceIsolationRules({
        projectCwd: '/c/workspace',
        installDir: '/c/install/',
        platform: 'linux',
      });
      assert.ok(rules.includes('Read(/c/install/**)'));
      // No double-slash artifacts like /c/install//**.
      assert.ok(!rules.some((r) => r.includes('//**')));
    });

    it('ignores empty strings in extraDeny', () => {
      const rules = buildWorkspaceIsolationRules({
        projectCwd: '/c/workspace',
        installDir: '/c/install',
        extraDeny: ['', '/home/user/.ssh', ''],
        platform: 'linux',
      });
      // No bare "Read(/**)" rules from the empties.
      assert.ok(!rules.some((r) => r === 'Read(/**)'));
      assert.ok(rules.includes('Read(/home/user/.ssh/**)'));
    });
  });

  describe('writeWorkspaceIsolationSettings', () => {
    it('writes deny rules into .claude/settings.local.json', async () => {
      const result = await writeWorkspaceIsolationSettings({
        projectCwd: tmpDir,
        installDir: '/c/Project-TOAD/toad-local',
        platform: 'linux',
      });
      assert.ok(result.added > 0);
      assert.ok(Array.isArray(result.rules));
      assert.ok(result.rules.length > 0);

      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      assert.ok(Array.isArray(settings.permissions.deny));
      assert.ok(settings.permissions.deny.includes('Read(/c/Project-TOAD/toad-local/**)'));
      assert.ok(settings.permissions.deny.includes('Bash(/c/Project-TOAD/toad-local/**)'));
    });

    it('is idempotent — second call adds zero new rules', async () => {
      await writeWorkspaceIsolationSettings({
        projectCwd: tmpDir,
        installDir: '/c/install',
        platform: 'linux',
      });
      const second = await writeWorkspaceIsolationSettings({
        projectCwd: tmpDir,
        installDir: '/c/install',
        platform: 'linux',
      });
      assert.equal(second.added, 0);
    });

    it('preserves pre-existing allow entries when writing deny rules', async () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        permissions: { allow: ['Bash(npm install:*)'] },
      }));

      await writeWorkspaceIsolationSettings({
        projectCwd: tmpDir,
        installDir: '/c/install',
        platform: 'linux',
      });

      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      // allow list untouched
      assert.deepStrictEqual(settings.permissions.allow, ['Bash(npm install:*)']);
      // deny list now populated
      assert.ok(settings.permissions.deny.includes('Read(/c/install/**)'));
    });

    it('merges with existing deny entries without duplicating', async () => {
      const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify({
        permissions: { deny: ['Read(/c/install/**)', 'Bash(rm -rf:*)'] },
      }));

      const result = await writeWorkspaceIsolationSettings({
        projectCwd: tmpDir,
        installDir: '/c/install',
        platform: 'linux',
      });
      // Pre-existing Read(/c/install/**) is not re-added.
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
      const readInstallCount = settings.permissions.deny.filter(
        (r) => r === 'Read(/c/install/**)',
      ).length;
      assert.equal(readInstallCount, 1);
      // Custom Bash(rm -rf:*) survives.
      assert.ok(settings.permissions.deny.includes('Bash(rm -rf:*)'));
      // And the new rules landed (6 path-aware tools × the install dir,
      // minus the one Read rule that pre-existed, plus the system paths).
      assert.ok(result.added > 0);
    });
  });

  describe('assertWorkspaceIsolated', () => {
    // PROJECT.md §4 — hard refusal. Any path overlap between workspace
    // and Symphony's install dir means agents could see Symphony.
    // The assertion throws clearly before any agent spawns.

    it('passes when projectCwd and installDir are wholly disjoint', () => {
      assert.doesNotThrow(() =>
        assertWorkspaceIsolated({
          projectCwd: '/home/user/projects/harvest',
          installDir: '/opt/symphony',
          platform: 'linux',
        }),
      );
    });

    it('throws when projectCwd is missing', () => {
      assert.throws(
        () => assertWorkspaceIsolated({ installDir: '/opt/symphony', platform: 'linux' }),
        /projectCwd is missing/,
      );
    });

    it('throws when installDir is missing', () => {
      assert.throws(
        () => assertWorkspaceIsolated({ projectCwd: '/home/user/p', platform: 'linux' }),
        /installDir is missing/,
      );
    });

    it('throws when projectCwd equals installDir', () => {
      assert.throws(
        () => assertWorkspaceIsolated({
          projectCwd: '/c/Project-TOAD/toad-local',
          installDir: '/c/Project-TOAD/toad-local',
          platform: 'linux',
        }),
        /equals Symphony's install dir/,
      );
    });

    it('throws when projectCwd equals installDir case-insensitively on Windows', () => {
      assert.throws(
        () => assertWorkspaceIsolated({
          projectCwd: 'C:\\Project-TOAD\\toad-local',
          installDir: 'c:/project-toad/TOAD-LOCAL',
          platform: 'win32',
        }),
        /equals Symphony's install dir/,
      );
    });

    it('treats case as significant on POSIX', () => {
      // Linux filesystems are case-sensitive — /Symphony and /symphony
      // are different paths. The assertion must not collapse them.
      assert.doesNotThrow(() =>
        assertWorkspaceIsolated({
          projectCwd: '/home/user/Symphony',
          installDir: '/home/user/symphony',
          platform: 'linux',
        }),
      );
    });

    it('throws when projectCwd is inside installDir', () => {
      assert.throws(
        () => assertWorkspaceIsolated({
          projectCwd: '/c/Project-TOAD/toad-local/sub-project',
          installDir: '/c/Project-TOAD/toad-local',
          platform: 'linux',
        }),
        /is inside Symphony's install dir/,
      );
    });

    it('throws when installDir is inside projectCwd', () => {
      assert.throws(
        () => assertWorkspaceIsolated({
          projectCwd: '/c/big-monorepo',
          installDir: '/c/big-monorepo/vendor/symphony',
          platform: 'linux',
        }),
        /is inside projectCwd/,
      );
    });

    it('does not match sibling paths sharing a prefix', () => {
      // /opt/symphony-data vs /opt/symphony — first 8 chars match but
      // they're siblings, not parent/child.
      assert.doesNotThrow(() =>
        assertWorkspaceIsolated({
          projectCwd: '/opt/symphony-data',
          installDir: '/opt/symphony',
          platform: 'linux',
        }),
      );
    });

    it('throws when projectCwd is not absolute', () => {
      assert.throws(
        () => assertWorkspaceIsolated({
          projectCwd: 'relative/path',
          installDir: '/opt/symphony',
          platform: 'linux',
        }),
        /must be an absolute path/,
      );
    });

    it('throws when installDir is not absolute', () => {
      assert.throws(
        () => assertWorkspaceIsolated({
          projectCwd: '/home/user/p',
          installDir: 'relative/install',
          platform: 'linux',
        }),
        /must be an absolute path/,
      );
    });

    it('normalizes Windows backslashes for the comparison', () => {
      assert.throws(
        () => assertWorkspaceIsolated({
          projectCwd: 'C:\\Project-TOAD\\toad-local\\sub',
          installDir: 'C:/Project-TOAD/toad-local',
          platform: 'win32',
        }),
        /is inside Symphony's install dir/,
      );
    });
  });

  describe('buildScrubbedAgentEnv', () => {
    // Even with the right cwd, agents inherit env vars by default. The
    // sidecar's process.env leaks Symphony's location via PWD,
    // INIT_CWD, TOAD_PROJECT_CWD, TOAD_INSTALL_DIR, npm_*, etc.
    // buildScrubbedAgentEnv forwards only a known-safe allow-list.

    it('drops sidecar leak vars (TOAD_*, PWD, INIT_CWD, npm_*, SYMPHONY_*)', () => {
      const out = buildScrubbedAgentEnv({
        platform: 'linux',
        parentEnv: {
          PATH: '/usr/bin',
          HOME: '/home/u',
          TOAD_PROJECT_CWD: '/c/leaky',
          TOAD_INSTALL_DIR: '/c/Project-TOAD/toad-local',
          TOAD_API_PORT: '3001',
          TOAD_DB_PATH: '/c/leaky/.toad/toad.db',
          SYMPHONY_FOUNDRY_DB_PATH: '/c/leaky/.symphony/foundry.db',
          PWD: '/c/Project-TOAD/toad-local',
          INIT_CWD: '/c/Project-TOAD/toad-local',
          npm_package_name: 'symphony-engine',
          npm_config_local_prefix: '/c/Project-TOAD/toad-local',
          npm_lifecycle_script: 'node scripts/dev-api-server.mjs',
        },
      });
      assert.equal(out.PATH, '/usr/bin');
      assert.equal(out.HOME, '/home/u');
      assert.equal(out.TOAD_PROJECT_CWD, undefined);
      assert.equal(out.TOAD_INSTALL_DIR, undefined);
      assert.equal(out.TOAD_API_PORT, undefined);
      assert.equal(out.TOAD_DB_PATH, undefined);
      assert.equal(out.SYMPHONY_FOUNDRY_DB_PATH, undefined);
      assert.equal(out.PWD, undefined);
      assert.equal(out.INIT_CWD, undefined);
      assert.equal(out.npm_package_name, undefined);
      assert.equal(out.npm_config_local_prefix, undefined);
      assert.equal(out.npm_lifecycle_script, undefined);
    });

    it('forwards provider auth vars so the CLI can authenticate', () => {
      const out = buildScrubbedAgentEnv({
        platform: 'linux',
        parentEnv: {
          PATH: '/usr/bin',
          ANTHROPIC_API_KEY: 'sk-ant-xxx',
          OPENAI_API_KEY: 'sk-oai-yyy',
        },
      });
      assert.equal(out.ANTHROPIC_API_KEY, 'sk-ant-xxx');
      assert.equal(out.OPENAI_API_KEY, 'sk-oai-yyy');
    });

    it('forwards Windows-specific allow-list vars on win32', () => {
      const out = buildScrubbedAgentEnv({
        platform: 'win32',
        parentEnv: {
          PATH: 'C:\\Windows;C:\\bin',
          APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
          LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
          USERPROFILE: 'C:\\Users\\u',
          SYSTEMROOT: 'C:\\Windows',
          PATHEXT: '.EXE;.CMD;.BAT',
        },
      });
      assert.equal(out.APPDATA, 'C:\\Users\\u\\AppData\\Roaming');
      assert.equal(out.LOCALAPPDATA, 'C:\\Users\\u\\AppData\\Local');
      assert.equal(out.USERPROFILE, 'C:\\Users\\u');
      assert.equal(out.SYSTEMROOT, 'C:\\Windows');
      assert.equal(out.PATHEXT, '.EXE;.CMD;.BAT');
    });

    it('drops Windows-only vars when running on POSIX', () => {
      // Defensive: should the parent env contain APPDATA on Linux (it
      // shouldn't), don't forward it as a courtesy.
      const out = buildScrubbedAgentEnv({
        platform: 'linux',
        parentEnv: {
          PATH: '/usr/bin',
          APPDATA: '/should/not/exist',
        },
      });
      assert.equal(out.APPDATA, undefined);
    });

    it('honors caller additions (override allow-list)', () => {
      const out = buildScrubbedAgentEnv({
        platform: 'linux',
        parentEnv: { PATH: '/usr/bin', PWD: '/leak' },
        additions: { CLAUDE_CONFIG_DIR: '/tmp/conf', PWD: '/intentional' },
      });
      // Caller's CLAUDE_CONFIG_DIR is forwarded even though it's not in
      // the allow-list — explicit additions win.
      assert.equal(out.CLAUDE_CONFIG_DIR, '/tmp/conf');
      // Caller's PWD overrides the (scrubbed-away) parent PWD.
      assert.equal(out.PWD, '/intentional');
    });

    it('ignores non-string values in parentEnv', () => {
      // process.env can sometimes have weird shapes after monkey-patching;
      // defensive code path.
      const out = buildScrubbedAgentEnv({
        platform: 'linux',
        parentEnv: { PATH: '/usr/bin', HOME: undefined, USER: 42 },
      });
      assert.equal(out.PATH, '/usr/bin');
      assert.equal(out.HOME, undefined);
      assert.equal(out.USER, undefined);
    });

    it('forwards XDG_* on POSIX but not on Windows', () => {
      const posix = buildScrubbedAgentEnv({
        platform: 'linux',
        parentEnv: { PATH: '/usr/bin', XDG_CONFIG_HOME: '/home/u/.config' },
      });
      assert.equal(posix.XDG_CONFIG_HOME, '/home/u/.config');

      const win = buildScrubbedAgentEnv({
        platform: 'win32',
        parentEnv: { PATH: 'C:\\bin', XDG_CONFIG_HOME: '/should/be/dropped' },
      });
      assert.equal(win.XDG_CONFIG_HOME, undefined);
    });
  });
});
