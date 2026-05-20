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
