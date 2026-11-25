'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const loadTs = require('../test-support/load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { ipcMain: { handle() {} } } };

const codexLimitsMod = loadTs('src/main/codexLimits.ts');
const {
  CodexLimitsReader,
  newestInText,
  parseRateLimitLine,
  recentDateDirs,
  withResets,
  parseAppServerRateLimits,
  queryCodexAppServer,
  readCodexAppServerLimits,
  CODEX_APP_SERVER_METHODS,
  CODEX_APP_SERVER_ARGS,
  isAllowedAppServerMethod
} = codexLimitsMod;

const liveFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-appserver-rate-limits.json'), 'utf8'));
const exhaustedFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-appserver-rate-limits-exhausted.json'), 'utf8'));
const legacyFixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'codex-appserver-rate-limits-legacy.json'), 'utf8'));

function rolloutLine(ts, p5, pw, { limitId = 'codex', reset5 = 2000000000, resetW = 2000500000 } = {}) {
  return JSON.stringify({
    timestamp: ts, type: 'event_msg',
    payload: { type: 'token_count', rate_limits: {
      limit_id: limitId,
      primary: { used_percent: p5, window_minutes: 300, resets_at: reset5 },
      secondary: { used_percent: pw, window_minutes: 10080, resets_at: resetW }
    } }
  });
}

class FakeAppServerProcess extends EventEmitter {
  constructor(customResponses = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.killSignal = null;
    this.pid = 42424;
    this.receivedRequests = [];

    let buffer = '';
    this.stdin.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        let req;
        try { req = JSON.parse(line); } catch { continue; }
        this.receivedRequests.push(req);
        if (customResponses[req.method]) {
          const resp = customResponses[req.method](req);
          if (resp) this.stdout.write(JSON.stringify(resp) + '\n');
        } else if (req.method === 'initialize') {
          this.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: {
              userAgent: 'test/0.160.0 dumb',
              codexHome: '/home/user/.codex',
              platformFamily: 'unix',
              platformOs: 'linux'
            }
          }) + '\n');
        } else if (req.method === 'account/rateLimits/read') {
          this.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: req.id,
            result: liveFixture.result
          }) + '\n');
        }
      }
    });
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.killSignal = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
    return true;
  }
}

class HangingAppServerProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.killSignal = null;
    this.pid = 42425;
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.killSignal = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
    return true;
  }
}

class FailingSpawnProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.pid = undefined;
    process.nextTick(() => {
      const err = new Error('spawn codex ENOENT');
      err.code = 'ENOENT';
      this.emit('error', err);
    });
  }

  kill() {
    return false;
  }
}

// Control tests (Baseline sanity & rollout compatibility)
test('CONTROL: recorded app-server fixtures exist and load with expected schema', () => {
  assert.ok(liveFixture.result.rateLimitsByLimitId.codex);
  assert.equal(liveFixture.result.rateLimitResetCredits.availableCount, 2);
  assert.equal(exhaustedFixture.result.ordinaryUsageAllowed, false);
  assert.equal(legacyFixture.result.rateLimits.planType, 'pro');
});

test('CONTROL: rollout tail line parser continues to parse legacy rollout records', () => {
  const parsed = parseRateLimitLine(rolloutLine('2026-10-01T03:00:00.000Z', 15, 8));
  assert.deepEqual(parsed, {
    updatedAt: Date.parse('2026-10-01T03:00:00.000Z'),
    fiveHour: { percent: 15, windowMinutes: 300, resetsAt: 2000000000 },
    weekly: { percent: 8, windowMinutes: 10080, resetsAt: 2000500000 }
  });
});

test('CONTROL: baseline withResets zeroes out expired windows', () => {
  const r = parseRateLimitLine(rolloutLine('2026-10-01T03:00:00Z', 40, 20, { reset5: 1000, resetW: 2000500000 }));
  const now = withResets(r, 5000 * 1000);
  assert.deepEqual(now.fiveHour, { percent: 0, windowMinutes: 300, reset: true });
  assert.equal(now.weekly.percent, 20);
});

// Failing TDD tests asserting intended app-server contract

