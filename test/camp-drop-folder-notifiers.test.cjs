'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

// Mock Electron app.getPath('userData') for config.ts so tests never touch real config
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-camp-drop-folders-test-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => userData } }
};

test.after(() => rmTree(userData));

const {
  DEFAULT_DROP_FOLDERS,
  getDropFolders,
  interpolateTemplate,
  matchesPattern,
  scanDropFolder,
  resolveRecipient,
  processDropFolder,
  DropFolderWatcher
} = loadTs('src/main/dropFolders.ts');

const { readConfig } = loadTs('src/main/config.ts');

function tmpHive() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-drop-folders-'));
  const hiveRoot = path.join(dir, 'hive');
  fs.mkdirSync(hiveRoot, { recursive: true });
  return { dir, hiveRoot };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Seeded lanes and configuration defaults
// ─────────────────────────────────────────────────────────────────────────────

test('DEFAULT_DROP_FOLDERS contains the two seeded lanes: vault-inbox and card-proposals', () => {
  assert.ok(Array.isArray(DEFAULT_DROP_FOLDERS), 'DEFAULT_DROP_FOLDERS must be an array');
  assert.equal(DEFAULT_DROP_FOLDERS.length, 2, 'Must seed exactly 2 lanes initially');

  const vault = DEFAULT_DROP_FOLDERS.find((f) => f.dir === 'vault-inbox');
  assert.ok(vault, 'vault-inbox lane must be seeded');
  assert.equal(vault.mode, 'count', 'vault-inbox must run in count mode');
  assert.equal(vault.toFile, 'KEEPER', 'vault-inbox recipient comes from KEEPER file');
  assert.equal(vault.exclude, 'README.md', 'vault-inbox excludes README.md');
  assert.equal(vault.everyMs, 60_000, 'vault-inbox checks every 60s');
  assert.equal(vault.renudgeMs, 1_800_000, 'vault-inbox renudges after 30 min (1800000 ms)');
  assert.equal(vault.pauseDuringClosingTime, true, 'vault-inbox pauses during closing time');
  assert.match(vault.subject, /vault-inbox.*pending/, 'vault-inbox subject mentions pending count');
  assert.match(vault.body, /entries wait in.*standing rule/, 'vault-inbox body directs draining per standing rule');

  const proposals = DEFAULT_DROP_FOLDERS.find((f) => f.dir === 'card-proposals');
  assert.ok(proposals, 'card-proposals lane must be seeded');
  assert.equal(proposals.mode, 'perFile', 'card-proposals must run in perFile mode');
  assert.equal(proposals.to, 'boss', 'card-proposals delivers to boss');
  assert.equal(proposals.everyMs, 60_000, 'card-proposals checks every 60s');
  assert.equal(proposals.pauseDuringClosingTime, true, 'card-proposals pauses during closing time');
  assert.match(proposals.subject, /Card proposal/, 'card-proposals subject specifies card proposal');
});

test('getDropFolders falls back to DEFAULT_DROP_FOLDERS when config has no dropFolders', () => {
  const result = getDropFolders(null);
  assert.deepEqual(result, DEFAULT_DROP_FOLDERS);

  const emptyResult = getDropFolders({});
  assert.deepEqual(emptyResult, DEFAULT_DROP_FOLDERS);

  const emptyListResult = getDropFolders({ dropFolders: [] });
  assert.deepEqual(emptyListResult, DEFAULT_DROP_FOLDERS);
});

test('getDropFolders adds a custom lane after the seeds, which stay present', () => {
  const custom = {
    dir: 'custom-lane',
    match: '*.txt',
    to: 'cedar',
    mode: 'perFile',
    everyMs: 15_000,
    pauseDuringClosingTime: false
  };
  const result = getDropFolders({ dropFolders: [custom] });
  assert.deepEqual(result, [...DEFAULT_DROP_FOLDERS, custom]);
});

