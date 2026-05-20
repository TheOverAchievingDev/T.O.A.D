import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCrossTeamPrefix,
  formatCrossTeamText,
  parseCrossTeamPrefix,
  stripCrossTeamPrefix,
  CROSS_TEAM_SOURCE,
  CROSS_TEAM_SENT_SOURCE,
} from '../src/protocol/crossTeam.js';

test('formatCrossTeamPrefix builds canonical metadata tag', () => {
  const prefix = formatCrossTeamPrefix('team-a.lead', 0);
  assert.equal(prefix, '<cross-team from="team-a.lead" depth="0" />');
});

test('formatCrossTeamPrefix includes conversationId when provided', () => {
  const prefix = formatCrossTeamPrefix('team-a.lead', 1, { conversationId: 'conv-1' });
  assert.ok(prefix.includes('conversationId="conv-1"'));
  assert.ok(prefix.includes('depth="1"'));
});

test('formatCrossTeamPrefix includes replyToConversationId when provided', () => {
  const prefix = formatCrossTeamPrefix('team-b.worker', 2, {
    conversationId: 'conv-2',
    replyToConversationId: 'conv-1',
  });
  assert.ok(prefix.includes('replyToConversationId="conv-1"'));
  assert.ok(prefix.includes('conversationId="conv-2"'));
});

test('formatCrossTeamPrefix escapes special characters in from field', () => {
  const prefix = formatCrossTeamPrefix('team-a."lead"', 0);
  assert.ok(prefix.includes('from="team-a.&quot;lead&quot;"'));
});

test('formatCrossTeamText builds prefix + body', () => {
  const text = formatCrossTeamText('team-a.lead', 0, 'Hello from team-a.');
  assert.equal(text, '<cross-team from="team-a.lead" depth="0" />\nHello from team-a.');
});

test('parseCrossTeamPrefix extracts metadata from prefix line', () => {
  const text = '<cross-team from="team-a.lead" depth="0" />\nHello from team-a.';
  const parsed = parseCrossTeamPrefix(text);
  assert.ok(parsed);
  assert.equal(parsed.from, 'team-a.lead');
  assert.equal(parsed.chainDepth, 0);
  assert.equal(parsed.conversationId, undefined);
});

test('parseCrossTeamPrefix extracts conversationId and replyToConversationId', () => {
  const text = '<cross-team from="team-b.worker" depth="2" conversationId="conv-2" replyToConversationId="conv-1" />\nBody.';
  const parsed = parseCrossTeamPrefix(text);
  assert.ok(parsed);
  assert.equal(parsed.from, 'team-b.worker');
  assert.equal(parsed.chainDepth, 2);
  assert.equal(parsed.conversationId, 'conv-2');
  assert.equal(parsed.replyToConversationId, 'conv-1');
});

test('parseCrossTeamPrefix returns null for non-cross-team text', () => {
  assert.equal(parseCrossTeamPrefix('Just normal text.'), null);
  assert.equal(parseCrossTeamPrefix(''), null);
});

test('parseCrossTeamPrefix unescapes attribute values', () => {
  const text = '<cross-team from="team-a.&quot;lead&quot;" depth="1" />\nBody.';
  const parsed = parseCrossTeamPrefix(text);
  assert.ok(parsed);
  assert.equal(parsed.from, 'team-a."lead"');
});

test('stripCrossTeamPrefix removes prefix and returns body only', () => {
  const text = '<cross-team from="team-a.lead" depth="0" />\nHello from team-a.';
  assert.equal(stripCrossTeamPrefix(text), 'Hello from team-a.');
});

test('stripCrossTeamPrefix returns unchanged text when no prefix', () => {
  assert.equal(stripCrossTeamPrefix('Just normal text.'), 'Just normal text.');
});

test('source discriminators are correct strings', () => {
  assert.equal(CROSS_TEAM_SOURCE, 'cross_team');
  assert.equal(CROSS_TEAM_SENT_SOURCE, 'cross_team_sent');
});
