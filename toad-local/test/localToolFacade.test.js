import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { COMMANDS } from '../src/commands/command-contract.js';
import { InMemoryTaskBoard, TASK_EVENT_TYPES, TASK_STATUS } from '../src/task/inMemoryTaskBoard.js';
import { LocalToolFacade } from '../src/tools/localToolFacade.js';
import { SettingsStore } from '../src/settings/settingsStore.js';
import { RiskPolicyStore } from '../src/policy/riskPolicyStore.js';
import { SqliteFoundryStore } from '../src/foundry/sqliteFoundryStore.js';
import { TeamConfigRegistry } from '../src/team/teamConfig.js';

function createFacade() {
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const runtimeRegistry = {
    getRuntime(runtimeId) {
      if (runtimeId !== 'runtime-lead-1') return null;
      return {
        runtimeId,
        teamId: 'team-a',
        agentId: 'lead',
        status: 'running',
      };
    },
    listRuntimes({ teamId }) {
      return [
        {
          runtimeId: 'runtime-lead-1',
          teamId,
          agentId: 'lead',
          status: 'running',
        },
        {
          runtimeId: 'runtime-worker-1',
          teamId,
          agentId: 'worker-1',
          status: 'exited',
        },
      ];
    },
  };
  const approvalBroker = {
    responses: [],
    respondApproval(input) {
      this.responses.push(input);
      return {
        approvalId: input.approvalId,
        status: input.decision,
        decision: input.decision,
        reason: input.reason || '',
      };
    },
  };
  const readModel = {
    listRuntimeAudit({ teamId, runtimeId }) {
      return [
        {
          eventId: 'event-1',
          teamId,
          runtimeId,
          agentId: 'lead',
          eventType: 'tool_use',
        },
      ];
    },
    listApprovals({ teamId }) {
      return [
        {
          approvalId: 'approval-1',
          teamId,
          agentId: 'lead',
          runtimeId: 'runtime-lead-1',
          prompt: 'Approve Write',
          status: 'pending',
        },
      ];
    },
    listCrossTeamMessages({ teamId, limit }) {
      return [
        {
          id: 'msg-cross-1',
          teamId,
          direction: 'outbound',
          targetTeamId: 'team-b',
          conversationId: 'conv-1',
          text: `Limit ${limit}`,
        },
      ];
    },
  };
  return {
    broker,
    taskBoard,
    runtimeRegistry,
    approvalBroker,
    readModel,
    facade: new LocalToolFacade({ broker, taskBoard, runtimeRegistry, approvalBroker, readModel }),
  };
}

test('LocalToolFacade sends messages through broker', () => {
  const { broker, facade } = createFacade();
  facade.execute({
    commandName: COMMANDS.MESSAGE_SEND,
    idempotencyKey: 'msg-1',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: {
      to: { kind: 'agent', agentId: 'worker-1' },
      text: 'Start on storage.',
    },
  });

  const inbox = broker.listInbox({
    teamId: 'team-a',
    recipient: { kind: 'agent', teamId: 'team-a', agentId: 'worker-1' },
  });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].from.id, 'lead');
});

test('LocalToolFacade task_list returns { tasks: [...] } so MCP clients accept the structuredContent', () => {
  // Claude Code's MCP client treats a top-level array as a schema mismatch
  // when it was expecting an object. Wrapping the array in `{ tasks: [...] }`
  // keeps the response shape consistent with runtime_list ({ runtimes }) and
  // unblocks the lead from using the tool. Field-confirmed regression on
  // 2026-05-03 — the lead reported "task_list tool errored with a schema
  // mismatch" until this wrap landed.
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'wrap-task-1',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'wrap-1', subject: 'check shape' },
  });
  const result = facade.execute({
    commandName: COMMANDS.TASK_LIST,
    actor: { teamId: 'team-a', agentId: 'lead' },
  });
  assert.ok(result && typeof result === 'object' && !Array.isArray(result), 'top-level result must be an object');
  assert.ok(Array.isArray(result.tasks), 'result.tasks must be an array');
  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].taskId, 'wrap-1');
});

test('LocalToolFacade message_send fires the DeliveryWorker so the recipient actually receives it', async () => {
  // Without this, the lead can call message_send all day and the messages
  // sit in the broker forever — DeliveryWorker is what writes the payload
  // to the recipient runtime's stdin via adapter.sendTurn. Confirmed in
  // the field on 2026-05-02: the lead created tasks + sent kickoff
  // messages to teammates, but delivery_attempts table had 0 rows so the
  // teammates never woke up.
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const deliveryCalls = [];
  const fakeDeliveryWorker = {
    async deliverMessage(messageId) {
      deliveryCalls.push(messageId);
      return { status: 'committed', responseState: 'accepted_by_runtime' };
    },
  };
  const facade = new LocalToolFacade({
    broker,
    taskBoard,
    deliveryWorker: fakeDeliveryWorker,
  });

  const result = await facade.execute({
    commandName: COMMANDS.MESSAGE_SEND,
    idempotencyKey: 'msg-deliver',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: {
      to: { kind: 'agent', agentId: 'worker-1' },
      text: 'Pick up CP-001 please.',
    },
  });

  // Broker write happened
  assert.ok(result.message);
  assert.equal(result.message.from.id, 'lead');
  // Delivery was triggered with the message id
  assert.equal(deliveryCalls.length, 1, 'deliveryWorker.deliverMessage must be called once');
  assert.equal(deliveryCalls[0], result.message.messageId);
  // Result includes delivery info so callers can react to delivery state
  assert.ok(result.delivery, 'response must surface delivery result');
});

test('LocalToolFacade message_send still appends when no DeliveryWorker is configured (back-compat)', async () => {
  // Tests + lightweight integrations may not wire a DeliveryWorker. The
  // facade must not throw — it should still write to the broker and
  // return cleanly so the operator gets a sensible response.
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const facade = new LocalToolFacade({ broker, taskBoard });

  const result = await facade.execute({
    commandName: COMMANDS.MESSAGE_SEND,
    idempotencyKey: 'msg-no-delivery',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: {
      to: { kind: 'agent', agentId: 'worker-1' },
      text: 'Standalone test — no delivery worker.',
    },
  });

  assert.ok(result.message, 'should still return the persisted message');
});

test('LocalToolFacade creates Foundry sessions, captures notes, and generates planning artifacts', () => {
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const foundryStore = new SqliteFoundryStore();
  const facade = new LocalToolFacade({ broker, taskBoard, foundryStore, projectCwd: 'C:/project' });

  const session = facade.execute({
    commandName: COMMANDS.FOUNDRY_SESSION_CREATE,
    idempotencyKey: 'foundry-session-1',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { title: 'Repair desk app' },
  });
  facade.execute({
    commandName: COMMANDS.FOUNDRY_MESSAGE_ADD,
    idempotencyKey: 'foundry-message-1',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: {
      sessionId: session.sessionId,
      role: 'user',
      text: 'Build a repair desk app with customers, assets, work orders, and status tracking.',
    },
  });

  const generated = facade.execute({
    commandName: COMMANDS.FOUNDRY_ARTIFACT_GENERATE,
    idempotencyKey: 'foundry-generate-1',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { sessionId: session.sessionId },
  });
  const loaded = facade.execute({
    commandName: COMMANDS.FOUNDRY_SESSION_GET,
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { sessionId: session.sessionId },
  });

  // Default set is the four core docs: brief, tech_spec, roadmap, tasks.
  // The prisma_schema doc is opt-in — only emitted when the chat
  // explicitly produces a `===DOC: prisma_schema===` block (so projects
  // that don't use a database don't get speculative DB schema noise).
  assert.equal(generated.artifacts.length, 4);
  assert.deepEqual(
    generated.artifacts.map((artifact) => artifact.targetPath).sort(),
    [
      'docs/foundry/product-brief.md',
      'docs/foundry/roadmap.md',
      'docs/foundry/task-breakdown.md',
      'docs/foundry/tech-spec.md',
    ]
  );
  assert.equal(loaded.messages.length, 1);
  assert.equal(loaded.artifacts.length, 4);
  assert.match(loaded.artifacts.find((artifact) => artifact.kind === 'product_brief').content, /repair desk app/i);
  foundryStore.close();
});

test('LocalToolFacade exports Foundry artifacts to repo files', async (t) => {
  const projectCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-foundry-facade-'));
  t.after(() => fs.rm(projectCwd, { recursive: true, force: true }));
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const foundryStore = new SqliteFoundryStore();
  const facade = new LocalToolFacade({ broker, taskBoard, foundryStore, projectCwd });

  const session = foundryStore.createSession({ sessionId: 'foundry-1', title: 'Export' });
  foundryStore.upsertArtifact({
    sessionId: session.sessionId,
    artifactId: 'artifact-1',
    kind: 'tech_spec',
    title: 'Tech Spec',
    content: '# Tech Spec',
    targetPath: 'docs/foundry/tech-spec.md',
  });

  const exported = facade.execute({
    commandName: COMMANDS.FOUNDRY_ARTIFACT_EXPORT,
    idempotencyKey: 'foundry-export-1',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { sessionId: session.sessionId },
  });

  assert.equal(exported.files.length, 1);
  assert.equal(
    await fs.readFile(path.join(projectCwd, 'docs', 'foundry', 'tech-spec.md'), 'utf8'),
    '# Tech Spec'
  );
  foundryStore.close();
});

test('LocalToolFacade materializes a Foundry session into repo docs, a team, and starter tasks', async (t) => {
  const projectCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-foundry-project-'));
  t.after(() => fs.rm(projectCwd, { recursive: true, force: true }));
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const foundryStore = new SqliteFoundryStore();
  const teamConfigRegistry = new TeamConfigRegistry();
  const facade = new LocalToolFacade({
    broker,
    taskBoard,
    foundryStore,
    teamConfigRegistry,
    projectCwd,
  });
  const session = foundryStore.createSession({ sessionId: 'foundry-1', title: 'Repair Desk App' });
  foundryStore.upsertArtifact({
    sessionId: session.sessionId,
    artifactId: 'brief',
    kind: 'product_brief',
    title: 'Product Brief',
    content: '# Product Brief',
    targetPath: 'docs/foundry/product-brief.md',
  });
  foundryStore.upsertArtifact({
    sessionId: session.sessionId,
    artifactId: 'tasks',
    kind: 'task_breakdown',
    title: 'TOAD Task Breakdown',
    content: [
      '# Repair Desk App TOAD Task Breakdown',
      '',
      '## Task 1 - Requirements contract',
      '- Deliverable: product brief and acceptance criteria.',
      '- Acceptance: reviewers can map requirements to workflows.',
      '',
      '## Task 2 - Data model',
      '- Deliverable: finalized schema and migration plan.',
    ].join('\n'),
    targetPath: 'docs/foundry/task-breakdown.md',
  });

  const result = await facade.execute({
    commandName: 'foundry_project_materialize',
    idempotencyKey: 'foundry-materialize-1',
    actor: { teamId: 'foundry', agentId: 'operator', role: 'human' },
    args: { sessionId: session.sessionId },
  });

  assert.equal(result.teamId, 'repair-desk-app');
  assert.equal(result.tasks.length, 2);
  assert.equal(result.files.length, 2);
  assert.equal(
    await fs.readFile(path.join(projectCwd, 'docs', 'foundry', 'product-brief.md'), 'utf8'),
    '# Product Brief',
  );
  const team = teamConfigRegistry.getTeam('repair-desk-app');
  assert.equal(team.teamId, 'repair-desk-app');
  assert.equal(team.teammates.length, 4);
  const tasks = taskBoard.listTasks({ teamId: 'repair-desk-app' });
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].taskId, 'T-001');
  assert.equal(tasks[0].subject, 'Requirements contract');
  assert.match(tasks[0].description, /product brief and acceptance criteria/);
  assert.equal(tasks[1].assignedRole, 'developer');
  foundryStore.close();
});

test('LocalToolFacade runs a Foundry chat turn through OpenAI settings and stores the assistant reply', async () => {
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const foundryStore = new SqliteFoundryStore();
  const settingsStore = {
    readEffective() {
      return Promise.resolve({
        providers: {
          providers: [
            { id: 'openai', apiKey: 'sk-test-openai', defaultModel: 'gpt-5.2' },
          ],
        },
      });
    },
  };
  let captured = null;
  const facade = new LocalToolFacade({
    broker,
    taskBoard,
    foundryStore,
    settingsStore,
    openaiFetch: async (url, init) => {
      captured = { url, init };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'resp-1',
          output_text: 'Let us clarify the users, entities, and success criteria first.',
          usage: { input_tokens: 10, output_tokens: 12 },
        }),
      };
    },
  });
  const session = foundryStore.createSession({ sessionId: 'foundry-1', title: 'Repair app' });

  const result = await facade.execute({
    commandName: COMMANDS.FOUNDRY_CHAT_TURN,
    idempotencyKey: 'foundry-chat-1',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: {
      sessionId: session.sessionId,
      text: 'We need work orders and assets.',
    },
  });

  assert.equal(captured.url, 'https://api.openai.com/v1/responses');
  assert.equal(captured.init.headers.Authorization, 'Bearer sk-test-openai');
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, 'gpt-5.2');
  assert.equal(body.store, false);
  assert.match(body.input, /We need work orders and assets/);
  // System prompt now directs the model to emit four ===DOC=== blocks
  // and limit clarifying-question rounds — see FOUNDRY_CHAT_INSTRUCTIONS.
  assert.match(body.instructions, /===DOC: brief===/);
  assert.match(body.instructions, /===DOC: tasks===/);
  assert.match(body.instructions, /clarifying questions/i);
  // Spec-quality upgrade (Kiro-inspired): brief carries EARS-notation
  // requirements (WHEN ... SHALL ...) so they are testable, and tech_spec
  // has explicit design.md-style subsections — component design, sequence/
  // data flow, error handling, testing strategy. Tasks must declare
  // dependencies so the lead can wave them out in order.
  assert.match(body.instructions, /EARS/);
  assert.match(body.instructions, /WHEN .*SHALL/i);
  assert.match(body.instructions, /Component Design/i);
  assert.match(body.instructions, /Sequence|Data Flow/i);
  assert.match(body.instructions, /Error Handling/i);
  assert.match(body.instructions, /Testing Strategy/i);
  assert.match(body.instructions, /Depends on|Dependencies/i);
  // Round-2 kiro-style additions: project-wide steering doc (coding
  // standards / never-dos), ADR log (design_decisions), and a global
  // Definition of Done gate. Each is an additional ===DOC=== block that
  // every agent reads at boot via its system prompt.
  assert.match(body.instructions, /===DOC: steering===/);
  assert.match(body.instructions, /===DOC: design_decisions===/);
  assert.match(body.instructions, /===DOC: definition_of_done===/);
  assert.match(body.instructions, /never-do|never do|forbidden/i);
  assert.equal(result.assistant.text, 'Let us clarify the users, entities, and success criteria first.');
  const loaded = foundryStore.getSession(session.sessionId);
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.messages[0].role, 'user');
  assert.equal(loaded.messages[1].role, 'assistant');
  foundryStore.close();
});

test('LocalToolFacade creates, updates, and comments on tasks', () => {
  const { facade } = createFacade();
  const actor = { teamId: 'team-a', agentId: 'lead' };

  const created = facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'task-create-storage',
    actor,
    args: {
      taskId: 'storage',
      subject: 'Build SQLite storage',
      ownerId: 'worker-1',
    },
  });
  assert.equal(created.ownerId, 'worker-1');

  const updated = facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'task-update-storage-start',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: {
      taskId: 'storage',
      status: TASK_STATUS.IN_PROGRESS,
    },
  });
  assert.equal(updated.status, TASK_STATUS.IN_PROGRESS);

  const commented = facade.execute({
    commandName: COMMANDS.TASK_COMMENT,
    idempotencyKey: 'task-comment-storage',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: {
      taskId: 'storage',
      text: 'SQLite broker is implemented.',
    },
  });
  assert.equal(commented.comments.length, 1);
});

test('LocalToolFacade requests and decides task reviews', () => {
  const { facade } = createFacade();
  const actor = { teamId: 'team-a', agentId: 'lead' };
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'task-create-review',
    actor,
    args: {
      taskId: 'review-me',
      subject: 'Review lifecycle',
    },
  });

  const requested = facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'review-request-1',
    actor,
    args: {
      taskId: 'review-me',
      reviewerId: 'reviewer-1',
    },
  });

  assert.equal(requested.reviewState, 'review');

  const approved = facade.execute({
    commandName: COMMANDS.REVIEW_DECIDE,
    idempotencyKey: 'review-decide-1',
    actor: { teamId: 'team-a', agentId: 'reviewer-1' },
    args: {
      taskId: 'review-me',
      decision: 'approved',
    },
  });

  assert.equal(approved.reviewState, 'approved');

  const changesRequested = facade.execute({
    commandName: COMMANDS.REVIEW_DECIDE,
    idempotencyKey: 'review-decide-2',
    actor: { teamId: 'team-a', agentId: 'reviewer-1' },
    args: {
      taskId: 'review-me',
      decision: 'changes_requested',
    },
  });

  assert.equal(changesRequested.reviewState, 'needs_fix');
  assert.equal(changesRequested.status, TASK_STATUS.PENDING);
});

test('LocalToolFacade requires idempotency keys for mutating commands', () => {
  const { facade } = createFacade();
  assert.throws(
    () =>
      facade.execute({
        commandName: COMMANDS.TASK_CREATE,
        actor: { teamId: 'team-a', agentId: 'lead' },
        args: { taskId: 'x', subject: 'Missing idempotency' },
      }),
    /idempotencyKey/
  );
});

test('LocalToolFacade lists agent runtime status for the actor team', () => {
  const { facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.AGENT_STATUS,
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: {},
  });

  assert.deepEqual(result, [
    {
      runtimeId: 'runtime-lead-1',
      teamId: 'team-a',
      agentId: 'lead',
      status: 'running',
    },
    {
      runtimeId: 'runtime-worker-1',
      teamId: 'team-a',
      agentId: 'worker-1',
      status: 'exited',
    },
  ]);
});

test('LocalToolFacade returns a specific runtime status by runtimeId', () => {
  const { facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.AGENT_STATUS,
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { runtimeId: 'runtime-lead-1' },
  });

  assert.deepEqual(result, {
    runtimeId: 'runtime-lead-1',
    teamId: 'team-a',
    agentId: 'lead',
    status: 'running',
  });
});

test('LocalToolFacade lists approvals for the actor team', () => {
  const { facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.APPROVAL_LIST,
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {},
  });

  assert.deepEqual(result, [
    {
      approvalId: 'approval-1',
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-lead-1',
      prompt: 'Approve Write',
      status: 'pending',
    },
  ]);
});

test('LocalToolFacade lists runtime audit events for the actor team', () => {
  const { facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.RUNTIME_EVENTS,
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: { runtimeId: 'runtime-lead-1' },
  });

  assert.deepEqual(result, [
    {
      eventId: 'event-1',
      teamId: 'team-a',
      runtimeId: 'runtime-lead-1',
      agentId: 'lead',
      eventType: 'tool_use',
    },
  ]);
});

test('LocalToolFacade lists cross-team messages for the actor team', () => {
  const { facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.CROSS_TEAM_MESSAGES,
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: { limit: 25 },
  });

  assert.deepEqual(result, [
    {
      id: 'msg-cross-1',
      teamId: 'team-a',
      direction: 'outbound',
      targetTeamId: 'team-b',
      conversationId: 'conv-1',
      text: 'Limit 25',
    },
  ]);
});

test('LocalToolFacade responds to approval requests through the approval broker', () => {
  const { approvalBroker, facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.APPROVAL_RESPOND,
    idempotencyKey: 'approval-response-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {
      approvalId: 'approval-1',
      decision: 'approved',
      reason: 'User approved the edit.',
    },
  });

  assert.deepEqual(approvalBroker.responses, [
    {
      approvalId: 'approval-1',
      idempotencyKey: 'approval-response-1',
      actor: { teamId: 'team-a', agentId: 'operator' },
      decision: 'approved',
      reason: 'User approved the edit.',
    },
  ]);
  assert.equal(result.status, 'approved');
});

