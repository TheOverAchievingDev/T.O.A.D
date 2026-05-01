import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  applyPermissionSuggestions,
  addPermissionRules,
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
});
