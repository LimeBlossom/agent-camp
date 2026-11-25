'use strict';

/**
 * Tests for on-demand Claude limits fallback via `claude /usage`.
 *
 * When $XDG_RUNTIME_DIR/cc-usage/ (limits.json or per-session files) has not been
 * refreshed by any active session and no live Status rate_limits are being forwarded,
 * the limits chip and balancer fall back to querying `claude /usage`.
 *
 * Contract requirements:
 *  - Parses recognized `Current session:` and `Current week:` lines.
 *  - Ignores other models (e.g. `Current week (Fable):`).
 *  - Strips ANSI escape sequences.
 *  - Treats ambiguous reset dates as unavailable (resetsAt: undefined).
 *  - Fails visibly (throws Error) on unknown or malformed output.
 *  - Triggers fallback when cache is stale or missing.
 *  - Does NOT spawn when cache or live rate_limits are fresh.
 *  - Falls back gracefully to stale cache if fallback spawn fails.
 */

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

const claudeLimitsMod = loadTs('src/main/claudeLimits.ts');
const {
  readClaudeLimits,
  noteLiveRateLimits,
  parseClaudeUsageOutput,
  isClaudeLimitsStale,
  queryClaudeUsage,
  readClaudeLimitsWithFallback,
  CLAUDE_USAGE_CMD,
  CLAUDE_USAGE_ARGS,
  CLAUDE_LIMITS_STALE_MS
} = claudeLimitsMod;

const liveFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-usage-live.txt'), 'utf8');
const exhaustedFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-usage-exhausted.txt'), 'utf8');
const ansiFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-usage-ansi.txt'), 'utf8');
const unknownFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-usage-unknown.txt'), 'utf8');

function withTempCache(files) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'md-limits-fb-'));
  const dir = path.join(runtime, 'cc-usage');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now() / 1000;
  for (const [name, body, ageSec] of files) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(body));
    fs.utimesSync(p, now - ageSec, now - ageSec);
  }
  process.env.XDG_RUNTIME_DIR = runtime;
  return runtime;
}

class FakeClaudeProcess extends EventEmitter {
  constructor({ stdoutText = '', exitCode = 0, delayMs = 0, signal = null } = {}) {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.killSignal = null;
    this.pid = 54321;
    this.spawnArgs = [];

    if (delayMs > 0) {
      setTimeout(() => {
        if (!this.killed) {
          if (stdoutText) this.stdout.write(stdoutText);
          this.stdout.end();
          this.emit('exit', exitCode, signal);
          this.emit('close', exitCode, signal);
        }
      }, delayMs);
    } else {
      process.nextTick(() => {
        if (!this.killed) {
          if (stdoutText) this.stdout.write(stdoutText);
          this.stdout.end();
          this.emit('exit', exitCode, signal);
          this.emit('close', exitCode, signal);
        }
      });
    }
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.killSignal = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
    return true;
  }
}

class HangingClaudeProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.killSignal = null;
    this.pid = 54322;
  }

  kill(signal = 'SIGTERM') {
    this.killed = true;
    this.killSignal = signal;
    this.emit('exit', null, signal);
    this.emit('close', null, signal);
    return true;
  }
}

// -----------------------------------------------------------------------------
// 0. Controls (Existing claudeLimits behavior)
// -----------------------------------------------------------------------------

test('control: readClaudeLimits and noteLiveRateLimits are exported functions', () => {
  assert.equal(typeof readClaudeLimits, 'function');
  assert.equal(typeof noteLiveRateLimits, 'function');
});

test('control: readClaudeLimits reads fresh endpoint limits.json correctly', () => {
  withTempCache([
    ['limits.json', { five_hour: { utilization: 22, resets_at: '2026-11-12T00:00:00Z' }, seven_day: { utilization: 55 } }, 10]
  ]);
  const got = readClaudeLimits();
  assert.ok(got);
  assert.equal(got.fiveHour?.percent, 22);
  assert.equal(got.sevenDay?.percent, 55);
});

test('control: readClaudeLimits reads fresh session file correctly', () => {
  withTempCache([
    ['sess-ctrl.json', { rate_limits: { five_hour: { used_percentage: 14 }, seven_day: { used_percentage: 44 } } }, 10]
  ]);
  const got = readClaudeLimits();
  assert.ok(got);
  assert.equal(got.fiveHour?.percent, 14);
  assert.equal(got.sevenDay?.percent, 44);
});

