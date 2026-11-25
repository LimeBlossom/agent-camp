'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const loadTs = require('../test-support/load-ts.cjs');

const {
  formatDurationCompact,
  formatClaudeLimits,
  formatCodexLimits,
  formatAgyQuota,
  formatAllLimits,
} = loadTs('src/shared/engineLimits.ts');

const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
const SCRIPT = PHONE_PAGE.slice(PHONE_PAGE.indexOf('<script>') + 8, PHONE_PAGE.indexOf('</script>'));

test('formatDurationCompact formats spans concisely', () => {
  assert.equal(formatDurationCompact(0), '');
  assert.equal(formatDurationCompact(-1000), '');
  assert.equal(formatDurationCompact(45 * 60_000), '45m');
  assert.equal(formatDurationCompact((2 * 60 + 10) * 60_000), '2h 10m');
  assert.equal(formatDurationCompact((3 * 24 + 4) * 60 * 60_000), '3d 4h');
});

test('formatClaudeLimits formats 5h and 7d buckets with resets', () => {
  const now = 1_700_000_000_000;
  const limits = {
    fiveHour: { percent: 22.4, resetsAt: Math.floor((now + 130 * 60_000) / 1000) }, // in 2h 10m
    sevenDay: { percent: 48.8, resetsAt: Math.floor((now + (3 * 24 + 4) * 60 * 60_000) / 1000) }, // in 3d 4h
    updatedAt: now,
  };
  const res = formatClaudeLimits(limits, now);
  assert.deepEqual(res, {
    id: 'claude',
    label: 'claude',
    segments: [
      { label: '5h', percent: 22, reset: '2h 10m' },
      { label: 'wk', percent: 49, reset: '3d 4h' },
    ],
  });

  // Omits reset when resetsAt is missing
  assert.deepEqual(formatClaudeLimits({ fiveHour: { percent: 10 } }, now), {
    id: 'claude',
    label: 'claude',
    segments: [{ label: '5h', percent: 10 }],
  });

  assert.equal(formatClaudeLimits(null), null);
  assert.equal(formatClaudeLimits({}), null);
});

test('formatCodexLimits formats 5h and weekly buckets', () => {
  const now = 1_700_000_000_000;
  const limits = {
    fiveHour: { percent: 4, resetsAt: Math.floor((now + 70 * 60_000) / 1000), windowMinutes: 300 },
    weekly: { percent: 2, resetsAt: Math.floor((now + (6 * 24 + 4) * 60 * 60_000) / 1000), windowMinutes: 10080 },
    updatedAt: now,
  };
  const res = formatCodexLimits(limits, now);
  assert.deepEqual(res, {
    id: 'codex',
    label: 'codex',
    segments: [
      { label: '5h', percent: 4, reset: '1h 10m' },
      { label: 'wk', percent: 2, reset: '6d 4h' },
    ],
  });

  // Reset flag clears reset duration
  assert.deepEqual(formatCodexLimits({ fiveHour: { percent: 0, reset: true, windowMinutes: 300 } }, now), {
    id: 'codex',
    label: 'codex',
    segments: [{ label: '5h', percent: 0 }],
  });

  assert.equal(formatCodexLimits(null), null);
});

test('formatAgyQuota formats multi-pool quotas and converts remaining to used', () => {
  const now = 1_700_000_000_000;
  const quota = {
    at: now,
    pools: [
      {
        name: 'Gemini',
        label: 'gem',
        fiveHour: { remaining: 100, note: 'Quota available' },
        weekly: { remaining: 81, note: 'Refreshes in 39h 47m' },
      },
      {
        name: 'Claude',
        label: 'claude',
        fiveHour: { remaining: 0, note: 'Refreshes in 4h 18m' },
        weekly: { remaining: 61, note: 'Refreshes in 6d 14h' },
      },
      {
        name: 'Argon',
        label: 'argon',
        weekly: { remaining: 0, note: 'Refreshes in 2d 2h' },
      },
    ],
  };

  const res = formatAgyQuota(quota, now);
  assert.deepEqual(res, {
    id: 'agy',
    label: 'agy',
    pools: [
      {
        label: 'gem',
        segments: [
          { label: '5h', percent: 0 },
          { label: 'wk', percent: 19, reset: '1d 15h' },
        ],
      },
      {
        label: 'claude',
        segments: [
          { label: '5h', percent: 100, reset: '4h 18m' },
          { label: 'wk', percent: 39, reset: '6d 14h' },
        ],
      },
      {
        label: 'argon',
        segments: [
          { label: 'wk', percent: 100, reset: '2d 2h' },
        ],
      },
    ],
  });

  assert.equal(formatAgyQuota(null), null);
  assert.equal(formatAgyQuota({ at: now, pools: [] }), null);
});

test('formatAllLimits aggregates claude, codex, and agy limits', () => {
  const all = formatAllLimits({
    claude: { fiveHour: { percent: 15 } },
    codex: { fiveHour: { percent: 25, windowMinutes: 300 } },
    agy: null,
  });
  assert.equal(all.length, 2);
  assert.equal(all[0].id, 'claude');
  assert.equal(all[1].id, 'codex');
});

