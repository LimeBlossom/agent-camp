'use strict';

/**
 * Tests for config snapshot masking defaults:
 * Work step (1): a saved config with an untouched key does not pin it.
 * Work step (2): save path writes only user-set keys (or keys differing from DEFAULTS).
 * Work step (3): one-time cleanup of keys equal to old defaults (e.g. legacy snapshot
 *                pinning harnessMergeCleanup: false).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

let currentUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-snapshot-defaults-'));
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { app: { getPath: () => currentUserData } }
};

const { writeConfig, readConfig, onConfigWritten } = loadTs('src/main/config.ts');

function resetTestUserData() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-snapshot-defaults-'));
  currentUserData = dir;
  return dir;
}

test.after(() => {
  try {
    fs.rmSync(currentUserData, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// -----------------------------------------------------------------------------
// Work Step (1): A saved config with an untouched key does not pin it
// -----------------------------------------------------------------------------

test('work step (1): writeConfig does not pin untouched defaults to disk in config.json', () => {
  const dir = resetTestUserData();
  const configFile = path.join(dir, 'config.json');

  // User saves one setting: notifications: true
  writeConfig({ notifications: true });

  assert.ok(fs.existsSync(configFile), 'config.json must be created');
  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));

  // The explicitly set key must be saved
  assert.equal(raw.notifications, true);

  // Untouched keys from DEFAULTS must NOT be pinned to disk
  assert.equal('harnessMergeCleanup' in raw, false, 'untouched harnessMergeCleanup must not be pinned in config.json');
  assert.equal('autoUpdate' in raw, false, 'untouched autoUpdate must not be pinned in config.json');
  assert.equal('multiWindow' in raw, false, 'untouched multiWindow must not be pinned in config.json');
  assert.equal('strongKeepalive' in raw, false, 'untouched strongKeepalive must not be pinned in config.json');
  assert.equal('defaultCommand' in raw, false, 'untouched defaultCommand must not be pinned in config.json');
  assert.equal('missions' in raw, false, 'untouched missions must not be pinned in config.json');

  // readConfig still resolves untouched keys to their defaults
  const cfg = readConfig();
  assert.equal(cfg.notifications, true);
  assert.equal(cfg.harnessMergeCleanup, true, 'readConfig resolves the default for untouched key');
});

test('work step (1): updating one setting on an existing config does not pin other untouched keys', () => {
  const dir = resetTestUserData();
  const configFile = path.join(dir, 'config.json');

  // Start with a sparse config containing only onboardingComplete
  fs.writeFileSync(configFile, JSON.stringify({ onboardingComplete: true }, null, 2));

  // User sets autoMode: false
  writeConfig({ autoMode: false });

  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(raw.onboardingComplete, true);
  assert.equal(raw.autoMode, false);

  // Untouched defaults must remain unpinned
  assert.equal('harnessMergeCleanup' in raw, false, 'untouched harnessMergeCleanup remains absent from disk');
  assert.equal('strongKeepalive' in raw, false, 'untouched strongKeepalive remains absent from disk');
  assert.equal('autoUpdate' in raw, false, 'untouched autoUpdate remains absent from disk');
});

// -----------------------------------------------------------------------------
// Work Step (2): Save path writes only user-set keys
// -----------------------------------------------------------------------------

test('work step (2): save path writes only keys differing from DEFAULTS (user-set keys)', () => {
  const dir = resetTestUserData();
  const configFile = path.join(dir, 'config.json');

  writeConfig({ registeredRepos: ['/test/repo'], autoMode: false });

  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(raw.registeredRepos, ['/test/repo']);
  assert.equal(raw.autoMode, false);

  // Default keys must not be dumped into config.json
  const defaultKeys = [
    'godProvider',
    'godModel',
    'defaultModel',
    'maxConcurrentWorkers',
    'workerIdleTimeoutMinutes',
    'semanticMemory',
    'embeddingModel',
    'missions',
    'notifications',
    'strongKeepalive',
    'harnessMergeCleanup',
    'autoUpdate',
    'telemetryEnabled',
    'multiWindow',
    'tvShowOffices',
    'officeTheme'
  ];

  for (const key of defaultKeys) {
    assert.equal(key in raw, false, `key '${key}' equals default and must not be written to disk`);
  }
});

test('work step (2): explicit user override differing from default IS saved to disk', () => {
  const dir = resetTestUserData();
  const configFile = path.join(dir, 'config.json');

  // Explicit user override of harnessMergeCleanup to false (where default is true)
  writeConfig({ harnessMergeCleanup: false });

  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(raw.harnessMergeCleanup, false, 'explicitly configured setting must be persisted');

  const cfg = readConfig();
  assert.equal(cfg.harnessMergeCleanup, false, 'readConfig must reflect explicit user override');
});

test('work step (2): readConfig and onConfigWritten still provide the full config with defaults populated', () => {
  const dir = resetTestUserData();

  let listenerSeen = null;
  const off = onConfigWritten((next) => {
    listenerSeen = next;
  });

  try {
    writeConfig({ notifications: true });

    // In-memory subscribers receive full shape with defaults
    assert.ok(listenerSeen, 'subscriber must be notified');
    assert.equal(listenerSeen.notifications, true);
    assert.equal(listenerSeen.harnessMergeCleanup, true);
    assert.equal(listenerSeen.autoMode, true);
    assert.equal(listenerSeen.godModel, 'claude-opus-5-5');

    // readConfig returns full shape with defaults
    const cfg = readConfig();
    assert.equal(cfg.notifications, true);
    assert.equal(cfg.harnessMergeCleanup, true);
    assert.equal(cfg.autoMode, true);
    assert.equal(cfg.godModel, 'claude-opus-5-5');
  } finally {
    off();
  }
});

// -----------------------------------------------------------------------------
// Work Step (3): One-time cleanup of keys equal to the old defaults
// -----------------------------------------------------------------------------

test('work step (3): legacy snapshot with old default harnessMergeCleanup: false is cleaned up so current default true takes effect', () => {
  const dir = resetTestUserData();
  const configFile = path.join(dir, 'config.json');

  // Simulate an older build's full config snapshot containing old default harnessMergeCleanup: false
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      onboardingComplete: true,
      harnessHome: '/home/user/HarnessAgents',
      harnessMergeCleanup: false, // old default from older build snapshot
      strongKeepalive: false,     // old default
      autoUpdate: true,           // old default
      telemetryEnabled: true,     // old default
      multiWindow: true           // old default
    }, null, 2)
  );

  // readConfig triggers the one-time cleanup of old default keys
  const cfg = readConfig();

  // harnessMergeCleanup should now adopt the current default (true), not remain trapped at false
  assert.equal(
    cfg.harnessMergeCleanup,
    true,
    'old default harnessMergeCleanup: false must be cleaned up to adopt current default true'
  );

  // In the file on disk, the old default should no longer be pinned
  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(raw.onboardingComplete, true, 'user setting onboardingComplete preserved');
  assert.equal(raw.harnessHome, '/home/user/HarnessAgents', 'user setting harnessHome preserved');
  assert.equal('harnessMergeCleanup' in raw, false, 'stale default harnessMergeCleanup removed from disk');
  assert.equal('strongKeepalive' in raw, false, 'stale default strongKeepalive removed from disk');
  assert.equal('autoUpdate' in raw, false, 'stale default autoUpdate removed from disk');
});

test('work step (3): legacy snapshot cleanup preserves user customizations that differed from old defaults', () => {
  const dir = resetTestUserData();
  const configFile = path.join(dir, 'config.json');

  // Config with user customizations (strongKeepalive: true, workerIdleTimeoutMinutes: 45)
  // alongside snapshotted old defaults (harnessMergeCleanup: false, autoUpdate: true)
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      onboardingComplete: true,
      harnessHome: '/custom/hive',
      strongKeepalive: true,           // user customized (differed from old default false)
      workerIdleTimeoutMinutes: 45,    // user customized (differed from old default 20)
      harnessMergeCleanup: false,      // matches old default false -> should be cleaned
      autoUpdate: true                 // matches old default true -> should be cleaned
    }, null, 2)
  );

  const cfg = readConfig();

  // User-chosen overrides remain intact
  assert.equal(cfg.strongKeepalive, true, 'user-customized strongKeepalive is preserved');
  assert.equal(cfg.workerIdleTimeoutMinutes, 45, 'user-customized workerIdleTimeoutMinutes is preserved');
  // Stale default is cleaned up to new default
  assert.equal(cfg.harnessMergeCleanup, true, 'stale default harnessMergeCleanup becomes current default true');

  const raw = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(raw.strongKeepalive, true, 'customized strongKeepalive remains on disk');
  assert.equal(raw.workerIdleTimeoutMinutes, 45, 'customized workerIdleTimeoutMinutes remains on disk');
  assert.equal('harnessMergeCleanup' in raw, false, 'stale default removed from disk');
  assert.equal('autoUpdate' in raw, false, 'stale default removed from disk');
});