test('getDropFolders: an entry with a seed dir overrides that seed field by field', () => {
  const result = getDropFolders({ dropFolders: [{ dir: 'vault-inbox', renudgeMs: 5_000, mode: 'count' }] });
  assert.equal(result.length, 2);
  const vault = result.find((f) => f.dir === 'vault-inbox');
  const seed = DEFAULT_DROP_FOLDERS.find((f) => f.dir === 'vault-inbox');
  assert.equal(vault.renudgeMs, 5_000);
  assert.deepEqual({ ...vault, renudgeMs: seed.renudgeMs }, seed, 'every other field keeps the seed value');
  assert.deepEqual(result.find((f) => f.dir === 'card-proposals'), DEFAULT_DROP_FOLDERS.find((f) => f.dir === 'card-proposals'));
});

test('getDropFolders: disabled removes a seeded or custom lane', () => {
  const result = getDropFolders({
    dropFolders: [
      { dir: 'card-proposals', disabled: true, mode: 'perFile' },
      { dir: 'custom-lane', to: 'x', mode: 'perFile' },
      { dir: 'custom-lane', disabled: true, mode: 'perFile' }
    ]
  });
  assert.deepEqual(result.map((f) => f.dir), ['vault-inbox']);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Pattern matching and template interpolation helpers
// ─────────────────────────────────────────────────────────────────────────────

test('matchesPattern matches file extensions and globs, respecting exclusions and ignoring hidden dirs', () => {
  assert.equal(matchesPattern('note.md', '*.md', 'README.md'), true);
  assert.equal(matchesPattern('README.md', '*.md', 'README.md'), false, 'Excluded file must not match');
  assert.equal(matchesPattern('notes.txt', '*.md'), false, 'Non-matching extension must not match');
  assert.equal(matchesPattern('.done', '*.json'), false, 'Hidden/system files must not match');
  assert.equal(matchesPattern('.failed', '*.json'), false, 'Hidden/system files must not match');
  assert.equal(matchesPattern('proposal.json', '*.json'), true);
});

test('interpolateTemplate replaces {{var}} and ${var} placeholders', () => {
  const tpl = 'vault-inbox: {{count}} pending in ${dir} for {{keeper}}';
  const res = interpolateTemplate(tpl, { count: 5, dir: '/tmp/vault', keeper: 'maple' });
  assert.equal(res, 'vault-inbox: 5 pending in /tmp/vault for maple');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Count mode (vault-inbox behavior)
// ─────────────────────────────────────────────────────────────────────────────

test('count mode: notifies keeper once with count when pending files exist, leaving files in place', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const vaultDir = path.join(hiveRoot, 'vault-inbox');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'KEEPER'), 'quince-mvnvoaig\n');
    fs.writeFileSync(path.join(vaultDir, 'README.md'), '# Vault inbox readme\n');
    fs.writeFileSync(path.join(vaultDir, '20261029T080000Z-note1.md'), '# Note 1\n');
    fs.writeFileSync(path.join(vaultDir, '20261029T080100Z-note2.md'), '# Note 2\n');

    const vaultConfig = DEFAULT_DROP_FOLDERS.find((f) => f.dir === 'vault-inbox');
    const sent = [];
    const state = {};

    const res = processDropFolder({
      hiveRoot,
      folder: vaultConfig,
      deliver: (msg) => sent.push(msg),
      isAgentKnown: (id) => id === 'quince-mvnvoaig',
      now: 1_000_000,
      state
    });

    assert.equal(res.skipped, false);
    assert.equal(res.filesFound, 2, 'README.md must be excluded, finding exactly 2 pending notes');
    assert.equal(res.messagesSent, 1, 'Exactly one summary message should be sent');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'quince-mvnvoaig');
    assert.equal(sent[0].act, 'inform');
    assert.match(sent[0].subject, /vault-inbox: 2 pending/);
    assert.match(sent[0].body, /2 entries wait in/);
    assert.match(sent[0].body, /Drain them per your vault-inbox standing rule/);

    // Count mode must leave files in place for keeper to drain!
    assert.ok(fs.existsSync(path.join(vaultDir, '20261029T080000Z-note1.md')));
    assert.ok(fs.existsSync(path.join(vaultDir, '20261029T080100Z-note2.md')));
    assert.equal(state.lastNudgeAt, 1_000_000, 'State must record lastNudgeAt');
  } finally {
    rmTree(dir);
  }
});

