'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const vm = require('node:vm');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');
const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
const { startPhoneServer } = loadTs('src/main/phone.ts');

const worker = (patch = {}) => ({
  id: 'elm', name: 'Elm', status: 'working', provider: 'codex',
  command: 'codex', ptyId: 'pty-1', model: 'gpt-6-sol', liveModel: 'gpt-6.1-sol', ...patch,
});

// Exercise the real state projection without binding the production phone port.
function phone(initialAgents) {
  let handler, agents = initialAgents;
  const originalCreate = http.createServer, originalInterfaces = os.networkInterfaces;
  try {
    os.networkInterfaces = () => ({ tailscale0: [{ family: 'IPv4', address: '100.64.0.1', internal: false }] });
    http.createServer = (callback) => { handler = callback; return { on() {}, listen() {} }; };
    assert.ok(startPhoneServer({
      token: () => 'secret', state: () => ({ agents }), tasks: () => ({ tasks: [] }),
      patchTask: () => false, sendToGod() {}, enqueue: () => false, roots: () => [],
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
        writeHead(code) { status = code; }, end(raw) { payload = JSON.parse(raw); },
      });
      assert.equal(status, 200);
      return payload;
    },
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
        sel.startsWith('.') ? hasClass(n, sel.slice(1)) : n.tagName === sel.toUpperCase()),
    },
    location: { hash: '#secret', pathname: '/', search: '' }, history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { scrollY: 0, scrollTo() {} }, URLSearchParams,
    fetch: async () => ({ status: 200, json: async () => server.snapshot() }),
    setInterval(fn) { timer = fn; },
  });
  await tick(); await tick();
  return {
    row(name) {
      const label = ids.main.all((n) => hasClass(n, 'name') && n.textContent === name)[0];
      assert.ok(label, `floor must show ${name}`);
      let row = label.parentNode;
      while (row && !hasClass(row, 'row')) row = row.parentNode;
      assert.ok(row, 'name must belong to an agent header row');
      return row;
    },
    async poll() { timer(); await tick(); await tick(); },
  };
}

function expectModel(row, model) {
  assert.ok(row.textContent.includes(model), `model ${model} must render beside the name; got ${JSON.stringify(row.textContent)}`);
  assert.ok(row.textContent.indexOf(model) > row.textContent.indexOf('Elm'), 'model must follow the agent name');
  assert.ok(row.all((n) => hasClass(n, 'status') && n.textContent === 'working').length, 'status must remain in the row');
}

test('phone floor shows each current live model beside its agent name, ahead of configured model', async () => {
  const p = await page(phone([
    worker(), worker({ id: 'other', name: 'Teak', liveModel: 'gpt-6-astra' }),
  ]));
  expectModel(p.row('Elm'), 'gpt-6.1-sol');
  assert.ok(p.row('Teak').textContent.includes('gpt-6-astra'), 'second agent must show its own model');
  assert.ok(!p.row('Elm').textContent.includes('gpt-6-sol'), 'configured model must not replace the live model');
});

test('phone floor falls back to the configured model when no live model is reported', async () => {
  const p = await page(phone([worker({ liveModel: undefined })]));
  expectModel(p.row('Elm'), 'gpt-6-sol');
});

test('phone floor leaves no model placeholder or separator when no model is reported', async () => {
  for (const absent of [undefined, null, '']) {
    const p = await page(phone([worker({ liveModel: absent, model: absent })]));
    assert.equal(p.row('Elm').textContent.replace(/\s+/g, ''), 'Elmworking',
      'missing model must not add default, undefined, null, provider-only labels or punctuation');
  }
});

test('phone floor updates the model on polling and removes it when no longer reported', async () => {
  const server = phone([worker()]), p = await page(server);
  expectModel(p.row('Elm'), 'gpt-6.1-sol');
  server.setAgents([worker({ liveModel: 'gpt-6-astra' })]);
  await p.poll();
  expectModel(p.row('Elm'), 'gpt-6-astra');
  assert.ok(!p.row('Elm').textContent.includes('gpt-6.1-sol'), 'old model must disappear');
  server.setAgents([worker({ model: undefined, liveModel: undefined })]);
  await p.poll();
  assert.equal(p.row('Elm').textContent.replace(/\s+/g, ''), 'Elmworking');
});