test('control: noteLiveRateLimits sets live in-memory rate limits', () => {
  withTempCache([]);
  noteLiveRateLimits({ five_hour: { used_percentage: 31 }, seven_day: { used_percentage: 62 } }, Date.now());
  const got = readClaudeLimits();
  assert.ok(got);
  assert.equal(got.fiveHour?.percent, 31);
  assert.equal(got.sevenDay?.percent, 62);
});

// -----------------------------------------------------------------------------
// 1. Output Parsing Tests
// -----------------------------------------------------------------------------

test('parseClaudeUsageOutput parses standard live claude /usage output', () => {
  assert.equal(typeof parseClaudeUsageOutput, 'function', 'parseClaudeUsageOutput must be exported');
  const now = 1794500000000;
  const parsed = parseClaudeUsageOutput(liveFixture, now);
  assert.ok(parsed, 'should return a parsed ClaudeLimits object');
  assert.equal(parsed.fiveHour?.percent, 5, 'session percent should parse to 5');
  assert.equal(parsed.sevenDay?.percent, 72, 'weekly percent should parse to 72');
  assert.equal(parsed.updatedAt, now, 'updatedAt should reflect the provided timestamp');
});

test('parseClaudeUsageOutput parses 100% exhausted and 0% limit outputs', () => {
  assert.equal(typeof parseClaudeUsageOutput, 'function', 'parseClaudeUsageOutput must be exported');
  const parsed = parseClaudeUsageOutput(exhaustedFixture);
  assert.ok(parsed);
  assert.equal(parsed.fiveHour?.percent, 100);
  assert.equal(parsed.sevenDay?.percent, 98);

  const zeroText = 'Current session: 0% used · resets in 4 hours\nCurrent week: 0% used · resets Nov 18';
  const zeroParsed = parseClaudeUsageOutput(zeroText);
  assert.equal(zeroParsed.fiveHour?.percent, 0);
  assert.equal(zeroParsed.sevenDay?.percent, 0);
});

test('parseClaudeUsageOutput strips ANSI color escape codes before parsing', () => {
  assert.equal(typeof parseClaudeUsageOutput, 'function', 'parseClaudeUsageOutput must be exported');
  const parsed = parseClaudeUsageOutput(ansiFixture);
  assert.ok(parsed);
  assert.equal(parsed.fiveHour?.percent, 15);
  assert.equal(parsed.sevenDay?.percent, 60);
});

test('parseClaudeUsageOutput supports alternative weekly section header without (all models)', () => {
  assert.equal(typeof parseClaudeUsageOutput, 'function', 'parseClaudeUsageOutput must be exported');
  const text = 'Current session: 20% used · resets 11pm\nCurrent week: 45% used · resets Nov 18';
  const parsed = parseClaudeUsageOutput(text);
  assert.equal(parsed.fiveHour?.percent, 20);
  assert.equal(parsed.sevenDay?.percent, 45);
});

test('parseClaudeUsageOutput treats ambiguous reset dates as unavailable (resetsAt undefined)', () => {
  assert.equal(typeof parseClaudeUsageOutput, 'function', 'parseClaudeUsageOutput must be exported');
  // Live fixture has reset dates like "Nov 11, 11:59pm (America/Chicago)" which lack year and standard format
  const parsed = parseClaudeUsageOutput(liveFixture);
  assert.equal(parsed.fiveHour?.resetsAt, undefined, 'ambiguous date should treat resetsAt as unavailable');
  assert.equal(parsed.sevenDay?.resetsAt, undefined, 'ambiguous date should treat resetsAt as unavailable');
});

test('parseClaudeUsageOutput parses unambiguous ISO reset timestamps when present', () => {
  assert.equal(typeof parseClaudeUsageOutput, 'function', 'parseClaudeUsageOutput must be exported');
  const text = 'Current session: 10% used · resets 2026-11-12T05:00:00Z\nCurrent week: 30% used · resets 2026-11-18T12:00:00Z';
  const parsed = parseClaudeUsageOutput(text);
  assert.equal(parsed.fiveHour?.percent, 10);
  assert.equal(parsed.fiveHour?.resetsAt, Math.floor(Date.parse('2026-11-12T05:00:00Z') / 1000));
  assert.equal(parsed.sevenDay?.percent, 30);
  assert.equal(parsed.sevenDay?.resetsAt, Math.floor(Date.parse('2026-11-18T12:00:00Z') / 1000));
});