test('LocalToolFacade forwards approval responses to the requesting runtime adapter', () => {
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const sentApprovals = [];
  const approvalBroker = {
    getApproval(approvalId) {
      assert.equal(approvalId, 'approval-1');
      return {
        approvalId,
        teamId: 'team-a',
        agentId: 'lead',
        runtimeId: 'runtime-lead-1',
        status: 'pending',
      };
    },
    respondApproval(input) {
      return {
        approvalId: input.approvalId,
        teamId: 'team-a',
        agentId: 'lead',
        runtimeId: 'runtime-lead-1',
        status: input.decision,
        decision: input.decision,
        reason: input.reason,
      };
    },
  };
  const adapters = new Map([
    [
      'runtime-lead-1',
      {
        approve(input) {
          sentApprovals.push(input);
          return { accepted: true, responseState: 'approval_response_returned' };
        },
      },
    ],
  ]);
  const facade = new LocalToolFacade({ broker, taskBoard, approvalBroker, adapters });

  const result = facade.execute({
    commandName: COMMANDS.APPROVAL_RESPOND,
    idempotencyKey: 'approval-response-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {
      approvalId: 'approval-1',
      decision: 'approved',
      reason: 'User approved the edit.',
    },
  });

  assert.deepEqual(sentApprovals, [
    {
      approvalId: 'approval-1',
      decision: 'approved',
      reason: 'User approved the edit.',
    },
  ]);
  assert.equal(result.runtimeResponse.accepted, true);
});

test('LocalToolFacade sends cross-team messages with prefix and dual-write', () => {
  const { broker, facade } = createFacade();

  const result = facade.execute({
    commandName: COMMANDS.CROSS_TEAM_SEND,
    idempotencyKey: 'cross-team-1',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: {
      targetTeamId: 'team-b',
      text: 'Need status update.',
      conversationId: 'conv-1',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.targetTeamId, 'team-b');
  assert.equal(result.targetAgentId, 'lead');

  // Incoming message in target team's inbox
  const targetMessages = broker.listMessages({ teamId: 'team-b' });
  assert.equal(targetMessages.length, 1);
  assert.ok(targetMessages[0].text.includes('<cross-team'));
  assert.ok(targetMessages[0].text.includes('from="team-a.lead"'));
  assert.ok(targetMessages[0].text.includes('Need status update.'));
  assert.equal(targetMessages[0].metadata.source, 'cross_team');

  // Sent copy in sender team's inbox
  const senderMessages = broker.listMessages({ teamId: 'team-a' });
  assert.equal(senderMessages.length, 1);
  assert.equal(senderMessages[0].metadata.source, 'cross_team_sent');
  assert.equal(senderMessages[0].metadata.conversationId, 'conv-1');
});

test('LocalToolFacade routes agent_launch to the launchAgent callback', async () => {
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  const calls = [];
  const facade = new LocalToolFacade({
    broker,
    taskBoard,
    launchAgent(input) {
      calls.push(input);
      return Promise.resolve({ runtimeId: input.runtimeId, status: 'starting', pid: 1234 });
    },
  });

  const result = await facade.execute({
    commandName: COMMANDS.AGENT_LAUNCH,
    idempotencyKey: 'launch-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {
      teamId: 'team-a',
      agentId: 'lead',
      runtimeId: 'runtime-lead-1',
      command: 'claude',
      args: ['--print'],
      cwd: 'C:\\Project-TOAD',
      env: { CLAUDE_VAR: 'on' },
      providerId: 'claude',
      prompt: 'Lead the kickoff.',
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    teamId: 'team-a',
    agentId: 'lead',
    runtimeId: 'runtime-lead-1',
    command: 'claude',
    args: ['--print'],
    cwd: 'C:\\Project-TOAD',
    env: { CLAUDE_VAR: 'on' },
    providerId: 'claude',
    prompt: 'Lead the kickoff.',
  });
  assert.deepEqual(result, { runtimeId: 'runtime-lead-1', status: 'starting', pid: 1234 });
});

test('LocalToolFacade rejects agent_launch when no launchAgent callback is configured', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.AGENT_LAUNCH,
      idempotencyKey: 'launch-fail',
      actor: { teamId: 'team-a', agentId: 'operator' },
      args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r1', command: 'claude' },
    }),
    /agent_launch is not configured/,
  );
});

test('LocalToolFacade task_plan_propose → task_plan_approve roundtrip populates task.plan', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'plan-c',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'plan-1', subject: 'planned' },
  });

  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'plan-prop',
    actor: { teamId: 'team-a', agentId: 'worker-1', role: 'developer' },
    args: {
      taskId: 'plan-1',
      summary: 'do the thing',
      filesExpectedToChange: ['x.js'],
      approach: ['step a', 'step b'],
      risks: ['none'],
      validationPlan: ['npm test'],
    },
  });

  let task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'plan-1' });
  assert.equal(task.plan.state, 'proposed');
  assert.equal(task.plan.summary, 'do the thing');
  assert.equal(task.plan.proposedBy, 'worker-1');

  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'plan-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'plan-1', reason: 'lgtm' },
  });

  task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'plan-1' });
  assert.equal(task.plan.state, 'approved');
  assert.equal(task.plan.decidedBy, 'lead');
  assert.equal(task.plan.reason, 'lgtm');
});

test('LocalToolFacade task_plan_approve refuses when the proposer is the approver', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'sa-c',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'sa-1', subject: 'self-approve' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'sa-prop',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: { taskId: 'sa-1', summary: 'do it' },
  });
  // Same agent tries to approve own plan — should be rejected regardless of role
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_PLAN_APPROVE,
      idempotencyKey: 'sa-app',
      actor: { teamId: 'team-a', agentId: 'worker-1', role: 'lead' },
      args: { taskId: 'sa-1' },
    }),
    /same agent cannot approve own plan/,
  );
});

test('LocalToolFacade ready → planned is blocked without an approved plan', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'gate-c',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-plan-1', subject: 'gate', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'gate-u-ready',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-plan-1', status: 'ready' },
  });

  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'gate-u-planned',
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: { taskId: 'gate-plan-1', status: 'planned' },
    }),
    /requires an approved plan/,
  );
});

test('LocalToolFacade ready → planned is allowed once a plan is approved', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'gate2-c',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-plan-2', subject: 'gate2', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'gate2-u-ready',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-plan-2', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'gate2-prop',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: { taskId: 'gate-plan-2', summary: 'do it' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'gate2-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'gate-plan-2' },
  });
  // Now ready → planned should be allowed
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'gate2-u-planned',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-plan-2', status: 'planned' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'gate-plan-2' });
  assert.equal(task.status, 'planned');
});

test('LocalToolFacade blocks testing → merge_ready when no passing test verdict exists', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  // Walk task into testing
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'gate-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-1', subject: 'gate', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'gate-u1',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-1', status: 'in_progress' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'gate-u2',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-1', status: 'review' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'gate-u3',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'gate-1', status: 'testing' },
  });

  // No validation_run for kind=test → merge_ready must be blocked
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'gate-u4',
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: { taskId: 'gate-1', status: 'merge_ready' },
    }),
    /requires a passing test verdict/,
  );
});

test('LocalToolFacade allows testing → merge_ready after a passing test verdict is recorded', async () => {
  const spawnFn = fakeSpawn({ exitCode: 0, stdout: 'all green', stderr: '' });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
    })(),
    spawnValidation: spawnFn,
  });
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({
    teamId: 'team-a',
    lead: { agentId: 'lead' },
    validation: { testCommand: 'npm test' },
  }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'pass-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'pass-1', subject: 'pass', status: 'pending' },
  });
  for (const [id, status] of [
    ['p1', 'in_progress'],
    ['p2', 'review'],
    ['p3', 'testing'],
  ]) {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: `pass-${id}`,
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: { taskId: 'pass-1', status },
    });
  }
  // Run the test command — verdict 'passed'
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'pass-run',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'pass-1', kind: 'test' },
  });
  // Now merge_ready should be allowed
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'pass-u4',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'pass-1', status: 'merge_ready' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'pass-1' });
  assert.equal(task.status, 'merge_ready');
});

test('LocalToolFacade blocks testing → merge_ready when the latest test verdict is "failed"', async () => {
  const spawnFn = fakeSpawn({ exitCode: 1, stdout: '', stderr: 'fail' });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
    })(),
    spawnValidation: spawnFn,
  });
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({
    teamId: 'team-a',
    lead: { agentId: 'lead' },
    validation: { testCommand: 'npm test' },
  }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'fail-c',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'fail-1', subject: 'fail', status: 'pending' },
  });
  for (const [id, status] of [['f1', 'in_progress'], ['f2', 'review'], ['f3', 'testing']]) {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: `fail-${id}`,
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: { taskId: 'fail-1', status },
    });
  }
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'fail-run',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'fail-1', kind: 'test' },
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'fail-u4',
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: { taskId: 'fail-1', status: 'merge_ready' },
    }),
    /failed/,
  );
});

function fakeSpawn({ exitCode = 0, stdout = '', stderr = '', durationMs = 1 } = {}) {
  const calls = [];
  const fn = (command, opts) => {
    calls.push({ command, opts });
    return { exitCode, stdout, stderr, durationMs };
  };
  fn.calls = calls;
  return fn;
}

test('LocalToolFacade validation_run records the run as a TASK_VALIDATION_RUN event', async () => {
  const spawnFn = fakeSpawn({ exitCode: 0, stdout: 'tests run', stderr: '' });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
    })(),
    spawnValidation: spawnFn,
  });
  // Seed team config with a test command
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({
    teamId: 'team-a',
    lead: { agentId: 'lead' },
    validation: { testCommand: 'npm test' },
  }));
  // Seed a task
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'val-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'val-1', subject: 'validate' },
  });

  const result = await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'val-run-1',
    actor: { teamId: 'team-a', agentId: 'tester-1' },
    args: { taskId: 'val-1', kind: 'test' },
  });

  assert.equal(spawnFn.calls.length, 1);
  assert.equal(spawnFn.calls[0].command, 'npm test');
  assert.equal(result.verdict, 'passed');
  assert.equal(result.exitCode, 0);

  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'val-1' });
  assert.equal(task.validations.length, 1);
  assert.equal(task.validations[0].kind, 'test');
  assert.equal(task.validations[0].verdict, 'passed');
  assert.equal(task.latestValidation.test.verdict, 'passed');
});

test('LocalToolFacade validation_run records "not_run" when no command is configured and no override is supplied', async () => {
  const spawnFn = fakeSpawn();
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
    })(),
    spawnValidation: spawnFn,
  });
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({
    teamId: 'team-a',
    lead: { agentId: 'lead' },
    // No validation field — testCommand not configured
  }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'nr-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'nr-1', subject: 'not run' },
  });

  const result = await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'nr-run',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'nr-1', kind: 'test' },
  });

  assert.equal(spawnFn.calls.length, 0, 'spawn should not be called when no command is configured');
  assert.equal(result.verdict, 'not_run');
});

test('LocalToolFacade validation_run records "failed" when the command exits non-zero', async () => {
  const spawnFn = fakeSpawn({ exitCode: 2, stdout: '', stderr: 'boom' });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
    })(),
    spawnValidation: spawnFn,
  });
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({
    teamId: 'team-a',
    lead: { agentId: 'lead' },
    validation: { testCommand: 'npm test' },
  }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'f-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'f-1', subject: 'fail' },
  });

  const result = await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'f-run',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'f-1', kind: 'test' },
  });

  assert.equal(result.verdict, 'failed');
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /boom/);
});

test('LocalToolFacade enforces role authority on dispatch (developer cannot agent_launch)', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    launchAgent: () => ({ runtimeId: 'r', status: 'starting' }),
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.AGENT_LAUNCH,
      idempotencyKey: 'role-test-1',
      actor: { teamId: 'team-a', agentId: 'worker-1', role: 'developer' },
      args: { teamId: 'team-a', agentId: 'worker-1', runtimeId: 'r', command: 'claude' },
    }),
    /role authority: developer cannot call agent_launch/,
  );
});

test('LocalToolFacade allows developer to call task_update (in their allowlist)', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'role-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'role-1', subject: 'role test', status: 'pending' },
  });

  // developer with task_update permission
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'role-update',
    actor: { teamId: 'team-a', agentId: 'worker-1', role: 'developer' },
    args: { taskId: 'role-1', status: 'in_progress' },
  });
  // (no throw means success)
});

test('LocalToolFacade rejects review_decide when the actor is the same agent that requested the review', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'sr-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'sr-1', subject: 'self-review' },
  });
  // worker-1 requests review on its own work
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'sr-req',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: { taskId: 'sr-1', diff: 'd', files: ['x'] },
  });

  // worker-1 (a reviewer in this hypothetical) tries to approve own work
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.REVIEW_DECIDE,
      idempotencyKey: 'sr-dec',
      actor: { teamId: 'team-a', agentId: 'worker-1', role: 'reviewer' },
      args: { taskId: 'sr-1', decision: 'approved' },
    }),
    /same agent cannot review own work/,
  );
});

test('LocalToolFacade allows review_decide when the actor differs from the requester', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rev-create',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'rev-1', subject: 'rev' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'rev-req',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: { taskId: 'rev-1' },
  });
  // Different agent decides — should succeed
  facade.execute({
    commandName: COMMANDS.REVIEW_DECIDE,
    idempotencyKey: 'rev-dec',
    actor: { teamId: 'team-a', agentId: 'reviewer-1', role: 'reviewer' },
    args: { taskId: 'rev-1', decision: 'approved' },
  });
});

test('LocalToolFacade task_update records "from" and "reason" in the STATUS_CHANGED event payload', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'create-sm',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'sm-1', subject: 'state-machine', status: 'pending' },
  });

  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'update-sm',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'sm-1', status: 'in_progress', reason: 'work started' },
  });

  const task = facade.execute({
    commandName: COMMANDS.TASK_LIST,
    actor: { teamId: 'team-a', agentId: 'lead' },
  }).tasks.find((t) => t.taskId === 'sm-1');
  const statusEvent = task.history.find((e) => e.eventType === 'task.status_changed');
  assert.ok(statusEvent, 'STATUS_CHANGED event should exist');
  assert.equal(statusEvent.payload.from, 'pending');
  assert.equal(statusEvent.payload.status, 'in_progress');
  assert.equal(statusEvent.payload.reason, 'work started');
});

test('LocalToolFacade task_update rejects illegal status transitions', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  // Get task into a terminal state
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'create-illegal',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'illegal-1', subject: 'bad transition', status: 'completed' },
  });

  // completed is terminal — must not move forward
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'update-illegal',
      actor: { teamId: 'team-a', agentId: 'lead' },
      args: { taskId: 'illegal-1', status: 'review' },
    }),
    /not an allowed transition|completed.*review/,
  );
});

test('LocalToolFacade task_update preserves backward-compatible pending → in_progress → completed', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'c-bc',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'bc-1', subject: 'bc', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'u1-bc',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'bc-1', status: 'in_progress' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'u2-bc',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'bc-1', status: 'completed' },
  });
  const task = facade.execute({
    commandName: COMMANDS.TASK_LIST,
    actor: { teamId: 'team-a', agentId: 'lead' },
  }).tasks.find((t) => t.taskId === 'bc-1');
  assert.equal(task.status, 'completed');
});

test('LocalToolFacade review_request stores diff, summary, files in the task event payload', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });

  // Seed a task first
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'create-x',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'task-x', subject: 'X' },
  });

  const task = facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'rev-req-1',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: {
      taskId: 'task-x',
      reviewerId: 'lead',
      summary: 'Did the thing',
      diff: '--- a/x.js\n+++ b/x.js\n@@ -0,0 +1 @@\n+1',
      files: ['x.js'],
    },
  });

  assert.equal(task.review.state, 'requested');
  assert.equal(task.review.reviewerId, 'lead');
  assert.equal(task.review.summary, 'Did the thing');
  assert.match(task.review.diff, /\+1/);
  assert.deepEqual(task.review.files, ['x.js']);
});

test('LocalToolFacade review_decide stores per-file feedback', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'create-y',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'task-y', subject: 'Y' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'rev-req-y',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: { taskId: 'task-y', diff: '--- a\n+++ b', files: ['y.js'] },
  });

  const task = facade.execute({
    commandName: COMMANDS.REVIEW_DECIDE,
    idempotencyKey: 'rev-dec-y',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: {
      taskId: 'task-y',
      decision: 'changes_requested',
      reason: 'Naming',
      feedback: [{ file: 'y.js', comment: 'rename to z.js' }],
    },
  });

  assert.equal(task.review.state, 'decided');
  assert.equal(task.review.decision, 'changes_requested');
  assert.equal(task.review.feedback.length, 1);
  assert.equal(task.review.feedback[0].file, 'y.js');
  assert.match(task.review.feedback[0].comment, /rename/);
});

test('LocalToolFacade review_list returns tasks with active reviews including the diff', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  // Two tasks: one with an open review, one without
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'c1',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'open-rev', subject: 'open' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'r1',
    actor: { teamId: 'team-a', agentId: 'worker-1' },
    args: { taskId: 'open-rev', diff: 'd', files: ['a.js'] },
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'c2',
    actor: { teamId: 'team-a', agentId: 'lead' },
    args: { taskId: 'no-rev', subject: 'no review' },
  });

  const list = facade.execute({
    commandName: COMMANDS.REVIEW_LIST,
    actor: { teamId: 'team-a', agentId: 'operator' },
  });

  assert.equal(list.length, 1);
  assert.equal(list[0].taskId, 'open-rev');
  assert.equal(list[0].review.state, 'requested');
  assert.equal(list[0].review.diff, 'd');
});

test('LocalToolFacade routes runtime_send_input to the adapter\'s sendTurn', async () => {
  const turns = [];
  const adapter = {
    async sendTurn(input) {
      turns.push(input);
      return { accepted: true, responseState: 'queued' };
    },
  };
  const adapters = new Map([['runtime-lead-1', adapter]]);
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    adapters,
  });

  const result = await facade.execute({
    commandName: COMMANDS.RUNTIME_SEND_INPUT,
    idempotencyKey: 'send-input-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: { runtimeId: 'runtime-lead-1', text: '/usage' },
  });

  assert.equal(turns.length, 1);
  assert.equal(turns[0].message.text, '/usage');
  assert.deepEqual(result, { accepted: true, responseState: 'queued' });
});

test('LocalToolFacade rejects runtime_send_input when no adapter is registered for the runtimeId', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    adapters: new Map(),
  });
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.RUNTIME_SEND_INPUT,
      idempotencyKey: 'send-input-fail',
      actor: { teamId: 'team-a', agentId: 'operator' },
      args: { runtimeId: 'runtime-ghost', text: 'hello' },
    }),
    /no adapter for runtime/,
  );
});

test('LocalToolFacade requires idempotencyKey for runtime_send_input', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    adapters: new Map([['runtime-lead-1', { sendTurn: () => ({}) }]]),
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.RUNTIME_SEND_INPUT,
      actor: { teamId: 'team-a', agentId: 'operator' },
      args: { runtimeId: 'runtime-lead-1', text: 'hello' },
    }),
    /idempotencyKey/,
  );
});