test('parseAppServerRateLimits parses live app-server response with both buckets and plan', () => {
  assert.equal(typeof parseAppServerRateLimits, 'function', 'parseAppServerRateLimits must be exported by codexLimits.ts');
  const limits = parseAppServerRateLimits(liveFixture);
  assert.ok(limits, 'must return a limits object');
  assert.equal(limits.fiveHour.percent, 28);
  assert.equal(limits.fiveHour.windowMinutes, 300);
  assert.equal(limits.fiveHour.resetsAt, 1794453790);
  assert.equal(limits.weekly.percent, 4);
  assert.equal(limits.weekly.windowMinutes, 10080);
  assert.equal(limits.weekly.resetsAt, 1795040590);
  assert.equal(limits.planType, 'plus');
});

test('app-server limits retain earned-reset credits with availableCount and expirations', () => {
  assert.equal(typeof parseAppServerRateLimits, 'function', 'parseAppServerRateLimits must be exported by codexLimits.ts');
  const limits = parseAppServerRateLimits(liveFixture);
  assert.ok(limits.credits, 'earned-reset credits must be retained, not discarded');
  assert.equal(limits.credits.availableCount, 2);
  assert.equal(limits.credits.credits.length, 2);
  assert.equal(limits.credits.credits[0].id, 'RateLimitResetCredit_247dca61608c819188f72a83d915f73f');
  assert.equal(limits.credits.credits[0].expiresAt, 1796069816);
  assert.equal(limits.credits.credits[1].id, 'RateLimitResetCredit_2d151fe092f48191a19ce338ec6f9557');
  assert.equal(limits.credits.credits[1].expiresAt, 1796162262);
});

test('prefers rateLimitsByLimitId over legacy top-level rateLimits', () => {
  assert.equal(typeof parseAppServerRateLimits, 'function', 'parseAppServerRateLimits must be exported by codexLimits.ts');
  const payload = {
    result: {
      rateLimits: {
        primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 100 },
        secondary: { usedPercent: 5, windowDurationMins: 10080, resetsAt: 200 }
      },
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 88, windowDurationMins: 300, resetsAt: 300 },
          secondary: { usedPercent: 22, windowDurationMins: 10080, resetsAt: 400 }
        }
      }
    }
  };
  const limits = parseAppServerRateLimits(payload);
  assert.equal(limits.fiveHour.percent, 88, 'rateLimitsByLimitId should take precedence over rateLimits');
  assert.equal(limits.weekly.percent, 22);
});

test('falls back to top-level rateLimits when rateLimitsByLimitId is absent (legacy response)', () => {
  assert.equal(typeof parseAppServerRateLimits, 'function', 'parseAppServerRateLimits must be exported by codexLimits.ts');
  const limits = parseAppServerRateLimits(legacyFixture);
  assert.equal(limits.fiveHour.percent, 42);
  assert.equal(limits.weekly.percent, 18);
  assert.equal(limits.planType, 'pro');
  assert.equal(limits.credits.availableCount, 0);
});

test('handles ordinaryUsageAllowed=false by recording blockage / exhausted state', () => {
  assert.equal(typeof parseAppServerRateLimits, 'function', 'parseAppServerRateLimits must be exported by codexLimits.ts');
  const limits = parseAppServerRateLimits(exhaustedFixture);
  assert.equal(limits.ordinaryUsageAllowed, false);
  assert.equal(limits.fiveHour.percent, 100);
  assert.equal(limits.weekly.percent, 100);
  assert.equal(limits.credits.availableCount, 1, 'earned-reset credits must remain available to unblock');
});

test('handles absent duration or reset timestamps gracefully without throwing', () => {
  assert.equal(typeof parseAppServerRateLimits, 'function', 'parseAppServerRateLimits must be exported by codexLimits.ts');
  const partial = {
    result: {
      rateLimitsByLimitId: {
        codex: {
          primary: { usedPercent: 15 },
          secondary: { usedPercent: 7, windowDurationMins: 10080 }
        }
      }
    }
  };
  const limits = parseAppServerRateLimits(partial);
  assert.ok(limits);
  assert.equal(limits.weekly.percent, 7);
  assert.equal(limits.weekly.windowMinutes, 10080);
  assert.equal(limits.weekly.resetsAt, undefined);
});

