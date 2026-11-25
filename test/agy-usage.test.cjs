'use strict';

/**
 * Antigravity agents leave no Claude transcript, so the floor showed them at
 * 0 tokens and "no activity yet" however hard they worked. Their usage is read
 * from agy's own conversation db; these pin the protobuf field mapping.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { usageFromGenMetadata, agyConversationDb, agyUsageSample } = loadTs('src/main/agyUsage.ts');

function varint(n) { const out = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n); return out; }
function vfield(f, v) { return [...varint(f * 8), ...varint(v)]; }
function lfield(f, bytes) { return [...varint(f * 8 + 2), ...varint(bytes.length), ...bytes]; }

test('usage is read from fields 1.4.2 (input), 1.4.3 (output), 1.4.5 (cache read)', () => {
  const usage = [...vfield(1, 999), ...vfield(2, 255817), ...vfield(3, 14473), ...vfield(5, 2092086)];
  const blob = Uint8Array.from([...lfield(9, [1, 2, 3]), ...lfield(1, [...vfield(3, 7), ...lfield(4, usage)])]);
  assert.deepEqual(usageFromGenMetadata(blob), { input: 255817, output: 14473, cacheRead: 2092086 });
});

test('a blob that is not a protobuf adds nothing instead of throwing', () => {
  assert.deepEqual(usageFromGenMetadata(Uint8Array.from([0xff, 0xff, 0xff])), { input: 0, output: 0, cacheRead: 0 });
});

test('only a conversation-shaped id becomes a db path, and only antigravity agents are read', () => {
  assert.equal(agyConversationDb('../../etc/passwd'), null);
  assert.match(agyConversationDb('85ff9f7e-158e-4cbb-af63-16bb3c5379dc', '/r'), /\/r\/conversations\/85ff9f7e-158e-4cbb-af63-16bb3c5379dc\.db$/);
  assert.equal(agyUsageSample('a', 'claude', '85ff9f7e-158e-4cbb-af63-16bb3c5379dc'), undefined);
  assert.equal(agyUsageSample('a', 'antigravity', undefined), undefined);
});
