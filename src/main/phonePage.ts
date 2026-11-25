import { parsePhoneMarkdown } from './phoneMarkdown';
import { DEFAULT_APP_TITLE } from '../shared/themePack';

/** The phone view's single page (served by phone.ts). Self-contained: inline
 *  CSS and JS, no external requests. Agent text is set with textContent. */
export const PHONE_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#FFF8E7">
<title>${DEFAULT_APP_TITLE}</title>
<style>
:root {
  --bg: #FFF8E7; --card: #FFFDF6; --ink: #1A1320; --ink2: #6B5878; --line: #D9CDB8;
  --accent: #6E1423; --warn: #D9822B; --busy: #2F6FA3; --chip: #F1E8D6;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #17131C; --card: #221C29; --ink: #F1EAF5; --ink2: #A898B3; --line: #3A3142;
    --accent: #E0708A; --warn: #F0A050; --busy: #6FA8DC; --chip: #2D2535; }
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--bg); color: var(--ink);
  font: 16px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
header { position: sticky; top: 0; z-index: 2; background: var(--bg); padding: 12px 16px 8px;
  display: flex; align-items: baseline; justify-content: space-between; border-bottom: 1px solid var(--line); }
header h1 { font-size: 17px; margin: 0; }
header small { color: var(--ink2); font-size: 12px; }
main { padding: 12px 16px 96px; max-width: 720px; margin: 0 auto; }
nav { position: fixed; bottom: 0; left: 0; right: 0; display: flex; background: var(--card);
  border-top: 1px solid var(--line); padding-bottom: env(safe-area-inset-bottom); z-index: 3; }
nav button { flex: 1; padding: 12px 0 10px; border: 0; background: none; color: var(--ink2); font-size: 14px; }
nav button.on { color: var(--accent); font-weight: 600; }
nav .badge { display: inline-block; min-width: 18px; padding: 0 5px; margin-left: 4px; border-radius: 9px;
  background: var(--warn); color: #fff; font-size: 12px; line-height: 18px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
.row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.name { font-weight: 600; }
.model { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink2); font-size: 12px; }
.status { font-size: 12px; padding: 1px 8px; border-radius: 9px; background: var(--chip); color: var(--ink2); }
.row .status { flex: none; }
.status.working, .status.thinking { background: var(--busy); color: #fff; }
.status.blocked, .status.waiting { background: var(--warn); color: #fff; }
.action { color: var(--ink2); font-size: 14px; margin-top: 4px; overflow-wrap: anywhere; }
.action.live { color: var(--ink); font-weight: 600; font-size: 15px; }
.age { color: var(--ink2); font-size: 12px; margin-top: 2px; }
button:disabled { opacity: .5; }
.modelbox select { margin-top: 8px; max-width: 100%; padding: 6px; border: 1px solid var(--line); border-radius: 8px; background: var(--chip); color: var(--ink); font-size: 14px; }
.modelbox .tailbtn { margin-right: 8px; }
.tailbtn { margin-top: 8px; padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--chip); color: var(--ink); font-size: 14px; }
.tail { white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.35 ui-monospace, Menlo, Consolas, monospace; margin-top: 8px;
  max-height: 50vh; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--chip); }
.reply { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; margin-top: 8px;
  border-left: 3px solid var(--line); padding-left: 8px; max-height: 40vh; overflow-y: auto; }