// DOM mock for testing phonePage script
class Node {
  constructor(tag) {
    this.tagName = tag;
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this.className = '';
    this.attrs = {};
    this.style = {};
  }
  get children() { return this.childNodes.filter((n) => n.tagName !== '#text'); }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  appendChild(n) { return this.insertBefore(n, null); }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    this.childNodes.splice(i, 0, n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    const idx = this.childNodes.indexOf(n);
    if (idx >= 0) this.childNodes.splice(idx, 1);
    n.parentNode = null;
    return n;
  }
  set textContent(t) {
    this.childNodes.forEach((n) => { n.parentNode = null; });
    this.childNodes = [];
    if (t) this.appendChild(text(t));
  }
  get textContent() {
    return this.tagName === '#text' ? this.data : this.childNodes.map((n) => n.textContent).join('');
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  focus() {}
  setSelectionRange() {}
  closest(tag) { let n = this; while (n && n.tagName !== tag.toUpperCase()) n = n.parentNode; return n; }
  all(pred, acc = []) {
    this.childNodes.forEach((c) => { if (pred(c)) acc.push(c); c.all(pred, acc); });
    return acc;
  }
}
function text(t) { const n = new Node('#text'); n.data = String(t); return n; }

function createPage(states) {
  const body = new Node('BODY');
  const byId = {};
  for (const id of ['stamp', 'main', 'askBadge']) {
    byId[id] = body.appendChild(new Node(id === 'main' ? 'MAIN' : 'SPAN'));
  }
  const nav = byId.nav = body.appendChild(new Node('NAV'));
  for (const t of ['floor', 'ask', 'tasks']) {
    const b = nav.appendChild(new Node('BUTTON'));
    b.dataset.tab = t;
  }
  let polls = 0, timer = null;
  const document = {
    hidden: false, activeElement: null,
    createElement: (tag) => new Node(tag.toUpperCase()),
    createTextNode: text,
    getElementById: (id) => byId[id],
    querySelectorAll: (sel) => body.all((n) => n.tagName === (sel === 'nav button' ? 'BUTTON' : sel.toUpperCase())),
    addEventListener() {},
  };
  const ctx = {
    document,
    location: { hash: '#tok', pathname: '/' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { scrollY: 0, scrollTo() {} },
    fetch: () => Promise.resolve({
      status: 200,
      json: () => Promise.resolve(states[Math.min(polls++, states.length - 1)]),
    }),
    setInterval(fn) { timer = fn; },
    Date, JSON, Object, Array, String,
  };
  vm.runInNewContext(SCRIPT, ctx);
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    main: byId.main,
    async poll() { timer(); await tick(); await tick(); },
    tab(t) { nav.onclick({ target: { closest: () => nav.children.find((b) => b.dataset.tab === t) } }); },
    limitsWrap: () => byId.main.all((n) => n.className && n.className.includes('limits'))[0] || null,
    chips: () => byId.main.all((n) => n.className && n.className.includes('lchip')),
  };
}

test('phone page renders usage limits on floor tab with correct color classes', async () => {
  const sampleLimits = [
    {
      id: 'claude',
      label: 'claude',
      segments: [
        { label: '5h', percent: 22, reset: '2h 10m' },
        { label: 'wk', percent: 49, reset: '3d 4h' },
      ],
    },
    {
      id: 'codex',
      label: 'codex',
      segments: [
        { label: '5h', percent: 80, reset: '1h 10m' },
        { label: 'wk', percent: 2, reset: '6d 4h' },
      ],
    },
    {
      id: 'agy',
      label: 'agy',
      pools: [
        {
          label: 'gem',
          segments: [
            { label: '5h', percent: 0 },
            { label: 'wk', percent: 19, reset: '39h 47m' },
          ],
        },
        {
          label: 'claude',
          segments: [
            { label: '5h', percent: 100, reset: '4h 18m' },
            { label: 'wk', percent: 39, reset: '6d 14h' },
          ],
        },
        {
          label: 'argon',
          segments: [
            { label: 'wk', percent: 95, reset: '2d 2h' },
          ],
        },
      ],
    },
  ];

  const state1 = {
    live: true, asks: [], board: [],
    agents: [{ id: 'a1', name: 'Maple', status: 'idle', isGod: true }],
    limits: sampleLimits,
  };

  const p = createPage([state1]);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  const wrap = p.limitsWrap();
  assert.ok(wrap, 'limits container rendered at top of floor');
  const chips = p.chips();
  assert.equal(chips.length, 3, 'renders 3 chips for claude, codex, agy');

  // Verify Claude chip content
  assert.ok(chips[0].textContent.includes('claude'));
  assert.ok(chips[0].textContent.includes('5h 22% (2h 10m)'));
  assert.ok(chips[0].textContent.includes('wk 49% (3d 4h)'));

  // Verify Codex chip content and warn color (80%)
  assert.ok(chips[1].textContent.includes('codex'));
  assert.ok(chips[1].textContent.includes('5h 80% (1h 10m)'));
  const warnSpans = chips[1].all((n) => n.className && n.className.includes('lwarn'));
  assert.equal(warnSpans.length, 1, '80% gets lwarn class');

  // Verify Agy chip content and danger color (100% and 95%)
  assert.ok(chips[2].textContent.includes('agy'));
  assert.ok(chips[2].textContent.includes('gem'));
  assert.ok(chips[2].textContent.includes('5h 0%'));
  assert.ok(chips[2].textContent.includes('claude'));
  assert.ok(chips[2].textContent.includes('5h 100% (4h 18m)'));
  assert.ok(chips[2].textContent.includes('argon'));
  assert.ok(chips[2].textContent.includes('wk 95% (2d 2h)'));
  const dangerSpans = chips[2].all((n) => n.className && n.className.includes('ldanger'));
  assert.equal(dangerSpans.length, 2, '100% and 95% get ldanger class');

  // Verify node reuse across unchanged polls
  await p.poll();
  assert.equal(p.limitsWrap(), wrap, 'limits node is preserved across unchanged poll');

  // Switching tab to ask hides limits
  p.tab('ask');
  assert.equal(p.limitsWrap(), null, 'limits container not on ask tab');
});