test('parseClaudeUsageOutput fails visibly on unknown or error output (Cloudflare 503, HTML)', () => {
  assert.equal(typeof parseClaudeUsageOutput, 'function', 'parseClaudeUsageOutput must be exported');
  assert.throws(
    () => parseClaudeUsageOutput(unknownFixture),
    /unrecognized|unknown|parse|invalid|no usage/i,
    'must fail visibly on unknown output'
  );
});

test('parseClaudeUsageOutput fails visibly on empty output', () => {
  assert.equal(typeof parseClaudeUsageOutput, 'function', 'parseClaudeUsageOutput must be exported');
  assert.throws(
    () => parseClaudeUsageOutput('   \n  \n'),
    /unrecognized|unknown|parse|empty|no usage/i,
    'must fail visibly on empty output'
  );
});

test('parseClaudeUsageOutput fails visibly on arbitrary text lacking usage metrics', () => {
  assert.equal(typeof parseClaudeUsageOutput, 'function', 'parseClaudeUsageOutput must be exported');
  assert.throws(
    () => parseClaudeUsageOutput('Welcome to Claude Code! Type /help for assistance.'),
    /unrecognized|unknown|parse|no usage/i,
    'must fail visibly when usage metrics are missing'
  );
});

test('parseClaudeUsageOutput fails visibly on malformed percentage tokens', () => {
  assert.equal(typeof parseClaudeUsageOutput, 'function', 'parseClaudeUsageOutput must be exported');
  const bad = 'Current session: NaN% used · resets tomorrow\nCurrent week: ??% used';
  assert.throws(
    () => parseClaudeUsageOutput(bad),
    /unrecognized|unknown|parse|invalid/i,
    'must fail visibly on malformed percentage tokens'
  );
});

test('parseClaudeUsageOutput fails visibly on CLI auth/login error output', () => {
  assert.equal(typeof parseClaudeUsageOutput, 'function', 'parseClaudeUsageOutput must be exported');
  const authErr = 'Error: You must run `claude login` before checking usage.';
  assert.throws(
    () => parseClaudeUsageOutput(authErr),
    /unrecognized|unknown|parse|error|login|auth/i,
    'must fail visibly on CLI auth errors'
  );
});

// -----------------------------------------------------------------------------
// 2. Constants & Staleness Detection
// -----------------------------------------------------------------------------

test('CLAUDE_USAGE_CMD is claude and CLAUDE_USAGE_ARGS is ["/usage"]', () => {
  assert.equal(CLAUDE_USAGE_CMD, 'claude');
  assert.deepEqual(CLAUDE_USAGE_ARGS, ['/usage']);
});

test('CLAUDE_LIMITS_STALE_MS defines a reasonable staleness window (e.g. 15 minutes)', () => {
  assert.equal(typeof CLAUDE_LIMITS_STALE_MS, 'number');
  assert.ok(CLAUDE_LIMITS_STALE_MS >= 5 * 60_000, 'staleness threshold should be at least 5 minutes');
  assert.ok(CLAUDE_LIMITS_STALE_MS <= 30 * 60_000, 'staleness threshold should be at most 30 minutes');
});

test('isClaudeLimitsStale identifies fresh vs stale cache based on updatedAt', () => {
  assert.equal(typeof isClaudeLimitsStale, 'function', 'isClaudeLimitsStale must be exported');
  const now = 1000000;
  const staleWindow = CLAUDE_LIMITS_STALE_MS || 900_000;

  assert.equal(isClaudeLimitsStale(null, now), true, 'null reading is stale');
  assert.equal(isClaudeLimitsStale({ updatedAt: now - 30_000 }, now), false, '30s old reading is fresh');
  assert.equal(isClaudeLimitsStale({ updatedAt: now - staleWindow + 1000 }, now), false, 'reading just inside threshold is fresh');
  assert.equal(isClaudeLimitsStale({ updatedAt: now - staleWindow - 1000 }, now), true, 'reading past threshold is stale');
});

// -----------------------------------------------------------------------------
// 3. Fallback Spawner & Process Handling
// -----------------------------------------------------------------------------

