'use strict';

/** The desktop chat shows an agent's last reply, read from its transcript. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { readLastAssistantText } = loadTs('src/main/transcript.ts');

function transcript(records) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-reply-')), 't.jsonl');
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return file;
}
const asst = (id, content) => ({ type: 'assistant', message: { id, content } });

test('joins every text block of the last assistant message, skipping tool calls', () => {
  const file = transcript([
    asst('m1', [{ type: 'text', text: 'old reply' }]),
    { type: 'user', message: { content: 'next?' } },
    asst('m2', [{ type: 'text', text: 'First part.' }]),
    asst('m2', [{ type: 'tool_use', name: 'Bash' }]),
    asst('m2', [{ type: 'text', text: 'Second part.' }]),
  ]);
  assert.equal(readLastAssistantText(file), 'First part.\n\nSecond part.');
});

test('a trailing tool-only record does not hide the reply before it', () => {
  const file = transcript([
    asst('m1', [{ type: 'text', text: 'the answer' }]),
    asst('m2', [{ type: 'tool_use', name: 'Read' }]),
  ]);
  assert.equal(readLastAssistantText(file), 'the answer');
});

test('missing or reply-less transcripts give null', () => {
  assert.equal(readLastAssistantText('/nonexistent/t.jsonl'), null);
  assert.equal(readLastAssistantText(transcript([{ type: 'user', message: { content: 'hi' } }])), null);
});