test('method allowlist permits initialize and account/rateLimits/read, blocking unallowed methods', () => {
  assert.deepEqual(CODEX_APP_SERVER_METHODS, ['initialize', 'account/rateLimits/read']);
  assert.equal(typeof isAllowedAppServerMethod, 'function', 'isAllowedAppServerMethod must be exported by codexLimits.ts');
  assert.equal(isAllowedAppServerMethod('initialize'), true);
  assert.equal(isAllowedAppServerMethod('account/rateLimits/read'), true);
  assert.equal(isAllowedAppServerMethod('session/create'), false);
  assert.equal(isAllowedAppServerMethod('tools/call'), false);
});

test('codex app-server spawn arguments match configuration allowlist', () => {
  assert.deepEqual(CODEX_APP_SERVER_ARGS, [
    'app-server',
    '--stdio',
    '-c',
    'mcp_servers={}',
    '-c',
    'analytics.enabled=false'
  ]);
});

test('app-server stream client sends initialize then account/rateLimits/read and parses result', async () => {
  const query = queryCodexAppServer || readCodexAppServerLimits;
  assert.equal(typeof query, 'function', 'queryCodexAppServer or readCodexAppServerLimits must be exported');
  const fakeProc = new FakeAppServerProcess();
  const limits = await query({ spawnFn: () => fakeProc });
  assert.equal(fakeProc.receivedRequests.length, 2);
  assert.equal(fakeProc.receivedRequests[0].method, 'initialize');
  assert.equal(fakeProc.receivedRequests[1].method, 'account/rateLimits/read');
  assert.equal(limits.fiveHour.percent, 28);
  assert.equal(limits.weekly.percent, 4);
  assert.equal(limits.credits.availableCount, 2);
});

test('timeout kills hanging app-server child process and falls back to rollout tail', async () => {
  const query = queryCodexAppServer || readCodexAppServerLimits;
  assert.equal(typeof query, 'function', 'queryCodexAppServer or readCodexAppServerLimits must be exported');
  const fakeProc = new HangingAppServerProcess();
  const queryPromise = query({ spawnFn: () => fakeProc, timeoutMs: 50 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fakeProc.killed, true, 'hanging child process must be killed on timeout');
  assert.match(fakeProc.killSignal, /SIG(TERM|KILL)/);
  const result = await queryPromise;
  assert.equal(result, null, 'timeout query resolves to null fallback');
});

test('spawn failure (ENOENT or child error) falls back cleanly without unhandled rejection', async () => {
  const query = queryCodexAppServer || readCodexAppServerLimits;
  assert.equal(typeof query, 'function', 'queryCodexAppServer or readCodexAppServerLimits must be exported');
  const fakeProc = new FailingSpawnProcess();
  const result = await query({ spawnFn: () => fakeProc });
  assert.equal(result, null, 'failed spawn resolves cleanly to null fallback');
});

test('CodexLimitsReader queries app-server and retains credits when successful', async () => {
  assert.equal(typeof CodexLimitsReader.prototype.readWithAppServer, 'function', 'readWithAppServer must be implemented on CodexLimitsReader');
  const reader = new CodexLimitsReader('/tmp', () => null, {
    spawnFn: () => new FakeAppServerProcess()
  });
  const res = await reader.readWithAppServer();
  assert.ok(res);
  assert.equal(res.fiveHour.percent, 28);
  assert.equal(res.credits.availableCount, 2);
});

test('CodexLimitsReader falls back to rollout tail when app-server fails or times out', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-codex-limits-app-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.parse('2026-10-01T12:00:00Z');
  const date = recentDateDirs(now)[0];
  const user = path.join(home, '.codex');
  const rolloutDir = path.join(user, 'sessions', date);
  fs.mkdirSync(rolloutDir, { recursive: true });
  fs.writeFileSync(path.join(rolloutDir, 'rollout-a.jsonl'), rolloutLine('2026-10-01T10:00:00Z', 55, 33) + '\n');

  const reader = new CodexLimitsReader(user, () => null, {
    spawnFn: () => new FailingSpawnProcess()
  });
  const res = typeof reader.readWithAppServer === 'function'
    ? await reader.readWithAppServer(now)
    : reader.read(now);
  assert.ok(res, 'reader must return rollout tail when app-server fails');
  assert.equal(res.fiveHour.percent, 55);
  assert.equal(res.weekly.percent, 33);
});