test('LocalToolFacade usage_summary aggregates plan tier + tokens + cost across teams', async () => {
  // The UI's top-bar usage chip needs a single call that gives it
  // {plan, totals: {tokens, costUsd, runtimes}}. Plan tier comes from
  // claude auth status; tokens + cost are summed out of the
  // runtime_events.turn_completed payloads (which carry result.usage and
  // result.total_cost_usd from the stream-json output).
  const fakeEventLog = {
    // facade.constructor only stores eventLog when it has appendEvent —
    // so the fake has to look like a real log, even if usage_summary
    // only ever calls listEvents.
    appendEvent() { /* noop for this test */ },
    listEvents() {
      return [
        // A turn_completed for one runtime — typical claude shape.
        {
          eventType: 'turn_completed',
          runtimeId: 'r1',
          createdAt: '2026-05-03T10:00:00Z',
          payload: {
            raw: {
              type: 'result',
              total_cost_usd: 0.42,
              usage: { input_tokens: 100, output_tokens: 250 },
            },
          },
        },
        // A non-result event — must be ignored by the aggregator.
        {
          eventType: 'tool_use',
          runtimeId: 'r1',
          createdAt: '2026-05-03T09:59:00Z',
          payload: {},
        },
        // Another turn_completed on a second runtime — should sum.
        {
          eventType: 'turn_completed',
          runtimeId: 'r2',
          createdAt: '2026-05-03T10:05:00Z',
          payload: {
            raw: {
              type: 'result',
              total_cost_usd: 1.08,
              usage: { input_tokens: 800, output_tokens: 400 },
            },
          },
        },
      ];
    },
  };
  const fakeRuntimeRegistry = {
    listRuntimes() {
      return [
        { runtimeId: 'r1', status: 'running' },
        { runtimeId: 'r2', status: 'running' },
        { runtimeId: 'r3', status: 'stopped' },
      ];
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    runtimeRegistry: fakeRuntimeRegistry,
    eventLog: fakeEventLog,
    // Provider-auth probe is injectable. When unset, plan tier should
    // safely degrade to "unknown" instead of throwing.
    providerAuthSpawnSync: () => ({ status: 0, stdout: JSON.stringify({
      loggedIn: true, subscriptionType: 'max', email: 'x@y.z',
    }) }),
  });

  const result = await facade.execute({
    commandName: COMMANDS.USAGE_SUMMARY,
    actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
    args: {},
  });

  // Plan tier surfaced. Should not include the email (PII) by default.
  assert.ok(result.plan, 'plan section present');
  assert.equal(result.plan.tier, 'max');
  assert.equal(result.plan.loggedIn, true);
  // Aggregate totals from the two turn_completed events.
  assert.equal(result.totals.tokensIn, 900);
  assert.equal(result.totals.tokensOut, 650);
  assert.equal(result.totals.costUsd.toFixed(2), '1.50');
  // Runtime tally — running vs total.
  assert.equal(result.runtimes.live, 2);
  assert.equal(result.runtimes.total, 3);
});

test('LocalToolFacade usage_summary degrades gracefully when auth status is unreachable', async () => {
  // If claude isn't installed / not signed in, we still want a usable
  // response so the UI chip can render "unknown plan · $0.00".
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    providerAuthSpawnSync: () => { throw new Error('claude not found'); },
  });

  const result = await facade.execute({
    commandName: COMMANDS.USAGE_SUMMARY,
    actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
    args: {},
  });

  assert.equal(result.plan.tier, 'unknown');
  assert.equal(result.plan.loggedIn, false);
  assert.equal(result.totals.tokensIn, 0);
  assert.equal(result.totals.tokensOut, 0);
  assert.equal(result.totals.costUsd, 0);
});

test('LocalToolFacade usage_summary surfaces per-provider plan info for anthropic, openai, gemini', async () => {
  // Operators want to see plan/usage status for every CLI runtime they
  // might use, not just the active one. The `providers` array in the
  // response carries auth status (via getAuthStatus) for each supported
  // provider, plus a quota field that's populated when the provider has
  // a usable probe (anthropic only today). Codex and Gemini get nullish
  // quota — the UI renders that as "no quota probe available" rather
  // than fabricating numbers.
  const home = os.homedir();
  const fakeFiles = {
    // anthropic — signed in
    [path.join(home, '.claude', '.credentials.json')]:
      JSON.stringify({ claudeAiOauth: { subscriptionType: 'max', accessToken: 'tok' } }),
    // codex — signed in (id_token JWT-shaped, payload base64 of {"email":"x@y.com"})
    [path.join(home, '.codex', 'auth.json')]:
      JSON.stringify({ tokens: { id_token: 'header.eyJlbWFpbCI6InhAeS5jb20ifQ.sig' } }),
    // gemini — signed in
    [path.join(home, '.gemini', 'oauth_creds.json')]:
      JSON.stringify({ access_token: 'tok', expiry_date: Date.now() + 3600_000 }),
  };
  const fakeReadFile = (p) => {
    if (p in fakeFiles) return fakeFiles[p];
    const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
  };
  const fakeStat = (p) => {
    if (p in fakeFiles) return { size: fakeFiles[p].length };
    const err = new Error('ENOENT'); err.code = 'ENOENT'; throw err;
  };

  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    providerAuthSpawnSync: () => ({ status: 0, stdout: JSON.stringify({
      loggedIn: true, subscriptionType: 'max',
    }) }),
    providerAuthReadFile: fakeReadFile,
    providerAuthStat: fakeStat,
    // Skip the live pty probe — return null deterministically and fast.
    claudeUsageProbe: async () => null,
  });

  const result = await facade.execute({
    commandName: COMMANDS.USAGE_SUMMARY,
    actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
    args: {},
  });

  assert.ok(Array.isArray(result.providers), 'providers array present');
  // Should include all three primary subscription-capable providers.
  const ids = result.providers.map((p) => p.providerId).sort();
  assert.deepEqual(ids, ['anthropic', 'gemini', 'openai']);

  const anthropic = result.providers.find((p) => p.providerId === 'anthropic');
  assert.ok(anthropic, 'anthropic entry present');
  assert.equal(anthropic.signedIn, true);
  assert.ok(anthropic.label, 'human-readable label included');
  // Quota field exists — null is acceptable (probe may not have run),
  // but the field MUST be present so the UI can render the placeholder.
  assert.ok('quota' in anthropic, 'quota field present (even if null)');

  const codex = result.providers.find((p) => p.providerId === 'openai');
  assert.equal(codex.signedIn, true);
  // Codex doesn't have a quota probe — quota is explicitly null.
  assert.equal(codex.quota, null);

  const gemini = result.providers.find((p) => p.providerId === 'gemini');
  assert.equal(gemini.signedIn, true);
  assert.equal(gemini.quota, null);
});

test('LocalToolFacade runtime_list returns the runtimeRegistry rows for the requested team', () => {
  // The UI's useToadData hook calls runtime_list({ teamId }) on every load
  // and after each refresh. Without this command, the UI receives "unsupported
  // command" and falls back to an empty runtime list, which makes every
  // agent in the side panel render as idle even when claude.exe processes
  // are actively orchestrating in the background.
  const fakeRegistry = {
    listRuntimes({ teamId }) {
      return [
        { runtimeId: `runtime-${teamId}-lead`, teamId, agentId: 'lead', status: 'running', pid: 1001, startedAt: '2026-05-02T10:00:00Z' },
        { runtimeId: `runtime-${teamId}-w1`, teamId, agentId: 'w1', status: 'running', pid: 1002, startedAt: '2026-05-02T10:00:01Z' },
      ];
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    runtimeRegistry: fakeRegistry,
  });

  const result = facade.execute({
    commandName: COMMANDS.RUNTIME_LIST,
    idempotencyKey: 'runtime-list-1',
    actor: { teamId: 'team-x', agentId: 'operator', role: 'human' },
    args: { teamId: 'team-x' },
  });

  assert.ok(Array.isArray(result.runtimes), 'response must shape { runtimes: [] }');
  assert.equal(result.runtimes.length, 2);
  assert.equal(result.runtimes[0].runtimeId, 'runtime-team-x-lead');
  assert.equal(result.runtimes[0].status, 'running');
  // Status field is what useToadData normalizes to "live" — must be present
  // on each runtime, not undefined or missing.
  for (const r of result.runtimes) {
    assert.ok(typeof r.status === 'string' && r.status.length > 0);
    assert.ok(typeof r.runtimeId === 'string' && r.runtimeId.length > 0);
    assert.ok(typeof r.agentId === 'string' && r.agentId.length > 0);
  }
});

test('LocalToolFacade runtime_list falls back to actor.teamId when args.teamId is omitted', () => {
  // The UI sometimes calls runtime_list without an explicit teamId — the
  // facade should derive it from the actor (same pattern as task_list).
  const fakeRegistry = {
    listRuntimes({ teamId }) {
      assert.equal(teamId, 'actor-team', 'should use actor.teamId fallback');
      return [];
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    runtimeRegistry: fakeRegistry,
  });

  const result = facade.execute({
    commandName: COMMANDS.RUNTIME_LIST,
    idempotencyKey: 'runtime-list-fallback',
    actor: { teamId: 'actor-team', agentId: 'operator', role: 'human' },
    args: {},
  });
  assert.deepEqual(result, { runtimes: [] });
});

test('LocalToolFacade routes team_create / team_list / team_delete through the team config registry', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(config) { this.teams.set(config.teamId, config); }
      getTeam(teamId) { return this.teams.get(teamId) || null; }
      listTeams() { return [...this.teams.values()]; }
      deleteTeam(teamId) { return this.teams.delete(teamId); }
    })(),
  });

  // Create
  const created = facade.execute({
    commandName: COMMANDS.TEAM_CREATE,
    idempotencyKey: 'team-create-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: {
      teamId: 'team-alpha',
      lead: { agentId: 'lead', command: 'claude', prompt: 'be brief' },
      teammates: [{ agentId: 'worker-1' }],
    },
  });
  assert.equal(created.teamId, 'team-alpha');
  assert.equal(created.lead.command, 'claude');
  assert.equal(created.teammates[0].agentId, 'worker-1');

  // List
  const list = facade.execute({
    commandName: COMMANDS.TEAM_LIST,
    actor: { teamId: 'team-a', agentId: 'operator' },
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].teamId, 'team-alpha');

  // Delete
  const deleteResult = facade.execute({
    commandName: COMMANDS.TEAM_DELETE,
    idempotencyKey: 'team-delete-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: { teamId: 'team-alpha' },
  });
  assert.equal(deleteResult.deleted, true);
  assert.equal(facade.execute({
    commandName: COMMANDS.TEAM_LIST,
    actor: { teamId: 'team-a', agentId: 'operator' },
  }).length, 0);
});

test('LocalToolFacade rejects team_* commands when no teamConfigRegistry is configured', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TEAM_LIST,
      actor: { teamId: 'team-a', agentId: 'operator' },
    }),
    /teamConfigRegistry is not configured/,
  );
});

function createTeamLifecycleFacade({ teamRuntimes = [], adapters = new Map() } = {}) {
  const launches = [];
  const stops = [];
  const registry = new (class {
    teams = new Map();
    registerTeam(config) { this.teams.set(config.teamId, config); }
    getTeam(teamId) { return this.teams.get(teamId) || null; }
    listTeams() { return [...this.teams.values()]; }
    deleteTeam(teamId) { return this.teams.delete(teamId); }
  })();
  const runtimeRegistry = {
    runtimes: new Map(teamRuntimes.map((r) => [r.runtimeId, r])),
    listRuntimes({ teamId } = {}) {
      const all = [...this.runtimes.values()];
      return teamId ? all.filter((r) => r.teamId === teamId) : all;
    },
    getRuntime(runtimeId) { return this.runtimes.get(runtimeId) || null; },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: registry,
    runtimeRegistry,
    adapters,
    launchAgent(input) {
      launches.push(input);
      runtimeRegistry.runtimes.set(input.runtimeId, {
        runtimeId: input.runtimeId,
        teamId: input.teamId,
        agentId: input.agentId,
        status: 'starting',
      });
      return Promise.resolve({ runtimeId: input.runtimeId, status: 'starting' });
    },
    stopAgent(input) {
      stops.push(input);
      const r = runtimeRegistry.runtimes.get(input.runtimeId);
      if (r) r.status = 'stopped';
      return Promise.resolve({ runtimeId: input.runtimeId, status: 'stopped' });
    },
  });
  return { facade, registry, runtimeRegistry, launches, stops };
}

test('LocalToolFacade team_launch launches every member with derived runtime IDs', async () => {
  const { facade, registry, launches } = createTeamLifecycleFacade();
  registry.registerTeam(new (await import('../src/team/teamConfig.js')).TeamConfig({
    teamId: 'team-alpha',
    lead: { agentId: 'lead', command: 'claude', args: ['--print'], prompt: 'Lead the team.' },
    teammates: [
      { agentId: 'worker-1', command: 'claude' },
      { agentId: 'worker-2', command: 'claude' },
    ],
  }));

  const result = await facade.execute({
    commandName: COMMANDS.TEAM_LAUNCH,
    idempotencyKey: 'team-launch-1',
    actor: { teamId: 'team-alpha', agentId: 'operator' },
    args: { teamId: 'team-alpha' },
  });

  assert.equal(launches.length, 3);
  assert.equal(launches[0].runtimeId, 'runtime-team-alpha-lead');
  assert.equal(launches[1].runtimeId, 'runtime-team-alpha-worker-1');
  assert.equal(launches[2].runtimeId, 'runtime-team-alpha-worker-2');
  assert.equal(launches[0].prompt, 'Lead the team.');
  assert.equal(result.teamId, 'team-alpha');
  assert.equal(result.members.length, 3);
  assert.deepEqual(result.members.map((m) => m.status), ['starting', 'starting', 'starting']);
});

test('LocalToolFacade team_launch throws when the team config is missing', async () => {
  const { facade } = createTeamLifecycleFacade();
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.TEAM_LAUNCH,
      idempotencyKey: 'team-launch-missing',
      actor: { teamId: 'team-alpha', agentId: 'operator' },
      args: { teamId: 'team-alpha' },
    }),
    /no config for teamId/,
  );
});

test('LocalToolFacade team_launch skips members that are already running', async () => {
  const { facade, registry, launches } = createTeamLifecycleFacade({
    teamRuntimes: [
      { runtimeId: 'runtime-team-alpha-lead', teamId: 'team-alpha', agentId: 'lead', status: 'running' },
    ],
    adapters: new Map([['runtime-team-alpha-lead', { sendTurn: () => ({}) }]]),
  });
  registry.registerTeam(new (await import('../src/team/teamConfig.js')).TeamConfig({
    teamId: 'team-alpha',
    lead: { agentId: 'lead' },
    teammates: [{ agentId: 'worker-1' }],
  }));

  const result = await facade.execute({
    commandName: COMMANDS.TEAM_LAUNCH,
    idempotencyKey: 'team-launch-resume',
    actor: { teamId: 'team-alpha', agentId: 'operator' },
    args: { teamId: 'team-alpha' },
  });

  assert.equal(launches.length, 1, 'only the missing member should be launched');
  assert.equal(launches[0].agentId, 'worker-1');
  assert.equal(result.members[0].status, 'already_running');
  assert.equal(result.members[1].status, 'starting');
});

test('LocalToolFacade team_launch relaunches stale running rows with no live adapter', async () => {
  const { facade, registry, launches } = createTeamLifecycleFacade({
    teamRuntimes: [
      { runtimeId: 'runtime-team-alpha-lead', teamId: 'team-alpha', agentId: 'lead', status: 'running' },
    ],
  });
  registry.registerTeam(new (await import('../src/team/teamConfig.js')).TeamConfig({
    teamId: 'team-alpha',
    lead: { agentId: 'lead', prompt: 'Start after restart.' },
    teammates: [],
  }));

  const result = await facade.execute({
    commandName: COMMANDS.TEAM_LAUNCH,
    idempotencyKey: 'team-launch-stale-running',
    actor: { teamId: 'team-alpha', agentId: 'operator' },
    args: { teamId: 'team-alpha' },
  });

  assert.equal(launches.length, 1);
  assert.equal(launches[0].runtimeId, 'runtime-team-alpha-lead');
  assert.equal(launches[0].prompt, 'Start after restart.');
  assert.equal(result.members[0].status, 'starting');
});

test('LocalToolFacade team_launch records per-member failures without aborting the rest', async () => {
  const launches = [];
  const registry = new (class {
    teams = new Map();
    registerTeam(c) { this.teams.set(c.teamId, c); }
    getTeam(id) { return this.teams.get(id) || null; }
  })();
  const runtimeRegistry = { listRuntimes: () => [], getRuntime: () => null };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: registry,
    runtimeRegistry,
    launchAgent(input) {
      launches.push(input);
      if (input.agentId === 'worker-1') return Promise.reject(new Error('boom'));
      return Promise.resolve({ runtimeId: input.runtimeId, status: 'starting' });
    },
  });
  registry.registerTeam(new (await import('../src/team/teamConfig.js')).TeamConfig({
    teamId: 'team-alpha',
    lead: { agentId: 'lead' },
    teammates: [{ agentId: 'worker-1' }, { agentId: 'worker-2' }],
  }));

  const result = await facade.execute({
    commandName: COMMANDS.TEAM_LAUNCH,
    idempotencyKey: 'team-launch-partial',
    actor: { teamId: 'team-alpha', agentId: 'operator' },
    args: { teamId: 'team-alpha' },
  });

  assert.equal(launches.length, 3);
  assert.equal(result.members[0].status, 'starting');
  assert.equal(result.members[1].status, 'failed');
  assert.match(result.members[1].error, /boom/);
  assert.equal(result.members[2].status, 'starting');
});

test('LocalToolFacade team_launch sends a stdin kickoff to the lead when no user prompt is set, leaves teammates silent', async () => {
  // Without a stdin kickoff, claude's stream-json mode never starts
  // generating — the lead just waits for input. The facade synthesizes a
  // minimal "introduce yourself, then wait" kickoff for the lead so the
  // operator immediately sees that the team booted. Teammates intentionally
  // get no kickoff: they only act on lead-issued message_send turns.
  const { facade, registry, launches } = createTeamLifecycleFacade();
  registry.registerTeam(new (await import('../src/team/teamConfig.js')).TeamConfig({
    teamId: 'kicktest',
    lead: { agentId: 'lead', role: 'lead' }, // no prompt set
    teammates: [
      { agentId: 'alice', role: 'developer' },
      { agentId: 'bob', role: 'qa' },
    ],
  }));

  await facade.execute({
    commandName: COMMANDS.TEAM_LAUNCH,
    idempotencyKey: 'team-launch-kickoff',
    actor: { teamId: 'kicktest', agentId: 'operator' },
    args: { teamId: 'kicktest' },
  });

  const [leadLaunch, aliceLaunch, bobLaunch] = launches;
  // Lead got a kickoff — short, points at the system prompt, doesn't
  // invent work
  assert.equal(typeof leadLaunch.prompt, 'string');
  assert.ok(leadLaunch.prompt.length > 0, 'lead should have a kickoff prompt');
  assert.match(leadLaunch.prompt, /operator|introduce|identity|who you are/i);
  // Teammates have no prompt — they wait
  assert.equal(aliceLaunch.prompt, undefined);
  assert.equal(bobLaunch.prompt, undefined);
});

test('LocalToolFacade team_launch preserves an explicit lead prompt instead of overwriting with the kickoff', async () => {
  // When the operator filled in the leadPrompt textarea (or foundry seeded
  // one), the kickoff must NOT clobber it — the explicit prompt is the
  // operator's intent and is more useful than a generic "introduce
  // yourself".
  const { facade, registry, launches } = createTeamLifecycleFacade();
  registry.registerTeam(new (await import('../src/team/teamConfig.js')).TeamConfig({
    teamId: 'explicit',
    lead: { agentId: 'lead', role: 'lead', prompt: 'Refactor the auth module.' },
    teammates: [],
  }));

  await facade.execute({
    commandName: COMMANDS.TEAM_LAUNCH,
    idempotencyKey: 'team-launch-explicit',
    actor: { teamId: 'explicit', agentId: 'operator' },
    args: { teamId: 'explicit' },
  });

  assert.equal(launches[0].prompt, 'Refactor the auth module.');
});

