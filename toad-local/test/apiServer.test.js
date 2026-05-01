import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { ApiServer } from '../src/transport/apiServer.js';
import { RuntimeEventBus } from '../src/runtime/RuntimeEventBus.js';

test('ApiServer broadcasts events via SSE', async (t) => {
  const eventBus = new RuntimeEventBus();
  const server = new ApiServer({ eventBus, port: 0 });

  await server.start();
  const port = server.getPort();

  // Connect a client
  const client = await new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/events`, (res) => {
      assert.equal(res.statusCode, 200);
      assert.equal(res.headers['content-type'], 'text/event-stream');
      resolve(res);
    });
    req.end();
  });

  // Collect SSE data
  const receivedData = [];
  client.on('data', (chunk) => {
    receivedData.push(chunk.toString());
  });

  // Emit an event on the bus
  eventBus.emit('runtime_event', { type: 'tool_use', toolName: 'test' });

  // Wait a bit for the data to be received
  await new Promise((resolve) => setTimeout(resolve, 50));

  const joinedData = receivedData.join('');
  assert.match(joinedData, /event: runtime_event/);
  assert.match(joinedData, /data: {"type":"tool_use","toolName":"test"}/);

  client.destroy();
  await server.stop();
});

test('ApiServer supports multiple clients', async (t) => {
  const eventBus = new RuntimeEventBus();
  const server = new ApiServer({ eventBus, port: 0 });

  await server.start();
  const port = server.getPort();

  // Connect two clients
  const client1 = await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/events`, resolve));
  const client2 = await new Promise((resolve) => http.get(`http://127.0.0.1:${port}/events`, resolve));

  let count1 = 0;
  let count2 = 0;

  client1.on('data', () => count1++);
  client2.on('data', () => count2++);

  // Emit an event
  eventBus.emit('runtime_event', { type: 'test' });

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.ok(count1 > 0);
  assert.ok(count2 > 0);

  client1.destroy();
  client2.destroy();
  await server.stop();
});

test('ApiServer handles client disconnects gracefully', async (t) => {
  const eventBus = new RuntimeEventBus();
  const server = new ApiServer({ eventBus, port: 0 });

  await server.start();
  const port = server.getPort();

  const req = http.get(`http://127.0.0.1:${port}/events`);
  
  await new Promise((resolve) => setTimeout(resolve, 50));
  
  assert.equal(server.getClientCount(), 1);

  req.destroy();

  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(server.getClientCount(), 0);

  await server.stop();
});

