import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDemoScreenshotManifest,
  screenshotFileName,
} from '../scripts/demoVideoTools.mjs';

test('demo screenshot manifest covers primary screens, overlays, and settings sections', () => {
  const captures = buildDemoScreenshotManifest();
  const ids = captures.map((capture) => capture.id);

  assert.ok(captures.length >= 28);
  assert.equal(new Set(ids).size, ids.length, 'capture ids must be unique');

  for (const required of [
    'cockpit-for-me',
    'cockpit-with-me',
    'foundry-discovery',
    'code-explorer',
    'tasks-board',
    'drift-monitor',
    'costs',
    'audit',
    'project-picker',
    'create-team',
    'create-task',
    'task-detail',
    'drawer-runtimes',
    'drawer-notifications',
    'settings-general',
    'settings-providers',
    'settings-plugins',
    'settings-advanced',
  ]) {
    assert.ok(ids.includes(required), `missing ${required}`);
  }
});

test('screenshot filenames are stable and filesystem safe', () => {
  assert.equal(screenshotFileName(0, 'Cockpit: FOR me'), '00-cockpit-for-me.png');
  assert.equal(screenshotFileName(12, 'Settings / Risk policies'), '12-settings-risk-policies.png');
});
