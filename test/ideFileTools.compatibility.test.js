import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listIdeTree, readIdeFile, writeIdeFile } from '../src/ide/ideFileTools.js';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'toad-ide-compat-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'app.py'), 'print("hi")\n');
  writeFileSync(join(dir, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]));
  writeFileSync(join(dir, 'huge.log'), 'abcdef');
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('listIdeTree includes language and compatibility metadata', () => {
  const f = fixture();
  try {
    const tree = listIdeTree({ projectCwd: f.dir, teamId: 'team-a' });
    const py = tree.entries.find((e) => e.path === 'src/app.py');
    const png = tree.entries.find((e) => e.path === 'image.png');
    assert.equal(py.languageHint, 'python');
    assert.equal(py.category, 'text');
    assert.equal(py.editable, true);
    assert.equal(png.category, 'unsupported');
    assert.equal(png.editable, false);
    assert.equal(png.binary, true);
  } finally {
    f.cleanup();
  }
});

test('readIdeFile returns editable UTF-8 content with metadata', () => {
  const f = fixture();
  try {
    const file = readIdeFile({ projectCwd: f.dir, teamId: 'team-a', relativePath: 'src/app.py' });
    assert.equal(file.kind, 'text');
    assert.equal(file.languageHint, 'python');
    assert.equal(file.editable, true);
    assert.equal(file.content, 'print("hi")\n');
  } finally {
    f.cleanup();
  }
});

test('readIdeFile returns unsupported metadata for binary files instead of throwing', () => {
  const f = fixture();
  try {
    const file = readIdeFile({ projectCwd: f.dir, teamId: 'team-a', relativePath: 'image.png' });
    assert.equal(file.kind, 'unsupported');
    assert.equal(file.editable, false);
    assert.equal(file.binary, true);
    assert.equal(file.content, undefined);
    assert.match(file.reason, /not editable|binary/i);
  } finally {
    f.cleanup();
  }
});

test('readIdeFile returns oversized readonly metadata for large text files', () => {
  const f = fixture();
  try {
    const file = readIdeFile({
      projectCwd: f.dir,
      teamId: 'team-a',
      relativePath: 'huge.log',
      maxBytes: 4,
    });
    assert.equal(file.kind, 'unsupported');
    assert.equal(file.category, 'readonly_text');
    assert.equal(file.editable, false);
    assert.equal(file.binary, false);
    assert.match(file.reason, /too large/i);
  } finally {
    f.cleanup();
  }
});

test('writeIdeFile remains text-only and returns editable read result', () => {
  const f = fixture();
  try {
    const before = readIdeFile({ projectCwd: f.dir, teamId: 'team-a', relativePath: 'src/app.py' });
    const after = writeIdeFile({
      projectCwd: f.dir,
      teamId: 'team-a',
      relativePath: 'src/app.py',
      content: 'print("bye")\n',
      expectedSha256: before.sha256,
    });
    assert.equal(after.kind, 'text');
    assert.equal(after.content, 'print("bye")\n');
  } finally {
    f.cleanup();
  }
});