test('ApiServer returns 404 for unknown endpoints', async (t) => {
  const eventBus = new RuntimeEventBus();
  const server = new ApiServer({ eventBus, port: 0 });

  await server.start();
  const port = server.getPort();

  const res = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/unknown`, resolve);
  });

  assert.equal(res.statusCode, 404);

  await server.stop();
});

test('ApiServer routes /api/call to toolFacade', async (t) => {
  const eventBus = new RuntimeEventBus();
  const mockToolFacade = {
    execute: async (command) => {
      assert.equal(command.actor.teamId, 'test-team');
      assert.equal(command.commandName, 'test_method');
      assert.equal(command.args.foo, 'bar');
      return { success: true };
    }
  };
  const server = new ApiServer({ eventBus, toolFacade: mockToolFacade, port: 0 });

  await server.start();
  const port = server.getPort();

  const payload = JSON.stringify({
    actor: { teamId: 'test-team', agentId: 'test-agent' },
    method: 'test_method',
    args: { foo: 'bar' }
  });

  const res = await new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${port}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }, resolve);
    req.write(payload);
    req.end();
  });

  assert.equal(res.statusCode, 200);

  let body = '';
  res.on('data', (chunk) => body += chunk.toString());
  await new Promise(resolve => res.on('end', resolve));

  const parsed = JSON.parse(body);
  assert.deepEqual(parsed, { result: { success: true } });

  await server.stop();
});

test('ApiServer returns 400 for malformed JSON bodies', async (t) => {
  const eventBus = new RuntimeEventBus();
  let facadeCalled = false;
  const server = new ApiServer({
    eventBus,
    toolFacade: {
      execute() {
        facadeCalled = true;
      },
    },
    port: 0,
  });

  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const res = await postRaw(port, '{not-json');
  const body = await readBody(res);

  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(body).error, /invalid json/i);
  assert.equal(facadeCalled, false);

});

test('ApiServer returns 400 for invalid /api/call envelope shape', async (t) => {
  const eventBus = new RuntimeEventBus();
  let facadeCalled = false;
  const server = new ApiServer({
    eventBus,
    toolFacade: {
      execute() {
        facadeCalled = true;
      },
    },
    port: 0,
  });

  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const res = await postJson(port, {
    actor: { teamId: 'team-a' },
    method: 'task_list',
    args: 'not-an-object',
  });
  const body = await readBody(res);

  assert.equal(res.statusCode, 400);
  assert.match(JSON.parse(body).error, /actor\.agentId/i);
  assert.equal(facadeCalled, false);

});

test('ApiServer returns 413 when /api/call body exceeds maxBodyBytes', async (t) => {
  const eventBus = new RuntimeEventBus();
  let facadeCalled = false;
  const server = new ApiServer({
    eventBus,
    toolFacade: {
      execute() {
        facadeCalled = true;
      },
    },
    maxBodyBytes: 16,
    port: 0,
  });

  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const res = await postJson(port, {
    actor: { teamId: 'team-a', agentId: 'operator' },
    method: 'task_list',
    args: { padding: 'this body is intentionally too large' },
  });
  const body = await readBody(res);

  assert.equal(res.statusCode, 413);
  assert.match(JSON.parse(body).error, /too large/i);
  assert.equal(facadeCalled, false);
});

test('ApiServer omits ACAO when request Origin is not on the allow-list', async (t) => {
  const eventBus = new RuntimeEventBus();
  const server = new ApiServer({
    eventBus,
    toolFacade: { execute() { return { ok: true }; } },
    allowedOrigins: ['http://localhost:5173'],
    port: 0,
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const res = await postJson(
    port,
    { actor: { teamId: 'team-a', agentId: 'operator' }, method: 'task_list' },
    { Origin: 'http://evil.example' }
  );

  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('ApiServer defaults allowedOrigins to localhost:5173 and 127.0.0.1:5173', async (t) => {
  const eventBus = new RuntimeEventBus();
  const server = new ApiServer({
    eventBus,
    toolFacade: { execute() { return { ok: true }; } },
    port: 0,
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const a = await postJson(
    port,
    { actor: { teamId: 'team-a', agentId: 'operator' }, method: 'task_list' },
    { Origin: 'http://localhost:5173' }
  );
  const b = await postJson(
    port,
    { actor: { teamId: 'team-a', agentId: 'operator' }, method: 'task_list' },
    { Origin: 'http://127.0.0.1:5173' }
  );

  assert.equal(a.headers['access-control-allow-origin'], 'http://localhost:5173');
  assert.equal(b.headers['access-control-allow-origin'], 'http://127.0.0.1:5173');
});

test('ApiServer allowedOrigins "*" echoes any origin', async (t) => {
  const eventBus = new RuntimeEventBus();
  const server = new ApiServer({
    eventBus,
    toolFacade: { execute() { return { ok: true }; } },
    allowedOrigins: '*',
    port: 0,
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const res = await postJson(
    port,
    { actor: { teamId: 'team-a', agentId: 'operator' }, method: 'task_list' },
    { Origin: 'http://anything.example' }
  );

  assert.equal(res.headers['access-control-allow-origin'], 'http://anything.example');
});

test('ApiServer echoes the request Origin in ACAO when origin is on the allow-list', async (t) => {
  const eventBus = new RuntimeEventBus();
  const server = new ApiServer({
    eventBus,
    toolFacade: { execute() { return { ok: true }; } },
    allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    port: 0,
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const res = await postJson(
    port,
    { actor: { teamId: 'team-a', agentId: 'operator' }, method: 'task_list' },
    { Origin: 'http://localhost:5173' }
  );

  assert.equal(res.statusCode, 200);
  assert.equal(
    res.headers['access-control-allow-origin'],
    'http://localhost:5173',
    'must echo the specific origin, not wildcard'
  );
});

test('ApiServer /events returns 401 when token is required and not provided', async (t) => {
  const eventBus = new RuntimeEventBus();
  const server = new ApiServer({
    eventBus,
    token: 'secret-abc',
    port: 0,
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const res = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/events`, resolve);
  });
  assert.equal(res.statusCode, 401);
});

