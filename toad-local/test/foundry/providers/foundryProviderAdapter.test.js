import test from 'node:test';
import assert from 'node:assert/strict';
import { FoundryProviderAdapter, FoundryProviderAdapterError } from '../../../src/foundry/providers/FoundryProviderAdapter.js';

test('FoundryProviderAdapter cannot be instantiated directly', () => {
  assert.throws(() => new FoundryProviderAdapter('test'), /abstract/i);
});

test('FoundryProviderAdapter subclass without send() throws when send is called', async () => {
  class Stub extends FoundryProviderAdapter {
    constructor() { super('stub'); }
  }
  const stub = new Stub();
  await assert.rejects(stub.send({ foundrySessionId: 's', text: 't' }), /send/i);
});

test('FoundryProviderAdapter default isAttached returns false', () => {
  class Stub extends FoundryProviderAdapter {
    constructor() { super('stub'); }
  }
  const stub = new Stub();
  assert.equal(stub.isAttached({ foundrySessionId: 's' }), false);
});

test('FoundryProviderAdapter default close and closeAll are no-ops', async () => {
  class Stub extends FoundryProviderAdapter {
    constructor() { super('stub'); }
  }
  const stub = new Stub();
  await stub.close({ foundrySessionId: 's' });
  await stub.closeAll();
  // No throw = pass.
});

test('FoundryProviderAdapter exposes providerId', () => {
  class Stub extends FoundryProviderAdapter {
    constructor() { super('stub-provider'); }
  }
  const stub = new Stub();
  assert.equal(stub.providerId, 'stub-provider');
});

test('FoundryProviderAdapter.send default throws FoundryProviderAdapterError with providerId in details', async () => {
  class Stub extends FoundryProviderAdapter {
    constructor() { super('stub'); }
  }
  const stub = new Stub();
  try {
    await stub.send({ foundrySessionId: 's', text: 't' });
    assert.fail('expected throw');
  } catch (err) {
    assert.equal(err.name, 'FoundryProviderAdapterError');
    assert.equal(err.details.providerId, 'stub');
  }
});