test('LocalToolFacade team_launch attaches a role-aware systemPrompt to every member', async () => {
  // Each agent gets a `--append-system-prompt` payload carrying its team
  // identity, role, teammate list, and instructions for the message_send
  // tool. Without this, the lead boots silent and the teammates have no
  // idea they're on a team. The facade is responsible for attaching the
  // systemPrompt to launchInput; the runtime turns it into the CLI flag.
  const { facade, registry, launches } = createTeamLifecycleFacade();
  registry.registerTeam(new (await import('../src/team/teamConfig.js')).TeamConfig({
    teamId: 'orion',
    lead: { agentId: 'captain', role: 'lead' },
    teammates: [
      { agentId: 'alice', role: 'developer' },
      { agentId: 'bob', role: 'qa' },
    ],
  }));

  await facade.execute({
    commandName: COMMANDS.TEAM_LAUNCH,
    idempotencyKey: 'team-launch-sysprompt',
    actor: { teamId: 'orion', agentId: 'operator' },
    args: { teamId: 'orion' },
  });

  assert.equal(launches.length, 3);
  // Lead system prompt: identifies as lead, lists teammates, mentions tool
  assert.match(launches[0].systemPrompt, /captain/);
  assert.match(launches[0].systemPrompt, /lead/i);
  assert.match(launches[0].systemPrompt, /alice/);
  assert.match(launches[0].systemPrompt, /bob/);
  assert.match(launches[0].systemPrompt, /message_send/);
  // Teammate system prompts: identify as themselves, name the lead
  assert.match(launches[1].systemPrompt, /alice/);
  assert.match(launches[1].systemPrompt, /developer/);
  assert.match(launches[1].systemPrompt, /captain/);
  assert.match(launches[2].systemPrompt, /bob/);
  assert.match(launches[2].systemPrompt, /qa/i);
  // Role-specific guidance differs between developer and qa
  assert.notEqual(launches[1].systemPrompt, launches[2].systemPrompt);
});

test('LocalToolFacade team_stop stops every running runtime in the team', async () => {
  const { facade, stops } = createTeamLifecycleFacade({
    teamRuntimes: [
      { runtimeId: 'runtime-team-alpha-lead', teamId: 'team-alpha', agentId: 'lead', status: 'running' },
      { runtimeId: 'runtime-team-alpha-worker-1', teamId: 'team-alpha', agentId: 'worker-1', status: 'running' },
      { runtimeId: 'runtime-other-lead', teamId: 'team-other', agentId: 'lead', status: 'running' },
    ],
  });

  const result = await facade.execute({
    commandName: COMMANDS.TEAM_STOP,
    idempotencyKey: 'team-stop-1',
    actor: { teamId: 'team-alpha', agentId: 'operator' },
    args: { teamId: 'team-alpha', signal: 'SIGTERM' },
  });

  assert.equal(stops.length, 2);
  assert.deepEqual(stops.map((s) => s.runtimeId).sort(), ['runtime-team-alpha-lead', 'runtime-team-alpha-worker-1']);
  assert.equal(stops[0].signal, 'SIGTERM');
  assert.equal(result.teamId, 'team-alpha');
  assert.equal(result.members.length, 2);
});

test('LocalToolFacade team_stop is a no-op idempotent return when no runtimes match', async () => {
  const { facade, stops } = createTeamLifecycleFacade();

  const result = await facade.execute({
    commandName: COMMANDS.TEAM_STOP,
    idempotencyKey: 'team-stop-empty',
    actor: { teamId: 'team-alpha', agentId: 'operator' },
    args: { teamId: 'team-alpha' },
  });

  assert.equal(stops.length, 0);
  assert.deepEqual(result, { teamId: 'team-alpha', members: [] });
});

test('LocalToolFacade routes agent_stop to the stopAgent callback', async () => {
  const calls = [];
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    stopAgent(input) {
      calls.push(input);
      return Promise.resolve({ runtimeId: input.runtimeId, status: 'stopped', signal: input.signal });
    },
  });

  const result = await facade.execute({
    commandName: COMMANDS.AGENT_STOP,
    idempotencyKey: 'stop-1',
    actor: { teamId: 'team-a', agentId: 'operator' },
    args: { runtimeId: 'runtime-lead-1', signal: 'SIGTERM' },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { runtimeId: 'runtime-lead-1', signal: 'SIGTERM' });
  assert.deepEqual(result, { runtimeId: 'runtime-lead-1', status: 'stopped', signal: 'SIGTERM' });
});

test('LocalToolFacade rejects agent_stop when no stopAgent callback is configured', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.AGENT_STOP,
      idempotencyKey: 'stop-fail',
      actor: { teamId: 'team-a', agentId: 'operator' },
      args: { runtimeId: 'runtime-lead-1' },
    }),
    /agent_stop is not configured/,
  );
});

test('LocalToolFacade requires idempotencyKey for agent_stop', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    stopAgent: () => ({ runtimeId: 'r', status: 'stopped' }),
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.AGENT_STOP,
      actor: { teamId: 'team-a', agentId: 'operator' },
      args: { runtimeId: 'runtime-lead-1' },
    }),
    /idempotencyKey/,
  );
});

test('LocalToolFacade requires idempotencyKey for agent_launch', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    launchAgent: () => ({ runtimeId: 'r', status: 'starting' }),
  });
  // execute()'s mutating-command check is synchronous — throws before reaching the async handler
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.AGENT_LAUNCH,
      actor: { teamId: 'team-a', agentId: 'operator' },
      args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r1', command: 'claude' },
    }),
    /idempotencyKey/,
  );
});

test('LocalToolFacade dispatches diagnostics_run and returns a structured report', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const spawnFn = (command) => {
    if (command.includes('--version')) return { exitCode: 0, stdout: '1.2.3', stderr: '', durationMs: 1 };
    if (command.includes('auth status')) return { exitCode: 0, stdout: '{"loggedIn":true}', stderr: '', durationMs: 1 };
    return { exitCode: 127, stdout: '', stderr: 'unknown', durationMs: 0 };
  };
  const registry = new (class {
    teams = new Map();
    registerTeam(c) { this.teams.set(c.teamId, c); }
    getTeam(id) { return this.teams.get(id) || null; }
    listTeams() { return Array.from(this.teams.values()); }
  })();
  registry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: registry,
    spawnValidation: spawnFn,
    dbPath: 'C:/Project-TOAD/.toad/toad.db',
  });
  const report = facade.execute({
    commandName: COMMANDS.DIAGNOSTICS_RUN,
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: {},
  });
  assert.ok(Array.isArray(report.checks));
  assert.ok(report.summary);
  // Should include all the enforcement checks
  const ids = report.checks.map((c) => c.id);
  assert.ok(ids.includes('state_machine_invalid_transitions_rejected'));
  assert.ok(ids.includes('role_authority_denies_developer_agent_launch'));
  assert.ok(ids.includes('validation_commands_configured'));
  assert.ok(ids.includes('provider_claude_detected'));
  assert.ok(ids.includes('provider_claude_authenticated'));
  assert.ok(ids.includes('dbpath_persistent'));
});

test('LocalToolFacade.diagnostics_run is callable by every role (read-only)', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: () => ({ exitCode: 0, stdout: '1.0', stderr: '', durationMs: 1 }),
    dbPath: '/tmp/x.db',
  });
  for (const role of ['developer', 'reviewer', 'tester', 'architect', 'lead', 'human']) {
    const report = facade.execute({
      commandName: COMMANDS.DIAGNOSTICS_RUN,
      actor: { teamId: 'team-a', agentId: `${role}-1`, role },
      args: {},
    });
    assert.ok(Array.isArray(report.checks), `role ${role} did not get checks`);
  }
});

test('LocalToolFacade blocks merge_ready → done for non-lead roles', async () => {
  const spawnFn = (cmd) => cmd.includes('claude') ? { exitCode: 0, stdout: '1.0', stderr: '', durationMs: 1 } : { exitCode: 0, stdout: 'pass', stderr: '', durationMs: 1 };
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const registry = new (class {
    teams = new Map();
    registerTeam(c) { this.teams.set(c.teamId, c); }
    getTeam(id) { return this.teams.get(id) || null; }
    listTeams() { return Array.from(this.teams.values()); }
  })();
  registry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    teamConfigRegistry: registry,
    spawnValidation: spawnFn,
  });
  // Walk a task to merge_ready as lead (privileged setup)
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rg-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rg-1', subject: 'role-guard', status: 'pending' },
  });
  for (const [id, status] of [
    ['rg-2', 'in_progress'],
    ['rg-3', 'review'],
    ['rg-4', 'testing'],
  ]) {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: id,
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'rg-1', status },
    });
  }
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'rg-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'rg-1', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rg-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rg-1', status: 'merge_ready' },
  });
  // Developer cannot complete the merge
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'rg-deny',
      actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
      args: { taskId: 'rg-1', status: 'done' },
    }),
    /role developer cannot perform merge_ready . done/,
  );
  // Lead can
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rg-allow',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rg-1', status: 'done' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'rg-1' });
  assert.equal(task.status, 'done');
});

test('LocalToolFacade triggers worktree creation when a task transitions ready → planned', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const calls = [];
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId }) {
      calls.push({ teamId, taskId });
      return {
        status: 'created',
        path: `/tmp/.toad/worktrees/${teamId}/${taskId}`,
        branch: `toad/${teamId}/${taskId}`,
        baseRef: 'abc123',
        createdAt: '2026-05-01T00:00:00.000Z',
      };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'wt-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-1', subject: 'wt', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'wt-ready',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-1', status: 'ready' },
  });
  // Approve a plan so the ready→planned gate passes
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'wt-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'wt-1', summary: 'do it' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'wt-approve',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-1' },
  });
  // The transition that triggers worktree creation
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'wt-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-1', status: 'planned' },
  });
  // Manager called once for this task
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { teamId: 'team-a', taskId: 'wt-1' });
  // Projection picks up the worktree
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'wt-1' });
  assert.equal(task.worktree.status, 'created');
  assert.equal(task.worktree.branch, 'toad/team-a/wt-1');
  assert.equal(task.worktree.baseRef, 'abc123');
});

test('LocalToolFacade tolerates worktreeManager throwing (best-effort, transition still completes)', async () => {
  const fakeWorktreeManager = {
    createForTask() { throw new Error('git is busted'); },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'wt2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-2', subject: 'wt2', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'wt2-ready',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-2', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'wt2-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'wt-2', summary: 'do it' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'wt2-approve',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-2' },
  });
  // Should not throw — transition still completes
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'wt2-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-2', status: 'planned' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'wt-2' });
  assert.equal(task.status, 'planned');
});

test('LocalToolFacade does not trigger worktree creation when no manager is configured', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    // no worktreeManager
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'wt3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-3', subject: 'wt3', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'wt3-ready',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-3', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'wt3-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'wt-3', summary: 'do it' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'wt3-approve',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-3' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'wt3-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'wt-3', status: 'planned' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'wt-3' });
  assert.equal(task.status, 'planned');
  assert.equal(task.worktree, null);
});

// --- §19 slice 1: merge_ready → done blocked when worktree branch would conflict with baseRef ---

function setupMergeReadyTask(facade, { taskId = 'mr-1' } = {}) {
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: `${taskId}-create`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId, subject: 'merge', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: `${taskId}-ready`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId, status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: `${taskId}-plan`,
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId, summary: 'm' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: `${taskId}-app`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId },
  });
  for (const [id, status] of [
    [`${taskId}-planned`, 'planned'],
    [`${taskId}-ip`, 'in_progress'],
    [`${taskId}-rev`, 'review'],
    [`${taskId}-test`, 'testing'],
  ]) {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: id,
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId, status },
    });
  }
}

function buildMergeFacade({ checkForConflicts, removeForTask = () => ({ status: 'removed', path: '/x', removedAt: 'now' }) } = {}) {
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId }) {
      return { status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: `toad/${teamId}/${taskId}`, baseRef: 'base-sha', createdAt: 'now' };
    },
    removeForTask,
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: () => ({ exitCode: 0, stdout: 'pass', stderr: '', durationMs: 1 }),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
      listTeams() { return Array.from(this.teams.values()); }
    })(),
    worktreeManager: fakeWorktreeManager,
    mergeChecker: { checkForConflicts },
  });
  return facade;
}

test('merge_ready → done is allowed when mergeChecker reports clean', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = buildMergeFacade({ checkForConflicts: () => ({ status: 'clean' }) });
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  setupMergeReadyTask(facade, { taskId: 'mc-clean' });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'mc-clean-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'mc-clean', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'mc-clean-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'mc-clean', status: 'merge_ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'mc-clean-done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'mc-clean', status: 'done' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'mc-clean' });
  assert.equal(task.status, 'done');
});

test('merge_ready → done is BLOCKED when mergeChecker reports conflict, with file list in error', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = buildMergeFacade({
    checkForConflicts: () => ({ status: 'conflict', files: ['src/foo.js', 'src/bar.js'] }),
  });
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  setupMergeReadyTask(facade, { taskId: 'mc-conf' });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'mc-conf-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'mc-conf', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'mc-conf-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'mc-conf', status: 'merge_ready' },
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'mc-conf-done',
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'mc-conf', status: 'done' },
    }),
    /merge_ready . done blocked.*conflict.*src\/foo\.js/,
  );
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'mc-conf' });
  assert.equal(task.status, 'merge_ready', 'task should still be merge_ready after blocked transition');
});

test('merge_ready → done is BLOCKED when mergeChecker reports error (operator must investigate)', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = buildMergeFacade({
    checkForConflicts: () => ({ status: 'error', error: 'worktree has uncommitted changes' }),
  });
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  setupMergeReadyTask(facade, { taskId: 'mc-err' });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'mc-err-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'mc-err', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'mc-err-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'mc-err', status: 'merge_ready' },
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'mc-err-done',
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'mc-err', status: 'done' },
    }),
    /merge_ready . done blocked.*uncommitted changes/,
  );
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'mc-err' });
  assert.equal(task.status, 'merge_ready');
});

test('merge_ready → done has no merge gate when no worktree exists (back-compat)', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  let checkerCalled = false;
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: () => ({ exitCode: 0, stdout: 'pass', stderr: '', durationMs: 1 }),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
      listTeams() { return Array.from(this.teams.values()); }
    })(),
    // no worktreeManager → no worktree gets attached
    mergeChecker: { checkForConflicts: () => { checkerCalled = true; return { status: 'clean' }; } },
  });
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  setupMergeReadyTask(facade, { taskId: 'mc-nowt' });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'mc-nowt-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'mc-nowt', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'mc-nowt-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'mc-nowt', status: 'merge_ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'mc-nowt-done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'mc-nowt', status: 'done' },
  });
  assert.equal(checkerCalled, false, 'mergeChecker should not run without a worktree');
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'mc-nowt' });
  assert.equal(task.status, 'done');
});

// --- bugfix: validation_run idempotency must skip spawn on retry ---

test('validation_run with the same idempotencyKey does NOT re-run spawn and returns the cached payload', async () => {
  let spawnCallCount = 0;
  const spawn = (command, opts) => {
    spawnCallCount++;
    return { exitCode: 0, stdout: 'pass', stderr: '', durationMs: 50 };
  };
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: spawn,
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
      listTeams() { return Array.from(this.teams.values()); }
    })(),
  });
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'idem-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'idem-1', subject: 'idem' },
  });
  // First call — runs the spawn, records a passed event
  const first = await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'val-run-once',
    actor: { teamId: 'team-a', agentId: 'tester', role: 'tester' },
    args: { taskId: 'idem-1', kind: 'test' },
  });
  assert.equal(first.verdict, 'passed');
  assert.equal(spawnCallCount, 1);

  // Second call — same idempotencyKey. Spawn must not run again. Returned
  // payload must equal the cached event's payload (not a fresh spawn result).
  const second = await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'val-run-once',
    actor: { teamId: 'team-a', agentId: 'tester', role: 'tester' },
    args: { taskId: 'idem-1', kind: 'test' },
  });
  assert.equal(spawnCallCount, 1, 'spawn must not run again on idempotent retry');
  assert.equal(second.verdict, 'passed');
  // Projection still has exactly one validation event
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'idem-1' });
  assert.equal(task.validations.length, 1);
});

test('validation_run with a different idempotencyKey runs the spawn again', async () => {
  let spawnCallCount = 0;
  const spawn = () => {
    spawnCallCount++;
    return { exitCode: 0, stdout: 'pass', stderr: '', durationMs: 50 };
  };
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: spawn,
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
      listTeams() { return Array.from(this.teams.values()); }
    })(),
  });
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'idem2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'idem-2', subject: 'idem2' },
  });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'run-a',
    actor: { teamId: 'team-a', agentId: 'tester', role: 'tester' },
    args: { taskId: 'idem-2', kind: 'test' },
  });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'run-b',
    actor: { teamId: 'team-a', agentId: 'tester', role: 'tester' },
    args: { taskId: 'idem-2', kind: 'test' },
  });
  assert.equal(spawnCallCount, 2);
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'idem-2' });
  assert.equal(task.validations.length, 2);
});

// --- §20: task_history_export ---

test('task_history_export returns the projection, taskEvents in order, and runtimeEvents (when eventLog provided)', () => {
  const events = [];
  const fakeEventLog = {
    appendEvent(input) { events.push(input); return { inserted: true, event: input }; },
    listEventsByTask({ teamId, taskId }) {
      assert.equal(teamId, 'team-a');
      assert.equal(taskId, 'th-1');
      return [
        { eventId: 're-1', runtimeId: 'rt-1', teamId, agentId: 'dev', eventType: 'assistant_text', payload: { text: 'hi' }, createdAt: '2026-05-01T00:10:00.000Z' },
      ];
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    eventLog: fakeEventLog,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'th-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'th-1', subject: 'history' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_COMMENT,
    idempotencyKey: 'th-c1',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'th-1', text: 'first comment' },
  });
  const exp = facade.execute({
    commandName: COMMANDS.TASK_HISTORY_EXPORT,
    actor: { teamId: 'team-a', agentId: 'reviewer-1', role: 'reviewer' },
    args: { taskId: 'th-1' },
  });
  assert.equal(exp.task.taskId, 'th-1');
  assert.equal(exp.task.subject, 'history');
  assert.ok(Array.isArray(exp.taskEvents));
  // CREATED + COMMENT_ADDED, in order
  assert.equal(exp.taskEvents.length, 2);
  assert.equal(exp.taskEvents[0].eventType, 'task.created');
  assert.equal(exp.taskEvents[1].eventType, 'task.comment_added');
  assert.ok(Array.isArray(exp.runtimeEvents));
  assert.equal(exp.runtimeEvents.length, 1);
  assert.equal(exp.runtimeEvents[0].eventType, 'assistant_text');
});

test('task_history_export returns empty runtimeEvents when no eventLog is configured', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'th2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'th-2', subject: 'no event log' },
  });
  const exp = facade.execute({
    commandName: COMMANDS.TASK_HISTORY_EXPORT,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'th-2' },
  });
  assert.equal(exp.task.taskId, 'th-2');
  assert.deepEqual(exp.runtimeEvents, []);
});

test('task_history_export throws when taskId is not provided', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_HISTORY_EXPORT,
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: {},
    }),
    /taskId/,
  );
});

test('task_history_export is callable by every role (read-only)', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'th3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'th-3', subject: 's' },
  });
  for (const role of ['developer', 'reviewer', 'tester', 'architect', 'lead', 'human']) {
    const exp = facade.execute({
      commandName: COMMANDS.TASK_HISTORY_EXPORT,
      actor: { teamId: 'team-a', agentId: `${role}-x`, role },
      args: { taskId: 'th-3' },
    });
    assert.equal(exp.task.taskId, 'th-3', `role ${role} couldn't export`);
  }
});

// --- §13 partial: no-op diff detector ---

test('review_request flags review.noOpDiff = true when computed diff has no files', () => {
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({ status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' }),
  };
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: '', files: [] }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'no-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-1', subject: 'noop', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'no-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'no-1', summary: 's' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'no-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-1' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'no-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-1', status: 'planned' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'no-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'no-1', summary: 'I did the thing' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'no-1' });
  assert.equal(task.review.noOpDiff, true);
});

test('review_request leaves noOpDiff false when files have actual changes', () => {
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({ status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' }),
  };
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: 'real diff', files: ['x.js'] }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'no2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-2', subject: 's' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'no2-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'no-2', summary: 's', diff: 'caller', files: ['caller.js'] },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'no-2' });
  assert.equal(task.review.noOpDiff, false);
});

