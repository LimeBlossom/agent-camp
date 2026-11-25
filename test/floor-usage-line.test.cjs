'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const vm = require('node:vm');
const fs = require('node:fs');
const ts = require('typescript');

const loadTs = require('../test-support/load-ts.cjs');
const { formatAgentUsage7d } = loadTs('src/shared/usageFormat.ts');
const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
const { startPhoneServer } = loadTs('src/main/phone.ts');

const worker = (patch = {}) => ({
  id: 'elm',
  name: 'Elm',
  status: 'working',
  provider: 'codex',
  command: 'codex',
  ptyId: 'pty-1',
  model: 'gpt-6.1-sol',
  ...patch
});

// ─── 1. formatAgentUsage7d Contract ──────────────────────────────────────────

test('formatAgentUsage7d: returns empty string for empty, undefined, or zero-token inputs', () => {
  assert.equal(formatAgentUsage7d(null), '');
  assert.equal(formatAgentUsage7d(undefined), '');
  assert.equal(formatAgentUsage7d([]), '');
  assert.equal(formatAgentUsage7d([{ engine: 'codex', totalTokens: 0 }]), '');
  assert.equal(formatAgentUsage7d([{ engine: 'codex', totalTokens: 0 }, { engine: 'agy', totalTokens: 0 }]), '');
});

test('formatAgentUsage7d: formats single engine with compact token numbers', () => {
  assert.equal(formatAgentUsage7d([{ engine: 'codex', totalTokens: 450 }]), '450 codex');
  assert.equal(formatAgentUsage7d([{ engine: 'codex', totalTokens: 1200 }]), '1.2k codex');
  assert.equal(formatAgentUsage7d([{ engine: 'codex', totalTokens: 12400 }]), '12k codex');
  assert.equal(formatAgentUsage7d([{ engine: 'codex', totalTokens: 250000 }]), '250k codex');
  assert.equal(formatAgentUsage7d([{ engine: 'agy', totalTokens: 1500000 }]), '1.5M agy');
  assert.equal(formatAgentUsage7d([{ engine: 'claude', totalTokens: 12400000 }]), '12.4M claude');
});

test('formatAgentUsage7d: formats multiple engines sorted by tokens descending joined by middle dot', () => {
  const entries = [
    { engine: 'codex', totalTokens: 250000 },
    { engine: 'agy', totalTokens: 1500000 },
    { engine: 'claude', totalTokens: 45000 }
  ];
  // 1.5M agy · 250k codex · 45k claude
  assert.equal(formatAgentUsage7d(entries), '1.5M agy · 250k codex · 45k claude');
});

test('formatAgentUsage7d: ignores zero-token entries when other engines have usage', () => {
  const entries = [
    { engine: 'codex', totalTokens: 0 },
    { engine: 'agy', totalTokens: 120000 }
  ];
  assert.equal(formatAgentUsage7d(entries), '120k agy');
});

// ─── 2. Phone Floor View Line ────────────────────────────────────────────────

function phone(initialAgents) {
  let handler, agents = initialAgents;
  const originalCreate = http.createServer, originalInterfaces = os.networkInterfaces;
  try {
    os.networkInterfaces = () => ({ tailscale0: [{ family: 'IPv4', address: '100.64.0.1', internal: false }] });
    http.createServer = (callback) => { handler = callback; return { on() {}, listen() {} }; };
    assert.ok(startPhoneServer({
      token: () => 'secret', state: () => ({ agents }), tasks: () => ({ tasks: [] }),
      patchTask: () => false, sendToGod() {}, enqueue: () => false, roots: () => []
    }));
  } finally {
    http.createServer = originalCreate;
    os.networkInterfaces = originalInterfaces;
  }
  return {
    setAgents(next) { agents = next; },
    snapshot() {
      let status, payload;
      handler({ url: '/api/state', method: 'GET', headers: { authorization: 'Bearer secret' } }, {
        writeHead(code) { status = code; }, end(raw) { payload = JSON.parse(raw); }
      });
      assert.equal(status, 200);
      return payload;
    }
  };
}

