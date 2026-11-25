'use strict';

/** A config.json written by an older build still loads after a setting is removed. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'md-config-removed-'));
const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { app: { getPath: () => userData } } };

const { readConfig } = loadTs('src/main/config.ts');

test.after(() => fs.rmSync(userData, { recursive: true, force: true }));

test('idleShutdownMinutes from an older build is ignored, and the rest of the file still applies', () => {
  fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({ idleShutdownMinutes: 10, workerIdleTimeoutMinutes: 33, onboardingComplete: true }));
  const cfg = readConfig();
  assert.equal(cfg.workerIdleTimeoutMinutes, 33);
  assert.equal(cfg.onboardingComplete, true);
});
