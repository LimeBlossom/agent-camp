const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');
const { BossInboxBatch } = loadTs('src/shared/bossInboxBatch.ts');
const mail = (id, act = 'done', from = 'worker') => ({ id, act, from });

test('quiet period coalesces mail and names all covered ids', () => {
  const b = new BossInboxBatch(), a = mail('a'), c = mail('c');
  assert.equal(b.inspect([a], 0).due, false);
  assert.equal(b.inspect([a, c], 120000).due, false);
  assert.equal(b.inspect([a, c], 299999).due, false);
  assert.deepEqual(b.inspect([a, c], 300000), { due: true, ids: ['a', 'c'] });
});
test('continuous eligible mail reaches ten minute cap', () => {
  const b = new BossInboxBatch(), inbox = [];
  for (let t = 0; t < 600000; t += 60000) {
    inbox.push(mail(String(t)));
    assert.equal(b.inspect(inbox, t).due, false);
  }
  inbox.push(mail('at-cap'));
  assert.equal(b.inspect(inbox, 600000).due, true);
});
test('human, worker requests and queries bypass batching', () => {
  for (const m of [mail('a', 'inform', 'human'), mail('a', 'request'), mail('a', 'query')]) {
    assert.equal(new BossInboxBatch().inspect([m], 0).due, true);
  }
});
test('worker and scheduler inform stay passive but are covered by next real wake', () => {
  const b = new BossInboxBatch(), passive = [mail('a', 'inform'), mail('s', 'inform', 'scheduler')];
  assert.equal(b.inspect(passive, 0).due, false);
  assert.equal(b.inspect(passive, 900000).due, false);
  assert.deepEqual(b.inspect([...passive, mail('q', 'query')], 900001), { due: true, ids: ['a', 's', 'q'] });
});
test('passive mail does not extend quiet period', () => {
  const b = new BossInboxBatch(), a = mail('a');
  b.inspect([a], 0);
  assert.equal(b.inspect([a, mail('i', 'inform')], 180000).due, true);
});
test('mail drained during debounce cancels it and resets cap', () => {
  const b = new BossInboxBatch();
  b.inspect([mail('a')], 0);
  assert.equal(b.inspect([], 100000).due, false);
  assert.equal(b.inspect([mail('b')], 600000).due, false);
  assert.equal(b.inspect([mail('b')], 780000).due, true);
});
test('delivery recheck defers a queued batch when new mail arrives', () => {
  const b = new BossInboxBatch(), a = mail('a'), c = mail('c');
  b.inspect([a], 0);
  assert.equal(b.inspect([a], 180000).due, true);
  assert.equal(b.inspect([a, c], 180001).due, false);
  assert.equal(b.inspect([a, c], 360001).due, true);
});
test('acknowledge only on success; no duplicate wakes, later mail remains eligible', () => {
  const b = new BossInboxBatch(), a = mail('a', 'request');
  assert.equal(b.inspect([a], 0).due, true);
  assert.equal(b.inspect([a], 1).due, true);
  b.acknowledge(['a']);
  assert.equal(b.inspect([a], 2).due, false);
  assert.deepEqual(b.inspect([a, mail('b', 'query')], 3), { due: true, ids: ['b'] });
});
test('quiet period, cap and immediate/passive rules are configurable', () => {
  const b = new BossInboxBatch();
  const cfg = { quietMs: 10, maxWaitMs: 20, immediateSenders: ['operator'], immediateActs: ['propose'], passiveActs: ['done'] };
  assert.equal(b.inspect([mail('a', 'request')], 0, cfg).due, false);
  assert.equal(b.inspect([mail('a', 'request')], 10, cfg).due, true);
  assert.equal(new BossInboxBatch().inspect([mail('b', 'inform', 'operator')], 0, cfg).due, true);
  assert.equal(new BossInboxBatch().inspect([mail('c', 'propose')], 0, cfg).due, true);
  assert.equal(new BossInboxBatch().inspect([mail('d')], 99999, cfg).due, false);
});
test('closing time makes any fresh mail due at once, informs included', () => {
  const b = new BossInboxBatch(), ack = mail('ack', 'inform');
  assert.equal(b.inspect([ack], 0).due, false);
  assert.deepEqual(b.inspect([ack], 0, undefined, { closing: true }), { due: true, ids: ['ack'] });
});
