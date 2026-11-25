'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

const {
  parseReportMarkdown,
  listFeedbackReports,
  dismissFeedbackReport,
  saveFeedbackNote,
  createFeedbackCardPayload
} = loadTs('src/shared/feedbackBoard.ts');
const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
const { startPhoneServer } = loadTs('src/main/phone.ts');

const SAMPLE_REPORT_MD = `# Bug ***

- **Timestamp**: 2026-10-26T01:23:45.678000+00:00
- **Scene**: Village
- **Run**: 42
- **Seed**: 987654321
- **Version**: 0.4.6

## Description
The ladder in Village collides with player character and locks movement.

## Attachments
- screenshot.png
- recent.log
`;

test('parseReportMarkdown extracts title, description, timestamp, and metadata fields', () => {
  const report = parseReportMarkdown(SAMPLE_REPORT_MD, '1298765432109876543', 'Alpha');
  assert.equal(report.id, '1298765432109876543');
  assert.equal(report.game, 'Alpha');
  assert.equal(report.title, 'Bug ***');
  assert.equal(report.scene, 'Village');
  assert.equal(report.run, '42');
  assert.equal(report.seed, '987654321');
  assert.equal(report.version, '0.4.6');
  assert.equal(report.time, '2026-10-26T01:23:45.678000+00:00');
  assert.equal(report.text, 'The ladder in Village collides with player character and locks movement.');
});

test('listFeedbackReports discovers reports in game folders and detects attachments and handled state', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-feedback-test-'));
  try {
    const alphaDir = path.join(tmpDir, 'alpha');
    const rep1Dir = path.join(alphaDir, '1298765432109876543');
    fs.mkdirSync(rep1Dir, { recursive: true });
    fs.writeFileSync(path.join(rep1Dir, 'report.md'), SAMPLE_REPORT_MD, 'utf8');
    fs.writeFileSync(path.join(rep1Dir, 'screenshot.png'), Buffer.from('fake-png'));
    fs.writeFileSync(path.join(rep1Dir, 'recent.log'), 'recent log text', 'utf8');

    // Handled report
    const rep2Dir = path.join(alphaDir, 'handled_report');
    fs.mkdirSync(rep2Dir, { recursive: true });
    fs.writeFileSync(path.join(rep2Dir, 'report.md'), SAMPLE_REPORT_MD, 'utf8');
    fs.writeFileSync(path.join(rep2Dir, '.handled'), JSON.stringify({ handledAt: '2026-10-26T01:25:00Z' }), 'utf8');

    const reports = listFeedbackReports(tmpDir);
    assert.equal(reports.length, 1, 'Should only return unhandled active reports');
    assert.equal(reports[0].id, '1298765432109876543');
    assert.equal(reports[0].game.toUpperCase(), 'ALPHA');
    assert.ok(reports[0].screenshotPath && reports[0].screenshotPath.endsWith('screenshot.png'));
    assert.ok(reports[0].logPath && reports[0].logPath.endsWith('recent.log'));
    assert.equal(reports[0].handled, false);
  } finally {
    rmTree(tmpDir);
  }
});

test('dismissFeedbackReport writes .handled marker so report is ignored', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-feedback-dismiss-'));
  try {
    const repDir = path.join(tmpDir, 'alpha', '1298765432109876543');
    fs.mkdirSync(repDir, { recursive: true });
    fs.writeFileSync(path.join(repDir, 'report.md'), SAMPLE_REPORT_MD, 'utf8');

    const ok = dismissFeedbackReport(repDir);
    assert.equal(ok, true, 'dismissFeedbackReport should succeed');

    const reports = listFeedbackReports(tmpDir);
    assert.equal(reports.length, 0, 'Dismissed report must not appear in active reports list');
  } finally {
    rmTree(tmpDir);
  }
});

test('createFeedbackCardPayload constructs task card referencing report folder and summary', () => {
  const report = {
    id: '1298765432109876543',
    game: 'Alpha',
    title: 'Bug ***',
    text: 'The ladder in Village collides with player character and locks movement.',
    scene: 'Village',
    run: '42',
    seed: '987654321',
    version: '0.4.6',
    time: '2026-10-26T01:23:45.678000+00:00',
    screenshotPath: 'hive/feedback/alpha/1298765432109876543/screenshot.png',
    logPath: 'hive/feedback/alpha/1298765432109876543/recent.log'
  };

  const payload = createFeedbackCardPayload(report, 'quince-mvnvoaig');
  assert.equal(payload.project, 'Alpha');
  assert.equal(payload.assignee, 'quince-mvnvoaig');
  assert.equal(payload.status, 'todo');
  assert.ok(payload.title.includes('Bug ***'), 'Card title must include report title');
  assert.ok(payload.description.includes('hive/feedback/alpha/1298765432109876543'), 'Description must cite report folder');
  assert.ok(payload.description.includes('The ladder in Village collides'), 'Description must cite report text');
});

test('phonePage includes feedback navigation tab and badge', () => {
  assert.match(PHONE_PAGE, /data-tab="feedback"/, 'Phone page must have a feedback tab button');
  assert.match(PHONE_PAGE, /id="feedbackBadge"/, 'Phone page must have a feedback badge span');
});

// ── Point 1: Own desktop tab, badge, and removed from ASK ME ─────────────────

test('desktop AskMeTab does not contain FeedbackPanel', () => {
  const askMeTabSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/AskMeTab.tsx'), 'utf8');
  assert.doesNotMatch(askMeTabSrc, /<FeedbackPanel\s*\/>/, 'FeedbackPanel must be removed from AskMeTab');
  assert.doesNotMatch(askMeTabSrc, /import\s+{[^}]*FeedbackPanel[^}]*}\s+from/, 'AskMeTab should not import FeedbackPanel');
});

