'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const loadTs = require('../test-support/load-ts.cjs');
const source = path.resolve(__dirname, '../src/main/ruleHooks.ts');

// Missing production code is an assertion failure; load errors in present code must surface.
function factory() {
  assert.ok(fs.existsSync(source), 'implement src/main/ruleHooks.ts (approved runner slice)');
  const api = loadTs('src/main/ruleHooks.ts');
  assert.equal(typeof api.createRuleHookHost, 'function', 'export createRuleHookHost');
  return api.createRuleHookHost;
}
const plain = value => JSON.parse(JSON.stringify(value));
const script = expr => `module.exports = (...args) => (${expr});`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(check) {
  const deadline = Date.now() + 15000;
  do {
    if (check()) return;
    await sleep(15);
  } while (Date.now() < deadline);
  assert.ok(check(), 'watched rule update did not become visible within 15s');
}
async function fixture(t, files = {}, options = {}) {
  const create = factory();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-rule-hooks-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const rulesDir = path.join(root, 'rules');
  if (!options.missingDir) fs.mkdirSync(rulesDir);
  const put = (name, text) => fs.writeFileSync(path.join(rulesDir, name), text);
  for (const [name, text] of Object.entries(files)) put(name, text);
  const errors = [], calls = [];
  const defaults = options.defaults || {
    policy: (...args) => { calls.push(args); return { ok: true, data: 'builtin' }; },
    other: () => ({ ok: true, data: 'other-default' })
  };
  const host = await create({ rulesDir, defaults, onError: event => errors.push(event), debounceMs: 10 });
  t.after(() => host.close());
  return { host, root, rulesDir, put, errors, calls };
}
function diagnostic(f, hook, phase) {
  const event = f.errors.find(e => e.type === 'rule-error' && e.hook === hook && e.phase === phase);
  assert.ok(event, `structured rule-error for ${hook}/${phase}`);
  assert.equal(event.file, path.join(f.rulesDir, `${hook}.js`));
  assert.equal(typeof event.message, 'string');
  assert.ok(event.message.length > 0);
}

test('loads a named hook and forwards multiple POJO arguments', async t => {
  const f = await fixture(t, { 'policy.js': script('({ok: false, reason: args[0].id + ":" + args[1].status})') });
  assert.deepEqual(plain(f.host.run('policy', { id: 'card' }, { status: 'doing' })), { ok: false, reason: 'card:doing' });
  assert.equal(f.calls.length, 0);
  assert.equal(f.errors.length, 0);
});

test('missing hook calls the compiled default exactly once with original arguments', async t => {
  const f = await fixture(t);
  const args = [{ id: 'card' }, { status: 'doing' }];
  assert.deepEqual(plain(f.host.run('policy', ...args)), { ok: true, data: 'builtin' });
  assert.deepEqual(f.calls, [args]);
  assert.equal(f.errors.length, 0);
});

test('absent rules directory starts with defaults and notices later creation', async t => {
  const f = await fixture(t, {}, { missingDir: true });
  assert.equal(f.host.run('policy').data, 'builtin');
  fs.mkdirSync(f.rulesDir);
  f.put('policy.js', script('({ok:true,data:"created"})'));
  await eventually(() => f.host.run('policy').data === 'created');
});

test('watch reloads two ordinary edits without explicit reload or restart', async t => {
  const f = await fixture(t, { 'policy.js': script('({ok:true,data:1})') });
  assert.equal(f.host.run('policy').data, 1);
  for (const n of [2, 3]) {
    f.put('policy.js', script(`({ok:true,data:${n}})`));
    await eventually(() => f.host.run('policy').data === n);
  }
});

test('directory watch survives repeated atomic editor saves', async t => {
  const f = await fixture(t, { 'policy.js': script('({ok:true,data:1})') });
  for (const n of [2, 3]) {
    f.put('policy.tmp', script(`({ok:true,data:${n}})`));
    fs.renameSync(path.join(f.rulesDir, 'policy.tmp'), path.join(f.rulesDir, 'policy.js'));
    await eventually(() => f.host.run('policy').data === n);
  }
});

test('deleting an override restores builtin rather than stale cached policy', async t => {
  const f = await fixture(t, { 'policy.js': script('({ok:false,reason:"custom"})') });
  assert.equal(f.host.run('policy').ok, false);
  fs.unlinkSync(path.join(f.rulesDir, 'policy.js'));
  await eventually(() => f.host.run('policy').data === 'builtin');
});

test('syntax failure at initial load logs and uses builtin', async t => {
  const f = await fixture(t, { 'policy.js': 'module.exports = (' });
  assert.equal(f.host.run('policy').data, 'builtin');
  diagnostic(f, 'policy', 'load');
});