test('count mode: does nothing when no pending files exist or keeper is missing/unknown', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const vaultDir = path.join(hiveRoot, 'vault-inbox');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'KEEPER'), 'quince-mvnvoaig\n');
    fs.writeFileSync(path.join(vaultDir, 'README.md'), '# Readme only\n');

    const vaultConfig = DEFAULT_DROP_FOLDERS.find((f) => f.dir === 'vault-inbox');
    const sent = [];
    const res = processDropFolder({
      hiveRoot,
      folder: vaultConfig,
      deliver: (msg) => sent.push(msg),
      isAgentKnown: (id) => id === 'quince-mvnvoaig'
    });

    assert.equal(res.messagesSent, 0);
    assert.equal(sent.length, 0, 'No message when pending files count is 0');

    // Add a file, but keeper is unknown agent
    fs.writeFileSync(path.join(vaultDir, 'note.md'), '# Note\n');
    const unknownRes = processDropFolder({
      hiveRoot,
      folder: vaultConfig,
      deliver: (msg) => sent.push(msg),
      isAgentKnown: () => false // Agent not in registry
    });
    assert.equal(unknownRes.skipped, true);
    assert.equal(sent.length, 0, 'No message when keeper agent is unknown to registry');
  } finally {
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Renudge throttling in count mode
// ─────────────────────────────────────────────────────────────────────────────

test('count mode: throttles renudge within renudgeMs, then renudges once renudgeMs has elapsed', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const vaultDir = path.join(hiveRoot, 'vault-inbox');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'KEEPER'), 'quince-mvnvoaig\n');
    fs.writeFileSync(path.join(vaultDir, 'note1.md'), '# Note 1\n');

    const vaultConfig = DEFAULT_DROP_FOLDERS.find((f) => f.dir === 'vault-inbox');
    const sent = [];
    const state = {};

    const t0 = 10_000_000;
    // Tick 1 at t0: sends initial notification
    processDropFolder({
      hiveRoot,
      folder: vaultConfig,
      deliver: (msg) => sent.push(msg),
      isAgentKnown: () => true,
      now: t0,
      state
    });
    assert.equal(sent.length, 1);

    // Tick 2 at t0 + 10 min (less than renudgeMs of 30 min): must NOT renudge
    const t1 = t0 + 10 * 60_000;
    const resThrottled = processDropFolder({
      hiveRoot,
      folder: vaultConfig,
      deliver: (msg) => sent.push(msg),
      isAgentKnown: () => true,
      now: t1,
      state
    });
    assert.equal(resThrottled.skipped, true);
    assert.equal(resThrottled.reason, 'renudge-throttled');
    assert.equal(sent.length, 1, 'Should still be 1 message; renudge was throttled');

    // Tick 3 at t0 + 31 min (exceeds renudgeMs of 30 min): sends renudge
    const t2 = t0 + 31 * 60_000;
    const resRenudge = processDropFolder({
      hiveRoot,
      folder: vaultConfig,
      deliver: (msg) => sent.push(msg),
      isAgentKnown: () => true,
      now: t2,
      state
    });
    assert.equal(resRenudge.skipped, false);
    assert.equal(sent.length, 2, 'Renudge message should be delivered after renudgeMs');
  } finally {
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. PerFile mode (card-proposals behavior)
// ─────────────────────────────────────────────────────────────────────────────

test('perFile mode: drains each JSON file into a message and moves it to .done', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const propDir = path.join(hiveRoot, 'card-proposals');
    fs.mkdirSync(propDir, { recursive: true });

    const p1 = {
      title: 'Fix drop folder polling',
      description: 'Make it scriptable from config',
      project: 'Camp',
      source: '/media/programming/test'
    };
    const p2 = {
      title: 'Add second feature',
      description: 'Another proposal',
      project: 'Camp',
      priority: 'high',
      source: '/media/programming/test2'
    };

    fs.writeFileSync(path.join(propDir, 'proposal-1.json'), JSON.stringify(p1), 'utf8');
    fs.writeFileSync(path.join(propDir, 'proposal-2.json'), JSON.stringify(p2), 'utf8');

    const propConfig = DEFAULT_DROP_FOLDERS.find((f) => f.dir === 'card-proposals');
    const sent = [];

    const res = processDropFolder({
      hiveRoot,
      folder: propConfig,
      deliver: (msg) => sent.push(msg),
      isAgentKnown: () => true
    });

    assert.equal(res.filesFound, 2);
    assert.equal(res.messagesSent, 2);
    assert.equal(sent.length, 2);
    assert.equal(sent[0].to, 'boss');
    assert.equal(sent[0].act, 'propose');
    assert.match(sent[0].subject, /Fix drop folder polling/);
    assert.match(sent[0].body, /Camp/);
    assert.match(sent[0].body, /Make it scriptable from config/);

    // Files must be moved to .done
    assert.equal(fs.existsSync(path.join(propDir, 'proposal-1.json')), false);
    assert.equal(fs.existsSync(path.join(propDir, 'proposal-2.json')), false);
    assert.ok(fs.existsSync(path.join(propDir, '.done', 'proposal-1.json')));
    assert.ok(fs.existsSync(path.join(propDir, '.done', 'proposal-2.json')));

    // Next tick must find 0 pending files
    const res2 = processDropFolder({
      hiveRoot,
      folder: propConfig,
      deliver: (msg) => sent.push(msg),
      isAgentKnown: () => true
    });
    assert.equal(res2.filesFound, 0);
    assert.equal(sent.length, 2, 'No duplicate messages sent');
  } finally {
    rmTree(dir);
  }
});