test('queryClaudeUsage executes claude /usage with non-interactive stdio and parses output', async () => {
  assert.equal(typeof queryClaudeUsage, 'function', 'queryClaudeUsage must be exported');
  let spawnedCmd = null;
  let spawnedArgs = null;
  let spawnOptions = null;

  const fakeProc = new FakeClaudeProcess({ stdoutText: liveFixture });
  const limits = await queryClaudeUsage({
    spawnFn: (cmd, args, opts) => {
      spawnedCmd = cmd;
      spawnedArgs = args;
      spawnOptions = opts;
      return fakeProc;
    }
  });

  assert.equal(spawnedCmd, 'claude');
  assert.deepEqual(spawnedArgs, ['/usage']);
  assert.ok(spawnOptions?.stdio, 'stdio options must be configured');
  assert.equal(limits.fiveHour?.percent, 5);
  assert.equal(limits.sevenDay?.percent, 72);
});

test('queryClaudeUsage kills process and times out when command hangs', async () => {
  assert.equal(typeof queryClaudeUsage, 'function', 'queryClaudeUsage must be exported');
  const fakeProc = new HangingClaudeProcess();

  const promise = queryClaudeUsage({
    spawnFn: () => fakeProc,
    timeoutMs: 50
  });

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(fakeProc.killed, true, 'hanging process must be killed on timeout');
  assert.match(fakeProc.killSignal, /SIG(TERM|KILL)/);

  await assert.rejects(promise, /timeout/i);
});

test('queryClaudeUsage handles process spawn failure or non-zero exit cleanly', async () => {
  assert.equal(typeof queryClaudeUsage, 'function', 'queryClaudeUsage must be exported');
  const fakeProc = new FakeClaudeProcess({ exitCode: 1, stdoutText: 'CLI error' });
  await assert.rejects(
    queryClaudeUsage({ spawnFn: () => fakeProc }),
    /exit|error|fail/i
  );
});

// -----------------------------------------------------------------------------
// 4. Fallback Triggering vs Fresh Cache Behavior
// -----------------------------------------------------------------------------

test('stale cache triggers the fallback: readClaudeLimitsWithFallback queries claude /usage', async () => {
  assert.equal(typeof readClaudeLimitsWithFallback, 'function', 'readClaudeLimitsWithFallback must be exported');
  // Endpoint reading is 2 hours old (7200s > STALE_MS)
  withTempCache([
    ['limits.json', { five_hour: { utilization: 90 }, seven_day: { utilization: 95 } }, 7200]
  ]);

  let spawnCount = 0;
  const fakeProc = new FakeClaudeProcess({ stdoutText: liveFixture });
  const limits = await readClaudeLimitsWithFallback({
    spawnFn: () => {
      spawnCount++;
      return fakeProc;
    }
  });

  assert.equal(spawnCount, 1, 'spawner should have been triggered because cache is stale');
  assert.equal(limits.fiveHour?.percent, 5, 'should return fresh limits from fallback');
  assert.equal(limits.sevenDay?.percent, 72, 'should return fresh limits from fallback');
});

test('missing cache directory triggers the fallback: queries claude /usage on-demand', async () => {
  assert.equal(typeof readClaudeLimitsWithFallback, 'function', 'readClaudeLimitsWithFallback must be exported');
  process.env.XDG_RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'md-empty-runtime-'));

  let spawnCount = 0;
  const fakeProc = new FakeClaudeProcess({ stdoutText: liveFixture });
  const limits = await readClaudeLimitsWithFallback({
    spawnFn: () => {
      spawnCount++;
      return fakeProc;
    }
  });

  assert.equal(spawnCount, 1, 'spawner should be triggered when cache is missing');
  assert.equal(limits.fiveHour?.percent, 5);
  assert.equal(limits.sevenDay?.percent, 72);
});


/** The Fable refresh runs /usage once per window even on a fresh cache; spend that run so the no-spawn tests below measure the steady state. */
async function spendFableRefresh() {
  await readClaudeLimitsWithFallback({ spawnFn: () => new FakeClaudeProcess({ stdoutText: 'Current session: 1% used\nCurrent week (all models): 1% used\n' }) });
}

