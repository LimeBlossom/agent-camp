'use strict';

// The phone page's ASK ME markdown: images written as ![alt](path) must become
// pictures (the desktop card renders them, so agents write them that way), and
// backticked image paths must keep working.

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const loadTs = require('../test-support/load-ts.cjs');

const { parsePhoneMarkdown } = loadTs('src/main/phoneMarkdown.ts');
const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');

const imgs = (blocks) => blocks.flatMap((b) => b.spans).filter((s) => s.kind === 'img');

test('a markdown image becomes an img span with its alt and path', () => {
  const blocks = parsePhoneMarkdown('Which icon set?\n\n![compare sheet](/home/x/research/compare.png)');
  assert.deepEqual(imgs(blocks), [{ kind: 'img', src: '/home/x/research/compare.png', alt: 'compare sheet' }]);
  assert.equal(blocks.length, 2);
});

test('an angle-bracketed path may contain spaces; a title is dropped', () => {
  const [img] = imgs(parsePhoneMarkdown('![a](</home/x/my shot.png> "title")'));
  assert.equal(img.src, '/home/x/my shot.png');
});

test('a backticked image path still renders as an image, other code stays code', () => {
  const blocks = parsePhoneMarkdown('See `/home/x/a.webp` and run `npm test`.');
  const spans = blocks[0].spans;
  assert.deepEqual(spans.map((s) => s.kind), ['text', 'img', 'text', 'code', 'text']);
  assert.equal(spans[1].src, '/home/x/a.webp');
  assert.equal(spans[3].text, 'npm test');
});

test('remote image URLs stay text: the page CSP only loads its own images', () => {
  const blocks = parsePhoneMarkdown('![x](https://example.com/a.png)');
  assert.deepEqual(imgs(blocks), []);
  assert.equal(blocks[0].spans[0].text, '![x](https://example.com/a.png)');
});

test('bold, bullets, headings, fences and line breaks', () => {
  const blocks = parsePhoneMarkdown('## Pick one\n**A** or __B__?\nsecond line\n- first\n2. second\n```\n<b>raw</b>\n```');
  assert.deepEqual(blocks.map((b) => b.kind), ['h', 'p', 'li', 'li', 'pre']);
  assert.deepEqual(blocks[1].spans.map((s) => s.kind), ['b', 'text', 'b', 'text', 'br', 'text']);
  assert.equal(blocks[3].ordered, true);
  assert.equal(blocks[4].spans[0].text, '<b>raw</b>');
});

test('a link keeps its label only, and markup in text is never interpreted', () => {
  const blocks = parsePhoneMarkdown('[the card](/x/y.md) <img src=x onerror=alert(1)>');
  assert.deepEqual(blocks[0].spans, [
    { kind: 'text', text: 'the card' },
    { kind: 'text', text: ' <img src=x onerror=alert(1)>' }
  ]);
});

test('the page embeds the parser and runs it standalone', () => {
  const start = PHONE_PAGE.indexOf('var parseMarkdown = (');
  const end = PHONE_PAGE.indexOf(');\n  function spanNode');
  assert.ok(start >= 0 && end > start, 'parser source embedded in the page');
  const embedded = new Function(`return ${PHONE_PAGE.slice(start + 'var parseMarkdown = '.length, end + 1)};`)();
  assert.deepEqual(imgs(embedded('![a](/p/q.png)')), [{ kind: 'img', src: '/p/q.png', alt: 'a' }]);
});

test('videos render as video spans, by markdown or backticked path', () => {
  const blocks = parsePhoneMarkdown('![legs](/h/r/before-after.mp4)\nsee `clip.webm` or `a.M4V`; `x.mp4 y` stays code');
  const spans = blocks[0].spans.filter((s) => s.kind === 'video' || s.kind === 'code');
  assert.deepEqual(spans, [
    { kind: 'video', src: '/h/r/before-after.mp4', alt: 'legs' },
    { kind: 'video', src: 'clip.webm', alt: 'clip.webm' },
    { kind: 'video', src: 'a.M4V', alt: 'a.M4V' },
    { kind: 'code', text: 'x.mp4 y' }
  ]);
  assert.deepEqual(parsePhoneMarkdown('![v](https://e.com/a.mp4)')[0].spans.map((s) => s.kind), ['text']);
});

test('the embedded page builds a video element for video spans', () => {
  assert.match(PHONE_PAGE, /s\.kind === 'video'/);
  assert.match(PHONE_PAGE, /v\.playsInline = true/);
});

function loadQuestionNode() {
  const SCRIPT = PHONE_PAGE.slice(PHONE_PAGE.indexOf('<script>') + 8, PHONE_PAGE.indexOf('</script>'));
  class Node {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.childNodes = []; this.className = ''; this.attrs = {}; }
    appendChild(n) { this.childNodes.push(n); n.parentNode = this; return n; }
    setAttribute(k, v) { this.attrs[k] = v; }
    set textContent(t) { this.childNodes = [{ tagName: '#text', textContent: t }]; }
    get textContent() { return this.childNodes.map((c) => c.textContent || c.data || '').join(''); }
    all(pred, acc = []) {
      this.childNodes.forEach((c) => {
        if (pred(c)) acc.push(c);
        if (c.all) c.all(pred, acc);
      });
      return acc;
    }
  }
  const ctx = {
    location: { hash: '#tok', pathname: '/' },
    history: { replaceState() {} },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      createElement: (tag) => new Node(tag),
      createTextNode: (t) => ({ tagName: '#text', data: String(t), textContent: String(t) }),
      getElementById: () => new Node('DIV'),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    window: { scrollTo() {} },
    fetch: () => new Promise(() => {}),
    setInterval() {},
    Date, JSON, Object, Array, String,
  };
  const instrumented = SCRIPT.replace('function questionNode(text) {', 'window.questionNode = questionNode; function questionNode(text) {');
  vm.runInNewContext(instrumented, ctx);
  return ctx.window.questionNode;
}