test('review_request leaves noOpDiff false when no diff computer was able to run (no worktree, caller silent)', () => {
  // Caller didn't supply diff; no worktree → no diff computed → not the "I did work but no files changed" case
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'no3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-3', subject: 's' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'no3-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'no-3', summary: 's' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'no-3' });
  // No diff computed → don't claim no-op (we don't actually know)
  assert.equal(task.review.noOpDiff, false);
});

// --- §13 partial: scope-drift detection in review_request ---

test('review_request flags scope drift: files outside plan.filesExpectedToChange land in review.scopeDrift', () => {
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({ status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' }),
  };
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: 'd', files: ['src/parser.js', 'src/scope-creep.js', 'README.md'] }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'sd-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-1', subject: 'scope', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'sd-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-1', summary: 's', filesExpectedToChange: ['src/parser.js'] },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'sd-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-1' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'sd-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-1', status: 'planned' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'sd-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-1', summary: 'please review' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'sd-1' });
  // Plan only allowed src/parser.js — the other two are out of scope
  assert.deepEqual(task.review.scopeDrift, ['src/scope-creep.js', 'README.md']);
  assert.deepEqual(task.review.files, ['src/parser.js', 'src/scope-creep.js', 'README.md']);
});

test('review_request does not flag anything when all changed files are in the plan', () => {
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: 'd', files: ['src/parser.js', 'src/parser.test.js'] }),
  };
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({ status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'sd2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-2', subject: 's', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'sd2-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-2', summary: 's', filesExpectedToChange: ['src/parser.js', 'src/parser.test.js'] },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'sd2-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-2' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'sd2-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-2', status: 'planned' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'sd2-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-2', summary: 's' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'sd-2' });
  assert.deepEqual(task.review.scopeDrift, []);
});

test('review_request supports directory wildcard "src/parser/**" in plan.filesExpectedToChange', () => {
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: 'd', files: ['src/parser/lex.js', 'src/parser/sub/parse.js', 'src/main.js'] }),
  };
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({ status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'sd3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-3', subject: 's', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'sd3-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-3', summary: 's', filesExpectedToChange: ['src/parser/**'] },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'sd3-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-3' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'sd3-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-3', status: 'planned' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'sd3-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-3', summary: 's' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'sd-3' });
  // Both src/parser/* files match; src/main.js is drift
  assert.deepEqual(task.review.scopeDrift, ['src/main.js']);
});

test('review_request leaves scopeDrift empty when plan has no filesExpectedToChange', () => {
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: 'd', files: ['anywhere.js'] }),
  };
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({ status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'sd4-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-4', subject: 's', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'sd4-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-4', summary: 's' /* no filesExpectedToChange */ },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'sd4-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-4' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'sd4-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'sd-4', status: 'planned' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'sd4-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'sd-4', summary: 's' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'sd-4' });
  // No expectation set → no drift flagged
  assert.deepEqual(task.review.scopeDrift, []);
});

// --- §7 finished: review_request auto-computes diff against task worktree ---

test('review_request rejects files that match task.forbiddenFiles', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'fc-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {
      taskId: 'fc-1',
      subject: 'file contract',
      forbiddenFiles: ['secrets/**', '.env'],
    },
  });
  assert.throws(
    () =>
      facade.execute({
        commandName: COMMANDS.REVIEW_REQUEST,
        idempotencyKey: 'fc-review',
        actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
        args: { taskId: 'fc-1', files: ['src/app.js', 'secrets/token.txt'] },
      }),
    /review_request: changed files include forbidden paths: secrets\/token\.txt/
  );
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'fc-1' });
  assert.equal(task.review, null);
});

test('review_request rejects files outside task.allowedFiles when the task has an explicit allowlist', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'fc2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {
      taskId: 'fc-2',
      subject: 'file contract',
      allowedFiles: ['src/**', 'package.json'],
    },
  });
  assert.throws(
    () =>
      facade.execute({
        commandName: COMMANDS.REVIEW_REQUEST,
        idempotencyKey: 'fc2-review',
        actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
        args: { taskId: 'fc-2', files: ['src/app.js', 'README.md'] },
      }),
    /review_request: changed files outside allowedFiles: README\.md/
  );
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'fc-2' });
  assert.equal(task.review, null);
});

test('review_request allows files that satisfy task.allowedFiles and avoid forbiddenFiles', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'fc3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {
      taskId: 'fc-3',
      subject: 'file contract',
      allowedFiles: ['src/**', 'package.json'],
      forbiddenFiles: ['src/secrets/**'],
    },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'fc3-review',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'fc-3', files: ['src/app.js', 'package.json'] },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'fc-3' });
  assert.deepEqual(task.review.files, ['src/app.js', 'package.json']);
});

test('review_request enforces task file contract against orchestrator-computed diff files', () => {
  const fakeDiffComputer = {
    computeDiff: () => ({ diff: 'diff --git a/secrets/token.txt b/secrets/token.txt', files: ['secrets/token.txt'] }),
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'fc4-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {
      taskId: 'fc-4',
      subject: 'computed file contract',
      forbiddenFiles: ['secrets/**'],
    },
  });
  facade.taskBoard.appendEvent({
    teamId: 'team-a',
    taskId: 'fc-4',
    eventType: TASK_EVENT_TYPES.WORKTREE_CREATED,
    actorId: 'lead',
    payload: {
      status: 'created',
      path: '/tmp/fc-4',
      branch: 'toad/team-a/fc-4',
      baseRef: 'base-sha',
    },
  });
  assert.throws(
    () =>
      facade.execute({
        commandName: COMMANDS.REVIEW_REQUEST,
        idempotencyKey: 'fc4-review',
        actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
        args: { taskId: 'fc-4' },
      }),
    /review_request: changed files include forbidden paths: secrets\/token\.txt/
  );
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'fc-4' });
  assert.equal(task.review, null);
});

test('review_request auto-computes diff and files when task has worktree and caller omits both', async () => {
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId }) {
      return {
        status: 'created',
        path: `/tmp/wt/${teamId}/${taskId}`,
        branch: `toad/${teamId}/${taskId}`,
        baseRef: 'base-sha',
        createdAt: '2026-05-01T00:00:00.000Z',
      };
    },
  };
  const fakeDiffComputer = {
    computeDiff({ worktreePath, baseRef }) {
      assert.equal(worktreePath, '/tmp/wt/team-a/dx-1');
      assert.equal(baseRef, 'base-sha');
      return { diff: 'diff --git a/x.js ...', files: ['x.js', 'y.js'] };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  // Walk task to a state where review_request makes sense
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'dx-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-1', subject: 'diff', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'dx-ready',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-1', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'dx-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'dx-1', summary: 's' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'dx-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-1' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'dx-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-1', status: 'planned' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'dx-ip',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-1', status: 'in_progress' },
  });
  // No diff or files supplied — orchestrator computes them
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'dx-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'dx-1', summary: 'please review' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'dx-1' });
  assert.equal(task.review.diff, 'diff --git a/x.js ...');
  assert.deepEqual(task.review.files, ['x.js', 'y.js']);
});

test('review_request preserves caller-supplied diff/files (operator override wins)', () => {
  const fakeDiffComputer = {
    computeDiff() {
      // Should not be called when caller supplies diff
      throw new Error('diff computer should not run when caller provides diff');
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'dx2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-2', subject: 'diff2' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'dx2-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'dx-2', diff: 'caller diff', files: ['caller.js'] },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'dx-2' });
  assert.equal(task.review.diff, 'caller diff');
  assert.deepEqual(task.review.files, ['caller.js']);
});

test('review_request without worktree leaves diff/files unset (no auto-compute)', () => {
  const fakeDiffComputer = {
    computeDiff() {
      throw new Error('should not be called when no worktree');
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    diffComputer: fakeDiffComputer,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'dx3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-3', subject: 'no wt' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'dx3-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'dx-3', summary: 's' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'dx-3' });
  assert.equal(task.review.diff, null);
  assert.deepEqual(task.review.files, []);
});

test('review_request tolerates diffComputer errors (best-effort, no diff/files attached)', () => {
  const fakeWorktreeManager = {
    createForTask: ({ teamId, taskId }) => ({
      status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now',
    }),
  };
  const fakeDiffComputer = {
    computeDiff() {
      return { diff: null, files: [], error: 'git is busted' };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    diffComputer: fakeDiffComputer,
  });
  // Quick path to a task with worktree
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'dx4-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-4', subject: 's', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'dx4-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'dx-4', summary: 's' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'dx4-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-4' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'dx4-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'dx-4', status: 'planned' },
  });
  // Should not throw despite diff error
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'dx4-rev',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'dx-4', summary: 's' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'dx-4' });
  assert.equal(task.review.diff, null);
  assert.deepEqual(task.review.files, []);
});

// --- §8 slice 3: worktree removal on done ---

test('LocalToolFacade calls worktreeManager.removeForTask when a task transitions merge_ready → done', async () => {
  const removeCalls = [];
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId }) {
      return {
        status: 'created',
        path: `/tmp/wt/${teamId}/${taskId}`,
        branch: `toad/${teamId}/${taskId}`,
        baseRef: 'abc',
        createdAt: '2026-05-01T00:00:00.000Z',
      };
    },
    removeForTask({ teamId, taskId }) {
      removeCalls.push({ teamId, taskId });
      return { status: 'removed', path: `/tmp/wt/${teamId}/${taskId}`, removedAt: '2026-05-01T01:00:00.000Z' };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: () => ({ exitCode: 0, stdout: 'pass', stderr: '', durationMs: 1 }),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
      listTeams() { return Array.from(this.teams.values()); }
    })(),
    worktreeManager: fakeWorktreeManager,
  });
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  // Walk the task all the way through the lifecycle
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rm-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rm-1', subject: 'cleanup', status: 'pending' },
  });
  for (const [id, status] of [
    ['rm-ready', 'ready'],
  ]) {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: id,
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'rm-1', status },
    });
  }
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'rm-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'rm-1', summary: 'cleanup' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'rm-approve',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rm-1' },
  });
  for (const [id, status] of [
    ['rm-planned', 'planned'],
    ['rm-ip', 'in_progress'],
    ['rm-rev', 'review'],
    ['rm-test', 'testing'],
  ]) {
    facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: id,
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'rm-1', status },
    });
  }
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'rm-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'rm-1', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rm-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rm-1', status: 'merge_ready' },
  });
  // No removal yet
  assert.equal(removeCalls.length, 0);
  // Move to done — should trigger removal
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rm-done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rm-1', status: 'done' },
  });
  assert.equal(removeCalls.length, 1);
  assert.deepEqual(removeCalls[0], { teamId: 'team-a', taskId: 'rm-1' });
  // Projection picks up removal
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'rm-1' });
  assert.equal(task.worktree.status, 'removed');
  assert.equal(task.worktree.removedAt, '2026-05-01T01:00:00.000Z');
});

test('LocalToolFacade does NOT remove worktree on rejected (operator triages manually)', () => {
  const removeCalls = [];
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId }) {
      return { status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: 'r', createdAt: 'now' };
    },
    removeForTask(input) { removeCalls.push(input); return { status: 'removed', path: '', removedAt: 'now' }; },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rj-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rj-1', subject: 'reject', status: 'review' },
  });
  // review → rejected
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rj-rej',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rj-1', status: 'rejected' },
  });
  assert.equal(removeCalls.length, 0, 'rejected should not auto-remove worktree');
});

test('LocalToolFacade tolerates worktreeManager.removeForTask throwing (best-effort)', async () => {
  const fakeWorktreeManager = {
    createForTask: () => ({ status: 'created', path: '/tmp/x', branch: 'b', baseRef: 'r', createdAt: 'now' }),
    removeForTask() { throw new Error('git is busted'); },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: () => ({ exitCode: 0, stdout: 'pass', stderr: '', durationMs: 1 }),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
      listTeams() { return Array.from(this.teams.values()); }
    })(),
    worktreeManager: fakeWorktreeManager,
  });
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'npm test' } }));
  // Walk to merge_ready quickly
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rt-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rt-1', subject: 't', status: 'testing' },
  });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'rt-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'rt-1', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rt-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rt-1', status: 'merge_ready' },
  });
  // Done should not throw even though removeForTask blows up
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rt-done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rt-1', status: 'done' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'rt-1' });
  assert.equal(task.status, 'done');
});

// --- §8 slice 4: explicit baseRef from task_create flows into worktree creation ---

test('task_create accepts baseRef + baseBranch and surfaces them on the projection', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'br-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-1', subject: 'baseref task', baseRef: 'feature-anchor', baseBranch: 'develop' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'br-1' });
  assert.equal(task.baseRef, 'feature-anchor');
  assert.equal(task.baseBranch, 'develop');
});

test('task_create accepts task risk contract fields and surfaces them on the projection', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  const task = facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'risk-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {
      taskId: 'risk-1',
      subject: 'risk task',
      allowedFiles: [' src/** ', 'docs/spec.md', ''],
      forbiddenFiles: ['.env', 'secrets/**'],
      acceptanceCriteria: ['test passes', 'review approved'],
      riskLevel: 'critical',
      requiresHumanApproval: true,
    },
  });
  assert.deepEqual(task.allowedFiles, ['src/**', 'docs/spec.md']);
  assert.deepEqual(task.forbiddenFiles, ['.env', 'secrets/**']);
  assert.deepEqual(task.acceptanceCriteria, ['test passes', 'review approved']);
  assert.equal(task.riskLevel, 'critical');
  assert.equal(task.requiresHumanApproval, true);
});

test('task_create rejects unsupported riskLevel values', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  assert.throws(
    () =>
      facade.execute({
        commandName: COMMANDS.TASK_CREATE,
        idempotencyKey: 'risk-bad',
        actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
        args: {
          taskId: 'risk-bad',
          subject: 'bad risk',
          riskLevel: 'severe',
        },
      }),
    /task_create: unsupported riskLevel severe/
  );
});

test('worktreeManager.createForTask receives task.baseRef from facade hook on ready→planned', () => {
  const seen = [];
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId, baseRef }) {
      seen.push({ teamId, taskId, baseRef });
      return { status: 'created', path: `/tmp/${teamId}/${taskId}`, branch: 'b', baseRef: baseRef || 'fallback', createdAt: 'now' };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'br2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-2', subject: 's', baseRef: 'pinned-sha', status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'br2-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'br-2', summary: 's' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'br2-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-2' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'br2-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-2', status: 'planned' },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].baseRef, 'pinned-sha');
});

test('worktreeManager.createForTask receives undefined baseRef when task did not capture one (HEAD fallback)', () => {
  const seen = [];
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId, baseRef }) {
      seen.push({ baseRef });
      return { status: 'created', path: '/tmp/x', branch: 'b', baseRef: 'fb', createdAt: 'now' };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'br3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-3', subject: 's', status: 'ready' /* no baseRef */ },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: 'br3-plan',
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId: 'br-3', summary: 's' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: 'br3-app',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-3' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'br3-planned',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'br-3', status: 'planned' },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].baseRef, undefined);
});

// --- §8 slice 2: agent_launch cwd enforcement against task worktree ---

function setupTaskWithWorktree(facade, taskId = 'cwd-1') {
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: `${taskId}-create`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId, subject: 'cwd', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: `${taskId}-ready`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId, status: 'ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_PROPOSE,
    idempotencyKey: `${taskId}-plan`,
    actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
    args: { taskId, summary: 'do it' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_PLAN_APPROVE,
    idempotencyKey: `${taskId}-approve`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: `${taskId}-planned`,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId, status: 'planned' },
  });
}

function makeWorktreeFacade({ workingPath = '/tmp/wt-cwd' } = {}) {
  const launches = [];
  const fakeWorktreeManager = {
    createForTask({ teamId, taskId }) {
      return {
        status: 'created',
        path: `${workingPath}/${teamId}/${taskId}`,
        branch: `toad/${teamId}/${taskId}`,
        baseRef: 'abc123',
        createdAt: '2026-05-01T00:00:00.000Z',
      };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    worktreeManager: fakeWorktreeManager,
    launchAgent: async (input) => {
      launches.push(input);
      return { runtimeId: input.runtimeId, status: 'running' };
    },
  });
  return { facade, launches };
}

test('agent_launch auto-sets cwd to worktree path when caller omits cwd', async () => {
  const { facade, launches } = makeWorktreeFacade();
  setupTaskWithWorktree(facade, 'cwd-1');
  await facade.execute({
    commandName: COMMANDS.AGENT_LAUNCH,
    idempotencyKey: 'al-1',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r-1', command: 'claude', taskId: 'cwd-1' },
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cwd, '/tmp/wt-cwd/team-a/cwd-1');
});

test('agent_launch accepts a cwd that matches the task worktree path', async () => {
  const { facade, launches } = makeWorktreeFacade();
  setupTaskWithWorktree(facade, 'cwd-2');
  await facade.execute({
    commandName: COMMANDS.AGENT_LAUNCH,
    idempotencyKey: 'al-2',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r-2', command: 'claude', taskId: 'cwd-2', cwd: '/tmp/wt-cwd/team-a/cwd-2' },
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cwd, '/tmp/wt-cwd/team-a/cwd-2');
});

test('agent_launch rejects a cwd that conflicts with the task worktree path', async () => {
  const { facade, launches } = makeWorktreeFacade();
  setupTaskWithWorktree(facade, 'cwd-3');
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.AGENT_LAUNCH,
      idempotencyKey: 'al-3',
      actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
      args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r-3', command: 'claude', taskId: 'cwd-3', cwd: '/elsewhere' },
    }),
    /agent_launch: cwd .* must match task worktree/,
  );
  assert.equal(launches.length, 0);
});

test('agent_launch with no taskId is unconstrained (back-compat)', async () => {
  const { facade, launches } = makeWorktreeFacade();
  // No task / no worktree on the call
  await facade.execute({
    commandName: COMMANDS.AGENT_LAUNCH,
    idempotencyKey: 'al-4',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r-4', command: 'claude', cwd: '/anywhere' },
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cwd, '/anywhere');
});

test('agent_launch with taskId for a task that has no created worktree leaves cwd unchanged', async () => {
  const { facade, launches } = makeWorktreeFacade();
  // Task that never reached planned — no worktree
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'cwd-5-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'cwd-5', subject: 'no wt' },
  });
  await facade.execute({
    commandName: COMMANDS.AGENT_LAUNCH,
    idempotencyKey: 'al-5',
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r-5', command: 'claude', taskId: 'cwd-5', cwd: '/anywhere' },
  });
  assert.equal(launches.length, 1);
  assert.equal(launches[0].cwd, '/anywhere');
});

test('LocalToolFacade emits tool_call_denied event when role authority rejects a call', () => {
  const events = [];
  const eventLog = {
    appendEvent(input) {
      events.push(input);
      return { inserted: true, event: input };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    eventLog,
  });
  // Developer cannot call agent_launch
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.AGENT_LAUNCH,
      idempotencyKey: 'dn-1',
      actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
      args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r1', command: 'claude' },
    }),
    /role authority: developer cannot call agent_launch/,
  );
  // Exactly one tool_call_denied event recorded
  const denied = events.filter((e) => e.eventType === 'tool_call_denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0].teamId, 'team-a');
  assert.equal(denied[0].agentId, 'dev-1');
  assert.equal(denied[0].payload.commandName, 'agent_launch');
  assert.equal(denied[0].payload.role, 'developer');
  assert.match(denied[0].payload.reason, /developer cannot call agent_launch/);
});

test('LocalToolFacade does not emit tool_call_denied for allowed calls', () => {
  const events = [];
  const eventLog = {
    appendEvent(input) { events.push(input); return { inserted: true, event: input }; },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    eventLog,
  });
  // Lead can call agent_status (no idempotency key required for read-only)
  facade.execute({
    commandName: COMMANDS.TASK_LIST,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {},
  });
  const denied = events.filter((e) => e.eventType === 'tool_call_denied');
  assert.equal(denied.length, 0);
});

test('LocalToolFacade tool_call_denied event emission is best-effort (does not mask original error)', () => {
  const eventLog = {
    appendEvent() { throw new Error('event log is broken'); },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    eventLog,
  });
  // Original role-authority error should bubble even if event log throws
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.AGENT_LAUNCH,
      idempotencyKey: 'dn-2',
      actor: { teamId: 'team-a', agentId: 'dev-1', role: 'developer' },
      args: { teamId: 'team-a', agentId: 'lead', runtimeId: 'r1', command: 'claude' },
    }),
    /role authority: developer cannot call agent_launch/,
  );
});