test('no spawn when cache is fresh: readClaudeLimitsWithFallback does not spawn if limits.json is fresh', async () => {
  assert.equal(typeof readClaudeLimitsWithFallback, 'function', 'readClaudeLimitsWithFallback must be exported');
  // 30 seconds old cache reading
  withTempCache([
    ['limits.json', { five_hour: { utilization: 12 }, seven_day: { utilization: 25 } }, 30]
  ]);

  await spendFableRefresh();
  let spawnCount = 0;
  const limits = await readClaudeLimitsWithFallback({
    spawnFn: () => {
      spawnCount++;
      return new FakeClaudeProcess({ stdoutText: liveFixture });
    }
  });

  assert.equal(spawnCount, 0, 'spawner must NOT be called when cache is fresh');
  assert.equal(limits.fiveHour?.percent, 12, 'should return cached fiveHour value');
  assert.equal(limits.sevenDay?.percent, 25, 'should return cached sevenDay value');
});

test('no spawn when session file cache is fresh: does not spawn if session reading is fresh', async () => {
  assert.equal(typeof readClaudeLimitsWithFallback, 'function', 'readClaudeLimitsWithFallback must be exported');
  // Session reading 15 seconds old
  withTempCache([
    ['sess-1.json', { rate_limits: { five_hour: { used_percentage: 18 }, seven_day: { used_percentage: 42 } } }, 15]
  ]);

  await spendFableRefresh();
  let spawnCount = 0;
  const limits = await readClaudeLimitsWithFallback({
    spawnFn: () => {
      spawnCount++;
      return new FakeClaudeProcess({ stdoutText: liveFixture });
    }
  });

  assert.equal(spawnCount, 0, 'spawner must NOT be called when session cache is fresh');
  assert.equal(limits.fiveHour?.percent, 18);
  assert.equal(limits.sevenDay?.percent, 42);
});

test('no spawn when live rate_limits is fresh: does not spawn if live memory reading is fresh', async () => {
  assert.equal(typeof readClaudeLimitsWithFallback, 'function', 'readClaudeLimitsWithFallback must be exported');
  withTempCache([
    ['limits.json', { five_hour: { utilization: 90 }, seven_day: { utilization: 95 } }, 7200]
  ]);

  // Record live reading right now
  noteLiveRateLimits({ five_hour: { used_percentage: 7 }, seven_day: { used_percentage: 14 } }, Date.now());

  await spendFableRefresh();
  let spawnCount = 0;
  const limits = await readClaudeLimitsWithFallback({
    spawnFn: () => {
      spawnCount++;
      return new FakeClaudeProcess({ stdoutText: liveFixture });
    }
  });

  assert.equal(spawnCount, 0, 'spawner must NOT be called when live rate_limits are fresh');
  assert.equal(limits.fiveHour?.percent, 7);
  assert.equal(limits.sevenDay?.percent, 14);
});

test('readClaudeLimitsWithFallback returns stale cache gracefully if fallback spawn fails', async () => {
  assert.equal(typeof readClaudeLimitsWithFallback, 'function', 'readClaudeLimitsWithFallback must be exported');
  withTempCache([
    ['limits.json', { five_hour: { utilization: 50 }, seven_day: { utilization: 80 } }, 7200]
  ]);

  const limits = await readClaudeLimitsWithFallback({
    spawnFn: () => new FakeClaudeProcess({ exitCode: 1, stdoutText: 'Crash' })
  });

  assert.ok(limits, 'should return fallback cached limits instead of crashing');
  assert.equal(limits.fiveHour?.percent, 50);
  assert.equal(limits.sevenDay?.percent, 80);
});

test('fresh cache with no Fable reading runs /usage once, and not again within the window', async () => {
  withTempCache([
    ['limits.json', { five_hour: { utilization: 12 }, seven_day: { utilization: 25 } }, 30]
  ]);
  const fableText = 'Current session: 31% used\nCurrent week (all models): 7% used\nCurrent week (Fable): 2% used\n';
  let spawnCount = 0;
  const spawnFn = () => { spawnCount++; return new FakeClaudeProcess({ stdoutText: fableText }); };
  const base = Date.now() + 5 * 60 * 1000;
  const first = await readClaudeLimitsWithFallback({ spawnFn, now: base });
  assert.equal(spawnCount, 1, 'Fable missing: /usage runs although cc-usage is fresh');
  assert.equal(first.sevenDayFable?.percent, 2);
  assert.equal(first.fiveHour?.percent, 12, 'cc-usage values still win');
  await readClaudeLimitsWithFallback({ spawnFn, now: base + 60_000 });
  assert.equal(spawnCount, 1, 'second call inside 15 min must not spawn');
});
