import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveApiToken } from '../src/runtime/resolveApiToken.js';

function withProjectDir(t, body) {
  const dir = mkdtempSync(join(tmpdir(), 'toad-token-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return body(dir);
}

function snapshotEnv() {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'TOAD_API_TOKEN');
  const prev = process.env.TOAD_API_TOKEN;
  return { had, prev };
}

function restoreEnv(snapshot) {
  if (snapshot.had) {
    process.env.TOAD_API_TOKEN = snapshot.prev;
  } else {
    delete process.env.TOAD_API_TOKEN;
  }
}

test('resolveApiToken returns the explicit token when provided', (t) => {
  const env = snapshotEnv();
  t.after(() => restoreEnv(env));
  process.env.TOAD_API_TOKEN = 'env-token';

  withProjectDir(t, (dir) => {
    mkdirSync(join(dir, '.toad'));
    writeFileSync(join(dir, '.toad', 'api-token'), 'file-token');

    assert.equal(resolveApiToken({ explicit: 'explicit-token', projectCwd: dir }), 'explicit-token');
  });
});

test('resolveApiToken returns env var when explicit is missing', (t) => {
  const env = snapshotEnv();
  t.after(() => restoreEnv(env));
  process.env.TOAD_API_TOKEN = 'env-token';

  withProjectDir(t, (dir) => {
    mkdirSync(join(dir, '.toad'));
    writeFileSync(join(dir, '.toad', 'api-token'), 'file-token');

    assert.equal(resolveApiToken({ projectCwd: dir }), 'env-token');
  });
});

test('resolveApiToken returns file contents when env and explicit are missing', (t) => {
  const env = snapshotEnv();
  t.after(() => restoreEnv(env));
  delete process.env.TOAD_API_TOKEN;

  withProjectDir(t, (dir) => {
    mkdirSync(join(dir, '.toad'));
    writeFileSync(join(dir, '.toad', 'api-token'), '   file-token\n');

    assert.equal(resolveApiToken({ projectCwd: dir }), 'file-token');
  });
});

test('resolveApiToken returns null when nothing is configured', (t) => {
  const env = snapshotEnv();
  t.after(() => restoreEnv(env));
  delete process.env.TOAD_API_TOKEN;

  withProjectDir(t, (dir) => {
    assert.equal(resolveApiToken({ projectCwd: dir }), null);
  });
});

test('resolveApiToken skips the file lookup when projectCwd is not provided', (t) => {
  const env = snapshotEnv();
  t.after(() => restoreEnv(env));
  delete process.env.TOAD_API_TOKEN;

  assert.equal(resolveApiToken({}), null);
});
