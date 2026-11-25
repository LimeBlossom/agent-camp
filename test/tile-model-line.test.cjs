'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const ts = require('typescript');
const React = require('react');
const ReactDOMServer = require('react-dom/server');
const loadTs = require('../test-support/load-ts.cjs');

const { tileModelLine } = loadTs('src/shared/modelLabel.ts');
const { sessionModel } = loadTs('src/shared/liveModel.ts');

test('tile model line: a live session shows its model display name only', () => {
  assert.equal(tileModelLine('pty-1', 'claude-opus-5-5'), 'Opus 5.5');
  assert.equal(tileModelLine('pty-1', 'claude-opus-5-5[1m]'), 'Opus 5.5', 'the context-window suffix is not part of the name');
  assert.equal(tileModelLine('pty-1', 'claude-sonnet-5-5-20261001'), 'Sonnet 5.5');
  assert.equal(tileModelLine('pty-1', 'gpt-6.2-sol'), 'gpt-6.2-sol');
  assert.equal(tileModelLine('pty-1', 'Claude Opus 4.6 (Thinking)'), 'Opus 4.6 Thinking');
});

test('tile model line: blank with no session or no model', () => {
  assert.equal(tileModelLine(undefined, 'claude-opus-5-5'), '', 'dormant / between cards: no PTY');
  assert.equal(tileModelLine('pty-1', undefined), '', 'session up but no model known yet');
  assert.equal(tileModelLine('pty-1', '  '), '');
});

test('session model: the log wins, else the model the harness launched, else none', () => {
  assert.equal(sessionModel('claude-sonnet-5-5', 'claude-opus-5-5'), 'claude-sonnet-5-5');
  assert.equal(sessionModel(null, 'Claude Opus 4.6 (Thinking)'), 'Claude Opus 4.6 (Thinking)', 'agy keeps no log: launched model');
  assert.equal(sessionModel(null, undefined), null);
  assert.equal(sessionModel(null, '  '), null);
});

function loadAgentCard() {
  const code = fs.readFileSync('src/renderer/src/components/AgentCard.tsx', 'utf8');
  const out = ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, esModuleInterop: true }
  }).outputText;
  const mod = { exports: {} };
  const req = (name) => {
    if (name === 'react') return React;
    if (name === 'react-i18next') return { useTranslation: () => ({ t: (k) => k }) };
    if (name === './PixelBadge') return { PixelBadge: () => null };
    if (name === './SpritePortrait') return { SpritePortrait: () => null };
    if (name === './AgentNameEditor') return { AgentNameEditor: () => null };
    if (name === './PixelPanel') return { PixelPanel: ({ children }) => React.createElement('div', null, children) };
    if (name === './RealtimeMichaelToggle') return { RealtimeMichaelToggle: () => null };
    if (name.includes('CostHud')) return { CostHud: () => null };
    if (name === './terminalPool') return { useHasTerminalDraft: () => false };
    if (name === './agentCurrentCard') return loadTs('src/renderer/src/components/agentCurrentCard.ts');
    if (name === '@/store/store') return { useStore: () => ({}) };
    return {};
  };
  new Function('React', 'module', 'exports', 'require', out)(React, mod, mod.exports, req);
  return mod.exports.AgentCard;
}

const base = { name: 'Fir', character: 'fir', accent: 'red', status: 'idle', project: 'Vault', description: 'Vault Keeper' };

test('agent tile: sub-line is the model, and the token count is gone from it', () => {
  const AgentCard = loadAgentCard();
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(AgentCard, {
    ...base, ptyId: 'pty-1', modelLabel: 'Opus 5.5', usage7dLine: '11.5M claude · 2M codex'
  }));
  assert.ok(html.includes('>Opus 5.5<'), html);
  assert.ok(!html.includes('11.5M'), `token count must not render on the tile; got ${html}`);
  assert.ok(!html.includes('Claude ·'), 'no provider prefix on the tile line');
});

test('agent tile: blank model line between cards', () => {
  const AgentCard = loadAgentCard();
  const html = ReactDOMServer.renderToStaticMarkup(React.createElement(AgentCard, {
    ...base, modelLabel: '', usage7dLine: '11.5M claude'
  }));
  assert.ok(!html.includes('11.5M') && !html.includes('Opus') && !html.includes('claude'), html);
});

test('agent strip: tile gets the live-session line; tokens move to the hover', () => {
  const src = fs.readFileSync('src/renderer/src/components/AgentStrip.tsx', 'utf8');
  assert.match(src, /modelLabel=\{tileModelLine\(a\.ptyId, a\.liveModel\)\}/);
  assert.doesNotMatch(src, /usage7dLine=\{/, 'the card no longer takes the token line');
  assert.match(src, /title=\{[^\n]*usage7d\[a\.id\]/, 'the 7-day tokens stay on the tile hover');
});
