'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const ts=require('typescript');
function freshEngine(response) {
 const code=ts.transpileModule(fs.readFileSync('src/renderer/src/hooks/freshEngine.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};
 const requireStub=(name)=>name==='@/store/config'?{buildSpawnCommand:()=> 'codex --model allowed'}:{sameEntry:(a,b)=>a.provider===b.provider&&a.model===b.model};
 new Function('exports','require','window',code)(exports,requireStub,{cth:{chooseAgentModel:async()=>response}});
 return exports.freshEngine;
}
test('fresh restore cannot fall back onto a refused model, including one-entry lists and difficulty-prefixed reasons',async()=>{
 const current={provider:'antigravity',model:'refused',command:'agy --model refused'};
 const run=freshEngine({entry:null,quotaBlocked:true,reason:'hard card; quota blocked: waiting for reset'});
 await assert.rejects(run('w',false,current,{}),/quota blocked/);
});
test('fresh restore uses an allowed alternative through the existing command builder',async()=>{
 const current={provider:'antigravity',model:'refused',command:'agy --model refused'};
 const run=freshEngine({entry:{provider:'codex',model:'allowed'},quotaBlocked:false,reason:'has room'});
 const next=await run('w',false,current,{});
 assert.equal(next.provider,'codex');
 assert.equal(next.command,'codex --model allowed');
});
test('a fresh start always asks main, which resolves the camp tiers; no per-agent list is passed',async()=>{
 const current={provider:'claude',model:'claude-opus-5-5',command:'claude'};
 const code=ts.transpileModule(fs.readFileSync('src/renderer/src/hooks/freshEngine.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const exports={};const asked=[];
 const requireStub=(name)=>name==='@/store/config'?{buildSpawnCommand:()=> 'agy --model x'}:{sameEntry:(a,b)=>a.provider===b.provider&&a.model===b.model};
 new Function('exports','require','window',code)(exports,requireStub,{cth:{chooseAgentModel:async(req)=>{asked.push(req);return {entry:{provider:'antigravity',model:'x'},quotaBlocked:false,reason:'tier strong: room'};}}});
 const next=await exports.freshEngine('w',false,current,{});
 assert.equal(asked.length,1);
 assert.equal('models' in asked[0],false);
 assert.equal(next.provider,'antigravity');
});
