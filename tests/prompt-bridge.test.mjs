import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { preparePrompt, BRIDGE_MARKER } from "../scripts/lib/prompt-bridge.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-suite-lang-test-"));
const bin = path.join(dir, "bridge");
const calls = path.join(dir, "calls");
fs.writeFileSync(bin, `#!/usr/bin/env node
const fs = require('fs'); let input='';
process.stdin.on('data', c=>input+=c);
process.stdin.on('end', ()=>{
 const r=JSON.parse(input); fs.appendFileSync(process.env.CALLS, JSON.stringify({r,argv:process.argv.slice(2),active:process.env.REX_LANG_BRIDGE_ACTIVE})+'\\n');
 const mode=process.env.MODE;
 if(mode==='fail'){process.stderr.write('secret-token');process.exit(1);}
 if(mode==='timeout'){setInterval(()=>{},1000);return;}
 if(mode==='malformed'){console.log('bad-json');return;}
 const out={original:r.prompt,text:'Review cc-suite. Preserve all constraints.',changed:true};
 if(mode==='unchanged'){out.text=r.prompt;out.changed=false;}
 if(mode==='mismatch')out.original='wrong';
 if(mode==='warning')out.warning='not translated';
 console.log(JSON.stringify(out));
});`, { mode: 0o755 });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const opts = (mode) => ({ cwd:dir, timeoutMs:6000, env:{...process.env,CC_SUITE_LANG_BRIDGE:'1',CC_SUITE_LANG_BRIDGE_BIN:bin,CALLS:calls,MODE:mode,REX_LANG_BRIDGE_ACTIVE:''} });
const source = 'Review policy. 请检查代码，不准写入；保留 `cc-suite` 和 123。';

test('mixed-language prompt preserves the exact original and quotes the translation', async()=>{
 const output=await preparePrompt(source,opts('ok'));
 assert.ok(output.startsWith(BRIDGE_MARKER)); assert.ok(output.includes(source));
 assert.match(output,/"Review cc-suite\. Preserve all constraints\."$/);
 assert.match(output,/requested output format/);
 const record=JSON.parse(fs.readFileSync(calls,'utf8').trim().split('\n').at(-1));
 assert.equal(record.r.prompt,source);assert.equal(record.active,'1');assert.ok(record.argv.includes('--delegation'));
 assert.ok(!output.includes('After answering the original task'));
});
test('marked prompt is idempotent and English is unchanged',async()=>{
 const output=await preparePrompt(source,opts('ok'));const before=fs.readFileSync(calls,'utf8');
 assert.equal(await preparePrompt(output,opts('fail')),output);
 assert.equal(await preparePrompt('Review code only',opts('fail')),'Review code only');
 assert.equal(fs.readFileSync(calls,'utf8'),before);
});
for(const mode of ['fail','malformed','mismatch','warning','unchanged'])test(`${mode} retains exact original`,async()=>{
 const status=[];assert.equal(await preparePrompt(source,{...opts(mode),report:x=>status.push(x)}),source);
 assert.ok(!status.join('').includes('secret-token'));
});
test('missing CLI retains the original',async()=>assert.equal(await preparePrompt(source,{...opts('ok'),env:{...opts('ok').env,CC_SUITE_LANG_BRIDGE_BIN:path.join(dir,'absent')}}),source));
test('timeout kills the translator and returns original within a bound',async()=>{
 const start=Date.now();assert.equal(await preparePrompt(source,{...opts('timeout'),timeoutMs:30}),source);
 assert.ok(Date.now()-start<1500);
});
test('explicit disable and recursion guard make no translator calls',async()=>{
 const before=fs.readFileSync(calls,'utf8');
 for(const env of [{CC_SUITE_LANG_BRIDGE:'0'},{REX_LANG_BRIDGE_ACTIVE:'1'}])assert.equal(await preparePrompt(source,{...opts('ok'),env:{...opts('ok').env,...env}}),source);
 assert.equal(fs.readFileSync(calls,'utf8'),before);
});
test('real zcode runner transports bilingual prompt and preserves structured result',()=>{
 const zcode=path.join(dir,'zcode');const received=path.join(dir,'received.json');
 fs.writeFileSync(zcode,`#!/usr/bin/env node\nconst fs=require('fs');fs.writeFileSync(process.env.RECEIVED,JSON.stringify(process.argv.slice(2)));console.log(JSON.stringify({sessionId:'fake',response:'RESULT'}));`,{mode:0o755});
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/zcode-runner.mjs',import.meta.url)),'--timeout-ms','5000','--',source],{
  cwd:dir,encoding:'utf8',timeout:10000,env:{...opts('ok').env,ZCODE_BIN:zcode,RECEIVED:received,CLAUDE_PLUGIN_DATA:path.join(dir,'state'),CODEX_TOOLKIT_BACKGROUND_JOB_ID:''},
 });
 assert.equal(r.status,0,r.stderr);const result=JSON.parse(r.stdout.trim());assert.equal(result.rawOutput,'RESULT');
 const argv=JSON.parse(fs.readFileSync(received,'utf8'));const prompt=argv[argv.indexOf('-p')+1];
 assert.ok(prompt.includes(BRIDGE_MARKER));assert.ok(prompt.includes(source));assert.match(prompt,/delegation from Claude Code/);
});

test('Claude MCP adapter translates only prompt and preserves request ids, permissions and reply fields',()=>{
 const backend=path.join(dir,'mcp-backend');
 fs.writeFileSync(backend,`#!/usr/bin/env node\nconst rl=require('readline').createInterface({input:process.stdin});rl.on('line',line=>console.log(line));`,{mode:0o755});
 const request={jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'claude_code',arguments:{prompt:source,cwd:dir,permissionMode:'plan',tools:['Read'],maxTurns:1}}};
 const init={jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05'}};
 const r=spawnSync(process.execPath,[fileURLToPath(new URL('../scripts/claude-mcp-bridge.mjs',import.meta.url)),'--',backend],{input:JSON.stringify(init)+'\n'+JSON.stringify(request)+'\n',encoding:'utf8',timeout:15000,cwd:dir,env:opts('ok').env});
 assert.equal(r.status,0,r.stderr);const [first,second]=r.stdout.trim().split('\n').map(JSON.parse);
 assert.deepEqual(first,init);assert.equal(second.id,2);assert.equal(second.params.arguments.permissionMode,'plan');assert.deepEqual(second.params.arguments.tools,['Read']);assert.equal(second.params.arguments.maxTurns,1);
 assert.ok(second.params.arguments.prompt.includes(BRIDGE_MARKER));assert.ok(second.params.arguments.prompt.includes(source));
});