test('questionNode: renders exactly ONE <img> when carrying the same image path as markdown and as a backticked path', () => {
  const questionNode = loadQuestionNode();
  const q = [
    '**Open this card on your phone: does the picture below show?**',
    '',
    '![test picture](/home/user/HarnessAgents/hive/research/alpha-bottom-bar-centreline/before_after_medium.png)',
    '',
    '`/home/user/HarnessAgents/hive/research/alpha-bottom-bar-centreline/before_after_medium.png`',
    '',
    '- `shows`: card pictures work, I close this',
    '- `broken`: say what you see instead',
  ].join('\n');
  const box = questionNode(q);
  const imgs = box.all((n) => n.tagName === 'IMG');
  assert.equal(imgs.length, 1, 'renders exactly ONE <img>');
  assert.ok(imgs[0].src && imgs[0].src.includes('before_after_medium.png'), 'img points to the image path');

  const codes = box.all((n) => n.tagName === 'CODE');
  const codeTexts = codes.map((c) => c.textContent);
  assert.ok(
    codeTexts.includes('/home/user/HarnessAgents/hive/research/alpha-bottom-bar-centreline/before_after_medium.png'),
    'the backticked copy stays as text (copyable path)'
  );
});

test('questionNode: a backticked image path with no markdown twin still renders an <img> (old cards)', () => {
  const questionNode = loadQuestionNode();
  const box = questionNode('See `/home/user/shots/old_card.png` for reference.');
  const imgs = box.all((n) => n.tagName === 'IMG');
  assert.equal(imgs.length, 1, 'a backticked image path with no markdown twin still renders an <img>');
  assert.ok(imgs[0].src && imgs[0].src.includes('old_card.png'));
});

test('parsePhoneMarkdown: a backticked image path with a markdown twin stays code, keeping only one image span', () => {
  const p = '/home/user/shots/example.png';
  const blocks = parsePhoneMarkdown(`![screenshot](${p})\n\n\`${p}\``);
  assert.deepEqual(imgs(blocks), [{ kind: 'img', src: p, alt: 'screenshot' }]);
  const codes = blocks.flatMap((b) => b.spans).filter((s) => s.kind === 'code');
  assert.deepEqual(codes, [{ kind: 'code', text: p }]);
});

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseRange, serveFile, videoMimeForPath } = loadTs('src/main/phone.ts');

test('parseRange: open, closed, suffix, clamped, unsatisfiable', () => {
  assert.equal(parseRange(undefined, 100), 'all');
  assert.deepEqual(parseRange('bytes=0-', 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange('bytes=10-19', 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange('bytes=90-500', 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
  assert.equal(parseRange('bytes=100-', 100), null);
  assert.equal(parseRange('bytes=5-2', 100), null);
  assert.equal(parseRange('bytes=0-1,5-6', 100), 'all');
  assert.equal(videoMimeForPath('/a/b.webm'), 'video/webm');
  assert.equal(videoMimeForPath('/a/b.png'), null);
});

test('a video is served with 200 whole, 206 for a range, 416 past the end, confined to roots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-video-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-video-out-'));
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256));
  fs.writeFileSync(path.join(root, 'clip.mp4'), bytes);
  fs.writeFileSync(path.join(outside, 'secret.mp4'), bytes);
  const deps = { roots: () => [root] };
  const server = http.createServer((req, res) => {
    void serveFile(deps, new URL(req.url, 'http://x').searchParams.get('p'), req, res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/?p=`;
  const get = async (p, range) => {
    const r = await fetch(base + encodeURIComponent(p), range ? { headers: { range } } : {});
    return { status: r.status, h: r.headers, body: Buffer.from(await r.arrayBuffer()) };
  };
  try {
    const whole = await get(path.join(root, 'clip.mp4'));
    assert.equal(whole.status, 200);
    assert.equal(whole.h.get('content-type'), 'video/mp4');
    assert.equal(whole.h.get('accept-ranges'), 'bytes');
    assert.deepEqual(whole.body, bytes);
    const part = await get('clip.mp4', 'bytes=100-199');
    assert.equal(part.status, 206);
    assert.equal(part.h.get('content-range'), 'bytes 100-199/1000');
    assert.deepEqual(part.body, bytes.subarray(100, 200));
    assert.equal((await get('clip.mp4', 'bytes=1000-')).status, 416);
    assert.equal((await get(path.join(outside, 'secret.mp4'))).status, 404);
    assert.equal((await get('../' + path.basename(outside) + '/secret.mp4')).status, 404);
  } finally {
    server.close();
    fs.rmSync(root, { recursive: true });
    fs.rmSync(outside, { recursive: true });
  }
});
