'use strict';

// camp-limit-resets-detail: the Claude chip names each reset's kind and the soonest
// use-by date; the Codex chip keeps (or admits it lost) the reset count when the
// `codex app-server` query fails, and says why in its tooltip.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const ts = require('typescript');
const loadTs = require('../test-support/load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { ipcMain: { handle() {} } } };

const { readClaudeResetGrants } = loadTs('src/main/claudeLimits.ts');
const { CodexLimitsReader, queryCodexAppServer, codexLaunchOptions, recentDateDirs } = loadTs('src/main/codexLimits.ts');
const liveFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-appserver-rate-limits.json'), 'utf8'));

function renderChip(file, exportName, state) {
  const filePath = path.join(__dirname, '..', 'src/renderer/src/components', file);
  const out = ts.transpileModule(fs.readFileSync(filePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true }
  }).outputText;
  const customReact = { ...React, useState: () => [state, () => {}] };
  const mod = { exports: {} };
  const req = (name) => {
    if (name === 'react') return customReact;
    if (name.includes('usageChipStyle')) {
      const sharedPath = path.join(__dirname, '..', 'src/renderer/src/components/usageChipStyle.ts');
      const shared = ts.transpileModule(fs.readFileSync(sharedPath, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true }
      }).outputText;
      const sharedModule = { exports: {} };
      new Function('module', 'exports', 'require', shared)(sharedModule, sharedModule.exports, () => ({}));
      return sharedModule.exports;
    }
    return {};
  };
  new Function('React', 'module', 'exports', 'require', out)(customReact, mod, mod.exports, req);
  return ReactDOMServer.renderToStaticMarkup(React.createElement(mod.exports[exportName]));
}

const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
const titleOf = (html) => (html.match(/title="([^"]*)"/) || [])[1] || '';

// ---------------------------------------------------------------- Claude chip

const NOW = Date.parse('2026-11-16T18:00:00Z');

function withLimitsJson(body) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'md-resets-detail-'));
  const dir = path.join(runtime, 'cc-usage');
  fs.mkdirSync(dir);
  const p = path.join(dir, 'limits.json');
  fs.writeFileSync(p, JSON.stringify(body));
  fs.utimesSync(p, NOW / 1000 - 30, NOW / 1000 - 30);
  process.env.XDG_RUNTIME_DIR = runtime;
}

const rawGrant = (over) => ({
  id: 'full-reset-2611',
  label: 'One full limit reset (November 2026)',
  resets_total: 1,
  resets_left: 1,
  ends_at: '2026-12-10T12:00:00+00:00',
  clears: ['five_hour', 'seven_day', 'seven_day_overage_included'],
  usable_now: true,
  ...over
});

test('each grant gets a short kind from what it clears: full, fable, 5h', () => {
  withLimitsJson({
    cedar_ember: {
      eligible: true,
      grants: [
        rawGrant({}),
        rawGrant({
          id: 'launch-2610-fable',
          label: 'New model launch: one Fable reset for Max, Team Premium and Enterprise Premium',
          ends_at: '2027-03-09T12:00:00+00:00',
          clears: ['five_hour', 'seven_day_overage_included']
        }),
        rawGrant({ id: 'five-only', label: 'Session reset', ends_at: '2026-12-20T12:00:00+00:00', clears: ['five_hour'] })
      ]
    }
  });
  const kinds = Object.fromEntries(readClaudeResetGrants(NOW).map((g) => [g.id, g.kind]));
  assert.deepEqual(kinds, { 'full-reset-2611': 'full', 'launch-2610-fable': 'fable', 'five-only': '5h' });
});

const claudeBase = { fiveHour: { percent: 11 }, sevenDay: { percent: 43 }, updatedAt: Date.now() };