test('LocalToolFacade blocks blocked → in_progress for developer/reviewer/tester', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'b-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'b-1', subject: 'block-guard', status: 'pending' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'b-ip',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'b-1', status: 'in_progress' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'b-block',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'b-1', status: 'blocked' },
  });
  // Developer + tester both have task_update access via role-authority but should be
  // blocked by the per-transition guard. (Reviewer can't call task_update at all —
  // role-authority denies them at a higher layer; they're not part of this test.)
  for (const role of ['developer', 'tester']) {
    assert.throws(
      () => facade.execute({
        commandName: COMMANDS.TASK_UPDATE,
        idempotencyKey: `b-deny-${role}`,
        actor: { teamId: 'team-a', agentId: `${role}-1`, role },
        args: { taskId: 'b-1', status: 'in_progress' },
      }),
      /role .* cannot perform blocked . in_progress/,
    );
  }
  // Architect can unblock
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'b-arch',
    actor: { teamId: 'team-a', agentId: 'arch-1', role: 'architect' },
    args: { taskId: 'b-1', status: 'in_progress' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'b-1' });
  assert.equal(task.status, 'in_progress');
});

// --- §14: human-approval gate + risk-policy classifier ---

function buildHumanGateFacade({ riskPolicy = null, diffComputer = null, mergeChecker = null } = {}) {
  return new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: () => ({ exitCode: 0, stdout: 'pass', stderr: '', durationMs: 1 }),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
      listTeams() { return Array.from(this.teams.values()); }
    })(),
    riskPolicy,
    ...(diffComputer ? { diffComputer } : {}),
    ...(mergeChecker ? { mergeChecker } : {}),
  });
}

test('task_human_approve records HUMAN_APPROVED event + populates task.humanApproval', () => {
  const facade = buildHumanGateFacade();
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'ha-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'ha-1', subject: 'risky', riskLevel: 'high', requiresHumanApproval: true },
  });
  facade.execute({
    commandName: COMMANDS.TASK_HUMAN_APPROVE,
    idempotencyKey: 'ha-approve',
    actor: { teamId: 'team-a', agentId: 'kayden', role: 'human' },
    args: { taskId: 'ha-1', reason: 'reviewed offline' },
  });
  const task = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'ha-1' });
  assert.equal(task.humanApproval.approved, true);
  assert.equal(task.humanApproval.approvedBy, 'kayden');
  assert.equal(task.humanApproval.reason, 'reviewed offline');
});

test('task_human_approve denies developer/reviewer/tester/architect roles', () => {
  const facade = buildHumanGateFacade();
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'ha2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'ha-2', subject: 'risky' },
  });
  for (const role of ['developer', 'reviewer', 'tester', 'architect']) {
    assert.throws(
      () => facade.execute({
        commandName: COMMANDS.TASK_HUMAN_APPROVE,
        idempotencyKey: `ha2-deny-${role}`,
        actor: { teamId: 'team-a', agentId: `${role}-1`, role },
        args: { taskId: 'ha-2' },
      }),
      /role authority: .* cannot call task_human_approve/,
      `expected ${role} to be denied`,
    );
  }
});

test('merge_ready → done is BLOCKED when requiresHumanApproval and no human approval recorded', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = buildHumanGateFacade({});
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'noop' } }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'g-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'g-1', subject: 'risky', riskLevel: 'high', requiresHumanApproval: true, status: 'testing' },
  });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'g-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'g-1', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'g-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'g-1', status: 'merge_ready' },
  });
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'g-done',
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'g-1', status: 'done' },
    }),
    /merge_ready . done blocked by human-approval gate.*riskLevel: high/,
  );
});

test('merge_ready → done is allowed once task_human_approve runs', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = buildHumanGateFacade({});
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'noop' } }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'g2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'g-2', subject: 'risky', riskLevel: 'high', requiresHumanApproval: true, status: 'testing' },
  });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'g2-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'g-2', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'g2-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'g-2', status: 'merge_ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_HUMAN_APPROVE,
    idempotencyKey: 'g2-approve',
    actor: { teamId: 'team-a', agentId: 'kayden', role: 'human' },
    args: { taskId: 'g-2' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'g2-done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'g-2', status: 'done' },
  });
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'g-2' });
  assert.equal(t.status, 'done');
});

test('merge_ready → done is unaffected when requiresHumanApproval is false', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const facade = buildHumanGateFacade({});
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'noop' } }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'g3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'g-3', subject: 'low risk', riskLevel: 'low', requiresHumanApproval: false, status: 'testing' },
  });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'g3-val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'g-3', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'g3-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'g-3', status: 'merge_ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'g3-done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'g-3', status: 'done' },
  });
  assert.equal(facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'g-3' }).status, 'done');
});

test('review_request runs the risk classifier and emits RISK_CLASSIFIED when policy matches', () => {
  const policy = { rules: [{ pattern: '.env*', riskLevel: 'critical', requiresHumanApproval: true }] };
  const facade = buildHumanGateFacade({ riskPolicy: policy });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rc-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rc-1', subject: 'edits .env' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'rc-rev',
    actor: { teamId: 'team-a', agentId: 'dev', role: 'developer' },
    args: { taskId: 'rc-1', summary: 'edits env', files: ['.env.production'] },
  });
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'rc-1' });
  assert.equal(t.riskLevel, 'critical');
  assert.equal(t.requiresHumanApproval, true);
  const riskEvents = t.history.filter((e) => e.eventType === 'task.risk_classified');
  assert.equal(riskEvents.length, 1);
  assert.equal(riskEvents[0].payload.source, 'risk_policy');
});

test('review_request does NOT emit RISK_CLASSIFIED when no rule matches', () => {
  const policy = { rules: [{ pattern: 'src/secrets/**', riskLevel: 'critical', requiresHumanApproval: true }] };
  const facade = buildHumanGateFacade({ riskPolicy: policy });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rc3-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rc-3', subject: 'safe edit' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'rc3-rev',
    actor: { teamId: 'team-a', agentId: 'dev', role: 'developer' },
    args: { taskId: 'rc-3', summary: 's', files: ['README.md'] },
  });
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'rc-3' });
  const riskEvents = t.history.filter((e) => e.eventType === 'task.risk_classified');
  assert.equal(riskEvents.length, 0);
});

test('review_request does NOT emit RISK_CLASSIFIED when policy is null (back-compat)', () => {
  const facade = buildHumanGateFacade({ riskPolicy: null });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'rc2-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rc-2', subject: 'no policy' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'rc2-rev',
    actor: { teamId: 'team-a', agentId: 'dev', role: 'developer' },
    args: { taskId: 'rc-2', summary: 's', files: ['.env.production'] },
  });
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'rc-2' });
  const riskEvents = t.history.filter((e) => e.eventType === 'task.risk_classified');
  assert.equal(riskEvents.length, 0);
  assert.equal(t.requiresHumanApproval, false);
});

test('classifier-driven elevation triggers the human-approval gate (end-to-end)', async () => {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  const policy = { rules: [{ pattern: '.env*', riskLevel: 'critical', requiresHumanApproval: true }] };
  const facade = buildHumanGateFacade({ riskPolicy: policy });
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'noop' } }));
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'e2e-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'e2e-1', subject: 'env edit', status: 'in_progress' },
  });
  // Agent claims the dangerous file
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'e2e-rev',
    actor: { teamId: 'team-a', agentId: 'dev', role: 'developer' },
    args: { taskId: 'e2e-1', summary: 's', files: ['.env.production'] },
  });
  const elevated = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'e2e-1' });
  assert.equal(elevated.requiresHumanApproval, true, 'classifier should have elevated');
  // Walk in_progress → review → testing
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'e2e-rev-status',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'e2e-1', status: 'review' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'e2e-test',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'e2e-1', status: 'testing' },
  });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'e2e-val',
    actor: { teamId: 'team-a', agentId: 'tester', role: 'tester' },
    args: { taskId: 'e2e-1', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'e2e-mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'e2e-1', status: 'merge_ready' },
  });
  // Done is blocked even though operator never set requiresHumanApproval directly
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'e2e-done',
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'e2e-1', status: 'done' },
    }),
    /human-approval gate/,
  );
});

// --- §19 slice 2: integration merge on merge_ready → done ---

function buildMergeIntegrationFacade({ mergeIntegrator, remoteMergePolicy } = {}) {
  return new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    spawnValidation: () => ({ exitCode: 0, stdout: 'pass', stderr: '', durationMs: 1 }),
    teamConfigRegistry: new (class {
      teams = new Map();
      registerTeam(c) { this.teams.set(c.teamId, c); }
      getTeam(id) { return this.teams.get(id) || null; }
      listTeams() { return Array.from(this.teams.values()); }
    })(),
    mergeIntegrator,
    remoteMergePolicy,
  });
}

async function walkToMergeReady(facade, taskId, { teamId = 'team-a', baseBranch = 'main', worktreeBranch } = {}) {
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  if (!facade.teamConfigRegistry.getTeam(teamId)) {
    facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId, validation: { testCommand: 'noop' } }));
  }
  // Synthesize a worktree directly via events so we don't need a real WorktreeManager.
  facade.taskBoard.appendEvent({
    teamId, taskId,
    idempotencyKey: `${taskId}:create`,
    eventType: 'task.created',
    actorId: 'lead',
    payload: { subject: 'integ smoke', status: 'testing', baseRef: 'BASE_SHA', baseBranch },
  });
  facade.taskBoard.appendEvent({
    teamId, taskId,
    idempotencyKey: `${taskId}:wt`,
    eventType: 'task.worktree_created',
    actorId: 'lead',
    payload: {
      status: 'created',
      path: '/tmp/wt',
      branch: worktreeBranch || `toad/${teamId}/${taskId}`,
      baseRef: 'BASE_SHA',
      createdAt: 'now',
    },
  });
  // Run validation to satisfy the CI gate
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: `${taskId}:val`,
    actor: { teamId, agentId: 'tester-1', role: 'tester' },
    args: { taskId, kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: `${taskId}:mr`,
    actor: { teamId, agentId: 'lead', role: 'lead' },
    args: { taskId, status: 'merge_ready' },
  });
}

test('merge_ready → done invokes mergeIntegrator and emits INTEGRATION_MERGED on success', async () => {
  const calls = [];
  const mergeIntegrator = {
    integrate(input) {
      calls.push(input);
      return {
        status: 'merged',
        baseBranch: input.baseBranch,
        mergeCommit: 'NEW_MERGE_SHA',
        parents: ['BASE_TIP', 'TASK_TIP'],
        mergedAt: '2026-05-01T22:00:00.000Z',
      };
    },
  };
  const facade = buildMergeIntegrationFacade({ mergeIntegrator });
  await walkToMergeReady(facade, 'integ-1');
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'integ-1:done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'integ-1', status: 'done' },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].baseBranch, 'main');
  assert.equal(calls[0].taskBranch, 'toad/team-a/integ-1');
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'integ-1' });
  assert.equal(t.status, 'done');
  assert.equal(t.integration.status, 'merged');
  assert.equal(t.integration.mergeCommit, 'NEW_MERGE_SHA');
  assert.deepEqual(t.integration.parents, ['BASE_TIP', 'TASK_TIP']);
});

test('merge_ready → done with no baseBranch on task records a "skipped" integration but lets the transition through', async () => {
  let called = false;
  const mergeIntegrator = {
    integrate() { called = true; return { status: 'merged' }; },
  };
  const facade = buildMergeIntegrationFacade({ mergeIntegrator });
  // Walk a task with NO baseBranch set
  const { TeamConfig } = await import('../src/team/teamConfig.js');
  facade.teamConfigRegistry.registerTeam(new TeamConfig({ teamId: 'team-a', validation: { testCommand: 'noop' } }));
  facade.taskBoard.appendEvent({
    teamId: 'team-a', taskId: 'no-base',
    idempotencyKey: 'no-base:create',
    eventType: 'task.created',
    actorId: 'lead',
    payload: { subject: 'no base branch', status: 'testing' },
  });
  facade.taskBoard.appendEvent({
    teamId: 'team-a', taskId: 'no-base',
    idempotencyKey: 'no-base:wt',
    eventType: 'task.worktree_created',
    actorId: 'lead',
    payload: { status: 'created', path: '/tmp/wt', branch: 'toad/team-a/no-base', baseRef: 'BASE', createdAt: 'now' },
  });
  await facade.execute({
    commandName: COMMANDS.VALIDATION_RUN,
    idempotencyKey: 'no-base:val',
    actor: { teamId: 'team-a', agentId: 'tester-1', role: 'tester' },
    args: { taskId: 'no-base', kind: 'test' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'no-base:mr',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-base', status: 'merge_ready' },
  });
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'no-base:done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-base', status: 'done' },
  });
  assert.equal(called, false, 'integrator should not be called when task has no baseBranch');
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'no-base' });
  assert.equal(t.status, 'done');
  assert.equal(t.integration.status, 'skipped');
  assert.equal(t.integration.reason, 'no_base_branch');
});

test('merge_ready → done is BLOCKED when integrator returns { status: error }', async () => {
  const mergeIntegrator = {
    integrate: () => ({ status: 'error', reason: 'update_ref_failed', stderr: 'race detected' }),
  };
  const facade = buildMergeIntegrationFacade({ mergeIntegrator });
  await walkToMergeReady(facade, 'integ-err');
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'integ-err:done',
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'integ-err', status: 'done' },
    }),
    /merge_ready . done blocked.*update_ref_failed/,
  );
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'integ-err' });
  assert.equal(t.status, 'merge_ready');
});

test('merge_ready → done is BLOCKED when remoteMergePolicy verdict.allow=false (PR required)', async () => {
  const policyCalls = [];
  const remoteMergePolicy = {
    evaluate: async ({ baseBranch, taskBranch }) => {
      policyCalls.push({ baseBranch, taskBranch });
      return {
        allow: false,
        reason: 'requires_pr',
        protection: {
          ok: true, protected: true, requiresPullRequest: true,
          requiredApprovingReviewCount: 1, requiresStatusChecks: false,
          requiredStatusCheckContexts: [], enforceAdmins: false,
          allowForcePushes: false, allowDeletions: false,
          requiresLinearHistory: false, hasPushRestrictions: false,
        },
      };
    },
  };
  let integratorCalled = false;
  const mergeIntegrator = {
    integrate: () => { integratorCalled = true; return { status: 'merged' }; },
  };
  const facade = buildMergeIntegrationFacade({ mergeIntegrator, remoteMergePolicy });
  await walkToMergeReady(facade, 'rp-blocked');

  await assert.rejects(
    async () => facade.execute({
      commandName: COMMANDS.TASK_UPDATE,
      idempotencyKey: 'rp-blocked:done',
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 'rp-blocked', status: 'done' },
    }),
    /requires_pr|github_create_pull_request/,
  );

  assert.equal(policyCalls.length, 1);
  assert.equal(policyCalls[0].baseBranch, 'main');
  assert.equal(policyCalls[0].taskBranch, 'toad/team-a/rp-blocked');
  assert.equal(integratorCalled, false, 'integrator must NOT be called when policy refuses');
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'rp-blocked' });
  assert.equal(t.status, 'merge_ready', 'task must remain in merge_ready');
});

test('merge_ready → done proceeds when remoteMergePolicy verdict.allow=true and records reason', async () => {
  const remoteMergePolicy = {
    evaluate: async () => ({ allow: true, reason: 'unprotected' }),
  };
  const mergeIntegrator = {
    integrate: (input) => ({
      status: 'merged', baseBranch: input.baseBranch,
      mergeCommit: 'NEW_SHA', parents: ['B', 'T'], mergedAt: '2026-05-02T00:00:00.000Z',
    }),
  };
  const facade = buildMergeIntegrationFacade({ mergeIntegrator, remoteMergePolicy });
  await walkToMergeReady(facade, 'rp-allow');
  await facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rp-allow:done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rp-allow', status: 'done' },
  });
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'rp-allow' });
  assert.equal(t.status, 'done');
  assert.equal(t.integration.status, 'merged');
  assert.equal(t.integration.remotePolicy?.reason, 'unprotected');
});

test('merge_ready → done with no remoteMergePolicy configured leaves merge unaffected (back-compat)', async () => {
  const mergeIntegrator = {
    integrate: () => ({ status: 'merged', baseBranch: 'main', mergeCommit: 'X', parents: ['a','b'], mergedAt: 'now' }),
  };
  const facade = buildMergeIntegrationFacade({ mergeIntegrator, remoteMergePolicy: null });
  await walkToMergeReady(facade, 'rp-none');
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'rp-none:done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'rp-none', status: 'done' },
  });
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'rp-none' });
  assert.equal(t.status, 'done');
  assert.equal(t.integration.status, 'merged');
});

test('merge_ready → done with no integrator configured leaves integration null (back-compat)', async () => {
  const facade = buildMergeIntegrationFacade({ mergeIntegrator: null });
  await walkToMergeReady(facade, 'no-integ');
  facade.execute({
    commandName: COMMANDS.TASK_UPDATE,
    idempotencyKey: 'no-integ:done',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'no-integ', status: 'done' },
  });
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'no-integ' });
  assert.equal(t.status, 'done');
  assert.equal(t.integration, null);
});

// --- §1 follow-up: priority/assignedRole/testCommands/expectedDeliverables/dependencyTaskIds ---

test('task_create accepts §1 follow-up fields and validates enums', () => {
  const facade = new LocalToolFacade({ broker: new InMemoryBroker(), taskBoard: new InMemoryTaskBoard() });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 's1-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {
      taskId: 's1-1',
      subject: 'rich',
      priority: 'urgent',
      assignedRole: 'tester',
      testCommands: ['npm test'],
      expectedDeliverables: ['out.txt'],
      dependencyTaskIds: ['parent-1'],
    },
  });
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 's1-1' });
  assert.equal(t.priority, 'urgent');
  assert.equal(t.assignedRole, 'tester');
  assert.deepEqual(t.testCommands, ['npm test']);
  assert.deepEqual(t.dependencyTaskIds, ['parent-1']);

  // bad priority rejected
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_CREATE,
      idempotencyKey: 's1-bad-prio',
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 's1-2', subject: 'x', priority: 'apocalyptic' },
    }),
    /unsupported priority/,
  );
  // bad assignedRole rejected
  assert.throws(
    () => facade.execute({
      commandName: COMMANDS.TASK_CREATE,
      idempotencyKey: 's1-bad-role',
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { taskId: 's1-3', subject: 'x', assignedRole: 'fairy' },
    }),
    /unsupported assignedRole/,
  );
});

// --- §14 follow-up: command rules in risk classifier ---

test('review_request pulls Bash commands from runtime_events and matches commandRules', () => {
  const fakeEventLog = {
    listEventsByTask({ teamId, taskId }) {
      assert.equal(taskId, 'cmd-1');
      return [
        { eventType: 'tool_use', payload: { toolName: 'Bash', input: { command: 'rm -rf /tmp/junk' } } },
        { eventType: 'tool_use', payload: { toolName: 'Read',  input: { file_path: 'README.md' } } },  // not a shell
        { eventType: 'assistant_text', payload: { text: 'done' } },
      ];
    },
    appendEvent() { return { inserted: true, event: {} }; },
  };
  const policy = {
    commandRules: [
      { pattern: 'rm -rf*', riskLevel: 'critical', requiresHumanApproval: true },
    ],
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    eventLog: fakeEventLog,
    riskPolicy: policy,
  });
  facade.execute({
    commandName: COMMANDS.TASK_CREATE,
    idempotencyKey: 'cmd-create',
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { taskId: 'cmd-1', subject: 'destructive cleanup' },
  });
  facade.execute({
    commandName: COMMANDS.REVIEW_REQUEST,
    idempotencyKey: 'cmd-rev',
    actor: { teamId: 'team-a', agentId: 'dev', role: 'developer' },
    args: { taskId: 'cmd-1', summary: 'cleaned up', files: ['noop.txt'] },
  });
  const t = facade.taskBoard.getTask({ teamId: 'team-a', taskId: 'cmd-1' });
  assert.equal(t.riskLevel, 'critical');
  assert.equal(t.requiresHumanApproval, true);
  const riskEvents = t.history.filter((e) => e.eventType === 'task.risk_classified');
  assert.equal(riskEvents.length, 1);
  // Matched rule should be tagged appliesTo: 'commands'
  const matched = riskEvents[0].payload.matchedRules;
  assert.equal(matched.length, 1);
  assert.equal(matched[0].appliesTo, 'commands');
  assert.equal(matched[0].pattern, 'rm -rf*');
});

