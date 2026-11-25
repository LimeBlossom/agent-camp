'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('../test-support/load-ts.cjs');
const { AgyRefusalStore, refusalFromStep, noticeKey } = loadTs('src/main/agyRefusals.ts');
const { AgyRefusalTerminal } = loadTs('src/main/agyRefusalTerminal.ts');
const { chooseEngine, balanceEngines } = loadTs('src/main/engineChoice.ts');
const { NoProgressWatch } = loadTs('src/main/quotaWatch.ts');
const { reconcileDormantLaunch } = loadTs('src/shared/dormantLaunch.ts');
const fixtures = require('./fixtures/agy-argon-refusals.json');
const first = fixtures[0];
const reset = Date.parse(first.serverResetAt);
const at = Date.parse(first.at);
function v(n) { const a=[]; do { let x=n%128; n=Math.floor(n/128); a.push(x+(n?128:0)); } while(n); return a; }
const vf = (f,n) => [...v(f*8),...v(n)];
const bf = (f,b) => [...v(f*8+2),...v(b.length),...b];
const sf = (f,s) => bf(f,Buffer.from(s));
function step(row) {
 const json = JSON.stringify({error:{code:429,status:'RESOURCE_EXHAUSTED',details:[{reason:'QUOTA_EXHAUSTED',metadata:{model:row.model,quotaResetTimeStamp:row.serverResetAt}}]}});
 return {
  metadata: Buffer.from(bf(1,vf(1,Date.parse(row.at)/1000))),
  step_payload: Buffer.from(bf(24,bf(3,[...sf(5,json),...sf(6,row.errorId)])))
 };
}
const read = (row, now=at) => { const s=step(row); return refusalFromStep('worker',s.metadata,s.step_payload,now); };
const temp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(),'agy-refusal-')),'state.json');

test('sanitized incident steps decode the absolute server reset, model and error IDs', () => {
 for(const row of fixtures) {
  const r=read(row,at+100000);
  assert.equal(r.resetAtMs,reset);
  assert.equal(r.errorId,row.errorId);
  assert.equal(r.model,'gemini-4-argon-medium');
  assert.equal(r.atMs,Date.parse(row.at));
 }
 assert.equal(refusalFromStep('w',Buffer.from([255]),Buffer.from([255]),at),null);
});

test('state survives restart; replayed countdown cannot re-anchor a named-model hold', () => {
 const p=temp(), store=new AgyRefusalStore(); store.load(p);
 const r=store.record(read(first));
 store.markNotified(r);
 const later=new AgyRefusalStore(); later.load(p);
 later.terminal('worker','Gemini 4 Argon (Medium)',{errorId:r.errorId,message:first.message,resetInMs:71*3600000},at+12*3600000);
 assert.equal(later.active(first.model,at+12*3600000).resetAtMs,reset);
 assert.equal(later.active('gemini-3.8-flash-high',at),undefined,'a named refusal does not exhaust other models in its pool');
 assert.equal(later.active(first.model,reset),undefined,'only expiry releases the model');
 assert.equal(later.pendingNotices().length,0);
 assert.equal(noticeKey(r),noticeKey(read(first,at+99999)));
});

test('positive aggregate pool readings do not change a model refusal', () => {
 const store=new AgyRefusalStore(); store.record(read(first));
 for (const remaining of [10,50,100]) {
  const readings={agy:{percent:100-remaining},codex:{percent:100}};
  assert.equal(chooseEngine(['agy','codex'],readings,()=>true,e=>!!store.active(e.model,at)).engine.id,'agy','Flash is distinct from refused Argon');
  const c=[{engine:'agy',label:'Argon',blocked:!!store.active(first.model,at)},{engine:'codex',label:'Codex'}];
  assert.equal(balanceEngines(c,readings,at).index,1);
 }
});

test('all-full ladder and balancer never return explicit refusals, including an all-refused list', () => {
 assert.equal(chooseEngine(['agy','codex'],{agy:100,codex:100},()=>true,e=>e.id==='agy').engine.id,'codex');
 assert.equal(chooseEngine(['agy','codex'],{agy:100,codex:100},()=>true,()=>true),null);
 assert.equal(balanceEngines([{engine:'agy',label:'a',blocked:true}],{agy:{percent:0}},at),null);
});