test('the Claude chip shows each grant kind and the soonest use-by date', () => {
  const html = renderChip('ClaudeLimitsChip.tsx', 'ClaudeLimitsChip', {
    ...claudeBase,
    resetGrants: [
      { id: 'a', label: 'One full limit reset (November 2026)', kind: 'full', left: 1, endsAt: Date.parse('2026-12-10T12:00:00Z') / 1000, usableNow: true },
      { id: 'b', label: 'Fable reset', kind: 'fable', left: 1, endsAt: Date.parse('2027-03-09T12:00:00Z') / 1000, usableNow: true }
    ]
  });
  assert.match(text(html), /2 resets \(full, fable, use by 12\/10\)/);
  assert.match(titleOf(html), /One full limit reset \(November 2026\)[^"]*Fable reset/, 'tooltip keeps the full list');
});

test('one kind shown once, and a grant with no end date gives no use-by', () => {
  const html = renderChip('ClaudeLimitsChip.tsx', 'ClaudeLimitsChip', {
    ...claudeBase,
    resetGrants: [
      { id: 'a', label: 'Session reset', kind: '5h', left: 2, usableNow: true }
    ]
  });
  assert.match(text(html), /2 resets \(5h\)/);
  assert.doesNotMatch(text(html), /use by/);
});

// ----------------------------------------------------------------- Codex app-server

class FakeAppServer extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    let buf = '';
    this.stdin.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        const req = JSON.parse(line);
        const result = req.method === 'initialize' ? { userAgent: 'test' } : liveFixture.result;
        this.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n');
      }
    });
  }
  kill() { return true; }
}

class MissingBinary extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    process.nextTick(() => {
      const err = new Error('spawn codex ENOENT');
      err.code = 'ENOENT';
      this.emit('error', err);
    });
  }
  kill() { return false; }
}

test('a failed app-server query reports why (spawn ENOENT)', async () => {
  const reasons = [];
  const got = await queryCodexAppServer({ spawnFn: () => new MissingBinary(), onError: (r) => reasons.push(r) });
  assert.equal(got, null);
  assert.equal(reasons.length, 1);
  assert.match(reasons[0], /ENOENT/);
});

test('a timed-out app-server query reports the timeout', async () => {
  const reasons = [];
  const hanging = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true; } });
  await queryCodexAppServer({ spawnFn: hanging, timeoutMs: 30, onError: (r) => reasons.push(r) });
  assert.match(reasons[0] || '', /timed out/i);
});

test('the app-server is spawned with the given env, so a packaged app can find codex and node', async () => {
  let seen;
  await queryCodexAppServer({
    codexBin: '/home/u/.npm-global/bin/codex',
    env: { PATH: '/home/u/.npm-global/bin:/usr/bin' },
    spawnFn: (cmd, args, opts) => { seen = { cmd, opts }; return new FakeAppServer(); }
  });
  assert.equal(seen.cmd, '/home/u/.npm-global/bin/codex');
  assert.equal(seen.opts.env.PATH, '/home/u/.npm-global/bin:/usr/bin');
});

test('codexLaunchOptions gives the app-server the login-shell PATH, where codex lives', () => {
  const got = codexLaunchOptions({
    shellPath: () => '/home/u/.npm-global/bin:/usr/bin',
    env: { HOME: '/home/u', PATH: '/usr/bin' }
  });
  assert.equal(got.codexBin, 'codex');
  assert.equal(got.env.PATH, '/home/u/.npm-global/bin:/usr/bin');
  assert.equal(got.env.HOME, '/home/u');
});

test('codexLaunchOptions honours CODEX_BIN', () => {
  const got = codexLaunchOptions({ shellPath: () => '/usr/bin', env: { CODEX_BIN: '/opt/codex' } });
  assert.equal(got.codexBin, '/opt/codex');
});

function rolloutHome(t, now) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-resets-detail-codex-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const user = path.join(home, '.codex');
  const dir = path.join(user, 'sessions', recentDateDirs(now)[0]);
  fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify({
    timestamp: new Date(now - 3600_000).toISOString(), type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      limit_id: 'codex',
      primary: { used_percent: 55, window_minutes: 300, resets_at: 2000000000 },
      secondary: { used_percent: 33, window_minutes: 10080, resets_at: 2000500000 }
    } }
  });
  fs.writeFileSync(path.join(dir, 'rollout-a.jsonl'), line + '\n');
  return user;
}

test('after an app-server failure the reader keeps the last known reset credits and says why', async (t) => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const user = rolloutHome(t, now);
  let fail = false;
  const reader = new CodexLimitsReader(user, () => null, {
    spawnFn: () => (fail ? new MissingBinary() : new FakeAppServer())
  });
  const first = await reader.readWithAppServer(now);
  assert.equal(first.credits.availableCount, 2);
  assert.equal(first.appServerError, undefined);

  fail = true;
  const second = await reader.readWithAppServer(now + 60_000);
  assert.equal(second.fiveHour.percent, 55, 'usage still comes from the rollouts');
  assert.equal(second.credits.availableCount, 2, 'last known credits survive the failure');
  assert.ok(second.creditsAt, 'carried credits are stamped with when they were read');
  assert.match(second.appServerError, /ENOENT/);
});

