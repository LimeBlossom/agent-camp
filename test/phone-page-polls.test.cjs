'use strict';

// The phone page polls /api/state every 4s. A poll that changed only something off
// screen (an agent's action while the human reads ASK ME) must not rebuild the cards they are
// looking at: a rebuilt <video> stops playing and a rebuilt <img> has no height until
// it reloads, so the page jumps.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const loadTs = require('../test-support/load-ts.cjs');

const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
const SCRIPT = PHONE_PAGE.slice(PHONE_PAGE.indexOf('<script>') + 8, PHONE_PAGE.indexOf('</script>'));

class Node {
  constructor(tag) { this.tagName = tag; this.childNodes = []; this.parentNode = null; this.dataset = {}; this.className = ''; this.attrs = {}; this.style = {}; this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 200; }
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
  removeChild(n) { this.childNodes.splice(this.childNodes.indexOf(n), 1); n.parentNode = null; return n; }
  set textContent(t) { this.childNodes.forEach((n) => { n.parentNode = null; }); this.childNodes = []; if (t) this.appendChild(text(t)); }
  get textContent() { return this.tagName === '#text' ? this.data : this.childNodes.map((n) => n.textContent).join(''); }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener() {}
  focus() {}
  setSelectionRange() {}
  closest(tag) { let n = this; while (n && n.tagName !== tag.toUpperCase()) n = n.parentNode; return n; }
  all(pred, acc = []) { this.childNodes.forEach((c) => { if (pred(c)) acc.push(c); c.all(pred, acc); }); return acc; }
}
function text(t) { const n = new Node('#text'); n.data = String(t); return n; }

function page(states) {
  const body = new Node('BODY');
  const byId = {};
  for (const id of ['stamp', 'main', 'askBadge']) { byId[id] = body.appendChild(new Node(id === 'main' ? 'MAIN' : 'SPAN')); }
  const nav = byId.nav = body.appendChild(new Node('NAV'));
  for (const t of ['floor', 'ask', 'tasks']) { const b = nav.appendChild(new Node('BUTTON')); b.dataset.tab = t; }
  let polls = 0, timer = null;
  const document = {
    hidden: false, activeElement: null,
    createElement: (tag) => new Node(tag.toUpperCase()),
    createTextNode: text,
    getElementById: (id) => byId[id],
    querySelectorAll: (sel) => body.all((n) => sel === '.reply' ? n.className === 'reply' : n.tagName === (sel === 'nav button' ? 'BUTTON' : sel.toUpperCase())),
    addEventListener() {},
  };
  const ctx = {
    document,
    location: { hash: '#tok', pathname: '/' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    window: { scrollY: 0, scrollTo() {} },
    fetch: () => Promise.resolve({ status: 200, json: () => Promise.resolve(states[Math.min(polls++, states.length - 1)]) }),
    setInterval(fn) { timer = fn; },
    Date, JSON, Object, Array, String,
  };
  vm.runInNewContext(SCRIPT, ctx);
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    main: byId.main,
    async poll() { timer(); await tick(); await tick(); },
    tab(t) { nav.onclick({ target: { closest: () => nav.children.find((b) => b.dataset.tab === t) } }); },
    replies: () => byId.main.all((n) => n.className === 'reply'),
    videos: () => byId.main.all((n) => n.tagName === 'VIDEO'),
  };
}

const ask = (id, q) => ({ id, title: 'Card ' + id, assignee: 'pika', project: 'Studio', q });
const state = (action, asks) => ({
  live: true, asks,
  agents: [{ id: 'a1', name: 'Pika', status: 'working', action, isGod: false, character: '', lastReply: '', lastReplyAt: null }],
  board: asks.map((a) => ({ id: a.id, title: a.title, status: 'blocked', assignee: 'pika' })),
});

async function run(states) {
  const p = page(states);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return p;
}

test('a poll that only changes an agent action keeps the ASK ME video element', async () => {
  const asks = [ask('t1', 'Which clip?\n\n![clip](/x/a.mp4)'), ask('t2', 'Other?')];
  const states = [state('reading', asks), state('editing', asks)];
  const p = await run(states);
  p.tab('ask');
  const [before] = p.videos();
  assert.ok(before, 'the ask renders a video');
  await p.poll();
  assert.equal(p.main.children.length, 2);
  assert.equal(p.videos()[0], before, 'same <video> node, so it keeps playing');
});

test('a new ask is added without rebuilding the cards already on screen', async () => {
  const asks = [ask('t1', '![clip](/x/a.mp4)')];
  const p = await run([state('x', asks), state('x', [...asks, ask('t3', 'New one?')])]);
  p.tab('ask');
  const [card] = p.main.children;
  const video = p.videos()[0];
  await p.poll();
  assert.equal(p.main.children.length, 2);
  assert.equal(p.main.children[0], card);
  assert.equal(p.videos()[0], video);
  assert.match(p.main.children[1].textContent, /Card t3/);
});

test('an answered ask leaves the page and the others stay put', async () => {
  const asks = [ask('t1', 'A?'), ask('t2', '![clip](/x/b.mp4)')];
  const p = await run([state('x', asks), state('x', [asks[1]])]);
  p.tab('ask');
  const video = p.videos()[0];
  await p.poll();
  assert.equal(p.main.children.length, 1);
  assert.equal(p.videos()[0], video);
});

const replyState = (action, lastReply = 'Long boss reply\n'.repeat(100)) => {
  const d = state(action, []);
  Object.assign(d.agents[0], { isGod: true, lastReply });
  return d;
};
function openReply(p) {
  p.main.children[0].onclick({ target: { tagName: 'DIV' } });
  return p.replies()[0];
}

test('a changed poll preserves the reading position inside a rebuilt boss reply', async () => {
  const p = await run([replyState('reading'), replyState('editing')]);
  const reply = openReply(p);
  reply.scrollTop = 350;
  await p.poll();
  assert.notEqual(p.replies()[0], reply, 'changed agent data rebuilds the card');
  assert.equal(p.replies()[0].scrollTop, 350);
});

test('new reply text holds a reader in the middle through repeated polls', async () => {
  const p = await run([replyState('working'), replyState('working', 'More reply\n'.repeat(120)), replyState('idle')]);
  openReply(p).scrollTop = 240;
  await p.poll();
  assert.equal(p.replies()[0].scrollTop, 240);
  await p.poll();
  assert.equal(p.replies()[0].scrollTop, 240);
});

test('a reader at the bottom follows updated reply text', async () => {
  const p = await run([replyState('working'), replyState('idle', 'New reply\n'.repeat(130))]);
  openReply(p).scrollTop = 800;
  await p.poll();
  const reply = p.replies()[0];
  assert.ok(reply.scrollTop >= reply.scrollHeight - reply.clientHeight);
});
