'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');

const { McpProbeCache, probeMcpServer } = loadTs('src/main/mcpProbe.ts');

const SERVER = `
let buf = '';
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.id === 1) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }) + '\\n');
    if (m.id === 2) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { tools: [{ name: 'a' }, { name: 'b' }] } }) + '\\n');
  }
});
`;

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

test('a server that answers tools/list passes, and is not left running', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-probe-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'server.cjs');
  fs.writeFileSync(script, `${SERVER}\nrequire('fs').writeFileSync(${JSON.stringify(path.join(dir, 'pid'))}, String(process.pid));\n`);
  const r = await probeMcpServer({ command: process.execPath, args: [script] }, 5000);
  assert.deepEqual(r, { ok: true, tools: 2 });
  const pid = Number(fs.readFileSync(path.join(dir, 'pid'), 'utf8'));
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((res) => setTimeout(res, 50));
  assert.equal(alive(pid), false);
});

test('a missing command, an early exit and a silent server each fail with a reason', { skip: process.platform === 'win32' }, async () => {
  const missing = await probeMcpServer({ command: '/nonexistent/md-mcp-server', args: [] }, 5000);
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /spawn failed|ENOENT/);
  const exits = await probeMcpServer({ command: process.execPath, args: ['-e', 'console.error("boom"); process.exit(3)'] }, 5000);
  assert.equal(exits.ok, false);
  assert.match(exits.reason, /exited 3 before answering: boom/);
  const silent = await probeMcpServer({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] }, 300);
  assert.equal(silent.ok, false);
  assert.match(silent.reason, /no tools\/list answer within/);
});

test('the cache persists results and shares one probe between concurrent checks', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-mcp-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mcp-probe.json');
  let calls = 0;
  const cache = new McpProbeCache(() => file, async () => { calls++; return { ok: true, tools: 1 }; });
  const spec = { command: 'x', args: ['y'] };
  await Promise.all([cache.check(spec), cache.check(spec)]);
  assert.equal(calls, 1);
  const again = new McpProbeCache(() => file, async () => { calls++; return { ok: false, reason: 'r' }; });
  assert.equal((await again.check(spec)).ok, true, 'a fresh pass on disk is reused');
  assert.equal(calls, 1);
  const stale = await again.check(spec, Date.now() + 25 * 3_600_000);
  assert.equal(stale.ok, true, 'a stale pass serves this spawn while it is re-checked');
  await new Promise((res) => setImmediate(res));
  assert.equal(calls, 2);
  assert.equal((await again.check(spec)).ok, false);
});