test('top-level throw is isolated from a different valid hook', async t => {
  const f = await fixture(t, {
    'policy.js': 'throw new Error("load broke")',
    'other.js': script('({ok:false,reason:"still alive"})')
  });
  assert.equal(f.host.run('policy').data, 'builtin');
  assert.equal(f.host.run('other').reason, 'still alive');
  diagnostic(f, 'policy', 'load');
});

test('runtime throw with no prior successful override logs and uses builtin', async t => {
  const f = await fixture(t, { 'policy.js': 'module.exports = () => { throw new Error("run broke") };' });
  assert.equal(f.host.run('policy').data, 'builtin');
  assert.equal(f.calls.length, 1);
  diagnostic(f, 'policy', 'run');
  assert.equal(f.host.run('other').data, 'other-default');
});

test('syntax-broken reload preserves last known good and then recovers', async t => {
  const f = await fixture(t, { 'policy.js': script('({ok:false,reason:"last good"})') });
  assert.equal(f.host.run('policy').reason, 'last good');
  f.put('policy.js', 'module.exports = (');
  await eventually(() => f.errors.some(e => e.phase === 'load'));
  assert.equal(f.host.run('policy').reason, 'last good');
  diagnostic(f, 'policy', 'load');
  f.put('policy.js', script('({ok:true,data:"recovered"})'));
  await eventually(() => f.host.run('policy').data === 'recovered');
});

test('runtime-broken reload uses prior successfully exercised hook', async t => {
  const f = await fixture(t, { 'policy.js': script('({ok:false,reason:"last good"})') });
  assert.equal(f.host.run('policy').reason, 'last good');
  f.put('policy.js', 'module.exports = () => { throw new Error("bad candidate") };');
  await eventually(() => { f.host.run('policy'); return f.errors.some(e => e.phase === 'run'); });
  assert.equal(f.host.run('policy').reason, 'last good');
  assert.equal(f.calls.length, 0);
  diagnostic(f, 'policy', 'run');
});

test('last-good hook throwing for new input reaches builtin without recursion', async t => {
  const f = await fixture(t, { 'policy.js': 'module.exports = x => { if (x.bad) throw new Error("input"); return {ok:false}; };' });
  assert.equal(f.host.run('policy', { bad: false }).ok, false);
  assert.equal(f.host.run('policy', { bad: true }).data, 'builtin');
  assert.equal(f.calls.length, 1);
});

for (const [label, content] of [
  ['non-callable export', 'module.exports = {ok:true};'],
  ['missing export', 'const unused = 1;']
]) test(`${label} logs a load failure and falls back`, async t => {
  const f = await fixture(t, { 'policy.js': content });
  assert.equal(f.host.run('policy').data, 'builtin');
  diagnostic(f, 'policy', 'load');
});

for (const [label, expression] of [
  ['node globals', '[typeof process,typeof require,typeof fs,typeof child_process,typeof Buffer]'],
  ['network and timers', '[typeof fetch,typeof WebSocket,typeof setTimeout,typeof setInterval]']
]) test(`sandbox omits ${label}`, async t => {
  const f = await fixture(t, { 'policy.js': script(`({ok:true,data:${expression}})`) });
  const data = plain(f.host.run('policy').data);
  assert.ok(Array.isArray(data), 'custom hook actually ran');
  assert.ok(data.every(x => x === 'undefined'), JSON.stringify(data));
});

test('sandbox cannot recover host process through argument constructors', async t => {
  const f = await fixture(t, { 'policy.js': `module.exports = x => {
    let escaped = false;
    try { escaped = !!x.constructor.constructor('return process')().versions.node; } catch {}
    return {ok:true,data:escaped};
  };` });
  assert.equal(f.host.run('policy', { id: 'card' }).data, false);
});

test('sandbox cannot compile new code with Function or eval', async t => {
  const f = await fixture(t, { 'policy.js': `module.exports = () => {
    let compiled = false;
    try { compiled = !!Function('return 1')(); } catch {}
    try { compiled = compiled || !!eval('1'); } catch {}
    return {ok:true,data:compiled};
  };` });
  assert.equal(f.host.run('policy').data, false);
});

test('every nested input clone is frozen and host input remains mutable', async t => {
  const f = await fixture(t, { 'policy.js': `module.exports = x => {
    const frozen = Object.isFrozen(x) && Object.isFrozen(x.rows) && Object.isFrozen(x.rows[0]);
    try { x.rows[0].status = 'done'; x.rows.push({}); } catch {}
    return {ok:true,data:frozen};
  };` });
  const input = { rows: [{ status: 'doing' }] };
  assert.equal(f.host.run('policy', input).data, true);
  assert.deepEqual(input, { rows: [{ status: 'doing' }] });
  assert.equal(Object.isFrozen(input.rows[0]), false);
  input.rows[0].status = 'todo';
});

