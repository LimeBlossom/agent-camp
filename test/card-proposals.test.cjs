'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const {
  CARD_PROPOSALS_DIR,
  PROPOSE_MCP_TOOLS,
  writeProposal,
  drainProposals,
  handleProposeMcpCall
} = loadTs('src/main/cardProposals.ts');

function tmpHive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-card-proposals-'));
  return { dir, hiveRoot: path.join(dir, 'hive') };
}

const valid = { title: 'Hot-reload the camp hooks', description: 'Edits need a restart today.', project: 'General' };

test('writeProposal writes one JSON file into card-proposals with the source session folder', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    fs.mkdirSync(hiveRoot, { recursive: true });
    const res = writeProposal(hiveRoot, { ...valid, priority: 'high' }, '/media/user/Programming/Vault');
    assert.equal(res.ok, true);
    assert.equal(path.dirname(res.path), path.join(hiveRoot, CARD_PROPOSALS_DIR));
    const saved = JSON.parse(fs.readFileSync(res.path, 'utf8'));
    assert.equal(saved.title, valid.title);
    assert.equal(saved.project, 'General');
    assert.equal(saved.priority, 'high');
    assert.equal(saved.source, '/media/user/Programming/Vault');
    assert.ok(saved.proposedAt);
  } finally { rmTree(dir); }
});

test('writeProposal refuses a missing title, a missing description or an unknown project', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    assert.match(writeProposal(hiveRoot, { ...valid, title: ' ' }, '/x').error, /title/i);
    assert.match(writeProposal(hiveRoot, { ...valid, description: '' }, '/x').error, /description/i);
    assert.match(writeProposal(hiveRoot, { ...valid, project: 'Nope' }, '/x').error, /project/i);
    assert.equal(fs.existsSync(path.join(hiveRoot, CARD_PROPOSALS_DIR)), false);
  } finally { rmTree(dir); }
});

test('writeProposal refuses when the hive root does not exist, so a proposal never lands nowhere', () => {
  const { dir } = tmpHive();
  try {
    assert.match(writeProposal(path.join(dir, 'missing'), valid, '/x').error, /hive/i);
  } finally { rmTree(dir); }
});

test('drainProposals delivers each proposal to the Boss once and moves it to .done', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    fs.mkdirSync(hiveRoot, { recursive: true });
    writeProposal(hiveRoot, valid, '/src/a');
    writeProposal(hiveRoot, { ...valid, title: 'Second' }, '/src/b');
    const sent = [];
    assert.equal(drainProposals(hiveRoot, (m) => sent.push(m)), 2);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].to, 'boss');
    assert.equal(sent[0].act, 'propose');
    assert.match(sent[0].subject, /Hot-reload the camp hooks/);
    assert.match(sent[0].body, /General/);
    assert.match(sent[0].body, /\/src\/a/);
    assert.match(sent[0].body, /create_card/);
    assert.equal(drainProposals(hiveRoot, (m) => sent.push(m)), 0, 'a drained proposal is not sent again');
    assert.equal(fs.readdirSync(path.join(hiveRoot, CARD_PROPOSALS_DIR, '.done')).length, 2);
  } finally { rmTree(dir); }
});

test('drainProposals moves an unreadable proposal to .failed instead of sending it', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const pdir = path.join(hiveRoot, CARD_PROPOSALS_DIR);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'broken.json'), '{not json');
    const sent = [];
    assert.equal(drainProposals(hiveRoot, (m) => sent.push(m)), 0);
    assert.equal(sent.length, 0);
    assert.deepEqual(fs.readdirSync(path.join(pdir, '.failed')), ['broken.json']);
  } finally { rmTree(dir); }
});

test('drainProposals leaves the file in place when delivery throws, so it retries next tick', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    fs.mkdirSync(hiveRoot, { recursive: true });
    writeProposal(hiveRoot, valid, '/src/a');
    assert.equal(drainProposals(hiveRoot, () => { throw new Error('boss offline'); }), 0);
    assert.equal(fs.readdirSync(path.join(hiveRoot, CARD_PROPOSALS_DIR)).filter((f) => f.endsWith('.json')).length, 1);
  } finally { rmTree(dir); }
});

test('the propose MCP never exposes create_card', () => {
  assert.equal(PROPOSE_MCP_TOOLS.some((t) => t.name === 'create_card'), false);
  const { dir, hiveRoot } = tmpHive();
  try {
    fs.mkdirSync(hiveRoot, { recursive: true });
    const ok = handleProposeMcpCall('propose_card', valid, { hiveRoot, cwd: '/src/a' });
    assert.equal(ok.isError, undefined);
    const bad = handleProposeMcpCall('create_card', valid, { hiveRoot, cwd: '/src/a' });
    assert.equal(bad.isError, true);
  } finally { rmTree(dir); }
});
