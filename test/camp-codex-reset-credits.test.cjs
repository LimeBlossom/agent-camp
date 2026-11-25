'use strict';

/**
 * camp-reset-credits-tests: Missed step 2 contract tests for Codex reset credits.
 *
 * Requirements from source proposal (god/inbox/.done/2026-11-12T05-05-14-207Z-56f121.json):
 * 1. Chip count visible above zero, absent at zero/missing; tooltip lists each expiry.
 * 2. Once-only alert within configurable lead time before soonest expiry, dedup by credit id, no repeated alert.
 * 3. ordinaryUsageAllowed=false never suggests an actionable reset.
 *
 * Uses existing timings config (TimingsConfig / DEFAULT_TIMINGS) and notification seams (LimitLockNotices style).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const ts = require('typescript');
const loadTs = require('../test-support/load-ts.cjs');

// Mock electron ipcMain
const electron = require.resolve('electron');
require.cache[electron] = {
  id: electron,
  filename: electron,
  loaded: true,
  exports: { ipcMain: { handle() {} } }
};

// ─── Modules Under Test ────────────────────────────────────────────────────────

const timingsMod = loadTs('src/main/timings.ts');
const { DEFAULT_TIMINGS, getTimings } = timingsMod;

const providerLimitsMod = loadTs('src/main/providerLimits.ts');
const { LimitLockNotices } = providerLimitsMod;

const codexLimitsMod = loadTs('src/main/codexLimits.ts');
const { parseAppServerRateLimits, withResets } = codexLimitsMod;

// ─── Helper: Render CodexLimitsChip with Injected Limits ────────────────────────

function loadCodexLimitsChipModule(injectedLimits) {
  const filePath = path.join(__dirname, '..', 'src/renderer/src/components/CodexLimitsChip.tsx');
  const code = fs.readFileSync(filePath, 'utf8');
  const transpiled = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.React,
      esModuleInterop: true
    }
  });

  const customReact = {
    ...React,
    useState: (init) => {
      // Injected limits overrides initial state during SSR render
      return [injectedLimits !== undefined ? injectedLimits : init, () => {}];
    }
  };

  const mod = { exports: {} };
  const req = (name) => {
    if (name === 'react') return customReact;
    if (name.includes('usageChipStyle')) return loadTs('src/renderer/src/components/usageChipStyle.ts');
    return {};
  };

  const fn = new Function('React', 'module', 'exports', 'require', transpiled.outputText);
  fn(customReact, mod, mod.exports, req);
  return mod.exports;
}

function renderChipHtml(limits) {
  const modExports = loadCodexLimitsChipModule(limits);
  const Component = modExports.CodexLimitsChip;
  assert.ok(Component, 'CodexLimitsChip component must be exported');
  return ReactDOMServer.renderToStaticMarkup(React.createElement(Component, { limits }));
}

function extractTitleAttr(html) {
  const match = html.match(/title="([^"]*)"/);
  return match ? match[1] : '';
}

function extractChipBody(html) {
  // Strip out title="..." attribute to isolate visible chip labels/segments
  return html.replace(/title="[^"]*"/g, '');
}

// ─── Section A: Baseline Controls (Green) ──────────────────────────────────────

test('CONTROL: recorded app-server fixtures exist and parse credits schema', () => {
  const fixturePath = path.join(__dirname, 'fixtures', 'codex-appserver-rate-limits.json');
  assert.ok(fs.existsSync(fixturePath), 'fixture must exist');
  const raw = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const parsed = parseAppServerRateLimits(raw);
  assert.ok(parsed, 'parsed limits must be non-null');
  assert.ok(parsed.credits, 'credits must be present');
  assert.equal(parsed.credits.availableCount, 2);
  assert.equal(parsed.credits.credits.length, 2);
  assert.equal(parsed.credits.credits[0].id, 'RateLimitResetCredit_247dca61608c819188f72a83d915f73f');
  assert.equal(parsed.credits.credits[0].expiresAt, 1796069816);
});

test('CONTROL: baseline CodexLimitsChip renders basic 5h and weekly buckets without error', () => {
  const limits = {
    fiveHour: { percent: 15, windowMinutes: 300 },
    weekly: { percent: 5, windowMinutes: 10080 },
    updatedAt: Date.now()
  };
  const html = renderChipHtml(limits);
  assert.ok(html.includes('codex'), 'must render codex label');
  assert.ok(html.includes('5h 15%'), 'must render 5h bucket');
  assert.ok(html.includes('wk 5%'), 'must render wk bucket');
});

test('CONTROL: baseline CodexLimitsChip renders null when limits is null or missing buckets', () => {
  assert.equal(renderChipHtml(null), '');
  assert.equal(renderChipHtml({ updatedAt: Date.now() }), '');
});

test('CONTROL: baseline getTimings falls back to DEFAULT_TIMINGS for existing keys', () => {
  const t = getTimings({});
  assert.equal(t.workerTickMs, DEFAULT_TIMINGS.workerTickMs);
  assert.equal(t.limitPollMs, DEFAULT_TIMINGS.limitPollMs);
});

test('CONTROL: baseline LimitLockNotices deduplicates notifications by id', () => {
  const toasts = [];
  const notices = new LimitLockNotices(() => true, (title, body) => toasts.push({ title, body }));
  notices.held('agent-1', 'Elm', 'codex', 1800000000);
  assert.equal(toasts.length, 1);
  notices.held('agent-1', 'Elm', 'codex', 1800000000);
  assert.equal(toasts.length, 1, 'must dedup held notices for the same agent');
});

test('CONTROL / ITEM 1: CodexLimitsChip visibly omits reset credit count when availableCount is zero', () => {
  const limits = {
    fiveHour: { percent: 50, windowMinutes: 300 },
    updatedAt: Date.now(),
    credits: {
      availableCount: 0,
      credits: []
    }
  };
  const html = renderChipHtml(limits);
  const body = extractChipBody(html);
  assert.doesNotMatch(
    body,
    /\b0\s*(?:resets?|credits?)/i,
    `Chip body must omit 0 reset count when availableCount is 0; got: ${body}`
  );
  assert.doesNotMatch(
    body,
    /\bresets?\b|\bcredits?\b/i,
    `Chip body must not show reset label when availableCount is 0; got: ${body}`
  );
});

test('CONTROL / ITEM 1: CodexLimitsChip visibly omits reset credit count when credits is absent or undefined', () => {
  const limits = {
    fiveHour: { percent: 50, windowMinutes: 300 },
    updatedAt: Date.now()
  };
  const html = renderChipHtml(limits);
  const body = extractChipBody(html);
  assert.doesNotMatch(
    body,
    /\bresets?\b|\bcredits?\b/i,
    `Chip body must omit credit count when credits object is absent; got: ${body}`
  );
});

// ─── Section B: Proposal Step 1 / Item 1 — Chip Count & Tooltip (Red) ─────────

test('ITEM 1: CodexLimitsChip displays reset credit count when availableCount is above zero', () => {
  const limits = {
    fiveHour: { percent: 50, windowMinutes: 300 },
    weekly: { percent: 20, windowMinutes: 10080 },
    updatedAt: Date.now(),
    credits: {
      availableCount: 2,
      credits: [
        { id: 'credit-1', expiresAt: 1796069816 },
        { id: 'credit-2', expiresAt: 1796162262 }
      ]
    }
  };
  const html = renderChipHtml(limits);
  const body = extractChipBody(html);
  assert.match(
    body,
    /2\s*(?:resets?|credits?)/i,
    `Chip visible body must render available reset credit count when > 0; got: ${body}`
  );
});

test('ITEM 1: CodexLimitsChip tooltip (title) lists each credit\'s expiry', () => {
  const exp1 = 1796069816;
  const exp2 = 1796162262;
  const limits = {
    fiveHour: { percent: 50, windowMinutes: 300 },
    updatedAt: Date.now(),
    credits: {
      availableCount: 2,
      credits: [
        { id: 'credit-alpha', expiresAt: exp1 },
        { id: 'credit-beta', expiresAt: exp2 }
      ]
    }
  };
  const html = renderChipHtml(limits);
  const title = extractTitleAttr(html);

  // Both credit expiries must be presented in the tooltip
  const dateStr1 = new Date(exp1 * 1000).toLocaleDateString();
  const dateStr2 = new Date(exp2 * 1000).toLocaleDateString();

  const hasExp1 = title.includes(String(exp1)) || title.includes(dateStr1) || /credit.*expires/i.test(title);
  const hasExp2 = title.includes(String(exp2)) || title.includes(dateStr2) || /reset.*expires/i.test(title);

  assert.ok(
    hasExp1 && hasExp2,
    `Tooltip title must list each credit's expiry; got title: "${title}"`
  );
});

test('ITEM 1: CodexLimitsChip tooltip supports credits with expiry field name fallback', () => {
  const exp = 1796069816;
  const limits = {
    fiveHour: { percent: 50, windowMinutes: 300 },
    updatedAt: Date.now(),
    credits: {
      availableCount: 1,
      credits: [
        { id: 'credit-fallback', expiry: exp }
      ]
    }
  };
  const html = renderChipHtml(limits);
  const title = extractTitleAttr(html);
  const dateStr = new Date(exp * 1000).toLocaleDateString();
  assert.ok(
    title.includes(String(exp)) || title.includes(dateStr) || /expires/i.test(title),
    `Tooltip must recognize expiry fallback property on credit object; got title: "${title}"`
  );
});

// ─── Section C: Proposal Step 1 / Item 2 — Timings & Expiry Alert (Red) ────────

test('ITEM 2: TimingsConfig and DEFAULT_TIMINGS define configurable codexResetCreditAlertLeadMs', () => {
  assert.equal(
    typeof DEFAULT_TIMINGS.codexResetCreditAlertLeadMs,
    'number',
    'DEFAULT_TIMINGS must define default codexResetCreditAlertLeadMs'
  );
  assert.ok(
    DEFAULT_TIMINGS.codexResetCreditAlertLeadMs > 0,
    'codexResetCreditAlertLeadMs default must be a positive duration'
  );
});

test('ITEM 2: getTimings respects custom codexResetCreditAlertLeadMs override', () => {
  const customLeadMs = 12 * 3600_000; // 12 hours
  const t = getTimings({ timings: { codexResetCreditAlertLeadMs: customLeadMs } });
  assert.equal(
    t.codexResetCreditAlertLeadMs,
    customLeadMs,
    'getTimings must merge and honor custom codexResetCreditAlertLeadMs override'
  );
});

test('ITEM 2: CodexResetCreditNotices is exported from codexLimits.ts', () => {
  assert.equal(
    typeof codexLimitsMod.CodexResetCreditNotices,
    'function',
    'CodexResetCreditNotices class must be exported from src/main/codexLimits.ts'
  );
});

test('ITEM 2: CodexResetCreditNotices fires once within configurable lead time before soonest expiry', () => {
  const CodexResetCreditNotices = codexLimitsMod.CodexResetCreditNotices;
  assert.ok(CodexResetCreditNotices, 'CodexResetCreditNotices required');

  const alerts = [];
  const leadMs = 86_400_000; // 24 hours lead time
  const notices = new CodexResetCreditNotices(
    () => true,
    (title, body) => alerts.push({ title, body }),
    () => leadMs
  );

  const nowMs = 1_700_000_000_000;
  // Expiry is in 2 hours (well within the 24h lead window)
  const expirySec = Math.floor((nowMs + 2 * 3600_000) / 1000);
  const limits = {
    updatedAt: nowMs,
    ordinaryUsageAllowed: true,
    credits: {
      availableCount: 1,
      credits: [{ id: 'credit-soon-1', expiresAt: expirySec }]
    }
  };

  notices.check(limits, nowMs);

  assert.equal(alerts.length, 1, 'Alert must fire when credit is within lead time before expiry');
  assert.match(alerts[0].title, /codex|reset|credit/i, 'Alert title must identify Codex reset credit');
  assert.match(alerts[0].body, /expir/i, 'Alert body must describe upcoming expiry');
});

test('ITEM 2: CodexResetCreditNotices dedup: once-only alert for same credit id, no repeated alert', () => {
  const CodexResetCreditNotices = codexLimitsMod.CodexResetCreditNotices;
  assert.ok(CodexResetCreditNotices, 'CodexResetCreditNotices required');

  const alerts = [];
  const notices = new CodexResetCreditNotices(
    () => true,
    (title, body) => alerts.push({ title, body }),
    () => 86_400_000
  );

  const nowMs = 1_700_000_000_000;
  const expirySec = Math.floor((nowMs + 3600_000) / 1000);
  const limits = {
    updatedAt: nowMs,
    ordinaryUsageAllowed: true,
    credits: {
      availableCount: 1,
      credits: [{ id: 'credit-dedup-1', expiresAt: expirySec }]
    }
  };

  // First pass: fires
  notices.check(limits, nowMs);
  assert.equal(alerts.length, 1, 'First pass must fire alert');

  // Second pass with same credit id: must NOT fire again
  notices.check(limits, nowMs + 60_000);
  assert.equal(alerts.length, 1, 'Must not repeat alert for the same credit id');

  // Third pass: still deduplicated
  notices.check(limits, nowMs + 120_000);
  assert.equal(alerts.length, 1, 'Must continue to dedup repeated checks for identical credit id');
});

test('ITEM 2: CodexResetCreditNotices does not fire alert when soonest expiry is further out than lead time', () => {
  const CodexResetCreditNotices = codexLimitsMod.CodexResetCreditNotices;
  assert.ok(CodexResetCreditNotices, 'CodexResetCreditNotices required');

  const alerts = [];
  const leadMs = 86_400_000; // 24 hours
  const notices = new CodexResetCreditNotices(
    () => true,
    (title, body) => alerts.push({ title, body }),
    () => leadMs
  );

  const nowMs = 1_700_000_000_000;
  // Expiry is in 5 days (outside 24h lead time)
  const expirySec = Math.floor((nowMs + 5 * 86_400_000) / 1000);
  const limits = {
    updatedAt: nowMs,
    ordinaryUsageAllowed: true,
    credits: {
      availableCount: 1,
      credits: [{ id: 'credit-far', expiresAt: expirySec }]
    }
  };

  notices.check(limits, nowMs);
  assert.equal(alerts.length, 0, 'Must not fire alert when expiry is further out than lead time');
});

test('ITEM 2: CodexResetCreditNotices does not fire alert when credit is already expired', () => {
  const CodexResetCreditNotices = codexLimitsMod.CodexResetCreditNotices;
  assert.ok(CodexResetCreditNotices, 'CodexResetCreditNotices required');

  const alerts = [];
  const notices = new CodexResetCreditNotices(
    () => true,
    (title, body) => alerts.push({ title, body }),
    () => 86_400_000
  );

  const nowMs = 1_700_000_000_000;
  // Expiry was 1 hour ago
  const expirySec = Math.floor((nowMs - 3600_000) / 1000);
  const limits = {
    updatedAt: nowMs,
    ordinaryUsageAllowed: true,
    credits: {
      availableCount: 1,
      credits: [{ id: 'credit-expired', expiresAt: expirySec }]
    }
  };

  notices.check(limits, nowMs);
  assert.equal(alerts.length, 0, 'Must not fire alert for already-expired credit');
});

test('ITEM 2: CodexResetCreditNotices alerts on distinct new credit id when another credit approaches expiry', () => {
  const CodexResetCreditNotices = codexLimitsMod.CodexResetCreditNotices;
  assert.ok(CodexResetCreditNotices, 'CodexResetCreditNotices required');

  const alerts = [];
  const notices = new CodexResetCreditNotices(
    () => true,
    (title, body) => alerts.push({ title, body }),
    () => 86_400_000
  );

  const nowMs = 1_700_000_000_000;
  const expiry1 = Math.floor((nowMs + 3600_000) / 1000);
  const expiry2 = Math.floor((nowMs + 7200_000) / 1000);

  // Check with credit 1
  notices.check({
    ordinaryUsageAllowed: true,
    credits: { availableCount: 1, credits: [{ id: 'credit-first', expiresAt: expiry1 }] }
  }, nowMs);
  assert.equal(alerts.length, 1);

  // Check with credit 2 (different id)
  notices.check({
    ordinaryUsageAllowed: true,
    credits: { availableCount: 1, credits: [{ id: 'credit-second', expiresAt: expiry2 }] }
  }, nowMs);
  assert.equal(alerts.length, 2, 'Must fire for distinct new credit id approaching expiry');
});

test('ITEM 2: CodexResetCreditNotices suppresses notification display when notifications disabled but marks credit seen', () => {
  const CodexResetCreditNotices = codexLimitsMod.CodexResetCreditNotices;
  assert.ok(CodexResetCreditNotices, 'CodexResetCreditNotices required');

  let notificationsEnabled = false;
  const alerts = [];
  const notices = new CodexResetCreditNotices(
    () => notificationsEnabled,
    (title, body) => alerts.push({ title, body }),
    () => 86_400_000
  );

  const nowMs = 1_700_000_000_000;
  const expirySec = Math.floor((nowMs + 3600_000) / 1000);
  const limits = {
    updatedAt: nowMs,
    ordinaryUsageAllowed: true,
    credits: {
      availableCount: 1,
      credits: [{ id: 'credit-disabled-seen', expiresAt: expirySec }]
    }
  };

  // Checked while notifications are off: show callback must not be invoked
  notices.check(limits, nowMs);
  assert.equal(alerts.length, 0, 'Must not show notification when notifications setting is off');

  // User turns notifications on mid-session: previously seen credit must not suddenly pop toast
  notificationsEnabled = true;
  notices.check(limits, nowMs + 5000);
  assert.equal(alerts.length, 0, 'Enabling notifications later must not re-alert on previously evaluated credit');
});

// ─── Section D: Proposal Step 3 / Item 3 — ordinaryUsageAllowed=false (Red) ───

test('ITEM 3: CodexLimitsChip does not suggest actionable reset when ordinaryUsageAllowed is false', () => {
  const limits = {
    fiveHour: { percent: 100, windowMinutes: 300 },
    weekly: { percent: 100, windowMinutes: 10080 },
    ordinaryUsageAllowed: false,
    updatedAt: Date.now(),
    credits: {
      availableCount: 1,
      credits: [{ id: 'credit-blocked', expiresAt: 1796069816 }]
    }
  };
  const html = renderChipHtml(limits);
  const title = extractTitleAttr(html);

  // Chip must not suggest the reset can be spent or claimed
  assert.doesNotMatch(
    title,
    /claim\s*reset|spend\s*reset|actionable/i,
    'Tooltip must not suggest reset can be claimed when ordinaryUsageAllowed is false'
  );
  // Tooltip must note that ordinary usage / reset is blocked or unavailable
  assert.match(
    title,
    /blocked|ordinary\s*usage|unavailable|disabled/i,
    `Tooltip must communicate blocked status when ordinaryUsageAllowed is false; got title: "${title}"`
  );
});

test('ITEM 3: CodexResetCreditNotices suppresses actionable reset expiry alert when ordinaryUsageAllowed is false', () => {
  const CodexResetCreditNotices = codexLimitsMod.CodexResetCreditNotices;
  assert.ok(CodexResetCreditNotices, 'CodexResetCreditNotices required');

  const alerts = [];
  const notices = new CodexResetCreditNotices(
    () => true,
    (title, body) => alerts.push({ title, body }),
    () => 86_400_000
  );

  const nowMs = 1_700_000_000_000;
  const expirySec = Math.floor((nowMs + 3600_000) / 1000);
  const limits = {
    updatedAt: nowMs,
    ordinaryUsageAllowed: false, // Usage blocked by account status
    credits: {
      availableCount: 1,
      credits: [{ id: 'credit-blocked-noalert', expiresAt: expirySec }]
    }
  };

  notices.check(limits, nowMs);
  assert.equal(
    alerts.length,
    0,
    'Must never alert to claim/spend an actionable reset when ordinaryUsageAllowed is false'
  );
});

// ─── Section E: Main Wiring Coverage ──────────────────────────────────────────

test('WIRING: main limitBeat checks codexResetCreditNotices with latest codexLimits on limitPollMs beat', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/index.ts'), 'utf8');
  assert.match(
    indexSrc,
    /const\s+codexResetCreditNotices\s*=\s*new\s+CodexResetCreditNotices\(/,
    'src/main/index.ts must instantiate codexResetCreditNotices'
  );
  assert.match(
    indexSrc,
    /codexResetCreditNotices\.check\(\s*codexLimits\s*,\s*now\s*\)/,
    'src/main/index.ts limitBeat must check codexResetCreditNotices with codexLimits and now'
  );
});

