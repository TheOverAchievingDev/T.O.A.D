import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteFoundryStore } from '../src/foundry/sqliteFoundryStore.js';

test('SqliteFoundryStore persists sessions, messages, and artifacts', (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'toad-foundry-'));
  const dbPath = join(tmpDir, 'toad.db');
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const a = new SqliteFoundryStore({ filePath: dbPath });
  const session = a.createSession({
    title: 'Inventory app',
    projectPath: 'C:/project',
    metadata: { source: 'test' },
  });
  a.addMessage({ sessionId: session.sessionId, role: 'user', text: 'Track parts and repairs.' });
  const artifact = a.upsertArtifact({
    sessionId: session.sessionId,
    kind: 'product_brief',
    title: 'Product Brief',
    content: '# Product Brief',
    targetPath: 'docs/foundry/product-brief.md',
  });
  a.close();

  const b = new SqliteFoundryStore({ filePath: dbPath });
  const loaded = b.getSession(session.sessionId);

  assert.ok(loaded);
  assert.equal(loaded.session.title, 'Inventory app');
  assert.equal(loaded.session.projectPath, 'C:/project');
  assert.deepEqual(loaded.session.metadata, { source: 'test' });
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.messages[0].text, 'Track parts and repairs.');
  assert.equal(loaded.artifacts.length, 1);
  assert.equal(loaded.artifacts[0].artifactId, artifact.artifactId);
  assert.equal(loaded.artifacts[0].version, 1);
  b.close();
});

test('SqliteFoundryStore updates existing artifacts with incremented versions', () => {
  const store = new SqliteFoundryStore();
  const session = store.createSession({ sessionId: 'foundry-1', title: 'Build notes' });
  const first = store.upsertArtifact({
    artifactId: 'artifact-1',
    sessionId: session.sessionId,
    kind: 'tech_spec',
    title: 'Tech Spec',
    content: 'v1',
    targetPath: 'docs/foundry/tech-spec.md',
  });
  const second = store.upsertArtifact({
    artifactId: 'artifact-1',
    sessionId: session.sessionId,
    kind: 'tech_spec',
    title: 'Tech Spec',
    content: 'v2',
    targetPath: 'docs/foundry/tech-spec.md',
  });

  assert.equal(first.version, 1);
  assert.equal(second.version, 2);
  assert.equal(store.getSession('foundry-1').artifacts[0].content, 'v2');
  store.close();
});

test('SqliteFoundryStore exports artifacts inside the requested root only', (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'toad-foundry-export-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const store = new SqliteFoundryStore();
  const session = store.createSession({ sessionId: 'foundry-1', title: 'Export test' });
  store.upsertArtifact({
    artifactId: 'artifact-safe',
    sessionId: session.sessionId,
    kind: 'roadmap',
    title: 'Roadmap',
    content: '# Roadmap',
    targetPath: 'docs/foundry/roadmap.md',
  });

  const exported = store.exportArtifacts({ sessionId: session.sessionId, rootDir: tmpDir });

  assert.equal(exported.files.length, 1);
  assert.ok(existsSync(join(tmpDir, 'docs', 'foundry', 'roadmap.md')));
  assert.equal(readFileSync(join(tmpDir, 'docs', 'foundry', 'roadmap.md'), 'utf8'), '# Roadmap');
  assert.equal(store.getSession(session.sessionId).artifacts[0].status, 'exported');
  store.close();
});

test('SqliteFoundryStore rejects artifact export path traversal', (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'toad-foundry-export-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const store = new SqliteFoundryStore();
  const session = store.createSession({ sessionId: 'foundry-1', title: 'Export test' });
  store.upsertArtifact({
    artifactId: 'artifact-bad',
    sessionId: session.sessionId,
    kind: 'tech_spec',
    title: 'Bad',
    content: 'bad',
    targetPath: '../escape.md',
  });

  assert.throws(
    () => store.exportArtifacts({ sessionId: session.sessionId, rootDir: tmpDir }),
    /targetPath escapes export root/
  );
  store.close();
});
