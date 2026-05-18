import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SecretRegistry } from '../src/tools/secretSubstitution.js';

describe('SecretRegistry — Slice 2 substitution pipeline', () => {
  test('register returns a token in {{NS_suffix}} form', () => {
    const reg = new SecretRegistry();
    const token = reg.register('DB_url', 'postgres://user:s3cret@host/db');
    assert.match(token, /^\{\{DB_url_[0-9a-f]{8}\}\}$/);
  });

  test('registering the same plaintext twice returns the same token (idempotent)', () => {
    const reg = new SecretRegistry();
    const t1 = reg.register('RAILWAY', 'secret-value');
    const t2 = reg.register('RAILWAY', 'secret-value');
    assert.equal(t1, t2);
  });

  test('resolve returns the plaintext for a known token', () => {
    const reg = new SecretRegistry();
    const token = reg.register('API_KEY', 'sk-abc123');
    assert.equal(reg.resolve(token), 'sk-abc123');
  });

  test('resolve returns null for an unknown token', () => {
    const reg = new SecretRegistry();
    assert.equal(reg.resolve('{{UNKNOWN_deadbeef}}'), null);
  });

  test('substitute replaces tokens in a string', () => {
    const reg = new SecretRegistry();
    const token = reg.register('DB_url', 'postgres://secret');
    const input = `connection: ${token} and backup: ${token}`;
    const result = reg.substitute(input);
    assert.equal(result, 'connection: postgres://secret and backup: postgres://secret');
  });

  test('substitute leaves unknown tokens as-is', () => {
    const reg = new SecretRegistry();
    const text = 'value: {{MISSING_cafebabe}}';
    assert.equal(reg.substitute(text), text);
  });

  test('substitute passes through non-string values unchanged', () => {
    const reg = new SecretRegistry();
    assert.equal(reg.substitute(null), null);
    assert.equal(reg.substitute(42), 42);
  });

  test('redactForAudit replaces plaintext with token', () => {
    const reg = new SecretRegistry();
    const token = reg.register('SECRET', 'hunter2_password_long_enough');
    const log = 'Connecting with hunter2_password_long_enough to db';
    const redacted = reg.redactForAudit(log);
    assert.ok(redacted.includes(token), `Expected token in: ${redacted}`);
    assert.ok(!redacted.includes('hunter2_password_long_enough'));
  });

  test('redactForAudit skips very short values (< 8 chars)', () => {
    const reg = new SecretRegistry();
    reg.register('SHORT', 'abc');
    assert.equal(reg.redactForAudit('abc'), 'abc'); // short secrets not redacted
  });

  test('size reflects registered secret count', () => {
    const reg = new SecretRegistry();
    assert.equal(reg.size, 0);
    reg.register('A', 'secret-one-long-enough');
    reg.register('B', 'secret-two-long-enough');
    assert.equal(reg.size, 2);
    reg.register('A', 'secret-one-long-enough'); // idempotent
    assert.equal(reg.size, 2);
  });

  test('clear wipes all secrets and tokens', () => {
    const reg = new SecretRegistry();
    const token = reg.register('X', 'my-long-secret-value');
    assert.equal(reg.size, 1);
    reg.clear();
    assert.equal(reg.size, 0);
    assert.equal(reg.resolve(token), null);
    const text = `use ${token}`;
    assert.equal(reg.substitute(text), text); // token not resolved after clear
  });

  test('register throws on empty plaintext', () => {
    const reg = new SecretRegistry();
    assert.throws(() => reg.register('NS', ''), /plaintext must be a non-empty string/);
    assert.throws(() => reg.register('NS', 42), /plaintext must be a non-empty string/);
  });
});
