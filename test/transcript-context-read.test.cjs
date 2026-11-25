'use strict';

/** The card gauge's tooltip shows how much context a session re-read this week. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { readContextReadSince } = loadTs('src/main/transcript.ts');

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-30T12:00:00Z');
const at = (msAgo) => new Date(NOW - msAgo).toISOString();
const asst = (id, msAgo, input, cacheRead, cacheCreation = 0) => ({
  type: 'assistant',
  timestamp: at(msAgo),
  message: { id, usage: { input_tokens: input, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation, output_tokens: 999 } }
});

function transcript(records) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-ctxread-')), 't.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}

test('each message id counts once, output is excluded, and older calls fall outside the window', () => {
  const file = transcript([
    asst('old', 8 * DAY, 10, 1000),
    asst('m1', 2 * DAY, 10, 1000, 5),
    asst('m1', 2 * DAY, 10, 1000, 5), // a second content block of the same message
    { type: 'user', message: { content: 'next' } },
    asst('m2', 1 * DAY, 20, 2000)
  ]);
  assert.deepEqual(readContextReadSince(file, NOW - 7 * DAY), { tokens: 1015 + 2020, calls: 2 });
});

test('a repeat read picks up appended calls, including one whose line was half-written', () => {
  const file = transcript([asst('a', DAY, 1, 100)]);
  assert.deepEqual(readContextReadSince(file, NOW - 7 * DAY), { tokens: 101, calls: 1 });
  const line = JSON.stringify(asst('b', DAY / 2, 2, 200));
  fs.appendFileSync(file, line.slice(0, 20));
  assert.deepEqual(readContextReadSince(file, NOW - 7 * DAY), { tokens: 101, calls: 1 });
  fs.appendFileSync(file, line.slice(20) + '\n');
  assert.deepEqual(readContextReadSince(file, NOW - 7 * DAY), { tokens: 303, calls: 2 });
});

test('a missing transcript reads as null', () => {
  assert.equal(readContextReadSince(path.join(os.tmpdir(), 'no-such-transcript.jsonl'), 0), null);
});
