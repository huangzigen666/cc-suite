import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { bridgeOverlay, overlayFiles } from "../scripts/lib/rex-lang-bridge-overlay.mjs";
import { fileURLToPath } from "node:url";

const baseline = path.join(os.homedir(), ".codex/plugins/rex-lang-bridge");
test('installed bridge overlay is idempotent and delegation dry-run never requests summaries',()=>{
 const dir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'rex-overlay-')));
 try {
  fs.cpSync(baseline,dir,{recursive:true,filter:p=>!p.includes('.bak-')&&!p.includes('/_ref')&&!p.includes('/.git')});
  for(const rel of overlayFiles){const p=path.join(dir,rel);const next=bridgeOverlay(rel,fs.readFileSync(p,'utf8'));assert.equal(bridgeOverlay(rel,next),next);fs.writeFileSync(p,next);}
  for(const prompt of ['/cc-suite:audit 请检查代码','Long English preamble: 请检查投档表，不得发布']){
   const r=spawnSync(process.execPath,[path.join(dir,'scripts/cli.mjs'),'--dry-run','--delegation','--json','--text',prompt],{encoding:'utf8',timeout:15000});
   assert.equal(r.status,0,r.stderr);const out=JSON.parse(r.stdout);assert.equal(out.mode,'translate');assert.equal(out.original,prompt);assert.equal(out.text,prompt);assert.equal(out.summaryInstruction,'');
  }
  for(const env of [{REX_LANG_BRIDGE_ACTIVE:'1'},{}]){
   const r=spawnSync(process.execPath,[path.join(dir,'scripts/prompt-bridge-hook.mjs')],{input:JSON.stringify({prompt:'[cc-suite rex-lang-bridge v1] 请检查代码'}),encoding:'utf8',timeout:15000,env:{...process.env,...env}});
   assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{});
  }
 } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('all managed Claude MCP emitters preserve caller options and generate the same adapter',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cc-suite-mcp-render-'));
 const scripts=fileURLToPath(new URL('../scripts/',import.meta.url));
 const code=`import sys,json,tomllib\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nimport bridge_agy_mcp as a,bridge_tools as t,bridge_agents as agents\npin=a.claude_code_server()['args'][-1]\nlegacy={'type':'stdio','command':'npx','args':['-y',pin],'env':{'TEST_TOKEN':'fixture'},'timeout':17}\nPath('.mcp.json').write_text(json.dumps({'mcpServers':{'claude-code':legacy}}))\nx=a.apply_delegation_reservation({'claude-code':dict(legacy)})['claude-code']\ny=t.desired_servers()['claude-code']\nfor r in [x,y]:\n assert r['command']=='node' and r['args'][1:4]==['--','npx','-y']\n assert r['env']==legacy['env'] and r['timeout']==17\n assert a.is_delegation_package(r) and t._is_delegation_package(r)\nassert not a.is_delegation_package({'command':'node','args':['/tmp/other.mjs','--','npx','-y',pin]})\nagent={'name':'critic','_body':'Read only.','allowed_tools':['Read'],'permission_mode':'plan'}\np=pin.split('@')[1]\nm,_=agents.plan_mcp_json([agent],p)\nr=json.loads(m)['mcpServers']['critic']\nassert r['command']=='node' and r['env']['CLAUDE_PERMISSION_MODE']=='plan' and r['env']['CLAUDE_ALLOWED_TOOLS']=='Read'\ns,_=agents.plan_codex_toml([agent],p)\nr=tomllib.loads(s)['mcp_servers']['critic']\nassert r['command']=='node' and r['args'][1:4]==['--','npx','-y']\nprint('managed emitters and reserved-name rejection passed')`;
 try {const r=spawnSync(path.join(os.homedir(),'.local/bin/python3.12'),['-c',code,scripts],{cwd:dir,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/rejection passed/);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