test('terminal estimate is anchored once across duplicates, restart, expiry and later Error ID refinement', () => {
 const p=temp(), store=new AgyRefusalStore(); store.load(p);
 const msg={message:'Individual quota reached. Resets in 1h.',resetInMs:3600000};
 store.terminal('worker',first.model,msg,at);
 const later=new AgyRefusalStore(); later.load(p);
 const r=later.terminal('worker',first.model,{...msg,errorId:first.errorId},at+1800000);
 assert.equal(r.resetAtMs,at+3600000);
 assert.equal(later.terminal('worker',first.model,{...msg,errorId:first.errorId},at+7200000).resetAtMs,at+3600000);
 assert.equal(later.active(first.model,at+7200000),undefined);
});

test('server reset replaces a terminal estimate; notification is once per refusal/source refinement', () => {
 const store=new AgyRefusalStore();
 const t=store.terminal('worker',first.model,{message:first.message,errorId:first.errorId,resetInMs:999999999},at);
 store.markNotified(t);
 const r=store.record(read(first));
 assert.equal(store.active(first.model,at).resetAtMs,reset);
 assert.equal(store.pendingNotices().length,1);
 store.markNotified(r);
 for(let i=0;i<3;i++) store.record(read(first,at+i*10000));
 assert.equal(store.pendingNotices().length,0);
});

const write = (t,chunk) => new Promise(resolve=>t.write(chunk,resolve));
const line='⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 4h16m24s.';
const id='5d4a33c7-5290-407f-8ec9-84f0bb8be1c1-1';
test('rendered detector handles split chunks/escapes, wraps, redraw and no final newline', async () => {
 const t=new AgyRefusalTerminal();
 let result;
 const text=`\x1b[31m${line}\x1b[0m\r\nError ID: ${id}`;
 for (const chunk of text) result=await write(t,chunk);
 assert.equal(result.errorId,id);
 assert.equal(result.resetInMs,15384000);
 result=await write(t,`\x1b[2J\x1b[H${line}\r\nError ID: ${id}`);
 assert.equal(result.errorId,id);
 result=await write(t,`\x1b[2J\x1b[H${line.replace('subscription to','subscription\r\n  to')}\r\nError ID: ${id}`);
 assert.equal(result.resetInMs,15384000);
 t.resize(40,20);
 result=await write(t,`\x1b[2J\x1b[H${line}\r\nError ID: ${id}`);
 assert.equal(result.errorId,id);
 assert.equal(result.resetInMs,15384000);
 t.dispose();
});

test('no-progress alert requires pending work, is once per episode, and re-arms on activity', () => {
 const watch=new NoProgressWatch();
 assert.equal(watch.check('w',true,1,0),false);
 assert.equal(watch.check('w',true,1,600000),true);
 assert.equal(watch.check('w',true,1,1200000),false);
 assert.equal(watch.check('w',true,2,1200000),false);
 assert.equal(watch.check('w',true,2,1800000),true);
 assert.equal(watch.check('w',false,2,2400000),false);
 assert.equal(watch.check('w',true,2,3000000),false);
});

test('dormant recipes reconcile stale Claude commands to configured providers without waking or rewriting historical sessions', () => {
 for (const model of ['Gemini 4 Argon (Medium)','gemini-3.8-flash-high']) {
  const raw={id:'dormant',provider:'antigravity',model,command:'claude --model old --permission-mode bypassPermissions',sessionId:'old-claude-session'};
  const next=reconcileDormantLaunch(raw);
  assert.match(next.command,/^agy --model /);
  assert.equal(next.sessionId,raw.sessionId);
  assert.match(raw.command,/^claude/);
 }
 const custom={provider:'codex',model:'gpt-6.1-sol',command:'codex --custom-flag'};
 assert.equal(reconcileDormantLaunch(custom),custom);
});