// --- §13 follow-up: stuck_runtime_list MCP tool ---

test('stuck_runtime_list returns the detector output filtered to actor.teamId', () => {
  const fakeRegistry = {
    listRuntimes({ teamId } = {}) {
      const all = [
        { runtimeId: 'r-stuck', teamId: 'team-a', agentId: 'a', taskId: 'task-1', status: 'running', startedAt: '2026-05-01T20:00:00.000Z' },
        { runtimeId: 'r-fresh', teamId: 'team-a', agentId: 'b', taskId: 'task-2', status: 'running', startedAt: '2026-05-01T21:55:00.000Z' },
        { runtimeId: 'r-other', teamId: 'team-other', agentId: 'c', status: 'running', startedAt: '2026-05-01T20:00:00.000Z' },
      ];
      return teamId ? all.filter((r) => r.teamId === teamId) : all;
    },
  };
  const fakeEventLog = {
    latestEventByRuntime() {
      return new Map([
        ['r-fresh', '2026-05-01T21:59:00.000Z'],
      ]);
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    runtimeRegistry: fakeRegistry,
    eventLog: fakeEventLog,
  });
  const result = facade.execute({
    commandName: COMMANDS.STUCK_RUNTIME_LIST,
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: { thresholdMs: 15 * 60_000, now: '2026-05-01T22:00:00.000Z' },
  });
  // r-stuck has no events, startedAt is far in the past — flagged
  // r-fresh ticked 1min ago (per fake `now`) — within threshold
  // r-other is in another team — filtered by registry
  assert.equal(result.length, 1);
  assert.equal(result[0].runtimeId, 'r-stuck');
  assert.equal(result[0].taskId, 'task-1');
});


// --- §3 Phase 3b: settings_get / settings_set ---

test('settings_get returns merged effective settings + paths', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-set-fac1-'));
  const settingsStore = new SettingsStore({ globalPath: path.join(tmpRoot, 'g.json'), projectCwd: tmpRoot });
  await settingsStore.setSection({ scope: 'global', section: 'general', value: { theme: 'dark' } });

  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    settingsStore,
  });
  const result = await facade.execute({
    commandName: COMMANDS.SETTINGS_GET,
    actor: { teamId: 'team-a', agentId: 'operator', role: 'human' },
    args: {},
  });
  assert.equal(result.scope, 'effective');
  assert.equal(result.settings.general.theme, 'dark');
  assert.equal(result.paths.global, path.join(tmpRoot, 'g.json'));
  assert.equal(result.paths.project, path.join(tmpRoot, '.toad', 'settings.json'));
});

test('settings_set writes a section and persists across reads', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-set-fac2-'));
  const settingsStore = new SettingsStore({ globalPath: path.join(tmpRoot, 'g.json'), projectCwd: tmpRoot });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    settingsStore,
  });

  const writeResult = await facade.execute({
    commandName: COMMANDS.SETTINGS_SET,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { scope: 'global', section: 'github', value: { user: 'alice', tokenScopes: ['repo'] } },
    idempotencyKey: 'k-1',
  });
  assert.equal(writeResult.scope, 'global');
  assert.equal(writeResult.section, 'github');
  assert.deepEqual(writeResult.value, { user: 'alice', tokenScopes: ['repo'] });

  const readResult = await facade.execute({
    commandName: COMMANDS.SETTINGS_GET,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { scope: 'global' },
  });
  assert.deepEqual(readResult.settings.github, { user: 'alice', tokenScopes: ['repo'] });
});

test('settings_set rejects bad scope/section/value', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-set-fac3-'));
  const settingsStore = new SettingsStore({ globalPath: path.join(tmpRoot, 'g.json'), projectCwd: tmpRoot });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    settingsStore,
  });
  const actor = { teamId: 'team-a', agentId: 'lead', role: 'lead' };

  await assert.rejects(
    () => facade.execute({ commandName: COMMANDS.SETTINGS_SET, actor, idempotencyKey: 'k-2', args: { scope: 'invalid', section: 'general', value: {} } }),
    /scope must be/,
  );
  await assert.rejects(
    () => facade.execute({ commandName: COMMANDS.SETTINGS_SET, actor, idempotencyKey: 'k-3', args: { scope: 'global', section: '', value: {} } }),
    /section must be/,
  );
  await assert.rejects(
    () => facade.execute({ commandName: COMMANDS.SETTINGS_SET, actor, idempotencyKey: 'k-4', args: { scope: 'global', section: 'general', value: 'oops' } }),
    /value must be/,
  );
});

test('settings_get throws cleanly when no settings store is configured', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  await assert.rejects(
    () => facade.execute({
      commandName: COMMANDS.SETTINGS_GET,
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: {},
    }),
    /no settings store/,
  );
});

test('settings_set is denied for non-lead/non-human roles', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-set-fac4-'));
  const settingsStore = new SettingsStore({ globalPath: path.join(tmpRoot, 'g.json'), projectCwd: tmpRoot });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    settingsStore,
  });
  await assert.rejects(
    async () => facade.execute({
      commandName: COMMANDS.SETTINGS_SET,
      actor: { teamId: 'team-a', agentId: 'rev', role: 'reviewer' },
      idempotencyKey: 'k-deny',
      args: { scope: 'global', section: 'general', value: { theme: 'dark' } },
    }),
    /role authority/,
  );
});

// --- §3c Phase 3c: GitHub auth ---

function makeGithubMock(routes) {
  return async (url, init) => {
    for (const [matcher, handler] of routes) {
      if (typeof matcher === 'string' ? url === matcher : matcher.test(url)) {
        return handler({ url, init });
      }
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
}

function ghJson(body, { status = 200, scopes } = {}) {
  const headers = {
    get(n) {
      if (n.toLowerCase() === 'x-oauth-scopes') return scopes ?? null;
      return null;
    },
  };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
}

async function makeFacadeWithSettings({ githubFetch, githubClientId } = {}) {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-gh-fac-'));
  const settingsStore = new SettingsStore({ globalPath: path.join(tmpRoot, 'g.json'), projectCwd: tmpRoot });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    settingsStore,
    githubFetch,
    githubClientId,
  });
  return { facade, settingsStore };
}

test('github_device_start uses the baked-in default client_id when nothing else is set', async () => {
  // BUILT_IN_GITHUB_CLIENT_ID in src/github/githubAppDefaults.js is the
  // resolver's last-resort fallback. When the project ships with a
  // non-empty default, device_start should succeed without an env var or
  // user-saved clientId.
  const { BUILT_IN_GITHUB_CLIENT_ID } = await import('../src/github/githubAppDefaults.js');
  if (!BUILT_IN_GITHUB_CLIENT_ID) {
    // No default shipped — assert the legacy "no client_id" error path.
    const { facade } = await makeFacadeWithSettings();
    await assert.rejects(
      async () => facade.execute({
        commandName: COMMANDS.GITHUB_DEVICE_START,
        actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
        args: {},
      }),
      /no OAuth client_id/,
    );
    return;
  }
  // Default IS shipped — verify the resolver picks it up.
  const githubFetch = makeGithubMock([
    [/login\/device\/code$/, ({ init }) => {
      // Confirm the baked-in client_id was used in the request body.
      assert.match(init.body, new RegExp(`client_id=${BUILT_IN_GITHUB_CLIENT_ID}`));
      return ghJson({ device_code: 'dc', user_code: 'AAAA-BBBB', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    }],
  ]);
  const { facade } = await makeFacadeWithSettings({ githubFetch });
  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_DEVICE_START,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {},
  });
  assert.equal(result.userCode, 'AAAA-BBBB');
});

test('github_device_start returns user code + verification URL', async () => {
  const githubFetch = makeGithubMock([
    [/login\/device\/code$/, () => ghJson({
      device_code: 'dc_xyz', user_code: 'AAAA-BBBB',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900, interval: 5,
    })],
  ]);
  const { facade } = await makeFacadeWithSettings({ githubFetch, githubClientId: 'cid-toad' });
  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_DEVICE_START,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {},
  });
  assert.equal(result.userCode, 'AAAA-BBBB');
  assert.equal(result.verificationUri, 'https://github.com/login/device');
  assert.equal(result.interval, 5);
});

test('github_device_poll returns pending while user is authorizing', async () => {
  const githubFetch = makeGithubMock([
    [/login\/oauth\/access_token$/, () => ghJson({ error: 'authorization_pending' })],
  ]);
  const { facade } = await makeFacadeWithSettings({ githubFetch, githubClientId: 'cid' });
  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_DEVICE_POLL,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { deviceCode: 'dc' },
    idempotencyKey: 'k-poll',
  });
  assert.equal(result.status, 'pending');
  assert.equal(result.reason, 'authorization_pending');
});

test('github_device_poll persists creds and returns granted on access_token', async () => {
  const githubFetch = makeGithubMock([
    [/login\/oauth\/access_token$/, () => ghJson({ access_token: 'gho_real', token_type: 'bearer', scope: 'repo,read:user' })],
    [/api\.github\.com\/user$/, () => ghJson({ login: 'octocat', id: 1, name: 'O', avatar_url: 'a', html_url: 'h' }, { scopes: 'repo, read:user' })],
  ]);
  const { facade, settingsStore } = await makeFacadeWithSettings({ githubFetch, githubClientId: 'cid' });

  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_DEVICE_POLL,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { deviceCode: 'dc' },
    idempotencyKey: 'k-grant',
  });
  assert.equal(result.status, 'granted');
  assert.equal(result.user.login, 'octocat');

  const persisted = await settingsStore.readGlobalRaw();
  assert.equal(persisted.github.source, 'device');
  assert.equal(persisted.github.accessToken, 'gho_real');
  assert.equal(persisted.github.user.login, 'octocat');
});

test('github_pat_verify returns rejected on bad credentials', async () => {
  const githubFetch = makeGithubMock([
    [/api\.github\.com\/user$/, () => ghJson({ message: 'Bad credentials' }, { status: 401 })],
  ]);
  const { facade, settingsStore } = await makeFacadeWithSettings({ githubFetch });
  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_PAT_VERIFY,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { token: 'pat_bad' },
    idempotencyKey: 'k-pat-bad',
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.httpStatus, 401);
  const persisted = await settingsStore.readGlobalRaw();
  assert.equal(persisted.github?.accessToken ?? null, null);
});

test('github_pat_verify persists token + user + scopes on success', async () => {
  const githubFetch = makeGithubMock([
    [/api\.github\.com\/user$/, () => ghJson({ login: 'alice', id: 7 }, { scopes: 'repo' })],
  ]);
  const { facade, settingsStore } = await makeFacadeWithSettings({ githubFetch });
  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_PAT_VERIFY,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { token: 'pat_good' },
    idempotencyKey: 'k-pat-ok',
  });
  assert.equal(result.status, 'verified');
  const persisted = await settingsStore.readGlobalRaw();
  assert.equal(persisted.github.source, 'pat');
  assert.equal(persisted.github.accessToken, 'pat_good');
  assert.deepEqual(persisted.github.scopes, ['repo']);
  assert.equal(persisted.github.user.login, 'alice');
});

test('github_status reports disconnected without creds, connected after', async () => {
  const githubFetch = makeGithubMock([
    [/api\.github\.com\/user$/, () => ghJson({ login: 'bob', id: 9 }, { scopes: 'repo' })],
  ]);
  const { facade } = await makeFacadeWithSettings({ githubFetch });

  const before = await facade.execute({
    commandName: COMMANDS.GITHUB_STATUS,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {},
  });
  assert.equal(before.status, 'disconnected');

  await facade.execute({
    commandName: COMMANDS.GITHUB_PAT_VERIFY,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { token: 'pat_z' },
    idempotencyKey: 'k-pat-z',
  });

  const after = await facade.execute({
    commandName: COMMANDS.GITHUB_STATUS,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {},
  });
  assert.equal(after.status, 'connected');
  assert.equal(after.source, 'pat');
  assert.equal(after.user.login, 'bob');
});

test('github_get_repository fails when no token is stored', async () => {
  const { facade } = await makeFacadeWithSettings();
  await assert.rejects(
    async () => facade.execute({
      commandName: COMMANDS.GITHUB_GET_REPOSITORY,
      actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
      args: { owner: 'kaydenraquel', repo: 'toad' },
    }),
    /not connected/i,
  );
});

test('github_get_repository uses stored bearer token to fetch /repos/{owner}/{repo}', async () => {
  let captured;
  const githubFetch = makeGithubMock([
    [/api\.github\.com\/user$/, () => ghJson({ login: 'kaydenraquel', id: 1 }, { scopes: 'repo' })],
    [/api\.github\.com\/repos\//, ({ url, init }) => {
      captured = { url, init };
      return ghJson({
        id: 99, name: 'toad', full_name: 'kaydenraquel/toad',
        private: false, default_branch: 'main',
        html_url: 'https://github.com/kaydenraquel/toad',
        visibility: 'public', archived: false,
      });
    }],
  ]);
  const { facade } = await makeFacadeWithSettings({ githubFetch });
  // Authenticate first so token is in the settings store.
  await facade.execute({
    commandName: COMMANDS.GITHUB_PAT_VERIFY,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { token: 'pat_repo' },
    idempotencyKey: 'k-pat-repo',
  });

  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_GET_REPOSITORY,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { owner: 'kaydenraquel', repo: 'toad' },
  });

  assert.match(captured.url, /\/repos\/kaydenraquel\/toad$/);
  assert.equal(captured.init.headers.Authorization, 'Bearer pat_repo');
  assert.equal(result.ok, true);
  assert.equal(result.repo.fullName, 'kaydenraquel/toad');
  assert.equal(result.repo.defaultBranch, 'main');
});

test('github_get_repository surfaces ok=false on 404 instead of throwing', async () => {
  const githubFetch = makeGithubMock([
    [/api\.github\.com\/user$/, () => ghJson({ login: 'x', id: 2 }, { scopes: 'repo' })],
    [/api\.github\.com\/repos\//, () => ghJson({ message: 'Not Found' }, { status: 404 })],
  ]);
  const { facade } = await makeFacadeWithSettings({ githubFetch });
  await facade.execute({
    commandName: COMMANDS.GITHUB_PAT_VERIFY,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { token: 'pat_404' },
    idempotencyKey: 'k-pat-404',
  });
  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_GET_REPOSITORY,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { owner: 'x', repo: 'missing' },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
});

test('github_get_branch_protection requires connection and returns normalized policy view', async () => {
  let captured;
  const githubFetch = makeGithubMock([
    [/api\.github\.com\/user$/, () => ghJson({ login: 'kaydenraquel', id: 1 }, { scopes: 'repo' })],
    [/api\.github\.com\/repos\/.*\/branches\/.*\/protection$/, ({ url, init }) => {
      captured = { url, init };
      return ghJson({
        required_pull_request_reviews: { required_approving_review_count: 1 },
        required_status_checks: { strict: true, contexts: ['ci/build'] },
        enforce_admins: { enabled: false },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
      });
    }],
  ]);
  const { facade } = await makeFacadeWithSettings({ githubFetch });

  // Not connected → should error.
  await assert.rejects(
    async () => facade.execute({
      commandName: COMMANDS.GITHUB_GET_BRANCH_PROTECTION,
      actor: { teamId: 't', agentId: 'lead', role: 'lead' },
      args: { owner: 'k', repo: 't', branch: 'main' },
    }),
    /not connected/i,
  );

  await facade.execute({
    commandName: COMMANDS.GITHUB_PAT_VERIFY,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: { token: 'pat_bp' },
    idempotencyKey: 'k-bp',
  });

  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_GET_BRANCH_PROTECTION,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: { owner: 'kaydenraquel', repo: 'toad', branch: 'main' },
  });

  assert.match(captured.url, /\/repos\/kaydenraquel\/toad\/branches\/main\/protection$/);
  assert.equal(captured.init.headers.Authorization, 'Bearer pat_bp');
  assert.equal(result.ok, true);
  assert.equal(result.protected, true);
  assert.equal(result.requiresPullRequest, true);
  assert.equal(result.requiredApprovingReviewCount, 1);
  assert.deepEqual(result.requiredStatusCheckContexts, ['ci/build']);
});

test('github_get_branch_protection returns protected=false on unprotected branches (404)', async () => {
  const githubFetch = makeGithubMock([
    [/api\.github\.com\/user$/, () => ghJson({ login: 'k', id: 1 }, { scopes: 'repo' })],
    [/api\.github\.com\/repos\/.*\/branches\/.*\/protection$/, () =>
      ghJson({ message: 'Branch not protected' }, { status: 404 })],
  ]);
  const { facade } = await makeFacadeWithSettings({ githubFetch });
  await facade.execute({
    commandName: COMMANDS.GITHUB_PAT_VERIFY,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: { token: 'pat_unp' },
    idempotencyKey: 'k-unp',
  });
  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_GET_BRANCH_PROTECTION,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: { owner: 'o', repo: 'r', branch: 'feature' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.protected, false);
  assert.equal(result.requiresPullRequest, false);
});

test('github_create_pull_request requires connection and POSTs with stored token', async () => {
  let captured;
  const githubFetch = makeGithubMock([
    [/api\.github\.com\/user$/, () => ghJson({ login: 'kaydenraquel', id: 1 }, { scopes: 'repo' })],
    [/api\.github\.com\/repos\/.*\/pulls$/, ({ url, init }) => {
      captured = { url, init };
      return ghJson(
        {
          id: 1, number: 42, state: 'open', title: 'Add feature',
          body: 'Closes #1', html_url: 'https://github.com/k/t/pull/42',
          draft: false, merged: false,
          head: { ref: 'feat/x', sha: 'aaa' },
          base: { ref: 'main', sha: 'bbb' },
          user: { login: 'kaydenraquel' },
        },
        { status: 201 },
      );
    }],
  ]);
  const { facade } = await makeFacadeWithSettings({ githubFetch });

  // Not connected → error.
  await assert.rejects(
    async () => facade.execute({
      commandName: COMMANDS.GITHUB_CREATE_PULL_REQUEST,
      actor: { teamId: 't', agentId: 'lead', role: 'lead' },
      args: { owner: 'k', repo: 't', head: 'feat/x', base: 'main', title: 'Add feature' },
      idempotencyKey: 'k-pr-noauth',
    }),
    /not connected/i,
  );

  await facade.execute({
    commandName: COMMANDS.GITHUB_PAT_VERIFY,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: { token: 'pat_pr' },
    idempotencyKey: 'k-pat-pr',
  });

  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_CREATE_PULL_REQUEST,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: {
      owner: 'kaydenraquel',
      repo: 'toad',
      head: 'feat/x',
      base: 'main',
      title: 'Add feature',
      body: 'Closes #1',
    },
    idempotencyKey: 'k-pr-1',
  });

  assert.match(captured.url, /\/repos\/kaydenraquel\/toad\/pulls$/);
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers.Authorization, 'Bearer pat_pr');
  const sent = JSON.parse(captured.init.body);
  assert.equal(sent.head, 'feat/x');
  assert.equal(sent.base, 'main');
  assert.equal(sent.title, 'Add feature');
  assert.equal(sent.body, 'Closes #1');
  assert.equal(result.ok, true);
  assert.equal(result.pr.number, 42);
  assert.equal(result.pr.htmlUrl, 'https://github.com/k/t/pull/42');
});