test('an app-server failure with no earlier reading leaves credits unknown, with the reason', async (t) => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const user = rolloutHome(t, now);
  const reader = new CodexLimitsReader(user, () => null, { spawnFn: () => new MissingBinary() });
  const got = await reader.readWithAppServer(now);
  assert.equal(got.credits, undefined);
  assert.match(got.appServerError, /ENOENT/);
});

test('the reader logs an app-server failure once per distinct reason, and again after a recovery', async (t) => {
  const now = Date.parse('2026-10-01T12:00:00Z');
  const user = rolloutHome(t, now);
  const logged = [];
  let fail = true;
  const reader = new CodexLimitsReader(user, () => null, {
    spawnFn: () => (fail ? new MissingBinary() : new FakeAppServer()),
    onFailure: (reason) => logged.push(reason)
  });
  await reader.readWithAppServer(now);
  await reader.readWithAppServer(now);
  assert.equal(logged.length, 1);
  fail = false;
  await reader.readWithAppServer(now);
  fail = true;
  await reader.readWithAppServer(now);
  assert.equal(logged.length, 2);
});

// ----------------------------------------------------------------- Codex chip

const codexBase = {
  fiveHour: { percent: 4, windowMinutes: 300 },
  weekly: { percent: 67, windowMinutes: 10080 },
  updatedAt: Date.now()
};

test('the Codex chip says "resets unknown" when the app-server is unreachable and no count is known', () => {
  const html = renderChip('CodexLimitsChip.tsx', 'CodexLimitsChip', { ...codexBase, appServerError: 'spawn codex ENOENT' });
  assert.match(text(html), /resets unknown/);
  assert.match(titleOf(html), /app-server[^"]*spawn codex ENOENT/);
});

test('the Codex chip keeps a carried reset count and flags its age in the tooltip', () => {
  const html = renderChip('CodexLimitsChip.tsx', 'CodexLimitsChip', {
    ...codexBase,
    credits: { availableCount: 3, credits: [] },
    creditsAt: Date.now() - 2 * 3600_000,
    appServerError: 'spawn codex ENOENT'
  });
  assert.match(text(html), /3 resets/);
  assert.doesNotMatch(text(html), /unknown/);
  assert.match(titleOf(html), /app-server[^"]*spawn codex ENOENT/);
});

test('the Codex chip shows the soonest available reset credit expiry inline', () => {
  const html = renderChip('CodexLimitsChip.tsx', 'CodexLimitsChip', {
    ...codexBase,
    credits: { availableCount: 2, credits: [
      { id: 'later', status: 'available', expiresAt: Date.parse('2027-03-09T12:00:00Z') / 1000 },
      { id: 'sooner', status: 'available', expiresAt: Date.parse('2026-12-10T12:00:00Z') / 1000 },
      { id: 'unavailable', status: 'used', expiresAt: Date.parse('2026-11-20T12:00:00Z') / 1000 }
    ] }
  });
  assert.match(text(html), /2 resets, use by 12\/10/);
  assert.match(titleOf(html), /Reset credit expires 3\/9\/2027/);
  assert.match(titleOf(html), /Reset credit expires 12\/10\/2026/);
});

test('the Codex chip omits use-by when reset credits have no expiry', () => {
  const html = renderChip('CodexLimitsChip.tsx', 'CodexLimitsChip', {
    ...codexBase,
    credits: { availableCount: 2, credits: [{ id: 'one' }, { id: 'two' }] }
  });
  assert.match(text(html), /2 resets/);
  assert.doesNotMatch(text(html), /use by/);
});

test('CONTROL: a healthy reading shows the count with no app-server warning', () => {
  const html = renderChip('CodexLimitsChip.tsx', 'CodexLimitsChip', { ...codexBase, credits: { availableCount: 3, credits: [] } });
  assert.match(text(html), /3 resets/);
  assert.doesNotMatch(titleOf(html), /app-server/);
});
