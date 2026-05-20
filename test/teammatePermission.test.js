import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parsePermissionRequest } from '../src/runtime/parsePermissionRequest.js';
import { InMemoryApprovalBroker } from '../src/approval/inMemoryApprovalBroker.js';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { InMemoryTaskBoard } from '../src/task/inMemoryTaskBoard.js';
import { LocalToolFacade } from '../src/tools/localToolFacade.js';

describe('Teammate permission request end-to-end', () => {
  let tmpDir;
  let broker;
  let taskBoard;
  let approvalBroker;
  let adapters;

  const TEAM_ID = 'team-alpha';
  const AGENT_ID = 'worker-1';
  const RUNTIME_ID = 'runtime-lead-1';

  // The raw JSON a teammate runtime sends through its inbox
  const teammatePermissionRequestText = JSON.stringify({
    type: 'permission_request',
    request_id: 'perm-req-001',
    agent_id: 'worker-1',
    tool_name: 'Write',
    tool_use_id: 'toolu_abc',
    description: 'Write to README.md',
    input: { file_path: 'README.md', content: '# Updated' },
    permission_suggestions: [
      {
        type: 'addRules',
        rules: [{ toolName: 'Write' }],
        behavior: 'allow',
        destination: 'localSettings',
      },
    ],
  });

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'toad-teammate-perm-'));
    broker = new InMemoryBroker();
    taskBoard = new InMemoryTaskBoard();
    approvalBroker = new InMemoryApprovalBroker();
    adapters = new Map();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('parses a teammate permission_request from text and persists it as an approval', () => {
    const parsed = parsePermissionRequest(teammatePermissionRequestText);
    assert.ok(parsed, 'should parse successfully');

    // Create an approval record with teammate source metadata
    const approval = approvalBroker.requestApproval({
      approvalId: parsed.requestId,
      teamId: TEAM_ID,
      agentId: parsed.agentId,
      runtimeId: RUNTIME_ID,
      prompt: `Approve ${parsed.toolName}`,
      metadata: {
        source: 'teammate',
        toolName: parsed.toolName,
        toolUseId: parsed.toolUseId,
        input: parsed.input,
        permissionSuggestions: parsed.permissionSuggestions,
      },
    });

    assert.equal(approval.status, 'pending');
    assert.equal(approval.metadata.source, 'teammate');
    assert.deepStrictEqual(approval.metadata.permissionSuggestions, parsed.permissionSuggestions);

    // Verify it appears in the pending list
    const pending = approvalBroker.listApprovals({ teamId: TEAM_ID });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].status, 'pending');
  });

  it('approval_respond with approved applies rules to settings file', async () => {
    const parsed = parsePermissionRequest(teammatePermissionRequestText);

    // Persist approval with teammate metadata
    approvalBroker.requestApproval({
      approvalId: parsed.requestId,
      teamId: TEAM_ID,
      agentId: parsed.agentId,
      runtimeId: RUNTIME_ID,
      prompt: `Approve ${parsed.toolName}`,
      metadata: {
        source: 'teammate',
        toolName: parsed.toolName,
        toolUseId: parsed.toolUseId,
        input: parsed.input,
        permissionSuggestions: parsed.permissionSuggestions,
      },
    });

    // Build a tool facade with projectCwd pointing at tmp
    const facade = new LocalToolFacade({
      broker,
      taskBoard,
      approvalBroker,
      adapters,
      projectCwd: tmpDir,
    });

    // Approve the teammate permission
    const result = facade.execute({
      commandName: 'approval_respond',
      idempotencyKey: 'idem-approve-001',
      actor: { teamId: TEAM_ID, agentId: 'operator' },
      args: {
        approvalId: parsed.requestId,
        decision: 'approved',
      },
    });

    assert.equal(result.decision, 'approved');
    assert.ok(result.settingsResult, 'should have a settingsResult');

    // The settingsResult is a promise — await it
    const settingsOutcome = await result.settingsResult;
    assert.ok(settingsOutcome.applied > 0, 'should have applied permission rules');

    // Verify the settings file was written
    const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(fs.existsSync(settingsPath), 'settings file should exist');

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.ok(settings.permissions.allow.includes('Write'), 'Write should be in allow list');
  });

  it('approval_respond with denied does not write settings file', () => {
    const parsed = parsePermissionRequest(teammatePermissionRequestText);

    approvalBroker.requestApproval({
      approvalId: parsed.requestId,
      teamId: TEAM_ID,
      agentId: parsed.agentId,
      runtimeId: RUNTIME_ID,
      prompt: `Approve ${parsed.toolName}`,
      metadata: {
        source: 'teammate',
        toolName: parsed.toolName,
        toolUseId: parsed.toolUseId,
        input: parsed.input,
        permissionSuggestions: parsed.permissionSuggestions,
      },
    });

    const facade = new LocalToolFacade({
      broker,
      taskBoard,
      approvalBroker,
      adapters,
      projectCwd: tmpDir,
    });

    const result = facade.execute({
      commandName: 'approval_respond',
      idempotencyKey: 'idem-deny-001',
      actor: { teamId: TEAM_ID, agentId: 'operator' },
      args: {
        approvalId: parsed.requestId,
        decision: 'denied',
        reason: 'Not safe',
      },
    });

    assert.equal(result.decision, 'denied');
    // No settings write for denials
    assert.equal(result.settingsResult, undefined);

    const settingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(!fs.existsSync(settingsPath), 'settings file should not be created on deny');
  });

  it('belt-and-suspenders: sends control_response to lead adapter when available', async () => {
    const parsed = parsePermissionRequest(teammatePermissionRequestText);

    approvalBroker.requestApproval({
      approvalId: parsed.requestId,
      teamId: TEAM_ID,
      agentId: parsed.agentId,
      runtimeId: RUNTIME_ID,
      prompt: `Approve ${parsed.toolName}`,
      metadata: {
        source: 'teammate',
        toolName: parsed.toolName,
        permissionSuggestions: parsed.permissionSuggestions,
      },
    });

    // Mock adapter that records approve() calls
    const approveCalls = [];
    const mockAdapter = {
      approve(input) {
        approveCalls.push(input);
        return { accepted: true, responseState: 'approval_response_returned', receipt: {} };
      },
    };
    adapters.set(RUNTIME_ID, mockAdapter);

    const facade = new LocalToolFacade({
      broker,
      taskBoard,
      approvalBroker,
      adapters,
      projectCwd: tmpDir,
    });

    const result = facade.execute({
      commandName: 'approval_respond',
      idempotencyKey: 'idem-belt-001',
      actor: { teamId: TEAM_ID, agentId: 'operator' },
      args: {
        approvalId: parsed.requestId,
        decision: 'approved',
      },
    });

    // Await the async settings write to prevent unhandled rejection after cleanup
    if (result.settingsResult && typeof result.settingsResult.then === 'function') {
      await result.settingsResult;
    }

    // Belt-and-suspenders: should also send control_response to lead adapter
    assert.equal(approveCalls.length, 1);
    assert.equal(approveCalls[0].approvalId, parsed.requestId);
    assert.equal(approveCalls[0].decision, 'approved');
  });

  it('no settingsResult when projectCwd is not configured', () => {
    const parsed = parsePermissionRequest(teammatePermissionRequestText);

    approvalBroker.requestApproval({
      approvalId: parsed.requestId,
      teamId: TEAM_ID,
      agentId: parsed.agentId,
      runtimeId: null,
      prompt: `Approve ${parsed.toolName}`,
      metadata: {
        source: 'teammate',
        permissionSuggestions: parsed.permissionSuggestions,
      },
    });

    // No projectCwd
    const facade = new LocalToolFacade({
      broker,
      taskBoard,
      approvalBroker,
      adapters,
    });

    const result = facade.execute({
      commandName: 'approval_respond',
      idempotencyKey: 'idem-nocwd-001',
      actor: { teamId: TEAM_ID, agentId: 'operator' },
      args: {
        approvalId: parsed.requestId,
        decision: 'approved',
      },
    });

    assert.equal(result.decision, 'approved');
    // settingsResult should be null (no projectCwd)
    assert.ok(!result.settingsResult);
  });
});
