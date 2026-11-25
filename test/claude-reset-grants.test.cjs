'use strict';

/**
 * Claude's banked "Reset for free" grants (what `/limit-reset` spends) come from the
 * usage endpoint's `cedar_ember` block, which ~/.claude/hooks/fetch-usage-limits.sh
 * caches in limits.json. The endpoint is undocumented, so a missing or malformed block
 * must read as "no data" and never as zero resets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const ts = require('typescript');
const loadTs = require('../test-support/load-ts.cjs');

const electron = require.resolve('electron');
require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: { ipcMain: { handle() {} } } };

const { readClaudeResetGrants } = loadTs('src/main/claudeLimits.ts');

const NOW = Date.parse('2026-11-16T18:00:00Z');

function withLimitsJson(body, ageSec = 30) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'md-grants-'));
  const dir = path.join(runtime, 'cc-usage');
  fs.mkdirSync(dir);
  const p = path.join(dir, 'limits.json');
  fs.writeFileSync(p, JSON.stringify(body));
  const mtime = NOW / 1000 - ageSec;
  fs.utimesSync(p, mtime, mtime);
  process.env.XDG_RUNTIME_DIR = runtime;
}

const grant = (over) => ({
  id: 'full-reset-2611',
  label: 'One full limit reset (November 2026)',
  resets_total: 1,
  resets_left: 1,
  ends_at: '2026-12-10T22:00:00+00:00',
  usable_now: true,
  ...over
});

test('grants are read from limits.json, soonest expiry first', () => {
  withLimitsJson({
    cedar_ember: {
      eligible: true,
      grants: [
        grant({ id: 'launch-2610-fable', label: 'Fable reset', ends_at: '2027-03-09T07:59:00+00:00' }),
        grant({})
      ]
    }
  });
  const got = readClaudeResetGrants(NOW);
  assert.deepEqual(got.map((g) => g.id), ['full-reset-2611', 'launch-2610-fable']);
  assert.equal(got[0].left, 1);
  assert.equal(got[0].endsAt, Math.floor(Date.parse('2026-12-10T22:00:00Z') / 1000));
  assert.equal(got[0].usableNow, true);
});

test('spent and expired grants are dropped', () => {
  withLimitsJson({
    cedar_ember: {
      grants: [grant({ id: 'spent', resets_left: 0 }), grant({ id: 'old', ends_at: '2026-11-01T00:00:00Z' }), grant({ id: 'ok' })]
    }
  });
  assert.deepEqual(readClaudeResetGrants(NOW).map((g) => g.id), ['ok']);
});

test('a missing, null or malformed cedar_ember block is no data, not zero', () => {
  withLimitsJson({ five_hour: { utilization: 3 } });
  assert.equal(readClaudeResetGrants(NOW), undefined);
  withLimitsJson({ cedar_ember: null });
  assert.equal(readClaudeResetGrants(NOW), undefined);
  withLimitsJson({ cedar_ember: { grants: 'nope' } });
  assert.equal(readClaudeResetGrants(NOW), undefined);
});

test('the "surface" refusal is no data, not zero', () => {
  withLimitsJson({ cedar_ember: { eligible: false, ineligible_reason: 'surface', grants: [] } });
  assert.equal(readClaudeResetGrants(NOW), undefined);
});

test('a stale limits.json gives no grants, since one may have been spent since', () => {
  withLimitsJson({ cedar_ember: { grants: [grant({})] } }, 2 * 3600);
  assert.equal(readClaudeResetGrants(NOW), undefined);
});

function renderChip(limits) {
  const filePath = path.join(__dirname, '..', 'src/renderer/src/components/ClaudeLimitsChip.tsx');
  const out = ts.transpileModule(fs.readFileSync(filePath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true }
  }).outputText;
  const customReact = { ...React, useState: () => [limits, () => {}] };
  const mod = { exports: {} };
  const req = (name) => (name === 'react' ? customReact : name.includes('usageChipStyle') ? loadTs('src/renderer/src/components/usageChipStyle.ts') : {});
  new Function('React', 'module', 'exports', 'require', out)(customReact, mod, mod.exports, req);
  return ReactDOMServer.renderToStaticMarkup(React.createElement(mod.exports.ClaudeLimitsChip));
}

const base = { fiveHour: { percent: 11 }, sevenDay: { percent: 43 }, updatedAt: Date.now() };

test('the chip shows the total resets left and lists each grant in its tooltip', () => {
  const html = renderChip({
    ...base,
    resetGrants: [
      { id: 'a', label: 'One full limit reset (November 2026)', left: 1, endsAt: 1796940000, usableNow: true },
      { id: 'b', label: 'Fable reset', left: 1, endsAt: 1804579140, usableNow: true }
    ]
  });
  assert.match(html, />2 resets</);
  assert.match(html, /title="[^"]*One full limit reset \(November 2026\)[^"]*Fable reset[^"]*"/);
  assert.match(html, /\/limit-reset/);
});

test('the chip shows no reset count without grants', () => {
  assert.doesNotMatch(renderChip(base), /reset[s]?</);
  assert.doesNotMatch(renderChip({ ...base, resetGrants: [] }), /reset[s]?</);
});

const { ClaudeResetGrantNotices } = loadTs('src/main/claudeLimits.ts');
const { DEFAULT_TIMINGS } = loadTs('src/main/timings.ts');
const DAY = 24 * 60 * 60 * 1000;

function notices(enabled = true, leadMs = DAY) {
  const shown = [];
  const n = new ClaudeResetGrantNotices(() => enabled, (title, body) => shown.push({ title, body }), () => leadMs);
  return { n, shown };
}

const soon = (id, msFromNow, label = id) => ({ id, label, left: 1, endsAt: Math.floor((NOW + msFromNow) / 1000), usableNow: true });

test('the expiry lead time is a configurable timing, a week by default', () => {
  assert.equal(DEFAULT_TIMINGS.claudeResetGrantAlertLeadMs, 7 * DAY);
});

test('alerts once when the soonest grant is inside the lead time, naming it and /limit-reset', () => {
  const { n, shown } = notices();
  const limits = { updatedAt: NOW, resetGrants: [soon('full', 3 * 3600_000, 'One full limit reset'), soon('fable', 90 * DAY)] };
  n.check(limits, NOW);
  n.check(limits, NOW + 60_000);
  assert.equal(shown.length, 1);
  assert.match(shown[0].body, /One full limit reset/);
  assert.match(shown[0].body, /\/limit-reset/);
});

test('no alert while the soonest grant is further out than the lead time', () => {
  const { n, shown } = notices();
  n.check({ updatedAt: NOW, resetGrants: [soon('full', 3 * DAY)] }, NOW);
  assert.equal(shown.length, 0);
});

test('no alert without grant data', () => {
  const { n, shown } = notices();
  n.check({ updatedAt: NOW }, NOW);
  n.check(null, NOW);
  assert.equal(shown.length, 0);
});

test('a second grant entering the lead time gets its own alert', () => {
  const { n, shown } = notices();
  n.check({ updatedAt: NOW, resetGrants: [soon('a', 3600_000), soon('b', 2 * DAY)] }, NOW);
  n.check({ updatedAt: NOW, resetGrants: [soon('b', 2 * DAY)] }, NOW + 1.5 * DAY);
  assert.equal(shown.length, 2);
});

test('notifications off marks the grant seen without showing it', () => {
  const { n, shown } = notices(false);
  const limits = { updatedAt: NOW, resetGrants: [soon('a', 3600_000)] };
  n.check(limits, NOW);
  assert.equal(shown.length, 0);
});

test('WIRING: the limit beat checks Claude grants alongside Codex credits', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(src, /const\s+claudeResetGrantNotices\s*=\s*new\s+ClaudeResetGrantNotices\(/);
  assert.match(src, /claudeResetGrantNotices\.check\(/);
});

test('the final reminder is a configurable timing, a day by default', () => {
  assert.equal(DEFAULT_TIMINGS.claudeResetGrantFinalAlertLeadMs, DAY);
});

function twoStage() {
  const shown = [];
  const n = new ClaudeResetGrantNotices(() => true, (title, body) => shown.push({ title, body }), () => 7 * DAY, () => DAY);
  return { n, shown };
}

test('a grant gets the week warning and then a day-before reminder, once each', () => {
  const { n, shown } = twoStage();
  const g = soon('full', 5 * DAY, 'One full limit reset');
  n.check({ resetGrants: [g] }, NOW);
  n.check({ resetGrants: [g] }, NOW + DAY);
  assert.equal(shown.length, 1);
  n.check({ resetGrants: [g] }, NOW + 4.5 * DAY);
  n.check({ resetGrants: [g] }, NOW + 4.6 * DAY);
  assert.equal(shown.length, 2);
  assert.notEqual(shown[0].title, shown[1].title);
  assert.match(shown[1].body, /One full limit reset/);
});

test('first seen inside the last day, a grant gets only the reminder, not both', () => {
  const { n, shown } = twoStage();
  n.check({ resetGrants: [soon('full', 3600_000)] }, NOW);
  assert.equal(shown.length, 1);
});

test('two grants expiring in the same window each get their own warning', () => {
  const { n, shown } = twoStage();
  n.check({ resetGrants: [soon('a', 3 * DAY), soon('b', 4 * DAY)] }, NOW);
  assert.equal(shown.length, 2);
});
