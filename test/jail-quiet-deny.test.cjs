'use strict';

// A jailed Claude dials Datadog's log intake on every spawn; the proxy denies it without
// asking the Boss to grant it, while every other denied host still asks.

const test = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('../test-support/load-ts.cjs');

const { reportJailDeny } = loadTs('src/main/agentJail.ts');

function run(provider, host) {
  const logs = [];
  const asks = [];
  reportJailDeny(provider, host, { log: (e) => logs.push(e), ask: (h) => asks.push(h) });
  return { logs, asks };
}

test('claude: the Datadog intake host is logged quiet and never asks the Boss', () => {
  const r = run('claude', 'http-intake.logs.us5.datadoghq.com');
  assert.deepEqual(r.asks, []);
  assert.deepEqual(r.logs, [{ hosts: ['http-intake.logs.us5.datadoghq.com'], quiet: true }]);
});

test('claude: an unlisted host still asks the Boss', () => {
  const r = run('claude', 'example.org');
  assert.deepEqual(r.asks, ['example.org']);
  assert.deepEqual(r.logs, [{ hosts: ['example.org'] }]);
});

test('claude: a look-alike domain is not quiet', () => {
  assert.deepEqual(run('claude', 'evildatadoghq.com').asks, ['evildatadoghq.com']);
});

test('antigravity: Datadog is not on its quiet list', () => {
  assert.deepEqual(run('antigravity', 'http-intake.logs.us5.datadoghq.com').asks, ['http-intake.logs.us5.datadoghq.com']);
});

// Measured 2026-11-23 on b6700905: every jailed Claude spawn also dials its updater and the
// browser log intake; each asked the Boss on every restart.
for (const host of ['registry.npmjs.org', 'downloads.claude.ai', 'browser-intake-us5-datadoghq.com']) {
  test(`claude: startup host ${host} is quiet`, () => {
    const r = run('claude', host);
    assert.deepEqual(r.asks, []);
    assert.deepEqual(r.logs, [{ hosts: [host], quiet: true }]);
  });
}

test('claude: other npm and claude.ai hosts still ask', () => {
  assert.deepEqual(run('claude', 'www.npmjs.com').asks, ['www.npmjs.com']);
  assert.deepEqual(run('claude', 'claude.ai').asks, ['claude.ai']);
});

// Background telemetry any CLI emits: denied with a log line, never a Boss mail.
for (const provider of ['claude', 'codex', 'antigravity']) {
  for (const host of ['ab.chatgpt.com', 'mobile.events.data.microsoft.com', 'Mobile.Events.Data.Microsoft.com.']) {
    test(`${provider}: telemetry host ${host} is quiet`, () => {
      const r = run(provider, host);
      assert.deepEqual(r.asks, []);
      assert.deepEqual(r.logs, [{ hosts: [host], quiet: true }]);
    });
  }
}

test('telemetry list stays narrow: chatgpt.com, example.com, nuget and look-alikes still ask', () => {
  for (const host of ['chatgpt.com', 'example.com', 'api.nuget.org', 'evilab.chatgpt.com', 'ab.chatgpt.com.evil.io', 'events.data.microsoft.com']) {
    assert.deepEqual(run('codex', host).asks, [host], host);
  }
});