test('github_create_pull_request surfaces 422 (PR already exists) without throwing', async () => {
  const githubFetch = makeGithubMock([
    [/api\.github\.com\/user$/, () => ghJson({ login: 'k', id: 1 }, { scopes: 'repo' })],
    [/api\.github\.com\/repos\/.*\/pulls$/, () =>
      ghJson(
        {
          message: 'Validation Failed',
          errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for k:feat.' }],
        },
        { status: 422 },
      )],
  ]);
  const { facade } = await makeFacadeWithSettings({ githubFetch });
  await facade.execute({
    commandName: COMMANDS.GITHUB_PAT_VERIFY,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: { token: 'pat_dup' },
    idempotencyKey: 'k-pat-dup',
  });
  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_CREATE_PULL_REQUEST,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: { owner: 'k', repo: 't', head: 'feat', base: 'main', title: 'x' },
    idempotencyKey: 'k-pr-dup',
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 422);
  assert.match(result.errors[0].message, /already exists/);
});

test('github_create_pull_request rejects non-lead/human roles', async () => {
  const { facade } = await makeFacadeWithSettings();
  await assert.rejects(
    async () => facade.execute({
      commandName: COMMANDS.GITHUB_CREATE_PULL_REQUEST,
      actor: { teamId: 't', agentId: 'dev', role: 'developer' },
      args: { owner: 'k', repo: 't', head: 'feat', base: 'main', title: 'x' },
      idempotencyKey: 'k-pr-deny',
    }),
    /role authority/,
  );
});

test('github_create_pull_request requires an idempotency key (mutating)', async () => {
  const { facade } = await makeFacadeWithSettings();
  await assert.rejects(
    async () => facade.execute({
      commandName: COMMANDS.GITHUB_CREATE_PULL_REQUEST,
      actor: { teamId: 't', agentId: 'lead', role: 'lead' },
      args: { owner: 'k', repo: 't', head: 'feat', base: 'main', title: 'x' },
      // no idempotencyKey
    }),
    /idempotencyKey/i,
  );
});

test('github_origin_remote returns parsed { owner, repo } when origin is a GitHub URL', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-gh-origin-'));
  const settingsStore = new SettingsStore({ globalPath: path.join(tmpRoot, 'g.json'), projectCwd: tmpRoot });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    settingsStore,
    projectCwd: tmpRoot,
    runGit: () => ({ exitCode: 0, stdout: 'https://github.com/kaydenraquel/toad.git\n', stderr: '' }),
  });
  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_ORIGIN_REMOTE,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: {},
  });
  assert.equal(result.ok, true);
  assert.equal(result.owner, 'kaydenraquel');
  assert.equal(result.repo, 'toad');
});

test('github_origin_remote returns ok=false when origin is not a GitHub URL', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-gh-origin-'));
  const settingsStore = new SettingsStore({ globalPath: path.join(tmpRoot, 'g.json'), projectCwd: tmpRoot });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    settingsStore,
    projectCwd: tmpRoot,
    runGit: () => ({ exitCode: 0, stdout: 'https://gitlab.com/o/r.git\n', stderr: '' }),
  });
  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_ORIGIN_REMOTE,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'origin_not_github');
});

test('github_origin_remote returns ok=false when origin lookup fails', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-gh-origin-'));
  const settingsStore = new SettingsStore({ globalPath: path.join(tmpRoot, 'g.json'), projectCwd: tmpRoot });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    settingsStore,
    projectCwd: tmpRoot,
    runGit: () => ({ exitCode: 128, stdout: '', stderr: 'fatal: No such remote' }),
  });
  const result = await facade.execute({
    commandName: COMMANDS.GITHUB_ORIGIN_REMOTE,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: {},
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_origin_remote');
});

test('github_disconnect clears creds but preserves clientId', async () => {
  const { facade, settingsStore } = await makeFacadeWithSettings();
  await settingsStore.setSection({
    scope: 'global', section: 'github',
    value: { source: 'pat', accessToken: 't', user: { login: 'x' }, scopes: ['repo'], clientId: 'cid-keep' },
  });
  await facade.execute({
    commandName: COMMANDS.GITHUB_DISCONNECT,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: {},
    idempotencyKey: 'k-disc',
  });
  const persisted = await settingsStore.readGlobalRaw();
  assert.equal(persisted.github.accessToken ?? null, null);
  assert.equal(persisted.github.user ?? null, null);
  assert.equal(persisted.github.clientId, 'cid-keep');
});

// --- §3d Phase 3d: risk policy editor ---

async function makeFacadeWithRiskPolicy() {
  const projectCwd = await fs.mkdtemp(path.join(os.tmpdir(), 'toad-rpol-fac-'));
  const riskPolicyStore = new RiskPolicyStore({ projectCwd });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    riskPolicyStore,
  });
  return { facade, riskPolicyStore, projectCwd };
}

test('risk_policy_get returns empty + exists=false on a fresh project', async () => {
  const { facade } = await makeFacadeWithRiskPolicy();
  const result = await facade.execute({
    commandName: COMMANDS.RISK_POLICY_GET,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: {},
  });
  assert.equal(result.exists, false);
  assert.deepEqual(result.rules, []);
});

test('risk_policy_set persists rules + commandRules', async () => {
  const { facade, riskPolicyStore } = await makeFacadeWithRiskPolicy();
  await facade.execute({
    commandName: COMMANDS.RISK_POLICY_SET,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    idempotencyKey: 'k-rpset',
    args: {
      rules: [{ pattern: '.env*', riskLevel: 'critical', requiresHumanApproval: true }],
      commandRules: [{ pattern: 'rm -rf', riskLevel: 'high' }],
    },
  });
  const reread = await riskPolicyStore.read();
  assert.equal(reread.rules[0].pattern, '.env*');
  assert.equal(reread.commandRules[0].pattern, 'rm -rf');
});

test('risk_policy_preview classifies against the supplied policy', async () => {
  const { facade } = await makeFacadeWithRiskPolicy();
  const verdict = await facade.execute({
    commandName: COMMANDS.RISK_POLICY_PREVIEW,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: {
      files: ['.env.production', 'src/app.ts'],
      commands: [],
      policy: {
        rules: [
          { pattern: '.env*', riskLevel: 'critical', requiresHumanApproval: true },
        ],
      },
    },
  });
  assert.equal(verdict.riskLevel, 'critical');
  assert.equal(verdict.requiresHumanApproval, true);
  assert.equal(verdict.matchedRules.length, 1);
  assert.equal(verdict.matchedRules[0].pattern, '.env*');
});

test('risk_policy_set is denied for non-lead/non-human roles', async () => {
  const { facade } = await makeFacadeWithRiskPolicy();
  await assert.rejects(
    async () => facade.execute({
      commandName: COMMANDS.RISK_POLICY_SET,
      actor: { teamId: 't', agentId: 'rev', role: 'reviewer' },
      idempotencyKey: 'k-rp-deny',
      args: { rules: [], commandRules: [] },
    }),
    /role authority/,
  );
});

// --- §3c.2 Phase 3c.2: provider plan-auth ---

test('provider_auth_status anthropic happy path returns signedIn:true', async () => {
  // Anthropic detection is now file-based (~/.claude/.credentials.json).
  // We don't have an injectable readFile/stat hook on the facade yet, so we
  // mock the spawnSync (which is no longer hit for Anthropic) only to ensure
  // we don't accidentally exec — and just verify the facade dispatches the
  // anthropic provider correctly. The detailed file-parse logic is tested
  // in test/providerAuth.test.js.
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    providerAuthSpawnSync: () => { throw new Error('should not spawn for anthropic'); },
  });
  const result = facade.execute({
    commandName: COMMANDS.PROVIDER_AUTH_STATUS,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: { providerId: 'anthropic' },
  });
  // Result depends on whether the test machine has ~/.claude/.credentials.json.
  // We just assert the call shape is correct (no exception, returns the expected
  // provider id, supported is true, signedIn is a boolean or null).
  assert.equal(result.providerId, 'anthropic');
  assert.equal(result.supported, true);
  assert.ok(typeof result.signedIn === 'boolean' || result.signedIn === null);
});

test('provider_auth_status returns supported=false for opencode (placeholder)', () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  const result = facade.execute({
    commandName: COMMANDS.PROVIDER_AUTH_STATUS,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: { providerId: 'opencode' },
  });
  assert.equal(result.supported, false);
  assert.equal(result.signedIn, null);
});

test('provider_auth_login dispatches spawn for non-manual providers', () => {
  // Gemini is still auto-spawn. Anthropic and Codex now return manual-login
  // instructions instead — see provider_auth_login returns manualLogin test below.
  let captured = null;
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    providerAuthSpawn: (cli, args) => {
      captured = { cli, args };
      return { pid: 7, unref() {} };
    },
  });
  const result = facade.execute({
    commandName: COMMANDS.PROVIDER_AUTH_LOGIN,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: { providerId: 'gemini' },
    idempotencyKey: 'k-paul',
  });
  assert.equal(result.started, true);
  assert.equal(captured.cli, 'gemini');
  assert.deepEqual(captured.args, ['auth', 'login']);
});

test('provider_auth_login returns manual-login instructions for Claude and Codex', () => {
  let spawnCalled = false;
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    providerAuthSpawn: () => { spawnCalled = true; return { pid: 1, unref() {} }; },
  });
  for (const providerId of ['anthropic', 'openai']) {
    const result = facade.execute({
      commandName: COMMANDS.PROVIDER_AUTH_LOGIN,
      actor: { teamId: 't', agentId: 'lead', role: 'lead' },
      args: { providerId },
      idempotencyKey: `k-manual-${providerId}`,
    });
    assert.equal(result.started, false, providerId);
    assert.equal(result.manualLogin, true, providerId);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0, providerId);
  }
  assert.equal(spawnCalled, false, 'no provider should auto-spawn');
});

test('provider_auth_logout dispatches synchronous spawn', () => {
  let captured = null;
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    providerAuthSpawnSync: (cli, args) => {
      captured = { cli, args };
      return { status: 0, stdout: '', stderr: '', error: null };
    },
  });
  const result = facade.execute({
    commandName: COMMANDS.PROVIDER_AUTH_LOGOUT,
    actor: { teamId: 't', agentId: 'lead', role: 'lead' },
    args: { providerId: 'anthropic' },
    idempotencyKey: 'k-pa-out',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(captured.args, ['auth', 'logout']);
});

// --- §20 audit_log_query ---

test('audit_log_query merges task + runtime events sorted newest first', () => {
  const broker = new InMemoryBroker();
  const taskBoard = new InMemoryTaskBoard();
  taskBoard.appendEvent({
    teamId: 'team-a', taskId: 'task-1', idempotencyKey: 'k1',
    eventType: TASK_EVENT_TYPES.CREATED, actorId: 'lead',
    payload: { title: 'first' },
  });
  taskBoard.appendEvent({
    teamId: 'team-a', taskId: 'task-2', idempotencyKey: 'k2',
    eventType: TASK_EVENT_TYPES.CREATED, actorId: 'lead',
    payload: { title: 'second' },
  });
  // Fake event log with two runtime events. The facade only accepts an
  // eventLog that has an appendEvent method, so we stub one too.
  const eventLog = {
    appendEvent() {},
    listEvents() {
      return [
        { id: 1, runtimeId: 'r-1', type: 'tool_use', createdAt: '2026-05-01T22:00:01.000Z', payload: { toolName: 'Edit' } },
        { id: 2, runtimeId: 'r-1', type: 'tool_use', createdAt: '2026-05-01T22:00:02.000Z', payload: { toolName: 'Bash' } },
      ];
    },
  };
  const facade = new LocalToolFacade({ broker, taskBoard, eventLog });
  const result = facade.execute({
    commandName: COMMANDS.AUDIT_LOG_QUERY,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { limit: 10 },
  });
  assert.equal(result.events.length, 4);
  // Newest first.
  for (let i = 0; i + 1 < result.events.length; i++) {
    const cur = Date.parse(result.events[i].createdAt);
    const next = Date.parse(result.events[i + 1].createdAt);
    if (Number.isFinite(cur) && Number.isFinite(next)) {
      assert.ok(cur >= next, 'should be sorted newest first');
    }
  }
  // Sources are tagged.
  const sources = new Set(result.events.map((e) => e._source));
  assert.deepEqual([...sources].sort(), ['runtime', 'task']);
});

test('audit_log_query honours sinceMs filter', () => {
  const taskBoard = new InMemoryTaskBoard();
  taskBoard.appendEvent({
    teamId: 'team-a', taskId: 'task-1', idempotencyKey: 'k1',
    eventType: TASK_EVENT_TYPES.CREATED, actorId: 'lead',
    payload: {},
  });
  const cutoff = Date.now() + 60_000;
  const facade = new LocalToolFacade({ broker: new InMemoryBroker(), taskBoard });
  const result = facade.execute({
    commandName: COMMANDS.AUDIT_LOG_QUERY,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { sinceMs: cutoff },
  });
  assert.equal(result.events.length, 0, 'cutoff in the future should filter all out');
});

test('audit_log_query caps results at the limit and reports hasMore', () => {
  const taskBoard = new InMemoryTaskBoard();
  for (let i = 0; i < 5; i++) {
    taskBoard.appendEvent({
      teamId: 'team-a', taskId: `task-${i}`, idempotencyKey: `k${i}`,
      eventType: TASK_EVENT_TYPES.CREATED, actorId: 'lead',
      payload: {},
    });
  }
  const facade = new LocalToolFacade({ broker: new InMemoryBroker(), taskBoard });
  const result = facade.execute({
    commandName: COMMANDS.AUDIT_LOG_QUERY,
    actor: { teamId: 'team-a', agentId: 'lead', role: 'lead' },
    args: { limit: 3 },
  });
  assert.equal(result.events.length, 3);
  assert.equal(result.hasMore, true);
  assert.equal(result.cap, 3);
});

test('provider_auth_login is denied for non-lead/non-human roles', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    providerAuthSpawn: () => ({ pid: 1, unref() {} }),
  });
  await assert.rejects(
    async () => facade.execute({
      commandName: COMMANDS.PROVIDER_AUTH_LOGIN,
      actor: { teamId: 't', agentId: 'rev', role: 'reviewer' },
      args: { providerId: 'anthropic' },
      idempotencyKey: 'k-pa-deny',
    }),
    /role authority/,
  );
});

test('LocalToolFacade drift_run delegates to driftEngine and returns DriftRunResult shape', async () => {
  const fakeEngine = {
    async runDrift({ teamId, trigger }) {
      assert.equal(teamId, 'team-a');
      assert.equal(trigger, 'manual');
      return {
        runId: 'run_1', asOf: '2026-05-04T10:00:00Z',
        teamScore: 18, status: 'healthy', findings: [],
        categoryScores: { architecture: 100 }, perTaskScores: {},
        history: [], trigger: 'manual',
      };
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    driftEngine: fakeEngine,
  });
  const result = await facade.execute({
    commandName: COMMANDS.DRIFT_RUN,
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
    args: { trigger: 'manual' },
  });
  assert.equal(result.teamScore, 18);
  assert.equal(result.status, 'healthy');
});

test('LocalToolFacade drift_run rejects when no driftEngine is configured', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  await assert.rejects(
    facade.execute({
      commandName: COMMANDS.DRIFT_RUN,
      actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
      args: {},
    }),
    /drift engine not configured/i
  );
});

test('LocalToolFacade plugin_list_available returns SUPPORTED_PLUGINS shape', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    pluginAuthReadFile: () => '{"token":"x"}',  // pretend railway is signed in
    pluginAuthStat: () => ({ size: 50 }),
  });
  const result = await facade.execute({
    commandName: COMMANDS.PLUGIN_LIST_AVAILABLE,
    actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
    args: {},
  });
  assert.ok(Array.isArray(result.plugins));
  const railway = result.plugins.find((p) => p.pluginId === 'railway');
  assert.ok(railway);
  assert.equal(railway.signedIn, true);
});

test('LocalToolFacade plugin_login surfaces manualLogin instructions for railway', async () => {
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
  });
  const result = await facade.execute({
    commandName: COMMANDS.PLUGIN_LOGIN,
    idempotencyKey: 'idem-plugin-login-1',
    actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
    args: { pluginId: 'railway' },
  });
  assert.equal(result.manualLogin, true);
  assert.match(result.reason, /railway login/);
});

test('LocalToolFacade plugin_logout shells out to railway logout', async () => {
  const calls = [];
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    pluginAuthSpawnSync: (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  const result = await facade.execute({
    commandName: COMMANDS.PLUGIN_LOGOUT,
    idempotencyKey: 'idem-plugin-logout-1',
    actor: { teamId: 't', agentId: 'ui-client', role: 'human' },
    args: { pluginId: 'railway' },
  });
  assert.equal(result.loggedOut, true);
  assert.equal(calls[0].cmd, 'railway');
});

test('LocalToolFacade plugin_resource_list returns rows from pluginResources', async () => {
  let listed = null;
  const fakeResources = {
    listForTeam: ({ teamId }) => {
      listed = teamId;
      return [{ resourceId: 'r1', teamId, pluginId: 'railway', kind: 'postgres', externalId: 'svc_x' }];
    },
  };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    pluginResources: fakeResources,
  });
  const result = await facade.execute({
    commandName: COMMANDS.PLUGIN_RESOURCE_LIST,
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
    args: {},
  });
  assert.equal(listed, 'team-a');
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].kind, 'postgres');
});

test('LocalToolFacade railway_link delegates to railwayLink', async () => {
  const calls = [];
  const fakeRailwayLink = async (args) => { calls.push(args); return { linked: true, projectId: 'p1' }; };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    railwayToolImpls: { link: fakeRailwayLink },
  });
  const result = await facade.execute({
    commandName: COMMANDS.RAILWAY_LINK,
    idempotencyKey: 'idem-railway-link-1',
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
    args: { projectId: 'p1' },
  });
  assert.equal(result.linked, true);
  assert.equal(calls[0].teamId, 'team-a');
});

test('LocalToolFacade railway_provision_db idempotent + uses pluginResources', async () => {
  const calls = [];
  const fakeProvision = async (args) => {
    calls.push(args);
    return { resourceId: 'res_1', externalId: 'svc_x', kind: 'postgres', wasExisting: false };
  };
  const fakeResources = { findLive: () => null, insert: () => ({ resourceId: 'res_1' }), listForTeam: () => [] };
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    pluginResources: fakeResources,
    railwayToolImpls: { provisionDb: fakeProvision },
  });
  const result = await facade.execute({
    commandName: COMMANDS.RAILWAY_PROVISION_DB,
    idempotencyKey: 'idem-railway-provision-1',
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
    args: { type: 'postgres' },
  });
  assert.equal(result.kind, 'postgres');
  assert.equal(calls[0].pluginResources, fakeResources, 'facade should pass pluginResources to the tool');
});

test('LocalToolFacade railway_get_connection_string returns plaintext (path-a)', async () => {
  const fakeGet = async () => ({ value: 'postgres://u:pw@h:5432/d', resourceId: 'res_1' });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    railwayToolImpls: { getConnectionString: fakeGet },
  });
  const result = await facade.execute({
    commandName: COMMANDS.RAILWAY_GET_CONNECTION_STRING,
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },
    args: { resourceId: 'res_1' },
  });
  // Plaintext returned to caller (path-a per spec gotcha #2)
  assert.equal(result.value, 'postgres://u:pw@h:5432/d');
});

test('LocalToolFacade railway_run_migration delegates to railwayRunMigration', async () => {
  const fakeMigrate = async (args) => ({ executed: true, output: 'ok' });
  const facade = new LocalToolFacade({
    broker: new InMemoryBroker(),
    taskBoard: new InMemoryTaskBoard(),
    railwayToolImpls: { runMigration: fakeMigrate },
  });
  const result = await facade.execute({
    commandName: COMMANDS.RAILWAY_RUN_MIGRATION,
    idempotencyKey: 'idem-railway-migrate-1',
    actor: { teamId: 'team-a', agentId: 'ui-client', role: 'human' },  // human role required
    args: { resourceId: 'res_1', sql: 'CREATE TABLE x (id INT);' },
  });
  assert.equal(result.executed, true);
});