class Node {
  constructor(tag) {
    this.tagName = tag; this.childNodes = []; this.parentNode = null;
    this.dataset = {}; this.className = ''; this.attrs = {}; this.style = {};
  }
  get children() { return this.childNodes.filter((n) => n.tagName !== '#text'); }
  get lastElementChild() { return this.children.at(-1) || null; }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    this.childNodes.splice(ref ? this.childNodes.indexOf(ref) : this.childNodes.length, 0, n);
    n.parentNode = this; return n;
  }
  removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; }
  set textContent(value) { this.childNodes = []; if (value) this.appendChild(text(value)); }
  get textContent() { return this.tagName === '#text' ? this.data : this.childNodes.map((n) => n.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = v; }
  getAttribute(k) { return this.attrs[k]; }
  all(pred) { return this.childNodes.flatMap((n) => [...(pred(n) ? [n] : []), ...n.all(pred)]); }
}
function text(value) { const n = new Node('#text'); n.data = String(value); return n; }
const tick = () => new Promise((resolve) => setImmediate(resolve));
const hasClass = (node, cls) => node.className.split(/\s+/).includes(cls);

async function page(server) {
  const body = new Node('BODY'), ids = {};
  for (const match of PHONE_PAGE.matchAll(/<(\w+)[^>]*\bid="([^"]+)"[^>]*>/g)) {
    ids[match[2]] = body.appendChild(new Node(match[1].toUpperCase()));
  }
  for (const match of PHONE_PAGE.matchAll(/<button\b[^>]*data-tab="([^"]+)"[^>]*>/g)) {
    const b = ids.nav.appendChild(new Node('BUTTON')); b.dataset.tab = match[1];
  }
  let timer;
  vm.runInNewContext(PHONE_PAGE.split('<script>')[1].split('</script>')[0], {
    document: {
      hidden: false, activeElement: null,
      createElement: (tag) => new Node(tag.toUpperCase()), createTextNode: text,
      getElementById: (id) => ids[id] || null, addEventListener() {},
      querySelectorAll: (sel) => sel === 'nav button' ? ids.nav.children : body.all((n) =>
        sel.startsWith('.') ? hasClass(n, sel.slice(1)) : n.tagName === sel.toUpperCase())
    },
    location: { hash: '#secret', pathname: '/', search: '' }, history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { scrollY: 0, scrollTo() {} }, URLSearchParams,
    fetch: async () => ({ status: 200, json: async () => server.snapshot() }),
    setInterval(fn) { timer = fn; }
  });
  await tick(); await tick();
  return {
    card(name) {
      const label = ids.main.all((n) => hasClass(n, 'name') && n.textContent.includes(name))[0];
      assert.ok(label, `floor must show ${name}`);
      let card = label.parentNode;
      while (card && !hasClass(card, 'card')) card = card.parentNode;
      assert.ok(card, `name must belong to an agent card; got ${card?.tagName}`);
      return card;
    },
    async poll() { timer(); await tick(); await tick(); }
  };
}

test('phone floor: renders each agent 7-day tokens per engine line on its card', async () => {
  const server = phone([
    worker({
      id: 'elm',
      name: 'Elm',
      usage7dLine: '1.5M agy · 250k codex'
    }),
    worker({
      id: 'quince',
      name: 'Quince',
      usage7dLine: '45k claude'
    }),
    worker({
      id: 'idle-one',
      name: 'Pawn',
      usage7dLine: undefined
    })
  ]);

  const p = await page(server);
  const elmCard = p.card('Elm');
  const quinceCard = p.card('Quince');
  const pawnCard = p.card('Pawn');

  assert.ok(
    elmCard.textContent.includes('1.5M agy · 250k codex'),
    `Elm card must render 7-day tokens per engine line; got ${JSON.stringify(elmCard.textContent)}`
  );
  assert.ok(
    quinceCard.textContent.includes('45k claude'),
    `Quince card must render 7-day tokens per engine line; got ${JSON.stringify(quinceCard.textContent)}`
  );
  assert.ok(
    !pawnCard.textContent.includes('7d') && !pawnCard.textContent.includes('codex') && !pawnCard.textContent.includes('agy'),
    'Agent with no recorded usage must not show an empty or stale usage line'
  );
});

test('phone floor: updates 7-day tokens per engine line on poll when usage changes', async () => {
  const server = phone([
    worker({ id: 'elm', name: 'Elm', usage7dLine: '12k codex' })
  ]);
  const p = await page(server);
  assert.ok(p.card('Elm').textContent.includes('12k codex'));

  server.setAgents([
    worker({ id: 'elm', name: 'Elm', usage7dLine: '150k codex · 50k agy' })
  ]);
  await p.poll();

  const text = p.card('Elm').textContent;
  assert.ok(text.includes('150k codex · 50k agy'), `must reflect updated tokens; got ${JSON.stringify(text)}`);
  assert.ok(!text.includes('12k codex'), 'stale token line must disappear');
});