test('perFile mode: moves malformed files to .failed and retries when deliver throws', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const propDir = path.join(hiveRoot, 'card-proposals');
    fs.mkdirSync(propDir, { recursive: true });

    // 1. Broken JSON file
    fs.writeFileSync(path.join(propDir, 'corrupt.json'), 'not valid json {{{', 'utf8');
    // 2. Valid JSON file
    fs.writeFileSync(
      path.join(propDir, 'valid.json'),
      JSON.stringify({ title: 'T', description: 'D', project: 'Camp' }),
      'utf8'
    );

    const propConfig = DEFAULT_DROP_FOLDERS.find((f) => f.dir === 'card-proposals');
    let failDelivery = true;

    // Delivery throws on valid.json
    processDropFolder({
      hiveRoot,
      folder: propConfig,
      deliver: () => {
        if (failDelivery) throw new Error('Network error');
      },
      isAgentKnown: () => true
    });

    // Broken file moved to .failed
    assert.ok(fs.existsSync(path.join(propDir, '.failed', 'corrupt.json')));
    // Valid file remains in place because delivery threw
    assert.ok(fs.existsSync(path.join(propDir, 'valid.json')));

    // Next tick with delivery succeeding
    failDelivery = false;
    const sent = [];
    processDropFolder({
      hiveRoot,
      folder: propConfig,
      deliver: (msg) => sent.push(msg),
      isAgentKnown: () => true
    });

    assert.equal(sent.length, 1);
    assert.ok(fs.existsSync(path.join(propDir, '.done', 'valid.json')));
  } finally {
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Closing-time pause
// ─────────────────────────────────────────────────────────────────────────────

test('pauseDuringClosingTime suppresses drop folder processing when closing time is active', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const vaultDir = path.join(hiveRoot, 'vault-inbox');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'KEEPER'), 'quince-mvnvoaig\n');
    fs.writeFileSync(path.join(vaultDir, 'note.md'), '# Note\n');

    const vaultConfig = DEFAULT_DROP_FOLDERS.find((f) => f.dir === 'vault-inbox');
    const sent = [];

    // Closing time ACTIVE -> must skip
    const resPaused = processDropFolder({
      hiveRoot,
      folder: vaultConfig,
      deliver: (msg) => sent.push(msg),
      isClosingTime: () => true,
      isAgentKnown: () => true
    });

    assert.equal(resPaused.skipped, true);
    assert.equal(resPaused.reason, 'closing-time');
    assert.equal(sent.length, 0, 'No notification sent during closing time');

    // Closing time INACTIVE -> must process
    const resActive = processDropFolder({
      hiveRoot,
      folder: vaultConfig,
      deliver: (msg) => sent.push(msg),
      isClosingTime: () => false,
      isAgentKnown: () => true
    });

    assert.equal(resActive.skipped, false);
    assert.equal(sent.length, 1, 'Notification sent when closing time is inactive');
  } finally {
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. New lane added ONLY in config fires without code changes
// ─────────────────────────────────────────────────────────────────────────────

test('a new lane added only in config fires without modifying engine code', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const patchDir = path.join(hiveRoot, 'review-patches');
    fs.mkdirSync(patchDir, { recursive: true });
    fs.writeFileSync(path.join(patchDir, 'fix-123.patch'), 'diff --git a/foo b/foo\n+line', 'utf8');

    const customFolder = {
      dir: 'review-patches',
      match: '*.patch',
      to: 'reviewer-agent',
      subject: 'Review request: {{filename}}',
      body: 'A new patch is available in {{dir}}: {{filename}}',
      mode: 'perFile',
      everyMs: 30_000,
      pauseDuringClosingTime: true
    };

    const sent = [];
    const res = processDropFolder({
      hiveRoot,
      folder: customFolder,
      deliver: (msg) => sent.push(msg),
      isAgentKnown: (id) => id === 'reviewer-agent'
    });

    assert.equal(res.filesFound, 1);
    assert.equal(res.messagesSent, 1);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'reviewer-agent');
    assert.match(sent[0].subject, /Review request: fix-123\.patch/);
    assert.match(sent[0].body, /fix-123\.patch/);
    assert.ok(fs.existsSync(path.join(patchDir, '.done', 'fix-123.patch')));
  } finally {
    rmTree(dir);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. DropFolderWatcher lifecycle and multi-folder execution
// ─────────────────────────────────────────────────────────────────────────────

test('DropFolderWatcher ticks all configured drop folders on invocation', () => {
  const { dir, hiveRoot } = tmpHive();
  try {
    const vaultDir = path.join(hiveRoot, 'vault-inbox');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'KEEPER'), 'quince-mvnvoaig\n');
    fs.writeFileSync(path.join(vaultDir, 'note.md'), '# Note\n');

    const propDir = path.join(hiveRoot, 'card-proposals');
    fs.mkdirSync(propDir, { recursive: true });
    fs.writeFileSync(
      path.join(propDir, 'prop.json'),
      JSON.stringify({ title: 'Task', description: 'Desc', project: 'Camp' }),
      'utf8'
    );

    const sent = [];
    const watcher = new DropFolderWatcher(
      () => hiveRoot,
      () => DEFAULT_DROP_FOLDERS,
      (msg) => sent.push(msg),
      () => false,
      () => true
    );

    const results = watcher.tick();
    assert.ok(Array.isArray(results), 'tick must return array of results for each folder');
    assert.equal(results.length, 2, 'Must process both seeded folders');
    assert.equal(sent.length, 2, 'Both seeded drop folders must send messages on tick');
  } finally {
    rmTree(dir);
  }
});