test('ApiServer /events accepts the correct token via ?token query string', async (t) => {
  const eventBus = new RuntimeEventBus();
  const server = new ApiServer({
    eventBus,
    token: 'secret-abc',
    port: 0,
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const res = await new Promise((resolve) => {
    http.get(`http://127.0.0.1:${port}/events?token=secret-abc`, resolve);
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'text/event-stream');
  res.destroy();
});

test('ApiServer /api/call returns 401 when Bearer token does not match', async (t) => {
  const eventBus = new RuntimeEventBus();
  let facadeCalled = false;
  const server = new ApiServer({
    eventBus,
    toolFacade: { execute() { facadeCalled = true; } },
    token: 'secret-abc',
    port: 0,
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const res = await postJson(
    port,
    { actor: { teamId: 'team-a', agentId: 'operator' }, method: 'task_list' },
    { Authorization: 'Bearer wrong-token' }
  );

  assert.equal(res.statusCode, 401);
  assert.equal(facadeCalled, false);
});

test('ApiServer /api/call accepts the correct Bearer token', async (t) => {
  const eventBus = new RuntimeEventBus();
  let receivedActor = null;
  const server = new ApiServer({
    eventBus,
    toolFacade: {
      execute(command) {
        receivedActor = command.actor;
        return { ok: true };
      },
    },
    token: 'secret-abc',
    port: 0,
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const res = await postJson(
    port,
    { actor: { teamId: 'team-a', agentId: 'operator' }, method: 'task_list' },
    { Authorization: 'Bearer secret-abc' }
  );
  const body = await readBody(res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(body), { result: { ok: true } });
  assert.deepEqual(receivedActor, { teamId: 'team-a', agentId: 'operator' });
});

test('ApiServer OPTIONS preflight is allowed without a token', async (t) => {
  const eventBus = new RuntimeEventBus();
  const server = new ApiServer({
    eventBus,
    toolFacade: { execute() {} },
    token: 'secret-abc',
    port: 0,
  });
  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const res = await new Promise((resolve) => {
    const req = http.request(
      `http://127.0.0.1:${port}/api/call`,
      { method: 'OPTIONS' },
      resolve
    );
    req.end();
  });

  assert.equal(res.statusCode, 204);
  assert.match(
    res.headers['access-control-allow-headers'] || '',
    /Authorization/i,
    'preflight must allow the Authorization header'
  );
});

test('ApiServer /api/call returns 401 when token is required and Authorization header is missing', async (t) => {
  const eventBus = new RuntimeEventBus();
  let facadeCalled = false;
  const server = new ApiServer({
    eventBus,
    toolFacade: { execute() { facadeCalled = true; } },
    token: 'secret-abc',
    port: 0,
  });

  await server.start();
  t.after(() => server.stop());
  const port = server.getPort();

  const res = await postJson(port, {
    actor: { teamId: 'team-a', agentId: 'operator' },
    method: 'task_list',
  });
  const body = await readBody(res);

  assert.equal(res.statusCode, 401);
  assert.match(JSON.parse(body).error, /unauthor/i);
  assert.equal(facadeCalled, false, 'facade must not be invoked when auth fails');
});

function postJson(port, payload, headers = {}) {
  return postRaw(port, JSON.stringify(payload), headers);
}

function postRaw(port, body, headers = {}) {
  return new Promise((resolve) => {
    const req = http.request(`http://127.0.0.1:${port}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
    }, resolve);
    req.write(body);
    req.end();
  });
}

function readBody(res) {
  let body = '';
  res.on('data', (chunk) => body += chunk.toString());
  return new Promise((resolve) => res.on('end', () => resolve(body)));
}