// The VM DOM above cannot measure layout. Use an installed browser for this assertion;
// PHONE_TEST_BROWSER can select Chrome/Chromium on machines without these Linux paths.
const browser = process.env.PHONE_TEST_BROWSER || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) => fs.existsSync(p));
test('long model ID keeps name and status inside the phone row at narrow widths', { skip: !browser && 'Chrome/Chromium unavailable; set PHONE_TEST_BROWSER' }, async () => {
  const model = 'gpt-' + 'long-model-identifier-'.repeat(16);
  const state = phone([worker({ liveModel: model })]).snapshot();
  const probe = `
    setTimeout(function () {
      var name = document.querySelector('main .name');
      var row = name && name.closest('.row');
      var status = row && row.querySelector('.status');
      var rect = row && row.getBoundingClientRect();
      var s = status && status.getBoundingClientRect();
      var n = name && name.getBoundingClientRect();
      var result = {
        viewport: innerWidth,
        modelPresent: !!row && row.textContent.includes(${JSON.stringify(model)}),
        pageFits: document.documentElement.scrollWidth <= innerWidth,
        rowFits: !!rect && rect.left >= 0 && rect.right <= innerWidth,
        nameFits: !!n && n.width > 0 && n.left >= rect.left && n.right <= rect.right + 1,
        statusFits: !!s && s.width > 0 && s.left >= rect.left && s.right <= rect.right + 1 && s.top >= rect.top && s.bottom <= rect.bottom + 1,
        noOverlap: !!n && !!s && (n.right <= s.left || n.bottom <= s.top || s.bottom <= n.top)
      };
      parent.postMessage(result, '*');
    }, 100);
  `;
  const html = PHONE_PAGE.replace('<script>', `<script>window.fetch = async function () { return { status: 200, json: async function () { return ${JSON.stringify(state)}; } }; };</script><script>`)
    .replace('</body>', `<script>${probe}</script></body>`);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url.startsWith('/phone')) return res.end(html);
    const width = Number(new URL(req.url, 'http://localhost').searchParams.get('width'));
    res.end(`<script>addEventListener('message', function (ev) {
      var out = document.createElement('pre'); out.id = 'geometry';
      out.textContent = JSON.stringify(ev.data); document.body.appendChild(out);
    });</script><iframe style="border:0;width:${width}px;height:844px" src="/phone#secret"></iframe>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const width of [320, 390]) {
      const output = await new Promise((resolve, reject) => {
        const child = spawn(browser, ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run',
          '--disable-background-networking', '--disable-component-update', '--disable-extensions',
          '--dump-dom', '--virtual-time-budget=1000', '--window-size=800,1000',
          `http://127.0.0.1:${server.address().port}/?width=${width}`]);
        let stdout = '', stderr = '';
        const timeout = setTimeout(() => { child.kill(); reject(new Error('browser timed out after 60 seconds')); }, 60000);
        child.stdout.on('data', (s) => { stdout += s; });
        child.stderr.on('data', (s) => { stderr += s; });
        child.on('error', (err) => { clearTimeout(timeout); reject(err); });
        child.on('close', (code) => { clearTimeout(timeout); code === 0 ? resolve(stdout) : reject(new Error(`browser exit ${code}: ${stderr}`)); });
      });
      const match = output.match(/<pre id="geometry">([^<]+)<\/pre>/);
      assert.ok(match, 'browser must report layout measurements');
      const result = JSON.parse(match[1]);
      assert.equal(result.viewport, width, 'layout must use the requested phone viewport');
      assert.equal(result.modelPresent, true, `${width}px: long model must render in the name row`);
      for (const key of ['pageFits', 'rowFits', 'nameFits', 'statusFits', 'noOverlap']) {
        assert.equal(result[key], true, `${width}px: ${key}; ${JSON.stringify(result)}`);
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
