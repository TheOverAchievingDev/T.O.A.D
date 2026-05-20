import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeEventBus } from '../src/runtime/RuntimeEventBus.js';

test('RuntimeEventBus emits and receives runtime events', () => {
  const bus = new RuntimeEventBus();
  const received = [];

  bus.on('runtime_event', (event) => received.push(event));

  bus.emit('runtime_event', {
    type: 'assistant_text',
    teamId: 'team-a',
    runtimeId: 'runtime-lead-1',
    payload: { text: 'Hello.' },
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].type, 'assistant_text');
  assert.equal(received[0].teamId, 'team-a');
});

test('RuntimeEventBus supports multiple listeners', () => {
  const bus = new RuntimeEventBus();
  const received1 = [];
  const received2 = [];

  bus.on('runtime_event', (event) => received1.push(event));
  bus.on('runtime_event', (event) => received2.push(event));

  bus.emit('runtime_event', { type: 'tool_use', teamId: 'team-a' });

  assert.equal(received1.length, 1);
  assert.equal(received2.length, 1);
});

test('RuntimeEventBus supports unsubscribe via off()', () => {
  const bus = new RuntimeEventBus();
  const received = [];
  const handler = (event) => received.push(event);

  bus.on('runtime_event', handler);
  bus.emit('runtime_event', { type: 'assistant_text' });
  assert.equal(received.length, 1);

  bus.off('runtime_event', handler);
  bus.emit('runtime_event', { type: 'tool_use' });
  assert.equal(received.length, 1); // no new events
});

test('RuntimeEventBus supports typed event channels', () => {
  const bus = new RuntimeEventBus();
  const toolEvents = [];
  const retryEvents = [];

  bus.on('tool_use', (event) => toolEvents.push(event));
  bus.on('api_retry', (event) => retryEvents.push(event));

  bus.emit('tool_use', { toolName: 'bash', teamId: 'team-a' });
  bus.emit('api_retry', { attempt: 1, teamId: 'team-a' });
  bus.emit('tool_use', { toolName: 'write', teamId: 'team-a' });

  assert.equal(toolEvents.length, 2);
  assert.equal(retryEvents.length, 1);
});

test('RuntimeEventBus.subscribe returns unsubscribe function', () => {
  const bus = new RuntimeEventBus();
  const received = [];

  const unsubscribe = bus.subscribe('runtime_event', (event) => received.push(event));
  bus.emit('runtime_event', { type: 'text' });
  assert.equal(received.length, 1);

  unsubscribe();
  bus.emit('runtime_event', { type: 'text' });
  assert.equal(received.length, 1);
});

test('RuntimeEventBus.listenerCount returns correct count', () => {
  const bus = new RuntimeEventBus();
  assert.equal(bus.listenerCount('runtime_event'), 0);

  const unsub1 = bus.subscribe('runtime_event', () => {});
  const unsub2 = bus.subscribe('runtime_event', () => {});
  assert.equal(bus.listenerCount('runtime_event'), 2);

  unsub1();
  assert.equal(bus.listenerCount('runtime_event'), 1);

  unsub2();
  assert.equal(bus.listenerCount('runtime_event'), 0);
});

test('RuntimeEventBus does not throw when emitting with no listeners', () => {
  const bus = new RuntimeEventBus();
  // Should not throw
  bus.emit('runtime_event', { type: 'text' });
  bus.emit('nonexistent_channel', { type: 'text' });
});

test('RuntimeEventBus.dispose removes all listeners', () => {
  const bus = new RuntimeEventBus();
  const received = [];

  bus.on('runtime_event', (event) => received.push(event));
  bus.on('tool_use', (event) => received.push(event));

  bus.dispose();

  bus.emit('runtime_event', { type: 'text' });
  bus.emit('tool_use', { type: 'text' });
  assert.equal(received.length, 0);
});
