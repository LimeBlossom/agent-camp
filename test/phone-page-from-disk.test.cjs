'use strict';

// Hot-reload slice 1: the phone page is read from config `campPhonePagePath` on each
// request, and the bundled string serves whenever that file is unusable.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const loadTs = require('../test-support/load-ts.cjs');
const rmTree = require('../test-support/rm-tree.cjs');

// Capture the request handler instead of binding a port; the live camp owns 7788.
let handler = null;
const realCreateServer = http.createServer;
const realNetworkInterfaces = os.networkInterfaces;
http.createServer = (h) => {
  handler = h;
  return { on() {}, listen() {} };
};
os.networkInterfaces = () => ({ tailscale0: [{ family: 'IPv4', internal: false, address: '100.64.0.9' }] });

const { startPhoneServer } = loadTs('src/main/phone.ts');
const { PHONE_PAGE } = loadTs('src/main/phonePage.ts');

http.createServer = realCreateServer;
os.networkInterfaces = realNetworkInterfaces;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'md-phone-page-'));
test.after(() => rmTree(tmp));

function serve(pagePath) {
  handler = null;
  http.createServer = (h) => { handler = h; return { on() {}, listen() {} }; };
  os.networkInterfaces = () => ({ tailscale0: [{ family: 'IPv4', internal: false, address: '100.64.0.9' }] });
  try {
    const started = startPhoneServer({
      token: () => 't', state: () => null, tasks: () => [], patchTask: () => false,
      sendToGod: () => {}, enqueue: () => false, roots: () => [],
      pagePath,
    });
    assert.ok(started, 'server must start with a mocked tailnet address');
  } finally {
    http.createServer = realCreateServer;
    os.networkInterfaces = realNetworkInterfaces;
  }
  return async function get(url = '/') {
    const out = { status: 0, headers: {}, body: '' };
    const res = {
      writeHead(s, h) { out.status = s; out.headers = h ?? {}; },
      end(b) { out.body = b === undefined ? '' : String(b); },
    };
    const done = new Promise((resolve) => { const e = res.end; res.end = (b) => { e(b); resolve(); }; });
    handler({ method: 'GET', url, headers: {} }, res);
    await done;
    return out;
  };
}

test('a request after a file edit serves the new page', async () => {
  const file = path.join(tmp, 'index.html');
  fs.writeFileSync(file, '<!doctype html><title>v1</title>');
  const get = serve(() => file);
  assert.equal((await get()).body, '<!doctype html><title>v1</title>');
  fs.writeFileSync(file, '<!doctype html><title>v2</title>');
  const second = await get();
  assert.equal(second.status, 200);
  assert.equal(second.body, '<!doctype html><title>v2</title>');
  assert.equal(second.headers['cache-control'], 'no-store');
  assert.ok(second.headers['content-security-policy'], 'the CSP header stays on a disk page');
});

test('a missing file serves the bundled page', async () => {
  const get = serve(() => path.join(tmp, 'does-not-exist.html'));
  const r = await get();
  assert.equal(r.status, 200);
  assert.equal(r.body, PHONE_PAGE);
});

test('a directory serves the bundled page', async () => {
  const get = serve(() => tmp);
  assert.equal((await get()).body, PHONE_PAGE);
});

test('a relative path serves the bundled page', async () => {
  const file = path.join(tmp, 'rel.html');
  fs.writeFileSync(file, 'x');
  const get = serve(() => path.relative(process.cwd(), file));
  assert.equal((await get()).body, PHONE_PAGE);
});

test('an unset path serves the bundled page', async () => {
  const get = serve(() => undefined);
  assert.equal((await get()).body, PHONE_PAGE);
  const get2 = serve(undefined);
  assert.equal((await get2()).body, PHONE_PAGE);
});

test('the page treats a 404 from /api as a missing route, not as offline', () => {
  const script = PHONE_PAGE.slice(PHONE_PAGE.indexOf('<script>') + 8, PHONE_PAGE.indexOf('</script>'));
  assert.match(script, /r\.status === 404/);
  assert.match(script, /stale page/);
});

test('the build step writes out/phone/index.html equal to the bundled page', () => {
  const { writePhonePage } = require('../tools/write-phone-page.cjs');
  const dest = path.join(tmp, 'out', 'phone', 'index.html');
  writePhonePage(dest);
  assert.equal(fs.readFileSync(dest, 'utf8'), PHONE_PAGE);
});