test('CommandCenterPanel defines a dedicated top-level feedback tab with unread badge and localized label', () => {
  const ccSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/CommandCenterPanel.tsx'), 'utf8');
  assert.match(ccSrc, /type\s+CCTab\s*=[^;]*'feedback'/, 'CCTab union must include feedback');
  assert.match(ccSrc, /key:\s*'feedback'/, 'TABS list must register feedback tab');
  assert.match(ccSrc, /tab\s*===\s*'feedback'\s*&&\s*<FeedbackPanel\s*\/>/, 'CommandCenterPanel must render FeedbackPanel for feedback tab');
  assert.match(ccSrc, /feedback.*badge|feedbackCount/i, 'Feedback tab button must display an unread/new badge when feedback reports exist');

  const enJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/i18n/locales/en.json'), 'utf8'));
  assert.ok(enJson.commandCenter?.tabs?.feedback, 'en.json must have commandCenter.tabs.feedback label');
});

// ── Point 2: Agent picker lists all floor agents including dormant ones ───────

test('desktop FeedbackPanel agent picker includes dormant floor agents alongside Boss decides', () => {
  const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/FeedbackPanel.tsx'), 'utf8');
  assert.match(panelSrc, /restorableAgents|fleet/, 'FeedbackPanel must read restorable/dormant floor agents');
  assert.doesNotMatch(panelSrc, /const\s+agents\s*=\s*useStore\(\(s\)\s*=>\s*s\.agents\);\s*\n\s*const\s*\[items/,
    'FeedbackPanel must not source agents exclusively from live s.agents');
});

test('phone view snapshot and picker include dormant floor agents', () => {
  assert.match(PHONE_PAGE, /data\.agents|\.agents/, 'Phone page must populate agents into dropdown');
  const phoneSrc = fs.readFileSync(path.join(__dirname, '..', 'src/main/phone.ts'), 'utf8');
  assert.match(phoneSrc, /restorableAgents|fleet/i, 'phone.ts snapshot must include dormant floor agents (restorableAgents or fleet) for the agent picker');
});

// ── Point 3: the human note box, survival on reload, card the human says line ───────────

test('desktop FeedbackPanel and phone feedbackCard provide a text box for the human thoughts / what to do', () => {
  const panelSrc = fs.readFileSync(path.join(__dirname, '..', 'src/renderer/src/components/FeedbackPanel.tsx'), 'utf8');
  assert.match(panelSrc, /<textarea|<input[^>]+type=['"]text['"]/, 'Desktop FeedbackPanel must render a text box for the human thoughts');

  assert.match(PHONE_PAGE, /textarea|placeholder.*thoughts|fb-note/i, 'Phone feedback card must render a text box for the human thoughts');
});

test('saveFeedbackNote persists the human thoughts to report folder and survives reload via listFeedbackReports', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-feedback-note-'));
  try {
    const alphaDir = path.join(tmpDir, 'alpha');
    const repDir = path.join(alphaDir, '1298765432109876543');
    fs.mkdirSync(repDir, { recursive: true });
    fs.writeFileSync(path.join(repDir, 'report.md'), SAMPLE_REPORT_MD, 'utf8');

    const ok = saveFeedbackNote(repDir, 'Check village ladder bounds and disable physics on climb.');
    assert.equal(ok, true, 'saveFeedbackNote should return true on success');

    const reports = listFeedbackReports(tmpDir);
    assert.equal(reports.length, 1);
    assert.equal(reports[0].note, 'Check village ladder bounds and disable physics on climb.', 'Saved note must be loaded with report so it survives reload');
  } finally {
    rmTree(tmpDir);
  }
});

test('createFeedbackCardPayload includes the human thoughts under a "The human says:" line', () => {
  const report = {
    id: '1298765432109876543',
    game: 'Alpha',
    title: 'Bug ***',
    text: 'The ladder in Village collides with player character and locks movement.',
    scene: 'Village',
    run: '42',
    seed: '987654321',
    version: '0.4.6',
    time: '2026-10-26T01:23:45.678000+00:00',
    screenshotPath: 'hive/feedback/alpha/1298765432109876543/screenshot.png',
    logPath: 'hive/feedback/alpha/1298765432109876543/recent.log'
  };

  const payloadWithNote = createFeedbackCardPayload(report, 'quince-mvnvoaig', 'Check ladder collider in village');
  assert.equal(payloadWithNote.assignee, 'quince-mvnvoaig');
  assert.match(payloadWithNote.description, /The human says:\s*\n.*Check ladder collider in village/,
    'Description must contain the human says: followed by the human note');

  const payloadWithoutNote = createFeedbackCardPayload(report, 'quince-mvnvoaig');
  assert.doesNotMatch(payloadWithoutNote.description, /The human says:/,
    'Description must not contain the human says: when no note provided');
});

test('Boss decides with the human text creates card for the Boss with the human says line in description', () => {
  const report = {
    id: '1298765432109876543',
    game: 'Alpha',
    title: 'Bug ***',
    text: 'The ladder in Village collides with player character and locks movement.'
  };

  const payload = createFeedbackCardPayload(report, 'boss', 'Boss please triage this collision');
  assert.equal(payload.assignee, 'boss', 'Assignee should be boss');
  assert.match(payload.description, /The human says:\s*\n.*Boss please triage this collision/,
    'Card for Boss must include the human says line with the human text');
});

