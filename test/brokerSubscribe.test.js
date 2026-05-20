import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryBroker } from '../src/broker/inMemoryBroker.js';
import { SqliteBroker } from '../src/broker/sqliteBroker.js';

const ENV = (idem) => ({
  teamId: 'team-a', idempotencyKey: idem,
  from: { kind: 'agent', id: 'lead' },
  to: { kind: 'agent', teamId: 'team-a', agentId: 'dev' },
  kind: 'reply', text: 'hello',
});

function brokers() {
  return [
    ['InMemoryBroker', () => new InMemoryBroker()],
    ['SqliteBroker', () => new SqliteBroker({ filePath: ':memory:' })],
  ];
}

for (const [name, make] of brokers()) {
  test(`${name}: subscribe fires once per NEW append with the envelope`, () => {
    const b = make();
    const seen = [];
    b.subscribe((m) => seen.push(m));
    b.appendMessage(ENV('m1'));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].teamId, 'team-a');
    assert.equal(seen[0].text, 'hello');
  });

  test(`${name}: no fire on idempotent dedup`, () => {
    const b = make();
    let n = 0;
    b.subscribe(() => { n += 1; });
    b.appendMessage(ENV('dup'));
    b.appendMessage(ENV('dup'));
    assert.equal(n, 1, 'second append is a dedup hit — must not fire');
  });

  test(`${name}: unsubscribe stops delivery`, () => {
    const b = make();
    let n = 0;
    const off = b.subscribe(() => { n += 1; });
    b.appendMessage(ENV('a'));
    off();
    b.appendMessage(ENV('b'));
    assert.equal(n, 1);
  });

  test(`${name}: subscriber throw is caught; message still inserted`, () => {
    const b = make();
    let invoked = 0;
    b.subscribe(() => { invoked += 1; throw new Error('bad subscriber'); });
    const r = b.appendMessage(ENV('safe'));
    assert.equal(invoked, 1, 'subscriber was called before it threw');
    assert.equal(r.inserted, true);
    assert.ok(b.getMessage(r.message.messageId));
  });

  test(`${name}: durability — subscriber can read the message via the broker from its handler`, () => {
    const b = make();
    let readBack = null;
    b.subscribe((m) => { readBack = b.getMessage(m.messageId); });
    b.appendMessage(ENV('dur'));
    assert.ok(readBack, 'message is queryable from within the subscriber (post-INSERT)');
    assert.equal(readBack.text, 'hello');
  });

  test(`${name}: subscribe rejects a non-function`, () => {
    const b = make();
    assert.throws(() => b.subscribe('nope'), /function/);
  });
}
