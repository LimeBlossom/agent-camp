'use strict';

/**
 * Fable weekly usage meter (card camp-fable-usage-meter).
 * `claude /usage` prints a "Current week (Fable)" line; today it is dropped.
 * Contract: parsed into ClaudeLimits.sevenDayFable (undefined when absent, never 0),
 * carried by formatAllLimits as a 'fable' segment, and rendered by ClaudeLimitsChip.
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

const {
  parseClaudeUsageOutput,
  readClaudeLimits,
  readClaudeLimitsWithFallback
} = loadTs('src/main/claudeLimits.ts');
const { formatClaudeLimits, formatAllLimits } = loadTs('src/shared/engineLimits.ts');

function withCache(files) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'md-limits-fable-'));
  const dir = path.join(runtime, 'cc-usage');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now() / 1000;
  for (const [name, body, ageSec] of files) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(body));
    fs.utimesSync(p, now - ageSec, now - ageSec);
  }
  process.env.XDG_RUNTIME_DIR = runtime;
  return dir;
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

    process.nextTick(() => {
      if (!this.killed) {
        if (stdoutText) this.stdout.write(stdoutText);
        this.stdout.end();
        this.emit('exit', exitCode, signal);
        this.emit('close', exitCode, signal);
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

const multilineFixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-usage-fable-multiline.txt'), 'utf8');

const VERBATIM = [
  'Current session: 31% used · resets Nov 13, 3:59pm (America/Chicago)',
  'Current week (all models): 7% used · resets Nov 13, 2:59pm (America/Chicago)',
  'Current week (Fable): 2% used · resets Nov 13, 2:59pm (America/Chicago)',
  ''
].join('\n');

test('parser reads the Fable week line into sevenDayFable', () => {
  const got = parseClaudeUsageOutput(VERBATIM, 1000);
  assert.equal(got.sevenDayFable.percent, 2);
  assert.equal(got.updatedAt, 1000);
});

test('the Fable line never leaks into the other meters', () => {
  const got = parseClaudeUsageOutput(VERBATIM);
  assert.equal(got.fiveHour.percent, 31);
  assert.equal(got.sevenDay.percent, 7);
});

test('Fable line listed before the all-models line still keeps sevenDay at all-models', () => {
  const swapped = [
    'Current session: 31% used',
    'Current week (Fable): 2% used',
    'Current week (all models): 7% used'
  ].join('\n');
  const got = parseClaudeUsageOutput(swapped);
  assert.equal(got.sevenDay.percent, 7);
  assert.equal(got.sevenDayFable.percent, 2);
});

test('an ISO reset on the Fable line parses like the other meters', () => {
  const raw = 'Current session: 1% used\nCurrent week (Fable): 2% used · resets 2026-11-20T19:59:00Z\n';
  const got = parseClaudeUsageOutput(raw);
  assert.equal(got.sevenDayFable.resetsAt, Math.floor(Date.parse('2026-11-20T19:59:00Z') / 1000));
});

test('a missing Fable line leaves sevenDayFable undefined, not 0', () => {
  const raw = 'Current session: 31% used\nCurrent week (all models): 7% used\n';
  const got = parseClaudeUsageOutput(raw);
  assert.equal(got.sevenDayFable, undefined);
  assert.equal(got.sevenDay.percent, 7);
});

test('a Fable-only week line without all-models does not become sevenDay', () => {
  const got = parseClaudeUsageOutput('Current session: 5% used\nCurrent week (Fable): 2% used\n');
  assert.equal(got.sevenDay, undefined);
  assert.equal(got.sevenDayFable.percent, 2);
});

test('a malformed Fable percentage fails visibly like the other lines', () => {
  assert.throws(
    () => parseClaudeUsageOutput('Current session: 5% used\nCurrent week (Fable): lots\n'),
    /Unrecognized claude \/usage output/
  );
});

test('formatClaudeLimits adds a fable segment after wk with percent and reset', () => {
  const now = 1_700_000_000_000;
  const out = formatClaudeLimits(
    {
      fiveHour: { percent: 31 },
      sevenDay: { percent: 7 },
      sevenDayFable: { percent: 2.4, resetsAt: Math.floor((now + 130 * 60_000) / 1000) }
    },
    now
  );
  assert.deepEqual(out.segments.map((s) => s.label), ['5h', 'wk', 'fable']);
  assert.deepEqual(out.segments[2], { label: 'fable', percent: 2, reset: '2h 10m' });
});

test('no fable segment when the reading is absent', () => {
  const out = formatClaudeLimits({ fiveHour: { percent: 31 }, sevenDay: { percent: 7 } });
  assert.deepEqual(out.segments.map((s) => s.label), ['5h', 'wk']);
});

test('formatAllLimits carries the fable segment to the phone page', () => {
  const all = formatAllLimits({ claude: { sevenDay: { percent: 7 }, sevenDayFable: { percent: 2 } } });
  assert.deepEqual(all[0].segments.map((s) => s.label), ['wk', 'fable']);
});

test('a Fable-only reading still yields a claude row', () => {
  const out = formatClaudeLimits({ sevenDayFable: { percent: 2 } });
  assert.deepEqual(out.segments.map((s) => s.label), ['fable']);
});

const chip = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/ClaudeLimitsChip.tsx'), 'utf8');

test('chip renders a fable segment from sevenDayFable and shows it when it is the only meter', () => {
  assert.match(chip, /label="fable"[^>]*bucket=\{limits\.sevenDayFable\}/);
  assert.match(chip, /!limits\.sevenDayFable/);
});

test('chip tooltip carries the reset time for the fable meter (shared Segment)', () => {
  assert.match(chip, /resets in \$\{reset\}/);
});

// Tests for card camp-phone-fable-missing:
// Suspect 1: Current claude /usage output has colon-less headers and multi-line meters
test('parser reads Fable from real current claude /usage output (colon-less header and multi-line meter)', () => {
  const got = parseClaudeUsageOutput(multilineFixture, 1000);
  assert.ok(got.sevenDayFable, 'sevenDayFable should be parsed from real claude /usage output');
  assert.equal(got.sevenDayFable.percent, 22);
  assert.equal(got.sevenDay.percent, 39);
  assert.equal(got.fiveHour.percent, 2);
  assert.equal(got.updatedAt, 1000);
});

test('parser reads Fable with ISO reset timestamp in multi-line format', () => {
  const raw = [
    'Current session',
    '█ 2% used',
    '',
    'Current week (Fable)',
    '███████████ 22% used',
    'Resets 2026-11-20T19:59:00Z'
  ].join('\n');
  const got = parseClaudeUsageOutput(raw, 2000);
  assert.ok(got.sevenDayFable, 'sevenDayFable must be parsed');
  assert.equal(got.sevenDayFable.percent, 22);
  assert.equal(got.sevenDayFable.resetsAt, Math.floor(Date.parse('2026-11-20T19:59:00Z') / 1000));
});

// Suspect 2: Borrow path - readClaudeLimits() must fill sevenDayFable from fresh fallbackCache
test('readClaudeLimits borrows sevenDayFable from fresh fallbackCache when cc-usage has none', async () => {
  withCache([
    ['limits.json', { five_hour: { utilization: 12 }, seven_day: { utilization: 25 } }, 30]
  ]);
  // Populate fallbackCache via readClaudeLimitsWithFallback
  const spawnFn = () => new FakeClaudeProcess({ stdoutText: VERBATIM });
  const base = Date.now();
  await readClaudeLimitsWithFallback({ spawnFn, now: base });

  // Synchronous readClaudeLimits (called by startPhoneServer / phone page) must carry borrowed Fable
  const got = readClaudeLimits();
  assert.ok(got, 'limits should not be null');
  assert.ok(got.sevenDayFable, 'readClaudeLimits must borrow sevenDayFable from fresh fallbackCache');
  assert.equal(got.sevenDayFable.percent, 2);
  assert.equal(got.fiveHour.percent, 12, 'cc-usage 5h utilization preserved');
  assert.equal(got.sevenDay.percent, 25, 'cc-usage 7d utilization preserved');
});

test('phone page limits formatAllLimits carries sevenDayFable when readClaudeLimits borrows from fallbackCache', async () => {
  withCache([
    ['limits.json', { five_hour: { utilization: 12 }, seven_day: { utilization: 25 } }, 30]
  ]);
  const spawnFn = () => new FakeClaudeProcess({ stdoutText: VERBATIM });
  const base = Date.now();
  await readClaudeLimitsWithFallback({ spawnFn, now: base });

  // Simulating the Camp phone page limits callback: limits: () => formatAllLimits({ claude: readClaudeLimits(), ... })
  const all = formatAllLimits({
    claude: readClaudeLimits()
  });
  const claudeRow = all.find((r) => r.id === 'claude');
  assert.ok(claudeRow, 'claude row must be present');
  assert.deepEqual(
    claudeRow.segments.map((s) => s.label),
    ['5h', 'wk', 'fable'],
    'phone page claude row must carry 5h, wk, and fable segments'
  );
  const fableSegment = claudeRow.segments.find((s) => s.label === 'fable');
  assert.equal(fableSegment.percent, 2);
});

test('readClaudeLimits borrows sevenDayFable after readClaudeLimitsWithFallback runs real claude /usage output', async () => {
  withCache([
    ['limits.json', { five_hour: { utilization: 12 }, seven_day: { utilization: 25 } }, 30]
  ]);
  const spawnFn = () => new FakeClaudeProcess({ stdoutText: multilineFixture });
  const base = Date.now();
  await readClaudeLimitsWithFallback({ spawnFn, now: base });

  const got = readClaudeLimits();
  assert.ok(got, 'limits should not be null');
  assert.ok(got.sevenDayFable, 'readClaudeLimits must borrow sevenDayFable parsed from real claude /usage');
  assert.equal(got.sevenDayFable.percent, 22);
});