.muted { color: var(--ink2); font-size: 13px; }
.wrap { overflow-wrap: anywhere; }
.q { overflow-wrap: anywhere; margin: 6px 0; }
.q p, .q h3, .q ul, .q pre { margin: 0 0 8px; }
.q h3 { font-size: 16px; }
.q ul { padding-left: 20px; }
.q li.num { list-style: none; margin-left: -14px; }
.q code { font: 13px ui-monospace, Menlo, monospace; background: var(--chip); padding: 0 3px; border-radius: 4px; }
.q pre { white-space: pre-wrap; background: var(--chip); padding: 6px 8px; border-radius: 6px; }
.q pre code { padding: 0; }
.q audio { display: block; width: 100%; margin: 8px 0; }
.tlink { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
.btnrow { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
.back { margin-bottom: 10px; }
.qa { border-left: 3px solid var(--line); padding-left: 8px; margin: 8px 0; }
.qa.dismissed { opacity: 0.6; }
.notes { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; }
.q img, .q video { display: block; max-width: 100%; margin: 8px 0; border-radius: 6px; border: 1px solid var(--line); }
textarea { width: 100%; min-height: 72px; padding: 8px; font: inherit; color: var(--ink); background: var(--bg);
  border: 1px solid var(--line); border-radius: 8px; resize: vertical; }
.send { margin-top: 6px; padding: 8px 16px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font-size: 15px; }
.send:disabled { opacity: 0.5; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .05em; color: var(--ink2); margin: 16px 0 6px; }
.task { padding: 8px 0; border-bottom: 1px solid var(--line); overflow-wrap: anywhere; }
.task:last-child { border-bottom: 0; }
.pchips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.pchip { padding: 6px 12px; border: 1px solid var(--line); border-radius: 16px; background: var(--chip); color: var(--ink); font-size: 14px; }
.pchip.on { background: var(--accent); border-color: var(--accent); color: #fff; }
.err { color: var(--warn); font-size: 13px; margin-top: 4px; }
.gate { text-align: center; padding: 48px 16px; }
.limits { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.lchip { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px;
  background: var(--card); border: 1px solid var(--line); border-radius: 6px;
  padding: 4px 8px; font-size: 13px; line-height: 1.3; }
.ltag { color: var(--ink2); font-weight: 600; }
.lres { color: var(--warn); font-weight: 600; }
.lpool { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.lsep, .lbar { color: var(--ink2); opacity: 0.5; }
.lseg { display: inline-flex; align-items: baseline; gap: 3px; }
.lreset { color: var(--ink2); font-size: 12px; }
.lok { color: var(--ink); }
.lwarn { color: var(--warn); font-weight: 600; }
.ldanger { color: var(--accent); font-weight: 600; }
.tfilter-bar { margin-bottom: 10px; }
.tfilter-row { display: flex; gap: 8px; margin-top: 6px; }
.tselect {
  flex: 1; min-width: 0; padding: 7px 10px; font-size: 13px; font-family: inherit;
  background: var(--chip); color: var(--ink); border: 1px solid var(--line);
  border-radius: 8px; outline: none; -webkit-appearance: none; appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%236B5878' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 8px center;
  padding-right: 24px;
}
.tactive-bar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; font-size: 12px; }
.tclear-btn { background: none; border: none; padding: 2px 4px; color: var(--accent); font-size: 12px; font-weight: 600; cursor: pointer; text-decoration: underline; }
.tpaging { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 8px 0; font-size: 13px; color: var(--ink2); }
.tpage-btns { display: flex; align-items: center; gap: 6px; }
.tpage-btn { padding: 5px 12px; border: 1px solid var(--line); border-radius: 6px; background: var(--card); color: var(--ink); font-size: 13px; font-weight: 500; cursor: pointer; }
.tpage-btn:disabled { opacity: 0.35; cursor: default; }
.tpage-num { font-size: 12px; color: var(--ink2); font-weight: 600; }
.fbshot { display: block; width: 100%; max-height: 220px; object-fit: contain; margin: 8px 0; border-radius: 6px; background: var(--chip); }
.fbnote { width: 100%; min-height: 64px; margin: 6px 0; padding: 8px; font: inherit; box-sizing: border-box; }
.fbpick { width: 100%; margin: 6px 0; padding: 8px; font: inherit; }
.fbdismiss { background: var(--chip); color: var(--ink2); }
.task-title { font-size: 14px; font-weight: 500; color: var(--ink); line-height: 1.35; }
.task-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 5px; font-size: 12px; }
.task-proj { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--chip); color: var(--ink2); font-weight: 600; }
.status.doing { background: var(--busy); color: #fff; }
.status.todo { background: var(--chip); color: var(--ink2); }
.status.done { background: var(--chip); color: var(--ink2); opacity: 0.85; }
</style>
</head>
<body>
<header><h1>${DEFAULT_APP_TITLE}</h1><small id="stamp"></small></header>
<main id="main"></main>
<nav id="nav">
  <button data-tab="floor">Floor</button>
  <button data-tab="ask">Ask Me<span id="askBadge"></span></button>
  <button data-tab="results">Results<span id="resultsBadge"></span></button>
  <button data-tab="feedback">Feedback<span id="feedbackBadge"></span></button>
  <button data-tab="tasks">Tasks</button>
  <button data-tab="backlog">Backlog</button>
</nav>
<script>
(function () {
  var KEY = 'md-phone-token';
  var h = location.hash.replace(/^#/, '');
  if (h) { try { localStorage.setItem(KEY, h); } catch (e) {} history.replaceState(null, '', location.pathname + location.search); }
  var token = h || (function () { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } })();
  var tab = 'floor', data = null, lastJson = '', open = {}, drafts = {}, errors = {}, picks = {}, notes = {}, backlogErrors = {}, backlogBusy = {}, dismissBusy = {};
  var tailOpen = Object.create(null), tails = Object.create(null);
  var modelUi = Object.create(null);
  var detailId = '', detail = null, detailError = '', detailReturnY = 0;
  var nodes = {}, next = {}, out = [];
  var main = document.getElementById('main');
  var PROJECT_KEY = 'md-phone-askProject';
  var project = (function () { try { return localStorage.getItem(PROJECT_KEY) || ''; } catch (e) { return ''; } })();
  function setProject(p) {
    project = p;
    try { if (p) localStorage.setItem(PROJECT_KEY, p); else localStorage.removeItem(PROJECT_KEY); } catch (e) {}
  }
  var BACKLOG_PROJECT_KEY = 'md-phone-backlogProject';
  var backlogProject = (function () { try { return localStorage.getItem(BACKLOG_PROJECT_KEY) || ''; } catch (e) { return ''; } })();
  function setBacklogProject(p) {
    backlogProject = p;
    try { if (p) localStorage.setItem(BACKLOG_PROJECT_KEY, p); else localStorage.removeItem(BACKLOG_PROJECT_KEY); } catch (e) {}
  }

  var TASK_PROJECT_KEY = 'md-phone-taskProject';
  var TASK_STATUS_KEY = 'md-phone-taskStatus';
  var TASK_ASSIGNEE_KEY = 'md-phone-taskAssignee';
  var TASK_PAGE_KEY = 'md-phone-taskPage';
  var taskProject = (function () { try { return localStorage.getItem(TASK_PROJECT_KEY) || ''; } catch (e) { return ''; } })();
  var taskStatus = (function () { try { return localStorage.getItem(TASK_STATUS_KEY) || ''; } catch (e) { return ''; } })();
  var taskAssignee = (function () { try { return localStorage.getItem(TASK_ASSIGNEE_KEY) || ''; } catch (e) { return ''; } })();
  var taskPage = (function () { try { var p = parseInt(localStorage.getItem(TASK_PAGE_KEY) || '1', 10); return isNaN(p) || p < 1 ? 1 : p; } catch (e) { return 1; } })();
  var PAGE_SIZE = 20;

  function setTaskPage(p) {
    taskPage = p;
    try { if (p > 1) localStorage.setItem(TASK_PAGE_KEY, String(p)); else localStorage.removeItem(TASK_PAGE_KEY); } catch (e) {}
  }
  function setTaskProject(p) {
    taskProject = p || '';
    setTaskPage(1);
    try { if (taskProject) localStorage.setItem(TASK_PROJECT_KEY, taskProject); else localStorage.removeItem(TASK_PROJECT_KEY); } catch (e) {}
  }
  function setTaskStatus(s) {
    taskStatus = s || '';
    setTaskPage(1);
    try { if (taskStatus) localStorage.setItem(TASK_STATUS_KEY, taskStatus); else localStorage.removeItem(TASK_STATUS_KEY); } catch (e) {}
  }
  function setTaskAssignee(a) {
    taskAssignee = a || '';
    setTaskPage(1);
    try { if (taskAssignee) localStorage.setItem(TASK_ASSIGNEE_KEY, taskAssignee); else localStorage.removeItem(TASK_ASSIGNEE_KEY); } catch (e) {}
  }
  function clearTaskFilters() {
    setTaskProject('');
    setTaskStatus('');
    setTaskAssignee('');
    setTaskPage(1);
  }

  var urlParams = (function () {
    try { return new URLSearchParams(location.search); } catch (e) { return null; }
  })();
  if (urlParams) {
    var initialTab = urlParams.get('tab');
    if (initialTab && ['floor', 'ask', 'results', 'feedback', 'tasks', 'backlog'].indexOf(initialTab) !== -1) tab = initialTab;
    if (urlParams.has('project')) setTaskProject(urlParams.get('project') || '');
    if (urlParams.has('status')) setTaskStatus(urlParams.get('status') || '');
    if (urlParams.has('assignee')) setTaskAssignee(urlParams.get('assignee') || '');
    if (urlParams.has('page')) setTaskPage(parseInt(urlParams.get('page') || '1', 10) || 1);
  }
  function nameFor(id) {
    if (!id) return '';
    if (data && data.agents) {
      for (var i = 0; i < data.agents.length; i++) {
        if (data.agents[i].id === id) return data.agents[i].name;
      }
    }
    return id;
  }
  function projectOf(task) {
    if (!task) return 'Other';
    if (typeof task.project === 'string' && task.project.trim()) return task.project.trim();
    var title = typeof task.title === 'string' ? task.title : '';
    var colon = title.indexOf(':');
    if (colon <= 0) return 'Other';
    var words = title.slice(0, colon).trim().split(/\s+/).filter(Boolean);
    if (!words.length || words.length > 3) return 'Other';
    return words[0];
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function api(path, body) {
    return fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: Object.assign({ Authorization: 'Bearer ' + token }, body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { if (r.status === 401) throw new Error('auth'); if (r.status === 404) throw new Error('stale'); return r.json(); });
  }
  var parseMarkdown = (${parsePhoneMarkdown.toString()});
  function spanNode(s) {
    if (s.kind === 'br') return el('br');
    if (s.kind === 'b') return el('strong', null, s.text);
    if (s.kind === 'code') return el('code', null, s.text);
    if (s.kind === 'img') {
      var img = el('img');
      img.loading = 'lazy';
      img.alt = s.alt;
      img.src = '/api/file?p=' + encodeURIComponent(s.src) + '&t=' + encodeURIComponent(token);
      return img;
    }
    if (s.kind === 'video') {
      var v = el('video');
      v.controls = true;
      v.muted = true;
      v.playsInline = true;
      v.preload = 'metadata';
      v.setAttribute('aria-label', s.alt);
      v.src = '/api/file?p=' + encodeURIComponent(s.src) + '&t=' + encodeURIComponent(token);
      return v;
    }
    if (s.kind === 'audio') {
      var au = el('audio');
      au.controls = true;
      au.preload = 'metadata';
      au.setAttribute('aria-label', s.alt);
      au.src = '/api/file?p=' + encodeURIComponent(s.src) + '&t=' + encodeURIComponent(token);
      return au;
    }
    return document.createTextNode(s.text);
  }
  function titleLink(cls, id, text) {
    var t = el('div', cls + ' tlink', text);
    t.setAttribute('role', 'button');
    t.tabIndex = 0;
    t.onclick = function () { openDetail(id); };
    return t;
  }
  function openDetail(id) {
    detailReturnY = window.scrollY;
    detailId = id; detail = null; detailError = '';
    render();
    window.scrollTo(0, 0);
    loadDetail();
  }
  function closeDetail() {
    detailId = ''; detail = null; detailError = '';
    render();
    window.scrollTo(0, detailReturnY);
  }
  function loadDetail() {
    var id = detailId;
    if (!id) return;
    api('/api/task?id=' + encodeURIComponent(id)).then(function (r) {
      if (detailId !== id) return;
      if (r && r.ok) { detail = r.task; detailError = ''; } else { detailError = (r && r.error) || 'Could not load this card.'; }
      render();
    }).catch(function () { if (detailId === id) { detailError = 'Could not load this card.'; render(); } });
  }
  function fmtWhen(iso) {
    var ms = Date.parse(iso || '');
    if (isNaN(ms)) return '';
    return new Date(ms).toLocaleString() + ' (' + sinceText(Date.now() - ms) + ' ago)';
  }
  function sinceText(diff) {
    var m = Math.floor(Math.max(0, diff) / 60000);
    if (m < 1) return 'under 1m';
    if (m < 60) return m + 'm';
    if (m < 2880) return Math.floor(m / 60) + 'h';
    return Math.floor(m / 1440) + 'd';
  }
  function renderDetail() {
    put('d:back', function () {
      var b = el('button', 'pchip back', '\u2190 Back');
      b.onclick = closeDetail;
      return b;
    });
    if (detailError) { put('d:err:' + detailError, function () { return el('p', 'err', detailError); }); return; }
    if (!detail) { put('d:loading', function () { return el('p', 'muted', 'Loading...'); }); return; }
    var t = detail;
    put('d:card:' + JSON.stringify(t), function () {
      var c = el('div', 'card');
      c.appendChild(el('div', 'name', t.title || t.id));
      var meta = el('div', 'task-meta');
      meta.appendChild(el('span', 'status ' + (t.status || 'todo'), t.status || 'todo'));
      if (t.project && t.project !== 'Other') meta.appendChild(el('span', 'task-proj', t.project));
      if (t.assignee) meta.appendChild(el('span', 'muted', '@' + nameFor(t.assignee)));
      c.appendChild(meta);
      c.appendChild(el('div', 'muted', t.id));
      var when = [];
      if (t.createdAt) when.push('Created ' + fmtWhen(t.createdAt));
      if (t.updatedAt) when.push('Updated ' + fmtWhen(t.updatedAt));
      if (t.backloggedAt) when.push('Shelved ' + fmtWhen(t.backloggedAt));
      if (when.length) c.appendChild(el('div', 'muted', when.join(' \u00b7 ')));
      if (t.description) { c.appendChild(el('h2', null, 'Description')); c.appendChild(questionNode(t.description)); }
      if (t.dependsOn && t.dependsOn.length) {
        c.appendChild(el('h2', null, 'Waits on'));
        t.dependsOn.forEach(function (d) { c.appendChild(titleLink('muted', d.id, d.title)); });
      }
      if (t.qa && t.qa.length) {
        c.appendChild(el('h2', null, 'Questions'));
        t.qa.slice().reverse().forEach(function (e) {
          var box = el('div', 'qa' + (e.dismissed ? ' dismissed' : ''));
          box.appendChild(questionNode(e.q));
          if (e.a) { box.appendChild(el('div', 'name', 'Answer')); box.appendChild(questionNode(e.a)); }
          else if (e.dismissed) box.appendChild(el('div', 'muted', 'Dismissed'));
          else box.appendChild(el('div', 'muted', 'Open'));
          var w = fmtWhen(e.answeredAt || e.askedAt);
          if (w) box.appendChild(el('div', 'muted', w));
          c.appendChild(box);
        });
      }
      if (t.result) { c.appendChild(el('h2', null, 'Result')); c.appendChild(questionNode(t.result)); }
      if (t.notes) { c.appendChild(el('h2', null, 'Notes')); c.appendChild(el('div', 'notes', t.notes)); }
      return c;
    });
  }
  // Every render reuses the node a key built last time, so a poll that changed something
  // else leaves a card, its videos (still playing) and its images (still sized) in place.
  // A key must therefore name everything its node shows.
  function put(key, build) {
    var n = nodes[key] || build();
    next[key] = n;
    out.push(n);
  }
  function questionNode(text) {
    var box = el('div', 'q'), list = null;
    parseMarkdown(text).forEach(function (b) {
      var node;
      if (b.kind === 'li') {
        if (!list) { list = el('ul'); box.appendChild(list); }
        node = el('li', b.ordered ? 'num' : null);
        list.appendChild(node);
      } else {
        list = null;
        node = el(b.kind === 'h' ? 'h3' : b.kind === 'pre' ? 'pre' : 'p');
        box.appendChild(node);
      }
      b.spans.forEach(function (s) { node.appendChild(spanNode(s)); });
    });
    return box;
  }
  function composer(key, placeholder, onSend) {
    var wrap = el('div');
    var ta = el('textarea');
    ta.placeholder = placeholder;
    ta.dataset.key = key;
    ta.value = drafts[key] || '';
    ta.oninput = function () { drafts[key] = ta.value; };
    var b = el('button', 'send', 'Send');
    b.onclick = function () {
      var text = ta.value.trim();
      if (!text) return;
      b.disabled = true;
      onSend(text).then(function (r) {
        if (r && r.ok) { drafts[key] = ''; errors[key] = ''; ta.value = ''; b.disabled = false; refresh(); }
        else { errors[key] = (r && r.error) || 'Not sent'; render(); }
      }).catch(function () { errors[key] = 'Not sent'; render(); });
    };
    wrap.appendChild(ta);
    wrap.appendChild(b);
    if (errors[key]) wrap.appendChild(el('div', 'err', errors[key]));
    return wrap;
  }

  function limitSegmentNode(seg) {
    var s = el('span', 'lseg');
    var pct = Math.round(seg.percent);
    var cls = pct >= 90 ? 'ldanger' : pct >= 75 ? 'lwarn' : 'lok';
    s.appendChild(el('span', cls, seg.label + ' ' + pct + '%'));
    if (seg.reset) {
      s.appendChild(el('span', 'lreset', ' (' + seg.reset + ')'));
      s.title = 'resets in ' + seg.reset;
    }
    return s;
  }

  function limitsNode(limits) {
    var wrap = el('div', 'limits');
    limits.forEach(function (lim) {
      var chip = el('div', 'lchip');
      chip.appendChild(el('span', 'ltag', lim.label));
      if (lim.segments) {
        lim.segments.forEach(function (seg, i) {
          if (i > 0) chip.appendChild(el('span', 'lsep', '·'));
          chip.appendChild(limitSegmentNode(seg));
        });
      }
      if (lim.pools) {
        lim.pools.forEach(function (p, pi) {
          if (pi > 0) chip.appendChild(el('span', 'lbar', '|'));
          var poolSpan = el('span', 'lpool');
          poolSpan.appendChild(el('span', 'ltag', p.label));
          p.segments.forEach(function (seg, si) {
            if (si > 0) poolSpan.appendChild(el('span', 'lsep', '·'));
            poolSpan.appendChild(limitSegmentNode(seg));
          });
          chip.appendChild(poolSpan);
        });
      }
      if (lim.reserved) chip.appendChild(el('span', 'lres', 'reserved: ' + lim.reserved.join('; ')));
      wrap.appendChild(chip);
    });
    return wrap;
  }

  function renderFloor() {
    if (!data.live) put('f:wait', function () { return el('p', 'muted', 'Waiting for the app to publish agent state...'); });
    if (data.limits && data.limits.length) {
      put('f:limits:' + JSON.stringify(data.limits), function () { return limitsNode(data.limits); });
    }
    data.agents.slice().sort(function (a, b) { return (b.isGod ? 1 : 0) - (a.isGod ? 1 : 0); }).forEach(function (a) {
      // lastOutputAt moves every poll; it only feeds the age text, which tickAges refreshes in place.
      var stable = Object.assign({}, a); delete stable.lastOutputAt;
      put('f:' + JSON.stringify([stable, !!open[a.id], !!tailOpen[a.id], tails[a.id] || null, modelUi[a.id] || null, errors['msg:' + a.id] || '', errors['model:' + a.id] || '', errors['pin:' + a.id] || '']), function () { return agentCard(a); });
    });
  }
  function agentCard(a) {
    var c = el('div', 'card');
    var r = el('div', 'row');
    r.appendChild(el('span', 'name', a.name + (a.isGod ? ' (orchestrator)' : '')));
    if (a.model) r.appendChild(el('span', 'model', a.model));
    r.appendChild(el('span', 'status ' + a.status, a.status));
    c.appendChild(r);
    if (a.action && a.action !== 'idle') c.appendChild(el('div', 'action live', a.action));
    if (a.actionSince || a.lastOutputAt) {
      var age = el('div', 'age');
      if (a.action && a.action !== 'idle' && a.actionSince) age.dataset.since = String(a.actionSince);
      if (a.lastOutputAt) age.dataset.out = String(a.lastOutputAt);
      age.textContent = ageText(age);
      c.appendChild(age);
    }
    if (a.usage7dLine) c.appendChild(el('div', 'muted', a.usage7dLine));
    c.onclick = function (ev) { if (ev.target.tagName === 'TEXTAREA' || ev.target.tagName === 'BUTTON' || ev.target.tagName === 'SELECT' || (ev.target.className === 'tail')) return; open[a.id] = !open[a.id]; render(); };
    if (open[a.id]) {
      var reply = a.lastReply ? el('div', 'reply', a.lastReply) : el('div', 'muted', 'No reply yet this session.');
      if (a.lastReply) reply.dataset.agentId = a.id;
      c.appendChild(reply);
      var tb = el('button', 'tailbtn', tailOpen[a.id] ? 'Hide output' : 'Show output');
      tb.onclick = function () {
        tailOpen[a.id] = !tailOpen[a.id];
        if (tailOpen[a.id]) loadTail(a.id); else render();
      };
      c.appendChild(tb);
      if (tailOpen[a.id]) {
        var t = tails[a.id];
        if (!t) c.appendChild(el('div', 'muted', 'Loading output...'));
        else if (t.error) c.appendChild(el('div', 'err', t.error));
        else {
          var pre = el('div', 'tail', (t.truncated ? '[older output not shown]\\n' : '') + (t.lines.length ? t.lines.join('\\n') : '(no output yet)'));
          pre.dataset.agentId = a.id;
          c.appendChild(pre);
        }
      }
      c.appendChild(tierBox(a));
      c.appendChild(modelPicker(a));
      c.appendChild(composer('msg:' + a.id, 'Message ' + a.name + '...', function (text) {
        return api('/api/message', { agentId: a.id, text: text });
      }));
    }
    return c;
  }
  function tierBox(a) {
    var box = el('div', 'modelbox');
    if (a.tier) box.appendChild(el('div', 'muted', 'Tier: ' + a.tier));
    if (!a.pin) return box;
    box.appendChild(el('div', 'muted wrap', 'Pin: ' + a.pin.label + (a.pin.unused ? ' (not used: ' + a.pin.unused + ')' : '')));
    if (errors['pin:' + a.id]) box.appendChild(el('div', 'err', errors['pin:' + a.id]));
    var clear = el('button', 'tailbtn', 'Clear pin');
    clear.onclick = function () {
      delete errors['pin:' + a.id];
      api('/api/clear-pin', { id: a.id }).then(function (r) {
        if (!(r && r.ok)) errors['pin:' + a.id] = (r && r.error) || 'Could not clear the pin.';
        refresh();
      }).catch(function () { errors['pin:' + a.id] = 'Could not clear the pin.'; render(); });
    };
    box.appendChild(clear);
    return box;
  }
  // Model switch: pick, confirm "current -> new", then show pending until the agent restarts.
  function modelPicker(a) {
    var box = el('div', 'modelbox');
    var ui = modelUi[a.id] || null;
    if (a.switching) {
      box.appendChild(el('div', 'muted', 'Switching to ' + a.switching.to + ' (' + a.switching.state + ')...'));
      return box;
    }
    if (errors['model:' + a.id]) box.appendChild(el('div', 'err', errors['model:' + a.id]));
    if (!ui) {
      var open_ = el('button', 'tailbtn', 'Change model');
      open_.onclick = function () {
        modelUi[a.id] = { loading: true };
        render();
        api('/api/agent-model?id=' + encodeURIComponent(a.id)).then(function (r) {
          modelUi[a.id] = r && r.ok ? { info: r, pick: -1 } : null;
          if (!(r && r.ok)) errors['model:' + a.id] = (r && r.error) || 'Could not load models.';
          render();
        }).catch(function () { modelUi[a.id] = null; errors['model:' + a.id] = 'Could not load models.'; render(); });
      };
      box.appendChild(open_);
      return box;
    }
    if (ui.loading) { box.appendChild(el('div', 'muted', 'Loading models...')); return box; }
    var cur = ui.info.current;
    var choices = ui.info.choices;
    if (ui.confirm) {
      var next_ = choices[ui.pick];
      box.appendChild(el('div', 'reply', cur.label + ' \\u2192 ' + next_.label));
      box.appendChild(el('div', 'muted', (a.isGod ? 'This restarts the Boss. ' : '') + 'The agent restarts on the new model once its terminal is quiet and keeps its card and work.'));
      var yes = el('button', 'tailbtn', a.isGod ? 'Confirm: restart the Boss' : 'Confirm switch');
      yes.onclick = function () {
        yes.disabled = true;
        api('/api/agent-model', { id: a.id, provider: next_.provider, model: next_.model, confirmBoss: !!a.isGod }).then(function (r) {
          modelUi[a.id] = null;
          errors['model:' + a.id] = r && r.ok ? '' : ((r && r.error) || 'Not switched');
          refresh();
        }).catch(function () { modelUi[a.id] = null; errors['model:' + a.id] = 'Not switched'; render(); });
      };
      var no = el('button', 'tailbtn', 'Cancel');
      no.onclick = function () { ui.confirm = false; render(); };
      box.appendChild(yes);
      box.appendChild(no);
      return box;
    }
    var sel = el('select');
    sel.appendChild(el('option', null, 'Switch to...'));
    choices.forEach(function (ch, i) {
      var same = ch.provider === cur.provider && (ch.model || '') === (cur.model || '');
      var o = el('option', null, ch.label + (same ? ' (current)' : ''));
      o.value = String(i);
      o.disabled = same;
      sel.appendChild(o);
    });
    sel.onchange = function () { ui.pick = sel.value === '' || sel.selectedIndex === 0 ? -1 : Number(sel.value); render(); };
    box.appendChild(sel);
    var go = el('button', 'tailbtn', 'Review switch');
    go.disabled = ui.pick < 0;
    go.onclick = function () { ui.confirm = true; render(); };
    var cancel = el('button', 'tailbtn', 'Cancel');
    cancel.onclick = function () { modelUi[a.id] = null; render(); };
    box.appendChild(go);
    box.appendChild(cancel);
    if (ui.pick >= 0) sel.value = String(ui.pick);
    return box;
  }
  function ago(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
    return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
  }
  function ageText(n) {
    var now = Date.now(), parts = [];
    if (n.dataset.since) parts.push('for ' + ago(now - Number(n.dataset.since)));
    if (n.dataset.out) parts.push('last output ' + ago(now - Number(n.dataset.out)) + ' ago');
    return parts.join(' / ');
  }
  function tickAges() {
    document.querySelectorAll('.age').forEach(function (n) { n.textContent = ageText(n); });
  }
  function loadTail(id) {
    api('/api/transcript?id=' + encodeURIComponent(id)).then(function (r) {
      var next_ = r && r.ok ? { lines: r.lines, truncated: !!r.truncated } : { error: (r && r.error) || 'Could not load output.' };
      if (JSON.stringify(tails[id]) === JSON.stringify(next_)) return;
      tails[id] = next_;
      render();
    }).catch(function () { tails[id] = { error: 'Could not load output.' }; render(); });
  }
  // Same order as the camp's chips (askMeProject.projectCounts): busiest first, Other last.
  function projectCounts(asks) {
    var counts = {};
    asks.forEach(function (q) { counts[q.project] = (counts[q.project] || 0) + 1; });
    return Object.keys(counts).map(function (p) { return { project: p, count: counts[p] }; }).sort(function (a, b) {
      return ((a.project === 'Other' ? 1 : 0) - (b.project === 'Other' ? 1 : 0))
        || b.count - a.count || a.project.localeCompare(b.project);
    });
  }
  function chip(label, count, on, p, set) {
    var b = el('button', 'pchip' + (on ? ' on' : ''), label + ' ' + count);
    b.onclick = function () { (set || setProject)(p); render(); };
    return b;
  }
  function renderAsk() {
    if (!data.asks.length) { put('a:none', function () { return el('p', 'muted', 'Nothing is waiting on you.'); }); return; }
    var projects = projectCounts(data.asks);
    if (projects.length > 1 || project) put('a:chips:' + JSON.stringify([projects, project, data.asks.length]), function () {
      var bar = el('div', 'pchips');
      bar.appendChild(chip('All', data.asks.length, !project, ''));
      projects.forEach(function (p) { bar.appendChild(chip(p.project, p.count, project === p.project, p.project)); });
      if (project && !projects.some(function (p) { return p.project === project; })) bar.appendChild(chip(project, 0, true, project));
      return bar;
    });
    var shown = project ? data.asks.filter(function (q) { return q.project === project; }) : data.asks;
    if (!shown.length) put('a:none:' + project, function () { return el('p', 'muted', 'Nothing from ' + project + ' is waiting on you.'); });
    shown.forEach(function (q) {
      put('a:' + JSON.stringify([q, fmtWhen(q.askedAt), errors['ans:' + q.id + ':' + q.q] || '', errors['bl:' + q.id] || '']), function () { return askCard(q); });
    });
  }
  function renderResults() {
    var items = data.results || [];
    if (!items.length) { put('r:none', function () { return el('p', 'muted', 'Nothing here yet. Answers to your questions and passed final checks land here.'); }); return; }
    items.forEach(function (r) {
      put('r:' + JSON.stringify([r, fmtWhen(r.at)]), function () {
        var c = el('div', 'card');
        c.appendChild(titleLink('name', r.cardId, r.title));
        var meta = el('div', 'muted', (r.label === 'check' ? 'Check passed' : 'Answer') + (r.seen ? '' : ' - new') + (fmtWhen(r.at) ? ' - ' + fmtWhen(r.at) : ''));
        c.appendChild(meta);
        c.appendChild(questionNode(r.text));
        return c;
      });
    });
  }
  function markResultsSeen() {
    if (!data || !(data.results || []).some(function (r) { return !r.seen; })) return;
    api('/api/results/seen', {}).catch(function () { /* the badge clears on the next open */ });
  }
  function renderFeedback() {
    var items = data.feedback || [];
    if (!items.length) { put('fb:none', function () { return el('p', 'muted', 'No unhandled game feedback.'); }); return; }
    items.forEach(function (r) {
      put('fb:' + JSON.stringify([r, picks[r.id] || '', errors['fb:' + r.id] || '']), function () { return feedbackCard(r); });
    });
  }
  function feedbackCard(r) {
    var c = el('div', 'card');
    c.appendChild(el('div', 'name', r.title || r.id));
    c.appendChild(el('div', 'muted', [r.game, r.version, r.time].filter(Boolean).join(' - ')));
    if (r.text) c.appendChild(el('div', 'task-title', r.text));
    if (r.screenshotPath) {
      var img = el('img', 'fbshot');
      img.src = '/api/file?p=' + encodeURIComponent(r.screenshotPath) + '&t=' + encodeURIComponent(token);
      img.loading = 'lazy';
      c.appendChild(img);
    }
    var sel = el('select', 'fbpick');
    var boss = el('option', '', 'Boss decides');
    boss.value = 'boss';
    sel.appendChild(boss);
    data.agents.filter(function (a) { return !a.isGod; }).concat(data.dormant || []).forEach(function (a) {
      var o = el('option', '', nameFor(a.id));
      o.value = a.id;
      sel.appendChild(o);
    });
    sel.value = picks[r.id] || 'boss';
    sel.onchange = function () { picks[r.id] = sel.value; };
    c.appendChild(sel);
    var note = el('textarea', 'fbnote');
    note.placeholder = 'Your thoughts / what to do about this';
    note.value = notes[r.id] !== undefined ? notes[r.id] : (r.note || '');
    note.oninput = function () { notes[r.id] = note.value; };
    note.onchange = function () { api('/api/feedback/note', { reportId: r.id, note: note.value }); };
    c.appendChild(note);
    var row = el('div', 'task-meta');
    var send = el('button', 'send', 'Send to agent');
    send.onclick = function () {
      send.disabled = true;
      api('/api/feedback/send', { reportId: r.id, agentId: sel.value, note: note.value }).then(function (res) {
        if (res && res.ok) { errors['fb:' + r.id] = ''; refresh(); }
        else { errors['fb:' + r.id] = (res && res.error) || 'Not sent'; render(); }
      }).catch(function () { errors['fb:' + r.id] = 'Not sent'; render(); });
    };
    var dis = el('button', 'send fbdismiss', 'Dismiss');
    dis.onclick = function () {
      dis.disabled = true;
      api('/api/feedback/dismiss', { reportId: r.id }).then(function () { refresh(); }).catch(function () { render(); });
    };
    row.appendChild(send);
    row.appendChild(dis);
    c.appendChild(row);
    if (errors['fb:' + r.id]) c.appendChild(el('div', 'err', errors['fb:' + r.id]));
    return c;
  }
  function askCard(q) {
    var c = el('div', 'card');
    c.appendChild(titleLink('name', q.id, q.title));
    if (q.assignee) c.appendChild(el('div', 'muted', q.assignee));
    var asked = fmtWhen(q.askedAt);
    if (asked) c.appendChild(el('div', 'muted', 'Asked ' + asked));
    c.appendChild(questionNode(q.q));
    var row = el('div', 'btnrow');
    var shelve = el('button', 'pchip', 'Backlog');
    shelve.onclick = function () {
      shelve.disabled = true;
      api('/api/backlog', { taskId: q.id }).then(function (r) {
        if (r && r.ok) { errors['bl:' + q.id] = ''; refresh(); }
        else { errors['bl:' + q.id] = (r && r.error) || 'Could not move this card to the Backlog. Try again.'; render(); }
      }).catch(function () { errors['bl:' + q.id] = 'Could not move this card to the Backlog. Try again.'; render(); });
    };
    var dismissKey = q.id + ':' + q.q;
    var dismiss = el('button', 'pchip', '\u2715 Dismiss');
    dismiss.setAttribute('aria-label', 'Dismiss this question without answering');
    dismiss.disabled = !!dismissBusy[dismissKey];
    dismiss.onclick = function () {
      if (dismissBusy[dismissKey]) return;
      dismissBusy[dismissKey] = true;
      dismiss.disabled = true;
      api('/api/dismiss', { taskId: q.id, q: q.q }).then(function (r) {
        dismissBusy[dismissKey] = false;
        if (r && r.ok) { errors['bl:' + q.id] = ''; refresh(); }
        else { errors['bl:' + q.id] = (r && r.error) || 'Could not dismiss this question. Try again.'; render(); }
      }).catch(function () { dismissBusy[dismissKey] = false; errors['bl:' + q.id] = 'Could not dismiss this question. Try again.'; render(); });
    };
    row.appendChild(shelve);
    row.appendChild(dismiss);
    c.appendChild(row);
    if (errors['bl:' + q.id]) c.appendChild(el('div', 'err', errors['bl:' + q.id]));
    c.appendChild(composer('ans:' + q.id + ':' + q.q, "Your answer, or 'done' with the result", function (text) {
      return api('/api/answer', { taskId: q.id, q: q.q, text: text });
    }));
    return c;
  }
  function taskProjects(board) {
    var counts = {};
    board.forEach(function (t) {
      var p = t.project || projectOf(t);
      counts[p] = (counts[p] || 0) + 1;
    });
    return Object.keys(counts).map(function (p) { return { project: p, count: counts[p] }; }).sort(function (a, b) {
      return ((a.project === 'Other' ? 1 : 0) - (b.project === 'Other' ? 1 : 0))
        || b.count - a.count || a.project.localeCompare(b.project);
    });
  }

  function taskAssignees(board) {
    var counts = {};
    board.forEach(function (t) {
      var a = t.assignee || 'unassigned';
      counts[a] = (counts[a] || 0) + 1;
    });
    return Object.keys(counts).map(function (a) { return { assignee: a, count: counts[a] }; }).sort(function (a, b) {
      if (a.assignee === 'unassigned') return 1;
      if (b.assignee === 'unassigned') return -1;
      return b.count - a.count || nameFor(a.assignee).localeCompare(nameFor(b.assignee));
    });
  }

  function renderTasks() {
    if (!data.board) return;

    var projects = taskProjects(data.board);
    var assignees = taskAssignees(data.board);

    var scopedByProjAndAssignee = data.board.filter(function (t) {
      if (taskProject && (t.project || projectOf(t)) !== taskProject) return false;
      if (taskAssignee && (t.assignee || 'unassigned') !== taskAssignee) return false;
      return true;
    });

    var statusCounts = { doing: 0, blocked: 0, todo: 0, done: 0 };
    scopedByProjAndAssignee.forEach(function (t) {
      var s = t.status || 'todo';
      if (statusCounts[s] !== undefined) statusCounts[s]++;
    });

    var filtered = scopedByProjAndAssignee.filter(function (t) {
      if (taskStatus && (t.status || 'todo') !== taskStatus) return false;
      return true;
    });

    var sorted = [];
    ['doing', 'blocked', 'todo', 'done'].forEach(function (s) {
      var list = filtered.filter(function (t) { return (t.status || 'todo') === s; });
      if (s === 'done') list = list.slice().reverse();
      for (var i = 0; i < list.length; i++) sorted.push(list[i]);
    });

    var total = sorted.length;
    var totalPages = Math.ceil(total / PAGE_SIZE) || 1;
    if (taskPage > totalPages) taskPage = totalPages;
    if (taskPage < 1) taskPage = 1;
    var startIdx = (taskPage - 1) * PAGE_SIZE;
    var endIdx = Math.min(startIdx + PAGE_SIZE, total);
    var pageTasks = sorted.slice(startIdx, endIdx);

    put('t:filters:' + JSON.stringify([taskProject, taskStatus, taskAssignee, data.board.length, scopedByProjAndAssignee.length, statusCounts]), function () {
      var wrap = el('div', 'tfilter-bar');

      var statusWrap = el('div', 'pchips');
      var allChip = el('button', 'pchip' + (!taskStatus ? ' on' : ''), 'All ' + scopedByProjAndAssignee.length);
      allChip.onclick = function () { setTaskStatus(''); render(); };
      statusWrap.appendChild(allChip);
      ['doing', 'blocked', 'todo', 'done'].forEach(function (s) {
        var count = statusCounts[s] || 0;
        var chip = el('button', 'pchip' + (taskStatus === s ? ' on' : ''), s + ' ' + count);
        chip.onclick = function () {
          setTaskStatus(taskStatus === s ? '' : s);
          render();
        };
        statusWrap.appendChild(chip);
      });
      wrap.appendChild(statusWrap);

      var row = el('div', 'tfilter-row');

      var pSel = el('select', 'tselect');
      pSel.setAttribute('aria-label', 'Filter by project');
      var pOptAll = el('option', null, 'All Projects (' + data.board.length + ')');
      pOptAll.value = '';
      pOptAll.setAttribute('value', '');
      pSel.appendChild(pOptAll);
      projects.forEach(function (p) {
        var opt = el('option', null, p.project + ' (' + p.count + ')');
        opt.value = p.project;
        opt.setAttribute('value', p.project);
        pSel.appendChild(opt);
      });
      pSel.value = taskProject;
      pSel.onchange = function () { setTaskProject(pSel.value); render(); };
      row.appendChild(pSel);

      var aSel = el('select', 'tselect');
      aSel.setAttribute('aria-label', 'Filter by assignee');
      var aOptAll = el('option', null, 'All Assignees (' + data.board.length + ')');
      aOptAll.value = '';
      aOptAll.setAttribute('value', '');
      aSel.appendChild(aOptAll);
      assignees.forEach(function (a) {
        var label = a.assignee === 'unassigned' ? 'Unassigned' : nameFor(a.assignee);
        var opt = el('option', null, label + ' (' + a.count + ')');
        opt.value = a.assignee;
        opt.setAttribute('value', a.assignee);
        aSel.appendChild(opt);
      });
      aSel.value = taskAssignee;
      aSel.onchange = function () { setTaskAssignee(aSel.value); render(); };
      row.appendChild(aSel);

      wrap.appendChild(row);

      if (taskProject || taskStatus || taskAssignee) {
        var actBar = el('div', 'tactive-bar');
        var parts = [];
        if (taskStatus) parts.push('status: ' + taskStatus);
        if (taskProject) parts.push('project: ' + taskProject);
        if (taskAssignee) parts.push('assignee: ' + (taskAssignee === 'unassigned' ? 'unassigned' : nameFor(taskAssignee)));
        actBar.appendChild(el('span', 'muted', 'Filters: ' + parts.join(', ')));
        var clr = el('button', 'tclear-btn', 'Clear all');
        clr.onclick = function () { clearTaskFilters(); render(); };
        actBar.appendChild(clr);
        wrap.appendChild(actBar);
      }

      return wrap;
    });

    function makePagingBar(isTop) {
      var bar = el('div', 'tpaging');
      bar.appendChild(el('span', 'tpage-info', 'Showing ' + (startIdx + 1) + '–' + endIdx + ' of ' + total));
      var btns = el('div', 'tpage-btns');
      var prev = el('button', 'tpage-btn', 'Prev');
      if (taskPage <= 1) prev.disabled = true;
      prev.onclick = function () {
        if (taskPage > 1) { setTaskPage(taskPage - 1); render(); window.scrollTo(0, 0); }
      };
      btns.appendChild(prev);
      btns.appendChild(el('span', 'tpage-num', 'Page ' + taskPage + ' of ' + totalPages));
      var next = el('button', 'tpage-btn', 'Next');
      if (taskPage >= totalPages) next.disabled = true;
      next.onclick = function () {
        if (taskPage < totalPages) { setTaskPage(taskPage + 1); render(); window.scrollTo(0, 0); }
      };
      btns.appendChild(next);
      bar.appendChild(btns);
      return bar;
    }

    if (total > 0) {
      put('t:page:top:' + JSON.stringify([taskPage, totalPages, total, startIdx, endIdx]), function () {
        return makePagingBar(true);
      });
    }

    if (total === 0) {
      put('t:empty:' + JSON.stringify([taskProject, taskStatus, taskAssignee]), function () {
        var msg = data.board.length === 0 ? 'No tasks on the board.' : 'No tasks match the selected filters.';
        var p = el('p', 'muted', msg);
        p.style.textAlign = 'center';
        p.style.padding = '24px 0';
        return p;
      });
    } else {
      put('t:list:' + JSON.stringify([taskPage, pageTasks.map(function (t) { return [t.id, t.title, t.status, t.assignee, t.project]; })]), function () {
        var c = el('div', 'card');
        pageTasks.forEach(function (t) {
          var d = el('div', 'task');
          d.appendChild(titleLink('task-title', t.id, t.title));
          var meta = el('div', 'task-meta');
          meta.appendChild(el('span', 'status ' + (t.status || 'todo'), t.status || 'todo'));
          var p = t.project || projectOf(t);
          if (p && p !== 'Other') {
            meta.appendChild(el('span', 'task-proj', p));
          }
          if (t.assignee) {
            meta.appendChild(el('span', 'muted', '@' + nameFor(t.assignee)));
          }
          d.appendChild(meta);
          c.appendChild(d);
        });
        return c;
      });
    }

    if (totalPages > 1) {
      put('t:page:bot:' + JSON.stringify([taskPage, totalPages, total, startIdx, endIdx]), function () {
        return makePagingBar(false);
      });
    }
  }

  function renderBacklog() {
    var backlog = data.backlog || [];
    if (!backlog.length) {
      put('b:empty', function () {
        var p = el('p', 'muted', 'Nothing in the backlog.');
        p.style.textAlign = 'center';
        p.style.padding = '24px 0';
        return p;
      });
      return;
    }
    var projects = projectCounts(backlog);
    if (projects.length > 1 || backlogProject) put('b:chips:' + JSON.stringify([projects, backlogProject, backlog.length]), function () {
      var bar = el('div', 'pchips');
      bar.appendChild(chip('All', backlog.length, !backlogProject, '', setBacklogProject));
      projects.forEach(function (p) { bar.appendChild(chip(p.project, p.count, backlogProject === p.project, p.project, setBacklogProject)); });
      if (backlogProject && !projects.some(function (p) { return p.project === backlogProject; })) bar.appendChild(chip(backlogProject, 0, true, backlogProject, setBacklogProject));
      return bar;
    });
    var shownBacklog = backlogProject ? backlog.filter(function (t) { return t.project === backlogProject; }) : backlog;
    if (!shownBacklog.length) put('b:none:' + backlogProject, function () {
      var p = el('p', 'muted', 'Nothing from ' + backlogProject + ' in the backlog.');
      p.style.textAlign = 'center';
      p.style.padding = '24px 0';
      return p;
    });
    shownBacklog.forEach(function (t) {
      var key = 'b:card:' + JSON.stringify([t.id, t.title, t.project, t.assignee, t.description, t.q, t.backloggedAt, t.stuck, t.stuckCount, backlogErrors[t.id], backlogBusy[t.id]]);
      put(key, function () {
        var c = el('div', 'card');
        c.appendChild(titleLink('name', t.id, t.title || t.id));
        var meta = el('div', 'task-meta');
        if (t.project) meta.appendChild(el('span', 'task-proj', t.project));
        if (t.assignee) meta.appendChild(el('span', 'muted', '@' + nameFor(t.assignee)));
        c.appendChild(meta);
        if (t.description) {
          c.appendChild(el('h2', null, 'Description'));
          c.appendChild(questionNode(t.description));
        }
        if (t.q) {
          c.appendChild(el('h2', null, 'Open question'));
          c.appendChild(questionNode(t.q));
        }
        var shelvedAt = Date.parse(t.backloggedAt);
        if (!isNaN(shelvedAt)) c.appendChild(el('div', 'muted', 'Shelved ' + new Date(shelvedAt).toLocaleDateString()));
        var bringBack = el('button', 'send', 'Bring back');
        bringBack.disabled = !!backlogBusy[t.id];
        bringBack.onclick = function () {
          if (backlogBusy[t.id]) return;
          backlogBusy[t.id] = true;
          backlogErrors[t.id] = '';
          render();
          api('/api/unbacklog', { taskId: t.id }).then(function (r) {
            backlogBusy[t.id] = false;
            if (!r || !r.ok) {
              backlogErrors[t.id] = (r && r.error) || 'Could not bring this card back. Try again.';
              render();
            } else {
              backlogErrors[t.id] = '';
              refresh();
            }
          }).catch(function () {
            backlogBusy[t.id] = false;
            backlogErrors[t.id] = 'Could not bring this card back. Try again.';
            render();
          });
        };
        c.appendChild(bringBack);
        if (backlogErrors[t.id]) c.appendChild(el('div', 'err', backlogErrors[t.id]));
        if (t.stuckCount) {
          c.appendChild(el('h2', null, t.stuckCount + (t.stuckCount === 1 ? ' card stuck behind this' : ' cards stuck behind this')));
          t.stuck.forEach(function (d) {
            c.appendChild(el('div', 'muted', '\u2514 ' + d.title + (d.assignee ? ' (' + nameFor(d.assignee) + ')' : '')));
          });
          if (t.stuckCount > t.stuck.length) c.appendChild(el('div', 'muted', '+' + (t.stuckCount - t.stuck.length) + ' more'));
        }
        return c;
      });
    });
  }

  function render() {
    // Replies scroll independently of the page; card replacements must restore both.
    var replyScroll = Object.create(null);
    document.querySelectorAll('.reply').forEach(function (reply) {
      replyScroll[reply.dataset.agentId] = {
        top: reply.scrollTop,
        bottom: reply.scrollHeight - reply.clientHeight - reply.scrollTop <= 1
      };
    });
    var tailScroll = Object.create(null);
    document.querySelectorAll('.tail').forEach(function (t) {
      tailScroll[t.dataset.agentId] = { top: t.scrollTop, bottom: t.scrollHeight - t.clientHeight - t.scrollTop <= 24 };
    });
    var scrollY = window.scrollY;
    var active = document.activeElement, sel = active && active.tagName === 'TEXTAREA'
      ? { key: active.dataset.key, s: active.selectionStart, e: active.selectionEnd } : null;
    next = {}; out = [];
    document.querySelectorAll('nav button').forEach(function (b) { b.className = b.dataset.tab === tab ? 'on' : ''; });
    var badge = document.getElementById('askBadge');
    badge.textContent = '';
    var fbBadge = document.getElementById('feedbackBadge');
    if (fbBadge) fbBadge.textContent = '';
    var resBadge = document.getElementById('resultsBadge');
    if (resBadge) resBadge.textContent = '';
    if (!token) put('gate', function () { return el('div', 'gate', 'Open this page from the link the app gives you (it carries the key).'); });
    else if (!data) put('loading', function () { return el('p', 'muted', 'Loading...'); });
    else {
      if (data.asks.length) badge.appendChild(el('span', 'badge', String(data.asks.length)));
      if (fbBadge && data.feedback && data.feedback.length) fbBadge.appendChild(el('span', 'badge', String(data.feedback.length)));
      var unseen = (data.results || []).filter(function (r) { return !r.seen; }).length;
      if (resBadge && unseen && tab !== 'results') resBadge.appendChild(el('span', 'badge', String(unseen)));
      if (detailId) renderDetail();
      else if (tab === 'floor') renderFloor(); else if (tab === 'ask') renderAsk(); else if (tab === 'results') renderResults(); else if (tab === 'feedback') renderFeedback(); else if (tab === 'backlog') renderBacklog(); else renderTasks();
    }
    nodes = next;
    // Only nodes out of place move; a node that stays is never detached.
    out.forEach(function (n, i) { if (main.children[i] !== n) main.insertBefore(n, main.children[i] || null); });
    while (main.children.length > out.length) main.removeChild(main.lastElementChild);
    document.querySelectorAll('.reply').forEach(function (reply) {
      var saved = replyScroll[reply.dataset.agentId];
      if (saved) reply.scrollTop = saved.bottom ? reply.scrollHeight - reply.clientHeight : saved.top;
    });
    document.querySelectorAll('.tail').forEach(function (t) {
      var saved = tailScroll[t.dataset.agentId];
      t.scrollTop = !saved || saved.bottom ? t.scrollHeight - t.clientHeight : saved.top;
    });
    window.scrollTo(0, scrollY);
    if (sel) {
      var again = Array.prototype.find.call(document.querySelectorAll('textarea'), function (t) { return t.dataset.key === sel.key; });
      if (again) { again.focus({ preventScroll: true }); try { again.setSelectionRange(sel.s, sel.e); } catch (e) {} }
    }
  }
  function refresh() {
    if (!token) { render(); return; }
    api('/api/state').then(function (d) {
      document.getElementById('stamp').textContent = 'updated ' + new Date().toLocaleTimeString();
      Object.keys(tailOpen).forEach(function (id) { if (tailOpen[id]) loadTail(id); });
      // An unchanged poll leaves the page alone: no flicker, nothing to restore.
      var json = JSON.stringify(d);
      if (json === lastJson && data) return;
      lastJson = json;
      data = d;
      render();
      tickAges();
      if (detailId) loadDetail();
    }).catch(function (e) {
      document.getElementById('stamp').textContent = e.message === 'auth' ? 'key rejected' : e.message === 'stale' ? 'stale page: reload' : 'offline';
      if (e.message === 'auth') { token = ''; render(); }
    });
  }
  document.getElementById('nav').onclick = function (ev) {
    var b = ev.target.closest('button');
    if (b) { tab = b.dataset.tab; detailId = ''; detail = null; detailError = ''; if (tab === 'results') markResultsSeen(); render(); window.scrollTo(0, 0); }
  };
  refresh();
  setInterval(function () { if (!document.hidden) { refresh(); tickAges(); } }, 4000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
})();
</script>
</body>
</html>
`;

const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** `page` with the app's name in its title and header (pages carry the default name). */
export function brandPhonePage(page: string, title: string): string {
  if (title === DEFAULT_APP_TITLE) return page;
  const name = escapeHtml(title);
  return page
    .replace(`<title>${DEFAULT_APP_TITLE}</title>`, `<title>${name}</title>`)
    .replace(`<h1>${DEFAULT_APP_TITLE}</h1>`, `<h1>${name}</h1>`);
}
