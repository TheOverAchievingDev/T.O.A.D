import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyFilePath,
  classifyReadBuffer,
  isBinaryBuffer,
} from '../src/ide/fileClassification.js';

test('classifyFilePath maps common project files to Monaco language hints', () => {
  assert.deepEqual(classifyFilePath('src/app.py'), {
    category: 'text',
    editable: true,
    previewable: false,
    binary: false,
    languageHint: 'python',
    reason: null,
  });
  assert.equal(classifyFilePath('Dockerfile').languageHint, 'dockerfile');
  assert.equal(classifyFilePath('.env.local').languageHint, 'dotenv');
  assert.equal(classifyFilePath('package-lock.json').languageHint, 'json');
  assert.equal(classifyFilePath('Makefile').languageHint, 'makefile');
  assert.equal(classifyFilePath('README.mdx').languageHint, 'mdx');
});

test('classifyFilePath marks known non-text files unsupported without image preview support', () => {
  const png = classifyFilePath('assets/logo.png');
  assert.equal(png.category, 'unsupported');
  assert.equal(png.editable, false);
  assert.equal(png.previewable, false);
  assert.equal(png.binary, true);
  assert.match(png.reason, /not editable/i);

  const zip = classifyFilePath('release/app.zip');
  assert.equal(zip.category, 'unsupported');
  assert.equal(zip.binary, true);
});

test('classifyReadBuffer keeps unknown UTF-8 files editable as plaintext', () => {
  const result = classifyReadBuffer({
    relativePath: 'notes.custom',
    bytes: Buffer.from('plain text\n', 'utf8'),
    maxBytes: 1024,
  });
  assert.equal(result.category, 'text');
  assert.equal(result.editable, true);
  assert.equal(result.languageHint, 'plaintext');
  assert.equal(result.reason, null);
});

test('classifyReadBuffer marks binary and oversized content as non-editable', () => {
  assert.equal(isBinaryBuffer(Buffer.from([0x01, 0x00, 0x02])), true);

  const binary = classifyReadBuffer({
    relativePath: 'blob.bin',
    bytes: Buffer.from([0x01, 0x00, 0x02]),
    maxBytes: 1024,
  });
  assert.equal(binary.category, 'binary');
  assert.equal(binary.editable, false);
  assert.equal(binary.binary, true);

  const large = classifyReadBuffer({
    relativePath: 'huge.log',
    bytes: Buffer.from('a'.repeat(8), 'utf8'),
    maxBytes: 4,
  });
  assert.equal(large.category, 'readonly_text');
  assert.equal(large.editable, false);
  assert.equal(large.binary, false);
  assert.match(large.reason, /too large/i);
});
