import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePermissionRequest } from '../src/runtime/parsePermissionRequest.js';

describe('parsePermissionRequest', () => {
  const validPayload = {
    type: 'permission_request',
    request_id: 'perm-abc-123',
    agent_id: 'worker-1',
    tool_name: 'Write',
    tool_use_id: 'toolu_xyz',
    description: 'Write to README.md',
    input: { file_path: 'README.md', content: '# Hello' },
    permission_suggestions: [
      {
        type: 'addRules',
        rules: [{ toolName: 'Write' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ],
  };

  it('parses a valid permission_request JSON payload', () => {
    const result = parsePermissionRequest(JSON.stringify(validPayload));
    assert.ok(result);
    assert.equal(result.requestId, 'perm-abc-123');
    assert.equal(result.agentId, 'worker-1');
    assert.equal(result.toolName, 'Write');
    assert.equal(result.toolUseId, 'toolu_xyz');
    assert.equal(result.description, 'Write to README.md');
    assert.deepStrictEqual(result.input, { file_path: 'README.md', content: '# Hello' });
    assert.equal(result.permissionSuggestions.length, 1);
    assert.equal(result.permissionSuggestions[0].type, 'addRules');
    assert.deepStrictEqual(result.permissionSuggestions[0].rules, [{ toolName: 'Write' }]);
    assert.equal(result.permissionSuggestions[0].behavior, 'allow');
    assert.equal(result.permissionSuggestions[0].destination, 'localSettings');
  });

  it('returns null for non-JSON text', () => {
    assert.equal(parsePermissionRequest('hello world'), null);
    assert.equal(parsePermissionRequest(''), null);
    assert.equal(parsePermissionRequest('   '), null);
  });

  it('returns null for non-object JSON', () => {
    assert.equal(parsePermissionRequest('"string"'), null);
    assert.equal(parsePermissionRequest('42'), null);
    assert.equal(parsePermissionRequest('[1,2]'), null);
    assert.equal(parsePermissionRequest('true'), null);
    assert.equal(parsePermissionRequest('null'), null);
  });

  it('returns null when type is not permission_request', () => {
    assert.equal(parsePermissionRequest(JSON.stringify({ type: 'idle_notification' })), null);
    assert.equal(parsePermissionRequest(JSON.stringify({ type: 'message' })), null);
    assert.equal(parsePermissionRequest(JSON.stringify({ hello: 'world' })), null);
  });

  it('returns null when request_id is missing', () => {
    const { request_id, ...rest } = validPayload;
    assert.equal(parsePermissionRequest(JSON.stringify(rest)), null);
  });

  it('returns null when agent_id is missing', () => {
    const { agent_id, ...rest } = validPayload;
    assert.equal(parsePermissionRequest(JSON.stringify(rest)), null);
  });

  it('returns null when tool_name is missing', () => {
    const { tool_name, ...rest } = validPayload;
    assert.equal(parsePermissionRequest(JSON.stringify(rest)), null);
  });

  it('defaults optional fields gracefully', () => {
    const minimal = {
      type: 'permission_request',
      request_id: 'req-1',
      agent_id: 'agent-1',
      tool_name: 'Bash',
    };
    const result = parsePermissionRequest(JSON.stringify(minimal));
    assert.ok(result);
    assert.equal(result.toolUseId, '');
    assert.equal(result.description, '');
    assert.deepStrictEqual(result.input, {});
    assert.deepStrictEqual(result.permissionSuggestions, []);
  });

  it('preserves setMode permission suggestions', () => {
    const payload = {
      ...validPayload,
      permission_suggestions: [
        { type: 'setMode', mode: 'acceptEdits', destination: 'session' },
      ],
    };
    const result = parsePermissionRequest(JSON.stringify(payload));
    assert.ok(result);
    assert.equal(result.permissionSuggestions.length, 1);
    assert.equal(result.permissionSuggestions[0].type, 'setMode');
    assert.equal(result.permissionSuggestions[0].mode, 'acceptEdits');
  });

  it('preserves multiple permission suggestions', () => {
    const payload = {
      ...validPayload,
      permission_suggestions: [
        { type: 'addRules', rules: [{ toolName: 'Write' }], behavior: 'allow', destination: 'localSettings' },
        { type: 'setMode', mode: 'bypassPermissions', destination: 'session' },
      ],
    };
    const result = parsePermissionRequest(JSON.stringify(payload));
    assert.ok(result);
    assert.equal(result.permissionSuggestions.length, 2);
  });

  it('handles whitespace-padded input', () => {
    const result = parsePermissionRequest('  ' + JSON.stringify(validPayload) + '  \n');
    assert.ok(result);
    assert.equal(result.requestId, 'perm-abc-123');
  });

  it('handles non-array permission_suggestions by defaulting to empty array', () => {
    const payload = { ...validPayload, permission_suggestions: 'not-an-array' };
    const result = parsePermissionRequest(JSON.stringify(payload));
    assert.ok(result);
    assert.deepStrictEqual(result.permissionSuggestions, []);
  });

  it('handles non-object input field by defaulting to empty object', () => {
    const payload = { ...validPayload, input: 'not-an-object' };
    const result = parsePermissionRequest(JSON.stringify(payload));
    assert.ok(result);
    assert.deepStrictEqual(result.input, {});
  });
});
