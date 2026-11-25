'use strict';

/** Post-merge worktree closeout (harnessMergeCleanup) is on unless a settings file says false. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-merge-cleanup-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };

const { readConfig } = loadTs('src/main/config.ts');
const configFile = path.join(userData, 'config.json');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('a fresh install with no settings file has closeout on', () => {
  fs.rmSync(configFile, { force: true });
  assert.equal(readConfig().harnessMergeCleanup, true);
});

test('a settings file without the key has closeout on', () => {
  fs.writeFileSync(configFile, JSON.stringify({ onboardingComplete: true }));
  assert.equal(readConfig().harnessMergeCleanup, true);
});

test('an explicit false in a settings file this build wrote stays off', () => {
  fs.writeFileSync(configFile, JSON.stringify({ onboardingComplete: true, harnessMergeCleanup: false, snapshotDefaultsCleanedV1: true }));
  assert.equal(readConfig().harnessMergeCleanup, false);
});
