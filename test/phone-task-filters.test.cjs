'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const loadTs = require('../test-support/load-ts.cjs');

const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');
const SCRIPT = PHONE_PAGE.slice(PHONE_PAGE.indexOf('<script>') + 8, PHONE_PAGE.indexOf('</script>'));

class MockNode {
  constructor(tag) {
    this.tagName = tag;
    this.childNodes = [];
    this.parentNode = null;
    this.dataset = {};
    this.className = '';
    this.attrs = {};
    this.style = {};
    this.value = '';
    this.disabled = false;
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
    if (idx !== -1) {
      this.childNodes.splice(idx, 1);
      n.parentNode = null;
    }
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
  setAttribute(k, v) { this.attrs[k] = v; if (k === 'value') this.value = v; }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener() {}
  focus() {}
  setSelectionRange() {}
  closest(tag) {
    let n = this;
    while (n && n.tagName !== tag.toUpperCase()) n = n.parentNode;
    return n;
  }
  all(pred, acc = []) {
    this.childNodes.forEach((c) => {
      if (pred(c)) acc.push(c);
      c.all(pred, acc);
    });
    return acc;
  }
  click() {
    if (this.onclick) this.onclick({ target: this });
  }
}

function text(t) {
  const n = new MockNode('#text');
  n.data = String(t);
  return n;
}

function createPhonePage(states, initialStorage = {}) {
  const body = new MockNode('BODY');
  const byId = {};
  for (const id of ['stamp', 'main', 'askBadge']) {
    byId[id] = body.appendChild(new MockNode(id === 'main' ? 'MAIN' : 'SPAN'));
  }
  const nav = (byId.nav = body.appendChild(new MockNode('NAV')));
  for (const t of ['floor', 'ask', 'tasks']) {
    const b = nav.appendChild(new MockNode('BUTTON'));
    b.dataset.tab = t;
  }
  let polls = 0, timer = null;
  const storage = Object.assign({}, initialStorage);

  const document = {
    hidden: false,
    activeElement: null,
    createElement: (tag) => new MockNode(tag.toUpperCase()),
    createTextNode: text,
    getElementById: (id) => byId[id],
    querySelectorAll: (sel) => {
      if (sel === 'nav button') return body.all((n) => n.tagName === 'BUTTON' && n.parentNode === nav);
      return body.all((n) => n.tagName === sel.toUpperCase());
    },
    addEventListener() {},
  };

  const ctx = {
    document,
    location: { hash: '#test-tok', pathname: '/' },
    history: { replaceState() {} },
    localStorage: {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => { storage[k] = String(v); },
      removeItem: (k) => { delete storage[k]; },
    },
    window: { scrollY: 0, scrollTo() {} },
    fetch: () => Promise.resolve({
      status: 200,
      json: () => Promise.resolve(states[Math.min(polls++, states.length - 1)]),
    }),
    setInterval(fn) { timer = fn; },
    Date, JSON, Object, Array, String, Math,
  };

  vm.runInNewContext(SCRIPT, ctx);
  const tick = () => new Promise((r) => setImmediate(r));

  return {
    main: byId.main,
    storage,
    async poll() { timer(); await tick(); await tick(); },
    tab(t) {
      const btn = nav.children.find((b) => b.dataset.tab === t);
      nav.onclick({ target: btn });
    },
    statusChips: () => byId.main.all((n) => n.tagName === 'BUTTON' && n.className.includes('pchip')),
    selects: () => byId.main.all((n) => n.tagName === 'SELECT'),
    taskRows: () => byId.main.all((n) => n.tagName === 'DIV' && n.className === 'task'),
    pagingBars: () => byId.main.all((n) => n.tagName === 'DIV' && n.className === 'tpaging'),
    pageButtons: () => byId.main.all((n) => n.tagName === 'BUTTON' && n.className.includes('tpage-btn')),
    clearBtn: () => byId.main.all((n) => n.tagName === 'BUTTON' && n.className.includes('tclear-btn'))[0] || null,
  };
}

async function boot(states, initialStorage) {
  const p = createPhonePage(states, initialStorage);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return p;
}

function makeBoard(count, projects = ['Alpha', 'Studio', 'SphereSurvivors']) {
  const statuses = ['doing', 'blocked', 'todo', 'done'];
  const assignees = ['cedar-mv1d931e', 'birch-001', 'alder-007', ''];
  const board = [];
  for (let i = 0; i < count; i++) {
    const proj = projects[i % projects.length];
    const status = statuses[i % statuses.length];
    const assignee = assignees[i % assignees.length];
    board.push({
      id: `task-${i + 1}`,
      title: `${proj}: Task number ${i + 1}`,
      status,
      assignee,
      project: proj,
    });
  }
  return board;
}

const sampleAgents = [
  { id: 'cedar-mv1d931e', name: 'Cedar', status: 'working' },
  { id: 'birch-001', name: 'Birch', status: 'idle' },
  { id: 'alder-007', name: 'Alder', status: 'waiting' },
];

test('renders tasks tab with status chips, project & assignee dropdowns, and initial paged list', async () => {
  const board = makeBoard(12);
  const state = { live: true, agents: sampleAgents, asks: [], board };
  const p = await boot([state]);

  p.tab('tasks');

  // Verify status chips
  const chips = p.statusChips();
  assert.equal(chips.length, 5); // All, doing, blocked, todo, done
  assert.match(chips[0].textContent, /All 12/);
  assert.ok(chips[0].className.includes('on'));

  // Verify dropdowns
  const selects = p.selects();
  assert.equal(selects.length, 2); // Project, Assignee
  const [projSel, assigneeSel] = selects;
  assert.equal(projSel.getAttribute('aria-label'), 'Filter by project');
  assert.equal(assigneeSel.getAttribute('aria-label'), 'Filter by assignee');

  // 12 cards fits on 1 page (PAGE_SIZE = 20)
  assert.equal(p.taskRows().length, 12);
  const [paging] = p.pagingBars();
  assert.match(paging.textContent, /Showing 1–12 of 12/);
});

test('supports 100+ cards board across multiple pages (20 cards per page) with prev/next navigation', async () => {
  const board = makeBoard(105);
  const state = { live: true, agents: sampleAgents, asks: [], board };
  const p = await boot([state]);

  p.tab('tasks');

  // Verify top and bottom paging bars exist for multi-page list
  const pagingBars = p.pagingBars();
  assert.equal(pagingBars.length, 2, 'has both top and bottom paging bars when totalPages > 1');
  assert.match(pagingBars[0].textContent, /Showing 1–20 of 105/);
  assert.match(pagingBars[0].textContent, /Page 1 of 6/);

  // Exactly 20 tasks rendered on page 1
  assert.equal(p.taskRows().length, 20);

  // Buttons on top paging bar: Prev is disabled, Next is enabled
  const buttons = p.pageButtons();
  const [topPrev, topNext] = [buttons[0], buttons[1]];
  assert.equal(topPrev.disabled, true, 'Prev disabled on page 1');
  assert.equal(topNext.disabled, false, 'Next enabled on page 1');

  // Click Next -> move to Page 2
  topNext.click();
  assert.equal(p.taskRows().length, 20);
  assert.match(p.pagingBars()[0].textContent, /Showing 21–40 of 105/);
  assert.match(p.pagingBars()[0].textContent, /Page 2 of 6/);

  // Click Next 4 more times to get to Page 6
  p.pageButtons()[1].click(); // Page 3
  p.pageButtons()[1].click(); // Page 4
  p.pageButtons()[1].click(); // Page 5
  p.pageButtons()[1].click(); // Page 6

  // Page 6 has remaining 5 tasks (101 to 105)
  assert.equal(p.taskRows().length, 5);
  assert.match(p.pagingBars()[0].textContent, /Showing 101–105 of 105/);
  assert.match(p.pagingBars()[0].textContent, /Page 6 of 6/);
  assert.equal(p.pageButtons()[0].disabled, false, 'Prev enabled on page 6');
  assert.equal(p.pageButtons()[1].disabled, true, 'Next disabled on last page');

  // Click Prev -> back to Page 5
  p.pageButtons()[0].click();
  assert.equal(p.taskRows().length, 20);
  assert.match(p.pagingBars()[0].textContent, /Showing 81–100 of 105/);
  assert.match(p.pagingBars()[0].textContent, /Page 5 of 6/);
});

test('status filter toggles by clicking status chips and updates active state and counts', async () => {
  const board = [
    { id: '1', title: 'Task 1', status: 'doing', assignee: 'cedar-mv1d931e', project: 'Alpha' },
    { id: '2', title: 'Task 2', status: 'doing', assignee: 'cedar-mv1d931e', project: 'Alpha' },
    { id: '3', title: 'Task 3', status: 'blocked', assignee: 'birch-001', project: 'Studio' },
    { id: '4', title: 'Task 4', status: 'todo', assignee: '', project: 'Studio' },
    { id: '5', title: 'Task 5', status: 'done', assignee: 'cedar-mv1d931e', project: 'Alpha' },
  ];
  const state = { live: true, agents: sampleAgents, asks: [], board };
  const p = await boot([state]);
  p.tab('tasks');

  // Chips: All 5, doing 2, blocked 1, todo 1, done 1
  const chips = p.statusChips();
  const doingChip = chips.find((c) => c.textContent.includes('doing'));
  assert.ok(doingChip);
  assert.match(doingChip.textContent, /doing 2/);

  // Click "doing" chip
  doingChip.click();
  const activeDoing = p.statusChips().find((c) => c.textContent.includes('doing'));
  assert.ok(activeDoing.className.includes('on'), 'doing chip is active');
  assert.equal(p.storage['md-phone-taskStatus'], 'doing');
  assert.equal(p.taskRows().length, 2);

  // Click "doing" chip again -> toggles back to All
  activeDoing.click();
  assert.ok(!p.storage['md-phone-taskStatus']);
  assert.equal(p.taskRows().length, 5);
});

test('project filter dropdown filters tasks by project and resets to page 1', async () => {
  const board = [
    ...makeBoard(40, ['Alpha']),
    ...makeBoard(10, ['Studio']),
  ];
  const state = { live: true, agents: sampleAgents, asks: [], board };
  const p = await boot([state]);
  p.tab('tasks');

  // Initially 50 tasks across 3 pages
  assert.match(p.pagingBars()[0].textContent, /Showing 1–20 of 50/);
  // Navigate to page 2
  p.pageButtons()[1].click();
  assert.match(p.pagingBars()[0].textContent, /Showing 21–40 of 50/);

  // Select Studio project
  const [projSel] = p.selects();
  projSel.value = 'Studio';
  projSel.onchange();

  assert.equal(p.storage['md-phone-taskProject'], 'Studio');
  assert.equal(p.taskRows().length, 10);
  assert.match(p.pagingBars()[0].textContent, /Showing 1–10 of 10/, 'resets to page 1');
});

test('assignee filter dropdown filters tasks by assignee and resolves agent names', async () => {
  const board = [
    { id: '1', title: 'Task 1', status: 'todo', assignee: 'cedar-mv1d931e', project: 'Alpha' },
    { id: '2', title: 'Task 2', status: 'doing', assignee: 'cedar-mv1d931e', project: 'Alpha' },
    { id: '3', title: 'Task 3', status: 'blocked', assignee: 'birch-001', project: 'Studio' },
    { id: '4', title: 'Task 4', status: 'todo', assignee: '', project: 'Studio' },
  ];
  const state = { live: true, agents: sampleAgents, asks: [], board };
  const p = await boot([state]);
  p.tab('tasks');

  const [, assigneeSel] = p.selects();
  // Check that Cedar name is rendered in option
  const optTexts = assigneeSel.childNodes.map((c) => c.textContent);
  assert.ok(optTexts.some((t) => t.includes('Cedar (2)')));
  assert.ok(optTexts.some((t) => t.includes('Unassigned (1)')));

  // Filter by Cedar
  assigneeSel.value = 'cedar-mv1d931e';
  assigneeSel.onchange();
  assert.equal(p.storage['md-phone-taskAssignee'], 'cedar-mv1d931e');
  assert.equal(p.taskRows().length, 2);

  // Filter by unassigned
  assigneeSel.value = 'unassigned';
  assigneeSel.onchange();
  assert.equal(p.taskRows().length, 1);
  assert.match(p.taskRows()[0].textContent, /Task 4/);
});

test('multiple filters combine and can be cleared with clear all button', async () => {
  const board = [
    { id: '1', title: 'Task 1', status: 'doing', assignee: 'cedar-mv1d931e', project: 'Alpha' },
    { id: '2', title: 'Task 2', status: 'todo', assignee: 'cedar-mv1d931e', project: 'Alpha' },
    { id: '3', title: 'Task 3', status: 'doing', assignee: 'birch-001', project: 'Alpha' },
    { id: '4', title: 'Task 4', status: 'doing', assignee: 'cedar-mv1d931e', project: 'Studio' },
  ];
  const state = { live: true, agents: sampleAgents, asks: [], board };
  const p = await boot([state]);
  p.tab('tasks');

  // Filter Project = Alpha, Status = doing, Assignee = cedar-mv1d931e
  const [projSel, assigneeSel] = p.selects();
  projSel.value = 'Alpha';
  projSel.onchange();

  const doingChip = p.statusChips().find((c) => c.textContent.includes('doing'));
  doingChip.click();

  assigneeSel.value = 'cedar-mv1d931e';
  assigneeSel.onchange();

  // Intersection: exactly Task 1 matches
  assert.equal(p.taskRows().length, 1);
  assert.match(p.taskRows()[0].textContent, /Task 1/);

  // Clear all button is present
  const clear = p.clearBtn();
  assert.ok(clear);
  clear.click();

  // All 4 tasks visible again, storage cleared
  assert.equal(p.taskRows().length, 4);
  assert.ok(!p.storage['md-phone-taskProject']);
  assert.ok(!p.storage['md-phone-taskStatus']);
  assert.ok(!p.storage['md-phone-taskAssignee']);
});

test('localStorage restores saved filters and page on load', async () => {
  const board = makeBoard(50);
  const state = { live: true, agents: sampleAgents, asks: [], board };
  const initialStorage = {
    'md-phone-taskPage': '2',
  };
  const p = await boot([state], initialStorage);
  p.tab('tasks');

  // Should start directly on page 2 (showing 21-40)
  assert.match(p.pagingBars()[0].textContent, /Showing 21–40 of 50/);
  assert.match(p.pagingBars()[0].textContent, /Page 2 of 3/);
});

test('polling with unchanged tasks preserves DOM node references (node reuse)', async () => {
  const board = makeBoard(5);
  const state1 = { live: true, agents: sampleAgents, asks: [], board };
  const state2 = { live: true, agents: [{ ...sampleAgents[0], action: 'new-action' }], asks: [], board };
  const p = await boot([state1, state2]);
  p.tab('tasks');

  const beforeRows = p.taskRows();
  const beforeSelects = p.selects();

  await p.poll();

  const afterRows = p.taskRows();
  const afterSelects = p.selects();

  assert.equal(afterRows[0], beforeRows[0], 'task row nodes preserved across polls');
  assert.equal(afterSelects[0], beforeSelects[0], 'filter select nodes preserved across polls');
});
