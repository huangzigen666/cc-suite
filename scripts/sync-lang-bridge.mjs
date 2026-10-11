#!/usr/bin/env node
// Explicit, bounded machine-local sync. --plan is read-only; --apply uses snapshots
// and same-directory temp files, validates, then atomically replaces each target.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { bridgeOverlay, overlayFiles } from "./lib/rex-lang-bridge-overlay.mjs";
const repo = fileURLToPath(new URL("../", import.meta.url));
const home = os.homedir();
const canonical = path.join(home, ".codex/plugins/rex-lang-bridge");
const installedFile = path.join(home, ".claude/plugins/installed_plugins.json");
const installedBytes = fs.readFileSync(installedFile);
const installed = JSON.parse(installedBytes).plugins?.["cc-suite@huangzigen666"]?.find(p=>p.scope==="user");
if (!installed || installed.version !== "2.5.4") throw new Error("Installed cc-suite baseline changed; review the new version before applying this overlay");
const cache = fs.realpathSync(installed.installPath);
if (!cache.startsWith(path.join(home,".claude/plugins/cache")+path.sep)) throw new Error("Unexpected installed plugin boundary");
const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "");
const skillDir = path.join(canonical, "skills/rex-lang-bridge");
const ledgerDir = path.join(home, ".local/state/cc-suite-lang-bridge", stamp);
const digest = (data) => crypto.createHash("sha256").update(data).digest("hex");
const changes = [], links = [];
function plannedFile(target, content) {
  const resolved = fs.existsSync(target) ? fs.realpathSync(target) : target;
  if (resolved.startsWith(path.join(home, "我的第二大脑") + path.sep)) throw new Error("Read-only knowledge source target");
  const before = fs.existsSync(resolved) ? fs.readFileSync(resolved) : null;
  if (before?.equals(Buffer.from(content))) return;
  const previous=changes.find(c=>c.target===resolved);
  if(previous){if(!previous.after.equals(Buffer.from(content)))throw new Error("Conflicting planned writes");return;}
  changes.push({ target: resolved, before, after: Buffer.from(content) });
}
function linked(target, source) {
  const old = fs.existsSync(target) || fs.lstatSync(path.dirname(target)).isDirectory()
    ? (() => { try { return fs.lstatSync(target); } catch { return null; } })() : null;
  if (old) {
    if (fs.realpathSync(target) === fs.realpathSync(source)) return;
    if (!old.isSymbolicLink()) throw new Error("Unmanaged existing entry: " + target);
    throw new Error("Different existing skill link: " + target);
  }
  links.push({ target, source });
}
function validate(target, content) {
  if (!content.length) throw new Error("Empty target");
  if (target.endsWith(".json")) JSON.parse(content);
  if (target.endsWith(".md")) {
    const text=content.toString();
    if (text.startsWith("---\n")) {
      const r=spawnSync("python3",["-c","import sys,yaml; t=sys.stdin.read(); d=yaml.safe_load(t.split('---',2)[1]); assert isinstance(d,dict)"] ,{input:text,encoding:"utf8"});
      if(r.status!==0)throw new Error("YAML validation failed: "+target);
    }
    if((text.match(/^```/gm)||[]).length%2)throw new Error("Unpaired code fence");
    let columns=0, fenced=false;
    for(const line of text.split("\n")){
      if(line.startsWith("```")){fenced=!fenced;columns=0;continue;}
      if(fenced)continue;
      if(line.startsWith("|")){const clean=line.replace(/`[^`]*`/g,"").replace(/\\\|/g,"");const n=clean.split("|").length;if(columns&&columns!==n)throw new Error("Table mismatch: "+target);columns=n;}else columns=0;
    }
  }
}
for (const root of [canonical, path.join(home,".codex/plugins/cache/rex-lang-bridge-local/rex-lang-bridge/0.1.0"),path.join(home,".claude/plugins/rex-lang-bridge")]) {
  if (!fs.existsSync(root)) continue;
  for (const rel of overlayFiles) {
    const target=path.join(root,rel);plannedFile(target,bridgeOverlay(rel,fs.readFileSync(target,"utf8")));
  }
}
const skill = path.join(skillDir,"SKILL.md");
let text=fs.readFileSync(skill,"utf8");
if(!text.includes("## cc-suite 自动委派桥接")) {
  text=text.replace(/^description:.*$/m,'description: "rex-lang-bridge v0.2.0-local：中文任务的双语参考、领域词保护、配置与离线预览；调用 cc-suite 时自动桥接委派提示词，支持原文保留、失败透传、防重复翻译和内部结果格式保护。"');
  text=text.replace("# rex-lang-bridge\n","# rex-lang-bridge v0.2.0-local\n");
  text+=`\n## cc-suite 自动委派桥接\n\n本机 cc-suite 的 runner 在发出任务前自动调用 \`rex-lang-bridge --delegation --json\`。十个后端共用该路径；Hermes 只保留文件，解冻前不得调用。\n\n- 委派模式翻译含中文的完整任务（含英文前置约束），保留原文字面量并附英文参考；不执行任务、不使用精炼模式。\n- 内部请求不追加中文摘要、不写桥接历史；用户最终答复的语言按当前请求处理。\n- 标记 \`[cc-suite rex-lang-bridge v1]\` 防止重复；翻译进程用 \`REX_LANG_BRIDGE_ACTIVE=1\` 防递归。\n- 单次桥接上限 45 秒，计入原 job 时限。缺失 CLI、错误输出或超时报告状态并使用原文；不扩权限、不自动重试。\n- 对直接 Claude MCP 调用：cc-suite 新生成的 MCP 注册使用 \`claude-mcp-bridge.mjs\`；旧注册在调用前用 \`cc-suite-prepare\` 从 stdin JSON 读取 \`prompt\`、可选 \`cwd\`，把输出 JSON 的 \`prompt\` 字段交给工具。已有标记时透传。\n\n\`CC_SUITE_LANG_BRIDGE=0\` 可对当前进程关闭桥接；不改全局设置。文件同步不证明宿主热加载或所有后端可用，重开会话后检查实际发送提示词。\n\n## 版本记录\n\n- v0.2.0-local（2026-10-12）：cc-suite 委派桥接；原文保留、失败透传、防重复翻译和内部结果格式保护。插件包版本仍为 0.1.0，本段记录本机 Skill 与代码 overlay，不代表 marketplace 发布。\n`;
}
plannedFile(skill,text);
// Update the installed cc-suite overlay only, without rewriting plugin identity.
const changedFiles=["scripts/lib/prompt-bridge.mjs","scripts/lib/rex-lang-bridge-overlay.mjs","scripts/lib/job-runner.mjs","scripts/codex-runner.mjs","scripts/agy-runner.mjs","scripts/grok-runner.mjs","scripts/qwen-runner.mjs","scripts/prepare-delegation.mjs","scripts/claude-mcp-bridge.mjs","scripts/mcp_claude.sh","commands/shared/codex-call.md","commands/shared/claude-prompt-bridge.md","commands/delegate.md"];
changedFiles.push("scripts/lib/prompt_bridge.py","scripts/bridge_agy_mcp.py","scripts/bridge_tools.py","scripts/bridge_agents.py");
for(const name of ["audit","audit-fix","verify","claude-review","claude-plan","claude-implement","claude-debug"])changedFiles.push(`skills/cc-suite/${name}/SKILL.md`);
if(!fs.existsSync(path.join(cache,".claude-plugin/plugin.json")))throw new Error("Installed cc-suite baseline absent");
for(const rel of changedFiles)plannedFile(path.join(cache,rel),fs.readFileSync(path.join(repo,rel)));
// Only existing native skill roots; never create a new agent or start a service.
const roots=[".claude/skills",".codex/skills",".agents/skills",".hermes/skills",".gemini/skills",".gemini/config/skills",".codebuddy/skills",".qoder/skills",".qoder-cn/skills",".grok/skills",".qwen/skills",".kimi-code/skills",".workbuddy/skills",".workbuddy-ai/skills",".zcode/skills",".openclaw/skills",".cursor/skills",".trae-cn/skills",".roo/skills",".continue/skills",".kiro/skills",".aider-desk/skills",".config/goose/skills"];
const present=roots.map(r=>path.join(home,r)).filter(r=>fs.existsSync(r));
for(const root of present)linked(path.join(root,"rex-lang-bridge"),skillDir);
linked(path.join(home,".local/bin/cc-suite-prepare"),path.join(repo,"scripts/prepare-delegation.mjs"));
// Claude gets the same user-input hook independently of plugin registration.
const settings=path.join(home,".claude/settings.json");const config=JSON.parse(fs.readFileSync(settings,"utf8"));
const command=`node "${path.join(canonical,"scripts/prompt-bridge-hook.mjs")}"`;
config.hooks??={};config.hooks.UserPromptSubmit??=[];
if(!config.hooks.UserPromptSubmit.some(entry=>entry.hooks?.some(hook=>hook.command===command))){
 config.hooks.UserPromptSubmit.push({hooks:[{type:"command",command,timeout:150}]});plannedFile(settings,JSON.stringify(config,null,2)+"\n");
}
for(const change of changes){
 validate(change.target,change.after);
 if(change.target.endsWith('.mjs')){const r=spawnSync(process.execPath,['--check','--input-type=module'],{input:change.after,encoding:'utf8'});if(r.status!==0)throw new Error('JavaScript validation failed: '+change.target);}
 if(change.target.endsWith('.py')){const r=spawnSync('python3',['-c','import ast,sys; ast.parse(sys.stdin.read())'],{input:change.after,encoding:'utf8'});if(r.status!==0)throw new Error('Python validation failed: '+change.target);}
}
const summary={status:"PLANNED",files:changes.map(c=>({path:c.target,before_sha256:c.before?digest(c.before):null,after_sha256:digest(c.after)})),links,present_skill_roots:present,hermes:"FROZEN_FILES_ONLY",runtime:"NOT_VERIFIED"};
if(!process.argv.includes("--apply")){process.stdout.write(JSON.stringify(summary,null,2)+"\n");process.exit(0);}
// Recheck the complete set before the first write.
if(!fs.readFileSync(installedFile).equals(installedBytes))throw new Error("Installed plugin registry changed during planning");
for(const c of changes){const current=fs.existsSync(c.target)?fs.readFileSync(c.target):null;if((current?digest(current):null)!==(c.before?digest(c.before):null))throw new Error("Concurrent change: "+c.target);}
for(const c of changes){
 fs.mkdirSync(path.dirname(c.target),{recursive:true});
 const mode=fs.existsSync(c.target)?fs.statSync(c.target).mode&0o777:0o644;
 if(c.before){let backup=c.target+".bak-"+stamp.slice(0,8),n=2;while(fs.existsSync(backup))backup=c.target+".bak-"+stamp.slice(0,8)+"-v"+n++;fs.copyFileSync(c.target,backup,fs.constants.COPYFILE_EXCL);fs.chmodSync(backup,mode);const s=fs.statSync(c.target);fs.utimesSync(backup,s.atime,s.mtime);if(digest(fs.readFileSync(backup))!==digest(c.before))throw new Error("Snapshot mismatch");c.backup=backup;}
 const temp=path.join(path.dirname(c.target),"."+path.basename(c.target)+".tmp-"+stamp);
 fs.writeFileSync(temp,c.after,{flag:"wx",mode});validate(c.target,fs.readFileSync(temp));
 if(c.target.endsWith(".mjs")){const r=spawnSync(process.execPath,["--check","--input-type=module"],{input:c.after,encoding:"utf8"});if(r.status!==0){fs.unlinkSync(temp);throw new Error("JavaScript syntax failed: "+c.target);}}
 const current=fs.existsSync(c.target)?fs.readFileSync(c.target):null;if((current?digest(current):null)!==(c.before?digest(c.before):null))throw new Error("Concurrent change before rename");
 fs.renameSync(temp,c.target);if(digest(fs.readFileSync(c.target))!==digest(c.after))throw new Error("Readback mismatch");
}
for(const link of links){const temp=link.target+".tmp-"+stamp;fs.symlinkSync(link.source,temp);if(fs.existsSync(link.target))throw new Error("Concurrent link creation");fs.renameSync(temp,link.target);}
const inodes=present.map(root=>fs.statSync(path.join(root,"rex-lang-bridge/SKILL.md")).ino);
if(new Set(inodes).size!==1)throw new Error("Shared Skill inode drift");
fs.mkdirSync(ledgerDir,{recursive:true});
const receipt={...summary,status:"APPLIED_STATIC",unique_skill_inodes:1,files:summary.files.map((file,i)=>({...file,backup:changes[i].backup??null}))};
fs.writeFileSync(path.join(ledgerDir,"receipt.json"),JSON.stringify(receipt,null,2)+"\n",{flag:"wx",mode:0o600});
process.stdout.write(JSON.stringify({status:receipt.status,files:changes.length,links:links.length,skill_roots:present.length,unique_skill_inodes:1,receipt:path.join(ledgerDir,"receipt.json"),hermes:receipt.hermes})+"\n");