test('separate rule contexts do not leak globals into each other or host', async t => {
  const f = await fixture(t, {
    'policy.js': 'globalThis.campRuleProbe = 42; module.exports = () => ({ok:true});',
    'other.js': script('({ok:true,data:typeof campRuleProbe})')
  });
  f.host.run('policy');
  assert.equal(f.host.run('other').data, 'undefined');
  assert.equal(globalThis.campRuleProbe, undefined);
});

test('invalid files report in lexical hook order regardless of file creation order', async t => {
  const f = await fixture(t, { 'zeta.js': '(', 'alpha.js': '(', 'middle.js': '(' }, {
    defaults: { zeta: () => ({ok:true}), alpha: () => ({ok:true}), middle: () => ({ok:true}) }
  });
  assert.deepEqual(f.errors.map(e => e.hook), ['alpha', 'middle', 'zeta']);
});

test('unregistered JS and temporary files are never executed', async t => {
  const f = await fixture(t, { 'unregistered.js': 'throw new Error("must not load");', 'policy.tmp': '(' });
  assert.equal(f.host.run('policy').data, 'builtin');
  assert.deepEqual(f.errors, []);
});

test('close cancels pending reloads and may be called twice', async t => {
  const f = await fixture(t, { 'policy.js': script('({ok:true,data:"before"})') });
  f.put('policy.js', '(');
  f.host.close();
  f.host.close();
  await sleep(80);
  assert.deepEqual(f.errors, []);
});

// Atomics.wait blocks without using CPU, like a host process the OS has descheduled.
// The stall lasts until an absolute deadline, so a later attempt runs straight through.
const stallUntil = ms => `{ const left = ${Date.now() + ms} - Date.now(); if (left > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, left); }`;

test('host stalled during a load is not a rule timeout: the hook still loads', async t => {
  const f = await fixture(t, { 'policy.js': `${stallUntil(110)} ${script('({ok:true,data:"loaded"})')}` });
  assert.equal(f.host.run('policy').data, 'loaded');
  assert.deepEqual(f.errors, []);
});

test('watched edit that lands during a long host stall is picked up afterwards', async t => {
  const f = await fixture(t, { 'policy.js': script('({ok:true,data:1})') });
  f.put('policy.js', `${stallUntil(600)} ${script('({ok:true,data:2})')}`);
  await eventually(() => f.host.run('policy').data === 2);
  assert.deepEqual(f.errors, []);
});

test('host stalled during a run is not a rule timeout: no builtin fallback', async t => {
  const f = await fixture(t, { 'policy.js': `module.exports = () => { ${stallUntil(110)} return {ok:true,data:"ran"}; };` });
  assert.equal(f.host.run('policy').data, 'ran');
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.errors, []);
});

// Outer process deadline makes a broken timeout assertion fail instead of hanging node --test.
for (const phase of ['load', 'run']) test(`50ms default bounds infinite ${phase} loop and host remains usable`, () => {
  factory();
  const program = `
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const assert = require('node:assert/strict');
    const create = require(${JSON.stringify(path.join(__dirname, '..', 'test-support', 'load-ts.cjs'))})('src/main/ruleHooks.ts').createRuleHookHost;
    (async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'camp-rule-timeout-'));
      let host;
      try {
        fs.writeFileSync(path.join(dir, 'policy.js'), ${JSON.stringify(phase === 'load' ? 'while(true){}' : 'module.exports = () => { while(true){} };')});
        const errors = [], started = performance.now();
        host = await create({rulesDir:dir, defaults:{policy:()=>({ok:true,data:'builtin'}),other:()=>({ok:true,data:'alive'})},onError:e=>errors.push(e)});
        assert.equal(host.run('policy').data, 'builtin');
        assert.ok(performance.now()-started < 1000, '50ms budget exceeded generous 1s ceiling');
        assert.equal(host.run('other').data, 'alive');
        assert.ok(errors.some(e=>e.type==='rule-error' && e.phase===${JSON.stringify(phase)} && /timeout|timed out/i.test(e.message)));
      } finally { if(host) host.close(); fs.rmSync(dir,{recursive:true,force:true}); }
    })().catch(e=>{console.error(e);process.exitCode=1;});
  `;
  const result = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', timeout: 4000 });
  assert.equal(result.error, undefined, `child watchdog fired: ${result.error}`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
